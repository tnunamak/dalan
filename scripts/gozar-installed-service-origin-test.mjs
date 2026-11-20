import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolveGozar } from '../src/gozar-routes.mjs';
import { serviceMain } from '../src/service.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

test('service install approves and proves an existing HTTPS origin, then removes only its tracking', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(homedir(), '.tmp', 'de-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bridge = path.join(root, 'd'), home = path.join(root, 'g');
  const env = { ...process.env, HOME: root, DALAN_HOME: bridge, GOZAR_HOME: home, XDG_CONFIG_HOME: path.join(root, 'c') };
  await mkdir(home, { mode: 0o700 });
  const hostname = 'existing-' + randomUUID().slice(0, 8) + '.test';
  const keyFile = path.join(root, 'key.pem'), certFile = path.join(root, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1', '-nodes',
    '-subj', '/CN=' + hostname, '-addext', 'subjectAltName=DNS:' + hostname, '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
  const cert = await readFile(certFile);
  const existingAgent = https.globalAgent;
  function lookup(host, options, callback) {
    if (host !== hostname) return dns.lookup(host, options, callback);
    if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
    else callback(null, '127.0.0.1', 4);
  }
  const agent = new https.Agent({ ca: cert, lookup });
  https.globalAgent = agent;
  const preload = path.join(root, 'fixture-lookup.mjs');
  await writeFile(preload, `import https from 'node:https'; import dns from 'node:dns';
    const hostname = ${JSON.stringify(hostname)};
    https.globalAgent = new https.Agent({ lookup: ${lookup} });`, { mode: 0o600 });
  const probe = net.createServer();
  await listen(probe);
  const port = probe.address().port, target = '127.0.0.1:' + port;
  await new Promise(resolve => probe.close(resolve));
  let challengeCount = 0, allowChallenge = true;
  const relay = https.createServer({ key: await readFile(keyFile), cert }, (req, res) => {
    if (req.url.startsWith('/.well-known/gozar/service?nonce=')) {
      challengeCount++;
      if (!allowChallenge) { res.writeHead(502); res.end(); return; }
    }
    const request = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, reply => {
      res.writeHead(reply.statusCode, reply.headers);
      reply.pipe(res);
    });
    request.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(request);
  });
  await listen(relay);
  const origin = 'https://' + hostname + ':' + relay.address().port;
  let child, childExit;
  try {
    const gozar = await resolveGozar({ env, home });
    const args = ['--public-url', origin, '--port', String(port), '--target', target, '--home', bridge];
    const install = ['install', '--worker', 'fixture', '--no-auto-update', ...args];
    const startBridge = async () => {
      if (child) return true;
      child = spawn(process.execPath, ['src/server.mjs'], { cwd: repo,
        env: { PATH: env.PATH, HOME: bridge, DALAN_AUTH_MODE: 'builtin', DALAN_GOZAR_SERVICE: '1', DALAN_PORT: String(port),
          NODE_EXTRA_CA_CERTS: certFile, NODE_OPTIONS: '--import=' + preload },
        stdio: 'ignore' });
      childExit = once(child, 'exit');
      for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
        try {
          if (await status(origin + '/admin') === 404) return true;
        } catch { /* server has not bound yet */ }
        await sleep(50);
      }
      return false;
    };
    const seams = { env, gozar, platform: 'linux', spawn: () => ({ status: 0, stdout: '' }),
      waitForSocket: startBridge, out: () => {} };
    const catalogRoutes = gozar.catalogRoutes;
    gozar.catalogRoutes = async query => {
      const catalog = await catalogRoutes(query);
      return { ...catalog, candidates: catalog.candidates.filter(candidate => candidate.ownership !== 'external-owned') };
    };
    const resourceFile = path.join(bridge, 'resource-url');
    await assert.rejects(serviceMain(install, { ...seams, consent: async () => assert.fail('no owner-managed offer') }),
      { code: 'requirements_unsatisfied' });
    assert.equal(challengeCount, 0);
    assert.deepEqual((await gozar.listRoutes({ home, owner: 'dalan' })).routes, []);
    await assert.rejects(readFile(resourceFile), { code: 'ENOENT' });
    gozar.catalogRoutes = catalogRoutes;
    await assert.rejects(serviceMain(install, { ...seams, consent: async () => false }), { code: 'consent_required' });
    assert.equal(challengeCount, 0);
    await assert.rejects(readFile(resourceFile), { code: 'ENOENT' });

    let reviews = 0;
    const result = await serviceMain(install, { ...seams, consent: async candidate => {
      reviews++;
      assert.equal(candidate.ownership, 'external-owned');
      assert.equal(candidate.consent.disclosures.ownership, 'external-owned');
      assert.equal(candidate.consent.scope.query.expectedOrigin, origin);
      assert.equal(candidate.consent.scope.query.target, target);
      return true;
    } });
    assert.equal(reviews, 1);
    assert.equal(result.origin, origin);
    assert.equal(result.route.ownership, 'external-owned');
    assert.equal(result.route.verification.subject.origin, origin);
    assert.equal(result.route.verification.subject.target, target);
    assert.equal(result.route.verification.subject.handleGeneration, result.route.handle.generation);
    assert.deepEqual(result.route.verification.checks, ['nonce', 'tls']);
    assert.ok(challengeCount > 0);
    assert.equal(new URL((await readFile(resourceFile, 'utf8')).trim()).origin, origin);
    allowChallenge = false;
    await waitForHandoff(resourceFile, false);
    assert.equal(await status(origin + '/admin'), 404);
    allowChallenge = true;
    await waitForHandoff(resourceFile, true);
    await assert.rejects(serviceMain(['uninstall', '--home', bridge], { ...seams, confirmRouteStop: async () => false }), /explicit approval/);
    const retained = await gozar.routeStatus({ home, handle: result.route.handle });
    assert.equal(retained.published, origin);
    const closeRoute = gozar.closeRoute;
    let relayAfterClose;
    gozar.closeRoute = async request => {
      const closed = await closeRoute(request);
      relayAfterClose = await status(origin + '/admin');
      return closed;
    };
    const uninstalled = await serviceMain(['uninstall', '--home', bridge], { ...seams, confirmRouteStop: async handle => {
      assert.deepEqual(handle, result.route.handle);
      return true;
    } });
    assert.ok(uninstalled.removed.includes('public route released'));
    const closed = (await gozar.listRoutes({ home, owner: 'dalan' })).routes.find(view => view.operationId === result.route.operationId);
    assert.equal(closed?.cleanup.state, 'confirmed');
    assert.deepEqual(closed.handle, result.route.handle);
    assert.equal(relayAfterClose, 404);
    assert.equal(relay.listening, true);
    t.diagnostic('Dalan withdrew the connector URL when challenge proof failed and restored it after proof returned. The exact SDK tracking record was removed while TLS still reached Dalan.');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await childExit;
    agent.destroy();
    https.globalAgent = existingAgent;
    await new Promise(resolve => { relay.close(resolve); relay.closeAllConnections(); });
  }
});

function status(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
}

async function waitForHandoff(file, expected) {
  const deadline = Date.now() + 11000;
  do {
    const present = await readFile(file).then(() => true, error => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    });
    if (present === expected) return;
    await sleep(100);
  } while (Date.now() < deadline);
  assert.fail(`The connector URL should be ${expected ? 'published' : 'withdrawn'}.`);
}
