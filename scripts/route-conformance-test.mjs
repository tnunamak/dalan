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
async function withFake(kinds, body) {
  const id = fakeId();
  const registry = await fakeRegistry({ id, kinds, reach: 'internet' });
  try {
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
  });
});

// Durable install with a fake id: Dalan's real installService and uninstallService, Gozar's real durable engine, the fake provider's rule store.
// Only the OS service manager is replaced (spawn answers ok, units are written to a scratch dir); the route is created and verified for real.
test('`dalan service install --route <fake id>` makes a usable, verified durable route, and uninstall leaves no rule in the store', async () => {
  const id = fakeId();
  const registry = await fakeRegistry({ id, kinds: ['durable'], reach: 'internet' });
  try {
    const { installService, uninstallService } = await import('../src/service.mjs');
    const gozarHome = fs.mkdtempSync(path.join(tmp, 'gozar-durable-'));
    const gozar = createRouteApi({ manifest: registry.manifest, root: registry.root, readContext: fakeReadContext({ home: gozarHome, verified: true }) });
    const box = fs.mkdtempSync(path.join(tmp, 'svc-'));
    fs.mkdirSync(path.join(box, '.config', 'systemd', 'user'), { recursive: true, mode: 0o700 });
    const seams = { gozar, platform: 'linux', env: { HOME: box, XDG_CONFIG_HOME: path.join(box, '.config'), GOZAR_HOME: gozarHome }, freePort: async () => 8789,
      consent: async () => true, spawn: () => ({ status: 0, stdout: '' }), waitForSocket: async () => true };
    const bridgeHome = path.join(box, 'bridge');
    const result = await installService({ home: bridgeHome, auto: true, route: id, workers: ['muse'], yes: true }, seams);
    assert.match(result.origin ?? '', /^https:\/\//);
    const store = JSON.parse(fs.readFileSync(path.join(registry.root, 'providers', id, 'store.json'), 'utf8'));
    assert.ok(Object.values(store.entries).some(entry => entry.rule), 'the fake provider holds a rule after install');
    const view = await gozar.routeStatus({ home: gozarHome, handle: result.route.handle });
    assert.equal(view.state, 'usable');
    assert.equal(view.verification.status, 'verified');
    await uninstallService({ home: bridgeHome }, seams);
    const after = JSON.parse(fs.readFileSync(path.join(registry.root, 'providers', id, 'store.json'), 'utf8'));
    assert.deepEqual(Object.values(after.entries).filter(entry => entry.rule), [], 'no rule is left in the store');
  } finally { await registry.cleanup(); }
});
