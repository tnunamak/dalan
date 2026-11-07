#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  dotJson,
  isLoopbackPortClosed,
  mcpRpc,
  parseArgs,
  processCommand,
  readJobs,
  readManifest,
  readStdin,
  runDot,
  waitForManifestProcesses,
} from './common.mjs';
import {
  cancelExposureCutoff,
  disableAndVerifyFunnel,
  validateExposure,
} from './exposure.mjs';

const args = parseArgs(process.argv.slice(2), {
  values: ['--home', '--test-operator-home'],
  flags: ['--token-stdin', '--check-tailscale'],
});

function fail(message) { throw new Error(message); }

function scanDirectoryForReferences(directory, references, visited = new Set()) {
  let realDirectory;
  try { realDirectory = fs.realpathSync(directory); }
  catch (error) { return error.code === 'ENOENT' ? 'absent' : 'unreadable'; }
  if (visited.has(realDirectory)) return 'absent';
  visited.add(realDirectory);

  let entries;
  try { entries = fs.readdirSync(realDirectory, { withFileTypes: true }); }
  catch (error) { return error.code === 'ENOENT' ? 'absent' : 'unreadable'; }

  let unreadable = false;
  for (const entry of entries) {
    const entryPath = path.join(realDirectory, entry.name);
    let stat;
    try { stat = fs.statSync(entryPath); }
    catch (error) {
      if (error.code !== 'ENOENT') unreadable = true;
      continue;
    }

    if (stat.isDirectory()) {
      const nested = scanDirectoryForReferences(entryPath, references, visited);
      if (nested === 'present') return 'present';
      if (nested === 'unreadable') unreadable = true;
      continue;
    }
    if (!stat.isFile()) continue;

    let contents;
    try { contents = fs.readFileSync(entryPath, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') unreadable = true;
      continue;
    }
    if (references.some(reference => contents.includes(reference))) return 'present';
  }
  return unreadable ? 'unreadable' : 'absent';
}

function scanCrontab(operatorHome, references, testOnly, spawn = spawnSync) {
  let contents;
  if (testOnly) {
    try { contents = fs.readFileSync(path.join(operatorHome, '.live-trial-test-crontab'), 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return 'absent';
      return 'unreadable';
    }
  } else {
    const result = spawn('crontab', ['-l'], { encoding: 'utf8', timeout: 2_000, maxBuffer: 64 * 1024 });
    if (result.error) return 'unreadable';
    if (result.status === 0) contents = result.stdout ?? '';
    else {
      const diagnostic = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      if (result.status === 1 && /no crontab for\s+/i.test(diagnostic)) return 'absent';
      return 'unreadable';
    }
  }
  return references.some(reference => contents.includes(reference)) ? 'present' : 'absent';
}

function assertTestOperatorHome(operatorHome) {
  let realOperatorHome;
  let realTestHome;
  try {
    realOperatorHome = fs.realpathSync(os.userInfo().homedir);
    realTestHome = fs.realpathSync(operatorHome);
  } catch { fail('test operator home must exist and be readable'); }
  if (realTestHome === realOperatorHome) fail('test operator home must not be the real user home');
}

export function persistenceProof(manifest, { operatorHome = os.userInfo().homedir, testOnly = false, spawn = spawnSync } = {}) {
  if (testOnly) assertTestOperatorHome(operatorHome);
  const references = [manifest.run_id, manifest.home].filter(value => typeof value === 'string' && value);
  const scanHome = home => ({
    launchAgents: scanDirectoryForReferences(path.join(home, 'Library/LaunchAgents'), references),
    systemdConfig: scanDirectoryForReferences(path.join(home, '.config/systemd/user'), references),
    systemdData: scanDirectoryForReferences(path.join(home, '.local/share/systemd/user'), references),
  });

  return {
    trial: scanHome(manifest.home),
    operator: {
      ...scanHome(operatorHome),
      cron: scanCrontab(operatorHome, references, testOnly, spawn),
    },
  };
}

function persistenceIsClear(proof) {
  return [...Object.values(proof.trial), ...Object.values(proof.operator)].every(status => status === 'absent');
}

function tailscaleStatus(check, exposure) {
  if (!check) return null;
  const status = command => {
    const socket = exposure?.mode === 'linux-second-node' ? ['--socket', exposure.tailscale_socket] : [];
    const result = spawnSync('tailscale', [...socket, ...command], { encoding: 'utf8', timeout: 5_000, maxBuffer: 32 * 1024 });
    if (result.error) return `${command.join(' ')}: unavailable`;
    const output = (result.stdout || result.stderr || '').trim();
    return `${command.join(' ')}: ${result.status === 0 ? output || 'ok' : `exit ${result.status}`}`;
  };
  return [status(['serve', 'status']), status(['funnel', 'status'])];
}

async function stopBridge(manifest) {
  for (const pid of manifest.pids) {
    if (!processCommand(pid)?.includes(manifest.process_title)) continue;
    try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  if (await waitForManifestProcesses(manifest, 8_000)) return true;

  for (const pid of manifest.pids) {
    if (!processCommand(pid)?.includes(manifest.process_title)) continue;
    try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  return await waitForManifestProcesses(manifest, 2_000);
}

function formatProof(proof) {
  const format = value => `launchAgents:${value.launchAgents} systemd_config:${value.systemdConfig} systemd_data:${value.systemdData}`;
  return {
    trial: format(proof.trial),
    operator: `${format(proof.operator)} cron:${proof.operator.cron}`,
  };
}

function disableRecordedExposure(manifest) {
  if (!manifest.exposure) {
    let publicUrl;
    try { publicUrl = new URL(manifest.public_url); }
    catch { fail('trial public URL is invalid; bridge and home retained'); }
    if (publicUrl.protocol === 'https:') {
      fail(`trial manifest has no exposure record for its HTTPS URL; bridge and home retained at ${manifest.home}. On the node that owns the rule, use its Tailscale CLI (add --socket <second-node-socket> for a separate node) to run: tailscale funnel --bg --https=443 http://127.0.0.1:${manifest.port} off; then run tailscale funnel status --json with the same socket, confirm no AllowFunnel Proxy targets port ${manifest.port}, and rerun teardown.`);
    }
    return null;
  }

  let exposure;
  try { exposure = validateExposure(manifest.exposure, manifest.port); }
  catch (error) {
    const port = Number.isInteger(manifest.port) ? manifest.port : '<recorded-local-port>';
    const recorded = manifest.exposure ?? {};
    const socket = recorded.mode === 'linux-second-node'
      && typeof recorded.tailscale_socket === 'string'
      && path.isAbsolute(recorded.tailscale_socket)
      ? ` --socket '${recorded.tailscale_socket.replaceAll("'", "'\\''")}'`
      : ' [--socket <second-node-socket>]';
    fail(`trial exposure metadata cannot identify a safe Funnel rule (${error.message}); bridge and home retained at ${manifest.home}. Inspect the manifest and owning node/socket, then run: tailscale${socket} funnel --bg --https=443 http://127.0.0.1:${port} off; inspect tailscale${socket} funnel status --json, confirm no AllowFunnel Proxy targets port ${port}, and rerun teardown.`);
  }
  disableAndVerifyFunnel(exposure, manifest.home);
  return exposure;
}

async function main() {
  if (args._.length || !args['--home']) {
    fail('usage: teardown.mjs --home DIR [--token-stdin] [--check-tailscale] [--test-operator-home DIR (test only)]');
  }
  const testOperatorHome = args['--test-operator-home'];
  if (testOperatorHome && process.env.DOT_BRIDGE_LIVE_TRIAL_TESTING !== '1') {
    fail('--test-operator-home is available only in the live-trial test harness');
  }
  const home = path.resolve(args['--home']);
  const manifest = readManifest(home);
  const exposure = disableRecordedExposure(manifest);
  if (exposure) {
    console.log(`exposure_forward=disabled public_port=${exposure.public_port} local_port=${exposure.local_port}`);
    let cutoffStopped = false;
    try { cutoffStopped = await cancelExposureCutoff(manifest); }
    catch (error) {
      fail(`Funnel is verified off, but its cutoff process could not be cancelled (${error.message}); bridge and home retained at ${home}. Inspect ${exposure.cutoff.log_file}, stop only PID ${exposure.cutoff.pid} if it still runs, then rerun teardown.`);
    }
    if (!cutoffStopped) {
      fail(`Funnel is verified off, but its cutoff process is still running; bridge and home retained at ${home}. Stop only PID ${exposure.cutoff.pid}, then rerun teardown.`);
    }
    console.log('exposure_cutoff=cancelled-or-already-finished');
  } else {
    console.log('exposure_forward=not-recorded');
  }
  const operatorHome = testOperatorHome ? path.resolve(testOperatorHome) : os.userInfo().homedir;
  const token = args['--token-stdin'] ? await readStdin() : '';
  if (token && !/^[A-Za-z0-9_-]{20,128}$/.test(token)) fail('stdin did not contain one opaque access token');
  const failures = [];
  let revoked = 'already inactive';
  let pairingWindow = 'not checked';
  let jobsSettled = 'not present';

  if (!await isLoopbackPortClosed(manifest.port)) {
    try {
      dotJson(home, ['connect', 'stop', '--json']);
      const pending = dotJson(home, ['connect', 'pending', '--json']);
      if (pending.window) failures.push('pairing window remains open');
      else pairingWindow = 'closed';
    } catch { failures.push('could not close or inspect the pairing window'); }

    if (manifest.jobs_file) {
      try {
        const jobs = readJobs(manifest);
        for (const requestId of [jobs.worker_request_id, jobs.dot_request_id]) {
          const current = dotJson(home, ['cancel-if-queued', requestId]);
          if (current.status === 'claimed') dotJson(home, ['cancel', requestId, '--reason', 'live trial teardown']);
          const after = dotJson(home, ['get', requestId, '--json']);
          if (!['finished', 'cancelled'].includes(after.status)) throw new Error('trial job is still active');
        }
        jobsSettled = 'yes';
      } catch { failures.push('could not settle all trial jobs'); }
    }

    try {
      const connections = dotJson(home, ['connect', 'list', '--json']).connections;
      if (connections.some(item => item.worker === manifest.worker && item.revoked_at === null)) {
        const result = runDot(home, ['connect', 'revoke', manifest.worker, '--json']);
        if (result.error || result.status !== 0) failures.push('connection revoke failed');
        else revoked = 'revoked';
      }
    } catch { failures.push('could not inspect or revoke the connection'); }
  } else {
    revoked = 'bridge was already stopped; private auth state will be deleted';
    pairingWindow = 'bridge was already stopped';
    jobsSettled = 'bridge was already stopped';
  }

  if (token && revoked === 'revoked') {
    try {
      const response = await mcpRpc(manifest, token, 'tools/list');
      if (response.status !== 401) failures.push(`revoked access returned HTTP ${response.status}, expected 401`);
      else console.log('revoked_access=401 (the built-in AS rejects revoked opaque tokens with 401)');
    } catch { failures.push('revoked access probe failed'); }
  }

  let processStopped = false;
  try { processStopped = await stopBridge(manifest); }
  catch { failures.push('failed to inspect or stop the manifest process'); }
  if (!processStopped) failures.push('a manifest process remains or its liveness could not be verified');

  // Only ECONNREFUSED proves that no loopback listener owns this port.
  let portClosed = false;
  for (let attempt = 0; attempt < 10 && !(portClosed = await isLoopbackPortClosed(manifest.port)); attempt++) await new Promise(resolve => setTimeout(resolve, 300));
  if (!portClosed) {
    const holder = spawnSync('lsof', ['-nP', `-iTCP:${manifest.port}`, '-sTCP:LISTEN', '-Fpc'], { encoding: 'utf8', timeout: 2_000, maxBuffer: 8_192 });
    if (holder.error || holder.status !== 0) failures.push('loopback port is still listening; lsof inspection was unreadable');
    else failures.push(`loopback port is still listening (holder: ${(holder.stdout ?? '').trim().replace(/\n/g, ' ') || 'unknown'})`);
  }

  const persistence = persistenceProof(manifest, { operatorHome, testOnly: Boolean(testOperatorHome) });
  const persistenceOutput = formatProof(persistence);
  if (!persistenceIsClear(persistence)) failures.push('persistence proof found a reference or unreadable location');

  const canRemoveHome = processStopped && portClosed && persistenceIsClear(persistence);
  if (canRemoveHome) fs.rmSync(home, { recursive: true, force: true });
  const homeGone = canRemoveHome && !fs.existsSync(home);
  if (!homeGone) failures.push('trial home retained because teardown absence proofs did not pass');
  const tailscaleAfter = tailscaleStatus(args['--check-tailscale'], exposure);

  console.log(`connection=${revoked}`);
  console.log(`pairing_window=${pairingWindow}`);
  console.log(`trial_jobs=${jobsSettled}`);
  console.log(`manifest_process=${processStopped ? 'absent' : 'present-or-uninspectable'}`);
  console.log(`loopback_port=${manifest.port} ${portClosed ? 'closed' : 'listening-or-uninspectable'}`);
  console.log(`persistence_trial=${persistenceOutput.trial}`);
  console.log(`persistence_operator=${persistenceOutput.operator}`);
  console.log(`trial_home=${homeGone ? 'absent' : 'present'}`);
  if (tailscaleAfter) {
    console.log('tailscale_after:');
    for (const line of tailscaleAfter) console.log(`  ${line}`);
  }
  if (failures.length) fail(failures.join('; '));
  console.log('teardown: all absence proofs passed');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => {
    console.error(`teardown failed: ${error.message}`);
    process.exitCode = 1;
  });
}
