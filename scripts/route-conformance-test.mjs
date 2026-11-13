// Consumer conformance for Gozar's testing export: a provider Dalan has never heard of, with a random id, must appear in `dalan routes`
// and be selectable by `--route <id>` through Dalan's real code. Adding a provider to Gozar needs no change here or in Dalan's source.
// Gozar is the real package from @tnunamak/gozar/testing; its probes and sessions are faked in memory, no provider process runs.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { createRouteApi, fakeReadContext, fakeRegistry } from '@tnunamak/gozar/testing';
import { routesMain } from '../src/routes.mjs';
import { runTry } from '../src/try.mjs';
import { reservedPort } from '../src/test-support/port.mjs';

const tempRoot = process.env.DOT_BRIDGE_TEST_TMP ?? path.join(os.homedir(), '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const tmp = fs.mkdtempSync(path.join(tempRoot, 'route-conformance-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const fakeId = () => `fake-${randomBytes(4).toString('hex')}`;
// Dalan requires the oauth-dcr protocol (its OAuth server registers clients dynamically). fakeRegistry in the packed 0.3 tarball writes oauthDcr: false,
// so the fake is ineligible for Dalan as written. `usable` flips that one flag in the fake's definition file; `dalan routes` needs no flip.
async function withFake(kinds, body, { usable = false } = {}) {
  const id = fakeId();
  const registry = await fakeRegistry({ id, kinds, reach: 'internet' });
  try {
    if (usable) {
      const file = path.join(registry.root, 'providers', id, 'definition.json');
      const definition = JSON.parse(fs.readFileSync(file, 'utf8'));
      definition.adapter.capabilities.protocols.oauthDcr = true;
      fs.writeFileSync(file, JSON.stringify(definition, null, 2));
    }
    const home = fs.mkdtempSync(path.join(tmp, 'gozar-'));
    const gozar = createRouteApi({ manifest: registry.manifest, root: registry.root, readContext: fakeReadContext({ home }) });
    return await body({ id, gozar, home });
  } finally { await registry.cleanup(); }
}

test('`dalan routes --json` lists a fake provider by its id, with its ports and proof', async () => {
  await withFake(['session'], async ({ id, gozar }) => {
    const lines = [];
    await routesMain({ argv: ['--json'], env: { GOZAR_HOME: path.join(tmp, 'routes-home') }, out: line => lines.push(line), gozar });
    const listed = JSON.parse(lines.join('\n')).find(c => c.providerId === id);
    assert.ok(listed, `${id} is listed`);
    assert.equal(listed.properties.address.ports, null);
    assert.deepEqual(listed.properties.proof, { vantage: 'this-device', checks: ['nonce'] });
    assert.equal(typeof listed.display.needs, 'string');
    const text = [];
    await routesMain({ argv: [], env: { GOZAR_HOME: path.join(tmp, 'routes-home') }, out: line => text.push(line), gozar });
    assert.match(text.join('\n'), new RegExp(`id: ${id}`));
    assert.match(text.join('\n'), /proof: checked from this-device; checks: nonce/);
  });
});

test('`dalan try --public --route <fake id>` reaches a ready route through the fake; an id one letter off is refused with the offered ids', async () => {
  await withFake(['session'], async ({ id, gozar }) => {
    for (const [route, expectReady] of [[id, true], [`${id}x`, false]]) {
      const name = `try-${route}`, input = new PassThrough(), controller = new AbortController();
      let out = '';
      const finished = runTry({
        argv: ['--public', '--home', path.join(tmp, name), '--port', String(await reservedPort()), '--route', route],
        env: { PATH: process.env.PATH, XDG_CONFIG_HOME: path.join(tmp, `cfg-${name}`), XDG_STATE_HOME: path.join(tmp, `state-${name}`) },
        out: { write: text => { out += text; if (/Use this route\? \[y\/N\]/.test(text)) setImmediate(() => input.write('y\n')); } },
        input, signal: controller.signal, errorContext: {}, hosted: { interactive: true, gozar, serverEnv: { DALAN_TEST_OAUTH: '1' } },
      }).then(() => ({}), error => ({ error }));
      if (expectReady) {
        for (let waited = 0; !/Public route ready\./.test(out) && waited < 30_000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
        assert.match(out, /Public route ready\./, out);
        assert.match(out, new RegExp(`id: ${id}`));
        controller.abort();
        await finished;
      } else {
        const done = await finished;
        assert.equal(done.error?.code, 'route_not_found');
        assert.match(done.error.message, new RegExp(`Unknown route id "${route}"\\. Offered: .*${id}`));
      }
    }
  }, { usable: true });
});

// Durable install with a fake id needs Gozar's durable facet. fakeRegistry refuses `durable` until that facet is merged; the case runs the day it does.
test('`dalan service install --route <fake id>` with a durable fake', async t => {
  const id = fakeId();
  let registry;
  try { registry = await fakeRegistry({ id, kinds: ['durable'], reach: 'internet' }); } catch (error) {
    assert.equal(error.code, 'unsupported');
    t.skip(`fakeRegistry throws unsupported for durable (${error.message}); this case waits for Gozar's durable facet`);
    return;
  }
  try {
    const { installService } = await import('../src/service.mjs');
    const home = fs.mkdtempSync(path.join(tmp, 'gozar-durable-'));
    const gozar = createRouteApi({ manifest: registry.manifest, root: registry.root, readContext: fakeReadContext({ home }) });
    const box = fs.mkdtempSync(path.join(tmp, 'svc-'));
    fs.mkdirSync(path.join(box, '.config', 'systemd', 'user'), { recursive: true, mode: 0o700 });
    const result = await installService({ home: path.join(box, 'bridge'), auto: true, route: id, workers: ['muse'], yes: true, writeUnitsOnly: true },
      { gozar, platform: 'linux', env: { HOME: box, XDG_CONFIG_HOME: path.join(box, '.config'), GOZAR_HOME: home }, freePort: async () => 8789, consent: async () => true, spawn: () => ({ status: 0, stdout: '' }), waitForSocket: async () => true });
    assert.match(result.origin ?? '', /^https:\/\//);
  } finally { await registry.cleanup(); }
});
