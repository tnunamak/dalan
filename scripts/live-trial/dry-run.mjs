#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  CALLBACK,
  Vendor,
} from './fake-vendor.mjs';
import {
  REPO,
  bridgeSecret,
  freeLoopbackPort,
  mcpRpc,
  mcpTool,
  processCommand,
  processExists,
  readManifest,
  resourceUrlFromManifest,
} from './common.mjs';
import { persistenceProof } from './teardown.mjs';

const script = name => path.join(REPO, 'scripts/live-trial', `${name}.mjs`);
const childEnv = {
  HOME: os.homedir(),
  PATH: process.env.PATH ?? '',
  NODE_ENV: 'test',
  DOT_BRIDGE_LIVE_TRIAL_TESTING: '1',
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
};

function runScript(name, args, input = '') {
  return spawnSync(process.execPath, [script(name), ...args], {
    cwd: REPO,
    env: childEnv,
    input,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 128 * 1024,
  });
}

function pass(condition, label) {
  assert.ok(condition, label);
  console.log(`PASS ${label}`);
}

function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

function assertSecretAbsent(result, label, secret) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  pass(!output.includes(secret), `${label} stdout/stderr omit bridge secret`);
}

function ownerClient(manifest) {
  const cli = args => {
    const result = spawnSync(process.execPath, [path.join(REPO, 'bin/dalan.mjs'), ...args], {
      cwd: REPO,
      env: { HOME: manifest.home, PATH: process.env.PATH ?? '', NODE_ENV: 'test', DOT_BRIDGE_TEST_OAUTH: '1' },
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 128 * 1024,
    });
    return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', json() { return JSON.parse(this.stdout); } };
  };
  return {
    pub: manifest.public_url,
    resource: resourceUrlFromManifest(manifest),
    cli,
    start_window(worker) { return cli(['connect', 'start', '--worker', worker, '--json']); },
    approve(code, worker, replace = true) {
      return cli(['connect', 'approve', code, '--worker', worker, ...(replace ? ['--replace'] : []), '--json']);
    },
  };
}

function expectOk(result, label) {
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed (${result.error?.code ?? `exit ${result.status}`})`);
  }
}

function assertProcessInspectionFailsClosed() {
  const gone = processExists(42, () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  pass(!gone, 'ESRCH proves a manifest process is gone');

  let permissionDenied = false;
  try {
    processExists(42, () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
  } catch { permissionDenied = true; }
  pass(permissionDenied, 'process liveness inspection errors fail closed');

  let psInspectionFailed = false;
  try { processCommand(process.pid, { spawn: () => ({ status: 1, error: null }) }); }
  catch { psInspectionFailed = true; }
  pass(psInspectionFailed, 'ps inspection errors fail closed while the process is alive');
}

function assertHomeScopedOwnerCommands(setup, home) {
  const commands = (setup.stdout ?? '').split('\n').map(line => line.trim()).filter(line =>
    line.includes('node bin/dalan.mjs') || /node scripts\/live-trial\/(job|verify|teardown)\.mjs/.test(line));
  const prefix = `HOME=${shellQuote(home)} `;
  const trialSocket = path.join(home, '.local/share/dalan/admin.sock');
  const realSocket = path.join(os.homedir(), '.local/share/dot-bridge/admin.sock');
  pass(commands.length === 4 && commands.every(line => line.startsWith(prefix))
    && trialSocket !== realSocket && home !== os.homedir(),
  'setup owner commands target the trial socket, not the real owner socket');
}

function createFakeOperatorHome(manifest, home) {
  const launchAgents = path.join(home, 'Library/LaunchAgents');
  const systemdConfig = path.join(home, '.config/systemd/user');
  const systemdData = path.join(home, '.local/share/systemd/user');
  fs.mkdirSync(launchAgents, { recursive: true, mode: 0o700 });
  fs.mkdirSync(systemdConfig, { recursive: true, mode: 0o700 });
  fs.mkdirSync(systemdData, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(launchAgents, 'unrelated.plist'), `<string>${manifest.run_id}</string>\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(systemdConfig, 'unrelated.service'), `[Service]\nExecStart=/bin/true ${manifest.home}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(systemdData, 'unrelated.timer'), `[Unit]\nDescription=${manifest.home}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(home, '.live-trial-test-crontab'), `* * * * * /bin/true ${manifest.run_id}\n`, { mode: 0o600 });
}

async function main() {
  assertProcessInspectionFailsClosed();
  const readme = fs.readFileSync(path.join(REPO, 'scripts/live-trial/README.md'), 'utf8');
  const ownerDocCommands = readme.split('\n').map(line => line.trim()).filter(line =>
    /node bin\/dalan\.mjs connect /.test(line) || /node scripts\/live-trial\/(job|verify|teardown)\.mjs/.test(line));
  pass(ownerDocCommands.length === 7 && ownerDocCommands.every(line => line.startsWith("HOME='<home printed by setup>' ")),
    'README scopes every owner command to the trial HOME');
  pass(readme.includes('Compare the pairing code shown in fixture-a\'s browser')
    && readme.includes('as_registration_refused')
    && readme.includes('callback host belongs to the connector provider')
    && readme.includes('cannot prove which vendor account started the flow'),
  'README requires browser-code, refused-callback and trusted-host checks and states the residual limit');
  const trialStepOrder = ['Enable the trial forward', 'Verify from outside the tailnet', 'Pair fixture-a', 'Submit and verify one job', 'Disable and verify the forward', 'Teardown']
    .map(step => readme.indexOf(step));
  pass(trialStepOrder.every((position, index) => position >= 0 && (!index || position > trialStepOrder[index - 1])),
    'README follows the enable, outside-check, pair, job, disable, teardown order');

  const worker = 'fixture-a';
  const port = await freeLoopbackPort();
  const home = path.join(os.tmpdir(), `dry-${randomUUID().slice(0, 8)}`);
  const fakeOperatorHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pbfixture-a-fake-operator-home-'));
  let manifest = null;
  let accessToken = '';
  let pathSecret = '';
  let teardownDone = false;
  let phase = 'setup';

  try {
    const setupArgs = [
      '--worker', worker,
      '--public-url', `http://127.0.0.1:${port}`,
      '--port', String(port),
      '--home', home,
    ];
    const legacy = runScript('setup', [...setupArgs, '--reveal-resource-url']);
    // Preserve cleanup if a regression unexpectedly allowed setup to run.
    if (fs.existsSync(path.join(home, 'live-trial.json'))) {
      manifest = readManifest(home);
      pathSecret = bridgeSecret(home);
    }
    pass(!legacy.error && legacy.status !== 0
      && (legacy.stderr ?? '').includes('unknown option --reveal-resource-url'),
    'legacy reveal flag fails with the ordinary unknown-option error');
    pass(!fs.existsSync(home),
      'legacy reveal flag creates no trial HOME, unit or exposure artifacts');
    const setup = runScript('setup', setupArgs);
    if (setup.error || setup.status !== 0) {
      throw new Error('loopback setup failed');
    }
    manifest = readManifest(home);
    pathSecret = bridgeSecret(home);
    assertSecretAbsent(setup, 'setup', pathSecret);
    assertHomeScopedOwnerCommands(setup, home);
    const workersFile=path.join(home,'.config/dalan/workers.json'),workers=JSON.parse(fs.readFileSync(workersFile,'utf8'));
    pass((fs.statSync(workersFile).mode&0o777)===0o600&&Object.values(workers.workers).every(worker=>Array.isArray(worker.repos)&&worker.repos.length===0),
      'fresh live-trial profile denies repository access by default');
    const resourceUrl = resourceUrlFromManifest(manifest);
    assertSecretAbsent(setup, 'setup resource URL', resourceUrl);
    const resourceFile = path.join(home, manifest.resource_url_file);
    pass((fs.statSync(resourceFile).mode & 0o777) === 0o600
      && fs.readFileSync(resourceFile, 'utf8').trim() === resourceUrl,
    'resource URL is stored in a mode-0600 file');
    const manifestText = fs.readFileSync(path.join(home, 'live-trial.json'), 'utf8');
    pass(!manifestText.includes(pathSecret) && !Object.hasOwn(manifest, 'resource_url')
      && !Object.hasOwn(manifest, 'resource_path') && !Object.hasOwn(manifest, 'local_resource_url'),
    'manifest does not contain the bridge path secret or secret-bearing URL fields');
    pass(manifest.bind_host === '127.0.0.1' && manifest.port === port, 'setup starts a private bridge on loopback');

    phase = 'public exposure';
    const publicCheck = spawnSync(process.execPath, [script('check-public'), resourceUrl], {
      cwd: REPO,
      env: childEnv,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 32 * 1024,
    });
    assertSecretAbsent(publicCheck, 'check-public', pathSecret);
    expectOk(publicCheck, 'check-public against the loopback bridge');
    console.log(publicCheck.stdout.trim());
    pass(publicCheck.stdout.trim().split('\n').length === 4, 'check-public reports all four outside checks');
    const publicCheckFromFile = spawnSync(process.execPath, [script('check-public')], {
      cwd: REPO,
      env: childEnv,
      input: `${resourceUrl}\n`,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 32 * 1024,
    });
    assertSecretAbsent(publicCheckFromFile, 'check-public from private file', pathSecret);
    expectOk(publicCheckFromFile, 'check-public with the private file on stdin');
    pass(publicCheckFromFile.stdout.trim().split('\n').length === 4, 'check-public reads a private resource URL from stdin');

    createFakeOperatorHome(manifest, fakeOperatorHome);
    const plantedPersistence = persistenceProof(manifest, { operatorHome: fakeOperatorHome, testOnly: true });
    pass(plantedPersistence.operator.launchAgents === 'present', 'persistence scan finds a LaunchAgent by content in a fake operator home');
    pass(plantedPersistence.operator.systemdConfig === 'present' && plantedPersistence.operator.systemdData === 'present',
      'persistence scan finds systemd user units by content in a fake operator home');
    pass(plantedPersistence.operator.cron === 'present', 'persistence scan finds a crontab reference by content in a fake operator home');

    fs.rmSync(path.join(fakeOperatorHome, 'Library'), { recursive: true, force: true });
    fs.mkdirSync(path.join(fakeOperatorHome, 'Library'), { mode: 0o700 });
    fs.writeFileSync(path.join(fakeOperatorHome, 'Library/LaunchAgents'), 'not a directory', { mode: 0o600 });
    const unreadablePersistence = persistenceProof(manifest, { operatorHome: fakeOperatorHome, testOnly: true });
    pass(unreadablePersistence.operator.launchAgents === 'unreadable', 'unreadable persistence directories are not reported absent');
    fs.rmSync(fakeOperatorHome, { recursive: true, force: true });
    fs.mkdirSync(fakeOperatorHome, { mode: 0o700 });

    phase = 'callback visibility';
    const bridge = ownerClient(manifest);
    const window = bridge.start_window(worker);
    if (window.code !== 0) throw new Error('fake pairing window failed');
    pass(true, 'pairing window opens before vendor registration');

    const refusedVendor = new Vendor(bridge, 'https://fixture-a.example/oauth/callback');
    const refusedRegistration = await refusedVendor.register();
    pass(refusedRegistration.status === 400, 'unlisted vendor callback registration is refused');
    const requestLog = path.join(home, '.local/state/dalan/requests.jsonl');
    const logText = fs.readFileSync(requestLog, 'utf8');
    const refusalLine = logText.split('\n').findLast(line => line.includes('"kind":"as_registration_refused"'));
    const refusal = refusalLine ? JSON.parse(refusalLine) : null;
    pass(Boolean(refusal)
      && Object.keys(refusal).sort().join(',') === 'at,kind'
      && refusal.kind === 'as_registration_refused'
      && !/(?:client_secret|access_token|refresh_token)\s*[:=]/i.test(logText),
    'refused callback log omits redirect details and credentials');

    const allow = bridge.cli(['connect', 'allow-callback', refusedVendor.redirect, '--json']);
    if (allow.code !== 0) console.error(`allowlist_status=${allow.code} error=${allow.stderr.trim().slice(0, 300)}`);
    if (allow.code !== 0) throw new Error('fake callback allowlist failed');
    const registration = await refusedVendor.register();
    pass(registration.status === 201, 'callback is allowlisted and the vendor retry succeeds within the same pairing window');

    phase = 'DCR';
    const vendor = refusedVendor;

    phase = 'pairing and token';
    const connected = await vendor.connect(worker, { replace: false, windowOpen: true });
    accessToken = connected.access;
    pass(Boolean(accessToken) && connected.flow.pkce.challenge.length === 43, 'pairing approval and PKCE S256 token exchange succeed');

    const initialized = await mcpRpc(manifest, accessToken, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'portable-live-trial-fake', version: '1.0.0' },
    });
    pass(initialized.status === 200 && initialized.body?.result?.protocolVersion === '2025-11-25', 'MCP initialize succeeds');

    phase = 'jobs';
    const submitted = runScript('job', ['--home', home, '--submit-only']);
    assertSecretAbsent(submitted, 'job submit', pathSecret);
    expectOk(submitted, 'text-only job submit');
    manifest = readManifest(home);
    const jobs = JSON.parse(fs.readFileSync(path.join(home, manifest.jobs_file), 'utf8'));
    const listedTools = await mcpRpc(manifest, accessToken, 'tools/list');
    const names = listedTools.body?.result?.tools?.map(tool => tool.name) ?? [];
    pass(listedTools.status === 200 && names.length > 0, 'worker tools/list succeeds');
    pass(!names.some(name => /^t3_/.test(name)) && names.includes('notify_owner'), 'global T3-off catalog is process-wide and advertises notify_owner');
    const notifyDenied = await mcpTool(manifest, accessToken, 'notify_owner', { text: 'synthetic denied call' });
    pass(notifyDenied.isError && /worker_capability_denied/.test(notifyDenied.text), 'advertised notify_owner remains denied without the worker capability');

    const pending = await mcpTool(manifest, accessToken, 'list_pending');
    pass(!pending.isError && pending.value.assignments.some(item => item.request_id === jobs.worker_request_id), 'fixture-a sees its explicitly targeted job');
    pass(!pending.value.assignments.some(item => item.request_id === jobs.dot_request_id), 'fixture-a cannot see the worker control job');
    const claim = await mcpTool(manifest, accessToken, 'claim', {
      request_id: jobs.worker_request_id,
      claimant: worker,
    });
    pass(!claim.isError && Boolean(claim.value.claim_id), 'fixture-a claims its job');

    const finish = await mcpTool(manifest, accessToken, 'finish', {
      request_id: jobs.worker_request_id,
      claim_id: claim.value.claim_id,
      outcome: 'completed',
      summary: 'Completed the text-only bridge trial.',
      result: `Completed the text-only assignment. Nonce: ${jobs.nonce}`,
    });
    pass(!finish.isError, 'fixture-a finishes its job with the nonce');

    phase = 'wait';
    const waited = runScript('job', ['--home', home, '--wait-only', '--timeout', '20']);
    assertSecretAbsent(waited, 'job wait', pathSecret);
    expectOk(waited, 'wait for the finished job');
    pass(waited.stdout.includes('nonce_echoed=yes') && waited.stdout.includes('target=worker status=queued'), 'job verdict confirms nonce echo and untouched worker control');

    phase = 'verify';
    const verified = runScript('verify', ['--home', home, '--token-stdin'], accessToken);
    assertSecretAbsent(verified, 'verify', pathSecret);
    expectOk(verified, 'owner-side verification');
    console.log(verified.stdout.trim());

    phase = 'teardown';
    const bridgeLog = fs.readFileSync(manifest.log_file, 'utf8');
    pass(!bridgeLog.includes(pathSecret), 'bridge log omits the bridge path secret');
    const tornDown = runScript('teardown', [
      '--home', home,
      '--test-operator-home', fakeOperatorHome,
      '--token-stdin',
    ], accessToken);
    assertSecretAbsent(tornDown, 'teardown', pathSecret);
    expectOk(tornDown, 'teardown');
    teardownDone = true;
    console.log(tornDown.stdout.trim());
    pass(!fs.existsSync(home), 'throwaway home is gone');
    console.log('dry-run: all checks passed');
  } catch (error) {
    const safeMessage = String(error.message ?? error)
      .replaceAll(pathSecret, pathSecret ? '[redacted]' : '')
      .replaceAll(accessToken, accessToken ? '[redacted]' : '');
    console.error(`FAIL dry-run phase=${phase}: ${safeMessage}`);
    process.exitCode = 1;
  } finally {
    if (!teardownDone && manifest) {
      fs.rmSync(fakeOperatorHome, { recursive: true, force: true });
      fs.mkdirSync(fakeOperatorHome, { mode: 0o700 });
      const cleanup = runScript('teardown', [
        '--home', home,
        '--test-operator-home', fakeOperatorHome,
        ...(accessToken ? ['--token-stdin'] : []),
      ], accessToken);
      if (pathSecret) assertSecretAbsent(cleanup, 'cleanup teardown', pathSecret);
      if (cleanup.status === 0) console.log('cleanup_after_failure: trial home removed');
      else console.error('cleanup_after_failure: teardown did not complete');
    }
    fs.rmSync(fakeOperatorHome, { recursive: true, force: true });
  }
}

main().catch(() => {
  console.error('FAIL dry-run phase=orchestration');
  process.exitCode = 1;
});
