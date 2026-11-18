import assert from 'node:assert/strict';
import fs from 'node:fs';
import { defaultPath } from '../src/paths.mjs';
import { fork } from 'node:child_process';
import { deliveryFixture } from './gozar-admission-recovery-worker.mjs';
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

// These cases deliberately use a contract fake. Counts below are facade deliveries,
// not physical provider allocations, and do not qualify any never-started code.
test('service delivery interruption preserves dispatch uncertainty and recovers the same operation', { timeout: 20000 }, async t => {
  const root = await mkdtemp(path.join(homedir(), '.tmp', 'delivery-'));
  let child;
  let exited;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (exited) await exited;
    await rm(root, { recursive: true, force: true });
  });
  child = fork(new URL('./gozar-admission-recovery-worker.mjs', import.meta.url), [root],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  exited = new Promise(resolve => child.once('exit', resolve));
  const held = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('service delivery barrier not reached')), 10000);
    const finish = (error, value) => {
      clearTimeout(timer);
      child.off('message', message);
      child.off('exit', earlyExit);
      child.off('error', failed);
      if (error) reject(error); else resolve(value);
    };
    const message = value => value.type === 'service-delivery-held'
      ? finish(null, value) : finish(new Error('worker did not reach held delivery: ' + JSON.stringify(value)));
    const earlyExit = () => finish(new Error('worker exited before service delivery barrier'));
    const failed = error => finish(error);
    child.on('message', message);
    child.once('exit', earlyExit);
    child.once('error', failed);
  });
  const x = deliveryFixture(root);
  const before = readFileSync(x.pointer, 'utf8');
  assert.equal(held.pointer.phase, 'dispatching');
  assert.equal(held.pointer.handle, undefined);
  assert.equal(x.read().requests.length, 1);
  await assert.rejects(installService(x.service, x.seams), /already running/);
  await assert.rejects(uninstallService({ home: x.bridge, confirmRouteStop: async () => assert.fail('held install owns lock') },
    x.seams), /already running/);
  assert.equal(readFileSync(x.pointer, 'utf8'), before);
  child.kill('SIGKILL');
  await exited;

  const empty = deliveryFixture(root, { observation: 'empty' });
  await assert.rejects(uninstallService({ home: x.bridge, confirmRouteStop: async () => assert.fail('absence is not a stop subject') },
    empty.seams), /unconfirmed|identify/);
  assert.equal(readFileSync(x.pointer, 'utf8'), before);
  const duplicate = deliveryFixture(root, { observation: 'duplicate' });
  await assert.rejects(installService(x.service, duplicate.seams), { code: 'route_conflict' });
  await assert.rejects(uninstallService({ home: x.bridge, confirmRouteStop: async () => assert.fail('ambiguous stop') },
    duplicate.seams), { code: 'route_conflict' });
  assert.equal(readFileSync(x.pointer, 'utf8'), before);

  // An unavailable observation forces same-ID replay; returning an error with
  // the facade's previously returned view must persist that exact handle.
  const retry = deliveryFixture(root, { observation: 'empty', errorAfterReturn: true });
  await assert.rejects(installService(x.service, retry.seams), { code: 'provider_unavailable' });
  const saved = JSON.parse(readFileSync(x.pointer, 'utf8'));
  assert.equal(saved.operationId, held.returned.operationId);
  assert.deepEqual(saved.handle, held.returned.handle);
  assert.equal(saved.phase, undefined);
  assert.deepEqual(x.read().requests, [saved.operationId, saved.operationId]);
  await assert.rejects(uninstallService({ home: x.bridge, confirmRouteStop: async subject => {
    assert.deepEqual(subject, held.returned.handle); return false;
  } }, x.seams), /approval/);
  assert.deepEqual(JSON.parse(readFileSync(x.pointer, 'utf8')), saved);
  assert.deepEqual(x.read().closes, []);
  await uninstallService({ home: x.bridge, confirmRouteStop: async subject => {
    assert.deepEqual(subject, held.returned.handle); return true;
  } }, x.seams);
  assert.equal(existsSync(x.pointer), false);
  assert.deepEqual(x.read().closes, [held.returned.handle]);
  assert.deepEqual(x.read().sentinel, { owner: 'neighbor', id: 'foreign-do-not-close' });
  t.diagnostic('Contract-fake service delivery interruption only: two facade calls, no physical-allocation claim. Hosted old-trial cleanup excluded; all five installed never-started mappings remain unqualified.');
});

test('service facade delivery release remembers the returned handle before service readiness', { timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(homedir(), '.tmp', 'delivery-return-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const barrier = new Promise(resolve => { reached = resolve; });
  const x = deliveryFixture(root, { hold: async view => { reached(view); await gate; } });
  // Attach rejection handling immediately; a pre-barrier failure must not hang.
  const run = installService(x.service, x.seams).then(
    () => ({ ok: true }), error => ({ error }));
  let timer;
  try {
    const view = await Promise.race([barrier, run.then(result => {
      throw result.error ?? new Error('install finished before delivery barrier');
    }), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('delivery barrier timed out')), 5000);
    })]);
    clearTimeout(timer);
    const pending = JSON.parse(readFileSync(x.pointer, 'utf8'));
    assert.equal(pending.phase, 'dispatching');
    assert.equal(pending.operationId, view.operationId);
    assert.equal(pending.handle, undefined);
    await assert.rejects(installService(x.service, x.seams), /already running/);
    release();
    const result = await run;
    assert.match(result.error?.message ?? '', /did not start on its admin socket/);
    const saved = JSON.parse(readFileSync(x.pointer, 'utf8'));
    assert.deepEqual(saved.handle, view.handle);
    assert.equal(saved.operationId, view.operationId);
    assert.equal(saved.phase, undefined);
    assert.deepEqual(x.read().requests, [view.operationId]);
    await assert.rejects(uninstallService({ home: x.bridge, confirmRouteStop: async () => false }, x.seams), /approval/);
    assert.deepEqual(x.read().closes, []);
    await uninstallService({ home: x.bridge, confirmRouteStop: async handle => {
      assert.deepEqual(handle, view.handle); return true;
    } }, x.seams);
    assert.deepEqual(x.read().closes, [view.handle]);
    assert.deepEqual(x.read().sentinel, { owner: 'neighbor', id: 'foreign-do-not-close' });
  } finally {
    clearTimeout(timer);
    release();
    await run;
  }
});

async function interruptedDelivery(t) {
  const root = await mkdtemp(path.join(homedir(), '.tmp', 'delivery-observed-'));
  let child, exited;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (exited) await exited;
    await rm(root, { recursive: true, force: true });
  });
  child = fork(new URL('./gozar-admission-recovery-worker.mjs', import.meta.url), [root],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  exited = new Promise(resolve => child.once('exit', resolve));
  const held = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('observed recovery barrier timed out')), 10000);
    const finish = (error, value) => {
      clearTimeout(timer);
      child.off('message', message); child.off('exit', earlyExit); child.off('error', failed);
      if (error) reject(error); else resolve(value);
    };
    const message = value => value.type === 'service-delivery-held'
      ? finish(null, value) : finish(new Error('unexpected worker message: ' + JSON.stringify(value)));
    const earlyExit = () => finish(new Error('worker exited before delivery barrier'));
    const failed = error => finish(error);
    child.on('message', message); child.once('exit', earlyExit); child.once('error', failed);
  });
  const x = deliveryFixture(root);
  assert.equal(held.pointer.phase, 'dispatching');
  assert.equal(held.pointer.handle, undefined);
  assert.equal(held.pointer.operationId, held.returned.operationId);
  assert.deepEqual(x.read().requests, [held.returned.operationId]);
  child.kill('SIGKILL');
  await exited;
  return { x, held };
}

test('normal observed recovery remembers the handle before readiness and retires its pointer on approved uninstall',
  { timeout: 20000 }, async t => {
  const { x, held } = await interruptedDelivery(t);
  const receiptFile = defaultPath(x.bridge, '.config/dot-bridge', 'service-install.json');
  let readiness = 0;
  await assert.rejects(installService(x.service, { ...x.seams, waitForSocket: async () => {
    readiness++;
    const pending = JSON.parse(readFileSync(x.pointer, 'utf8'));
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
    assert.equal(pending.operationId, held.returned.operationId);
    assert.deepEqual(pending.handle, held.returned.handle);
    assert.equal(pending.phase, undefined);
    assert.deepEqual(receipt.route_handle, pending.handle);
    return false;
  } }), /did not start on its admin socket/);
  assert.equal(readiness, 1);
  const pointer = readFileSync(x.pointer, 'utf8'), receipt = readFileSync(receiptFile, 'utf8');
  assert.deepEqual(x.read().requests, [held.returned.operationId], 'observation does not redispatch');
  await assert.rejects(uninstallService({ home: x.bridge, confirmRouteStop: async handle => {
    assert.deepEqual(handle, held.returned.handle); return false;
  } }, x.seams), /approval/);
  assert.equal(readFileSync(x.pointer, 'utf8'), pointer);
  assert.equal(readFileSync(receiptFile, 'utf8'), receipt);
  assert.deepEqual(x.read().closes, []);
  await uninstallService({ home: x.bridge, confirmRouteStop: async handle => {
    assert.deepEqual(handle, held.returned.handle); return true;
  } }, x.seams);
  assert.equal(existsSync(x.pointer), false);
  assert.deepEqual(x.read().closes, [held.returned.handle]);
  assert.deepEqual(x.read().sentinel, { owner: 'neighbor', id: 'foreign-do-not-close' });
  let consent = 0;
  const fresh = deliveryFixture(x.root);
  await assert.rejects(installService(fresh.service, { ...fresh.seams, consent: async () => {
    consent++; return false;
  } }), { code: 'consent_required' });
  assert.equal(consent, 1, 'fresh install reaches new consent, not the retired operation');
  assert.deepEqual(x.read().requests, [held.returned.operationId]);
  assert.deepEqual(x.read().closes, [held.returned.handle]);
});

test('observed recovery write failure retains uncertainty and stops before service effects',
  { timeout: 20000 }, async t => {
  const { x, held } = await interruptedDelivery(t);
  const before = readFileSync(x.pointer, 'utf8');
  const originalOpen = fs.openSync;
  const failure = Object.assign(new Error('fixture pending atomic open failed'), { code: 'EIO' });
  let writes = 0, starts = 0, readiness = 0;
  const seams = { ...x.seams,
    spawn: (command, args) => {
      if (!args.includes('show-environment')) starts++;
      return { status: 0, stdout: '' };
    },
    waitForSocket: async () => { readiness++; return false; },
  };
  const mock = t.mock.method(fs, 'openSync', function(file, flags, ...args) {
    if (typeof file === 'string' && file.startsWith(x.pointer + '.') &&
        file.endsWith('.tmp') && flags === 'wx') {
      writes++; throw failure;
    }
    return originalOpen.call(fs, file, flags, ...args);
  });
  try {
    await assert.rejects(installService(x.service, seams), error => error === failure);
  } finally { mock.mock.restore(); }
  assert.equal(writes, 1);
  assert.equal(starts, 0);
  assert.equal(readiness, 0);
  assert.equal(existsSync(defaultPath(x.bridge, '.config/dot-bridge', 'service-install.json')), false);
  assert.equal(readFileSync(x.pointer, 'utf8'), before);
  assert.deepEqual(x.read().requests, [held.returned.operationId]);
  assert.deepEqual(x.read().closes, []);
  assert.deepEqual(x.read().sentinel, { owner: 'neighbor', id: 'foreign-do-not-close' });
  await assert.rejects(installService(x.service, x.seams), /did not start on its admin socket/);
  const saved = JSON.parse(readFileSync(x.pointer, 'utf8'));
  assert.equal(saved.operationId, held.returned.operationId);
  assert.deepEqual(saved.handle, held.returned.handle);
  assert.deepEqual(x.read().requests, [held.returned.operationId]);
  await uninstallService({ home: x.bridge, confirmRouteStop: async handle => {
    assert.deepEqual(handle, held.returned.handle); return true;
  } }, x.seams);
  assert.equal(existsSync(x.pointer), false);
  assert.deepEqual(x.read().closes, [held.returned.handle]);
  assert.deepEqual(x.read().sentinel, { owner: 'neighbor', id: 'foreign-do-not-close' });
});
