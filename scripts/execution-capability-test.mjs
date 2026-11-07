#!/usr/bin/env node
// Execution capability: the per-job `execution` field (none|worker|host), its defaults, retry conflicts, executor-aware admission,
// required_capabilities, and the worker_attested label. Drives the real server over the admin socket.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseWorkers } from '../src/workers.mjs';
import { admitHostExecution, hostBackend, hostReadiness } from '../src/execution.mjs';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// `dalan doctor` words the darwin case for the operator ("unavailable on macOS; ..."); the admission and
// hostReadiness() paths keep the "no host executor on darwin" wording. Each assertion uses its own pattern.
const unavailableReason = process.platform === 'linux' ? /resource_limits_unavailable/ : /unavailable on macOS: host checks are not available; jobs can still be delegated with --execution none \(no host checks\)/;
const unavailableHost = process.platform === 'linux' ? /capability_not_available: host_execution.*resource_limits_unavailable/ : /^capability_not_available: host_execution \(no host executor on darwin\)$/;

// ---- unit: profile default, readiness, capability admission ----
{
  const one = { dot: { connections: [{ issuer: 'https://i.test', subject: 's', client_id: 'c' }] } };
  assert.equal(parseWorkers({ workers: one }).defaultExecution, 'none', 'profile mode without default_execution means none');
  assert.equal(parseWorkers({ workers: one, default_execution: 'host' }).defaultExecution, 'host');
  assert.equal(parseWorkers({ workers: one, default_execution: 'worker' }).defaultExecution, 'worker');
  assert.throws(() => parseWorkers({ workers: one, default_execution: 'sandbox' }), /invalid workers: default_execution/);
  assert.equal((await import('../src/workers.mjs')).LEGACY_PROFILE.defaultExecution, 'host', 'the legacy profile keeps host execution');
  assert.equal(hostReadiness(() => true).ready, false);
  assert.match(hostReadiness(() => true).reason, process.platform === 'linux' ? /resource_limits_unavailable/ : /no host executor/);
  assert.throws(() => admitHostExecution([]), /capability_not_available: host_execution/);
  if (process.platform === 'linux') {
    assert.deepEqual(hostReadiness(() => false), { ready: false, reason: 'bwrap not found' });
    assert.match(hostReadiness(f => f !== '/usr/bin/bash').reason, /^bash not found/, 'the fd-closing launcher is a prerequisite too');
  } else console.log('SKIP Linux prerequisite probes: bwrap and bash host executor is Linux-only');
  assert.throws(() => admitHostExecution(null, { readiness: { ready: false, reason: 'bwrap not found' } }), /^Error: capability_not_available: host_execution \(bwrap not found\)$/);
  assert.throws(() => admitHostExecution(['native_darwin_execution'], { readiness: { ready: true } }), /capability_not_available: native_darwin_execution \(linux-bwrap-pasta v\d+ declares unsupported\)/);
  assert.throws(() => admitHostExecution(['not_a_capability'], { readiness: { ready: true } }), /capability_not_available: not_a_capability .* declares unknown/);
  // The default pasta backend writes no control-group stop receipt, so a job that requires full-tree cancellation is refused.
  assert.throws(() => admitHostExecution(['full_tree_cancel_verified'], { readiness: { ready: true } }), /capability_not_available: full_tree_cancel_verified \(linux-bwrap-pasta v\d+ declares unsupported\)/);
  admitHostExecution(['private_loopback', 'read_scope_enforced'], { readiness: { ready: true } });

  const previousHostChecks = process.env.DALAN_HOST_CHECKS;
  try {
    delete process.env.DALAN_HOST_CHECKS;
    assert.equal(hostBackend({ ready: true }).capabilities.full_tree_cancel_verified, 'unsupported', 'the pasta backend has no systemd control-group receipt');
    process.env.DALAN_HOST_CHECKS = '1';
    const systemdBackend = hostBackend({ ready: true });
    assert.equal(systemdBackend.name, 'linux-bwrap-systemd');
    assert.equal(systemdBackend.version, '1', 'the opted-in systemd backend uses its own versioned capability table');
    assert.equal(systemdBackend.capabilities.full_tree_cancel_verified, 'verified');
    assert.equal(systemdBackend.measured_by.full_tree_cancel_verified, 'scripts/host-stop-production-path-test.mjs');
  } finally { if (previousHostChecks === undefined) delete process.env.DALAN_HOST_CHECKS; else process.env.DALAN_HOST_CHECKS = previousHostChecks; }
}

// ---- server ----
const makeHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-exec-cap-'));
async function withServer({ port, workersFile, hideBwrap }, fn) {
  const home = makeHome(), fixture = path.join(home, 'fixture');
  const env = { ...process.env, HOME: home, DOT_BRIDGE_PORT: String(port), DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1', DOT_BRIDGE_T3_DRY_RUN: '1', DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE: fixture, ...(hideBwrap ? { DOT_BRIDGE_TEST_HIDE_BWRAP: '1' } : {}) };
  const git = (...args) => { const r = spawnSync('git', ['-C', fixture, ...args], { encoding: 'utf8', env }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  fs.mkdirSync(path.join(home, '.local/share/dot-bridge'), { recursive: true });
  fs.mkdirSync(fixture, { recursive: true });
  git('init'); git('config', 'user.name', 'F'); git('config', 'user.email', 'f@example.test');
  fs.mkdirSync(path.join(fixture, 'src')); fs.writeFileSync(path.join(fixture, 'src/a.js'), 'export const a=1;\n');
  // The default check needs a binary that is not on this host: only a host job may be blocked by it.
  fs.writeFileSync(path.join(fixture, '.dot-bridge.json'), JSON.stringify({ checks: { default: { argv: ['sh', '-c', 'true'], prerequisites: { binaries: ['definitely-missing-binary-xyz'] } } } }));
  git('add', '-A'); git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  const profile=structuredClone(workersFile??{default_execution:'host',workers:{dot:{connections:[{issuer:'https://fixture.invalid',subject:'fixture',client_id:'fixture'}]}}});
  for(const worker of Object.values(profile.workers))worker.repos??=['test/fixture'];
  fs.mkdirSync(path.join(home,'.config/dot-bridge'),{recursive:true});fs.writeFileSync(path.join(home,'.config/dot-bridge/workers.json'),JSON.stringify(profile),{mode:0o600});
  const service = spawn(process.execPath, ['src/server.mjs'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const serviceExit = new Promise(resolve => service.once('exit', resolve));
  let ready = false, stderr = ''; service.stdout.on('data', b => { if (String(b).includes('MCP listening')) ready = true; }); service.stderr.on('data', b => stderr += b);
  try {
    for (let i = 0; i < 200 && !ready; i++) await sleep(25);
    assert(ready, stderr);
    const admin = (route, body) => new Promise((resolve, reject) => { const req = http.request({ socketPath: path.join(home, '.local/share/dot-bridge/admin.sock'), path: route, method: 'POST', headers: { 'content-type': 'application/json' } }, res => { let b = ''; res.on('data', s => b += s); res.on('end', () => resolve({ code: res.statusCode, body: JSON.parse(b) })); }); req.on('error', reject); req.end(JSON.stringify(body)); });
    const db = () => new DatabaseSync(path.join(home, '.local/share/dot-bridge/bridge.db'));
    const row = id => { const d = db(); try { return d.prepare('SELECT execution,required_capabilities,payload FROM assignments WHERE request_id=?').get(id); } finally { d.close(); } };
    const task = (extra = {}) => ({ schema_version: 1, request_id: `req_${randomUUID()}`, brief: 'Fix the bug in src/a.js', inputs: [{ github_repo: 'test/fixture', base_sha: base }], expected_output: 'A patch', execution_scope: 'implementation', scope_paths: ['src/a.js'], ...extra });
    const submit = (assignment, extra = {}) => admin('/submit', { delivery: 'none', assignment, owner_token: 'exec-cap-owner', ...extra });
    await fn({ submit, task, row, admin, home });
  } finally { if (service.exitCode === null) service.kill('SIGTERM'); await serviceExit; fs.rmSync(home, { recursive: true, force: true }); }
}

// Legacy profile (no workers.json): host is the default, exactly as before this slice.
await withServer({ port: 19011 }, async ({ submit, task, row, admin, home }) => {
  const legacy = task();
  const blocked = await submit(legacy);
  assert.equal(blocked.code, 400, 'owner default is host: the disabled executor blocks admission');
  assert.match(blocked.body.error, unavailableHost);
  assert.equal(row(legacy.request_id),undefined);
  const doctor=spawnSync(process.execPath,['bin/dalan.mjs','doctor','--json'],{cwd:repo,encoding:'utf8',env:{...process.env,HOME:home}});
  assert.equal(doctor.status,0,doctor.stderr);
  const status=JSON.parse(doctor.stdout);
  assert.equal(status.host_executor.ready,false);
  assert.match(status.host_executor.reason,unavailableReason);
  // On macOS `doctor` reports no backend at all; elsewhere it lists the historical values, none of them verified.
  assert(process.platform === 'darwin' ? status.backend === null : !Object.values(status.backend.capabilities).includes('verified'),'disabled executor must not advertise verified live capabilities');

  // none and worker jobs do not probe host prerequisites, so the same repository is admitted.
  for (const execution of ['none', 'worker']) {
    const t = task(), r = await submit(t, { execution });
    assert.equal(r.code, 200, JSON.stringify(r)); assert.equal(r.body.execution, execution);
    assert.equal(row(t.request_id).execution, execution, 'stored in a column');
    assert(!JSON.parse(row(t.request_id).payload).execution, 'never in the payload');
    assert.deepEqual(r.body.check_readiness.probed, [], 'no host probes');
    // A retry that omits the field is not judged; a retry that names another value is a conflict.
    assert.equal((await submit(t)).code, 200);
    assert.equal((await submit(t, { execution })).code, 200);
    const other = await submit(t, { execution: execution === 'none' ? 'worker' : 'none' });
    assert.equal(other.code, 400); assert.match(other.body.error, /request_id conflict/);
  }
  assert.equal((await submit(task(), { execution: 'bogus' })).code, 400);
  assert.match((await submit(task(), { execution: 'bogus' })).body.error, /invalid execution/);

  // required_capabilities: only a host job can require them, and only verified ones are admitted.
  const refuse = async (extra, pattern) => { const t = task(), r = await submit(t, extra); assert.equal(r.code, 400, JSON.stringify(r)); assert.match(r.body.error, pattern); assert.equal(row(t.request_id), undefined, 'a refused submit stores no row'); };
  await refuse({ execution: 'host', required_capabilities: ['native_darwin_execution'] }, unavailableHost);
  await refuse({ execution: 'host', required_capabilities: ['immutable_input_snapshot'] }, unavailableHost);
  await refuse({ execution: 'host', required_capabilities: ['nope'] }, /invalid required_capabilities/);
  await refuse({ execution: 'worker', required_capabilities: ['private_loopback'] }, /only execution=host jobs can require bridge capabilities/);
});

// Same fixture, repository fine, but this host models "no executor": a host job is refused with the named reason, never queued.
await withServer({ port: 19012, hideBwrap: true }, async ({ submit, task, row }) => {
  const t = task({ scope_paths: ['src/a.js'] });
  const r = await submit(t, { execution: 'host' });
  assert.equal(r.code, 400); assert.equal(r.body.error, `capability_not_available: host_execution (${process.platform === 'linux' ? 'bwrap not found' : 'no host executor on darwin'})`); assert.equal(row(t.request_id), undefined);
  const legacyDefault = await submit(task());
  assert.equal(legacyDefault.code, 400); assert.equal(legacyDefault.body.error, `capability_not_available: host_execution (${process.platform === 'linux' ? 'bwrap not found' : 'no host executor on darwin'})`, 'the legacy default is host, so it is refused too');
  for (const execution of ['none', 'worker']) { const w = task(), ok = await submit(w, { execution }); assert.equal(ok.code, 200, JSON.stringify(ok)); assert.equal(row(w.request_id).execution, execution); }
});

// Profile mode: default_execution from workers.json; absent means none.
const dotWorker = { dot: { connections: [{ issuer: 'https://issuer.test', subject: 's', client_id: 'c' }] } };
await withServer({ port: 19013, workersFile: { workers: dotWorker } }, async ({ submit, task, row }) => {
  const t = task(), r = await submit(t); assert.equal(r.code, 200, JSON.stringify(r)); assert.equal(r.body.execution, 'none'); assert.equal(row(t.request_id).execution, 'none');
  assert.equal((await submit(t)).code, 200, 'retry keeps the stored default');
  const host = task(), h = await submit(host, { execution: 'host' }); assert.equal(h.code, 400, 'an explicit host job is refused while execution is disabled'); assert.match(h.body.error, unavailableHost);
});
await withServer({ port: 19014, workersFile: { workers: dotWorker, default_execution: 'worker' } }, async ({ submit, task, row }) => {
  const t = task(), r = await submit(t); assert.equal(r.code, 200, JSON.stringify(r)); assert.equal(row(t.request_id).execution, 'worker');
});

// worker_attested: a worker's own report is never labelled bridge_verified.
{
  const home = makeHome(); process.env.HOME = home;
  const { Store } = await import('../src/store.mjs');
  const store = new Store(path.join(home, 'db.sqlite'));
  const id = `req_${randomUUID()}`, payload = { schema_version: 1, request_id: id, brief: 'research', inputs: [{ revision: 'abc' }], expected_output: 'report', execution_scope: 'read-only' };
  store.submit(payload, 'none', 'environment', 'owner', false, null, 'normal', null, payload, null, null, 'worker');
  const claim = store.claim(id, 'dot', 'subject', 99).claim_id;
  store.finish(id, claim, 'completed', 'done; all my tests passed', 'report', 'subject');
  const got = store.get(id);
  assert.equal(got.execution, 'worker'); assert.equal(got.report.trust, 'worker_attested');
  assert.doesNotMatch(JSON.stringify(got), /bridge_verified/);
  store.db.close(); fs.rmSync(home, { recursive: true, force: true });
}
console.log('execution-capability-test: PASS');
