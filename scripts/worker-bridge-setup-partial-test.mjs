import assert from 'node:assert/strict';
import { publishWorkerRoute } from './worker-bridge-setup.mjs';

const home = '/fixture/worker';
const configDir = home + '/config';
const urlFile = home + '/resource-url';
const retained = { home: '/fixture/routes', handle: { kind: 'local' }, custody: 'fixture' };
const gozar = {};
const writes = [];
let observed = false;
await assert.rejects(publishWorkerRoute({
  o: { home, worker: 'fixture', port: 8901 }, env: {}, gozar,
  url: 'https://worker.example.invalid', secret: 'synthetic',
  urlFile, configDir, log() {},
  readReference: () => retained,
  observeRoute: async (supplied, reference) => {
    assert.equal(supplied, gozar);
    assert.equal(reference, retained);
    observed = true;
    return { state: 'recorded', view: { published: null } };
  },
  write: (file, text) => writes.push([file, text]),
  consent: () => assert.fail('recorded route should not need provider consent'),
}), error => {
  assert.deepEqual(error.partialSetup, {
    phase: 'public_verification', homeRetained: true, serviceRetained: true,
    resourceUrlRewritten: false,
  });
  return true;
});
assert.equal(observed, true);
assert.equal(writes.some(([file]) => file === urlFile), false);
console.log('PASS public verification failure reports retained install and does not rewrite the resource URL');
