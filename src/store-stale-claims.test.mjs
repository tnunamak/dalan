import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, loadRedeliveryLimits } from './store.mjs';
import { HOST_BUDGET_CEILINGS, parseHostBudget, resolveHostStopEvidence } from './host-budget.mjs';

test('CLI guidance uses the stable command for the executable on PATH, but npx in npm exec', async t => {
  const { cliCommand } = await import('./cli-name.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-cli-name-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'dalan');
  fs.writeFileSync(bin, '', { mode: 0o700 });
  assert.equal(cliCommand(bin, { PATH: dir }), 'dalan');
  assert.equal(cliCommand(bin, { PATH: dir, npm_command: 'exec' }), 'npx @tnunamak/dalan');
});

test('suite self-test accepts a Node executable path containing spaces and an apostrophe', { skip: process.platform === 'win32' }, async t => {
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-segments-node-path-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scripts = path.join(dir, 'scripts');
  const fakeNode = path.join(dir, "operator's node");
  fs.mkdirSync(scripts);
  fs.symlinkSync(process.execPath, fakeNode);
  const runner = path.join(scripts, 'test-segments.mjs');
  const preload = path.join(dir, 'path-fixture.mjs');
  fs.copyFileSync(new URL('../scripts/test-segments.mjs', import.meta.url), runner);
  fs.writeFileSync(path.join(scripts, 'test-segments-test.mjs'), '');
  fs.writeFileSync(preload, 'Object.defineProperty(process, "execPath", { value: process.env.FIXTURE_NODE_PATH });');
  const result = spawnSync(process.execPath, ['--import', preload, runner, '--self-test'], {
    env: { HOME: dir, TMPDIR: dir, PATH: process.env.PATH, FIXTURE_NODE_PATH: fakeNode },
    encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS segment runner continues after failures/);
});

for (const [name, segments, testScript, diagnostic] of [
  ['blank segment', ['  '], 'node scripts/test-segments.mjs', /test segments must contain non-empty command strings/],
  ['wrong npm test entrypoint', ['fixture-command-must-not-run'], 'node alternate-test-runner.mjs', /npm test must use the sequential runner/],
]) {
  test('segment runner rejects ' + name + ' before starting any segment', async t => {
    const { spawnSync } = await import('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-segment-invalid-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const scripts = path.join(dir, 'scripts');
    fs.mkdirSync(scripts);
    const runner = path.join(scripts, 'test-segments.mjs');
    fs.copyFileSync(new URL('../scripts/test-segments.mjs', import.meta.url), runner);
    fs.writeFileSync(path.join(scripts, 'test-segments.json'), JSON.stringify(segments));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: testScript } }));
    const result = spawnSync(process.execPath, [runner], {
      cwd: dir, env: { HOME: dir, USERPROFILE: dir, TMPDIR: dir, TEMP: dir, PATH: process.env.PATH },
      encoding: 'utf8', timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, diagnostic);
    assert.doesNotMatch(result.stdout, /=== SEGMENT/);
  });
}

test('CLI guidance falls back to the checkout when a different dalan is first on PATH', async t => {
  const { cliCommand } = await import('./cli-name.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-cli-fallback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const checkout = path.join(dir, 'checkout with spaces.mjs');
  fs.writeFileSync(checkout, '', { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'dalan'), '', { mode: 0o700 });
  assert.equal(cliCommand(checkout, { PATH: dir }), "node '" + fs.realpathSync(checkout) + "'");
});

async function selfCheckFailureFixture(t) {
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-selfcheck-failure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'src'));
  const cli = path.join(dir, 'scripts', 'dalan-try-selfcheck.mjs');
  fs.copyFileSync(new URL('../scripts/dalan-try-selfcheck.mjs', import.meta.url), cli);
  fs.writeFileSync(path.join(dir, 'src', 'redirect-policy.mjs'), 'export const validateRedirectUri = () => ({ ok: true });');
  fs.writeFileSync(path.join(dir, 'src', 'try-selfcheck.mjs'), `
    export const SELFCHECK_REDIRECT = 'https://example.invalid/callback';
    export async function runSelfCheck({ url }) {
      throw new Error('fixture connection failed at ' + url);
    }
  `);
  return (vars = {}) => {
    const result = spawnSync(process.execPath, [cli, '--home', dir], {
      env: { HOME: dir, USERPROFILE: dir, ...vars }, encoding: 'utf8', timeout: 5000,
    });
    assert.ifError(result.error);
    return result;
  };
}

test('trial self-check reports usage when the supplied home lacks a resource-url file', async t => {
  const invoke = await selfCheckFailureFixture(t);
  const result = invoke();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^usage:/);
  assert.equal(result.stdout, '');
});

test('trial self-check reports the failed result without echoing the attempted URL', async t => {
  const invoke = await selfCheckFailureFixture(t);
  const url = 'https://example.invalid/fixture-marker';
  const result = invoke({ DALAN_TRY_URL: url });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /RESULT FAIL/);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-marker|fixture connection failed/);
});

const minute=60000;
function fixture(t) {
  let now=Date.parse('2026-11-13T12:00:00Z');
  const store=new Store(':memory:',{now:()=>now});
  t.after(()=>store.db.close());
  const at=new Date(now).toISOString();
  // Persist real rows so the liveness SELECT must include last_tool_at.
  store.db.prepare("INSERT INTO assignments(request_id,payload,payload_hash,thread_id,environment_id,status,created_at,target_worker) VALUES(?,?,?,?,?,'claimed',?,'dot')")
    .run('idle-test','{}','fixture','','',at);
  store.db.prepare("INSERT INTO claims(request_id,claimant,claim_id,claimed_at,subject,worker,state,last_claim_activity_at,lease_ms,lease_deadline_at) VALUES(?,?,?,?,?,'dot','active',?,?,?)")
    .run('idle-test','test-worker','test-claim',at,'local-principal',at,60*minute,new Date(now+60*minute).toISOString());
  const row=()=>store.db.prepare('SELECT * FROM claims WHERE request_id=?').get('idle-test');
  return {store,row,advance:n=>{now+=n;},stamp:()=>new Date(now).toISOString()};
}

test('status reports a 20-minute idle claim despite a live lease, without mutating it',t=>{
  const f=fixture(t);f.advance(20*minute);
  // A lease touch alone is not progress or a recorded tool call.
  f.store.db.prepare('UPDATE claims SET last_claim_activity_at=?,lease_deadline_at=? WHERE request_id=?')
    .run(f.stamp(),'2026-11-13T14:00:00Z','idle-test');
  const before=f.row();
  const status=f.store.status();
  assert.equal(status.stale_claims.count,1);
  assert.equal(status.stale_claims.threshold_ms,15*minute);
  assert.equal(status.stale_claims.max_idle_ms,20*minute);
  assert.deepEqual(status.stale_claims.items,[{
    request_id:'idle-test',idle_ms:20*minute,last_progress_at:null,last_tool_at:null,
  }]);
  assert.deepEqual(status.by_worker.dot.stale_claims,status.stale_claims);
  assert.deepEqual(f.row(),before);
  assert.deepEqual({...f.store.db.prepare('SELECT status,cancelled_at FROM assignments WHERE request_id=?').get('idle-test')},{status:'claimed',cancelled_at:null});
});

test('an assignment tool call two minutes ago keeps a 20-minute-old claim fresh',t=>{
  const f=fixture(t);f.advance(18*minute);
  f.store.db.prepare('UPDATE claims SET last_tool_at=? WHERE request_id=?').run(f.stamp(),'idle-test');
  f.advance(2*minute);
  assert.equal(f.store.status().stale_claims.count,0);
  assert.equal(f.store.status().stale_claims.max_idle_ms,null);
});

test('idle observation changes at the boundary without changing assignment state',t=>{
  const f=fixture(t);
  f.advance(15*minute-1);
  assert.equal(f.store.status().stale_claims.count,0);
  f.advance(1);
  assert.equal(f.store.status().stale_claims.count,1);
  assert.equal(f.row().state,'active');
});

test('repeated status reads report the same idle observation at a frozen clock',t=>{
  const f=fixture(t);
  f.advance(23*minute);
  const before=f.row();
  const first=f.store.status().stale_claims;
  const second=f.store.status().stale_claims;
  assert.equal(first.count,1);
  assert.deepEqual(second,first);
  assert.deepEqual(f.row(),before);
});

test('recent progress independently keeps a claim fresh',t=>{
  const f=fixture(t);f.advance(18*minute);
  f.store.db.prepare('UPDATE claims SET last_progress_at=? WHERE request_id=?').run(f.stamp(),'idle-test');
  f.advance(2*minute);
  assert.equal(f.store.status().stale_claims.count,0);
});

test('threshold is configurable and exact boundary is stale',t=>{
  const f=fixture(t);f.advance(20*minute);
  assert.equal(f.store.status({limits:{...f.store.limits,claimIdleWarningMs:21*minute}}).stale_claims.count,0);
  assert.equal(f.store.status({limits:{...f.store.limits,claimIdleWarningMs:20*minute}}).stale_claims.count,1);
});

test('post-start hold and future lease do not suppress idle observations',t=>{
  const f=fixture(t);f.advance(20*minute);
  f.store.startedMs=f.store.nowMs();
  assert.equal(f.store.heldAfterStart(f.row()),true);
  assert.equal(f.store.leaseExpired(f.row()),false);
  assert.equal(f.store.status().stale_claims.count,1);
});

test('terminal claims are not counted',t=>{
  const f=fixture(t);f.advance(20*minute);
  f.store.db.prepare("UPDATE assignments SET status='finished' WHERE request_id=?").run('idle-test');
  assert.equal(f.store.status().stale_claims.count,0);
});

test('host budget refuses a missing required limit', () => {
  const budget = {...HOST_BUDGET_CEILINGS};
  delete budget.output_bytes;
  assert.throws(() => parseHostBudget(budget), /host_budget requires.*output_bytes/);
});

test('host budget names the misaligned memory or disk limit', () => {
  for (const limit of ['memory_bytes', 'disk_write_bytes']) {
    const budget = {...HOST_BUDGET_CEILINGS, [limit]: HOST_BUDGET_CEILINGS[limit] - 1};
    assert.throws(() => parseHostBudget(budget), new RegExp('invalid host_budget\\.' + limit + ': expected a multiple of 4096'));
  }
});

test('host stop evidence stays unverified when remaining processes are reported or unknown', () => {
  const base = { verified: true, reason: 'synthetic test receipt' };
  assert.deepEqual(resolveHostStopEvidence(null, null), null);
  for (const evidence of [base, { ...base, remaining_pids: [123] }]) {
    assert.deepEqual(resolveHostStopEvidence(null, evidence), { ...evidence, verified: false });
    assert.equal(evidence.verified, true, 'validation must not mutate the supplied evidence');
  }
  assert.deepEqual(resolveHostStopEvidence(null, { ...base, remaining_pids: [] }),
    { ...base, remaining_pids: [] });
});

test('host budget rejects one over the process ceiling with a named limit', () => {
  const atLimit = { ...HOST_BUDGET_CEILINGS };
  assert.deepEqual(parseHostBudget(atLimit), atLimit);
  assert.throws(() => parseHostBudget({ ...atLimit, processes: atLimit.processes + 1 }),
    /invalid host_budget\.processes/);
});

test('idle warning configuration defaults, validates, and is distinct from legacy lease setting',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-idle-warning-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'limits.json');
  assert.equal(loadRedeliveryLimits(file).claimIdleWarningMs,15*minute);
  fs.writeFileSync(file,JSON.stringify({claim_idle_warning_ms:20*minute,stale_claim_ms:60*minute}),{mode:0o600});
  const limits=loadRedeliveryLimits(file);
  assert.equal(limits.claimIdleWarningMs,20*minute);
  assert.equal(limits.leaseMs,60*minute);
  for(const value of [0,-1,1.5,'900000',604800001]) {
    fs.writeFileSync(file,JSON.stringify({claim_idle_warning_ms:value}));
    assert.throws(()=>loadRedeliveryLimits(file),/invalid claim_idle_warning_ms/);
  }
});

for(const [name,accepted,refused] of [['minimum',60000,59999],['maximum',604800000,null]]) {
  test(`idle warning accepts its ${name}`,t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-idle-warning-boundary-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const file=path.join(dir,'limits.json');
    fs.writeFileSync(file,JSON.stringify({claim_idle_warning_ms:accepted}),{mode:0o600});
    assert.equal(loadRedeliveryLimits(file).claimIdleWarningMs,accepted);
    if(refused!==null) {
      fs.writeFileSync(file,JSON.stringify({claim_idle_warning_ms:refused}),{mode:0o600});
      assert.throws(()=>loadRedeliveryLimits(file),/invalid claim_idle_warning_ms/);
    }
  });
}

test('try refuses conflicting local and public modes in either order', async () => {
  const { parseTryArgs } = await import('./try.mjs');
  for (const argv of [['--local', '--public'], ['--public', '--local']]) {
    assert.throws(() => parseTryArgs(argv), /--local cannot be combined with --public/);
  }
  assert.equal(parseTryArgs(['--local', '--local']).mode, 'local');
  assert.equal(parseTryArgs(['--public', '--public']).mode, 'public');
});


test('try rejects an unrecognizable pending list or incomplete attempt', async () => {
  const { parsePending } = await import('./try.mjs');
  assert.throws(() => parsePending({ window: null }), /no pending list/);
  assert.throws(() => parsePending({ window: {}, pending: [] }), /bad window/);
  assert.throws(() => parsePending({ window: null, pending: [{ code: 'fixture-only' }] }),
    /attempt without client_id/);
  assert.deepEqual(parsePending({ window: null, pending: [] }), { window: null, pending: [] });
});

test('try suggests only the newest live native attempt without hiding browser attempts', async () => {
  const { parsePending } = await import('./try.mjs');
  const attempt = (code, native, superseded = false) => ({
    code, native, superseded, client_id: 'fixture-app', redirect_uri: 'https://client.invalid/return',
    scopes: ['read'], expires_in_seconds: 45,
  });
  const entries = [
    attempt('prior', true), attempt('browser', false), attempt('current', true), attempt('closed', true, true),
  ];
  const parsed = parsePending({ window: { worker: 'fixture' }, pending: entries });
  assert.deepEqual(parsed.pending.map(({ code, superseded }) => [code, superseded]),
    [['prior', true], ['browser', false], ['current', false], ['closed', true]]);
  assert.equal(entries[0].superseded, false, 'input is not rewritten');
  assert.equal(parsed.pending[2].expires_in_seconds, 45);
});

test('lineBuffer assembles split CRLF lines and flushes an unterminated final line once', async () => {
  const { lineBuffer } = await import('./try-exposure.mjs');
  const lines = [];
  const push = lineBuffer(line => lines.push(line));
  push('one\r');
  assert.deepEqual(lines, []);
  push('\ntwo\nlast');
  assert.deepEqual(lines, ['one', 'two']);
  push.end();
  push.end();
  assert.deepEqual(lines, ['one', 'two', 'last']);
});

test('try refuses malformed scope entries instead of coercing them for display', async () => {
  const { parsePending } = await import('./try.mjs');
  const attempt = {
    code: 'fixture', client_id: 'fixture-app', redirect_uri: 'https://client.invalid/return',
  };
  for (const scopes of [[17], ['read', null], ['']]) {
    assert.throws(() => parsePending({ window: null, pending: [{ ...attempt, scopes }] }),
      /attempt with invalid scopes/);
  }
  for (const scopes of [[], ['read', 'write']]) {
    const parsed = parsePending({ window: null, pending: [{ ...attempt, scopes }] });
    assert.deepEqual(parsed.pending[0].scopes, scopes);
    assert.notEqual(parsed.pending[0].scopes, scopes);
  }
});

test('lineBuffer retains the configured tail while waiting for a final newline', async () => {
  const { lineBuffer } = await import('./try-exposure.mjs');
  const lines = [];
  const push = lineBuffer(line => lines.push(line), 4);
  push('discard-kept');
  assert.deepEqual(lines, []);
  push('\n');
  push.end();
  assert.deepEqual(lines, ['kept']);
});

async function runUpgradeDrainFixture(t, args, extraEnv = {}) {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../scripts/upgrade-drain.mjs', import.meta.url));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-drain-args-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  // A regression must never reach a real bin/dot-worker.mjs or use the host HOME.
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env: { HOME: cwd, USERPROFILE: cwd, SYSTEMROOT: process.env.SYSTEMROOT, ...extraEnv },
    encoding: 'utf8',
    timeout: 2000,
  });
}

test('upgrade-drain rejects a subminimum timeout before pausing or quiescing', async t => {
  for (const args of [[], ['--until-quiescent']]) {
    const result = await runUpgradeDrainFixture(t, args, { DALAN_UPGRADE_DRAIN_TIMEOUT_MS: '999' });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DALAN_UPGRADE_DRAIN_TIMEOUT_MS must be an integer of at least 1000/);
    assert.match(result.stderr, args.length ? /quiesce off/ : /dalan resume/);
    assert.equal(result.stdout, '');
  }
});
