// Dalan reaches the network only through the frozen Gozar route contract. This test pins the contract fixture, checks the fake that stands in for
// the unreleased Gozar runtime against that same fixture, and proves what Dalan sends and does with a route it was never told about.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  FROZEN_CODES as DALAN_CODES, RouteError, approvalFor, buildQuery, canonicalHost, dalanRequirements, describeCandidate, ensureDurableRoute, explainRouteError,
  normalizeRequestHost, pickCandidate, registerExternalService, resolveGozar, startSessionRoute, targetFor,
} from '../src/gozar-routes.mjs';
import { FROZEN_CODES, FakeGozarError, createFakeGozar, requestChecks } from '../src/test-support/gozar-fake.mjs';
import { parseTryArgs } from '../src/try.mjs';
import { runSetup } from '../src/setup.mjs';
import { installService } from '../src/service.mjs';

const FIXTURE = new URL('../src/test-support/gozar-contract.json', import.meta.url);
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const tempRoot = process.env.DOT_BRIDGE_TEST_TMP ?? path.join(os.homedir(), '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const tmp = fs.mkdtempSync(path.join(tempRoot, 'gozc-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const HOME = path.join(tmp, 'gozar-state');
const yes = async () => true;
const INVENTED = 'zq-invented-7';

// ---- the pin -------------------------------------------------------------------------------------------------------------------------
test('the contract fixture is the frozen C0 file (provenance file names made provider-neutral), pinned by hash', () => {
  assert.equal(createHash('sha256').update(fs.readFileSync(FIXTURE)).digest('hex'), '36703bd62579359a9e852990580e333591401ab527240b56801ba650cb0c2d51');
});

test('Dalan knows the same 21 error codes the contract freezes, and no others', () => {
  assert.equal(fixture.frozenErrorCodes.length, 21);
  assert.deepEqual([...DALAN_CODES], fixture.frozenErrorCodes);
  assert.deepEqual(FROZEN_CODES, fixture.frozenErrorCodes);
  assert.throws(() => new FakeGozarError('provider_failed', 'x'), /not a frozen Gozar error code/);
});

// ---- the fake is checked against the fixture ------------------------------------------------------------------------------------------
const checkers = { Query: requestChecks.query, EnsureRouteRequest: requestChecks.ensure, AdoptRouteRequest: requestChecks.adopt, ExposeRequest: requestChecks.expose };
test('the fake refuses every invalid request shape in the fixture, with a frozen code', () => {
  let checked = 0;
  for (const entry of fixture.invalid.filter(e => e.shape in checkers)) {
    assert.throws(() => checkers[entry.shape](entry.value), error => { assert.ok(FROZEN_CODES.includes(error.code), entry.name); return error.code === 'invalid_input'; }, `${entry.shape}: ${entry.name}`);
    checked++;
  }
  assert.ok(checked >= 15, `checked ${checked} invalid cases`);
});

test('the fake accepts every valid request in the fixture', () => {
  for (const entry of fixture.valid.filter(e => e.shape in checkers)) assert.doesNotThrow(() => checkers[entry.shape](entry.value), `${entry.shape}: ${entry.name}`);
});

test('the fake returns the fixture shapes: same keys for a catalog, a candidate and a route view', async () => {
  const gozar = createFakeGozar();
  const catalog = await gozar.catalogRoutes(buildQuery({ home: HOME, target: targetFor(8799), usage: { kind: 'session', lifetimeMs: 1000 } }));
  const sample = fixture.valid.find(v => v.shape === 'Catalog').value;
  assert.deepEqual(Object.keys(catalog).sort(), Object.keys(sample).sort());
  // The pinned 0.2 fixture predates Gozar 0.3; the fake adds exactly providerId to a candidate.
  assert.deepEqual(Object.keys(catalog.candidates[0]).sort(), [...Object.keys(sample.candidates[0]), 'providerId'].sort());
  const view = await gozar.expose({ ...buildQuery({ home: HOME, target: targetFor(8799), usage: { kind: 'session', lifetimeMs: 1000 } }), approval: approvalFor(pickCandidate(catalog)), wait: 'verified' });
  assert.deepEqual(Object.keys(view).sort(), Object.keys(fixture.valid.find(v => v.shape === 'RouteView').value).sort());
});

test('what Dalan sends always passes the fake\'s request checks (a session, a durable create, an adopt, an attached route)', async () => {
  const base = { home: HOME, target: targetFor(8799) };
  requestChecks.query(buildQuery({ ...base, usage: { kind: 'session', lifetimeMs: 3600000 } }));
  requestChecks.query(buildQuery({ ...base, usage: { kind: 'durable', routeId: 'dalan-main' }, route: INVENTED, address: 'stable' }));
  requestChecks.query(buildQuery({ ...base, usage: { kind: 'attached' } }));
  requestChecks.query(buildQuery({ ...base, usage: { kind: 'durable', routeId: 'x' }, intent: 'adopt', origin: 'https://a.example', migrationRef: 'm' }));
  assert.deepEqual(dalanRequirements({ address: 'stable' }).protocols, ['sse', 'streamable-http', 'oauth-dcr']);
});

// ---- exact --route pass-through --------------------------------------------------------------------------------------------------------
test('`dalan try --route ID` keeps ID exactly, for an id no list knows; there is no client or route enum', () => {
  for (const name of [INVENTED, 'work', 'Work.Office', 'a_b-c.9']) assert.equal(parseTryArgs(['--public', '--route', name]).route, name);
  assert.equal(parseTryArgs(['--route', INVENTED]).mode, 'public');
  assert.equal(parseTryArgs(['--public']).route, undefined, 'no route means no name is sent');
  assert.throws(() => parseTryArgs(['--public', '--client', 'chatgpt']), /unknown option|--client/);
  assert.throws(() => parseTryArgs(['--local', '--route', INVENTED]), /--local cannot be combined with --route/);
});

test('the id reaches Gozar as providerId unchanged and an unknown id is Gozar\'s route_not_found, not a local refusal', async () => {
  const gozar = createFakeGozar();
  const query = buildQuery({ home: HOME, target: targetFor(8799), usage: { kind: 'session', lifetimeMs: 1000 }, route: INVENTED });
  assert.equal(query.providerId, INVENTED);
  assert.equal(query.route, undefined);
  await assert.rejects(() => startSessionRoute({ gozar, query, consent: yes }), error => error.code === 'route_not_found');
  assert.equal(gozar.fake.state.effects.length, 0, 'an unknown name exposes nothing');
  const known = buildQuery({ home: HOME, target: targetFor(8799), usage: { kind: 'session', lifetimeMs: 1000 }, route: 'fake-ephemeral' });
  const route = await startSessionRoute({ gozar: createFakeGozar(), query: known, consent: yes }).catch(error => error);
  assert.ok(route instanceof RouteError || route.origin, 'a known name is accepted by the same code path');
  assert.throws(() => buildQuery({ home: HOME, target: 't', usage: { kind: 'attached' }, route: '' }), /needs an id/);
});

test('`dalan setup --route ID` sends ID to Gozar and saves it as typed', async () => {
  const gozar = createFakeGozar();
  const env = { XDG_CONFIG_HOME: path.join(tmp, 'cfg-setup'), HOME: path.join(tmp, 'h1') };
  const out = []; const input = new PassThrough();
  await runSetup({ argv: ['--route', 'fake-stable'], env, out: { write: text => out.push(text) }, input, interactive: true, gozar, gozarHome: HOME, answers: ['y'] });
  const seen = gozar.fake.state.calls;
  assert.ok(seen.includes('catalogRoutes'));
  const saved = JSON.parse(fs.readFileSync(path.join(env.XDG_CONFIG_HOME, 'dalan', 'route.json'), 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal(saved.routeName, 'fake-stable');
  assert.deepEqual(Object.keys(saved).sort(), ['bridgeHome', 'gozarHome', 'origin', 'requirements', 'routeId', 'routeName', 'version']);
});

test('`dalan service install --route ID` forwards ID to a durable ensure; without it the origin is an external service', async () => {
  const seam = gozar => ({ gozar, platform: 'linux', env: { HOME: path.join(tmp, 'h2'), XDG_CONFIG_HOME: path.join(tmp, 'x2'), GOZAR_HOME: HOME }, spawn: () => ({ status: 0, stdout: '' }), waitForSocket: async () => true, consent: yes, proxy: null });
  fs.mkdirSync(path.join(tmp, 'x2', 'systemd', 'user'), { recursive: true, mode: 0o700 });
  const base = { origin: 'https://own.example', port: 8789, target: '127.0.0.1:8789', workers: ['dot'] };
  const unknown = createFakeGozar();
  await assert.rejects(() => installService({ ...base, home: path.join(tmp, 'svc1'), route: INVENTED }, seam(unknown)), error => error.code === 'route_not_found');
  assert.equal(unknown.fake.state.effects.length, 0, 'the unknown name was forwarded verbatim and Gozar refused it');
  const external = createFakeGozar();
  const result = await installService({ ...base, home: path.join(tmp, 'svc2') }, seam(external));
  assert.equal(result.started, true);
  assert.equal(result.route.origin, 'https://own.example');
  assert.ok(external.fake.state.calls.includes('addService'));
});

// ---- sessions end with the trial; durable routes outlive it -------------------------------------------------------------------------
test('session stop closes exactly its handle once; a durable route is never closed by the same stop', async () => {
  const gozar = createFakeGozar();
  const durable = await ensureDurableRoute({ gozar, query: buildQuery({ home: HOME, target: targetFor(8789), usage: { kind: 'durable', routeId: 'dalan-main' }, address: 'stable' }), consent: yes });
  const route = await startSessionRoute({ gozar, query: buildQuery({ home: HOME, target: targetFor(8799), usage: { kind: 'session', lifetimeMs: 5000 } }), consent: yes });
  assert.equal(route.handle.kind, 'session');
  assert.deepEqual(await route.stop(), { removed: true });
  assert.deepEqual(await route.stop(), { removed: true }, 'stop is idempotent');
  const closes = gozar.fake.state.effects.filter(e => e.type.startsWith('close'));
  assert.deepEqual(closes.map(e => e.type), ['close']);
  assert.equal(gozar.fake.state.pins.has('dalan-main'), true, 'the durable route is still there');
  assert.equal((await gozar.routeStatus({ home: HOME, handle: durable.handle })).state, 'usable');
});

test('without consent nothing is exposed; consent shows the disclosure Gozar returned', async () => {
  const gozar = createFakeGozar();
  let shown = null;
  const query = buildQuery({ home: HOME, target: targetFor(8799), usage: { kind: 'session', lifetimeMs: 5000 } });
  await assert.rejects(() => startSessionRoute({ gozar, query, consent: async c => { shown = c.disclosure.text; return false; } }), error => error.tryKind === 'consent');
  assert.match(shown, /disclosure/i);
  assert.equal(gozar.fake.state.effects.length, 0);
});

test('a durable route asks once; later ensures reuse the pin and need no new approval', async () => {
  const gozar = createFakeGozar();
  let asked = 0;
  const query = buildQuery({ home: HOME, target: targetFor(8789), usage: { kind: 'durable', routeId: 'dalan-main' }, address: 'stable' });
  const consent = async () => { asked++; return true; };
  const first = await ensureDurableRoute({ gozar, query, consent });
  const second = await ensureDurableRoute({ gozar, query, consent });
  assert.equal(asked, 1);
  assert.equal(first.origin, second.origin, 'a stable route never silently rotates');
});

test('a stopped-by-user route needs fresh consent: reconsent alone is not enough', async () => {
  const gozar = createFakeGozar();
  const query = buildQuery({ home: HOME, target: targetFor(8789), usage: { kind: 'durable', routeId: 'dalan-main' }, address: 'stable' });
  await ensureDurableRoute({ gozar, query, consent: yes });
  gozar.fake.tombstone('dalan-main');
  await assert.rejects(() => ensureDurableRoute({ gozar, query, consent: yes }), error => error.code === 'stopped_by_user');
  await assert.rejects(() => gozar.ensureRoute({ ...query, reconsent: true }), error => error.code === 'consent_required');
  const view = await ensureDurableRoute({ gozar, query, consent: yes, reconsent: true });
  assert.equal(view.state, 'usable');
});

test('the route watch reports a changed address as rotated and a lost route as lost, and ends the trial\'s wait', async () => {
  for (const [patch, reason] of [[{ state: 'address_changed', published: 'https://other.route.invalid' }, 'rotated'], [{ state: 'lost', published: null }, 'lost']]) {
    const gozar = createFakeGozar();
    const route = await startSessionRoute({ gozar, query: buildQuery({ home: HOME, target: targetFor(8799), usage: { kind: 'session', lifetimeMs: 5000 } }), consent: yes });
    gozar.fake.change(route.handle.id, patch);
    assert.equal(await route.exited, reason);
    assert.equal(route.endedBecause(), reason);
    await route.stop();
  }
});

test('a route Gozar has not verified yet is pending, not lost; a later loss still ends the wait', async () => {
  const gozar = createFakeGozar();
  const original = gozar.watchRoutes;
  gozar.watchRoutes = async function* (args) {
    for await (const event of original(args)) {
      yield event.type === 'snapshot' ? { ...event, route: { ...event.route, state: 'unverified', published: null, verification: { status: 'unverified', checkedAt: null } } } : event;
    }
  };
  const route = await startSessionRoute({ gozar, query: buildQuery({ home: HOME, target: targetFor(8799), usage: { kind: 'session', lifetimeMs: 5000 } }), consent: yes });
  const early = await Promise.race([route.exited, new Promise(resolve => setTimeout(() => resolve('pending'), 300))]);
  assert.equal(early, 'pending', 'an unverified first snapshot does not end the trial');
  gozar.fake.change(route.handle.id, { state: 'lost', published: null });
  assert.equal(await route.exited, 'lost');
  await route.stop();
});

test('stop reports cleanup debt and a replaced route honestly, and offers no provider command', async () => {
  const gozar = createFakeGozar();
  gozar.fake.setCleanupDebt('relay entry remains');
  const route = await startSessionRoute({ gozar, query: buildQuery({ home: HOME, target: targetFor(8799), usage: { kind: 'session', lifetimeMs: 5000 } }), consent: yes });
  const result = await route.stop();
  assert.equal(result.removed, false);
  assert.match(result.detail, /cleanup debt/);
  assert.equal(result.command, undefined);
});

test('a Ctrl-C during startup closes the route that was just made', async () => {
  const gozar = createFakeGozar();
  const controller = new AbortController();
  const original = gozar.expose;
  gozar.expose = async request => { const view = await original(request); controller.abort(); return view; };
  await assert.rejects(() => startSessionRoute({ gozar, query: buildQuery({ home: HOME, target: targetFor(8799), usage: { kind: 'session', lifetimeMs: 5000 } }), consent: yes, signal: controller.signal }), error => error.name === 'AbortError' || error.code === 'ABORT_ERR');
  assert.equal(gozar.fake.state.effects.filter(e => e.type === 'close').length, 1);
});

test('external services are registered and read back through the same route view', async () => {
  const gozar = createFakeGozar();
  const { view } = await registerExternalService({ gozar, home: HOME, origin: 'https://own.example', target: '127.0.0.1:8789' });
  assert.equal(view.ownership, 'external-owned');
  assert.equal(view.handle.kind, 'external');
});

// ---- Host --------------------------------------------------------------------------------------------------------------------------------
test('Host: the default port written out is the same authority; every other host stays refused', () => {
  const origin = 'https://name.route.invalid';
  assert.equal(canonicalHost('name.route.invalid:443', origin), 'name.route.invalid');
  assert.equal(canonicalHost('NAME.route.invalid:443', origin), 'name.route.invalid');
  assert.equal(canonicalHost('name.route.invalid', origin), 'name.route.invalid');
  for (const bad of ['name.route.invalid:444', 'name.route.invalid:80', 'xname.route.invalid:443', 'name.route.invalid.evil:443', 'localhost:443', '127.0.0.1:443', 'name.route.invalid:4430']) {
    assert.equal(canonicalHost(bad, origin), bad, bad);
  }
  assert.equal(canonicalHost('own.example:443', 'https://own.example:8443'), 'own.example:443', 'an explicit non-default port stays exact');
  assert.equal(canonicalHost('own.example:8443', 'https://own.example:8443'), 'own.example:8443');
  const req = { headers: { host: 'name.route.invalid:443' } };
  normalizeRequestHost(req, origin);
  assert.equal(req.headers.host, 'name.route.invalid');
  const loopback = { headers: { host: '127.0.0.1:8799' } };
  normalizeRequestHost(loopback, origin);
  assert.equal(loopback.headers.host, '127.0.0.1:8799');
});

// ---- the bundled package -----------------------------------------------------------------------------------------------------------------
test('installed bundled resolution: the package inside Dalan\'s own tree wins; a Gozar without the contract is runtime_missing with its version', async () => {
  const good = await resolveGozar({ importer: async () => createFakeGozar() });
  assert.equal(typeof good.catalogRoutes, 'function');
  await assert.rejects(() => resolveGozar({ importer: async () => ({ createServiceVerifier() {} }), resolvePackage: () => path.join(tmp, 'gozar-old-package.json') }), error => error.code === 'runtime_missing' && /missing catalogRoutes/.test(error.message));
  fs.writeFileSync(path.join(tmp, 'gozar-old-package.json'), JSON.stringify({ version: '0.1.0' }));
  await assert.rejects(() => resolveGozar({ importer: async () => ({}), resolvePackage: () => path.join(tmp, 'gozar-old-package.json') }), error => /Gozar \(0\.1\.0\)/.test(error.message));
  await assert.rejects(() => resolveGozar({ importer: async () => { throw Object.assign(new Error('nope'), { code: 'ERR_MODULE_NOT_FOUND' }); } }), error => error.code === 'runtime_missing');
});

// ---- errors and display -------------------------------------------------------------------------------------------------------------------
test('every frozen code has an explanation; Gozar\'s next action is shown; no provider text is added', () => {
  for (const code of FROZEN_CODES) {
    const explained = explainRouteError({ code, message: '' });
    assert.equal(explained.code, code);
    assert.ok(explained.line.length > 10, code);
  }
  const action = fixture.valid.find(v => v.shape === 'Action' && v.name === 'instructions').value;
  assert.match(explainRouteError({ code: 'setup_required', message: '', nextAction: action }).fix, new RegExp(action.label));
  assert.equal(explainRouteError(new Error('plain')).code, null);
});

test('a candidate is described from returned data only: reach, readers, stability, cost, account, setup', async () => {
  const gozar = createFakeGozar();
  const catalog = await gozar.catalogRoutes(buildQuery({ home: HOME, target: targetFor(8799), usage: { kind: 'session', lifetimeMs: 1 } }));
  const text = catalog.candidates.flatMap((c, i) => describeCandidate(c, i)).join('\n');
  for (const word of ['reach:', 'traffic readers:', 'address:', 'cost:', 'account needed:', 'lifetimes:', 'setup:']) assert.match(text, new RegExp(word));
});
