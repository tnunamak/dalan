import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { gozarProvider } from '../src/try-exposure.mjs';

test('Gozar recovery keeps its original cwd for relative PATH and GOZAR_HOME', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gozar-recovery-cwd-'));
  const originalCwd = process.cwd();
  const launch = path.join(root, 'launch');
  const other = path.join(root, 'other-shell');
  const binDir = path.join(launch, 'path-bin');
  const trapBinDir = path.join(other, 'path-bin');
  const config = path.join(launch, 'controller');
  const stateFile = path.join(config, 'state.json');
  const callsFile = path.join(config, 'commands.jsonl');
  const trapFile = path.join(other, 'path-trap-hit');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(trapBinDir, { recursive: true });
  fs.mkdirSync(other, { recursive: true });

  const fakeCli = path.join(binDir, 'gozar');
  fs.writeFileSync(fakeCli, `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const home = path.resolve(process.env.GOZAR_HOME);
const stateFile = path.join(home, 'state.json');
const callsFile = path.join(home, 'commands.jsonl');
fs.mkdirSync(home, { recursive: true });
const absent = { phase: 'unknown', candidate: null, published: null, limitations: ['Controller unavailable: ENOENT'] };
const snapshot = () => fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : absent;
const save = value => fs.writeFileSync(stateFile, JSON.stringify(value));
fs.appendFileSync(callsFile, JSON.stringify({ args, cwd: process.cwd(), home, cli: fs.realpathSync(process.argv[1]) }) + '\\n');
if (args[0] === 'status') {
  console.log(JSON.stringify({ snapshot: snapshot() }));
  if (snapshot().phase === 'unknown') process.exitCode = 1;
} else if (args[0] === 'expose') {
  const ready = { sessionId: 'owned-session', phase: 'published-ready', candidate: null, published: 'https://trial.example.invalid', resources: [] };
  save(ready); console.log(JSON.stringify({ snapshot: ready }));
} else if (args[0] === 'stop') {
  const current = snapshot();
  if (current.phase === 'published-ready') {
    const pending = { ...current, phase: 'cleanup-pending', candidate: null, published: null, resources: [{ cleanup: 'pending' }] };
    save(pending); console.log(JSON.stringify({ snapshot: pending, localCleanupFailures: ['fixture pending'] }));
  } else {
    const stopped = { ...current, phase: 'stopped', candidate: null, published: null, resources: [] };
    save(stopped); console.log(JSON.stringify({ snapshot: stopped, localCleanupFailures: [] }));
  }
}
`, { mode: 0o700 });
  const trap = path.join(trapBinDir, 'gozar');
  fs.writeFileSync(trap, `#!${process.execPath}
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(trapFile)}, 'wrong executable');
console.log(JSON.stringify({ snapshot: { phase: 'stopped', candidate: null, published: null, resources: [] } }));
`, { mode: 0o700 });

  try {
    process.chdir(launch);
    const env = { PATH: './path-bin', GOZAR_HOME: './controller' };
    const provider = gozarProvider({ resolveBundled: () => null, env });
    assert.equal(provider.probe().ok, true);
    const route = await provider.start({ gatePort: 45678 });
    assert.equal(route.origin, 'https://trial.example.invalid');

    // Force the provider to return its manual recovery command while preserving its own
    // cleanup ownership rules. This fake controller reports an unconfirmed stop.
    const originalCalls = fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse);
    const last = originalCalls.at(-1);
    const cleanup = await provider.stop();
    assert.equal(cleanup.removed, false);
    assert.match(cleanup.command, /stop/);
    assert.equal(last.args[0], 'expose');
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).phase, 'cleanup-pending');

    // The recovery command must refer to the provider's captured invocation context,
    // not whichever directory happens to be current when someone pastes it.
    process.chdir(other);
    const replay = spawnSync('/bin/sh', ['-c', cleanup.command], {
      cwd: other,
      encoding: 'utf8',
      env: { ...process.env, PATH: '/usr/bin:/bin' },
      timeout: 10_000,
    });
    assert.equal(replay.status, 0, `recovery command failed: ${replay.stderr}`);
    assert.equal(fs.existsSync(trapFile), false, 'recovery did not execute the other shell cwd PATH trap');
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).phase, 'stopped');
    const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.at(-1).cwd, launch, 'recovery command ran the provider CLI from its original cwd');
    assert.equal(calls.at(-1).home, config, 'relative GOZAR_HOME resolved to the original controller config');
    assert.equal(calls.at(-1).cli, fakeCli, 'recovery used the originally selected CLI');
    assert.deepEqual(calls.at(-1).args, ['stop', '--port', '45678']);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
