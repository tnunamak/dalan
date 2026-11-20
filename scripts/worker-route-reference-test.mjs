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
  assert.deepEqual(workerRouteReference(home, expected, view, custody), expected);
  assert.throws(() => workerRouteReference(home, expected, { handle, operationId: 'unrelated' }, custody), { code: 'route_conflict' });
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

test('contradictory operation identity keeps the authenticated worker route untouched', async () => {
  const { ref, files, reference, args } = fixture();
  files.set(reference, JSON.stringify({ ...ref, operationId: 'retained-operation' }));
  const before = new Map(files);
  let statusReads = 0;
  const gozar = {
    routeStatus: async () => {
      statusReads++;
      return {
        handle: ref.handle, operationId: 'other-operation',
        state: 'usable', origin: args.url, published: args.url, verification: { status: 'verified' },
      };
    },
    listRoutes: async () => assert.fail('conflicting status must not fall back to history'),
    catalogRoutes: async () => assert.fail('conflicting status must not allocate'),
    ensureRoute: async () => assert.fail('conflicting status must not dispatch'),
  };
  await assert.rejects(publishWorkerRoute({ ...args, gozar, write: () => assert.fail('no writes') }), { code: 'route_conflict' });
  assert.equal(statusReads, 1);
  assert.deepEqual(files, before, 'reference and URL bytes are unchanged');
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

test('a failed verification on real owned files keeps the previous URL and backfills the reference', async t => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-worker-route-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'worker'), configDir = path.join(home, 'config');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const handle = { kind: 'durable', id: 'fixture', generation: 4 };
  const reference = path.join(configDir, 'route-reference.json'), urlFile = path.join(home, 'resource-url');
  fs.writeFileSync(reference, JSON.stringify({ home: path.join(dir, 'gozar'), custody: path.join(dir, 'custody'), handle }), { mode: 0o600 });
  fs.writeFileSync(urlFile, 'previous-value\n', { mode: 0o600 });
  const url = 'https://worker.invalid';
  const gozar = { routeStatus: async () => ({ handle, operationId: 'original-operation', state: 'declined', origin: url, published: null, verification: { status: 'failed' } }) };
  await assert.rejects(publishWorkerRoute({
    o: { home, repo: dir, worker: 'fixture', port: 8888 }, env: {}, url, secret: 'synthetic-value', urlFile, configDir, log: () => {}, gozar,
  }), error => error.code !== 'ERR_INVALID_ARG_TYPE' && /could not verify the public route/.test(error.message));
  assert.equal(fs.readFileSync(urlFile, 'utf8'), 'previous-value\n');
  assert.equal(JSON.parse(fs.readFileSync(reference, 'utf8')).operationId, 'original-operation');
});

test('contradictory operation identity on real owned files leaves reference and URL bytes unchanged', async t => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-worker-conflict-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'worker'), configDir = path.join(home, 'config');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const handle = { kind: 'durable', id: 'fixture', generation: 4 };
  const reference = path.join(configDir, 'route-reference.json'), urlFile = path.join(home, 'resource-url');
  const referenceBytes = JSON.stringify({ home: path.join(dir, 'gozar'), custody: path.join(dir, 'custody'), handle, operationId: 'retained-operation' });
  fs.writeFileSync(reference, referenceBytes, { mode: 0o600 });
  fs.writeFileSync(urlFile, 'previous-value\n', { mode: 0o600 });
  const url = 'https://worker.invalid';
  const names = fs.readdirSync(home).concat(fs.readdirSync(configDir));
  const gozar = {
    routeStatus: async () => ({ handle, operationId: 'other-operation', state: 'usable', origin: url, published: url, verification: { status: 'verified' } }),
    listRoutes: async () => assert.fail('conflicting status must not fall back to history'),
    ensureRoute: async () => assert.fail('conflicting status must not dispatch'),
  };
  await assert.rejects(publishWorkerRoute({
    o: { home, repo: dir, worker: 'fixture', port: 8888 }, env: {}, url, secret: 'synthetic-value', urlFile, configDir, log: () => {}, gozar,
  }), { code: 'route_conflict' });
  assert.equal(fs.readFileSync(reference, 'utf8'), referenceBytes);
  assert.equal(fs.readFileSync(urlFile, 'utf8'), 'previous-value\n');
  assert.deepEqual(fs.readdirSync(home).concat(fs.readdirSync(configDir)), names, 'no temporary or new files');
});
