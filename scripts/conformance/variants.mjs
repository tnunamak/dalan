// Required fault and race variants from the profile ("Required fault and race variants"), run against the real server process.
// Level per variant: persistence-restart (SIGKILL + restart on the same DB) or concurrent-race (parallel real requests).
// LIMIT: the bridge exposes no hook to hold a transaction after its snapshot read (no barrier injection), so races are
// driven by parallel requests and repeated rounds, not by deterministic interleaving. Each result says what it could and could not do.
import http from 'node:http';
import { DotBridgeAdapter, ERROR_MAP } from './adapter-dot-bridge.mjs';
import { createInertProtocolFixtures } from '../../src/test-support/protocol-service-fixtures.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const submitCmd = (job, key = 'k1', retainUntil = 1000) => ({ v: 0, op: 'submit', job, key, body: { source: 'git:BASE', scope: 'read:fixture', policy: 'P0', destination: 'owner-inbox', retainUntil } });
const claimCmd = (job, key = 'kc') => ({ v: 0, op: 'claim', job, key, body: { leaseMs: LEASE }, revision: 1 });
const RESULT = JSON.stringify({ source: 'git:BASE', policy: 'P0' });
// Native protocol jobs require a command key and an expected revision on every mutation. These helpers build the raw tool
// arguments so a variant can send them concurrently or drop the reply; the revision is read from the store at call time.
const LEASE = 100;
const mapped = e => (e ? (ERROR_MAP.find(([re]) => re.test(e))?.[1] ?? e) : null);
const claimArgs = (a, job, claimant, key = `kc-${claimant}`, revision = 1) => ({ request_id: a.maps.job.get(job), claimant, command_key: key, expected_revision: revision, lease_ms: LEASE * a.clockScale });
const finishArgs = (a, job, claimId, key = 'kf', extra = {}) => ({ request_id: a.maps.job.get(job), claim_id: claimId, outcome: 'completed', summary: 'done', result: RESULT, command_key: key, expected_revision: a.rev(job), epoch: 1, ...extra });
const cancelBody = (a, job, key = 'kx') => ({ id: a.maps.job.get(job), reason: 'stop', command_key: key, expected_revision: a.rev(job) });

// retainUntil is in fixture time: a variant that advances the clock past it would see the job tombstoned.
async function setup(adapter, job, retainUntil) { const r = await adapter.invoke('owner', submitCmd(job, 'k1', retainUntil)); if (!r.reply?.ok) throw new Error(`setup submit failed: ${JSON.stringify(r.reply)}`); }
async function claim(adapter, principal, job) { const r = await adapter.invoke(principal, claimCmd(job)); if (!r.reply?.ok) throw new Error(`setup claim failed: ${JSON.stringify(r.reply)}`); return r; }
const nativeClaimId = (adapter, alias) => adapter.nativeClaim(alias);
// Send a request and drop the connection right after the bytes are flushed: the server commits, the client never reads the reply.
function postDropReply(adapter, subject, name, args) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: adapter.port, method: 'POST', path: `/${adapter.secret}/mcp`, headers: { 'content-type': 'application/json', authorization: `Bearer ${adapter.token(subject)}` } });
    req.on('error', () => resolve({ dropped: true }));
    req.on('finish', () => setTimeout(() => { req.destroy(); resolve({ dropped: true }); }, 5));
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }));
  });
}
async function poll(fn, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(25); } return null; }

const free = (a, job) => a.admin('POST', '/cancel', cancelBody(a, job, 'kfree'), a.ownerToken(job));
const variants = [];
const variant = (id, traces, level, fn) => variants.push({ id, traces, level, fn });
// Sequential fixture-level command through the adapter (same translation the traces use).
const cmd = (a, principal, op, job, body, extra = {}) => a.invoke(principal, { v: 0, op, job, key: `${op}-${job}-${a.trace.length}-${Math.random().toString(36).slice(2, 6)}`, body, ...extra });
const waitBody = waiter => ({ waiter, predicate: 'terminal', afterSeq: 0, expiresAt: 900 });
const isRevision = e => mapped(e) === 'REVISION';

variant('V01-T05-concurrent-claims', ['T05'], 'concurrent-race (parallel requests, no barrier)', async a => {
  await a.reset(); const rounds = 24; const outcomes = []; const winners = { W1: 0, W2: 0 };
  for (let i = 0; i < rounds; i++) {
    const job = `race-${i}-claim`; await setup(a, job);
    const rid = a.maps.job.get(job);
    const order = i % 2 === 0 ? ['W1', 'W2'] : ['W2', 'W1']; // alternate which request is sent first
    // Both claimants read revision 1 (the submit receipt) and race to commit revision 2.
    const rs = await Promise.all(order.map(p => a.mcp(p, 'claim', claimArgs(a, job, p))));
    const wins = rs.map((r, k) => ({ p: order[k], r })).filter(x => !x.r.error);
    const losers = rs.filter(r => r.error);
    const active = a.q("SELECT count(*) n FROM claims WHERE request_id=? AND state='active'", rid)[0].n;
    outcomes.push({ wins: wins.length, loserError: losers[0]?.error ?? null, active, epoch: a.q1('SELECT epoch FROM claims WHERE request_id=?', rid)?.epoch ?? null, revision: a.rev(job) });
    if (wins.length === 1) winners[wins[0].p]++;
    await free(a, job);
  }
  const safety = outcomes.every(o => o.wins === 1 && o.active === 1 && o.epoch === 1 && o.revision === 2);
  const loserCodes = [...new Set(outcomes.map(o => mapped(o.loserError)))];
  const exact = loserCodes.length === 1 && loserCodes[0] === 'REVISION';
  return { safetyHolds: safety, exactMatch: safety && exact, observed: { rounds, winners, loserMappedCodes: loserCodes, allExactlyOneWinner: safety }, expectation: 'exactly one current claim; loser maps to REVISION', note: 'One winner per round, both claimants win in different rounds, both send orders. The loser must map to REVISION (compare-and-set on the submit revision). Not a deterministic snapshot-hold race: the bridge has no barrier hook.' };
});

variant('V02-T09-T28-lost-reply-replay', ['T09', 'T28'], 'persistence-restart (reply dropped after commit; crash-after-commit via DOT_BRIDGE_CRASH_AT)', async a => {
  const obs = {};
  // (1) finish, reply dropped by the client after the request is sent
  await a.reset(); await setup(a, 'lostfinish'); const c = await claim(a, 'W1', 'lostfinish'); const claimId = a.nativeClaim(c.reply.value.claim);
  const rid = a.maps.job.get('lostfinish'); const finishA = finishArgs(a, 'lostfinish', claimId);
  await postDropReply(a, 'W1', 'finish', finishA);
  const committed = await poll(() => a.q1('SELECT receipt_id FROM reports WHERE request_id=?', rid));
  const replay = await a.mcp('W1', 'finish', finishA); // identical command: same key, same expected revision
  const events = a.q("SELECT 1 FROM protocol_events WHERE request_id=? AND event_type='finished'", rid).length;
  obs.finishDropped = { committedBeforeReplay: !!committed, replayError: replay.error ?? null, replayReceiptSame: replay.value?.receipt_id === committed?.receipt_id, replayDuplicateFlag: replay.value?.duplicate ?? null, finishedEvents: events };
  // (2) crash after the report is durable but before the reply (server's own crash point), then replay on the restarted process
  await a.reset(); await a.killServer(); await a.startServer({ DOT_BRIDGE_CRASH_AT: 'after_report_persistence' });
  await setup(a, 'crashfinish'); const c2 = await claim(a, 'W1', 'crashfinish'); const claimId2 = a.nativeClaim(c2.reply.value.claim); const rid2 = a.maps.job.get('crashfinish');
  const args2 = finishArgs(a, 'crashfinish', claimId2);
  const crashed = await a.mcp('W1', 'finish', args2).catch(e => ({ error: `transport: ${e.code ?? e.message}` }));
  await sleep(200);
  const durable = a.q1('SELECT receipt_id FROM reports WHERE request_id=?', rid2);
  await a.killServer(); await a.startServer();
  const replay2 = await a.mcp('W1', 'finish', args2); const get2 = await a.mcp('W1', 'get', { request_id: rid2 });
  obs.crashAfterReportCommit = { clientSawTransportError: !!crashed.error, reportDurableAfterCrash: !!durable, replayError: replay2.error ?? null, replayReceiptSame: !!durable && replay2.value?.receipt_id === durable.receipt_id, finishedEvents: a.q("SELECT 1 FROM protocol_events WHERE request_id=? AND event_type='finished'", rid2).length, getShowsReport: !!get2.value?.report, getShowsClaim: get2.value?.claim?.state };
  // (3) claim replay: same claimant retries the identical claim after the reply is lost; no second claim, no new epoch
  await a.reset(); await setup(a, 'lostclaim'); const rid3 = a.maps.job.get('lostclaim');
  const claimA = claimArgs(a, 'lostclaim', 'W1', 'kc-replay');
  await postDropReply(a, 'W1', 'claim', claimA); await poll(() => a.q1('SELECT 1 FROM claims WHERE request_id=?', rid3));
  const re = await a.mcp('W1', 'claim', claimA);
  obs.claimDropped = { replayError: re.error ?? null, replayDuplicateFlag: re.value?.duplicate, epoch: re.value?.epoch, claimEvents: a.q("SELECT 1 FROM protocol_events WHERE request_id=? AND event_type='claimed'", rid3).length };
  const safety = obs.finishDropped.committedBeforeReplay && obs.finishDropped.replayReceiptSame && obs.finishDropped.finishedEvents === 1 && obs.crashAfterReportCommit.reportDurableAfterCrash && obs.crashAfterReportCommit.replayReceiptSame && obs.crashAfterReportCommit.finishedEvents === 1 && obs.crashAfterReportCommit.getShowsReport && obs.claimDropped.epoch === 1 && obs.claimDropped.claimEvents === 1;
  return { safetyHolds: safety, exactMatch: false, observed: obs, expectation: 'replayed identical command returns the original receipt, no new event, authority readable via get', note: 'An identical replay (same command key, same expected revision) must return the original receipt and append no event. Not scored as an exact match against the golden: this variant drives raw tool arguments, not the profile envelope.' };
});

variant('V03-T21-T22-cancel-finish-race', ['T21', 'T22'], 'concurrent-race (parallel requests, no barrier)', async a => {
  await a.reset(); const rounds = 64; const tally = {}; let both = 0; let bad = 0; let doubleWin = 0;
  for (let i = 0; i < rounds; i++) {
    const job = `cfrace-${i}`; await setup(a, job); const c = await claim(a, 'W1', job); const rid = a.maps.job.get(job); const claimId = a.nativeClaim(c.reply.value.claim);
    const finArgs = finishArgs(a, job, claimId); const canBody = cancelBody(a, job); // both read the same revision
    const fin = () => a.mcp('W1', 'finish', finArgs);
    const can = () => a.admin('POST', '/cancel', canBody, a.ownerToken(job));
    const d = [0, 15, 30, 45, 60, 80, 100, 130][i % 8]; // delay the cancel by d ms so both commit orders are reached
    const [f, k] = await Promise.all([fin(), sleep(d).then(can)]);
    if (!f.error && !k.error) doubleWin++; // two commands at one revision must not both commit
    const row = a.q1('SELECT status FROM assignments WHERE request_id=?', rid); const rep = a.q1('SELECT late FROM reports WHERE request_id=?', rid);
    const key = `${row.status}|report=${rep ? (rep.late ? 'late' : 'on-time') : 'none'}|finish=${f.error ? mapped(f.error) : 'ok'}|cancel=${k.error ? mapped(k.error) : 'ok'}`;
    tally[key] = (tally[key] ?? 0) + 1;
    if (row.status === 'cancelled' && rep) both++;
    if (row.status === 'finished' && !rep) bad++;
    await free(a, job);
  }
  return { safetyHolds: bad === 0 && doubleWin === 0, exactMatch: bad === 0 && doubleWin === 0 && both === 0, observed: { rounds, outcomes: tally, cancelledWithReport: both, bothCommands: doubleWin }, expectation: 'exactly one of {finished receipt, cancelled terminal}; never both', note: 'Finish and cancel are sent with the same expected revision; exactly one may commit and the other must be refused. A finished job always has a report; no round may end cancelled with a report.' };
});

variant('V04-T23-T24-crash-barriers', ['T23', 'T24'], 'persistence-restart (SIGKILL at step and mid-operation)', async a => {
  const obs = {};
  const art = 'art_fixture_A'; const bytes = Buffer.from('abc'); const digest = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  const chunk = (job, k, extra) => ({ request_id: a.maps.job.get(job), claim_id: k, artifact_id: art, epoch: 1, expected_revision: a.rev(job), ...extra });
  // kill after upload (staged, unsealed), restart, finish referencing unsealed must be rejected; then seal and finish without re-upload
  await a.reset(); await setup(a, 'crash1'); let c = await claim(a, 'W1', 'crash1'); let cid = a.nativeClaim(c.reply.value.claim);
  const up = await a.mcp('W1', 'artifact_chunk', chunk('crash1', cid, { command_key: 'ku', offset: 0, data_base64: bytes.toString('base64'), final: false }));
  await a.control({ op: 'restart' });
  const rejected = await a.mcp('W1', 'finish', finishArgs(a, 'crash1', cid, 'kf-unsealed', { artifact_ids: [art] }));
  const sealed = await a.mcp('W1', 'artifact_chunk', chunk('crash1', cid, { command_key: 'ks', offset: 3, data_base64: '', final: true, sha256: digest, size: 3 }));
  await a.control({ op: 'restart' });
  const fin = await a.mcp('W1', 'finish', finishArgs(a, 'crash1', cid, 'kf-sealed', { artifact_ids: [art] }));
  obs.afterUpload = { uploadOk: !up.error, uploadError: up.error ?? null, unsealedFinishRejected: rejected.error ?? null, sealOk: !sealed.error, sealError: sealed.error ?? null, finishAfterSealRestartOk: !fin.error, finishError: fin.error ?? null, reuploadNeeded: false };
  // SIGKILL racing finish: either no report or a complete report, never a half state
  const states = {}; await a.reset();
  for (let i = 0; i < 24; i++) {
    const job = `killfin-${i}`; await setup(a, job); const cc = await claim(a, 'W1', job); const r = a.maps.job.get(job); const k = a.nativeClaim(cc.reply.value.claim);
    const p = postDropReply(a, 'W1', 'finish', finishArgs(a, job, k));
    await sleep([5, 25, 50, 80, 110, 140, 180, 240][i % 8]); await a.killServer(); await p; await a.startServer();
    const st = a.q1('SELECT status FROM assignments WHERE request_id=?', r).status; const rep = a.q1('SELECT 1 x FROM reports WHERE request_id=?', r); const ev = a.q("SELECT 1 FROM protocol_events WHERE request_id=? AND event_type='finished'", r).length;
    const key = `${st}|report=${!!rep}|finishedEvents=${ev}`; states[key] = (states[key] ?? 0) + 1;
    await free(a, job);
  }
  obs.killDuringFinish = states;
  const consistent = Object.keys(states).every(k => k === 'claimed|report=false|finishedEvents=0' || k === 'finished|report=true|finishedEvents=1');
  const safety = obs.afterUpload.uploadOk && !!obs.afterUpload.unsealedFinishRejected && obs.afterUpload.sealOk && obs.afterUpload.finishAfterSealRestartOk && consistent;
  return { safetyHolds: safety, exactMatch: false, observed: obs, expectation: 'orphan staged bytes never appear as a finished proposal; once sealed and lease live, finish works after restart without re-upload; only a fully committed finish wins', note: 'Crash safety at step boundaries and under SIGKILL racing finish (status, report and event commit together). Not run: kill between blob write and staged-metadata commit inside one artifact_chunk call (no barrier hook; DOT_BRIDGE_CRASH_AT has only after_report_persistence and after_attempt_commit).' };
});

variant('V05-T30-T31-waiter-vs-finish', ['T30', 'T31'], 'concurrent-race (parallel requests, no barrier)', async a => {
  await a.reset(); const rounds = 20; const tally = {};
  for (let i = 0; i < rounds; i++) {
    const job = `wrace-${i}`; await setup(a, job); const c = await claim(a, 'W1', job); const rid = a.maps.job.get(job); const cid = a.nativeClaim(c.reply.value.claim);
    const rev = a.rev(job); // register-waiter and finish both read this revision; one commits first and the other must retry on the new revision
    const register = async () => {
      let r = await a.admin('POST', '/protocol/wait', { id: rid, command_key: 'kw', expected_revision: rev, waiter: 'W', predicate: 'terminal', after_seq: 0, expires_at: a.baseMs + 900 }, a.ownerToken(job));
      for (let n = 0; n < 5 && r.error && isRevision(r.error); n++) r = await a.admin('POST', '/protocol/wait', { id: rid, command_key: 'kw', expected_revision: a.rev(job), waiter: 'W', predicate: 'terminal', after_seq: 0, expires_at: a.baseMs + 900 }, a.ownerToken(job));
      return r;
    };
    const finish = async () => {
      let r = await a.mcp('W1', 'finish', finishArgs(a, job, cid, 'kf', { expected_revision: rev }));
      for (let n = 0; n < 5 && r.error && isRevision(r.error); n++) r = await a.mcp('W1', 'finish', finishArgs(a, job, cid, 'kf'));
      return r;
    };
    const delay = [0, 1, 3, 8][i % 4];
    const [w, f] = await Promise.all([(async () => { if (i % 2) await sleep(delay); return register(); })(), (async () => { if (i % 2 === 0) await sleep(delay); return finish(); })()]);
    await sleep(120);
    const deliveries = a.q('SELECT delivery_id FROM durable_waiter_deliveries WHERE job=? AND waiter=?', rid, 'W');
    const inbox = await a.admin('POST', '/protocol/inbox', { id: rid, waiter: 'W' }, a.ownerToken(job));
    const key = `register=${w.error ? mapped(w.error) : 'ok'}|finish=${f.error ? mapped(f.error) : 'ok'}|deliveryRows=${deliveries.length}|pendingInInbox=${inbox.value?.deliveries?.length ?? inbox.error}`; tally[key] = (tally[key] ?? 0) + 1;
    await free(a, job);
  }
  const safety = Object.keys(tally).every(k => k === 'register=ok|finish=ok|deliveryRows=1|pendingInInbox=1');
  return { safetyHolds: safety, exactMatch: false, observed: { rounds, outcomes: tally }, expectation: 'exactly one pending delivery whether registration or completion wins; registration that sees terminal points to the terminal event', note: 'Both orders are reached by delaying one side; a side that loses the revision compare-and-set retries on the new revision. After the race the durable waiter store must hold exactly one delivery for the waiter and the inbox must show exactly one pending delivery.' };
});

variant('V06-T34-T35-delivery-uncertainty', ['T34', 'T35'], 'persistence-restart (inert fake destination records transits and acceptances)', async a => {
  const obs = {};
  const prepare = async job => { // submit, claim, register waiter W, finish: leaves one pending delivery D:W
    await setup(a, job); await claim(a, 'W1', job);
    await cmd(a, 'owner', 'wait', job, waitBody('W'), { revision: a.rev(job) });
    const f = await cmd(a, 'W1', 'finish', job, { outcome: 'completed', summary: 'done', artifacts: [], source: 'git:BASE', policy: 'P0' }, { revision: a.rev(job), epoch: 1, claim: 'C1' });
    if (!f.reply?.ok) throw new Error(`setup finish failed: ${JSON.stringify(f.reply)}`);
  };
  const dest = () => createInertProtocolFixtures(a.home).inspect();
  const counts = () => { const s = dest(); return { transitsBegun: s.begins, accepted: s.accepts }; };
  // T34: crash after the destination accepted. Recovery must not send again; the delivery is unknown until reconciled.
  await a.reset(); await prepare('acc');
  const d1 = await cmd(a, 'service', 'dispatch', 'acc', { delivery: 'D:W' });
  await a.control({ op: 'restart' }); // the fake destination completes the transit that was in flight
  const d2 = await cmd(a, 'service', 'dispatch', 'acc', { delivery: 'D:W' });
  const afterRetry = counts();
  const rec = await cmd(a, 'service', 'reconcile', 'acc', { delivery: 'D:W', outcome: 'found', receipt: 'remote-42' });
  const inboxAcc = await cmd(a, 'owner', 'inbox', 'acc', { waiter: 'W' });
  obs.crashAfterAccept = { firstDispatch: d1.reply, redispatchAfterRestart: d2.reply, destinationAfterRedispatch: afterRetry, reconcile: rec.reply, inboxAfterReconcile: inboxAcc.reply?.value?.deliveries?.length };
  // T35: destination outcome unknown, and reconcile cannot resolve it. Stays unknown, visible, and is never resent.
  await a.reset(); await prepare('unk');
  await cmd(a, 'service', 'dispatch', 'unk', { delivery: 'D:W' });
  const r1 = await cmd(a, 'service', 'delivery_result', 'unk', { delivery: 'D:W', outcome: 'unknown', receipt: 'timeout' });
  const r2 = await cmd(a, 'service', 'reconcile', 'unk', { delivery: 'D:W', outcome: 'unknown', receipt: 'no query support' });
  const r3 = await cmd(a, 'service', 'dispatch', 'unk', { delivery: 'D:W' });
  await a.control({ op: 'restart' });
  const inboxUnk = await cmd(a, 'owner', 'inbox', 'unk', { waiter: 'W' });
  obs.unknownOutcome = { delivered: r1.reply, reconciled: r2.reply, redispatch: r3.reply, destination: counts(), inboxAfterRestart: inboxUnk.reply?.value?.deliveries?.map(x => x.state) };
  const A = obs.crashAfterAccept, U = obs.unknownOutcome;
  const safety = A.firstDispatch?.ok === true && A.redispatchAfterRestart?.ok === false && A.redispatchAfterRestart?.code === 'DELIVERY_UNKNOWN' && A.destinationAfterRedispatch.transitsBegun === 1 && A.destinationAfterRedispatch.accepted === 1 && A.reconcile?.ok === true && A.reconcile.value.state === 'acknowledged' && A.inboxAfterReconcile === 0
    && U.delivered?.value?.state === 'unknown' && U.reconciled?.value?.state === 'unknown' && U.redispatch?.code === 'DELIVERY_UNKNOWN' && U.destination.transitsBegun === 1 && U.inboxAfterRestart?.length === 1 && U.inboxAfterRestart[0] === 'unknown';
  return { safetyHolds: safety, exactMatch: safety, observed: obs, expectation: 'fake destination records delivery ids; kill after accept; recovery must not resend; unknown stays visible', note: 'The destination is the inert fake receiver shipped with the test support code; it records every transit begun and every acceptance. After a restart the delivery must not be sent again (one transit, one acceptance), a repeat dispatch is refused as DELIVERY_UNKNOWN, reconcile with a found receipt acknowledges it, and an unresolved unknown stays in the inbox across restart.' };
});

variant('V07-inbox-ack-crash', ['T36'], 'persistence-restart (SIGKILL; ack reply dropped)', async a => {
  await a.reset(); await setup(a, 'inboxjob'); await claim(a, 'W1', 'inboxjob'); const rid = a.maps.job.get('inboxjob');
  await cmd(a, 'owner', 'wait', 'inboxjob', waitBody('W'), { revision: a.rev('inboxjob') });
  const f = await cmd(a, 'W1', 'finish', 'inboxjob', { outcome: 'completed', summary: 'done', artifacts: [], source: 'git:BASE', policy: 'P0' }, { revision: a.rev('inboxjob'), epoch: 1, claim: 'C1' });
  const cap = a.ownerToken('inboxjob'); const pending = async () => (await a.admin('POST', '/protocol/inbox', { id: rid, waiter: 'W' }, cap)).value.deliveries;
  const obs = { finishOk: f.reply?.ok === true };
  const first = await pending(); const delivery = first[0]?.delivery; obs.unreadBefore = first.length === 1 && first[0].state === 'pending';
  await a.control({ op: 'restart' }); const second = await pending(); obs.unreadAfterRestartBeforeAck = second.length === 1 && second[0].delivery === delivery;
  // ack with the reply dropped (client never sees it), then restart, then retry with the same operation
  await new Promise(resolve => { const req = http.request({ socketPath: a.socket, method: 'POST', path: '/protocol/ack', headers: { 'content-type': 'application/json', 'x-owner-capability': cap } }); req.on('error', () => resolve()); req.on('finish', () => setTimeout(() => { req.destroy(); resolve(); }, 5)); req.end(JSON.stringify({ id: rid, waiter: 'W', delivery })); });
  await poll(async () => (await pending()).length === 0);
  await a.control({ op: 'restart' }); obs.suppressedAfterAckAndRestart = (await pending()).length === 0;
  const retry = await a.admin('POST', '/protocol/ack', { id: rid, waiter: 'W', delivery }, cap);
  obs.retryReply = retry.error ? { error: retry.error } : retry.value;
  obs.retryReturnsAcknowledged = retry.value?.state === 'acknowledged';
  const safety = obs.finishOk && obs.unreadBefore && obs.unreadAfterRestartBeforeAck && obs.suppressedAfterAckAndRestart;
  return { safetyHolds: safety, exactMatch: safety && obs.retryReturnsAcknowledged, observed: obs, expectation: 'inbox returns the same delivery until a durable ack; ack survives restart; retrying ack returns its original reply', note: 'The inbox keeps returning the same pending delivery until the ack commits; the ack survives SIGKILL; retrying the ack after a restart must return acknowledged again, not an error.' };
});

variant('V08-deadline-boundaries-and-sweep-races', ['T07', 'T10', 'T11', 'T37', 'T38'], 'persistence-restart + concurrent-race', async a => {
  const obs = {}; const results = {};
  for (const [label, at] of [['one tick before', LEASE - 1], ['exactly at', LEASE], ['one tick after', LEASE + 1]]) {
    await a.reset(); await setup(a, 'dl'); await claim(a, 'W1', 'dl'); const rid = a.maps.job.get('dl');
    await a.control({ op: 'advance', to: at }); await a.tick();
    results[label] = { at, expired: a.q1('SELECT state FROM claims WHERE request_id=?', rid).state === 'abandoned' };
  }
  obs.leaseBoundary = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { at: v.at, expiredByTick: v.expired }]));
  // sweep vs finish vs replacement claim, many rounds
  await a.reset(); const rounds = 16; const tally = {}; let oldEpochAuthorized = 0;
  for (let i = 0; i < rounds; i++) {
    const job = `sw-${i}`; await setup(a, job, 1e12); const c = await claim(a, 'W1', job); const rid = a.maps.job.get(job); const cid = a.nativeClaim(c.reply.value.claim);
    const pre = a.rev(job);
    await a.control({ op: 'advance', to: (i + 1) * 100000 });
    // the sweep, the old claimant's finish and a replacement claim all start from the pre-sweep revision
    const [, f, c2] = await Promise.all([a.tick(), a.mcp('W1', 'finish', finishArgs(a, job, cid, 'kf-old', { summary: 'old', expected_revision: pre })), a.mcp('W2', 'claim', claimArgs(a, job, 'W2', 'kc-w2-a', pre + 1))]);
    let c2b = null; if (c2.error && a.q1("SELECT state FROM claims WHERE request_id=?", rid)?.state === 'abandoned') c2b = await a.mcp('W2', 'claim', claimArgs(a, job, 'W2', 'kc-w2-b', a.rev(job))); // retry on the post-sweep revision
    const st = a.q1('SELECT status FROM assignments WHERE request_id=?', rid).status; const cl = a.q1('SELECT epoch,state,claimant FROM claims WHERE request_id=?', rid); const rep = a.q1('SELECT claim_id FROM reports WHERE request_id=?', rid);
    // old claim must not own a result once a newer epoch exists
    const stale = rep && cl.epoch > 1 && rep.claim_id === cid; if (stale) oldEpochAuthorized++;
    const key = `status=${st}|epoch=${cl.epoch}|finish=${f.error ? mapped(f.error) : 'ok'}|W2claim=${c2.error ? 'rejected' : 'ok'}${c2b ? `|W2retry=${c2b.error ? mapped(c2b.error) : 'ok'}` : ''}`; tally[key] = (tally[key] ?? 0) + 1;
    await free(a, job);
  }
  obs.sweepFinishClaimRace = { rounds, outcomes: tally, oldEpochResultAfterNewEpoch: oldEpochAuthorized };
  return { safetyHolds: oldEpochAuthorized === 0 && results['one tick before'].expired === false && results['exactly at'].expired === true && results['one tick after'].expired === true, exactMatch: false, observed: obs, expectation: 'now>=leaseUntil expires; one tick before does not; no old epoch becomes authorized through a stale receipt', note: 'Lease boundary: the lease expires when now >= lease deadline, not one tick before. Sweep, old-claimant finish and replacement claim race from one revision; after the race no result may belong to an older epoch than the current claim. No waiter or retention deadline is exercised here. The bridge accepts no client-supplied times except the payload retention time.' };
});

export async function runVariants({ clockScale = 1, only } = {}) {
  const out = [];
  for (const v of variants) {
    if (only && !only.some(id => v.id.startsWith(id))) continue;
    const a = new DotBridgeAdapter({ clockScale }); await a.init();
    const started = Date.now();
    try { const r = await v.fn(a); out.push({ id: v.id, traces: v.traces, level: v.level, status: r.notRun ? 'NOT_RUN' : r.safetyHolds ? (r.exactMatch ? 'PASS' : 'SAFETY_HOLDS_NOT_EXACT') : 'SAFETY_VIOLATED', ms: Date.now() - started, ...r }); }
    catch (e) { out.push({ id: v.id, traces: v.traces, level: v.level, status: 'ERROR', error: e.stack?.split('\n').slice(0, 4).join(' | ') }); }
    finally { await a.close(); }
  }
  return out;
}
