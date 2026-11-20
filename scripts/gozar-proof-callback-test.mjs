import assert from 'node:assert/strict';
import { test } from 'node:test';
import { monitorRoute } from '../src/gozar-routes.mjs';

const origin = 'https://synthetic.example';
const handle = { kind: 'lease', id: 'fixture', generation: 1 };
const view = { handle, origin, state: 'usable', published: origin, verification: {status: 'verified'} };

test('a failed handoff ends the consumer wait without reporting provider loss', async () => {
  const cause = new Error('synthetic local write failure');
  let closes = 0;
  const route = monitorRoute({gozar: {
    async *watchRoutes() { yield {route: view, type: 'snapshot'}; },
    async closeRoute() { closes++; return {handle, state: 'released', published: null, cleanup: {state: 'confirmed'}}; },
  }, home: '/synthetic', view});
  const observations = [];
  await route.watchPublished(async available => { observations.push(available); throw cause; });
  assert.deepEqual(observations, [true]);
  assert.equal(await route.exited, 'handoff_failed');
  assert.equal(route.endedBecause(), 'handoff_failed');
  assert.equal(route.handoffFailure().cause, cause);
  assert.doesNotMatch(route.handoffFailure().message, /synthetic local write failure/);
  assert.equal(closes, 0);
  assert.deepEqual(await route.stop(), {removed: true});
  await route.stop();
  assert.equal(closes, 1);
});

test('a provider watch failure still reports route loss', async () => {
  const route = monitorRoute({gozar: {
    async *watchRoutes() { throw new Error('synthetic provider watch failure'); },
  }, home: '/synthetic', view, remove: false});
  await route.watchPublished(() => assert.fail('no proof transition'));
  assert.equal(await route.exited, 'lost');
  assert.equal(route.handoffFailure(), null);
  await route.stop();
});
