// `--remove --purge-home` deletes a bridge home. It must not do that under a service that still uses the home:
// a unit or launch agent (of any name) that names the home, or a process that holds the bridge database open.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bridgeDatabaseHolders, run } from './worker-bridge-setup.mjs';

function fixture(platform) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'purge-guard-')));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'plutil'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // Stand-ins for the service managers: they succeed and do nothing.
  for (const tool of ['systemctl', 'launchctl']) fs.writeFileSync(path.join(bin, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: root, XDG_CONFIG_HOME: path.join(root, '.config'), DALAN_SETUP_LOCK_DIR: path.join(root, 'locks'), DALAN_PURGE_WAIT_MS: '300' };
  const out = [];
  const seams = { platform, env, log: line => out.push(line) };
  const home = path.join(root, 'h');
  run(['--worker', 'fern', '--public-url', 'https://fern.example.test', '--port', '18801', '--home', home, '--write-units-only'], seams);
  // --write-units-only writes the units only; make the home look like one that `init` made.
  fs.mkdirSync(path.join(home, '.config/dot-bridge'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/dot-bridge/workers.json'), JSON.stringify({ workers: { fern: {} } }));
  const dir = platform === 'linux' ? path.join(root, '.config/systemd/user') : path.join(root, 'Library/LaunchAgents');
  const unit = path.join(dir, platform === 'linux' ? 'dot-bridge-fern.service' : 'org.dalan.dot-bridge-fern.plist');
  return { root, home, dir, unit, seams, out };
}

for (const platform of ['linux', 'darwin']) test(`${platform}: purge refuses while another unit names the home, and keeps everything`, () => {
  const f = fixture(platform);
  try {
    // A service of an older release: a unit name that this release does not generate.
    const other = path.join(f.dir, platform === 'linux' ? 'bridge-older-name.service' : 'com.example.older-bridge.plist');
    fs.writeFileSync(other, platform === 'linux' ? `[Service]\nEnvironment=HOME=${f.home}\n` : `<dict><key>HOME</key><string>${f.home}</string></dict>\n`);
    assert.throws(() => run(['--remove', '--worker', 'fern', '--home', f.home, '--purge-home'], f.seams), error => {
      assert.match(error.message, new RegExp(path.basename(other).replace(/\./g, '\\.')), 'names the file');
      assert.match(error.message, platform === 'linux' ? /systemctl --user disable --now/ : /launchctl bootout/, 'says how to stop it');
      return true;
    });
    assert(fs.existsSync(f.home), 'the home is kept');
    assert(fs.existsSync(f.unit), 'the known unit is kept: nothing was stopped or deleted');
    // A home whose name only starts like this one is not a reference.
    fs.writeFileSync(other, platform === 'linux' ? `[Service]\nEnvironment=HOME=${f.home}-two\n` : `<dict><string>${f.home}-two/logs</string></dict>\n`);
    run(['--remove', '--worker', 'fern', '--home', f.home, '--purge-home'], f.seams);
    assert(!fs.existsSync(f.home) && !fs.existsSync(f.unit));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('purge refuses while a process holds the bridge database open, then proceeds when it is gone', async () => {
  const f = fixture(process.platform === 'darwin' ? 'darwin' : 'linux');
  let holder;
  try {
    const dbDir = path.join(f.home, '.local/share/dalan');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = path.join(dbDir, 'bridge.db');
    fs.writeFileSync(db, '');
    holder = spawn(process.execPath, ['-e', `require('fs').openSync(${JSON.stringify(db)},'r'); console.log('open'); setInterval(()=>{},1000)`], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise(resolve => holder.stdout.once('data', resolve));
    assert.throws(() => run(['--remove', '--worker', 'fern', '--home', f.home, '--purge-home'], f.seams), error => {
      assert.match(error.message, new RegExp(`\\b${holder.pid}\\b`), `names the process: ${error.message}`);
      assert.match(error.message, /stop/i);
      return true;
    });
    assert(fs.existsSync(f.home), 'the home is kept');
    holder.kill('SIGKILL');
    await new Promise(resolve => holder.once('exit', resolve));
    run(['--remove', '--worker', 'fern', '--home', f.home, '--purge-home'], f.seams);
    assert(!fs.existsSync(f.home));
  } finally { if (holder && holder.exitCode === null) holder.kill('SIGKILL'); fs.rmSync(f.root, { recursive: true, force: true }); }
});

// ---- A probe that cannot tell is not a probe that found nothing. ----

const lsofResult = over => ({ status: 0, signal: null, stdout: '', stderr: '', ...over });
const darwinProbe = (home, result) => bridgeDatabaseHolders(home, { platform: 'darwin', spawn: () => result });

test('lsof that is missing, times out, fails or overflows is "unknown", not "no holders"', () => {
  const home = '/nonexistent/bridge-home';
  const enoent = Object.assign(new Error('spawnSync lsof ENOENT'), { code: 'ENOENT' });
  const timeout = Object.assign(new Error('spawnSync lsof ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const overflow = Object.assign(new Error('spawnSync lsof ENOBUFS'), { code: 'ENOBUFS' });
  for (const [name, result] of [
    ['missing', lsofResult({ status: null, error: enoent })],
    ['timeout', lsofResult({ status: null, signal: 'SIGTERM', error: timeout })],
    ['killed', lsofResult({ status: null, signal: 'SIGKILL' })],
    ['overflow', lsofResult({ status: null, error: overflow })],
    ['error exit', lsofResult({ status: 2, stderr: 'lsof: unsupported option' })],
    ['exit 1 with a warning', lsofResult({ status: 1, stderr: "lsof: WARNING: can't stat() fuse file system" })],
    ['exit 1 with only an unrecognized line', lsofResult({ status: 1, stdout: 'p4242\ncnode\n' })],
  ]) {
    const r = darwinProbe(home, result);
    assert.deepEqual(r.holders, [], `${name}: no holder is named`);
    assert.equal(typeof r.unknown, 'string', `${name}: the probe reports that it could not tell`);
    assert.ok(r.unknown.length > 0);
  }
});

test('lsof that ran and found nothing, or found a holder, is a definite answer', () => {
  const home = '/nonexistent/bridge-home';
  // lsof exits 1 with no output when nothing matched.
  assert.deepEqual(darwinProbe(home, lsofResult({ status: 1 })), { holders: [], unknown: null });
  assert.deepEqual(darwinProbe(home, lsofResult({ status: 0 })), { holders: [], unknown: null });
  const withHolder = darwinProbe(home, lsofResult({ status: 0, stdout: `p4242\ncnode\nn${home}/.local/share/dalan/bridge.db\n` }));
  assert.deepEqual(withHolder, { holders: [{ pid: '4242', command: 'node' }], unknown: null });
  // A holder that was found stays a holder even when lsof also exited with an error.
  assert.equal(darwinProbe(home, lsofResult({ status: 1, stderr: 'warn', stdout: `p4242\ncnode\nn${home}/bridge.db\n` })).holders.length, 1);
});

test('linux: an unreadable /proc, or an fd list that fails to read, is "unknown"', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-probe-'));
  try {
    const home = path.join(root, 'h');
    assert.equal(typeof bridgeDatabaseHolders(home, { platform: 'linux', procRoot: path.join(root, 'no-proc') }).unknown, 'string', 'no /proc');
    const proc = path.join(root, 'proc');
    fs.mkdirSync(path.join(proc, '4242/fd'), { recursive: true });
    assert.deepEqual(bridgeDatabaseHolders(home, { platform: 'linux', procRoot: proc }), { holders: [], unknown: null }, 'a readable /proc with nothing open');
    // A process that refuses us (another user's, or one that is not dumpable) is not a bridge; one whose fd list fails some
    // other way leaves the answer incomplete.
    fs.mkdirSync(path.join(proc, '4244'));
    fs.writeFileSync(path.join(proc, '4244/fd'), '');
    assert.equal(typeof bridgeDatabaseHolders(home, { platform: 'linux', procRoot: proc }).unknown, 'string', 'an fd list that fails to read');
    fs.rmSync(path.join(proc, '4244'), { recursive: true });
    // A process that exited while we looked is not a failure.
    fs.mkdirSync(path.join(proc, '4243'));
    assert.equal(bridgeDatabaseHolders(home, { platform: 'linux', procRoot: proc }).unknown, null, 'a vanished process');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const platform of ['linux', 'darwin']) test(`${platform}: purge keeps the home when the open-file probe cannot tell`, () => {
  const f = fixture(platform);
  try {
    const seams = { ...f.seams, holderProbe: () => ({ holders: [], unknown: 'lsof is not installed' }) };
    assert.throws(() => run(['--remove', '--worker', 'fern', '--home', f.home, '--purge-home'], seams), error => {
      assert.match(error.message, /lsof is not installed/, 'says why');
      assert.match(error.message, /kept/);
      assert.match(error.message, /--purge-home/, 'says how to retry');
      return true;
    });
    assert(fs.existsSync(f.home), 'the home is kept');
    // A probe that ran and found nothing lets the purge go on.
    run(['--remove', '--worker', 'fern', '--home', f.home, '--purge-home'], { ...f.seams, holderProbe: () => ({ holders: [], unknown: null }) });
    assert(!fs.existsSync(f.home), 'the home is removed once the probe is definite');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

// ---- Units that are symlinks, and units that cannot be read. ----

for (const platform of ['linux', 'darwin']) test(`${platform}: purge refuses while a symlinked unit names the home`, () => {
  const f = fixture(platform);
  try {
    const target = path.join(f.root, 'elsewhere', platform === 'linux' ? 'older.service' : 'older.plist');
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, platform === 'linux' ? `[Service]\nEnvironment=HOME=${f.home}\n` : `<dict><key>HOME</key><string>${f.home}</string></dict>\n`);
    const link = path.join(f.dir, platform === 'linux' ? 'bridge-linked.service' : 'com.example.linked.plist');
    fs.symlinkSync(target, link);
    assert.throws(() => run(['--remove', '--worker', 'fern', '--home', f.home, '--purge-home'], f.seams), error => {
      assert.match(error.message, new RegExp(path.basename(link).replace(/\./g, '\\.')), 'names the link');
      return true;
    });
    assert(fs.existsSync(f.home), 'the home is kept');
    assert(fs.existsSync(f.unit), 'nothing was stopped or deleted');
    // Links that cannot name the home are not references: a masked unit and a dangling link.
    fs.rmSync(link);
    fs.symlinkSync('/dev/null', link);
    fs.symlinkSync(path.join(f.root, 'gone'), path.join(f.dir, 'bridge-dangling.service'));
    run(['--remove', '--worker', 'fern', '--home', f.home, '--purge-home'], f.seams);
    assert(!fs.existsSync(f.home));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('purge refuses while a unit file cannot be read', t => {
  if (process.getuid() === 0) return t.skip('root reads everything');
  const f = fixture('linux');
  const unreadable = path.join(f.dir, 'bridge-unreadable.service');
  try {
    fs.writeFileSync(unreadable, `[Service]\nEnvironment=HOME=${f.home}\n`, { mode: 0o000 });
    assert.throws(() => run(['--remove', '--worker', 'fern', '--home', f.home, '--purge-home'], f.seams), error => {
      assert.match(error.message, /bridge-unreadable\.service/);
      assert.match(error.message, /could not be read|cannot be read|not read/);
      return true;
    });
    assert(fs.existsSync(f.home) && fs.existsSync(f.unit), 'nothing was removed');
  } finally { fs.chmodSync(unreadable, 0o600); fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const platform of ['linux', 'darwin']) test(`${platform}: purge refuses a --home reached through a symlinked parent, and keeps the real home`, () => {
  const f = fixture(platform);
  try {
    // The real home stays where it is; an alias of its parent directory points at the same tree.
    const alias = path.join(f.root, 'alias');
    fs.symlinkSync(f.root, alias);
    const aliased = path.join(alias, path.basename(f.home));
    assert.throws(() => run(['--remove', '--worker', 'fern', '--home', aliased, '--purge-home'], f.seams), error => {
      assert.match(error.message, /symbolic link/);
      assert(error.message.includes(f.home), 'names the real path');
      return true;
    });
    assert(fs.existsSync(path.join(f.home, '.config/dot-bridge/workers.json')), 'the real home is kept');
    assert(fs.existsSync(f.unit), 'the unit is kept: nothing is removed before the refusal');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const platform of ['linux', 'darwin']) test(`${platform}: purge refuses while another unit names the home through a symlinked path`, () => {
  const f = fixture(platform);
  try {
    // Another service names the same home through an alias of its parent directory.
    const alias = path.join(f.root, 'alias');
    fs.symlinkSync(f.root, alias);
    const aliased = path.join(alias, path.basename(f.home));
    const other = path.join(f.dir, platform === 'linux' ? 'bridge-aliased.service' : 'com.example.aliased-bridge.plist');
    fs.writeFileSync(other, platform === 'linux' ? `[Service]\nEnvironment=HOME=${aliased}\n` : `<dict><key>HOME</key><string>${aliased}</string></dict>\n`);
    assert.throws(() => run(['--remove', '--worker', 'fern', '--home', f.home, '--purge-home'], f.seams), error => {
      assert.match(error.message, new RegExp(path.basename(other).replace(/\./g, '\\.')), 'names the file');
      return true;
    });
    assert(fs.existsSync(path.join(f.home, '.config/dot-bridge/workers.json')), 'the home is kept');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const platform of ['linux', 'darwin']) for (const mark of [',', ':', '=']) test(`${platform}: purge refuses while another unit names the home through an alias whose name has "${mark}"`, () => {
  const f = fixture(platform);
  try {
    const alias = path.join(f.root, `comma${mark}tag`);
    fs.symlinkSync(f.root, alias);
    const aliased = path.join(alias, path.basename(f.home));
    const other = path.join(f.dir, platform === 'linux' ? 'bridge-delim.service' : 'com.example.delim-bridge.plist');
    fs.writeFileSync(other, platform === 'linux' ? `[Service]\nEnvironment=HOME=${aliased}\n` : `<dict><key>HOME</key><string>${aliased}</string></dict>\n`);
    assert.throws(() => run(['--remove', '--worker', 'fern', '--home', f.home, '--purge-home'], f.seams), error => {
      assert.match(error.message, new RegExp(path.basename(other).replace(/\./g, '\\.')), 'names the file');
      return true;
    });
    assert(fs.existsSync(path.join(f.home, '.config/dot-bridge/workers.json')), 'the home is kept');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const line of ['WorkingDirectory=-ALIAS', 'WorkingDirectory=!ALIAS', 'ExecStart=-ALIAS/run.sh', 'ExecStart=+ALIAS/run.sh', 'ExecStart=@ALIAS/run.sh run', 'ReadWritePaths=-ALIAS']) test(`linux: purge refuses while another unit names the home through an alias written as ${line}`, () => {
  const f = fixture('linux');
  try {
    const alias = path.join(f.root, 'alias');
    fs.symlinkSync(f.root, alias);
    const aliased = path.join(alias, path.basename(f.home));
    const other = path.join(f.dir, 'bridge-prefix.service');
    fs.writeFileSync(other, `[Service]\n${line.replace('ALIAS', aliased)}\n`);
    assert.throws(() => run(['--remove', '--worker', 'fern', '--home', f.home, '--purge-home'], f.seams), error => {
      assert.match(error.message, /bridge-prefix\.service/, 'names the file');
      return true;
    });
    assert(fs.existsSync(path.join(f.home, '.config/dot-bridge/workers.json')), 'the home is kept');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('linux: a unit with too many possible paths to check refuses the purge quickly', () => {
  const f = fixture('linux');
  try {
    const other = path.join(f.dir, 'bridge-crafted.service');
    fs.writeFileSync(other, `[Service]\nEnvironment=X=${'/a,'.repeat(400)}\n`);
    const started = Date.now();
    assert.throws(() => run(['--remove', '--worker', 'fern', '--home', f.home, '--purge-home'], f.seams), error => {
      assert(error.message.includes('bridge-crafted.service'), error.message);
      assert.match(error.message, /could not be read/);
      return true;
    });
    assert(Date.now() - started < 5000, 'the check stays fast');
    assert(fs.existsSync(path.join(f.home, '.config/dot-bridge/workers.json')), 'the home is kept');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
