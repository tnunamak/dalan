// The one-command install on both systems, with fakes for launchctl, systemctl and Gozar: `service install --worker W --route R`,
// a second run that changes nothing, the update job, the default-home pointer, the CLI following the updater, and uninstall.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultPath } from '../src/paths.mjs';
import { installService, serviceMain, uninstallService } from '../src/service.mjs';
import { createFakeGozar } from '../src/test-support/gozar-fake.mjs';
import { servicePlist, updatePlist, controlLaunchd, launchdLabels, MARKER } from '../src/service-launchd.mjs';
import { homePointerPath, readDefaultHome, recordDefaultHome, serviceHomeFor } from '../src/default-home.mjs';
import { followTarget } from '../src/follow-current.mjs';
import { controlService } from '../src/service-update-runtime.mjs';

// A short root: each test home must leave its admin socket path under the platform limit (103 bytes on macOS), which install checks.
// The deepest one is <root>/mac/.local/share/dalan-service/.local/share/dalan/admin.sock, so a long TMPDIR falls back to /tmp.
const preferred = process.env.TMPDIR ?? path.join(os.homedir(), '.tmp');
const scratch = preferred.length <= 30 ? preferred : fs.realpathSync('/tmp');
fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
const root = fs.mkdtempSync(path.join(scratch, 'd1-'));
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
  // macOS 26: a bootstrapped job stays loaded and never spawns until kickstart. Update and rollback both run stop, daemon-reload, restart.
  for (const path of ['update', 'rollback']) {
    const spawned = new Set(), loadedNow = new Set(), calls = [];
    const fake = (cmd, args) => {
      calls.push(args.join(' ')); const [verb, target, file] = args, label = String(target).split('/').pop();
      if (verb === 'print') return { status: loadedNow.has(label) ? 0 : 113, stdout: '', stderr: '' };
      if (verb === 'bootstrap') { loadedNow.add(/<key>Label<\/key>\s*<string>([^<]+)/.exec(fs.readFileSync(file, 'utf8'))[1]); return { status: 0, stdout: '', stderr: '' }; }
      if (verb === 'bootout') { loadedNow.delete(label); spawned.delete(label); return { status: 0, stdout: '', stderr: '' }; }
      if (verb === 'kickstart') { if (!loadedNow.has(label)) return { status: 113, stdout: '', stderr: 'not loaded' }; spawned.add(label); return { status: 0, stdout: '', stderr: '' }; }
      return { status: 0, stdout: '', stderr: '' };
    };
    const seams = { spawn: fake, uid: 501, env: mac.env };
    loadedNow.add(labels.service); spawned.add(labels.service);
    controlLaunchd(receipt, 'stop', seams); controlLaunchd(receipt, 'daemon-reload', seams); controlLaunchd(receipt, 'restart', seams);
    assert.ok(spawned.has(labels.service), `${path}: the agent is spawned, not just loaded`);
  }

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
  assert.ok(!fs.existsSync(first.home) && fs.existsSync(gone.moved_to), 'the home is moved aside, not deleted');
  assert.ok(fs.existsSync(path.join(gone.moved_to, 'resource-url')));

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
  await assert.rejects(installService(options(seamsFor('badword', 'linux'), { route: 'nonesuch' }), seamsFor('badword', 'linux').seams), /No route named "nonesuch", and none offered is labelled with it\. Offered: Example public route/);
  await assert.rejects(installService(options(seamsFor('wrongword', 'linux'), { route: 'temporary' }), seamsFor('wrongword', 'linux').seams), /No route|not usable|route/i);

  // ---- explicit external route keeps working; --route alone needs a name, nothing alone is refused ------------------------------------
  await assert.rejects(serviceMain(['install', '--worker', 'muse'], seamsFor('refuse', 'linux').seams), /pass --route NAME/);

  // ---- a failed install allocates no public route: every read-only check runs first ---------------------------------------------------
  {
    const unitDirOf = box => path.join(box.env.XDG_CONFIG_HOME, 'systemd/user');
    const untouched = (box, home, why) => {
      assert.deepEqual(box.gozar.fake.state.calls, [], `${why}: Gozar is not asked for anything`);
      assert.deepEqual(box.gozar.fake.state.effects, [], `${why}: no route is allocated`);
      assert.equal(fs.existsSync(home), false, `${why}: no home is created`);
      assert.equal(fs.existsSync(unitDirOf(box)), false, `${why}: no unit file is written`);
    };
    // The admin socket path must fit the platform limit (bytes, without the terminating NUL): exactly at the limit passes the check.
    for (const [platform, limit, name] of [['linux', 107, 'sl'], ['darwin', 103, 'sm']]) {
      for (const extra of [0, 1]) {
        const box = seamsFor(`${name}${extra}`, platform);
        const suffix = Buffer.byteLength(path.join(box.userHome, '/.local/share/dalan/admin.sock'));
        const home = path.join(box.userHome, 'h'.repeat(limit + extra - suffix - 1));
        assert.equal(Buffer.byteLength(path.join(home, '.local/share/dalan/admin.sock')), limit + extra);
        const reached = new Error('the socket check passed');
        let ports = 0;
        const attempt = installService(options(box, { home }), { ...box.seams, freePort: async () => { ports++; throw reached; } });
        if (extra === 0) { await assert.rejects(attempt, error => error === reached); assert.equal(ports, 1); }
        else {
          await assert.rejects(attempt, error => {
            assert.ok(error.message.includes(`would be ${limit + 1} bytes`), error.message);
            assert.ok(error.message.includes(`limit on ${platform === 'darwin' ? 'macOS' : 'Linux'} is ${limit} bytes`), error.message);
            assert.ok(error.message.includes('shorter --home'), error.message);
            return true;
          });
          assert.equal(ports, 0, 'a home that is too long is refused before anything else');
        }
        untouched(box, home, `socket ${platform} +${extra}`);
      }
    }
    // An unreachable user systemd manager is named, with the command that shows why, before any route is allocated.
    {
      const box = seamsFor('nomgr', 'linux'), home = options(box).home, calls = [];
      await assert.rejects(installService(options(box), { ...box.seams, spawn: (cmd, args) => { calls.push([cmd, ...args]); return { status: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found' }; } }), error => {
        assert.match(error.message, /user systemd manager is not reachable/);
        assert.ok(error.message.includes('systemctl --user status'), error.message);
        assert.ok(error.message.includes('login session') && error.message.includes('loginctl enable-linger'), error.message);
        assert.ok(error.message.includes('Failed to connect to bus'), 'the system reason is kept');
        return true;
      });
      assert.deepEqual(calls, [['systemctl', '--user', 'show-environment']]);
      untouched(box, home, 'no systemd manager');
    }
    // A worker profile, a unit-name collision and an unsafe Gozar state path are all found before the allocation.
    {
      const box = seamsFor('noprof', 'linux'), home = options(box).home;
      await assert.rejects(installService(options(box, { workers: [] }), box.seams), /pass --worker NAME/);
      untouched(box, home, 'no worker profile');
    }
    {
      const box = seamsFor('clash', 'linux'), home = options(box).home;
      const unit = `dalan-${createHash('sha256').update(home).digest('hex').slice(0, 10)}.service`;
      fs.mkdirSync(unitDirOf(box), { recursive: true }); fs.writeFileSync(path.join(unitDirOf(box), unit), '[Unit]\nDescription=someone else\n');
      await assert.rejects(installService(options(box), box.seams), /already exists with different contents/);
      assert.deepEqual(box.gozar.fake.state.calls, [], 'a unit collision: Gozar is not asked for anything');
      assert.equal(fs.existsSync(home), false);
    }
    {
      const box = seamsFor('gzst', 'linux'), home = options(box).home, open = path.join(box.userHome, 'gz');
      fs.mkdirSync(open); fs.chmodSync(open, 0o777);
      await assert.rejects(installService(options(box), { ...box.seams, env: { ...box.env, GOZAR_HOME: open } }), /writable by group or others/);
      untouched(box, home, 'an unsafe Gozar state path');
    }
    // --write-units-only writes the units and allocates nothing.
    {
      const box = seamsFor('wuo', 'linux');
      const written = await installService(options(box, { writeUnitsOnly: true }), box.seams);
      assert.equal(written.started, false); assert.equal(written.route, null);
      assert.deepEqual(box.gozar.fake.state.calls, [], '--write-units-only: Gozar is not asked for anything');
      assert.ok(written.units.every(unit => fs.existsSync(path.join(unitDirOf(box), unit))));
    }
    // A failure after the allocation keeps the route's handle in the receipt, so `dalan service uninstall` releases it.
    {
      const box = seamsFor('late', 'linux'), home = options(box).home;
      await assert.rejects(installService(options(box), { ...box.seams, waitForSocket: async () => false }), /did not start on its admin socket/);
      const pin = box.gozar.fake.state.pins.get('dalan-main');
      assert.ok(pin, 'the route was allocated');
      const kept = JSON.parse(fs.readFileSync(path.join(defaultPath(home, '.config/dot-bridge'), 'service-install.json'), 'utf8'));
      assert.deepEqual(kept.route_handle, pin.view.handle, 'the receipt holds the handle of the allocated route');
      await uninstallService({ home }, box.seams);
      assert.deepEqual(box.closed, [pin.view.handle], 'uninstall releases the route the failed install allocated');
    }
  }

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
  // An explicit --home names another home, so the default home's version is not the one to run. DALAN_HOME still selects its own.
  for (const argv of [['service', 'status', '--home', '/different/home'], ['service', 'status', '--home=/different/home']]) {
    assert.equal(followTarget({ ownBin: own, env: follow.env, argv }), null, `an explicit home does not follow the default home: ${argv.join(' ')}`);
  }
  assert.equal(followTarget({ ownBin: own, env: follow.env, argv: ['service', 'status'] }), fs.realpathSync(path.join(pkg, 'dalan.mjs')));
  assert.equal(followTarget({ ownBin: own, env: { ...follow.env, DALAN_HOME: fhome }, argv: [] }), fs.realpathSync(path.join(pkg, 'dalan.mjs')), 'DALAN_HOME still selects its own package');
  {
    // The real entry point passes its arguments: with --home it stays in this package; without, it hands over.
    const real = sandbox('follow-bin'), rhome = path.join(real.userHome, 'svc'), rpkg = path.join(rhome, 'versions/9.9.9/bin');
    fs.mkdirSync(path.join(rhome, '.config'), { recursive: true }); fs.mkdirSync(rpkg, { recursive: true });
    fs.writeFileSync(path.join(rpkg, 'dalan.mjs'), "process.stdout.write('followed\\n');\n");
    fs.symlinkSync(path.join(rhome, 'versions/9.9.9'), path.join(rhome, 'current'));
    recordDefaultHome(rhome, real.env);
    const bin = fileURLToPath(new URL('../bin/dalan.mjs', import.meta.url));
    const run = args => spawnSync(process.execPath, [bin, ...args], { env: real.env, encoding: 'utf8' });
    const ownVersion = `${JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}\n`;
    assert.equal(run(['--version']).stdout, 'followed\n', 'without --home the CLI hands over to the default home');
    assert.equal(run(['--version', '--home', path.join(real.userHome, 'other')]).stdout, ownVersion, 'an explicit --home stays in this package');
    assert.equal(run(['--version', `--home=${path.join(real.userHome, 'other')}`]).stdout, ownVersion, 'an explicit --home= stays in this package');
  }
  console.log('service-one-command-test: ok');
} finally { if (!process.env.KEEP) fs.rmSync(root, { recursive: true, force: true }); }
