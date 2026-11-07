// `worker-bridge-setup.mjs --repoint` moves an existing service to the code that runs the script (an upgrade from the
// renamed npm package, or a moved checkout) and changes nothing else. Units are written to a throwaway HOME; no service manager runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { run } from './worker-bridge-setup.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const OLD = '/opt/old/lib/node_modules/dot-bridge';

function fixture(platform) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repoint-'))); // setup refuses a lock path through a symlink (macOS /var)
  const bin = path.join(root, 'bin'); // a stand-in plutil, so the result does not depend on the host's plutil
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'plutil'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: root, XDG_CONFIG_HOME: path.join(root, '.config'), DALAN_SETUP_LOCK_DIR: path.join(root, 'locks') };
  const out = [];
  const seams = { platform, env, log: line => out.push(line) };
  run(['--worker', 'fern', '--public-url', 'https://fern.example.test', '--port', '18801', '--home', path.join(root, 'h'), '--write-units-only'], seams);
  const dir = platform === 'linux' ? path.join(root, '.config/systemd/user') : path.join(root, 'Library/LaunchAgents');
  const file = path.join(dir, platform === 'linux' ? 'dot-bridge-fern.service' : 'org.dalan.dot-bridge-fern.plist');
  // Make it look like an install made by an older package in another directory (older plists lack the session types).
  const generated = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, generated.split(repo).join(OLD).replace(/  <key>LimitLoadToSessionType<\/key>\n  <array>\n(?:    <string>\w+<\/string>\n)+  <\/array>\n/, ''));
  return { root, env, seams, file, out, dir, generated };
}

for (const platform of ['linux', 'darwin']) test(`${platform}: --repoint moves the unit to this code, once`, () => {
  const f = fixture(platform);
  try {
    const before = fs.readFileSync(f.file, 'utf8');
    assert(before.includes(OLD) && !before.includes(repo) && !before.includes('LimitLoadToSessionType'));
    fs.chmodSync(f.file, 0o644);
    f.out.length = 0;
    run(['--repoint', '--worker', 'fern'], f.seams);
    const after = fs.readFileSync(f.file, 'utf8');
    assert.equal(after, f.generated, 'the unit is what this release generates: only the code directory and the session types changed');
    assert.equal(fs.statSync(f.file).mode & 0o777, 0o644);
    assert(f.out.some(l => l.includes(`Repointed ${f.file}`)));
    assert(f.out.some(l => platform === 'linux' ? /systemctl --user daemon-reload && systemctl --user restart dot-bridge-fern/.test(l) : /launchctl bootstrap .*launchctl kickstart -k/.test(l)), 'prints the restart sequence');
    assert.deepEqual(fs.readdirSync(f.dir), [path.basename(f.file)], 'no temporary file left');
    f.out.length = 0;
    run(['--repoint', '--worker', 'fern'], f.seams);
    assert(f.out.some(l => l.includes('already points at')));
    assert.equal(fs.readFileSync(f.file, 'utf8'), after);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

// A supported HOME can sit below the old code directory. --repoint changes the code directory and the script argument and
// nothing else: HOME, the environment, the interpreter and the log paths stay as they are.
for (const platform of ['linux', 'darwin']) test(`${platform}: --repoint leaves a HOME below the old code directory untouched`, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repoint-nested-')));
  try {
    const old = path.join(root, 'opt/old-package');
    const home = path.join(old, 'state');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'plutil'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: root, XDG_CONFIG_HOME: path.join(root, '.config'), DALAN_SETUP_LOCK_DIR: path.join(root, 'locks') };
    const seams = { platform, env, log: () => {} };
    run(['--worker', 'fern', '--public-url', 'https://fern.example.test', '--port', '18801', '--home', home, '--write-units-only'], seams);
    const file = platform === 'linux' ? path.join(root, '.config/systemd/user/dot-bridge-fern.service') : path.join(root, 'Library/LaunchAgents/org.dalan.dot-bridge-fern.plist');
    const generated = fs.readFileSync(file, 'utf8');
    assert(generated.includes(home), 'the unit names the nested HOME');
    // The same unit as an older install wrote it: the code directory and the script argument name the old directory.
    const aged = generated
      .replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${old}`)
      .replace(/(<key>WorkingDirectory<\/key>\s*<string>)[^<]*/, `$1${old}`)
      .replace(`<string>${path.join(repo, 'src/server.mjs')}</string>`, `<string>${path.join(old, 'src/server.mjs')}</string>`);
    assert.notEqual(aged, generated);
    fs.writeFileSync(file, aged);
    run(['--repoint', '--worker', 'fern'], seams);
    assert.equal(fs.readFileSync(file, 'utf8'), generated, 'only the code directory and the script argument changed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// An older macOS plist lacks the session types that the user domain needs. --repoint adds them even when the code
// directory did not move, so an in-place upgrade can run it every time.
test('darwin: --repoint adds the session types to a current-label plist whose code directory did not move', () => {
  const f = fixture('darwin');
  try {
    const stripped = f.generated.replace(/  <key>LimitLoadToSessionType<\/key>\n  <array>\n(?:    <string>\w+<\/string>\n)+  <\/array>\n/, '');
    assert.notEqual(stripped, f.generated);
    fs.writeFileSync(f.file, stripped);
    f.out.length = 0;
    run(['--repoint', '--worker', 'fern'], f.seams);
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.generated);
    assert(f.out.some(l => l.includes('session types')), 'the output says what changed');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('--repoint refuses a unit it did not write, a missing unit and extra install options', () => {
  const f = fixture('linux');
  try {
    assert.throws(() => run(['--repoint', '--worker', 'nobody'], f.seams), /no service unit for worker nobody/);
    assert.throws(() => run(['--repoint', '--worker', 'fern', '--port', '18802'], f.seams), /--repoint takes only --worker/);
    const text = fs.readFileSync(f.file, 'utf8');
    fs.writeFileSync(f.file, text.replace(/^#.*\n/, '# hand written\n'));
    assert.throws(() => run(['--repoint', '--worker', 'fern'], f.seams), /was not created by worker-bridge-setup/);
    assert(fs.readFileSync(f.file, 'utf8').includes(OLD), 'a refusal leaves the unit unchanged');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('darwin: --repoint refuses a plist whose script is not in its code directory', () => {
  const f = fixture('darwin');
  try {
    const text = fs.readFileSync(f.file, 'utf8');
    fs.writeFileSync(f.file, text.replace(`${OLD}/src/server.mjs`, '/elsewhere/server.mjs'));
    assert.throws(() => run(['--repoint', '--worker', 'fern'], f.seams), /runs a script other than/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

// `launchctl kickstart` fails with exit 113 on an agent that `bootout` unloaded. The upgrade guide stops the service with
// bootout, so every kickstart command in it comes right after a bootstrap command.
test('the upgrade guide loads the macOS agent before it kicks it', () => {
  const doc = fs.readFileSync(path.join(repo, 'docs/dalan-upgrade.md'), 'utf8');
  const kicks = [...doc.matchAll(/launchctl kickstart -k/g)];
  assert(kicks.length >= 2, 'both upgrade paths document the macOS start');
  for (const kick of kicks) assert(/launchctl bootstrap [^\n]*\n?[^\n]*$/.test(doc.slice(Math.max(0, kick.index - 160), kick.index)), `bootstrap precedes kickstart at offset ${kick.index}`);
});
