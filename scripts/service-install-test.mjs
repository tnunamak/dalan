import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultPath } from '../src/paths.mjs';
import { installService } from '../src/service.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(os.homedir(), '.tmp/one-bridge-1111');
fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
const root = fs.mkdtempSync(path.join(scratch, 'service-install-'));
const userHome = path.join(root, 'user');
fs.mkdirSync(userHome, { mode: 0o700 });
const xdg = path.join(userHome, '.config');
const env = { ...process.env, HOME: userHome, XDG_CONFIG_HOME: xdg };
const calls = [];
const route = { origin: 'https://bridge.example.test', target: '192.0.2.10:8789', verification: { status: 'verified', method: 'challenge' } };
const spawn = (command, args) => {
  calls.push([command, ...args]);
  return command === 'gozar'
    ? { status: 0, stdout: JSON.stringify({ schemaVersion: 1, route }), stderr: '' }
    : { status: 0, stdout: '', stderr: '' };
};

try {
  const home = path.join(root, 'bridge');
  const result = await installService({ home, origin: 'https://bridge.example.test', port: 8787,
    target: '192.0.2.10:8789', workers: ['dot', 'muse', 'duet-default', 'duet-dondo'], gozarBin: 'gozar' }, {
    env, platform: 'linux', node: '/usr/bin/node', repo: '/opt/dalan', proxy: '/usr/lib/systemd/systemd-socket-proxyd',
    spawn, waitForSocket: async () => true,
  });
  assert.equal(result.started, true);
  assert.equal(result.route.verification.status, 'verified');
  assert.deepEqual(result.workers, ['dot', 'muse', 'duet-default', 'duet-dondo']);
  assert.equal(fs.statSync(path.join(home, 'resource-url')).mode & 0o777, 0o600);
  const resourceUrl = fs.readFileSync(path.join(home, 'resource-url'), 'utf8').trim();
  assert.match(resourceUrl, /^https:\/\/bridge\.example\.test\/[a-f0-9]{64}\/mcp$/);
  const config = defaultPath(home, '.config/dot-bridge');
  assert.equal(JSON.parse(fs.readFileSync(path.join(config, 'workers.json'))).workers['duet-dondo'].repos.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(config, 'as.json'))).public_url, 'https://bridge.example.test');
  const unitDir = path.join(xdg, 'systemd/user');
  const serviceUnit = fs.readFileSync(path.join(unitDir, result.unit), 'utf8');
  assert.match(serviceUnit, /Environment=DALAN_BIND_HOST=127\.0\.0\.1/);
  assert.match(serviceUnit, /Environment=DALAN_AUTH_MODE=builtin/);
  assert.match(serviceUnit, /Environment=DALAN_GOZAR_SERVICE=1/);
  assert.match(serviceUnit, /Environment=DALAN_CATALOG_PROFILE=stable/);
  const callsBeforeGozar = calls.findIndex(call => call[0] === 'gozar');
  assert(callsBeforeGozar > 0, 'Gozar route is registered after systemd starts the service');
  assert(calls.some(call => call.join(' ').includes('enable --now') && call.join(' ').includes('target.socket')));
  assert.deepEqual(calls[callsBeforeGozar].slice(0, 6), ['gozar', 'service', 'add', '--origin', 'https://bridge.example.test', '--target']);
  assert(calls[callsBeforeGozar].includes('192.0.2.10:8789'));
  assert.equal(calls[callsBeforeGozar].at(-1), '--json');

  const migratedHome = path.join(root, 'migrated');
  const migratedConfig = defaultPath(migratedHome, '.config/dot-bridge');
  fs.mkdirSync(migratedConfig, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(migratedConfig, 'workers.json'), JSON.stringify({ default_execution: 'none', workers: { dot: { repos: ['example/repo'] } } }) + '\n', { mode: 0o600 });
  let dryCalls = 0;
  const dry = await installService({ home: migratedHome, origin: 'https://bridge.example.test', port: 8790,
    target: '127.0.0.1:8790', workers: [], writeUnitsOnly: true }, {
    env, platform: 'linux', node: '/usr/bin/node', repo: '/opt/dalan', proxy: null,
    spawn: () => { dryCalls++; throw new Error('write-units-only must not call systemctl or Gozar'); },
  });
  assert.equal(dry.started, false);
  assert.equal(dryCalls, 0);
  assert.equal(fs.existsSync(path.join(migratedConfig, 'as.json')), false, 'write-units-only does not initialize OAuth files');
  assert.equal(fs.readFileSync(path.join(migratedConfig, 'workers.json'), 'utf8').includes('example/repo'), true, 'migration profile is preserved');

  const cliHome = path.join(root, 'cli-home');
  const cli = spawnSync(process.execPath, [path.join(repo, 'bin/dalan.mjs'), 'service', 'install', '--home', cliHome,
    '--public-url', 'https://cli.example.test', '--port', '8798', '--target', '127.0.0.1:8798',
    '--worker=dot', '--worker', 'muse', '--write-units-only', '--json'], { env, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const cliResult = JSON.parse(cli.stdout);
  assert.equal(cliResult.started, false);
  assert.deepEqual(cliResult.units, [cliResult.unit]);
  assert.equal(fs.existsSync(path.join(cliHome, '.config/dalan/workers.json')), false, 'write-units-only does not create worker or auth state');

  const missingLan = spawnSync(process.execPath, [path.join(repo, 'bin/dalan.mjs'), 'service', 'install', '--home', path.join(root, 'bad-lan'), '--public-url', 'https://cli.example.test', '--port', '8798', '--target', '192.0.2.10:8799', '--worker', 'dot', '--write-units-only'], { env, encoding: 'utf8' });
  assert.notEqual(missingLan.status, 0);
  assert.match(missingLan.stderr, /requires --lan-port/);

  const oldHome = path.join(root, 'existing-bridge-data');
  fs.mkdirSync(path.join(oldHome, '.local/share/dalan'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(oldHome, '.local/share/dalan/bridge.db'), 'existing data');
  const oldProfile = path.join(defaultPath(oldHome, '.config/dot-bridge'), 'workers.json');
  fs.mkdirSync(path.dirname(oldProfile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(oldProfile, JSON.stringify({ workers: { dot: { repos: [] } } }) + '\n', { mode: 0o600 });
  await assert.rejects(installService({ home: oldHome, origin: 'https://old.example.test', port: 8799,
    target: '127.0.0.1:8799', workers: [] }, { env, platform: 'linux' }), /already contains bridge data/);
  assert.equal(fs.existsSync(path.join(path.dirname(oldProfile), 'as.json')), false, 'a populated existing bridge home is refused before auth writes');

  const existingWorkerHome = path.join(root, 'existing-worker-profile');
  const existingWorkerConfig = defaultPath(existingWorkerHome, '.config/dot-bridge');
  fs.mkdirSync(existingWorkerConfig, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(existingWorkerConfig, 'workers.json'), JSON.stringify({ workers: { dot: { connections: [{ issuer: 'https://issuer.example', subject: 'dot' }] } } }) + '\n', { mode: 0o600 });
  await assert.rejects(installService({ home: existingWorkerHome, origin: 'https://bridge.example.test', port: 8792,
    target: '127.0.0.1:8792', workers: [] }, { env, platform: 'linux', spawn, waitForSocket: async () => true }), /not a built-in OAuth worker profile/);
  await assert.rejects(installService({ home: migratedHome, origin: 'https://bridge.example.test', port: 8793,
    target: '127.0.0.1:8793', workers: ['other'] }, { env, platform: 'linux' }), /already exists; omit --worker/);

  const symlinkHome = path.join(root, 'symlink-home');
  fs.symlinkSync(migratedHome, symlinkHome);
  await assert.rejects(installService({ home: symlinkHome, origin: 'https://bridge.example.test', port: 8794,
    target: '127.0.0.1:8794', workers: ['dot'] }, { env, platform: 'linux' }), /symlink/);

  const noReadyHome = path.join(root, 'not-ready');
  await assert.rejects(installService({ home: noReadyHome, origin: 'https://not-ready.example.test', port: 8795,
    target: '127.0.0.1:8795', workers: ['dot'] }, {
    env, platform: 'linux', node: '/usr/bin/node', repo: '/opt/dalan', spawn, waitForSocket: async () => false,
  }), /did not start on its admin socket/);

  const retryHome = path.join(root, 'retry-route');
  let firstGozarCall = true;
  const retryInstall = workers => installService({ home: retryHome, origin: 'https://retry.example.test', port: 8791,
    target: '127.0.0.1:8791', workers, gozarBin: 'gozar' }, {
    env, platform: 'linux', node: '/usr/bin/node', repo: '/opt/dalan', spawn: (command, args) => command === 'gozar'
      ? { status: 0, stdout: JSON.stringify({ schemaVersion: 1, route: { ...route, origin: 'https://retry.example.test', target: '127.0.0.1:8791', verification: { status: firstGozarCall ? 'failed' : 'verified' } } }), stderr: '' }
      : { status: 0, stdout: '', stderr: '' }, waitForSocket: async () => true,
  });
  await assert.rejects(retryInstall(['dot']), /did not verify the service route/);
  firstGozarCall = false;
  const retried = await retryInstall([]);
  assert.equal(retried.route.verification.status, 'verified', 'an exact own-install receipt permits a safe retry');
  await assert.rejects(installService({ home: retryHome, origin: 'https://changed.example.test', port: 8791,
    target: '127.0.0.1:8791', workers: [] }, { env, platform: 'linux' }), /belongs to a different service configuration/);

  for (const field of ['origin', 'target']) {
    const mismatchHome = path.join(root, `mismatch-${field}`);
    await assert.rejects(installService({ home: mismatchHome, origin: route.origin, port: 8796,
      target: route.target, workers: ['dot'], gozarBin: 'gozar' }, {
      env, platform: 'linux', node: '/usr/bin/node', repo: '/opt/dalan', proxy: '/usr/lib/systemd/systemd-socket-proxyd',
      spawn: command => command === 'gozar'
        ? { status: 0, stdout: JSON.stringify({ schemaVersion: 1, route: { ...route, [field]: field === 'origin' ? 'https://wrong.example.test' : '192.0.2.11:8789' } }) }
        : { status: 0, stdout: '' }, waitForSocket: async () => true,
    }), /does not match/);
  }

  const gozarFailureHome = path.join(root, 'gozar-failure');
  await assert.rejects(installService({ home: gozarFailureHome, origin: 'https://gozar-failure.example.test', port: 8796,
    target: '127.0.0.1:8796', workers: ['dot'], gozarBin: 'gozar' }, {
    env, platform: 'linux', node: '/usr/bin/node', repo: '/opt/dalan', spawn: (command, args) => command === 'gozar'
      ? { status: 1, stdout: '', stderr: 'route verification failed' }
      : { status: 0, stdout: '', stderr: '' }, waitForSocket: async () => true,
  }), /gozar service add .*failed/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('service installer: PASS');
