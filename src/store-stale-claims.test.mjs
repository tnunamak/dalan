import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, loadRedeliveryLimits } from './store.mjs';
import { HOST_BUDGET_CEILINGS, parseHostBudget } from './host-budget.mjs';

test('CLI guidance uses the stable command for the executable on PATH, but npx in npm exec', async t => {
  const { cliCommand } = await import('./cli-name.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-cli-name-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'dalan');
  fs.writeFileSync(bin, '', { mode: 0o700 });
  assert.equal(cliCommand(bin, { PATH: dir }), 'dalan');
  assert.equal(cliCommand(bin, { PATH: dir, npm_command: 'exec' }), 'npx @tnunamak/dalan');
});

test('CLI guidance falls back to the checkout when a different dalan is first on PATH', async t => {
  const { cliCommand } = await import('./cli-name.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-cli-fallback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const checkout = path.join(dir, 'checkout with spaces.mjs');
  fs.writeFileSync(checkout, '', { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'dalan'), '', { mode: 0o700 });
  assert.equal(cliCommand(checkout, { PATH: dir }), "node '" + fs.realpathSync(checkout) + "'");
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

async function runDrainErrorFixture(t, args, responder) {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-drain-errors-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, 'bin'));
  fs.writeFileSync(path.join(cwd, 'bin', 'dot-worker.mjs'), responder);
  const cli = fileURLToPath(new URL('../scripts/upgrade-drain.mjs', import.meta.url));
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env: { HOME: cwd, USERPROFILE: cwd, SYSTEMROOT: process.env.SYSTEMROOT },
    encoding: 'utf8', timeout: 3000,
  });
}

test('upgrade-drain reports a failed pause without claiming the queue is safe', async t => {
  const result = await runDrainErrorFixture(t, [], [
    'if (process.argv[2] !== "pause") process.exit(9);',
    'console.error("synthetic pause refusal");',
    'process.exitCode = 42;',
  ].join('\n'));
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /dalan pause failed: synthetic pause refusal/);
  assert.match(result.stderr, /dalan resume/);
});

test('upgrade-drain refuses an invalid quiesce snapshot without telling the operator to restart', async t => {
  const result = await runDrainErrorFixture(t, ['--until-quiescent'], [
    'if (process.argv[2] !== "quiesce") process.exit(9);',
    'if (process.argv[3] === "on") console.log("{}");',
    'else if (process.argv[3] === "status") console.log(JSON.stringify({admitted_in_flight:0,delivery_in_flight:0}));',
    'else process.exitCode = 9;',
  ].join('\n'));
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid in-flight counters/);
  assert.match(result.stderr, /dalan quiesce off/);
  assert.doesNotMatch(result.stdout, /No admitted calls/);
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

test('upgrade-drain will not report an empty queue without a claims array', async t => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-drain-report-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, 'bin'));
  fs.writeFileSync(path.join(cwd, 'bin', 'dot-worker.mjs'), [
    'const operation = process.argv[2];',
    'if (operation === "pause") console.log("{}");',
    'else if (operation === "claims") console.log(process.env.OWNED_CLAIMS_REPORT);',
    'else process.exitCode = 2;',
  ].join('\n'));
  const cli = fileURLToPath(new URL('../scripts/upgrade-drain.mjs', import.meta.url));
  const run = payload => spawnSync(process.execPath, [cli], {
    cwd,
    env: { HOME: cwd, USERPROFILE: cwd, SYSTEMROOT: process.env.SYSTEMROOT, OWNED_CLAIMS_REPORT: payload },
    encoding: 'utf8',
    timeout: 3000,
  });
  for (const report of ['{}', '{"claims":null}']) {
    const refused = run(report);
    assert.ifError(refused.error);
    assert.equal(refused.status, 1, 'an unmeasured queue must not authorize restart');
    assert.match(refused.stderr, /dalan claims returned no claims array/);
    assert.doesNotMatch(refused.stdout, /No unexpired claims remain/);
  }
  const empty = run('{"claims":[]}');
  assert.ifError(empty.error);
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /No unexpired claims remain/);
});

test('try refuses conflicting local and public modes in either order', async () => {
  const { parseTryArgs } = await import('./try.mjs');
  for (const argv of [['--local', '--public'], ['--public', '--local']]) {
    assert.throws(() => parseTryArgs(argv), /--local cannot be combined with --public/);
  }
  assert.equal(parseTryArgs(['--local', '--local']).mode, 'local');
  assert.equal(parseTryArgs(['--public', '--public']).mode, 'public');
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

test('upgrade-drain refuses unknown flags before operating on the service', async t => {
  const result = await runUpgradeDrainFixture(t, ['--unknown-option']);
  assert.ifError(result.error);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown argument "--unknown-option"/);
  assert.match(result.stderr, /only option is --until-quiescent/);
  assert.equal(result.stdout, '');
});

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
