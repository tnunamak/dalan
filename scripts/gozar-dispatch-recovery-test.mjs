import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createTestingGozar, fakeRegistry } from '@tnunamak/gozar/testing';
import { approvalFor, buildQuery, pickCandidate } from '../src/gozar-routes.mjs';
import { installService, uninstallService } from '../src/service.mjs';
import { runTry } from '../src/try.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(homedir(), '.tmp', 'dr-'));
  const registry = await fakeRegistry({ id: 'edge-' + randomUUID().slice(0, 8), kinds: ['attached', 'durable', 'session'],
    reach: 'internet', dir: root });
  const harness = await createTestingGozar({ manifest: registry.manifest, root: registry.root, effects: [] });
  let expectedDebt;
  t.after(async () => {
    try {
      if (expectedDebt) {
        assert.deepEqual(harness.events, [], 'the isolated failure started no provider effects');
        await assert.rejects(harness.close(), error => {
          assert.equal(error.code, 'cleanup_debt');
          assert.deepEqual(error.route.handle, expectedDebt);
          return true;
        });
      } else await harness.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  const home = path.join(root, 'g'), bridge = path.join(root, 'd');
  const env = { PATH: process.env.PATH, HOME: root, GOZAR_HOME: home, XDG_CONFIG_HOME: path.join(root, 'c'), XDG_STATE_HOME: path.join(root, 's') };
  const serviceFile = path.join(env.XDG_CONFIG_HOME, 'dalan', 'route-installs', createHash('sha256').update(bridge).digest('hex') + '.json');
  const trialFile = path.join(bridge, '.route-reference.json');
  const gozar = harness.gozar;
  const sentinelQuery = { ...buildQuery({ home, target: '127.0.0.1:14321', usage: { kind: 'durable', routeId: 'neighbor' } }),
    owner: 'neighbor', operationId: randomUUID() };
  const sentinelApproval = approvalFor(pickCandidate(await gozar.catalogRoutes(sentinelQuery)));
  const sentinel = await gozar.ensureRoute({ ...sentinelQuery, approval: sentinelApproval });
  const service = { home: bridge, auto: true, origin: null, port: null, target: null, workers: ['fixture'], autoUpdate: false };
  const seams = { env, gozar, platform: 'linux', waitForSocket: async () => false, spawn: () => ({ status: 0, stdout: '' }) };
  const makeRef = (file, phase = 'prepared') => {
    const ref = { home, operationId: randomUUID(), phase, port: 18789 };
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(ref), { mode: 0o600 });
    return ref;
  };
  const intact = async () => {
    const current = (await gozar.listRoutes({ home, owner: 'neighbor' })).routes.find(view => view.operationId === sentinel.operationId);
    assert.deepEqual(current.handle, sentinel.handle);
    assert.notEqual(current.cleanup.state, 'confirmed');
  };
  return { home, bridge, env, gozar, sentinel, serviceFile, trialFile, service, seams, makeRef, intact,
    expectCleanupDebt(handle) { expectedDebt = handle; } };
}

test('service retry obtains fresh consent and dispatches the prepared operation ID once', async t => {
  const x = await fixture(t);
  const ref = x.makeRef(x.serviceFile);
  assert.deepEqual((await x.gozar.listRoutes({ home: x.home, owner: 'dalan' })).routes, []);
  let reviews = 0;
  await assert.rejects(installService(x.service, { ...x.seams, consent: async () => { reviews++; return true; } }),
    /did not start on its admin socket/);
  assert.equal(reviews, 1);
  const routes = (await x.gozar.listRoutes({ home: x.home, owner: 'dalan' })).routes;
  assert.equal(routes.length, 1);
  assert.equal(routes[0].operationId, ref.operationId);
  await x.intact();
});

test('uninstall can cancel a prepared operation without closing a route and refuses uncertain absence', async t => {
  const x = await fixture(t);
  const ref = x.makeRef(x.serviceFile);
  await assert.rejects(uninstallService({ home: x.bridge, confirmRouteStop: async () => false }, x.seams), /approval/);
  assert.equal(existsSync(x.serviceFile), true);
  const removed = await uninstallService({ home: x.bridge, confirmRouteStop: async subject => {
    assert.equal(subject.operationId, ref.operationId);
    return true;
  } }, x.seams);
  assert.equal(removed.moved_to, null);
  assert.equal(existsSync(x.serviceFile), false);
  const uncertain = x.makeRef(x.serviceFile, 'dispatching');
  await assert.rejects(uninstallService({ home: x.bridge, confirmRouteStop: async () => assert.fail('no exact stop subject') }, x.seams), /unconfirmed|identify/);
  assert.equal(JSON.parse(readFileSync(x.serviceFile)).operationId, uncertain.operationId);
  assert.deepEqual((await x.gozar.listRoutes({ home: x.home, owner: 'dalan' })).routes, []);
  await x.intact();
});

test('hosted retry after the saved pre-dispatch boundary reaches fresh consent and keeps the operation when declined', async t => {
  const x = await fixture(t);
  const ref = x.makeRef(x.trialFile);
  writeFileSync(path.join(x.bridge, '.dalan-trial'), 'created by dalan try\n');
  const input = new PassThrough();
  const errorContext = {};
  let asked = 0;
  await assert.rejects(runTry({ argv: ['--public', '--home', x.bridge], env: x.env, input, out: { write(text) {
    if (text.includes('Use this route?')) { asked++; setImmediate(() => input.write('no\n')); }
  } }, errorContext, hosted: { gozar: x.gozar, interactive: true, pickPort: async () => ref.port } }),
  error => error.tryKind === 'consent');
  assert.equal(asked, 1);
  assert.equal(JSON.parse(readFileSync(x.trialFile)).operationId, ref.operationId);
  assert.ok(errorContext.freshTrialCommand.includes(x.bridge));
  await x.intact();
});

test('a real pre-reservation SDK consent refusal keeps the same prepared ID for cancellation', async t => {
  const x = await fixture(t);
  const ensureRoute = x.gozar.ensureRoute;
  let offered;
  x.gozar.ensureRoute = async request => {
    if (!request.approval) return ensureRoute(request);
    offered = request.operationId;
    const saved = JSON.parse(readFileSync(x.serviceFile));
    assert.equal(saved.phase, 'dispatching');
    assert.equal(saved.operationId, offered);
    return ensureRoute({ ...request, approval: { ...request.approval, candidateToken: 'unissued-fixture-token' } });
  };
  await assert.rejects(installService(x.service, { ...x.seams, consent: async () => true }), { code: 'consent_required' });
  assert.ok(offered);
  const saved = JSON.parse(readFileSync(x.serviceFile));
  assert.equal(saved.phase, 'prepared');
  assert.equal(saved.operationId, offered);
  assert.deepEqual((await x.gozar.listRoutes({ home: x.home, owner: 'dalan' })).routes, []);
  await uninstallService({ home: x.bridge, confirmRouteStop: async subject => {
    assert.equal(subject.operationId, offered);
    return true;
  } }, x.seams);
  await x.intact();
});

test('a consent refusal with a public SDK recovery view retains its exact handle', async t => {
  const x = await fixture(t);
  const ensureRoute = x.gozar.ensureRoute;
  let providerId;
  x.gozar.ensureRoute = request => ensureRoute(request.approval
    ? { ...request, providerId, approval: { ...request.approval, candidateToken: 'unissued-fixture-token' } }
    : request);
  let refused;
  await assert.rejects(installService(x.service, { ...x.seams, consent: async candidate => {
    providerId = candidate.providerId;
    return true;
  } }), error => {
    refused = error;
    return error.code === 'consent_unknown' && !!error.route?.handle;
  });
  const saved = JSON.parse(readFileSync(x.serviceFile));
  assert.equal(saved.phase, undefined);
  assert.equal(saved.operationId, refused.route.operationId);
  assert.deepEqual(saved.handle, refused.route.handle);
  x.expectCleanupDebt(saved.handle);
  await x.intact();
});

test('a legacy dispatch marker with no observed route reuses its ID only after fresh consent', async t => {
  const x = await fixture(t);
  const ref = x.makeRef(x.serviceFile, undefined);
  delete ref.phase;
  writeFileSync(x.serviceFile, JSON.stringify(ref));
  await assert.rejects(installService(x.service, { ...x.seams, consent: async () => false }), { code: 'consent_required' });
  assert.deepEqual(JSON.parse(readFileSync(x.serviceFile)), ref);
  await assert.rejects(installService(x.service, { ...x.seams, consent: async () => true }), /did not start on its admin socket/);
  const routes = (await x.gozar.listRoutes({ home: x.home, owner: 'dalan' })).routes;
  assert.deepEqual(routes.map(view => view.operationId), [ref.operationId]);
  await x.intact();
});

test('a failed observation leaves dispatch uncertain and never asks for new authority', async t => {
  const x = await fixture(t);
  const ref = x.makeRef(x.serviceFile, 'dispatching');
  const listRoutes = x.gozar.listRoutes;
  x.gozar.listRoutes = request => request.owner === 'dalan'
    ? Promise.reject(Object.assign(new Error('temporary read failure'), { code: 'provider_unavailable' }))
    : listRoutes(request);
  const refuseReview = async () => assert.fail('no prompt is authorized after a failed observation');
  await assert.rejects(installService(x.service, { ...x.seams, consent: refuseReview }), { code: 'provider_unavailable' });
  await assert.rejects(uninstallService({ home: x.bridge, confirmRouteStop: refuseReview }, x.seams), { code: 'provider_unavailable' });
  assert.deepEqual(JSON.parse(readFileSync(x.serviceFile)), ref);
  await x.intact();
});

test('uninstall cannot cancel a prepared reference while an install holds it for consent', async t => {
  const x = await fixture(t);
  const ref = x.makeRef(x.serviceFile);
  let showReview, answerReview;
  const review = new Promise(resolve => { showReview = resolve; });
  const answer = new Promise(resolve => { answerReview = resolve; });
  const install = installService(x.service, { ...x.seams, consent: async () => { showReview(); return answer; } });
  try {
    await Promise.race([review, install]);
    await assert.rejects(uninstallService({ home: x.bridge, confirmRouteStop: async () => assert.fail('competing cancellation') }, x.seams), /already running/);
    assert.deepEqual(JSON.parse(readFileSync(x.serviceFile)), ref);
  } finally {
    answerReview(false);
    await assert.rejects(install, { code: 'consent_required' });
  }
  await x.intact();
});

test('an unreadable retained handle cannot authorize replay or removal', async t => {
  const x = await fixture(t);
  const ref = x.makeRef(x.serviceFile, 'dispatching');
  delete ref.phase;
  ref.handle = { kind: 'durable', id: 'dalan-main', generation: 1 };
  writeFileSync(x.serviceFile, JSON.stringify(ref));
  const noAuthority = async () => assert.fail('an empty read cannot override a retained handle');
  await assert.rejects(installService(x.service, { ...x.seams, consent: noAuthority }), { code: 'route_not_found' });
  await assert.rejects(uninstallService({ home: x.bridge, confirmRouteStop: noAuthority }, x.seams), { code: 'route_not_found' });
  assert.deepEqual(JSON.parse(readFileSync(x.serviceFile)), ref);
  await x.intact();
});
