#!/usr/bin/env node
// Stdio ACP agent (v1) that fronts the dot-bridge for T3 Code's acpRegistry "local" driver.
// One process per T3 thread. stdout carries only protocol frames; every log line goes to stderr.
// Shared ACP support lives in integrations/t3/acp-kit/.
import { Readable, Writable } from 'node:stream';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk';
import { sessionPath, readJsonPrivate, writeJsonPrivate } from '../integrations/t3/acp-kit/src/session-store.mjs';
import { acquireLock, LockBusyError } from '../integrations/t3/acp-kit/src/lock.mjs';
import { createRefuse, cancelBudgetMs, CANCEL_CLEANUP_MS } from '../integrations/t3/acp-kit/src/errors.mjs';
import { detectPresentPatches } from '../src/patch-apply.mjs';
import {
  paths, adminRequest, transient, sha256, parsePrompt, attemptId, ownerToken, readOrCreateSecret, bridgeRefusal,
  prepareAssignment, sizeRefusal, withoutNote, Refusal, verdictRefusal, CONTINUE_PROMPT, promptText, isBuild, buildResultText, decideHint, runBuildProseCheck, adminArtifact,
} from '../src/acp-bridge.mjs';

const num = (name, fallback) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : fallback; };
const HEARTBEAT_MS = num('DOT_ACP_HEARTBEAT_MS', 30_000);
const IN_FLIGHT_CAP = num('DOT_ACP_INFLIGHT_CAP', 10);
const VALID_MS = num('DOT_ACP_VALID_MINUTES', 30) * 60_000;
const OUTAGE_MS = num('DOT_ACP_OUTAGE_MS', 600_000);
const CANCEL_BUDGET_MS = cancelBudgetMs(process.env.DOT_ACP_CANCEL_BUDGET_MS); // T3 allows 10 s for the prompt to return after session/cancel
// Submit does server-side work that reads never do (it reads the pinned repository to scan the scope, checks pull request
// state and, for builds, runs the check-readiness probes), so it gets its own deadline; every other call keeps the 5 s
// DOT_ACP_HTTP_TIMEOUT_MS. A submit that times out is retried by request id, which the bridge treats as the same job.
const SUBMIT_DEADLINE_MS = num('DOT_ACP_SUBMIT_DEADLINE_MS', 30_000);
const SUBMIT_RETRIES = 2;
const MAX_ATTEMPTS = 6;
const MAX_EXPIRIES = 3;
// One adapter serves several bridge workers: DOT_ACP_WORKER picks the bridge worker that submissions target (unset = the
// bridge default, the worker), and DOT_ACP_MODEL/DOT_ACP_LABEL name the T3 model. DOT_ACP_SOCKET picks the bridge.
const WORKER = process.env.DOT_ACP_WORKER || null;
// Same rule as a worker name in workers.json (src/workers.mjs).
if (WORKER !== null && !/^[a-z][a-z0-9_-]{0,31}$/.test(WORKER)) throw new Error('DOT_ACP_WORKER must be a worker name');
const MODEL = process.env.DOT_ACP_MODEL || 'dot';
const LABEL = process.env.DOT_ACP_LABEL || (WORKER ? `Dalan worker: ${WORKER}` : 'Dalan worker');
const P = paths();
const log = (...a) => console.error('[dot-acp]', ...a);
const sleep = (ms, signal) => new Promise(resolve => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

// ---------------------------------------------------------------- durable session state
// One file per session (several adapter processes share the directory). Written atomically, mode 0600.
const sessions = new Map();
const sessionFile = id => {
  try { return sessionPath(P.stateDir, id); }
  catch (e) { if (e.code === 'invalid_session_id') throw acp.RequestError.invalidParams(null, 'invalid session id'); throw e; }
};
// Only a session that holds an assignment needs a file; probes and idle sessions leave nothing behind.
function saveSession(s) {
  if (!s.pending && !s.builds?.length) { fs.rmSync(sessionFile(s.id), { force: true }); return; }
  writeJsonPrivate(sessionFile(s.id), { id: s.id, cwd: s.cwd, model: s.model, pending: s.pending, builds: s.builds ?? [] });
}
const readSession = id => readJsonPrivate(sessionFile(id));

// Hold the session's lock file for the whole turn (portable O_EXCL lock; a crashed owner is detected by pid and start
// time). Every writer/deleter runs while the session has one owner.
async function lockSession(id) {
  try { return await acquireLock(`${sessionFile(id)}.lock`); }
  catch (e) { if (e instanceof LockBusyError) throw refuse(`session ${id} is active in another adapter`,{failure_type:'adapter_error',failure_type_source:'dot_acp_adapter'}); throw e; }
}

const configOptions = current => [{
  id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: current,
  options: [{ value: MODEL, name: LABEL }],
}];
const refuse = createRefuse(acp.RequestError); // T3 records a prompt error as a provider_error failure

// ---------------------------------------------------------------- bridge operations
let secret = null;
const tokenFor = rid => ownerToken(secret ??= readOrCreateSecret(P.secretFile), rid);
const call = (route, rid, opts = {}) => adminRequest(P.socket, route, { ...opts, token: rid ? tokenFor(rid) : undefined });

// The stored row for this request id with our token: null when the bridge has no such row, a Refusal when it is not ours.
async function readRow(rid) {
  try { return await call(`/get?id=${encodeURIComponent(rid)}&peek=1`, rid); }
  catch (e) {
    if (e.message === 'message not found' || e.message === 'assignment not found') return null;
    if (e.message === 'invalid owner capability') throw new Refusal(`request ${rid} exists under another owner`);
    throw e;
  }
}

// Find the assignment for this brief, or submit one. A retried or restarted task attaches to the row it already
// submitted, so the worker never gets the same brief twice:
//   no row                     -> check eligibility, submit
//   row with another brief     -> refuse (one root token must not serve two briefs)
//   row cancelled or expired   -> next attempt id `<root>_r<n>`
//   row queued/claimed/finished-> attach; the wait returns the result or keeps waiting
async function acquire(s, parsed) {
  const briefHash = sha256(parsed.brief);
  let submitRetries = 0;
  const preparedByAttempt=new Map();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const rid = attemptId(parsed.requestRoot, attempt);
    const row = await readRow(rid);
    if (row) {
      const storedHash = row.assignment.acp_brief_hash ?? sha256(withoutNote(row.assignment.brief ?? ''));
      if (storedHash !== briefHash) throw new Refusal(`token ${parsed.requestRoot} was already used with a different brief`);
      if (row.status === 'cancelled') continue;
      return { root: parsed.requestRoot, rid, attempt, briefHash, validUntil: row.assignment.valid_until ?? null, notes: [], startedAt: Date.now() };
    }
    const status = await call('/status', null);
    const refusal = bridgeRefusal(status, IN_FLIGHT_CAP);
    if (refusal) throw new Refusal(refusal,'deferred',{failure_type_source:'bridge_status_refusal',verdict:'defer'});
    let prepared=preparedByAttempt.get(rid);
    if(!prepared) {
      const validUntil = new Date(Date.now() + VALID_MS).toISOString();
      const assignment = await prepareAssignment({ cwd: s.cwd, requestId: rid, brief: parsed.brief, validUntil });
      const body = { max_queued: IN_FLIGHT_CAP, delivery: 'none', ...(WORKER ? { worker: WORKER } : {}), assignment, owner_token: tokenFor(rid), meta: { source: 'agent', ...(assignment.execution_scope === 'implementation' ? { task_kind: 'build' } : {}) }, ...(assignment.inputs.length && assignment.execution_scope !== 'implementation' ? { exclude_sensitive: true } : {}) };
      prepared={body,validUntil}; preparedByAttempt.set(rid,prepared);
    }
    const {body,validUntil}=prepared;
    try {
      let preview;
      try { preview=await call('/submit-preview',null,{method:'POST',payload:body,timeoutMs:SUBMIT_DEADLINE_MS}); }
      catch(error) {
        if(error.http_status===404) throw new Refusal('bridge does not support safe /submit-preview; no assignment was submitted','adapter_error',{failure_type_source:'bridge_compatibility'});
        throw error;
      }
      if(preview.verdict!=='admissible') throw verdictRefusal(preview);
      preparedByAttempt.set(rid,prepared);
    } catch(e) {
      if(e instanceof Refusal) throw e;
      if(transient(e)&&submitRetries++<SUBMIT_RETRIES) { attempt--; continue; }
      throw e;
    }
    try { await call('/submit', null, { method: 'POST', payload: body, timeoutMs: SUBMIT_DEADLINE_MS }); }
    catch (e) {
      if (e.message === 'request_id conflict') { attempt--; continue; } // lost a race: re-read the row
      if(e.verdict) throw verdictRefusal(e);
      // The bridge may have stored the job before the deadline; the same id and brief make the retry attach to it.
      if (transient(e) && submitRetries++ < SUBMIT_RETRIES) { attempt--; continue; }
      if (/^(?:worker|dot) queue is full/.test(e.message)) throw new Refusal(e.message);
      const size = e.http_status === 400 ? sizeRefusal(e.message, Buffer.byteLength(parsed.brief)) : null;
      if (size) throw new Refusal(size);
      throw e;
    }
    return { root: parsed.requestRoot, rid, attempt, briefHash, validUntil:prepared.validUntil, notes: [], startedAt: Date.now() };
  }
  throw new Refusal(`no usable assignment after ${MAX_ATTEMPTS} attempts for ${parsed.requestRoot}`);
}

async function resultText(row) {
  const r = row.report;
  let text = (r?.result || r?.summary || '').trim() || '(the worker finished without a result)';
  if (r && r.outcome !== 'completed') text = `[worker outcome: ${r.outcome}]\n${text}`;
  if (!isBuild(withoutNote(row.assignment?.brief ?? ''))) return `${text}\n\n${decideHint(row.request_id)}`;
  const art = r?.workspace_evidence?.patch_artifact;
  const patch = art?.artifact_id && art.size ? await adminArtifact(P.socket, art.artifact_id, tokenFor(row.request_id)) : null;
  const proseCheck = await runBuildProseCheck(row.assignment?.inputs?.[0]?.github_repo, patch);
  return buildResultText(row, text, patch, proseCheck);
}

// ---------------------------------------------------------------- patch observations
// A build result with a patch is remembered for this session (the last few). On the next prompt the adapter checks, read-only,
// whether that patch reverses cleanly against the requester's working tree. This
// is an advisory observation; only explicit owner actions record dispositions.
const MAX_TRACKED_BUILDS = 5;
function trackBuild(s, row) {
  const art = row.report?.workspace_evidence?.patch_artifact;
  if (!isBuild(withoutNote(row.assignment?.brief ?? '')) || !art?.artifact_id || !art.size) return;
  s.builds = [...(s.builds ?? []).filter(b => b.rid !== row.request_id), { rid: row.request_id, artifact_id: art.artifact_id, observed: false }].slice(-MAX_TRACKED_BUILDS);
}
async function reportPresentPatches(s, say) {
  const observed = await detectPresentPatches(s.builds ?? [], s.cwd, {
    fetchPatch: b => adminArtifact(P.socket, b.artifact_id, tokenFor(b.rid)),
    onError: (b, e) => log(`patch observation for ${b.rid} failed: ${e.message}`),
  });
  if (!observed.length) return;
  s.builds = s.builds.filter(b => !b.observed);
  saveSession(s);
  await say('agent_message_chunk', `worker: patch for ${observed.join(', ')} matches the working tree; no owner decision recorded.\n\n`);
}

// ---------------------------------------------------------------- the turn
function currentTurn(s, ctl) { return s.ctl === ctl && s.generation === ctl.generation; }
function publishPending(s, ctl) {
  if (!currentTurn(s, ctl)) return;
  s.pending = ctl.pending;
  saveSession(s);
}
async function runTurn(s, ctl, text, say) {
  const incoming = parsePrompt(text);
  let parsed = incoming;
  const notes = ctl.pending?.notes ?? [];
  if (ctl.pending) {
    const row = await readRowOrThrow(ctl.pending.rid);
    parsed = { brief: withoutNote(row.assignment.brief), requestRoot: ctl.pending.root };
  }
  for (let expiries = 0; ; expiries++) {
    if (ctl.pending) {
      // Attached already (a steer, or T3's continuation prompt after a restart): do not submit; report what was not sent.
      const steerText = text.trim();
      if (steerText && steerText !== CONTINUE_PROMPT && sha256(incoming.brief) !== ctl.pending.briefHash && !ctl.pending.notes.includes(steerText.slice(0, 200))) ctl.pending.notes.push(steerText.slice(0, 200));
      await say('agent_thought_chunk', `re-attached to ${ctl.pending.rid}\n`);
    } else {
      ctl.pending = await acquire(s, parsed);
      ctl.pending.notes = notes;
      await say('agent_thought_chunk', `worker assignment ${ctl.pending.rid}\n`);
    }
    publishPending(s, ctl);
    // A cancel that arrived while acquire was submitting found nothing to cancel; cancel the job it created now.
    if (ctl.cancelled) { ctl.cancelDone = Promise.resolve(ctl.cancelDone).then(() => cancelPending(s, ctl)); return { cancelled: true }; }
    const outcome = await waitLoop(s, ctl, say);
    if (outcome.expired) {
      if (expiries + 1 >= MAX_EXPIRIES) throw refuse(`assignment ${ctl.pending.rid} expired ${MAX_EXPIRIES} times before the worker claimed it`,{failure_type:'expired',failure_type_source:'bridge_observed_transition'});
      await say('agent_thought_chunk', `${ctl.pending.rid} expired unclaimed; resubmitting\n`);
      ctl.pending = null;
      publishPending(s, ctl);
      continue;
    }
    return outcome;
  }
}

async function heartbeat(s, ctl, say, note = '') {
  let state = '';
  try {
    const r = await call('/owner-states', null, { method: 'POST', payload: { items: [{ id: ctl.pending.rid, capability: tokenFor(ctl.pending.rid) }] } });
    state = r.states?.[0]?.status ?? 'unknown';
  } catch { state = 'bridge unreachable'; }
  const age = Math.round((Date.now() - ctl.pending.startedAt) / 1000);
  await say('agent_thought_chunk', `worker ${state}, ${age < 120 ? `${age} s` : `${Math.round(age / 60)} min`}${note}\n`);
}

// Block until the assignment ends. Returns {text}, {blocked,text}, {cancelled} or {expired}; throws on a hard failure.
async function waitLoop(s, ctl, say) {
  const slice = Math.max(1, Math.ceil(HEARTBEAT_MS / 1000));
  let outageSince = null;
  for (;;) {
    if (ctl.cancelled) return { cancelled: true };
    let r;
    try {
      r = await call(`/wait?id=${encodeURIComponent(ctl.pending.rid)}&timeout=${slice}&peek=1`, ctl.pending.rid, { signal: ctl.abort.signal });
      outageSince = null;
    } catch (e) {
      if (ctl.cancelled) return { cancelled: true };
      if (e.http_status === 409) { await sleep(1000, ctl.abort.signal); continue; } // our previous process's waiter has not detached yet
      if (!transient(e)) throw refuse(`worker bridge error: ${e.message}`,{failure_type:'adapter_error',failure_type_source:'dot_acp_bridge_response'});
      outageSince ??= Date.now();
      if (Date.now() - outageSince > OUTAGE_MS) throw refuse(`worker bridge unreachable for ${Math.round(OUTAGE_MS / 60000)} min: ${e.message}`,{failure_type:'transport_error',failure_type_source:'dot_acp_transport'});
      await say('agent_thought_chunk', `bridge unreachable (${e.message}); retrying\n`);
      await sleep(Math.min(2000, HEARTBEAT_MS), ctl.abort.signal);
      continue;
    }
    if (r.status === 'timeout') { await heartbeat(s, ctl, say); continue; }
    if (r.status === 'worker_break') { await say('agent_thought_chunk', `worker usage break: ${r.notice ?? ''}\n`); continue; }
    if (r.status === 'blocker' || r.status === 'question') return { blocked: true, text: `[worker ${r.status}] ${r.blocker_text ?? ''}`.trim() };
    if (r.status === 'finished') {
      const row = await readRowOrThrow(ctl.pending.rid), text = await resultText(row);
      trackBuild(s, row);
      return { text };
    }
    if (r.status === 'cancelled') {
      if (ctl.cancelled) return { cancelled: true };
      const row = await readRowOrThrow(ctl.pending.rid);
      if (row.cancelled_reason === 'expired') return { expired: true };
      const rid = ctl.pending.rid;
      ctl.pending = null;
      publishPending(s, ctl);
      throw refuse(`assignment ${rid} was cancelled (not by this session)`,{failure_type:'owner_cancelled',failure_type_source:'bridge_observed_transition'});
    }
    throw refuse(`unexpected wait status ${r.status}`,{failure_type:'adapter_error',failure_type_source:'dot_acp_adapter'});
  }
}
async function readRowOrThrow(rid) {
  const row = await readRow(rid);
  if (!row) throw refuse(`assignment ${rid} disappeared from the bridge`,{failure_type:'adapter_error',failure_type_source:'dot_acp_bridge_response'});
  return row;
}

// ---------------------------------------------------------------- agent
const agent = acp.agent({ name: 'dot-acp', version: '0.1.0' })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentInfo: { name: 'dot-acp', version: '0.1.0' },
    agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
    authMethods: [],
  }))
  // Free and instant: T3's discovery probe calls this every refresh. Never touches the bridge; params.mcpServers is ignored.
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    const s = { id: randomUUID(), cwd: params.cwd, model: MODEL, pending: null, ctl: null };
    sessions.set(s.id, s);
    return { sessionId: s.id, configOptions: configOptions(s.model) };
  })
  .onRequest(acp.methods.agent.session.load, ({ params }) => {
    sessionFile(params.sessionId); // validates the id
    const saved = readSession(params.sessionId); // a session without an assignment has no file: it restores empty
    sessions.set(params.sessionId, { id: params.sessionId, cwd: params.cwd ?? saved?.cwd, model: MODEL, pending: saved?.pending ?? null, builds: saved?.builds ?? [], ctl: null });
    return { configOptions: configOptions(MODEL) };
  })
  .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
    const s = sessions.get(params.sessionId);
    if (!s) throw acp.RequestError.invalidParams(null, 'unknown session');
    // T3 lists a `default` slug beside the advertised model, so accept it as the same single model.
    if (params.configId !== 'model' || ![MODEL, 'default'].includes(params.value)) throw acp.RequestError.invalidParams(null, `only model "${MODEL}" exists`);
    return { configOptions: configOptions(MODEL) };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const s = sessions.get(params.sessionId);
    if (!s) throw acp.RequestError.invalidParams(null, `unknown session ${params.sessionId}`);
    if (s.ctl) throw acp.RequestError.invalidRequest(null, 'prompt already active');
    const ctl = s.ctl = { abort: new AbortController(), cancelled: false, cancelDone: null, pending: null, generation: s.generation = (s.generation ?? 0) + 1 };
    const say = (type, text) => !currentTurn(s, ctl) ? Promise.resolve() : client.notify(acp.methods.client.session.update, { sessionId: s.id, update: { sessionUpdate: type, content: { type: 'text', text } } }).catch(() => {});
    let lock;
    try {
      lock = await lockSession(s.id);
      // session/load can precede another process finishing; read again under ownership.
      const saved = readSession(s.id);
      ctl.pending = s.pending = saved?.pending ?? null;
      s.builds = saved?.builds ?? s.builds ?? [];
      await reportPresentPatches(s, say);
      if (ctl.cancelled) {
        await Promise.race([cancelPending(s, ctl), sleep(CANCEL_CLEANUP_MS)]);
        return { stopReason: 'cancelled' };
      }
      let outcome;
      // T3 allows 10 s after session/cancel; if acquire or a notification stalls, answer anyway and let runTurn finish
      // in the background (its own cancelled check then cancels any job it created).
      const cancelled = new Promise(r => ctl.abort.signal.addEventListener('abort', () => setTimeout(() => r({ cancelled: true }), CANCEL_BUDGET_MS), { once: true }));
      const turn = runTurn(s, ctl, promptText(params.prompt), say);
      turn.catch(() => {});
      try { outcome = await Promise.race([turn, cancelled]); }
      catch (e) {
        if (ctl.cancelled) outcome = { cancelled: true };
        else if (e instanceof Refusal) {
          const data={};
          for(const key of ['failure_type','failure_type_source','verdict','reasons','bytes']) if(e[key]!==undefined) data[key]=e[key];
          throw refuse(`worker refused: ${e.message}`,data);
        }
        else if (e instanceof acp.RequestError) throw e;
        else throw refuse(`worker adapter error: ${e.message}`,{failure_type:transient(e)?'transport_error':'adapter_error',failure_type_source:'dot_acp_adapter'});
      }
      // Bounded: the 5 s fallback plus at most 2 s here stays inside T3's 10 s cancel window.
      if (outcome.cancelled) { await Promise.race([ctl.cancelDone, sleep(CANCEL_CLEANUP_MS)]); return { stopReason: 'cancelled' }; }
      const notes = ctl.pending.notes.map(n => `\n\nnot sent to the worker: ${n}`).join('');
      await say('agent_message_chunk', outcome.text + notes);
      if (!outcome.blocked) ctl.pending = null; // finished: the next prompt is a new request
      publishPending(s, ctl);
      return { stopReason: 'end_turn' };
    } finally {
      if (currentTurn(s, ctl)) s.ctl = null;
      lock?.release();
    }
  })
  // Answer the pending prompt as cancelled, then cancel the assignment only if no one claimed it. A claimed assignment keeps
  // running and stays retrievable: the next prompt (or a relaunch with the same token) re-attaches.
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    const s = sessions.get(params.sessionId);
    const ctl = s?.ctl;
    if (!ctl || ctl.cancelled) return;
    ctl.cancelled = true;
    ctl.cancelDone = cancelPending(s, ctl);
    ctl.abort.abort();
  });

async function cancelPending(s, ctl) {
  const pending = ctl.pending;
  if (!pending) return;
  try {
    const r = await Promise.race([call('/cancel-if-queued', pending.rid, { method: 'POST', payload: { id: pending.rid } }), sleep(CANCEL_BUDGET_MS).then(() => null)]);
    // Cancelled here or already (another session on the same token, or the operator): nothing is left to re-attach to.
    if ((r?.cancelled || r?.status === 'cancelled') && ctl.pending === pending) { ctl.pending = null; publishPending(s, ctl); log(`cancelled queued ${pending.rid}`); }
    else log(`cancel left ${pending.rid} ${r?.status ?? 'unknown'}`);
  } catch (e) { log(`cancel-if-queued failed for ${pending.rid}: ${e.message}`); }
}

// T3 closing our stdin means it is done with this session. Exit without cancelling anything: queued rows expire by
// valid_until, claimed rows finish and stay retrievable.
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
agent.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
log('ready');
