import test from 'node:test';
import assert from 'node:assert/strict';
import { publishWorkerRoute, workerRouteReference } from './worker-bridge-setup.mjs';

test('worker route identity survives allocation and a matching retry view', () => {
  const home = '/synthetic/gozar', custody = '/synthetic/custody';
  const handle = { kind: 'durable', id: 'fixture', generation: 4 };
  const view = { handle, operationId: 'original-operation' };
  const expected = { home, handle, custody, operationId: view.operationId };
  assert.deepEqual(workerRouteReference(home, null, view, custody), expected);
  assert.deepEqual(workerRouteReference(home, { home, handle, custody }, view, custody), expected);
  assert.deepEqual(workerRouteReference(home, expected, { handle, operationId: 'unrelated' }, custody), expected);
  assert.deepEqual(workerRouteReference(home, { home, handle, custody }, { handle }, custody), { home, handle, custody });
});

const fixture = () => {
  const handle = { kind: 'durable', id: 'fixture', generation: 4 };
  const ref = { home: '/synthetic/gozar', custody: '/synthetic/custody', handle };
  const urlFile = '/synthetic/worker/resource-url', configDir = '/synthetic/worker/config';
  const reference = configDir + '/route-reference.json';
  const files = new Map([[urlFile, 'previous-value'], [reference, JSON.stringify(ref)]]);
  const url = 'https://worker.invalid';
  return { ref, files, reference, args: {
    o: { home: '/synthetic/worker', worker: 'fixture', port: 8888 }, env: {}, url,
    secret: 'synthetic-value', urlFile, configDir, log: () => {},
    readReference: () => JSON.parse(files.get(reference)),
    write: (path, value) => files.set(path, value),
  } };
};

test('matching authenticated status backfills a handle-only reference', async () => {
  const { ref, files, reference, args } = fixture();
  const gozar = { routeStatus: async () => ({
    handle: ref.handle, operationId: 'original-operation',
    state: 'usable', origin: args.url, published: args.url, verification: { status: 'verified' },
  }) };
  await publishWorkerRoute({ ...args, gozar });
  assert.deepEqual(JSON.parse(files.get(reference)), { ...ref, operationId: 'original-operation' });
});

test('a missing historical route remains unconfirmed and leaves an existing URL untouched', async () => {
  const { ref, files, reference, args } = fixture();
  const gozar = {
    routeStatus: async () => { throw Object.assign(new Error('not found'), { code: 'route_not_found' }); },
    ensureRoute: async () => assert.fail('missing status must not allocate'),
  };
  await assert.rejects(publishWorkerRoute({ ...args, gozar }), { code: 'route_not_found' });
  assert.deepEqual(JSON.parse(files.get(reference)), ref);
  assert.equal(files.get(args.urlFile), 'previous-value');
});
