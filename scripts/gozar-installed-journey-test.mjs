// All SDK imports resolve through the installed package's public exports.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
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

async function installedPackageMetadata(specifier, packageName) {
  let directory = dirname(fileURLToPath(import.meta.resolve(specifier)));
  for (;;) {
    let metadata;
    try {
      metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (metadata?.name === packageName) return metadata;
    const parent = dirname(directory);
    assert.notEqual(parent, directory, `Could not find metadata for ${specifier}`);
    directory = parent;
  }
}

test('the installed Gozar version matches the Dalan manifest and lock', async () => {
  const dependency = '@tnunamak/gozar';
  const [manifest, lock, installed] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../package-lock.json', import.meta.url), 'utf8').then(JSON.parse),
    installedPackageMetadata(`${dependency}/testing`, dependency),
  ]);
  const declared = manifest.dependencies[dependency];
  assert.ok(declared, 'Dalan declares the Gozar dependency');
  assert.equal(lock.packages[''].dependencies[dependency], declared, 'root lock dependency');
  assert.equal(lock.packages[`node_modules/${dependency}`].version, declared, 'locked package version');
  assert.equal(installed.version, declared, 'actual installed package version');
});

test('installed Gozar proves and removes an unknown route serving the real Dalan bridge', { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dg-'));
  // Everything acquired is registered here at once and released last-in first-out by t.after, which runs even when setup
  // throws. Every step runs even if another rejects; a cleanup failure never replaces the failure that ended the body.
  const cleanups = [() => rm(root, { recursive: true, force: true })];
  let bodyFailed = false;
  t.after(async () => {
    const failures = [];
    for (const step of cleanups.reverse()) {
      try { await step(); } catch (error) { failures.push(error); }
    }
    for (const error of failures) t.diagnostic(`cleanup failed: ${error?.stack ?? error}`);
    if (failures.length && !bodyFailed) throw new AggregateError(failures, 'fixture cleanup failed');
  });
  const id = 'edge-' + randomUUID().slice(0, 8);
  const home = join(root, 'g');
  const registry = await fakeRegistry({ id, kinds: ['attached', 'session'], reach: 'internet', dir: root,
    protocols: ['sse', 'streamable-http', 'oauth-dcr'] });
  cleanups.push(() => registry.cleanup());
  const trial = join(root, 'd');
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const appPort = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const preparedId = process.env.DALAN_TEST_PREPARED_ROUTE === '1' ? randomUUID() : null;
  if (preparedId) {
    await mkdir(trial, { mode: 0o700 });
    await writeFile(join(trial, '.dalan-trial'), 'created by dalan try\n', { mode: 0o600 });
    await writeFile(join(trial, '.route-reference.json'), JSON.stringify({ home, operationId: preparedId, phase: 'prepared', port: appPort }), { mode: 0o600 });
  }
  const stop = new AbortController();
  const input = new PassThrough();
  const resources = new Map();
  cleanups.push(async () => {
    const failures = [];
    for (const resource of resources.values()) {
      try { await resource.close(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'resource close failed');
  });
  const foreign = await forwarder('127.0.0.1:1');
  resources.set('foreign', foreign);
  let requestedTarget, publicOrigin, nonceReads = 0, removed = [];
  const browserReceipt = process.env.DALAN_TEST_BROWSER_RECEIPT;
  const testReproof = process.env.DALAN_TEST_REPROOF_ROUTE === '1';
  let challengeAvailable = true;
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
      if (!challengeAvailable && /\/identity$/.test(new URL(url).pathname)) return { status: 502, headers: {}, chunks: [] };
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
  cleanups.push(() => harness.close());
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
  const run = runTry({ argv: ['--public', '--home', trial, '--port', String(appPort)],
    env: { PATH: process.env.PATH, HOME: root, GOZAR_HOME: home, XDG_CONFIG_HOME: join(root, 'c'), XDG_STATE_HOME: join(root, 's') },
    out: { write(text) {
      output += text;
      if (text.includes('Use this route?')) setImmediate(() => input.write('yes\n'));
      if (text.includes('Waiting for sign-in.')) signalHandoff();
    } }, input, signal: stop.signal, errorContext: {},
    hosted: { interactive: true, gozar: harness.gozar, fetchImpl: publicFetch, readyMs: browserReceipt ? 18000 : 3000 },
  });
  cleanups.push(async () => {
    stop.abort();
    input.end();
    await run.catch(() => {});
  });
  let handedOff = false;
  try {
    await Promise.race([handoff, run.then(() => assert.fail('trial stopped before handoff'))]);
    handedOff = true;
    const resourceFile = join(trial, 'resource-url');
    const url = (await readFile(resourceFile, 'utf8')).trim();
    assert.equal(new URL(url).origin, publicOrigin);
    assert.ok(nonceReads > 0, 'the public check reached the SDK-owned nonce endpoint');
    const { routes } = await harness.gozar.listRoutes({ home, owner: 'dalan' });
    const [route] = routes;
    if (preparedId) assert.deepEqual(routes.map(view => view.operationId), [preparedId]);
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
    if (testReproof) {
      challengeAvailable = false;
      await waitForResource(resourceFile, false);
      assert.deepEqual([...resources.keys()], ['foreign', 'owned']);
      assert.deepEqual(removed, []);
      challengeAvailable = true;
      await waitForResource(resourceFile, true);
      assert.equal((await readFile(resourceFile, 'utf8')).trim(), url);
      const { routes: resumed } = await harness.gozar.listRoutes({ home, owner: 'dalan' });
      assert.deepEqual(resumed.map(view => view.handle), [route.handle]);
      t.diagnostic('The installed SDK withdrew proof after a failed nonce read, and Dalan restored the same handoff when proof returned.');
    }
    assert.doesNotMatch(output, /candidateToken|approvalToken/);
    stop.abort();
    await run;
    assert.deepEqual(removed, ['owned']);
    assert.equal(resources.size, 1);
    assert.equal(resources.get('foreign'), foreign);
    if (preparedId) {
      await assert.rejects(readFile(join(trial, '.route-reference.json')), { code: 'ENOENT' });
      t.diagnostic('The prepared operation kept its ID through approval, route proof, bridge traffic and cleanup.');
    }
  } catch (error) {
    bodyFailed = true;
    if (proof && !handedOff) {
      try {
        assert.equal(proof.published, publicOrigin);
        assert.ok(proof.verification.checks.includes('nonce'));
        assert.notEqual(requestedTarget, proof.verification.subject.target);
        assert.deepEqual(removed, ['owned'], 'failed app readiness still closes the exact connector');
        assert.deepEqual([...resources.keys()], ['foreign']);
        assert.doesNotMatch(output, /Waiting for sign-in|Paste this URL/);
        await assert.rejects(readFile(join(trial, 'resource-url')), { code: 'ENOENT' });
        t.diagnostic('SDK nonce proof reached the gate, Dalan refused the host, and cleanup preserved the foreign sentinel without handoff.');
      } catch (secondary) {
        t.diagnostic(`failure-path assertions also failed: ${secondary?.message ?? secondary}`);
      }
    }
    throw error;
  }
});

async function waitForResource(file, expected) {
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    const present = await readFile(file).then(() => true, error => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    });
    if (present === expected) return;
    await sleep(75);
  }
  assert.fail(`The trial connector URL should be ${expected ? 'published' : 'withdrawn'}.`);
}
