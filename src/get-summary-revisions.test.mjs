import test from 'node:test';
import assert from 'node:assert/strict';
import { formatGetSummary, formatGetEndNote } from './get-summary.mjs';

async function trialHomeCli(t) {
  const { mkdir, mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
  const { spawnSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const home = await mkdtemp(join(tmpdir(), 'dalan-bin-entry-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const trial = join(home, '.local', 'share', 'dalan-trial');
  await mkdir(trial, { recursive: true });
  await writeFile(join(trial, '.dalan-trial'), '');
  const bin = fileURLToPath(new URL('../bin/dalan.mjs', import.meta.url));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  return {version:pkg.version, run(...args) {
    const result = spawnSync(process.execPath, [bin, ...args], {
      env: { HOME:home, USERPROFILE:home, XDG_CONFIG_HOME:join(home,'.config') },
      encoding:'utf8', timeout:5000,
    });
    assert.ifError(result.error);
    return result;
  }};
}

test('dalan version flags print the package version with no trial-home requirement', async t => {
  const {run,version}=await trialHomeCli(t);
  for (const flag of ['--version', '-v']) {
    const result=run(flag);
    assert.equal(result.status,0,result.stderr);
    assert.equal(result.stdout,version+'\n');
    assert.equal(result.stderr,'');
  }
});

test('dalan help still opens with trial mode present and no bridge home selected', async t => {
  const {run}=await trialHomeCli(t);
  const result=run('--help');
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/\bdalan\b/i);
  assert.match(result.stdout,/\bsetup\b/i);
  assert.equal(result.stderr,'');
});

test('dead-man CLI reports unsupported commands and extra status arguments without opening a state file', async t => {
  const { mkdtemp, readdir, rm } = await import('node:fs/promises');
  const { spawnSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = await mkdtemp(join(tmpdir(), 'dalan-deadman-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../bin/dot-deadman.mjs', import.meta.url));
  for (const [args, message] of [
    [['report'], 'dalan-deadman: usage: dalan-deadman [serve|heartbeat|status|reconcile]'],
    [['status', 'unexpected'], 'dalan-deadman: usage: dalan-deadman status'],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      env: { HOME: root, USERPROFILE: root, DOT_DEADMAN_ENV: join(root, 'absent-env'),
        DOT_DEADMAN_DB: join(root, 'must-not-open.sqlite') },
      encoding: 'utf8', timeout: 5000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim().split('\n').at(-1), message);
    assert.deepEqual(await readdir(root), []);
  }
});

const options = { id: 'job-original', cli: 'dalan', decideWords: 'accepted|rejected|applied' };
for (const status of ['finished', 'running']) {
  test(`revised ${status} job points to correction without hiding original evidence`, () => {
    const job = { status, target_worker: 'dot', revised_by: { request_id: 'job-correction' },
      report: { outcome: 'completed', summary: 'Original summary', result: 'Original report remains readable' },
      artifacts: [{ id: 'artifact-original' }], checks: [{ id: 'check-original' }] };
    const before = structuredClone(job);
    const summary = formatGetSummary(job, options);
    assert.ok(summary.startsWith(`Job job-original: ${status}\n`));
    assert.ok(summary.includes('Correction: job-correction'));
    assert.ok(summary.includes('Next: dalan get job-correction'));
    assert.ok(summary.includes('Original summary'));
    assert.ok(summary.includes('Original report remains readable'));
    assert.ok(summary.includes('Evidence: 1 artifact, 1 check'));
    assert.ok(summary.includes('Full record: dalan get job-original --json'));
    assert.doesNotMatch(summary, /decide job-original|cancelled/);
    assert.equal(formatGetEndNote(job, options), 'Next: dalan get job-correction');
    assert.deepEqual(job, before);
  });
}
for (const [status, next, note] of [
  ['finished', 'Next: dalan decide job-original accepted', 'decide: dalan decide job-original accepted|rejected|applied'],
  ['running', 'Next: dalan wait job-original --timeout 3600, then dalan get job-original', null],
  ['cancelled', null, null],
]) {
  test(`unrevised ${status} guidance is unchanged`, () => {
    const summary = formatGetSummary({ status }, options);
    assert.equal(summary, `Job job-original: ${status}${next ? '\n\n' + next : ''}\nFull record: dalan get job-original --json`);
    assert.equal(formatGetEndNote({ status }, options), note);
    assert.doesNotMatch(summary, /Correction:/);
  });
}
async function alertCliResult(t, args, publisherFails = false) {
  const { copyFile, mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { spawnSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'dalan-alert-success-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'bin'));
  await mkdir(join(root, 'src'));
  const cli = join(root, 'bin', 'dot-alert.mjs');
  await copyFile(new URL('../bin/dot-alert.mjs', import.meta.url), cli);
  await writeFile(join(root, 'src', 'alerts.mjs'), `
    export async function publishAlert(title, message, log, options) {
      await new Promise(resolve => setTimeout(resolve, 10));
      if (${publisherFails}) throw new Error('fixture publisher unavailable');
      log('fixture diagnostic');
      console.log(JSON.stringify({ title, message, options }));
    }
  `);
  const result = spawnSync(process.execPath, [cli, ...args], {
    env: { HOME: root, USERPROFILE: root }, encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  return result;
}

async function successfulAlertCli(t, title, message) {
  const result = await alertCliResult(t, [title, message]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const [delivery, ...rest] = result.stdout.trimEnd().split('\n');
  return { delivery: JSON.parse(delivery), rest };
}

test('alert CLI refuses a missing message without invoking the publisher', async t => {
  const result = await alertCliResult(t, ['fixture title'], true);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'usage: dalan-alert TITLE MESSAGE');
});

test('alert CLI reports publisher failure without falsely acknowledging delivery', async t => {
  const result = await alertCliResult(t, ['fixture title', 'fixture message'], true);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /fixture publisher unavailable/);
});

test('alert CLI sends one intact title and body to the required publisher', async t => {
  const title = 'Fixture subject: two words';
  const message = 'first line\nsecond line with "quotes"';
  const { delivery } = await successfulAlertCli(t, title, message);
  assert.deepEqual(delivery, { title, message, options: { requirePublisher: true } });
});

test('alert CLI only acknowledges after asynchronous publication completes', async t => {
  const { rest } = await successfulAlertCli(t, 'fixture subject', 'fixture body');
  assert.deepEqual(rest, ['sent']);
});

test('running questions and original full-record access remain available after revision', () => {
  const summary = formatGetSummary({ status: 'running', revised_by: { request_id: 'job-correction' },
    progress: [{ note: 'QUESTION: Which fixture?' }] }, options);
  assert.ok(summary.includes('QUESTION: Which fixture?'));
  assert.ok(summary.includes('Answer with: dalan note job-original "TEXT"'));
  assert.ok(summary.includes('Full record: dalan get job-original --json'));
  assert.ok(summary.includes('Next: dalan get job-correction'));
});

async function heartbeatFailureFixture(t, healthFailure) {
  const { readFile, writeFile, mkdir, mkdtemp, rm } = await import('node:fs/promises');
  const { spawnSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'dalan-heartbeat-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'bin'));
  await mkdir(join(root, 'src'));
  const original = await readFile(new URL('../bin/dot-heartbeat.mjs', import.meta.url));
  await writeFile(join(root, 'bin/dot-heartbeat.mjs'), original);
  await writeFile(join(root, 'src/paths.mjs'), "export const defaultPath = (...parts) => parts.join('/');");
  await writeFile(join(root, 'src/env.mjs'), 'export const readEnv = name => process.env[name];');
  await writeFile(join(root, 'src/admin-socket.mjs'), 'export const adminSocketPath = () => "fixture";');
  await writeFile(join(root, 'src/host-health.mjs'), healthFailure
    ? 'export async function bridgeHealth() { throw new Error("fixture probe failed"); }'
    : 'export async function bridgeHealth() { return { healthy: true }; }');
  await writeFile(join(root, 'bin/dot-deadman.mjs'),
    'import { writeFileSync } from "node:fs"; writeFileSync(process.env.FIXTURE_SENTINEL, "entered"); process.exitCode = 7;');
  const health = join(root, 'health.json');
  const sentinel = join(root, 'child-entered');
  await writeFile(health, '{"healthy":true}');
  const result = spawnSync(process.execPath, [join(root, 'bin/dot-heartbeat.mjs')], {
    encoding: 'utf8',
    env: { DALAN_HEALTH_FILE: health, FIXTURE_SENTINEL: sentinel },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /health check or external heartbeat failed/);
  assert.equal(result.stdout, '');
  await assert.rejects(readFile(health), { code: 'ENOENT' });
  return { readFile, sentinel };
}

test('heartbeat probe failure removes stale health without launching the alert helper', async t => {
  const { readFile, sentinel } = await heartbeatFailureFixture(t, true);
  await assert.rejects(readFile(sentinel), { code: 'ENOENT' });
});

test('heartbeat helper failure retracts the positive health file and exits nonzero', async t => {
  const { readFile, sentinel } = await heartbeatFailureFixture(t, false);
  assert.equal(await readFile(sentinel, 'utf8'), 'entered');
});

async function deadmanHeartbeatRefusal(t, health) {
  const { readFile, writeFile, mkdir, mkdtemp, rm } = await import('node:fs/promises');
  const { spawnSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'dalan-deadman-refusal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'bin'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'bin/dot-deadman.mjs'),
    await readFile(new URL('../bin/dot-deadman.mjs', import.meta.url)));
  await writeFile(join(root, 'src/env.mjs'), 'export const readEnv = name => process.env[name];');
  await writeFile(join(root, 'src/deadman.mjs'),
    'export const createDeadmanFromEnv = () => { throw Error("unexpected monitor start"); }; export const readDeadmanStatus = () => { throw Error("unexpected DB access"); };');
  const preload = join(root, 'fixture-clock.mjs');
  await writeFile(preload, 'Date.now = () => Date.parse("2026-01-01T00:00:00Z"); globalThis.fetch = () => { throw Error("unexpected heartbeat publication"); };');
  const file = join(root, 'health.json');
  await writeFile(file, JSON.stringify(health));
  const result = spawnSync(process.execPath, ['--import', preload, join(root, 'bin/dot-deadman.mjs'), 'heartbeat'], {
    encoding: 'utf8', timeout: 5000,
    env: { HOME: root, DALAN_HEALTH_FILE: file, DOT_DEADMAN_ENV: join(root, 'missing-env'),
      DOT_DEADMAN_URL: 'https://fixture.example.test', DOT_DEADMAN_TOKEN: 'x'.repeat(32) },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'dalan-deadman: bridge health evidence is absent, unhealthy, or stale');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), health);
}

test('dead-man heartbeat refuses a recent unhealthy result without publishing', async t => {
  await deadmanHeartbeatRefusal(t, { healthy: false, observed_at: '2025-12-31T23:59:59Z' });
});

test('dead-man heartbeat refuses an unreadable observation date without publishing', async t => {
  await deadmanHeartbeatRefusal(t, { healthy: true, observed_at: 'not-a-date' });
});

test('dead-man heartbeat refuses old positive health evidence without publishing', async t => {
  await deadmanHeartbeatRefusal(t, { healthy: true, observed_at: '2025-12-31T23:58:29Z' });
});

test('dead-man heartbeat refuses health evidence beyond the future-skew allowance', async t => {
  await deadmanHeartbeatRefusal(t, { healthy: true, observed_at: '2026-01-01T00:00:31Z' });
});

test('alert reports usage when its title or message is empty without reaching the publisher', async t => {
  const { copyFile, writeFile, mkdir, mkdtemp, rm } = await import('node:fs/promises');
  const { spawnSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'dalan-alert-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'bin'));
  await mkdir(join(root, 'src'));
  const cli = join(root, 'bin/dot-alert.mjs');
  await copyFile(new URL('../bin/dot-alert.mjs', import.meta.url), cli);
  await writeFile(join(root, 'src/alerts.mjs'), 'export const publishAlert = () => { throw Error("unexpected publisher call"); };');
  for (const args of [['', 'synthetic message'], ['synthetic title', '']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: root, timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stderr.trim(), 'usage: dalan-alert TITLE MESSAGE');
    assert.equal(result.stdout, '');
  }
});
