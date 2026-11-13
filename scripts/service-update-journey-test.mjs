import assert from 'node:assert/strict';
import { createFakeGozar } from '../src/test-support/gozar-fake.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { installService } from '../src/service.mjs';
import { updateService, serviceStatus } from '../src/service-update.mjs';
import { probeService, probeCandidate } from '../src/service-update-runtime.mjs';
import { defaultPath } from '../src/paths.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const scratch = path.join(os.homedir(), '.tmp');
fs.mkdirSync(scratch, { recursive: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('isolated two-worker bridge stages, switches with consent, and restores data on restart failure', { timeout: 90000 }, async () => {
  const root = fs.mkdtempSync(path.join(scratch, 'uj-')), home = path.join(root, 'h');
  let child, errors = '', failRestart = false;
  const installOptions = { home, origin: 'https://update.example.test', port: 18791, target: '127.0.0.1:18791', workers: ['fern', 'muse'], enableWorkspace: true, enableT3: true, autoUpdate: false };
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, 'xdg') };
  const cli = args => {
    const result = spawnSync(process.execPath, [path.join(repo, 'bin/dalan.mjs'), ...args, '--json'], {
      env: { ...env, DALAN_HOME: home }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
    await exited; clearTimeout(timer); child = null;
  }
  async function start() {
    const receipt = JSON.parse(fs.readFileSync(path.join(defaultPath(home, '.config/dot-bridge'), 'service-install.json')));
    const selected = fs.realpathSync(path.join(home, 'current'));
    child = spawn(process.execPath, [path.join(selected, 'src/server.mjs')], { cwd: selected, env: {
      PATH: process.env.PATH, HOME: home, NODE_ENV: 'test', DALAN_AUTH_MODE: 'builtin', DALAN_BIND_HOST: '127.0.0.1', DALAN_PORT: '0',
      DALAN_CATALOG_PROFILE: 'stable', DALAN_ENABLE_WORKSPACE: '1', DALAN_ENABLE_T3_TOOLS: '1',
    }, stdio: ['ignore', 'ignore', 'pipe'] });
    errors = ''; child.stderr.on('data', b => { errors = (errors + b).slice(-3000); });
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null) throw new Error(`fixture bridge failed: ${errors}`);
      try { await probeService(home, { ...receipt, repo: selected }); return; } catch {}
      await delay(50);
    }
    throw new Error(`fixture bridge timed out: ${errors}`);
  }
  function packageFixture(version, changed) {
    const candidate = path.join(home, 'versions', version, 'node_modules/@tnunamak/dalan');
    fs.mkdirSync(candidate, { recursive: true });
    for (const dir of ['src', 'packages/job-core', 'scripts/lib', 'scripts/live-trial', 'integrations/t3/acp-kit/src', 'docs']) {
      fs.cpSync(path.join(repo, dir), path.join(candidate, dir), { recursive: true, filter: source => !source.includes('/node_modules') && !source.includes('/__pycache__') });
    }
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(candidate, 'node_modules'));
    fs.writeFileSync(path.join(candidate, 'package.json'), JSON.stringify({ name: '@tnunamak/dalan', version, type: 'module' }));
    if (changed) {
      const file = path.join(candidate, 'src/server.mjs');
      const original = fs.readFileSync(file, 'utf8');
      // Change an actual exposed descriptor while preserving its name and schema.
      const at = original.indexOf('// During an update, refuse a changed catalog');
      assert(at > 0);
      fs.writeFileSync(file, original.slice(0, at) + "tools[0]={...tools[0],description:tools[0].description+' Changed release description.'};\n" + original.slice(at));
    }
    return candidate;
  }
  try {
    await installService(installOptions, { env, platform: 'linux', repo, gozar: createFakeGozar(), spawn: (command) => ({ status: 0, stdout: command === 'gozar' ? JSON.stringify({ schemaVersion: 1, route: { origin: installOptions.origin, target: installOptions.target, verification: { status: 'verified' } } }) : '' }), waitForSocket: async () => true });
    await start();
    const receipt = JSON.parse(fs.readFileSync(path.join(defaultPath(home, '.config/dot-bridge'), 'service-install.json')));
    const originalVersion = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'))).version;
    assert.deepEqual(Object.keys((await probeService(home, receipt)).catalogs).sort(), ['fern', 'muse']);
    const assignment = path.join(root, 'queued-job.json'), requestId = 'req_update_journey';
    fs.writeFileSync(assignment, JSON.stringify({ schema_version: 1, request_id: requestId,
      brief: 'Keep this queued job across an update.', inputs: [], expected_output: 'one report', execution_scope: 'read-only' }));
    cli(['submit', '--execution', 'worker', '--worker', 'fern', '--file', assignment]);
    assert.equal(cli(['get', requestId]).status, 'queued');
    const candidate = packageFixture('0.7.0', true);
    const release = version => ({ name: '@tnunamak/dalan', version, dist: { integrity: 'sha512-Zml4dHVyZQ==', tarball: 'https://registry.npmjs.org/fixture.tgz' } });
    const seams = {
      latestRelease: async () => release('0.7.0'), installRelease: async () => candidate,
      probeCandidate: async (...args) => {
        let diagnostic = '';
        try { return await probeCandidate(...args, { spawn: (command, argv, options) => {
          const process = spawn(command, argv, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
          process.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-3000); });
          return process;
        } }); } catch (error) { throw new Error(`${error.message}: ${diagnostic}`); }
      },
      controlService: async (_receipt, action) => {
        if (action === 'daemon-reload') return;
        if (action === 'stop') return stop();
        assert.equal(action, 'restart');
        if (failRestart && fs.realpathSync(path.join(home, 'current')).includes('/0.8.0/')) {
          fs.writeFileSync(path.join(defaultPath(home, '.local/share/dot-bridge'), 'migration-sentinel'), 'corrupted');
          throw new Error('injected restart failure after state mutation');
        }
        await stop(); await start();
      },
    };
    const staged = await updateService({ home }, seams);
    assert.equal(staged.outcome, 'connector_refresh_required');
    assert.equal(fs.realpathSync(path.join(home, 'current')), repo);
    assert.equal((await probeService(home, receipt)).version, originalVersion);
    const applied = await updateService({ home, yes: true }, seams);
    assert.equal(applied.outcome, 'updated');
    assert.equal((await probeService(home, { ...receipt, repo: candidate })).version, '0.7.0');
    assert.equal(serviceStatus({ home }).version, '0.7.0');
    assert.equal(cli(['get', requestId]).status, 'queued', 'the update retains queued work and its owner receipt');
    const next = packageFixture('0.8.0', true);
    const sentinel = path.join(defaultPath(home, '.local/share/dot-bridge'), 'migration-sentinel');
    fs.writeFileSync(sentinel, 'saved'); failRestart = true;
    await assert.rejects(updateService({ home }, { ...seams, latestRelease: async () => release('0.8.0'), installRelease: async () => next }), /injected restart failure/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'saved');
    assert.equal(fs.realpathSync(path.join(home, 'current')), candidate);
    assert.equal((await probeService(home, { ...receipt, repo: candidate })).version, '0.7.0');
    assert.equal(serviceStatus({ home }).version, '0.7.0');
    assert.equal(cli(['get', requestId]).status, 'queued', 'rollback retains queued work and its owner receipt');
  } finally { await stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
