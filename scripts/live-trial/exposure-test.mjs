#!/usr/bin/env node
// The live trial's public route is a Gozar session route recorded in the manifest and removed by teardown. The fake Gozar stands in for the
// unreleased runtime (see src/test-support/gozar-fake.mjs); real integration is proven separately.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { REPO } from './common.mjs';
import { closeAndVerifyRoute, exposureRecord, validateExposure } from './exposure.mjs';
import { buildQuery, startSessionRoute, targetFor } from '../../src/gozar-routes.mjs';
import { createFakeGozar } from '../../src/test-support/gozar-fake.mjs';

const HOME = path.join(os.tmpdir(), 'unused-gozar-home-for-fake');
const started = async gozar => {
  const route = await startSessionRoute({ gozar, consent: async () => true, query: buildQuery({ home: HOME, target: targetFor(8787), route: undefined, usage: { kind: 'session', lifetimeMs: 60_000 } }) });
  return { route, record: exposureRecord({ view: route.view, home: HOME, localPort: 8787, lifetimeMs: 60_000, now: () => 0 }) };
};

test('the manifest record names the handle, home, origin, port and deadline; anything else is refused', async () => {
  const { record } = await started(createFakeGozar());
  assert.equal(validateExposure(record, 8787), record);
  assert.equal(record.deadline_at, new Date(60_000).toISOString());
  for (const bad of [null, [], { ...record, kind: 'x' }, { ...record, handle: { kind: 'session', id: '', generation: 1 } }, { ...record, handle: { ...record.handle, generation: 0 } },
    { ...record, gozar_home: 'relative' }, { ...record, origin: 'http://insecure.invalid' }, { ...record, local_port: 9 }, { ...record, deadline_at: 'soon' }]) assert.throws(() => validateExposure(bad, 8787));
});

test('teardown closes exactly the recorded handle and reads it back', async () => {
  const gozar = createFakeGozar();
  const { record } = await started(gozar);
  assert.deepEqual(await closeAndVerifyRoute(record, '/trial', { gozar }), { state: 'released' });
  assert.equal(gozar.fake.state.effects.filter(e => e.type === 'close').length, 1);
  assert.equal((await closeAndVerifyRoute(record, '/trial', { gozar })).state, 'released', 'a second teardown is safe');
  const missing = { ...gozar, closeRoute: async () => { throw Object.assign(new Error('x'), { code: 'route_not_found' }); } };
  assert.deepEqual(await closeAndVerifyRoute(record, '/trial', { gozar: missing }), { state: 'gone' });
});

test('unconfirmed removal stops teardown with instructions that name no provider command', async () => {
  const gozar = createFakeGozar();
  gozar.fake.setCleanupDebt('relay entry remains');
  const { record } = await started(gozar);
  await assert.rejects(() => closeAndVerifyRoute(record, '/trial', { gozar }), error => /not verified/.test(error.message) && /cleanup debt/.test(error.message) && /Gozar/.test(error.message) && !/gozar (expose|stop|route)\b/.test(error.message));
  const broken = { ...createFakeGozar(), closeRoute: async () => { throw Object.assign(new Error('x'), { code: 'busy' }); } };
  await assert.rejects(() => closeAndVerifyRoute(record, '/trial', { gozar: broken }), /close failed: busy/);
});

test('setup refuses an HTTPS public URL without --route, and --lifetime-seconds without --route', () => {
  for (const args of [['--public-url', 'https://trial.example.invalid'], ['--public-url', 'http://127.0.0.1:8787', '--lifetime-seconds', '60']]) {
    const result = spawnSync(process.execPath, [path.join(REPO, 'scripts/live-trial/setup.mjs'), ...args], { cwd: REPO, encoding: 'utf8', timeout: 15_000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--route/);
  }
});
