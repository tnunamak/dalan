// The one-command install on both systems, with fakes for launchctl, systemctl and Gozar: `service install --worker W --route R`,
// a second run that changes nothing, the update job, the default-home pointer, the CLI following the updater, and uninstall.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultPath } from '../src/paths.mjs';
import { installService, serviceMain, uninstallService } from '../src/service.mjs';
import { createFakeGozar } from '../src/test-support/gozar-fake.mjs';
import { servicePlist, updatePlist, controlLaunchd, launchdLabels, MARKER } from '../src/service-launchd.mjs';
import { homePointerPath, readDefaultHome, recordDefaultHome, serviceHomeFor } from '../src/default-home.mjs';
import { followTarget } from '../src/follow-current.mjs';
import { controlService } from '../src/service-update-runtime.mjs';

const scratch = process.env.TMPDIR ?? path.join(os.homedir(), '.tmp');
fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
const root = fs.mkdtempSync(path.join(scratch, 'dalan-one-command-'));
const sandbox = name => {
  const userHome = path.join(root, name);
  fs.mkdirSync(path.join(userHome, '.config'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(userHome, 'Library', 'LaunchAgents'), { recursive: true, mode: 0o700 });
  return { userHome, env: { PATH: process.env.PATH, HOME: userHome, XDG_CONFIG_HOME: path.join(userHome, '.config'), GOZAR_HOME: '/' } };
};
// A launchctl that remembers which labels are loaded and logs every call.
const fakeLaunchctl = () => {
  const loaded = new Set(), log = [];
  const spawn = (cmd, args) => {
    assert.equal(cmd, 'launchctl'); log.push(args.join(' '));
    const [verb, target, file] = args, label = String(target).split('/').pop();
    if (verb === 'print') return { status: loaded.has(label) ? 0 : 113, stdout: '', stderr: '' };
    if (verb === 'bootstrap') { const text = fs.readFileSync(file, 'utf8'); loaded.add(/<key>Label<\/key>\s*<string>([^<]+)/.exec(text)[1]); return { status: 0, stdout: '', stderr: '' }; }
    if (verb === 'bootout') { loaded.delete(label); return { status: 0, stdout: '', stderr: '' }; }
    return { status: 0, stdout: '', stderr: '' }; // kickstart
  };
  return { spawn, loaded, log };
};
const systemctlCalls = [];
const spawnSystemctl = (cmd, args) => { systemctlCalls.push([cmd, ...args]); return { status: 0, stdout: '', stderr: '' }; };
const seamsFor = (name, platform, extra = {}) => {
  const box = sandbox(name), launchctl = fakeLaunchctl(), gozar = createFakeGozar();
  const closed = [];
  const closeRoute = gozar.closeRoute; gozar.closeRoute = async request => { closed.push(request.handle); return closeRoute(request); };
  const ensure = gozar.ensureRoute; gozar.ensureRoute = async query => { const view = await ensure(query); return { ...view, verification: { ...(view.verification ?? {}), status: 'verified', method: 'challenge' } }; };
  const addService = gozar.addService; gozar.addService = async request => { const reply = await addService(request); reply.route = { ...reply.route, verification: { status: 'verified', method: 'challenge' } }; return reply; };
  const seams = { env: box.env, platform, gozar, node: '/usr/bin/node', repo: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), spawn: spawnSystemctl,
    waitForSocket: async () => true, freePort: async () => 8789, launchd: { spawn: launchctl.spawn, uid: 501, env: box.env }, consent: async () => true, ...extra };
  return { ...box, launchctl, gozar, closed, seams };
};
const options = (box, extra = {}) => ({ home: path.join(box.userHome, '.local/share/dalan-service'), auto: true, origin: null, port: null, target: null, lanPort: null,
  enableWorkspace: false, enableT3: false, workers: ['muse'], verifyCmd: null, route: 'work', autoUpdate: undefined, writeUnitsOnly: false, json: false, ...extra });

try {
  // ---- plists are well formed and keep the rules of the launchd design ---------------------------------------------------------------
  const plist = servicePlist({ unit: 'dalan-abc', node: '/opt/homebrew/bin/node', home: '/Users/t/svc', port: 8789 });
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/, 'restart after a crash, not after a clean exit');
  assert.match(plist, /service recover --home \/Users\/t\/svc --quiet &amp;&amp; exec \/opt\/homebrew\/bin\/node \/Users\/t\/svc\/current\/src\/server\.mjs/, 'recovery runs before the server');
  assert.ok(plist.includes(MARKER) && plist.includes('/Users/t/svc/logs/bridge.err.log'));
  assert.throws(() => servicePlist({ unit: 'x', node: '/opt/h omebrew/node', home: '/Users/t/svc', port: 1 }), /safe absolute path/);
  const update = updatePlist({ unit: 'dalan-abc', node: '/opt/homebrew/bin/node', home: '/Users/t/svc' });
  assert.match(update, /<string>org\.dalan\.dalan-abc-update<\/string>/);
  assert.match(update, /service<\/string>\s*<string>update/);
  assert.equal(update, updatePlist({ unit: 'dalan-abc', node: '/opt/homebrew/bin/node', home: '/Users/t/svc' }), 'the update time depends only on the home');

  // ---- macOS: one command, then nothing to change on the second run -----------------------------------------------------------------
  const mac = seamsFor('mac', 'darwin');
  const first = await installService(options(mac), mac.seams);
  const labels = launchdLabels(path.basename(first.home) && JSON.parse(fs.readFileSync(path.join(defaultPath(first.home, '.config/dot-bridge'), 'service-install.json'), 'utf8')).unit);
  assert.equal(first.started, true); assert.equal(first.already_installed, false);
  assert.match(first.origin, /^https:\/\/fake-\d+\.route\.invalid$/, 'the public address comes from the route, not the command line');
  assert.equal(first.port, 8789);
  assert.ok(mac.launchctl.loaded.has(labels.service) && mac.launchctl.loaded.has(labels.update), 'service and update agents are loaded');
  assert.ok(fs.existsSync(path.join(mac.userHome, 'Library/LaunchAgents', `${labels.service}.plist`)));
  assert.ok(mac.launchctl.log.some(line => line.startsWith(`kickstart user/501/${labels.service}`)), 'kickstart after bootstrap');
  assert.ok(fs.existsSync(first.resource_url_file) && fs.readFileSync(first.resource_url_file, 'utf8').startsWith(`${first.origin}/`));
  assert.equal(readDefaultHome(mac.env), first.home, 'the install records the default home');
  assert.equal(serviceHomeFor(mac.env), first.home);
  assert.equal(serviceHomeFor({ ...mac.env, DALAN_HOME: '/elsewhere/h' }), '/elsewhere/h', 'DALAN_HOME still overrides');
  const receipt = JSON.parse(fs.readFileSync(path.join(defaultPath(first.home, '.config/dot-bridge'), 'service-install.json'), 'utf8'));
  assert.equal(receipt.platform, 'darwin'); assert.equal(receipt.auto_update, true); assert.equal(receipt.route, 'work'); assert.ok(receipt.route_handle?.id);
  const before = mac.launchctl.log.length, stat = fs.statSync(path.join(mac.userHome, 'Library/LaunchAgents', `${labels.service}.plist`)).mtimeMs;
  const second = await installService(options(mac), mac.seams);
  assert.equal(second.already_installed, true); assert.equal(second.origin, first.origin, 'the same address on the second run');
  assert.equal(fs.statSync(path.join(mac.userHome, 'Library/LaunchAgents', `${labels.service}.plist`)).mtimeMs, stat, 'the second run leaves the plist alone');
  assert.ok(!mac.launchctl.log.slice(before).some(line => line.startsWith('bootout')), 'the second run does not unload a running agent');
  const lines = []; await serviceMain(['install', '--worker', 'muse', '--route', 'work'], { ...mac.seams, out: line => lines.push(line) });
  const text = lines.join('\n');
  assert.match(text, /Connector URL \(keep private\): in .*resource-url/); assert.match(text, /Next: dalan connect start --worker muse/); assert.match(text, /Check: dalan doctor --auth/);
  assert.ok(!text.includes(fs.readFileSync(first.resource_url_file, 'utf8').trim()), 'the secret URL is never printed');

  // the updater controls the launchd agent
  const controlLog = []; const receiptView = { ...receipt, unit_dir: receipt.unit_dir };
  await controlService(receiptView, 'restart', { launchd: (r, action) => controlLog.push([r.platform, action]) }); await controlService(receiptView, 'stop', { launchd: (r, action) => controlLog.push([r.platform, action]) });
  assert.deepEqual(controlLog, [['darwin', 'restart'], ['darwin', 'stop']]);
  controlLaunchd(receipt, 'restart', mac.seams.launchd); assert.ok(mac.launchctl.log.at(-1).startsWith(`kickstart -k user/501/${labels.service}`));
  controlLaunchd(receipt, 'stop', mac.seams.launchd); assert.ok(!mac.launchctl.loaded.has(labels.service));
  controlLaunchd(receipt, 'restart', mac.seams.launchd); assert.ok(mac.launchctl.loaded.has(labels.service), 'a stopped agent is bootstrapped again by restart');

  // a plist someone else wrote is never overwritten
  fs.writeFileSync(path.join(mac.userHome, 'Library/LaunchAgents', `${labels.service}.plist`), '<plist>hand made</plist>');
  await assert.rejects(installService(options(mac), mac.seams), /not generated by dalan/);

  // uninstall: agents gone, plists gone, route closed, pointer forgotten, home kept
  fs.writeFileSync(path.join(mac.userHome, 'Library/LaunchAgents', `${labels.service}.plist`), servicePlist({ unit: receipt.unit, node: '/usr/bin/node', home: first.home, port: 8789 }));
  const gone = await uninstallService({ home: first.home }, mac.seams);
  assert.ok(gone.removed.some(line => line.startsWith('removed') && line.endsWith(`${labels.service}.plist`)));
  assert.equal(fs.readdirSync(path.join(mac.userHome, 'Library/LaunchAgents')).length, 0, 'no agent file is left');
  assert.equal(mac.launchctl.loaded.size, 0, 'nothing stays loaded');
  assert.equal(mac.closed.length, 1, 'the durable route is released'); assert.equal(fs.existsSync(homePointerPath(mac.env)), false);
  assert.ok(fs.existsSync(first.home), 'the home is kept');

  // ---- Linux: the same one command, through systemd ----------------------------------------------------------------------------------
  const linux = seamsFor('linux', 'linux');
  const lin = await installService(options(linux), linux.seams);
  assert.equal(lin.started, true); assert.match(lin.origin, /^https:\/\//);
  assert.ok(systemctlCalls.some(call => call.includes('enable') && call.some(arg => String(arg).endsWith('-update.timer'))), 'the update timer is enabled');
  assert.equal(readDefaultHome(linux.env), lin.home);
  const again = await installService(options(linux), linux.seams); assert.equal(again.already_installed, true); assert.equal(again.origin, lin.origin);
  const linuxReceipt = JSON.parse(fs.readFileSync(path.join(defaultPath(lin.home, '.config/dot-bridge'), 'service-install.json'), 'utf8'));
  const removedLinux = await uninstallService({ home: lin.home }, linux.seams);
  assert.ok(removedLinux.removed.some(line => line.endsWith('.service')));
  assert.deepEqual(fs.readdirSync(path.join(linux.userHome, '.config/systemd/user')), [], 'no unit file is left');
  assert.ok(systemctlCalls.some(call => call.includes('disable') && call.includes(`${linuxReceipt.unit}.service`)));

  // ---- --route WORD: a word in the label of a route Gozar offers (nothing here knows a provider) -----------------------------------------
  const word = seamsFor('word', 'linux');
  const byWord = await installService(options(word, { route: 'public' }), word.seams);
  assert.match(byWord.origin, /^https:\/\//, 'a label word picks the offered route');
  await assert.rejects(installService(options(seamsFor('badword', 'linux'), { route: 'nonesuch' }), seamsFor('badword', 'linux').seams), /No route is named or labelled "nonesuch"\. Offered: Example public route/);
  await assert.rejects(installService(options(seamsFor('wrongword', 'linux'), { route: 'temporary' }), seamsFor('wrongword', 'linux').seams), /No route|not usable|route/i);

  // ---- explicit external route keeps working; --route alone needs a name, nothing alone is refused ------------------------------------
  await assert.rejects(serviceMain(['install', '--worker', 'muse'], seamsFor('refuse', 'linux').seams), /pass --route NAME/);

  // ---- the default home pointer -------------------------------------------------------------------------------------------------------
  const pointer = sandbox('pointer');
  assert.equal(readDefaultHome(pointer.env), null);
  const home = path.join(pointer.userHome, 'h'); fs.mkdirSync(path.join(home, '.config'), { recursive: true });
  recordDefaultHome(home, pointer.env); assert.equal(readDefaultHome(pointer.env), home);
  assert.equal(fs.statSync(homePointerPath(pointer.env)).mode & 0o777, 0o600);
  fs.writeFileSync(homePointerPath(pointer.env), 'relative/path\n'); assert.equal(readDefaultHome(pointer.env), null, 'a relative record is ignored');
  fs.writeFileSync(homePointerPath(pointer.env), `${path.join(pointer.userHome, 'missing')}\n`); assert.equal(readDefaultHome(pointer.env), null, 'a record with no Dalan home is ignored');

  // ---- the CLI on PATH follows the service's current version ------------------------------------------------------------------------
  const follow = sandbox('follow'), fhome = path.join(follow.userHome, 'svc'), pkg = path.join(fhome, 'versions/9.9.9/bin');
  fs.mkdirSync(path.join(fhome, '.config'), { recursive: true }); fs.mkdirSync(pkg, { recursive: true }); fs.writeFileSync(path.join(pkg, 'dalan.mjs'), '');
  fs.symlinkSync(path.join(fhome, 'versions/9.9.9'), path.join(fhome, 'current'));
  const own = path.join(follow.userHome, 'global/bin/dalan.mjs'); fs.mkdirSync(path.dirname(own), { recursive: true }); fs.writeFileSync(own, '');
  recordDefaultHome(fhome, follow.env);
  assert.equal(followTarget({ ownBin: own, env: follow.env }), fs.realpathSync(path.join(pkg, 'dalan.mjs')), 'the CLI hands over to the version the service runs');
  assert.equal(followTarget({ ownBin: path.join(pkg, 'dalan.mjs'), env: follow.env }), null, 'no handover when already that version');
  assert.equal(followTarget({ ownBin: own, env: { ...follow.env, DALAN_NO_FOLLOW: '1' } }), null);
  assert.equal(followTarget({ ownBin: own, env: { ...follow.env, DALAN_FOLLOWED: '1' } }), null, 'one handover at most');
  console.log('service-one-command-test: ok');
} finally { if (!process.env.KEEP) fs.rmSync(root, { recursive: true, force: true }); }
