#!/usr/bin/env node
// The timeout kill of an automatic preparation is a kill(-pgid). If it ever hit the wrong group it would take down the bridge.
// This test is the bridge's stand-in: it spawns an innocent sibling in its own group, starts a preparation that stalls on a
// dead registry, and shows that the preparation runs in a group of its own, that the kill removes that whole group, and that
// this process, its group and the sibling are untouched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.homedir(), '.tmp', 'prepare-kill-scope-'));
process.env.HOME = home;
const { prepareNodeModulesInChild } = await import('../src/prepared-node-modules.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stat = pid => { const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const rest = text.slice(text.lastIndexOf(')') + 2).split(' '); return { ppid: Number(rest[1]), pgid: Number(rest[2]) }; };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const inStore = () => fs.readdirSync('/proc').filter(pid => /^\d+$/.test(pid)).map(Number).filter(pid => { try { return fs.readlinkSync(`/proc/${pid}/cwd`).startsWith(home); } catch { return false; } });

const sibling = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); // same group as this process
const siblingOwnGroup = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: true }); // a different group
const stalled = http.createServer(() => {});
try {
  await new Promise(resolve => stalled.listen(0, '127.0.0.1', resolve));
  const self = stat(process.pid);
  assert.equal(stat(sibling.pid).pgid, self.pgid, 'the first sibling shares this process\'s group, as a bridge child does');
  const slow = fs.realpathSync(fs.mkdtempSync(path.join(home, 'slow-')));
  const manifest = { name: 'slow-fixture', version: '1.0.0', dependencies: { stalled: '1.0.0' } };
  fs.writeFileSync(path.join(slow, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(slow, 'package-lock.json'), JSON.stringify({ name: 'slow-fixture', version: '1.0.0', lockfileVersion: 3,
    packages: { '': manifest, 'node_modules/stalled': { version: '1.0.0', resolved: `http://127.0.0.1:${stalled.address().port}/stalled.tgz`, integrity: 'sha512-AAAA' } } }));

  const result = prepareNodeModulesInChild(slow, { timeoutMs: 4000, env: { ...process.env, npm_config_registry: `http://127.0.0.1:${stalled.address().port}/` } }).then(() => 'resolved', error => error);
  // While it stalls: every process the preparation started is in one group, and that group is not ours.
  let running = [];
  for (let i = 0; i < 60 && !running.length; i++) { await sleep(100); running = inStore(); }
  assert(running.length > 0, 'the preparation is running');
  const groups = new Set(running.map(pid => stat(pid).pgid));
  assert.equal(groups.size, 1, `one process group, saw ${[...groups]}`);
  const [group] = groups;
  assert.notEqual(group, self.pgid, 'the preparation is not in this process\'s group');
  assert.notEqual(group, stat(siblingOwnGroup.pid).pgid);
  assert.notEqual(group, 0); assert.notEqual(group, 1);

  const outcome = await result;
  assert.equal(outcome.code, 'dependencies_install_failed'); assert.match(outcome.message, /timed out/);
  for (let i = 0; i < 30 && inStore().length; i++) await sleep(100);
  assert.deepEqual(inStore(), [], 'the whole preparation group is gone');
  for (const pid of running) assert.equal(alive(pid), false, `preparation process ${pid} is gone`);
  // And nothing else was touched.
  assert.equal(alive(process.pid), true);
  assert.equal(alive(sibling.pid), true, 'a child of this process in this process\'s group survives');
  assert.equal(alive(siblingOwnGroup.pid), true, 'a child in another group survives');
  assert.equal(stat(process.pid).pgid, self.pgid);
  console.log('PASS prepare-kill-scope: the timeout kill removes only the preparation\'s own process group');
} finally {
  for (const child of [sibling, siblingOwnGroup]) try { child.kill('SIGKILL'); } catch {}
  stalled.close();
  fs.chmodSync(home, 0o700);
  fs.rmSync(home, { recursive: true, force: true });
}
