// All SDK imports resolve through the installed package's public exports.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createTestingGozar, fakeRegistry } from '@tnunamak/gozar/testing';
import { runTry } from '../src/try.mjs';

async function forwarder(target, observe = () => {}) {
  const upstream = new URL('http://' + target);
  const server = http.createServer((req, res) => {
    const forward = http.request({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: req.headers }, reply => {
      observe(req, reply.statusCode);
      res.writeHead(reply.statusCode, reply.headers);
      reply.pipe(res);
    });
    forward.on('error', () => { res.writeHead(502); res.end(); });
    res.on('close', () => forward.destroy());
    req.pipe(forward);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

test('installed Gozar proves and removes an unknown route serving the real Dalan bridge', { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(homedir(), '.tmp', 'dg-'));
  const id = 'edge-' + randomUUID().slice(0, 8);
  const home = join(root, 'g');
  const registry = await fakeRegistry({ id, kinds: ['attached', 'session'], reach: 'internet', dir: root,
    protocols: ['sse', 'streamable-http', 'oauth-dcr'] });
  const trial = join(root, 'd');
  const stop = new AbortController();
  const input = new PassThrough();
  const foreign = await forwarder('127.0.0.1:1');
  const resources = new Map([['foreign', foreign]]);
  let requestedTarget, publicOrigin, nonceReads = 0, removed = [];
  const browserReceipt = process.env.DALAN_TEST_BROWSER_RECEIPT;
  let browserObserved, browserProbePending = Boolean(browserReceipt);
  const publicFetch = async (url, init = {}) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, publicOrigin);
    const port = resources.get('owned').port;
    if (browserProbePending && parsed.pathname.startsWith('/.well-known/oauth-protected-resource/')) {
      browserProbePending = false;
      await writeFile(browserReceipt, JSON.stringify({ port, path: '/admin' }), { mode: 0o600 });
      const until = Date.now() + 16000;
      while (browserObserved === undefined && Date.now() < until) await sleep(50);
      assert.ok(browserObserved, 'the browser reached the same installed SDK gate');
      t.diagnostic(`Browser /admin response through the SDK gate: HTTP ${browserObserved}`);
    }
    return new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, path: parsed.pathname + parsed.search,
        method: init.method, signal: init.signal, headers: { host: parsed.host, ...Object.fromEntries(new Headers(init.headers)) } },
      response => resolve(new Response(Readable.toWeb(response), { status: response.statusCode, headers: response.headers })));
      request.on('error', reject);
      request.end(init.body);
    });
  };
  const harness = await createTestingGozar({ manifest: registry.manifest, root: registry.root, effects: [
    { kind: 'process-runtime', operation: 'open', async handle({ origin, target }) {
      assert.equal(resources.has('owned'), false, 'the operation creates one connector');
      publicOrigin = origin;
      requestedTarget = target;
      resources.set('owned', await forwarder(target, (request, status) => {
        if (browserReceipt && request.url === '/admin' && /Chrome|Chromium/.test(request.headers['user-agent'] ?? '')) browserObserved = status;
      }));
      return { handle: 'owned', origin };
    } },
    { kind: 'process-runtime', operation: 'read', async handle({ handle }) { return { present: resources.has(handle) }; } },
    { kind: 'process-runtime', operation: 'close', async handle({ handle }) {
      assert.equal(handle, 'owned');
      await resources.get(handle)?.close();
      resources.delete(handle);
      removed.push(handle);
      return { closed: true };
    } },
    { kind: 'network', operation: 'fetch', async handle({ url, method, headers }) {
      const response = await publicFetch(url, { method, headers });
      if (/\/identity$/.test(new URL(url).pathname) && response.ok) nonceReads++;
      const chunks = [];
      let previous = performance.now();
      for await (const value of response.body) {
        const now = performance.now();
        chunks.push({ data: Buffer.from(value).toString('base64'), delayMs: Math.round(now - previous) });
        previous = now;
      }
      return { status: response.status, headers: Object.fromEntries(response.headers), chunks };
    } },
  ] });
  let proof;
  const watchRoutes = harness.gozar.watchRoutes;
  harness.gozar.watchRoutes = async function* (request) {
    for await (const event of watchRoutes(request)) {
      if (event.route.verification.status === 'verified') proof = event.route;
      yield event;
    }
  };
  let output = '';
  let signalHandoff;
  const handoff = new Promise(resolve => { signalHandoff = resolve; });
  const run = runTry({ argv: ['--public', '--home', trial],
    env: { PATH: process.env.PATH, HOME: root, GOZAR_HOME: home, XDG_CONFIG_HOME: join(root, 'c'), XDG_STATE_HOME: join(root, 's') },
    out: { write(text) {
      output += text;
      if (text.includes('Use this route?')) setImmediate(() => input.write('yes\n'));
      if (text.includes('Waiting for sign-in.')) signalHandoff();
    } }, input, signal: stop.signal, errorContext: {},
    hosted: { interactive: true, gozar: harness.gozar, fetchImpl: publicFetch, readyMs: browserReceipt ? 18000 : 3000 },
  });
  try {
    await Promise.race([handoff, run.then(() => assert.fail('trial stopped before handoff'))]);
    const url = (await readFile(join(trial, 'resource-url'), 'utf8')).trim();
    assert.equal(new URL(url).origin, publicOrigin);
    assert.ok(nonceReads > 0, 'the public check reached the SDK-owned nonce endpoint');
    const { routes } = await harness.gozar.listRoutes({ home, owner: 'dalan' });
    const [route] = routes;
    assert.equal(route.published, publicOrigin);
    assert.notEqual(requestedTarget, route.verification.subject.target, 'provider forwards to the SDK gate');
    assert.ok(route.verification.checks.includes('nonce'));
    const auth = await publicFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
    assert.equal(auth.status, 401);
    assert.match(auth.headers.get('www-authenticate'), /^Bearer/i);
    const owner = await publicFetch(publicOrigin + '/admin');
    assert.equal(owner.status, 404);
    const wrongHost = await publicFetch(publicOrigin + '/admin', { headers: { host: 'unrelated.invalid', 'x-forwarded-host': new URL(publicOrigin).host } });
    assert.equal(wrongHost.status, 421, 'a forwarded authority cannot substitute for the wrong Host');
    assert.doesNotMatch(output, /candidateToken|approvalToken/);
    stop.abort();
    await run;
    assert.deepEqual(removed, ['owned']);
    assert.equal(resources.size, 1);
    assert.equal(resources.get('foreign'), foreign);
  } catch (error) {
    if (proof) {
      assert.equal(proof.published, publicOrigin);
      assert.ok(proof.verification.checks.includes('nonce'));
      assert.notEqual(requestedTarget, proof.verification.subject.target);
      assert.deepEqual(removed, ['owned'], 'failed app readiness still closes the exact connector');
      assert.deepEqual([...resources.keys()], ['foreign']);
      assert.doesNotMatch(output, /Waiting for sign-in|Paste this URL/);
      await assert.rejects(readFile(join(trial, 'resource-url')), { code: 'ENOENT' });
      t.diagnostic('SDK nonce proof reached the gate, Dalan refused the host, and cleanup preserved the foreign sentinel without handoff.');
    }
    throw error;
  } finally {
    stop.abort();
    input.end();
    await run.catch(() => {});
    await harness.close().catch(() => {});
    await Promise.all([...resources.values()].map(resource => resource.close()));
    await registry.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
