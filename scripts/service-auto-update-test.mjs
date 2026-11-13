import assert from 'node:assert/strict';
import { createFakeGozar } from '../src/test-support/gozar-fake.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { autoUpdateUnits, setAutoUpdate } from '../src/service-auto-update.mjs';
import { installService, serviceMain } from '../src/service.mjs';
import { defaultPath } from '../src/paths.mjs';

const scratch = path.join(os.homedir(), '.tmp');
fs.mkdirSync(scratch, { recursive: true });
function fixture() {
  const root = fs.mkdtempSync(path.join(scratch, 'du-'));
  const home = path.join(root, 'h'), unitDir = path.join(root, 'systemd/user');
  const config = defaultPath(home, '.config/dot-bridge');
  fs.mkdirSync(config, { recursive: true, mode: 0o700 });
  fs.mkdirSync(unitDir, { recursive: true });
  const receipt = { schema_version: 1, home, unit: 'dalan-123', unit_dir: unitDir, node: process.execPath, repo: '/opt/dalan', auto_update: true };
  fs.writeFileSync(path.join(config, 'service-install.json'), JSON.stringify(receipt), { mode: 0o600 });
  return { root, home, unitDir, receipt, config };
}

test('daily update timer runs without consent and uses the selected package', () => {
  const { files, timer } = autoUpdateUnits({ home: '/home/test/bridge', unit: 'dalan-123', node: '/usr/bin/node' });
  assert.equal(timer, 'dalan-123-update.timer');
  assert.match(files[timer], /^OnCalendar=daily$/m);
  assert.match(files[timer], /^RandomizedDelaySec=1h$/m);
  assert.match(files[timer], /^Persistent=true$/m);
  const service = files['dalan-123-update.service'];
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /ExecStart=\/usr\/bin\/node \/home\/test\/bridge\/current\/bin\/dalan.mjs service update --home \/home\/test\/bridge --json/);
  assert(!service.includes('--yes'));
  assert(!service.includes('Environment=HOME='), 'timer needs operator HOME for systemctl and npm');
});

test('on/off persist the preference and control only this timer', async () => {
  const f = fixture(), calls = [];
  try {
    const spawn = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0 }; };
    await setAutoUpdate({ home: f.home, enabled: false }, { spawn });
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.config, 'service-install.json'))).auto_update, false);
    assert(calls.some(call => call.join(' ') === 'systemctl --user disable --now dalan-123-update.timer'));
    await setAutoUpdate({ home: f.home, enabled: true }, { spawn });
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.config, 'service-install.json'))).auto_update, true);
    assert(calls.some(call => call.join(' ') === 'systemctl --user enable --now dalan-123-update.timer'));
    assert(!calls.some(call => call.includes('dalan-123.service')), 'preference changes do not restart bridge');
    assert(fs.existsSync(path.join(f.unitDir, 'dalan-123-update.timer')));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('a killed updater releases the shared preference lock', { timeout: 10000 }, async () => {
  const f = fixture();
  const module = new URL('../src/service-update-lock.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireUpdateLock } from ${JSON.stringify(module)}; acquireUpdateLock(${JSON.stringify(f.home)}); console.log('locked'); setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdout.once('data', resolve);
      child.once('exit', () => reject(new Error('lock holder exited before acquiring')));
    });
    await assert.rejects(setAutoUpdate({ home: f.home, enabled: false }, { spawn: () => ({ status: 0 }) }), /already running/);
    child.kill('SIGKILL'); await exited;
    await setAutoUpdate({ home: f.home, enabled: false }, { spawn: () => ({ status: 0 }) });
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.config, 'service-install.json'))).auto_update, false);
  } finally { child.kill('SIGKILL'); await exited; fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('new installs default on, retries preserve opt-out, explicit opt-in works', async () => {
  const f = fixture();
  fs.rmSync(f.home, { recursive: true });
  const calls = [];
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(f.root, 'xdg') };
  const options = { home: f.home, origin: 'https://bridge.example.test', port: 18789, target: '127.0.0.1:18789', workers: ['fern'] };
  const seams = { env, platform: 'linux', gozar: createFakeGozar(), spawn: (cmd, args) => {
    calls.push([cmd, ...args]);
    return { status: 0, stdout: cmd === 'gozar' ? JSON.stringify({ schemaVersion: 1, route: { origin: options.origin, target: options.target, verification: { status: 'verified' } } }) : '' };
  }, waitForSocket: async () => true };
  try {
    const installed = await installService(options, seams);
    assert.equal(installed.auto_update, true);
    assert(fs.lstatSync(path.join(f.home, 'current')).isSymbolicLink());
    const receipt = JSON.parse(fs.readFileSync(path.join(f.config, 'service-install.json')));
    await setAutoUpdate({ home: f.home, enabled: false }, seams);
    const retried = await installService(options, seams);
    assert.equal(retried.auto_update, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.config, 'service-install.json'))).auto_update, false);
    assert(receipt.unit_dir.startsWith(f.root));
    assert(calls.some(call => call.some(arg => arg.endsWith('-update.timer'))));
    const oldReceipt = { ...receipt };
    for (const key of ['repo', 'node', 'unit_dir', 'auto_update']) delete oldReceipt[key];
    fs.writeFileSync(path.join(f.config, 'service-install.json'), JSON.stringify(oldReceipt));
    const serviceFile = path.join(receipt.unit_dir, `${receipt.unit}.service`);
    fs.writeFileSync(serviceFile, fs.readFileSync(serviceFile, 'utf8')
      .replace(/^ExecStartPre=.*\n/m, '') // 0.6.0 and 0.6.1 units have no recovery step
      .replace(/^WorkingDirectory=.*$/m, 'WorkingDirectory=/opt/previous-dalan')
      .replace(path.join(f.home, 'current', 'src/server.mjs'), '/opt/previous-dalan/src/server.mjs'));
    const enrolled = await installService(options, seams);
    assert.equal(enrolled.auto_update, false, 'old installs enroll without changing their update preference');
    assert(JSON.parse(fs.readFileSync(path.join(f.config, 'service-install.json'))).unit_dir);
    // The unit was written, but the installer died before the old process restarted.
    fs.writeFileSync(path.join(f.config, 'service-install.json'), JSON.stringify(oldReceipt));
    calls.length = 0;
    await installService(options, seams);
    assert(calls.some(call => call[0] === 'systemctl' && call[2] === 'restart'), 'enrollment resumes even when the unit already matches');
    const pending = JSON.parse(fs.readFileSync(path.join(f.config, 'service-install.json')));
    fs.writeFileSync(path.join(f.config, 'service-install.json'), JSON.stringify({ ...pending, enrollment_pending: true }));
    calls.length = 0;
    await installService(options, seams);
    assert(calls.some(call => call[0] === 'systemctl' && call[2] === 'restart'), 'committed enrollment receipt still requires pending restart');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.config, 'service-install.json'))).enrollment_pending, undefined);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('CLI rejects conflicting consent/options and unsupported platform', async () => {
  await assert.rejects(serviceMain(['auto-update', 'maybe']), /on\|off|on or off/);
  await assert.rejects(serviceMain(['update', '--check', '--yes']), /--check.*--yes|--yes.*--check/);
  const f = fixture();
  try {
    await assert.rejects(setAutoUpdate({ home: f.home, enabled: true }, { platform: 'darwin' }), /Linux/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
