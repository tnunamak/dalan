// Moving a 0.6 route to Gozar with a real bridge on an isolated home. The old route is a fake legacy rule (an https origin that relays to the
// bridge) owned by the 0.6 code until Gozar adopts it. Gozar is the contract-faithful fake; real Gozar integration is not exercised here.
// Settled here: the exact origin, secret path, issuer keys, client ID and grant survive; a crash at any step resumes to the same end state
// with exactly one adopt; the old ingress is untouched until adopt; a failed authenticated check hands the route back.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { beginPairing, openSession } from '../src/demo-worker.mjs';
import { CRASH_POINTS, fenceLegacyRecords, legacyRecordFiles, migrateLegacyRoute, unfenceLegacyRecords } from '../src/gozar-routes.mjs';
import { readJournal, readRouteSetting } from '../src/route-setting.mjs';
import { createFakeGozar } from '../src/test-support/gozar-fake.mjs';
import { reservedPort } from '../src/test-support/port.mjs';
import { defaultPath } from '../src/paths.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const tempRoot = process.env.DOT_BRIDGE_TEST_TMP ?? path.join(os.homedir(), '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const tmp = fs.mkdtempSync(path.join(tempRoot, 'dmig-'));
const children = new Set();
const relayServers = new Set();
process.on('exit', () => { for (const child of children) child.kill('SIGKILL'); for (const relay of relayServers) relay.closeAllConnections(); fs.rmSync(tmp, { recursive: true, force: true }); });
after(() => { for (const child of children) child.kill('SIGKILL'); for (const relay of relayServers) { relay.closeAllConnections(); relay.close(); } });
const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));
const realFetch = globalThis.fetch;
const relays = new Map(); // https host -> bridge port
globalThis.fetch = (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const port = relays.get(url.host);
  if (!port) return realFetch(input, init);
  return realFetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { ...init, headers: { ...(init.headers ?? {}), host: url.host } });
};
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rawGet = ({ port, host, pathname }) => new Promise((resolve, reject) => {
  const request = http.get({ host: '127.0.0.1', port, path: pathname, headers: { host } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
  request.on('error', reject);
});

let counter = 0;
async function legacyInstall() {
  const name = `m${counter++}`;
  const root = path.join(tmp, name);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const port = await reservedPort();
  const origin = `https://legacy-${counter}.route.invalid`;
  const host = new URL(origin).host;
  const env = { PATH: process.env.PATH, HOME: home, DALAN_AUTH_MODE: 'builtin', DALAN_GOZAR_SERVICE: '1', DALAN_PORT: String(port) };
  const run = (...args) => new Promise((resolve, reject) => execFile(process.execPath, [path.join(repo, 'bin/dalan.mjs'), ...args], { env, cwd: repo, timeout: 30_000 }, (error, stdout, stderr) => error ? reject(new Error(`${args.join(' ')}: ${stderr || stdout}`)) : resolve(stdout)));
  await run('init', '--worker', 'hosted', '--public-url', origin);
  const configDir = defaultPath(home, '.config/dot-bridge');
  const log = path.join(home, 'server.log');
  let server = null;
  const start = async () => {
    fs.writeFileSync(log, '');
    server = spawn(process.execPath, [path.join(repo, 'src/server.mjs')], { env, cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(server);
    for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => fs.appendFileSync(log, chunk));
    for (let waited = 0; !/MCP listening/.test(fs.readFileSync(log, 'utf8')); waited += 50) { assert.ok(waited < 20_000, 'bridge did not start'); await sleepMs(50); }
  };
  // The old route: an https host in front of the bridge. The relay sets the public Host, as a route does.
  const relay = http.createServer((req, res) => {
    const forward = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: { ...req.headers, host } }, answer => { res.writeHead(answer.statusCode, answer.headers); answer.pipe(res); });
    forward.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(forward);
  });
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  relays.set(host, relay.address().port);
  relayServers.add(relay);
  const stop = async () => { if (!server) return; const done = new Promise(resolve => server.once('close', resolve)); server.kill('SIGTERM'); await done; children.delete(server); server = null; };
  await start();
  const secret = fs.readFileSync(path.join(configDir, 'env'), 'utf8').match(/^BRIDGE_PATH_SECRET=(.+)$/m)[1];
  const url = `${origin}/${secret}/mcp`;
  // A real enrolled client: registration, owner approval, token. This is the grant that must survive the move.
  await run('connect', 'start', '--worker', 'hosted');
  const pairing = await beginPairing(url, { redirect: 'https://chatgpt.com/connector_platform_oauth_redirect', clientName: 'Migration client' });
  let pending; for (let i = 0; i < 100; i++) { pending = JSON.parse(await run('connect', 'pending', '--json')); if (JSON.stringify(pending).includes(pairing.code)) break; await sleepMs(50); }
  await run('connect', 'approve', pairing.code, '--worker', 'hosted', '--json');
  const token = await pairing.complete();
  const record = path.join(configDir, 'dot-bridge-hosted.exposure.json'); // the old owner's record
  fs.writeFileSync(record, JSON.stringify({ mode: 'legacy', worker: 'hosted', public_url: origin, local_port: port }), { mode: 0o600 });
  const target = `127.0.0.1:${port}`;
  const gozar = createFakeGozar({ legacy: { origin, target, files: [record], generation: 1, bridgeHome: home }, verifyTarget: async () => {
    assert.equal(await rawGet({ port, host, pathname: `/.well-known/gozar/service?nonce=${'a'.repeat(64)}` }), 200, 'the bridge serves the proof while Gozar adopts'); } });
  const env2 = { XDG_CONFIG_HOME: path.join(root, 'xdg'), HOME: home };
  const calls = { fence: 0, unfence: 0, restart: 0, checks: 0 };
  const kit = (extra = {}) => ({
    gozar, env: env2, gozarHome: path.join(root, 'gozar'), routeId: 'dalan-main', origin, target, bridgeHome: home, generation: 1,
    stateFiles: () => [record],
    fence: async () => { calls.fence++; fenceLegacyRecords(configDir); gozar.fake.setLegacyFenced(true); },
    unfence: async () => { calls.unfence++; unfenceLegacyRecords(configDir); gozar.fake.setLegacyFenced(false); },
    restart: async () => { calls.restart++; await stop(); await start(); },
    authenticatedCheck: async () => { calls.checks++; const call = await openSession(url, token); await call('list_pending', {}); return true; },
    consent: async () => true, ...extra,
  });
  const preserved = () => ({ as: sha(path.join(configDir, 'as.json')), env: fs.readFileSync(path.join(configDir, 'env'), 'utf8').match(/^BRIDGE_PATH_SECRET=(.+)$/m)[1],
    keys: fs.readdirSync(configDir).filter(f => /key|jwks/i.test(f)).sort().map(f => [f, sha(path.join(configDir, f))]) });
  return { home, configDir, origin, host, port, url, token, secret, record, gozar, kit, calls, env: env2, preserved, stop, start, run };
}
const adopts = gozar => gozar.fake.state.effects.filter(e => e.type === 'adopt').length;

for (const point of CRASH_POINTS) {
  test(`a crash at ${point} resumes to the same end state: exactly one adopt, the same origin, secret path, issuer keys, client and grant`, async () => {
    const x = await legacyInstall();
    try {
      const before = x.preserved();
      const crash = p => { if (p === point) throw Object.assign(new Error(`crash at ${p}`), { simulatedCrash: true }); };
      await assert.rejects(migrateLegacyRoute(x.kit({ crash })), error => error.simulatedCrash === true);
      // Until adopt the old owner is untouched: no adoption yet, and the old rule is still its own.
      if (['after-prepared', 'after-fence', 'after-fence-journal'].includes(point)) {
        assert.equal(adopts(x.gozar), 0, 'nothing was adopted before the crash point');
        assert.equal(x.gozar.fake.state.legacy.owner, 'legacy');
      }
      assert.ok(readJournal(x.env), 'the journal is on disk after the crash');
      assert.equal(readRouteSetting(x.env) === null || point === 'after-commit-setting', true, 'no v2 setting before the commit step');
      const resumed = await migrateLegacyRoute(x.kit());
      assert.equal(resumed.migrated, true, JSON.stringify(resumed));
      assert.equal(adopts(x.gozar), 1, 'adopt happened exactly once');
      assert.equal(x.gozar.fake.state.legacy.owner, 'gozar');
      const setting = readRouteSetting(x.env);
      assert.equal(setting.origin, x.origin, 'the exact connector origin');
      assert.equal(setting.routeId, 'dalan-main');
      assert.equal(readJournal(x.env), null, 'the journal is gone once committed');
      assert.deepEqual(x.preserved(), before, 'secret path, issuer keys and client registry are byte-identical');
      const call = await openSession(x.url, x.token);
      await assert.doesNotReject(call('list_pending', {}), 'the same grant still works through the same origin');
      assert.deepEqual(legacyRecordFiles(x.configDir), [`${x.record}.gozar-fence`], 'after adopt the old owner stays fenced, so older code cannot act on the rule');
    } finally { await x.stop(); }
  });
}

test('the old record is fenced before adopt and the fence is lifted again if the move halts before adopt', async () => {
  const x = await legacyInstall();
  try {
    let fencedAtAdopt = null;
    const adoptOriginal = x.gozar.adoptRoute;
    x.gozar.adoptRoute = async request => { fencedAtAdopt = !fs.existsSync(x.record) && fs.existsSync(`${x.record}.gozar-fence`); return adoptOriginal(request); };
    assert.equal((await migrateLegacyRoute(x.kit())).migrated, true);
    assert.equal(fencedAtAdopt, true, 'the old exposure record was moved aside before Gozar adopted the rule');
    const y = await legacyInstall();
    try {
      const halted = await migrateLegacyRoute(y.kit({ consent: async () => false }));
      assert.equal(halted.migrated, false);
      assert.equal(fs.existsSync(y.record), true, 'declined consent leaves the old record in place');
      assert.equal(fs.existsSync(`${y.record}.gozar-fence`), false);
      assert.equal(adopts(y.gozar), 0);
      assert.equal(y.gozar.fake.state.legacy.owner, 'legacy');
      assert.equal(readRouteSetting(y.env), null);
      assert.equal(readJournal(y.env), null);
    } finally { await y.stop(); }
  } finally { await x.stop(); }
});

test('a failed authenticated check hands the route back in two phases; the old owner takes over and nothing is committed', async () => {
  const x = await legacyInstall();
  try {
    const before = x.preserved();
    const result = await migrateLegacyRoute(x.kit({ authenticatedCheck: async () => false }));
    assert.equal(result.migrated, false);
    assert.match(result.reason, /handed back/);
    const types = x.gozar.fake.state.effects.map(e => e.type);
    assert.deepEqual(types.filter(t => t.startsWith('hand-back') || t === 'adopt'), ['adopt', 'hand-back-start', 'hand-back-confirm']);
    assert.equal(x.gozar.fake.state.legacy.owner, 'legacy', 'the previous owner holds the route again');
    assert.equal(fs.existsSync(x.record), true, 'the old record is unfenced');
    assert.equal(readRouteSetting(x.env), null, 'no v2 setting was committed');
    assert.equal(readJournal(x.env), null);
    assert.deepEqual(x.preserved(), before);
  } finally { await x.stop(); }
});

test('an unrecognised or ambiguous old route halts before any fence and leaves everything as found', async () => {
  const x = await legacyInstall();
  try {
    const result = await migrateLegacyRoute(x.kit({ stateFiles: () => [path.join(x.configDir, 'not-a-known-record.json')] }));
    assert.equal(result.migrated, false);
    assert.equal(x.calls.fence, 0, 'nothing was fenced');
    assert.equal(fs.existsSync(x.record), true);
    assert.equal(adopts(x.gozar), 0);
    assert.equal(readRouteSetting(x.env), null);
  } finally { await x.stop(); }
});

test('a real bridge accepts the default port written out on an https origin, and refuses every other port and host', async () => {
  const x = await legacyInstall();
  try {
    const probe = host => rawGet({ port: x.port, host, pathname: `/.well-known/gozar/service?nonce=${'b'.repeat(64)}` });
    assert.equal(await probe(x.host), 200);
    assert.equal(await probe(`${x.host}:443`), 200, 'name:443 is the same authority');
    assert.equal(await probe(`${x.host}:8443`), 421);
    assert.equal(await probe(`evil-${x.host}`), 421);
    assert.equal(await probe(`${x.host}:443x`), 421);
  } finally { await x.stop(); }
});
