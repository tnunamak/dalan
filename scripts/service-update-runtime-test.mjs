import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { latestRelease, installRelease, controlService, probeService, probeCandidate } from '../src/service-update-runtime.mjs';
import { initAsFiles } from '../src/as-files.mjs';

const testScratch = path.join(os.homedir(), '.tmp'); fs.mkdirSync(testScratch, { recursive: true, mode: 0o700 });
const tmp = fs.mkdtempSync(path.join(testScratch, 'du-'));
const packageDir = path.join(tmp, 'package'); fs.mkdirSync(packageDir);
fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@tnunamak/dalan', version: '0.7.0', files: ['index.js'] }));
fs.writeFileSync(path.join(packageDir, 'index.js'), 'export default 7;\n');
const pack = spawnSync('npm', ['pack', '--pack-destination', tmp], { cwd: packageDir, encoding: 'utf8' });
assert.equal(pack.status, 0, pack.stderr);
const tarball = fs.readFileSync(path.join(tmp, 'tnunamak-dalan-0.7.0.tgz'));
const integrity = 'sha512-' + createHash('sha512').update(tarball).digest('base64');
let release;
const server = http.createServer((req, res) => {
  if (req.url === '/dalan-0.7.0.tgz') { res.setHeader('content-type', 'application/octet-stream'); return res.end(tarball); }
  release = { name: '@tnunamak/dalan', version: '0.7.0', dist: { tarball: new URL(`file://${path.join(tmp, 'tnunamak-dalan-0.7.0.tgz')}`).href, integrity } };
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(release));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const registry = `http://127.0.0.1:${server.address().port}`;
try {
  assert.deepEqual(await latestRelease({}, { registry }), release);
  await assert.rejects(latestRelease({}, { registry: 'http://example.com' }), /HTTPS/);
  await assert.rejects(latestRelease({}, { registry: 'https://example.invalid' }), /registry|ENOTFOUND|fetch/i);

  const home = path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
  let runs = 0;
  const fakeNpm = async (_command, args, { cwd }) => {
    runs++;
    if (args.includes('--package-lock-only')) {
      fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@tnunamak/dalan': { integrity } } }));
    } else {
      const dir = path.join(cwd, 'node_modules', '@tnunamak', 'dalan'); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@tnunamak/dalan', version: '0.7.0' }));
    }
  };
  const installed = await installRelease(home, release, { run: fakeNpm, registry });
  assert.equal(path.basename(installed), 'dalan'); assert.equal(runs, 2);
  assert.equal(await installRelease(home, release, { run: () => assert.fail('verified install should be reused'), registry }), installed);
  const bad = { ...release, dist: { ...release.dist, integrity: 'sha512-' + Buffer.alloc(64, 8).toString('base64') } };
  await assert.rejects(installRelease(home, bad, { run: fakeNpm, registry }), /integrity/);

  const realHome = path.join(tmp, 'real-home'); fs.mkdirSync(realHome);
  const realInstalled = await installRelease(realHome, release, { registry, timeout: 60_000 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(realInstalled, 'package.json'), 'utf8')).version, '0.7.0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(realHome, 'versions', '0.7.0', '.dalan-release.json'), 'utf8')).integrity, integrity);
  const corrupt = { ...release, dist: { ...release.dist, integrity: 'sha512-' + Buffer.alloc(64, 3).toString('base64') } };
  const badHome = path.join(tmp, 'bad-home');
  await assert.rejects(installRelease(badHome, corrupt, { registry, timeout: 60_000 }), /integrity/);
  assert.deepEqual(fs.readdirSync(path.join(badHome, 'versions')), [], 'failed install must remove its staging directory');

  const config = path.join(home, '.config', 'dot-bridge');
  fs.mkdirSync(config, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(config, 'operator.key'), 'operator-secret\n', { mode: 0o600 });
  fs.writeFileSync(path.join(config, 'as.json'), JSON.stringify({ version: 1, public_url: 'https://example.test', callbacks: [] }), { mode: 0o600 });
  fs.writeFileSync(path.join(config, 'workers.json'), JSON.stringify({ workers: { codex: { repos: [] } } }), { mode: 0o600 });
  const candidate = path.join(tmp, 'candidate'); fs.mkdirSync(path.join(candidate, 'src'), { recursive: true });
  fs.writeFileSync(path.join(candidate, 'package.json'), JSON.stringify({ name: '@tnunamak/dalan', version: '0.6.0' }));
  const failedScratch = [];
  await assert.rejects(probeCandidate(home, { enable_workspace: false, enable_t3: false }, candidate, { spawn: (_command, _args, options) => {
    failedScratch.push(options.env.HOME); throw new Error('spawn failed');
  } }), /spawn failed/);
  await assert.rejects(probeCandidate(home, { node: path.join(tmp, 'missing-node'), enable_workspace: false, enable_t3: false }, candidate, { spawn: (command, args, options) => {
    failedScratch.push(options.env.HOME); return spawn(command, args, options);
  } }), /could not start/);
  assert.equal(failedScratch.length, 2);
  assert(failedScratch.every(directory => !fs.existsSync(directory)), 'failed probes remove their own scratch without depending on other concurrent probes');

  const socketDir = path.join(home, '.local', 'share', 'dot-bridge'); fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  const socketPath = path.join(socketDir, 'admin.sock');
  const admin = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ version: '0.6.0', catalogs: { codex: [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object' } }] }, port: 65535, self_check: false })); });
  await new Promise((resolve, reject) => admin.listen(socketPath, error => error ? reject(error) : resolve()));
  await assert.rejects(probeService(home, { repo: candidate }), /self-check response/);
  await new Promise(resolve => admin.close(resolve));
  const hanging = http.createServer((req, res) => {
    const drip = setInterval(() => res.write(' '), 5);
    res.on('close', () => clearInterval(drip));
  });
  await new Promise((resolve, reject) => hanging.listen(socketPath, error => error ? reject(error) : resolve()));
  const started = Date.now();
  const hangingProbe = probeService(home, { repo: candidate }, { timeout: 50 });
  let raceTimer;
  try {
    const outcome = await Promise.race([hangingProbe.then(value => ({ value }), error => ({ error })), new Promise(resolve => { raceTimer = setTimeout(() => resolve(null), 500); })]);
    assert.notEqual(outcome, null, 'admin probe ignored its absolute request deadline while response bytes continued');
    assert.ok(outcome.error && /timed out/.test(outcome.error.message), 'admin probe must reject on its absolute request deadline');
    assert.ok(Date.now() - started < 500, 'admin probe must honor its total request timeout');
  } finally {
    clearTimeout(raceTimer);
    hanging.closeAllConnections();
    await new Promise(resolve => hanging.close(resolve));
    await hangingProbe.catch(() => {});
  }

  const isolated = path.join(tmp, 'isolated-service');
  const isolatedConfig = path.join(isolated, '.config', 'dot-bridge');
  fs.mkdirSync(isolatedConfig, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(isolatedConfig, 'workers.json'), JSON.stringify({ workers: { codex: { repos: [] }, claude: { repos: [] } } }), { mode: 0o600 });
  initAsFiles(isolatedConfig, { publicUrl: 'https://service-check.example.test' });
  fs.writeFileSync(path.join(isolatedConfig, 'operator.key'), 'isolated-operator-key\n', { mode: 0o600 });
  let unauthorizedStatus = null, unauthorizedError = null, unauthorizedCheck = Promise.resolve(), candidateStarts = 0;
  const candidateSpawn = (command, args, options) => {
    candidateStarts++;
    const child = spawn(command, args, options);
    if (candidateStarts === 1) return child;
    unauthorizedCheck = (async () => {
      const socket = path.join(options.env.HOME, '.local', 'share', 'dalan', 'admin.sock');
      for (let i = 0; i < 160 && !fs.existsSync(socket); i++) await new Promise(resolve => setTimeout(resolve, 50));
      if (!fs.existsSync(socket)) { unauthorizedError = new Error('candidate admin socket did not appear'); return; }
      await new Promise(resolve => {
        const req = http.request({ socketPath: socket, path: '/service-check', method: 'GET', headers: { 'x-operator-key': 'wrong-key' }, timeout: 1500 }, res => {
          unauthorizedStatus = res.statusCode; res.resume(); res.on('end', resolve);
        });
        req.on('timeout', () => req.destroy(new Error('unauthorized check timed out')));
        req.on('error', error => { unauthorizedError = error; resolve(); }); req.end();
      });
    })().catch(error => { unauthorizedError = error; });
    return child;
  };
  const probe = await probeCandidate(isolated, { node: process.execPath, enable_workspace: true, enable_t3: true }, fileURLToPath(new URL('..', import.meta.url)), { spawn: candidateSpawn });
  await unauthorizedCheck;
  assert.equal(probe.self_check, true);
  assert.deepEqual(Object.keys(probe.catalogs).sort(), ['claude', 'codex']);
  assert.equal(unauthorizedError, null);
  assert.ok(unauthorizedStatus !== null && unauthorizedStatus !== 200, `wrong operator key returned ${unauthorizedStatus}`);

  let systemctlArgs;
  await controlService({ unit: 'dalan-test' }, 'restart', { run: async (...args) => { systemctlArgs = args; } });
  assert.deepEqual(systemctlArgs[1], ['--user', 'restart', 'dalan-test.service']);
  await assert.rejects(controlService({ unit: 'bad;unit' }, 'restart'), /unit/);
} finally {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}
