#!/usr/bin/env node
// Work-order compiler against a real bridge: `submit --dry-run` and `/submit-preview` store nothing and return the verdict,
// typed reasons with fixes and byte accounting; a real submit refuses with the same reasons and exit codes (reject 2, clarify 3,
// defer 4); defers queue by default unless --refuse-defer; typed failure reasons show in get; an owner cannot fake an expiry.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';
const repo = path.resolve(new URL('..', import.meta.url).pathname);
const home = fs.mkdtempSync(path.join(os.homedir(), '.tmp', 'dalan-work-order-'));
const fixture = path.join(home, 'fixture');
const env = { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: '', DOT_BRIDGE_PORT: '0', DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1', DOT_BRIDGE_T3_DRY_RUN: '1', DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE: fixture, PATH: `${path.join(home, 'bin')}:${process.env.PATH}` };
const dbFile = path.join(home, '.local/share/dot-bridge/bridge.db');
const assignment = (extra = {}) => ({ schema_version: 1, request_id: `req_${randomUUID()}`, brief: 'Inspect bounded input', inputs: [], expected_output: 'findings', execution_scope: 'read-only', ...extra });
const sleep = ms => new Promise(r => setTimeout(r, ms));
function git(args) { const r = spawnSync('git', args, { encoding: 'utf8', env }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); }
function cli(args, input = '') { return new Promise(resolve => { const c = spawn(process.execPath, ['bin/dalan.mjs', ...args], { cwd: repo, env }); let stdout = '', stderr = ''; c.stdout.on('data', b => stdout += b); c.stderr.on('data', b => stderr += b); c.on('close', code => resolve({ code, stdout, stderr })); c.stdin.end(input); }); }
function admin(route, body, headers = {}, method = 'POST', splitAt = null) { return new Promise((resolve, reject) => { const req = http.request({ socketPath: path.join(home, '.local/share/dot-bridge/admin.sock'), path: route, method, headers: { 'content-type': 'application/json', ...headers } }, res => { let b = ''; res.on('data', s => b += s); res.on('end', () => resolve({ code: res.statusCode, body: JSON.parse(b) })); }); req.on('error', reject); const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body)); if (splitAt === null) req.end(bytes); else { req.write(bytes.subarray(0, splitAt)); setTimeout(() => req.end(bytes.subarray(splitAt)), 50); } }); }
const rows = () => { const s = new Store(dbFile); const n = s.db.prepare('SELECT count(*) n FROM assignments').get().n; const e = s.db.prepare('SELECT count(*) n FROM lifecycle_events').get().n; s.db.close(); return { assignments: n, events: e }; };
const hasRow = id => { const s = new Store(dbFile); const r = s.hasAssignment(id); s.db.close(); return r; };
const receiptCount = () => { const dir = path.join(home, '.local/share/dot-bridge/receipts'); try { return fs.readdirSync(dir).length; } catch { return 0; } };
const receiptToken = id => { const dir = path.join(home, '.local/share/dot-bridge/receipts'); for (const name of fs.readdirSync(dir)) { const r=JSON.parse(fs.readFileSync(path.join(dir,name),'utf8')); if(r.request_id===id) return r.token; } throw new Error('receipt missing'); };
const logLines = () => { try { return fs.readFileSync(path.join(home, '.local/state/dot-bridge/requests.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
let service;
try {
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, 'bin', 'gh'), '#!/bin/sh\necho "unexpected gh call" >&2\nexit 1\n', { mode: 0o755 });
  fs.mkdirSync(path.join(home, '.local/share/dot-bridge'), { recursive: true });
  fs.mkdirSync(path.join(home,'.config/dot-bridge'),{recursive:true});
  fs.writeFileSync(path.join(home,'.config/dot-bridge/workers.json'),JSON.stringify({default_execution:'host',workers:{dot:{connections:[{issuer:'https://fixture.invalid',subject:'fixture',client_id:'fixture'}],repos:["test/fixture"]}}}),{mode:0o600});
  fs.mkdirSync(fixture, { recursive: true });
  git(['init', fixture]); git(['-C', fixture, 'config', 'user.name', 'Fixture']); git(['-C', fixture, 'config', 'user.email', 'fixture@example.test']);
  for (const file of ['safe.txt', 'src/a.ts', 'src/dup.txt', 'docs/dup.txt', 'lib/util.txt']) { const full = path.join(fixture, file); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, 'inert\n'); }
  git(['-C', fixture, 'add', '.']); git(['-C', fixture, 'commit', '-m', 'fixture']);
  const base = git(['-C', fixture, 'rev-parse', 'HEAD']);
  const scoped = (extra = {}) => assignment({ inputs: [{ github_repo: 'test/fixture', base_sha: base }], scope_paths: ['safe.txt'], ...extra });
  service = spawn(process.execPath, ['src/server.mjs'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false, stderr = ''; service.stdout.on('data', b => { if (String(b).includes('MCP listening')) ready = true; }); service.stderr.on('data', b => stderr += b);
  for (let i = 0; i < 400 && !ready; i++) await sleep(25); assert(ready, stderr);

  // 1. dry run of an admissible order: verdict, byte accounting after expansion, nothing stored, no receipt.
  {
    const before = rows(), a = scoped();
    const r = await cli(['submit', '--stdin', '--dry-run', '--json'], JSON.stringify(a));
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const out = JSON.parse(r.stdout);
    assert.equal(out.verdict, 'admissible'); assert.equal(out.stored, false); assert.equal(out.dry_run, true); assert.deepEqual(out.reasons, []);
    assert.equal(out.bytes.brief, Buffer.byteLength(a.brief));
    assert.ok(out.bytes.after_expansion.brief > out.bytes.brief, 'the scope allow-list is counted: ' + JSON.stringify(out.bytes));
    assert.ok(out.bytes.after_expansion.instructions > out.bytes.instructions);
    assert.equal(out.bytes.limits.brief, 16384);
    assert.deepEqual(out.normalized_scope.scope_paths, ['safe.txt']);
    assert.equal(hasRow(a.request_id), false); assert.deepEqual(rows(), before, 'dry run wrote rows'); assert.equal(receiptCount(), 0, 'dry run wrote a receipt');
    // The dedicated HTTP preview route returns the verdict and stores nothing.
    const http1 = await admin('/submit-preview', { delivery: 'none', assignment: a, owner_token: 'wo-owner' });
    assert.equal(http1.code, 200, JSON.stringify(http1)); assert.equal(http1.body.verdict, 'admissible'); assert.equal(http1.body.stored, false);
    assert.deepEqual(rows(), before);
    const ambiguousRoute = await admin('/submit?dry_run=1', { delivery: 'none', assignment: a, owner_token: 'wo-owner' });
    assert.equal(ambiguousRoute.code, 400); assert.match(ambiguousRoute.body.error,/requires POST \/submit-preview/); assert.deepEqual(rows(),before);
    // human mode prints the verdict on stderr
    const human = await cli(['submit', '--stdin', '--dry-run'], JSON.stringify(a)); assert.equal(human.code, 0); assert.match(human.stderr, /verdict: admissible[\s\S]*bytes: brief \d+ -> \d+ after expansion/);
    // the real submit stores it and sizes no default validity while the bridge has seen no queue waits
    const real = await cli(['submit', '--stdin', '--json'], JSON.stringify(a)); assert.equal(real.code, 0, real.stderr);
    assert.equal(hasRow(a.request_id), true);
    // Matching local receipts retain the same owner capability for a retry preview.
    const dup = await cli(['submit', '--stdin', '--dry-run', '--json'], JSON.stringify(a));
    assert.equal(dup.code, 0, dup.stderr); assert.equal(JSON.parse(dup.stdout).duplicate, true);
    const owner=receiptToken(a.request_id);
    const beforeRetry=rows();
    const rawMatch=await admin('/submit-preview',{delivery:'none',assignment:a,owner_token:owner,meta:{source:'agent'}});
    assert.equal(rawMatch.body.verdict,'admissible');assert.equal(rawMatch.body.duplicate,true);
    const store=new Store(dbFile);
    const check=(changes={})=>store.checkRetry(a,changes.delivery??{mode:'none'},null,changes.owner_token??owner,changes.review??false,changes.priority??'normal',changes.meta??{source:'agent'},changes.identity??a,changes.worker,changes.execution??null,changes.required_capabilities??null);
    assert.throws(()=>check({identity:{...a,brief:'changed immutable brief'}}),/request_id conflict/);
    assert.throws(()=>check({worker:'other-worker'}),/request_id conflict/);
    assert.throws(()=>check({execution:'none'}),/request_id conflict/);
    assert.throws(()=>check({required_capabilities:['synthetic-capability']}),/request_id conflict/);
    assert.throws(()=>check({meta:{source:'fix-loop'}}),/request_id conflict/);
    assert.throws(()=>check({delivery:{mode:'t3',threadId:'thread_synthetic'}}),/request_id conflict/);
    assert.throws(()=>check({owner_token:'wrong-owner'}),/request_id conflict/);
    store.db.close();
    assert.deepEqual(rows(),beforeRetry,'matching and conflicting retry previews do not mutate assignments or lifecycle events');
    const wrongCapability = await admin('/submit-preview', { delivery: 'none', assignment: a, owner_token: 'x' });
    assert.equal(wrongCapability.code, 200); assert.equal(wrongCapability.body.verdict, 'reject'); assert.match(wrongCapability.body.reasons[0].message, /request_id conflict/);
  }

  // 2. clarify: probable typo with its candidate, ambiguous bare filename with its candidates, missing inputs.
  const verdictOf = async (a, extraArgs = []) => { const r = await cli(['submit', '--stdin', '--dry-run', '--json', ...extraArgs], JSON.stringify(a)); return { code: r.code, out: JSON.parse(r.stdout) }; };
  const refusal = async (a, extraArgs = []) => { const r = await cli(['submit', '--stdin', '--json', ...extraArgs], JSON.stringify(a)); return { code: r.code, err: JSON.parse(r.stderr || r.stdout), stderr: r.stderr }; };
  {
    const typo = scoped({ scope_paths: ['src/aa.ts'] });
    const { code, out } = await verdictOf(typo);
    assert.equal(code, 3, JSON.stringify(out)); assert.equal(out.verdict, 'clarify');
    const reason = out.reasons.find(r => r.code === 'unknown_scope_path'); assert.ok(reason, JSON.stringify(out.reasons));
    assert.ok(reason.candidates.includes('src/a.ts'), JSON.stringify(reason)); assert.match(reason.fix, /did you mean src\/a\.ts/);
    const real = await refusal(typo); assert.equal(real.code, 3);
    assert.equal(real.err.verdict, 'clarify'); assert.deepEqual(real.err.reasons.map(r => r.code), out.reasons.map(r => r.code), 'dry run and real submit give the same reasons');
    assert.equal(hasRow(typo.request_id), false);

    const ambiguous = scoped({ brief: 'Look at dup.txt and tell me what it holds' });
    const amb = await verdictOf(ambiguous); assert.equal(amb.code, 3); const ar = amb.out.reasons.find(r => r.code === 'ambiguous_path');
    assert.ok(ar && ar.candidates.length === 2 && ar.candidates.includes('src/dup.txt') && ar.candidates.includes('docs/dup.txt'), JSON.stringify(amb.out.reasons));

    const noInputs = assignment({ output_paths: ['notes.md'] });
    const ni = await verdictOf(noInputs); assert.equal(ni.code, 3); assert.equal(ni.out.reasons[0].code, 'missing_inputs'); assert.match(ni.out.reasons[0].fix, /inputs/);
    assert.equal(ni.out.bytes.after_expansion, null, 'refused before expansion');
  }

  // The repository scanner runs in a worker thread. Preserve expanded UTF-8 byte counts on refusal.
  {
    const expanded = scoped({ request_id: 'req_multibyte_expansion', brief: 'é'.repeat(8180), output_paths: ['notes/new-file.txt'] });
    const body = { delivery: 'none', assignment: expanded, owner_token: 'byte-owner' };
    // Deliver the first byte of a multibyte character separately from its continuation.
    const splitAt = Buffer.from(JSON.stringify(body)).indexOf(Buffer.from('é')) + 1;
    const result = await admin('/submit-preview', body, {}, 'POST', splitAt);
    assert.equal(result.body.verdict, 'reject');
    assert.equal(result.body.bytes.brief, 16360);
    assert.ok(result.body.bytes.after_expansion.brief > result.body.bytes.limits.brief, JSON.stringify(result.body.bytes));
    assert.ok(result.body.bytes.over_by.brief > 0, JSON.stringify(result.body.bytes));
    assert.match(result.body.reasons[0].message, /UTF-8 bytes/);
  }
  // Private generic input values are not preview output, errors, or request-log content.
  {
    const sentinel = 'SYNTHETIC_PRIVATE_QUERY_SENTINEL';
    const privateInput = assignment({ request_id: 'req_private_input_fixture', inputs: [{ url: `https://private.invalid/resource?key=${sentinel}`, input_patch: sentinel }] });
    const result = await admin('/submit-preview', { delivery: 'none', assignment: privateInput, owner_token: sentinel });
    const evidence = JSON.stringify({ body: result.body, logs: logLines() });
    assert.equal(evidence.includes(sentinel), false, evidence);
    assert.deepEqual(result.body.normalized_scope.inputs, { count: 1, repository_pin_count: 0, repository_pins: [] });
    const cliPreview = await cli(['submit', '--stdin', '--dry-run', '--json'], JSON.stringify(privateInput));
    assert.equal((cliPreview.stdout + cliPreview.stderr).includes(sentinel), false, cliPreview.stdout + cliPreview.stderr);
    const malformed={...privateInput,request_id:'req_private_error_fixture',scope_paths:[`https://private.invalid/path?key=${sentinel}`]};
    const failedPreview=await admin('/submit-preview',{delivery:'none',assignment:malformed,owner_token:'safe-owner'});
    const failedCli=await cli(['submit','--stdin','--dry-run','--json'],JSON.stringify(malformed));
    const failedEvidence=JSON.stringify({body:failedPreview.body,logs:logLines(),stdout:failedCli.stdout,stderr:failedCli.stderr});
    assert.equal(failedEvidence.includes(sentinel),false,failedEvidence);
  }

  // 3. reject: forbidden or invalid.
  {
    const hard = scoped({ scope_paths: ['.env.fixture'] });
    const { code, out } = await verdictOf(hard); assert.equal(code, 2); assert.equal(out.verdict, 'reject'); assert.equal(out.reasons[0].code, 'sensitive_path_hard');
    const real = await refusal(hard); assert.equal(real.code, 2); assert.equal(real.err.reasons[0].code, 'sensitive_path_hard'); assert.ok(real.err.reasons[0].fix);
    const compatibilityFlag=scoped({request_id:'req_queue_anyway_scope_guard',scope_paths:['.env.fixture']}); const guarded=await refusal(compatibilityFlag,['--queue-anyway']); assert.equal(guarded.code,2); assert.equal(guarded.err.verdict,'reject'); assert.equal(hasRow(compatibilityFlag.request_id),false,'--queue-anyway does not bypass scope checks');
    const humanRefusal = await cli(['submit', '--stdin'], JSON.stringify(hard)); assert.equal(humanRefusal.code, 2); assert.match(humanRefusal.stderr, /dalan: verdict: reject[\s\S]*sensitive_path_hard \(scope_paths\)[\s\S]*fix: remove \.env\.fixture/);
    const traversal = await verdictOf(scoped({ scope_paths: ['../etc/passwd'] })); assert.equal(traversal.code, 2); assert.equal(traversal.out.reasons[0].code, 'invalid_path');
    const secret = await verdictOf(assignment({ brief: 'token ghp_' + 'a'.repeat(30) })); assert.equal(secret.code, 2); assert.equal(secret.out.reasons[0].code, 'secret_content');
    for(const malformed of [{...assignment(),expected_output:undefined},{...assignment(),schema_version:2},{...assignment(),execution_scope:null}]) {
      const before=rows(),bad=await admin('/submit-preview',{delivery:'none',assignment:malformed,owner_token:'malformed-owner'});
      assert.equal(bad.body.verdict,'reject',JSON.stringify(bad.body));
      assert.equal(bad.body.reasons[0].code,'invalid_schema',JSON.stringify(bad.body));
      assert.deepEqual(rows(),before,'invalid schema preview must not store anything');
    }
    const bad = await verdictOf({ ...assignment(), expected_output: undefined }); assert.equal(bad.code, 2); assert.equal(bad.out.reasons[0].code, 'invalid_schema',JSON.stringify(bad.out));
    // oversize: the fix says how many bytes to cut, and the accounting shows the overflow
    const big = await verdictOf(assignment({ brief: 'x'.repeat(16384 + 700) })); assert.equal(big.code, 2);
    assert.equal(big.out.reasons[0].code, 'brief_too_large'); assert.match(big.out.reasons[0].fix, /cut at least 700 bytes/); assert.equal(big.out.bytes.over_by.brief, 700);
  }

  // 4. defer: a paused bridge. Dry run reports it; real submit queues by default; --refuse-defer opts out; the HTTP default also queues.
  {
    assert.equal((await cli(['pause', '--reason', 'maintenance window'])).code, 0);
    const a = scoped();
    const { code, out } = await verdictOf(a); assert.equal(code, 4, JSON.stringify(out)); assert.equal(out.verdict, 'defer');
    assert.equal(out.reasons[0].code, 'worker_paused'); assert.match(out.reasons[0].message, /maintenance window/); assert.ok(out.retry_after_seconds > 0);
    const queued = await cli(['submit', '--stdin', '--json'], JSON.stringify(a)); assert.equal(queued.code, 0, queued.stderr); assert.equal(hasRow(a.request_id), true);
    const refusedOrder=scoped(); const refused = await refusal(refusedOrder,['--refuse-defer']); assert.equal(refused.code, 4, JSON.stringify(refused)); assert.equal(refused.err.verdict, 'defer'); assert.equal(hasRow(refusedOrder.request_id), false); assert.equal(receiptCount(), 2, 'refused fresh request leaves no receipt');
    const legacy = scoped(); const viaHttp = await admin('/submit', { delivery: 'none', assignment: legacy, owner_token: 'legacy-owner' }); assert.equal(viaHttp.code, 200, 'a raw HTTP submit without refuse_defer keeps queueing');
    const compatible=scoped(); const queuedCompat=await cli(['submit','--stdin','--json','--queue-anyway'],JSON.stringify(compatible)); assert.equal(queuedCompat.code,0,queuedCompat.stderr); assert.equal(hasRow(compatible.request_id),true);
    assert.equal((await cli(['resume'])).code, 0);
    assert.equal((await cli(['break','--reason','synthetic usage break'])).code,0);
    const breakQueued=scoped(); const breakSubmit=await cli(['submit','--stdin','--json'],JSON.stringify(breakQueued)); assert.equal(breakSubmit.code,0,breakSubmit.stderr); assert.equal(hasRow(breakQueued.request_id),true);
    // The PR-head-reviewer's ordinary live CLI shape includes background/review metadata and must queue during a break.
    const reviewerOrder=scoped(); const reviewerSubmit=await cli(['submit','--stdin','--json','--background','--exclude-sensitive','--allow-scope-prune','--deliver','none','--objective-key','pr:test/repo#70','--revision',base,'--task-kind','review','--source','agent'],JSON.stringify(reviewerOrder)); assert.equal(reviewerSubmit.code,0,reviewerSubmit.stderr); assert.equal(hasRow(reviewerOrder.request_id),true);
    const beforeRefusal=receiptCount(); const breakRefused=scoped(); const breakRefusal=await refusal(breakRefused,['--refuse-defer']); assert.equal(breakRefusal.code,4,JSON.stringify(breakRefusal)); assert.equal(breakRefusal.err.verdict,'defer'); assert.equal(hasRow(breakRefused.request_id),false); assert.equal(receiptCount(),beforeRefusal,'usage-break refusal leaves no fresh receipt');
    assert.equal((await cli(['break','--clear'])).code,0);
  }

  // A corrected uncreated request can replace an old CLI receipt; an accepted row stays immutable.
  {
    const a=scoped(), sentinel='SYNTHETIC_STALE_RECEIPT_CAPABILITY';
    const file=path.join(home,'.local/share/dot-bridge/receipts',createHash('sha256').update(a.request_id).digest('hex')+'.json');
    const stale=JSON.stringify({request_id:a.request_id,token:sentinel,body:JSON.stringify({...a,brief:'old uncreated request'}),delivery:'none',meta:{source:'agent'}})+'\n';
    fs.writeFileSync(file,stale,{mode:0o600});
    assert.equal(hasRow(a.request_id),false);
    const preview=await cli(['submit','--stdin','--dry-run','--json'],JSON.stringify(a));
    assert.equal(preview.code,1);assert.equal(fs.readFileSync(file,'utf8'),stale,'preview must not replace a persisted receipt');
    const corrected=await cli(['submit','--stdin','--json'],JSON.stringify(a));
    assert.equal(corrected.code,0,corrected.stderr);assert.equal(hasRow(a.request_id),true);
    const saved=fs.readFileSync(file,'utf8');assert.notEqual(JSON.parse(saved).token,sentinel);
    const changed=await cli(['submit','--stdin','--json'],JSON.stringify({...a,brief:'changed accepted request'}));
    assert.equal(changed.code,1);assert.equal(fs.readFileSync(file,'utf8'),saved,'accepted ownership and binding must remain unchanged');
    for(const r of [preview,corrected,changed]) assert.ok(!r.stdout.includes(sentinel)&&!r.stderr.includes(sentinel),'synthetic capability leaked');
  }

  // 5. typed failure reasons in get, and an owner cannot dress a cancel as an expiry.
  {
    const a = scoped(); assert.equal((await cli(['submit', '--stdin', '--json'], JSON.stringify(a))).code, 0);
    const legacyReason = await cli(['cancel', a.request_id, '--reason', 'expired', '--json']); assert.equal(legacyReason.code, 0, legacyReason.stderr);
    const got = JSON.parse((await cli(['get', a.request_id, '--json'])).stdout);
    assert.equal(got.status, 'cancelled'); assert.equal(got.cancelled_reason, 'expired'); assert.equal(got.failure_type, 'owner_cancelled'); assert.equal(got.failure_type_source, 'bridge_observed_transition'); assert.equal(got.expired, undefined);
    const waited = JSON.parse((await cli(['wait', a.request_id, '--timeout', '1', '--json'])).stdout);
    assert.equal(waited.failure_type, 'owner_cancelled'); assert.equal(waited.expired, undefined);
  }

  // 6. the request log types each refusal.
  {
    const sentinel='SYNTHETIC_PRIVATE_OBJECTIVE_SENTINEL';
    const refusal=await admin('/submit',{delivery:'none',assignment:assignment({brief:'x'.repeat(17000)}),owner_token:'synthetic-metadata-owner',meta:{source:'agent',task_kind:'review',objective_key:'https://private.invalid/?key='+sentinel,revision:'https://private.invalid/?key='+sentinel}});
    assert.equal(refusal.code,400);assert.ok(!JSON.stringify(refusal.body).includes(sentinel));
    assert.ok(!JSON.stringify(logLines()).includes(sentinel),'objective/revision metadata must not leak into logs');
    const refused = logLines().filter(l => l.kind === 'submit_rejected');
    assert.ok(refused.length >= 3, 'actual rejected submits are logged');
    assert.ok(refused.some(l=>l.reason_codes.includes('unknown_scope_path'))&&refused.some(l=>l.reason_codes.includes('sensitive_path_hard')),'typed reject and clarify outcomes are retained');
    for (const l of refused) { assert.ok(l.reason_codes.length >= 1); assert.ok(['reject', 'clarify', 'defer'].includes(l.verdict)); assert.ok(Number.isFinite(l.attempt_latency_ms)); }
    const dry = logLines().filter(l => l.kind === 'submit_dry_run'); assert.ok(dry.length >= 4 && dry.every(l => l.verdict));
    assert.ok(logLines().some(l => l.kind === 'submit_deferred' && l.reason_codes.includes('worker_paused')));
  }
  // 7. a refusal raised by an early request check (before the compiler runs) is typed and logged like any other.
  {
    const a = scoped();
    const refusal = await admin('/submit', { delivery: 'none', assignment: a, owner_token: 'wo-early-owner', command_key: '' });
    assert.equal(refusal.code, 400); assert.equal(refusal.body.verdict, 'reject'); assert.ok(refusal.body.reasons.length >= 1, 'a typed reason is returned');
    const logged = logLines().filter(l => l.kind === 'submit_rejected' && l.request_id === a.request_id);
    assert.equal(logged.length, 1, 'the early refusal is logged'); assert.equal(logged[0].verdict, 'reject'); assert.ok(logged[0].reason_codes.length >= 1);
    assert.equal(hasRow(a.request_id), false, 'a refused submit stores nothing');
    const preview = await admin('/submit-preview', { delivery: 'none', assignment: scoped(), owner_token: 'wo-early-owner', command_key: '' });
    assert.equal(preview.code, 200, JSON.stringify(preview)); assert.equal(preview.body.verdict, 'reject'); assert.equal(preview.body.stored, false);
  }
  console.log('work-order-e2e: PASS');
} finally { if (service) { await new Promise(resolve => { if(service.exitCode!==null) return resolve(); service.once('exit',resolve); service.kill('SIGTERM'); }); } fs.rmSync(home, { recursive: true, force: true }); }
