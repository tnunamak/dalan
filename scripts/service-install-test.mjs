import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultPath } from '../src/paths.mjs';
import { installService } from '../src/service.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = process.env.DOT_BRIDGE_SERVICE_INSTALL_TMP ?? path.join(os.homedir(), '.tmp');
fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
const root = fs.mkdtempSync(path.join(scratch, 'dalan-service-install-'));
const userHome = path.join(root, 'user');
fs.mkdirSync(userHome, { mode: 0o700 });
const xdg = path.join(userHome, '.config');
const env = { ...process.env, HOME: userHome, XDG_CONFIG_HOME: xdg };
const calls = [];
const route = { origin: 'https://bridge.example.test', target: '192.0.2.10:8787', verification: { status: 'verified', method: 'challenge' } };
const spawn = (command, args) => {
  calls.push([command, ...args]);
  return command === 'gozar'
    ? { status: 0, stdout: JSON.stringify({ schemaVersion: 1, route }), stderr: '' }
    : { status: 0, stdout: '', stderr: '' };
};
const privateState = home => {
  const paths = [
    '.config/dot-bridge/workers.json', '.config/dot-bridge/service-install.json',
    '.config/dot-bridge/as.json', '.config/dot-bridge/as-jwks.json',
    '.config/dot-bridge/as-cookie-keys.json', '.config/dot-bridge/env', 'resource-url',
  ];
  return Object.fromEntries(paths.map(relative => {
    const file = path.join(home, relative);
    if (!fs.existsSync(file)) return [relative, null];
    const stat = fs.lstatSync(file);
    return [relative, { mode: stat.mode & 0o777, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }];
  }));
};

try {
  const home = path.join(root, 'bridge');
  const result = await installService({ home, origin: 'https://bridge.example.test', port: 8787,
    target: '192.0.2.10:8787', lanPort: 8787, workers: ['dot', 'muse', 'duet-default', 'duet-dondo'], gozarBin: 'gozar' }, {
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
  assert(calls[callsBeforeGozar].includes('192.0.2.10:8787'));
  assert.equal(calls[callsBeforeGozar].at(-1), '--json');

  const installState = privateState(home);
  const exactRetry = await installService({ home, origin: 'https://bridge.example.test', port: 8787,
    target: '192.0.2.10:8787', lanPort: 8787, workers: ['dot', 'muse', 'duet-default', 'duet-dondo'], gozarBin: 'gozar' }, {
    env, platform: 'linux', node: '/usr/bin/node', repo: '/opt/dalan', proxy: '/usr/lib/systemd/systemd-socket-proxyd',
    spawn, waitForSocket: async () => true,
  });
  assert.equal(exactRetry.started, true);
  assert.deepEqual(privateState(home), installState, 'an exact --worker retry must preserve keys, policy, grants and receipt');

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
    '--worker=alpha', '--worker', 'beta', '--write-units-only', '--json'], { env, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const cliResult = JSON.parse(cli.stdout);
  assert.equal(cliResult.started, false);
  assert.deepEqual(cliResult.units, [cliResult.unit]);
  assert.equal(fs.existsSync(path.join(cliHome, '.config/dalan/workers.json')), false, 'write-units-only does not create worker or auth state');

  const missingLan = spawnSync(process.execPath, [path.join(repo, 'bin/dalan.mjs'), 'service', 'install', '--home', path.join(root, 'bad-lan'), '--public-url', 'https://cli.example.test', '--port', '8798', '--target', '192.0.2.10:8799', '--worker', 'dot', '--write-units-only'], { env, encoding: 'utf8' });
  assert.notEqual(missingLan.status, 0);
  assert.match(missingLan.stderr, /requires --lan-port/);


  const samePortHome = path.join(root, 'same-port-cli');
  const samePortCli = spawnSync(process.execPath, [path.join(repo, 'bin/dalan.mjs'), 'service', 'install',
    '--home', samePortHome, '--public-url', 'https://cli.example.test', '--port', '8798',
    '--target', '127.0.0.2:8798', '--lan-port', '8798', '--worker', 'dot', '--write-units-only', '--json'], { env, encoding: 'utf8' });
  assert.equal(samePortCli.status, 0, samePortCli.stderr);
  const samePortResult = JSON.parse(samePortCli.stdout);
  assert.equal(samePortResult.units.length, 3);
  assert.match(fs.readFileSync(path.join(unitDir, samePortResult.unit.replace('.service', '-target.socket')), 'utf8'), /ListenStream=127\.0\.0\.2:8798/);

  const beforeRejectedUnits = fs.readdirSync(unitDir).sort();
  for (const [label, target, lanPort, verifyCmd, error] of [
    ['translation', '192.0.2.10:8799', 8799, undefined, /translated target ports/],
    ['empty-command', '192.0.2.10:8799', 8799, '   ', /nonempty/],
    ['wildcard', '0.0.0.0:8798', 8798, undefined, /wildcard/],
    ['missing-lan', '192.0.2.10:8798', undefined, undefined, /requires --lan-port/],
    ['mismatched-lan', '192.0.2.10:8798', 8797, undefined, /requires --lan-port/],
  ]) {
    const rejectedHome = path.join(root, label);
    const beforeCalls = calls.length;
    await assert.rejects(installService({ home: rejectedHome, origin: route.origin, port: 8798,
      target, lanPort, verifyCmd, workers: ['dot'] }, { env, platform: 'linux', spawn }), error);
    assert.equal(fs.existsSync(rejectedHome), false);
    assert.equal(calls.length, beforeCalls, 'invalid topology must not call systemctl or Gozar');
    const args = [path.join(repo, 'bin/dalan.mjs'), 'service', 'install', '--home', rejectedHome,
      '--public-url', route.origin, '--port', '8798', '--target', target, '--worker', 'dot', '--write-units-only'];
    if (lanPort !== undefined) args.push('--lan-port', String(lanPort));
    if (verifyCmd !== undefined) args.push('--verify-cmd', verifyCmd);
    const rejected = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, error);
    assert.equal(fs.existsSync(rejectedHome), false);
    assert.deepEqual(fs.readdirSync(unitDir).sort(), beforeRejectedUnits, 'invalid topology must not write units');
  }

  const verifyCmd = 'trusted-check --origin "https://bridge.example.test"';
  const translatedCalls = [];
  const translated = await installService({ home: path.join(root, 'translated'), origin: route.origin, port: 8798,
    target: '192.0.2.10:8799', lanPort: 8799, verifyCmd, workers: ['dot'], gozarBin: 'gozar' }, {
    env, platform: 'linux', node: '/usr/bin/node', repo: '/opt/dalan', proxy: '/usr/lib/systemd/systemd-socket-proxyd',
    spawn: (command, args) => {
      translatedCalls.push([command, ...args]);
      return { status: 0, stdout: command === 'gozar' ? JSON.stringify({ schemaVersion: 1,
        route: { ...route, target: '192.0.2.10:8799', verification: { status: 'verified', method: 'host-command' } } }) : '', stderr: '' };
    }, waitForSocket: async () => true,
  });
  assert.equal(translated.started, true);
  const translatedGozar = translatedCalls.find(call => call[0] === 'gozar');
  assert.deepEqual(translatedGozar.slice(-3), ['--verify-cmd', verifyCmd, '--json']);

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
  const failedRouteState = privateState(retryHome);
  firstGozarCall = false;
  const retried = await retryInstall(['dot']);
  assert.equal(retried.route.verification.status, 'verified', 'an exact own-install receipt permits a safe retry');
  assert.deepEqual(privateState(retryHome), failedRouteState, 'route retry must preserve keys, policy, grants and receipt');
  await assert.rejects(installService({ home: retryHome, origin: 'https://changed.example.test', port: 8791,
    target: '127.0.0.1:8791', workers: ['dot'] }, { env, platform: 'linux' }), /belongs to a different service configuration/);

  for (const field of ['origin', 'target']) {
    const mismatchHome = path.join(root, `mismatch-${field}`);
    await assert.rejects(installService({ home: mismatchHome, origin: route.origin, port: 8787,
      target: route.target, lanPort: 8787, workers: ['dot'], gozarBin: 'gozar' }, {
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
