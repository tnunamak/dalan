import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireUpdateLock } from '../src/service-update-lock.mjs';
import { updateService, serviceStatus } from '../src/service-update.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-update-test-'));
const release = { name: '@tnunamak/dalan', version: '0.7.0', dist: { integrity: 'sha512-test' } };
function fixture(overrides = {}) {
  const home = path.join(tmp, Math.random().toString(16).slice(2));
  fs.mkdirSync(path.join(home, '.config', 'dot-bridge'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, 'versions', '0.6.0'), { recursive: true });
  const repo = path.join(home, 'versions', '0.6.0', 'node_modules', '@tnunamak', 'dalan');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version: '0.6.0' }));
  fs.symlinkSync(path.relative(home, repo), path.join(home, 'current'));
  fs.writeFileSync(path.join(home, '.config', 'dot-bridge', 'service-install.json'), JSON.stringify({ schema_version: 1, home, unit: 'dalan-unit', workers: ['codex'], repo, node: process.execPath, unit_dir: path.join(home, 'units'), auto_update: true }), { mode: 0o600 });
  fs.writeFileSync(path.join(home, '.config', 'dot-bridge', 'workers.json'), JSON.stringify({ workers: { codex: { repos: [] } } }), { mode: 0o600 });
  fs.mkdirSync(path.join(home, 'units'), { recursive: true });
  fs.writeFileSync(path.join(home, 'units', 'dalan-unit.service'), `WorkingDirectory=${repo}\nExecStart=${process.execPath} ${repo}/src/server.mjs\n`, { mode: 0o600 });
  const events = [];
  const seams = {
    latestRelease: async () => release,
    installRelease: async (_home, r) => { events.push('install'); const candidate = path.join(home, 'versions', r.version, 'node_modules', '@tnunamak', 'dalan'); fs.mkdirSync(candidate, { recursive: true }); fs.writeFileSync(path.join(candidate, 'package.json'), JSON.stringify({ name: '@tnunamak/dalan', version: r.version })); return candidate; },
    probeService: async home => ({ version: JSON.parse(fs.readFileSync(path.join(fs.realpathSync(path.join(home, 'current')), 'package.json'), 'utf8')).version, catalogs: { codex: [{ name: 'ping', inputSchema: { type: 'object' } }] } }),
    probeCandidate: async () => ({ version: '0.7.0', catalogs: { codex: [{ name: 'ping', inputSchema: { type: 'object' } }] } }),
    controlService: async (_receipt, action) => { events.push(action); },
    ...overrides,
  };
  return { home, events, seams, repo };
}

try {
  {
    const f = fixture(); const r = await updateService({ home: f.home, check: true }, f.seams);
    assert.equal(r.outcome, 'update_available'); assert.deepEqual(f.events, []);
  }
  {
    const f = fixture({ latestRelease: async () => ({ ...release, version: '0.6.0' }) });
    const r = await updateService({ home: f.home }, f.seams);
    assert.equal(r.outcome, 'up_to_date'); assert.deepEqual(f.events, []);
  }
  {
    let guardAtRestart = false;
    const f = fixture({ controlService: async (_receipt, action) => { if (action === 'restart') guardAtRestart = fs.existsSync(path.join(f.home, '.config', 'dot-bridge', 'service-catalog.json')); f.events.push(action); } });
    const r = await updateService({ home: f.home }, f.seams);
    assert.equal(r.outcome, 'updated'); assert.equal(fs.realpathSync(path.join(f.home, 'current')), fs.realpathSync(path.join(f.home, 'versions', '0.7.0', 'node_modules', '@tnunamak', 'dalan')));
    assert.equal(serviceStatus({ home: f.home }).version, '0.7.0');
    assert.equal(guardAtRestart, true);
    assert.equal(fs.existsSync(path.join(f.home, '.config', 'dot-bridge', 'service-catalog.json')), false);
  }
  {
    const f = fixture();
    for (const v of ['0.1.0', '0.2.0', '0.3.0', '0.4.0', '0.5.0']) fs.mkdirSync(path.join(f.home, 'versions', v), { recursive: true });
    await updateService({ home: f.home }, f.seams);
    const kept = fs.readdirSync(path.join(f.home, 'versions')).sort();
    assert.ok(kept.includes('0.6.0') && kept.includes('0.7.0')); assert.ok(kept.length <= 3);
  }
  {
    const f = fixture({ pruneVersions: () => { throw new Error('prune denied'); } });
    const r = await updateService({ home: f.home }, f.seams);
    assert.equal(r.outcome, 'updated'); assert.match(r.cleanup_warning, /pruning failed: prune denied/);
    assert.equal(fs.realpathSync(path.join(f.home, 'current')), fs.realpathSync(path.join(f.home, 'versions', '0.7.0', 'node_modules', '@tnunamak', 'dalan')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, '.config', 'dot-bridge', 'service-install.json'), 'utf8')).version, '0.7.0');
  }
  {
    const f = fixture(), releaseLock = acquireUpdateLock(f.home);
    try { await assert.rejects(updateService({ home: f.home }, f.seams), /already running/); } finally { releaseLock(); }
  }
  {
    const f = fixture();
    const candidate = path.join(f.home, 'versions', '0.7.0', 'node_modules', '@tnunamak', 'dalan');
    fs.mkdirSync(candidate, { recursive: true }); fs.writeFileSync(path.join(candidate, 'package.json'), JSON.stringify({ name: '@tnunamak/dalan', version: '0.7.0' }));
    const txDir = path.join(f.home, 'update-backup'), snapshot = path.join(txDir, 'snapshot');
    fs.mkdirSync(snapshot, { recursive: true }); fs.cpSync(path.join(f.home, '.config'), path.join(snapshot, '.config'), { recursive: true });
    fs.writeFileSync(path.join(snapshot, '.snapshot-complete.json'), JSON.stringify({ complete: true, roots: { '.config': true, '.local': false } }));
    fs.writeFileSync(path.join(f.home, '.config', 'dot-bridge', 'marker'), 'mutated');
    fs.unlinkSync(path.join(f.home, 'current')); fs.symlinkSync(path.relative(f.home, candidate), path.join(f.home, 'current'));
    fs.writeFileSync(path.join(f.home, 'update-transaction.json'), JSON.stringify({ home: f.home, oldRepo: f.repo, candidate, snapshot, unitFile: path.join(f.home, 'units', 'dalan-unit.service'), oldUnit: `WorkingDirectory=${f.repo}\nExecStart=${process.execPath} ${f.repo}/src/server.mjs\n`, oldCatalogs: { codex: [{ name: 'ping', inputSchema: { type: 'object' } }] }, oldVersion: '0.6.0', phase: 'switched' }));
    await updateService({ home: f.home }, { ...f.seams, latestRelease: async () => ({ ...release, version: '0.6.0' }) });
    assert.equal(fs.realpathSync(path.join(f.home, 'current')), fs.realpathSync(f.repo));
    assert.equal(fs.existsSync(path.join(f.home, '.config', 'dot-bridge', 'marker')), false);
    assert.equal(fs.existsSync(path.join(f.home, '.config', 'dot-bridge', 'service-catalog.json')), false);
    assert.deepEqual(f.events.slice(0, 3), ['stop', 'daemon-reload', 'restart']);
  }
  {
    const f = fixture();
    const candidate = path.join(f.home, 'versions', '0.7.0', 'node_modules', '@tnunamak', 'dalan');
    fs.mkdirSync(candidate, { recursive: true }); fs.writeFileSync(path.join(candidate, 'package.json'), JSON.stringify({ name: '@tnunamak/dalan', version: '0.7.0' }));
    const snapshot = path.join(f.home, 'update-backup', 'snapshot'); fs.mkdirSync(snapshot, { recursive: true });
    fs.unlinkSync(path.join(f.home, 'current')); fs.symlinkSync(path.relative(f.home, candidate), path.join(f.home, 'current'));
    fs.writeFileSync(path.join(f.home, 'update-transaction.json'), JSON.stringify({ home: f.home, oldRepo: f.repo, candidate, snapshot, oldVersion: '0.6.0', phase: 'switched' }));
    fs.writeFileSync(path.join(f.home, '.config', 'dot-bridge', 'keep'), 'important');
    await assert.rejects(updateService({ home: f.home }, f.seams), /snapshot is missing or incomplete/);
    assert.equal(fs.readFileSync(path.join(f.home, '.config', 'dot-bridge', 'keep'), 'utf8'), 'important');
    assert.equal(fs.realpathSync(path.join(f.home, 'current')), fs.realpathSync(candidate));
    assert.deepEqual(f.events, []);
  }
  {
    const f = fixture({ probeCandidate: async () => { throw new Error('selfcheck'); } });
    await assert.rejects(updateService({ home: f.home }, f.seams), /selfcheck/);
    assert.equal(fs.realpathSync(path.join(f.home, 'current')), fs.realpathSync(f.repo)); assert.ok(!f.events.includes('stop'));
  }
  {
    const changed = { codex: [{ name: 'new-tool' }] };
    const f = fixture({ probeService: async home => ({ version: JSON.parse(fs.readFileSync(path.join(fs.realpathSync(path.join(home, 'current')), 'package.json'), 'utf8')).version, catalogs: fs.realpathSync(path.join(home, 'current')).includes('0.7.0') ? changed : { codex: [{ name: 'ping', inputSchema: { type: 'object' } }] } }), probeCandidate: async () => ({ version: '0.7.0', catalogs: changed }) });
    const r = await updateService({ home: f.home }, f.seams);
    assert.equal(r.outcome, 'connector_refresh_required'); assert.ok(!f.events.includes('stop'));
  }
  {
    const changed = { codex: [{ name: 'new-tool' }] };
    const f = fixture({ probeService: async home => ({ version: JSON.parse(fs.readFileSync(path.join(fs.realpathSync(path.join(home, 'current')), 'package.json'), 'utf8')).version, catalogs: fs.realpathSync(path.join(home, 'current')).includes('0.7.0') ? changed : { codex: [{ name: 'ping', inputSchema: { type: 'object' } }] } }), probeCandidate: async () => ({ version: '0.7.0', catalogs: changed }) });
    const r = await updateService({ home: f.home, yes: true }, f.seams);
    assert.equal(r.outcome, 'updated');
  }
  {
    const f = fixture({ controlService: async (_receipt, action) => { f.events.push(action); if (action === 'restart') throw new Error('restart failed'); } });
    await assert.rejects(updateService({ home: f.home, yes: true }, f.seams), /restart failed/);
    assert.equal(fs.realpathSync(path.join(f.home, 'current')), fs.realpathSync(f.repo));
    assert.equal(fs.existsSync(path.join(f.home, '.config', 'dot-bridge', 'service-catalog.json')), false);
  }
  {
    let stopped = false;
    const f = fixture({ controlService: async (_receipt, action) => { f.events.push(action); if (action === 'stop' && !stopped) { stopped = true; throw new Error('stop failed'); } } });
    await assert.rejects(updateService({ home: f.home }, f.seams), /stop failed/);
    assert.equal(fs.realpathSync(path.join(f.home, 'current')), fs.realpathSync(f.repo));
    assert.ok(f.events.includes('restart'));
  }
  {
    let candidateChecks = 0;
    const f = fixture({
      controlService: async (_receipt, action) => { f.events.push(action); if (action === 'stop') fs.writeFileSync(path.join(f.home, '.config', 'dot-bridge', 'workers.json'), JSON.stringify({ workers: { codex: { repos: ['changed'] } } }), { mode: 0o600 }); },
      probeCandidate: async () => { candidateChecks++; return { version: '0.7.0', catalogs: { codex: [{ name: 'ping', inputSchema: { type: 'object' } }] } }; },
    });
    await assert.rejects(updateService({ home: f.home }, f.seams), /configuration changed while stopping/);
    assert.equal(fs.realpathSync(path.join(f.home, 'current')), fs.realpathSync(f.repo));
    assert.equal(candidateChecks, 1);
  }
  {
    let probes = 0;
    const f = fixture({
      probeService: async home => { if (++probes >= 3) throw new Error('old service unhealthy'); return { version: JSON.parse(fs.readFileSync(path.join(fs.realpathSync(path.join(home, 'current')), 'package.json'), 'utf8')).version, catalogs: { codex: [{ name: 'ping', inputSchema: { type: 'object' } }] } }; },
      controlService: async (_receipt, action) => { f.events.push(action); if (action === 'restart' && f.events.filter(x => x === 'restart').length === 1) throw new Error('candidate restart failed'); },
    });
    await assert.rejects(updateService({ home: f.home, yes: true }, f.seams), /rollback failed: old service unhealthy/);
    assert.equal(fs.realpathSync(path.join(f.home, 'current')), fs.realpathSync(f.repo));
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
