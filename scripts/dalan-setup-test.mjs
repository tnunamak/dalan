// `dalan setup`: Gozar is asked what is possible, the disclosure it returns is shown, one question is asked, and only the requirements,
// the opaque route name and the pinned origin are saved (route-setting version 2).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { runSetup, SWITCH_NOTE } from '../src/setup.mjs';
import { inspectRouteSetting, readRouteSetting, routeSettingPath, validateSetting, writeRouteSetting } from '../src/route-setting.mjs';
import { createFakeGozar } from '../src/test-support/gozar-fake.mjs';

const tempRoot = process.env.DOT_BRIDGE_TEST_TMP ?? path.join(os.homedir(), '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const tmp = fs.mkdtempSync(path.join(tempRoot, 'dsetup-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const GOZAR_HOME = path.join(tmp, 'gozar');
let n = 0;
const session = ({ gozar = createFakeGozar(), answers = [], interactive = true, argv = [] } = {}) => {
  const env = { XDG_CONFIG_HOME: path.join(tmp, `c${n++}`), HOME: tmp };
  const input = new PassThrough();
  let out = '';
  const stream = { write: text => { out += text; if (/[?\]:] $/.test(text) && answers.length) setImmediate(() => input.write(`${answers.shift()}\n`)); } };
  return { env, gozar, get out() { return out; }, run: () => runSetup({ env, out: stream, input, interactive, gozar, gozarHome: GOZAR_HOME, argv }) };
};

test('one question; yes saves a version-2 setting with only the pinned origin and the requirements', async () => {
  const s = session({ answers: ['y'] });
  const result = await s.run();
  assert.equal((s.out.match(/\[y\/N\]/g) ?? []).length, 1);
  assert.equal(result.changed, true);
  const saved = readRouteSetting(s.env);
  assert.equal(saved.version, 2);
  assert.equal(saved.routeId, 'dalan-main');
  assert.equal(saved.routeName, null);
  assert.match(saved.origin, /^https:\/\//);
  assert.deepEqual(Object.keys(saved).sort(), ['bridgeHome', 'gozarHome', 'origin', 'requirements', 'routeId', 'routeName', 'version']);
  assert.equal(fs.statSync(routeSettingPath(s.env)).mode & 0o777, 0o600);
  assert.equal(s.out.match(/^Next:/gm).length, 1, 'one line, once');
  assert.ok(s.out.includes(SWITCH_NOTE));
});

test('--route NAME is passed to Gozar verbatim: an unknown invented name is Gozar\'s route_not_found and nothing is saved', async () => {
  const s = session({ answers: ['y'], argv: ['--route', 'zq-invented-7'] });
  await assert.rejects(s.run(), error => error.code === 'route_not_found');
  assert.equal(readRouteSetting(s.env), null);
  assert.equal(s.gozar.fake.state.pins.size, 0);
});

test('answer n saves nothing and creates no route', async () => {
  const s = session({ answers: ['n'] });
  const result = await s.run();
  assert.equal(result.changed, false);
  assert.equal(readRouteSetting(s.env), null);
  assert.match(s.out, /Nothing saved/);
  assert.equal(s.gozar.fake.state.pins.size, 0);
});

test('without a terminal nothing is asked and nothing is saved', async () => {
  const s = session({ interactive: false });
  await s.run();
  assert.equal(readRouteSetting(s.env), null);
  assert.doesNotMatch(s.out, /\[y\/N\]/);
});

test('a legacy 0.6 setting is left byte-for-byte untouched and setup says so', async () => {
  const s = session({ answers: ['y'] });
  fs.mkdirSync(path.dirname(routeSettingPath(s.env)), { recursive: true });
  fs.writeFileSync(routeSettingPath(s.env), '{"route":"legacy-value"}');
  const result = await s.run();
  assert.equal(result.legacy, true);
  assert.equal(fs.readFileSync(routeSettingPath(s.env), 'utf8'), '{"route":"legacy-value"}');
  assert.match(s.out, /left untouched/);
  assert.equal(s.gozar.fake.state.effects.length, 0);
});

test('the saved setting fails closed: unknown versions, unknown fields and corrupt files are never guessed at', () => {
  const env = { XDG_CONFIG_HOME: path.join(tmp, 'rs'), HOME: tmp };
  assert.equal(inspectRouteSetting(env).state, 'none');
  fs.mkdirSync(path.dirname(routeSettingPath(env)), { recursive: true });
  fs.writeFileSync(routeSettingPath(env), '{not json');
  assert.equal(readRouteSetting(env), null);
  assert.equal(inspectRouteSetting(env).state, 'unreadable');
  fs.writeFileSync(routeSettingPath(env), '{"version":3}');
  assert.equal(inspectRouteSetting(env).state, 'unreadable');
  const good = { version: 2, requirements: {}, gozarHome: GOZAR_HOME, routeName: null, routeId: 'dalan-main', origin: 'https://x.example', bridgeHome: null };
  assert.throws(() => writeRouteSetting({ ...good, extra: 1 }, env), /unknown fields/);
  assert.throws(() => validateSetting({ ...good, origin: 'http://x.example' }), /https origin/);
  writeRouteSetting(good, env);
  assert.equal(readRouteSetting(env).origin, 'https://x.example');
});
