// `dalan setup`: Tailscale found -> one question; not found -> one short choice; a saved choice is read by later runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { detectTailscale, runSetup } from '../src/setup.mjs';
import { readRouteSetting, routeSettingPath, writeRouteSetting } from '../src/route-setting.mjs';

const tempRoot = process.env.DOT_BRIDGE_TEST_TMP ?? path.join(os.homedir(), '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const tmp = fs.mkdtempSync(path.join(tempRoot, 'dsetup-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const session = (detect, answers = [], interactive = true) => {
  const env = { XDG_CONFIG_HOME: path.join(tmp, `c${n++}`) };
  const input = new PassThrough();
  let out = '';
  const stream = { write: text => { out += text; if (/[?\]:] $/.test(text) && answers.length) setImmediate(() => input.write(`${answers.shift()}\n`)); } };
  return { env, get out() { return out; }, run: () => runSetup({ env, out: stream, input, interactive, detect }) };
};
const found = { ok: true, node: 'box', dnsName: 'box.tail1.ts.net' };
const absent = { ok: false, installed: false, reason: 'Tailscale is not installed.' };

test('Tailscale found: exactly one question, Enter saves it, and later runs read it', async () => {
  const s = session(() => found, ['']);
  const result = await s.run();
  assert.equal((s.out.match(/\[Y\/n\]/g) ?? []).length, 1);
  assert.match(s.out, /Use Tailscale \(box\) for a stable address\? \[Y\/n\] /);
  assert.equal(result.route, 'tailscale');
  assert.equal(readRouteSetting(s.env), 'tailscale');
  assert.equal(fs.statSync(routeSettingPath(s.env)).mode & 0o777, 0o600);
});

test('Tailscale found, answer n: keeps trial links and says so', async () => {
  const s = session(() => found, ['n']);
  await s.run();
  assert.equal(readRouteSetting(s.env), 'localhost.run');
  assert.match(s.out, /keeps making trial links/);
});

test('Tailscale not found: one short choice list; 2 keeps trial links, anything else saves nothing', async () => {
  const two = session(() => absent, ['2']);
  await two.run();
  assert.match(two.out, /For daily use, pick one:\n  1\. Tailscale \(recommended\): install it from https:\/\/tailscale\.com\/download/);
  assert.match(two.out, /2\. Keep using trial links/);
  assert.equal(readRouteSetting(two.env), 'localhost.run');
  const one = session(() => absent, ['1']);
  await one.run();
  assert.equal(readRouteSetting(one.env), null);
  assert.match(one.out, /Nothing saved/);
});

test('without a terminal nothing is asked and nothing is saved', async () => {
  for (const detect of [() => found, () => absent]) {
    const s = session(detect, [], false);
    await s.run();
    assert.equal(readRouteSetting(s.env), null);
    assert.doesNotMatch(s.out, /\[Y\/n\]|Choose/);
  }
});

test('detectTailscale: no binary is not installed; a failing preflight is one reason line', () => {
  assert.deepEqual(detectTailscale({ which: () => null }), { ok: false, installed: false, reason: 'Tailscale is not installed.' });
  const broken = detectTailscale({ which: () => '/bin/tailscale', tailscale: () => { throw new Error('Tailscale is not running or not logged in.\nmore'); } });
  assert.equal(broken.ok, false);
  assert.equal(broken.installed, true);
  assert.doesNotMatch(broken.reason, /\n/);
});

test('the saved route: unknown values are ignored and refused, and a corrupt file reads as no choice', () => {
  const env = { XDG_CONFIG_HOME: path.join(tmp, 'rs') };
  assert.equal(readRouteSetting(env), null);
  assert.throws(() => writeRouteSetting('cloudflare', env), /unknown route/);
  fs.mkdirSync(path.dirname(routeSettingPath(env)), { recursive: true });
  fs.writeFileSync(routeSettingPath(env), '{not json');
  assert.equal(readRouteSetting(env), null);
  fs.writeFileSync(routeSettingPath(env), '{"route":"cloudflare"}');
  assert.equal(readRouteSetting(env), null);
});
