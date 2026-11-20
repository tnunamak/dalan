// Contract-fake service delivery oracle, NOT installed SDK admission/crash proof.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeGozar } from '../src/test-support/gozar-fake.mjs';
import { installService } from '../src/service.mjs';

export function deliveryFixture(root, { hold, observation = 'normal', errorAfterReturn = false } = {}) {
  const home = path.join(root, 'g'), bridge = path.join(root, 'd');
  const env = { PATH: process.env.PATH, HOME: root, GOZAR_HOME: home,
    XDG_CONFIG_HOME: path.join(root, 'c'), XDG_STATE_HOME: path.join(root, 's') };
  const file = path.join(root, 'facade.json');
  const pointer = path.join(env.XDG_CONFIG_HOME, 'dalan', 'route-installs',
    createHash('sha256').update(bridge).digest('hex') + '.json');
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  const save = state => { writeFileSync(file + '.tmp', JSON.stringify(state), { mode: 0o600 }); renameSync(file + '.tmp', file); };
  if (!existsSync(file)) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    save({ returned: null, requests: [], closes: [], sentinel: { owner: 'neighbor', id: 'foreign-do-not-close' } });
  }
  const base = createFakeGozar();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const gozar = {
    ...base,
    async ensureRoute(request) {
      if (!request.approval) return base.ensureRoute(request);
      const state = read();
      state.requests.push(request.operationId);
      // This fixture models a facade's retained result, not a provider ledger.
      if (!state.returned) state.returned = await base.ensureRoute(request);
      assert.equal(state.returned.operationId, request.operationId);
      save(state);
      const returned = structuredClone(state.returned);
      if (hold) await hold(returned);
      if (errorAfterReturn) throw Object.assign(new Error('fixture lost delivery with retained view'),
        { code: 'provider_unavailable', route: returned });
      return returned;
    },
    async listRoutes() {
      const view = read().returned;
      if (!view || observation === 'empty') return { routes: [] };
      return { routes: observation === 'duplicate' ? [view, structuredClone(view)] : [view] };
    },
    async routeStatus({ handle }) {
      const view = read().returned;
      assert.ok(view && same(view.handle, handle), 'only the original service handle may be observed');
      return structuredClone(view);
    },
    async closeRoute({ handle, mode }) {
      const state = read();
      assert.equal(mode, 'remove');
      assert.deepEqual(handle, state.returned.handle, 'foreign sentinel is never a cleanup subject');
      state.closes.push(handle);
      state.returned = { ...state.returned, state: 'released', published: null, cleanup: { state: 'confirmed' } };
      save(state);
      return structuredClone(state.returned);
    },
  };
  const service = { home: bridge, auto: true, origin: null, port: null, target: null,
    workers: ['fixture'], autoUpdate: false };
  const seams = { env, gozar, platform: 'linux', consent: async () => true,
    waitForSocket: async () => false, spawn: () => ({ status: 0, stdout: '' }) };
  return { root, home, bridge, pointer, read, service, seams };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const x = deliveryFixture(process.argv[2], { hold: async returned => {
    const pointer = JSON.parse(readFileSync(x.pointer, 'utf8'));
    assert.equal(pointer.phase, 'dispatching');
    assert.equal(pointer.operationId, returned.operationId);
    assert.equal(pointer.handle, undefined);
    process.send({ type: 'service-delivery-held', returned, pointer });
    await new Promise(resolve => process.once('message', message => {
      assert.equal(message, 'release');
      resolve();
    }));
  } });
  try {
    await installService(x.service, x.seams);
    process.send?.({ type: 'unexpected-success' });
  } catch (error) {
    process.send?.({ type: 'finished', message: error.message, code: error.code });
  } finally { process.disconnect?.(); }
}
