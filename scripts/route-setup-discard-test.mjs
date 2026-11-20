import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {runRouteSetup} from '../src/route-setup.mjs';

const failure = code => Object.assign(new Error(code), {code});

async function fixture(t, {actionError, discardCode}) {
  const root = await mkdtemp(join(tmpdir(), 'route-setup-discard-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const providerId = 'fixture-provider';
  const bytes = Buffer.from([1, 2, 3]);
  const output = [];
  let actions = 0, discards = 0;
  let revision = 1;
  const gozar = {
    async readSetupOperation(ref) {
      const scope = {providerId, configurationRevision:1, scopeId:'fixture-scope', registryId:'fixture-registry', draftId:null};
      return {operationId:ref.operationId, revision, scope, state:'required', resources:[],
        evidence:{known:false, reason:'fixture'},
        nextAction:{id:'intake', kind:'provide-secret', inputId:'fixture-input', label:'Fixture input',
          digest:'fixture-digest', disclosure:{revision:1, links:[]},
          step:{permission:{label:'fixture permission'}},
          consent:{facts:[], consentFactsDigest:'fixture-facts', scope:{...scope, operation:{id:ref.operationId, revision}}}}};
    },
    async storeSecret(request) {
      assert.deepEqual(request.bytes, Buffer.from([1, 2, 3]));
      return {handle:'fixture-handle'};
    },
    async runSetupAction(command) {
      actions += 1;
      assert.equal(command.expectedSetupRevision, 1);
      assert.equal(command.secretHandle, 'fixture-handle');
      assert.deepEqual(bytes, Buffer.alloc(3));
      if (actionError) throw actionError;
      const view = await gozar.readSetupOperation(command);
      revision += 1;
      return {...view, revision, state:'complete', nextAction:null};
    },
    async discardSecret(request) {
      discards += 1;
      assert.equal(request.handle, 'fixture-handle');
      throw failure(discardCode);
    }
  };
  return {bytes, output, count: () => [actions, discards, revision], run: () => runRouteSetup({
    gozar, candidate:{providerId, setup:{state:'required'}}, home:root, env:{XDG_CONFIG_HOME:root},
    say: line => output.push(line), ask:async () => 'yes', askSecret:async () => bytes
  })};
}

test('failed disposal cannot override an advanced setup revision or repeat the action', async t => {
  const f = await fixture(t, {discardCode:'secret_backend_unavailable'});
  assert.equal(await f.run(), true);
  assert.deepEqual(f.count(), [1, 1, 2]);
  assert.ok(f.output.some(line => line.includes('could not be confirmed')));
  assert.deepEqual(f.bytes, Buffer.alloc(3));
});

test('failed disposal preserves the original setup action error', async t => {
  const original = failure('fixture_action_failed');
  const f = await fixture(t, {actionError:original, discardCode:'secret_backend_unavailable'});
  await assert.rejects(f.run(), error => error === original);
  assert.deepEqual(f.count(), [1, 1, 1]);
  assert.deepEqual(f.bytes, Buffer.alloc(3));
});

test('a referenced synthetic handle stays protected without extra cleanup', async t => {
  const f = await fixture(t, {discardCode:'secret_in_use'});
  assert.equal(await f.run(), true);
  assert.deepEqual(f.count(), [1, 1, 2]);
  assert.equal(f.output.some(line => line.includes('could not be confirmed')), false);
});
