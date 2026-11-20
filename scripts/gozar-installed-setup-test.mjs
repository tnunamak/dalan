import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, copyFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGozar } from '@tnunamak/gozar';
import { fakeRegistry } from '@tnunamak/gozar/testing';
import { buildQuery } from '../src/gozar-routes.mjs';
import { routeSecretBackend } from '../src/route-custody.mjs';
import { cancelRouteSetup, runRouteSetup } from '../src/route-setup.mjs';

test('installed setup requires current consent, uses private custody, and retries exact disconnect after backend failure', { timeout: 25000 }, async t => {
  const root = await mkdtemp(join(homedir(), '.tmp', 'ds-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = 'edge-' + randomUUID().slice(0, 8);
  const registry = await fakeRegistry({ id, kinds: ['attached'], reach: 'internet', protocols: ['sse', 'streamable-http', 'oauth-dcr'], dir: root });
  const adapterDir = join(root, 'providers', id);
  await rename(join(adapterDir, 'index.mjs'), join(adapterDir, 'base.mjs'));
  await copyFile(new URL('../src/test-support/route-management-fixture.mjs', import.meta.url), join(adapterDir, 'index.mjs'));
  const provider = join(adapterDir, 'management.json');
  const state = { callback: 'none', expiresAt: new Date(Date.now() + 120_000).toISOString(), disconnects: 0, removes: 0, foreign: { id: 'foreign', contents: 'leave as found' } };
  const save = () => writeFile(provider, JSON.stringify(state));
  await save();
  const home = join(root, 'g'), custody = join(root, 'custody');
  const env = { XDG_CONFIG_HOME: join(root, 'config') };
  const setupDir = join(env.XDG_CONFIG_HOME, 'dalan', 'route-setup');
  const backend = routeSecretBackend(custody);
  const canary = 'private-inventory-' + randomUUID();
  let locked = false, handle;
  const secretBackend = {
    ...backend,
    async put(request) {
      const [ref] = await readdir(setupDir);
      const saved = JSON.parse(await readFile(join(setupDir, ref), 'utf8'));
      assert.equal(saved.providerId, id, 'operation ID is durable before intake');
      const stored = await backend.put(request);
      handle = { scopeId: request.scopeId, handle: stored.handle };
      return stored;
    },
    async delete(request) {
      if (locked) throw new Error('synthetic backend failure');
      return backend.delete(request);
    },
  };
  // Rebuild the factory between invocations to simulate a fresh host process.
  const api = () => createGozar({ manifest: registry.manifest, root: registry.root, secretBackend });
  const query = buildQuery({ home, target: '127.0.0.1:12345', usage: { kind: 'attached' } });
  const output = [];
  const say = line => output.push(line);
  let gozar = api(), [candidate] = (await gozar.catalogRoutes(query)).candidates;
  let handoffs = 0, prompted = 0;
  const run = async (ask, verify) => runRouteSetup({ gozar, candidate, home, env, say, ask,
    async handoff(href) {
      assert.equal(new URL(href).searchParams.get('synthetic'), 'handoff-canary');
      handoffs++;
      state.callback = verify ? 'verified' : 'returned';
      await save();
    },
    async askSecret() { prompted++; return Buffer.from(canary); },
  });

  assert.equal(await run(async () => 'no'), false, 'decline cannot open the browser');
  assert.equal(handoffs, 0);
  const [filename] = await readdir(setupDir);
  const ref = JSON.parse(await readFile(join(setupDir, filename), 'utf8'));
  assert.equal((await gozar.readSetupOperation(ref)).nextAction.href, undefined);
  assert.equal(await run(async () => 'yes'), false, 'a browser return cannot stand in for observed authorization');
  assert.equal(handoffs, 1);
  assert.equal(prompted, 0);

  state.blocked = true;
  await save();
  assert.equal(await run(async () => 'yes'), false, 'reconciling instructions are not setup completion');
  assert.equal(prompted, 0);
  assert.equal((await gozar.readSetupOperation(ref)).state, 'reconciling');
  state.blocked = false;
  await save();

  gozar = api();
  assert.equal(await run(async () => 'yes', true), true);
  assert.equal(prompted, 1);
  const completion = await gozar.readSetupOperation(ref);
  assert.equal(completion.evidence.known, true);
  assert.deepEqual(completion.resources.map(resource => [resource.ownership, resource.presence]), [['owned', { known: true, value: true }]]);
  assert.deepEqual(await gozar.listRoutes({ home, owner: 'dalan' }), { routes: [] }, 'setup completes before any route exists');
  assert.deepEqual(await backend.presence(handle), { known: true, value: true });

  const cancel = ask => cancelRouteSetup({ gozar, home, operationId: ref.operationId, env, ask, say });
  assert.equal(await cancel(async () => 'no'), false);
  assert.equal((await gozar.readSetupOperation(ref)).state, 'complete');
  assert.equal(await cancel(async question => /Cancel this/.test(question) ? 'yes' : 'no'), false);
  assert.equal((await gozar.readSetupOperation(ref)).nextAction.step.purpose, 'remove-resource');
  assert.deepEqual(await backend.presence(handle), { known: true, value: true });

  locked = true;
  assert.equal(await cancel(async () => 'yes'), false);
  assert.deepEqual(await backend.presence(handle), { known: true, value: true });
  assert.deepEqual(await readdir(setupDir), [filename], 'failed disconnect retains the exact operation for recovery');
  const debt = await gozar.readSetupOperation(ref);
  assert.equal(debt.nextAction.step.purpose, 'disconnect');
  assert.equal(debt.resources[0].handle, completion.resources[0].handle);
  assert.equal(debt.resources[0].removal, 'confirmed');
  locked = false;
  gozar = api();
  assert.equal(await cancel(async () => 'yes'), true);
  assert.deepEqual(await backend.presence(handle), { known: true, value: false });
  const finalProvider = JSON.parse(await readFile(provider, 'utf8'));
  assert.equal(finalProvider.disconnects, 1);
  assert.equal(finalProvider.removes, 1);
  assert.deepEqual(finalProvider.foreign, state.foreign);
  assert.deepEqual(await readdir(setupDir), []);
  assert.doesNotMatch(output.join('\n'), /handoff-canary|private-inventory-/);
  for (const name of await readdir(custody)) assert.equal((await readFile(join(custody, name))).includes(canary), false);
});
