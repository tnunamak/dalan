import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireUpdateLock } from '../src/service-update-lock.mjs';
import { spawnSync } from 'node:child_process';
import { updateService, serviceStatus, recoverService } from '../src/service-update.mjs';

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
function interruptedSwitch(f, { config = 'present', receiptCommitted = false } = {}) {
  const candidate = path.join(f.home, 'versions', '0.7.0', 'node_modules', '@tnunamak', 'dalan');
  fs.mkdirSync(candidate, { recursive: true }); fs.writeFileSync(path.join(candidate, 'package.json'), JSON.stringify({ name: '@tnunamak/dalan', version: '0.7.0' }));
  const receiptFile = path.join(f.home, '.config', 'dot-bridge', 'service-install.json');
  const oldReceipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  const txDir = path.join(f.home, 'update-backup'), snapshot = path.join(txDir, 'snapshot');
  fs.mkdirSync(snapshot, { recursive: true }); fs.cpSync(path.join(f.home, '.config'), path.join(snapshot, '.config'), { recursive: true });
  fs.writeFileSync(path.join(snapshot, '.snapshot-complete.json'), JSON.stringify({ complete: true, roots: { '.config': true, '.local': false } }));
  if (receiptCommitted) fs.writeFileSync(receiptFile, JSON.stringify({ ...oldReceipt, repo: candidate, version: '0.7.0' }), { mode: 0o600 });
  if (config === 'missing') fs.rmSync(path.join(f.home, '.config'), { recursive: true, force: true });
  if (config === 'partial') {
    fs.rmSync(path.join(f.home, '.config'), { recursive: true, force: true });
    fs.mkdirSync(path.join(f.home, '.config'), { recursive: true });
    fs.writeFileSync(path.join(f.home, '.config', 'partial'), 'interrupted restore');
  }
  fs.unlinkSync(path.join(f.home, 'current')); fs.symlinkSync(path.relative(f.home, candidate), path.join(f.home, 'current'));
  fs.writeFileSync(path.join(f.home, 'update-transaction.json'), JSON.stringify({ home: f.home, oldRepo: f.repo, candidate, snapshot, unitFile: path.join(f.home, 'units', 'dalan-unit.service'), oldUnit: `WorkingDirectory=${f.repo}\nExecStart=${process.execPath} ${f.repo}/src/server.mjs\n`, oldCatalogs: { codex: [{ name: 'ping', inputSchema: { type: 'object' } }] }, oldVersion: '0.6.0', oldReceipt, phase: 'switched' }), { mode: 0o600 });
  return { candidate, oldReceipt };
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
    const { candidate } = interruptedSwitch(f, { receiptCommitted: true });
    await updateService({ home: f.home }, { ...f.seams, latestRelease: async () => ({ ...release, version: '0.6.0' }) });
    assert.equal(fs.realpathSync(path.join(f.home, 'current')), fs.realpathSync(f.repo));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, '.config', 'dot-bridge', 'service-install.json'), 'utf8')).version, undefined);
    assert.equal(fs.existsSync(path.join(f.home, '.config', 'dot-bridge', 'service-catalog.json')), false);
    assert.deepEqual(f.events.slice(0, 3), ['stop', 'daemon-reload', 'restart']);
    assert.notEqual(candidate, fs.realpathSync(path.join(f.home, 'current')));
  }
  {
    // Updater killed after the pin was written: a plain service start must recover with no control seam.
    const pin = home => path.join(home, '.config', 'dot-bridge', 'service-catalog.json');
    const killed = () => {
      const f = fixture(); const { candidate } = interruptedSwitch(f);
      fs.writeFileSync(pin(f.home), JSON.stringify({ version: '0.7.0', catalogs: {} }));
      fs.writeFileSync(path.join(f.home, '.config', 'dot-bridge', 'junk'), 'candidate state');
      return { f, candidate };
    };
    const assertRecovered = f => {
      assert.equal(fs.realpathSync(path.join(f.home, 'current')), fs.realpathSync(f.repo));
      assert.equal(fs.existsSync(pin(f.home)), false); assert.equal(fs.existsSync(path.join(f.home, '.config', 'dot-bridge', 'junk')), false);
      assert.equal(fs.existsSync(path.join(f.home, 'update-transaction.json')), false);
      assert.equal(fs.existsSync(path.join(f.home, 'update-backup')), false);
      assert.ok(fs.existsSync(path.join(f.home, '.config', 'dot-bridge', 'workers.json')));
    };
    { const { f } = killed(); assert.deepEqual(recoverService({ home: f.home }), { outcome: 'recovered' }); assertRecovered(f); assert.deepEqual(f.events, []);
      assert.deepEqual(recoverService({ home: f.home }), { outcome: 'nothing_pending' }); }
    { const { f, candidate } = killed(), lock = acquireUpdateLock(f.home);
      try { assert.deepEqual(recoverService({ home: f.home }), { outcome: 'update_running' }); } finally { lock(); }
      assert.equal(fs.realpathSync(path.join(f.home, 'current')), fs.realpathSync(candidate));
      assert.ok(fs.existsSync(pin(f.home))); assert.ok(fs.existsSync(path.join(f.home, 'update-transaction.json'))); }
    { const f = fixture(); assert.deepEqual(recoverService({ home: f.home }), { outcome: 'nothing_pending' }); }
    { const { f } = killed();
      const run = spawnSync(process.execPath, [path.resolve('bin/dalan.mjs'), 'service', 'recover', '--home', f.home, '--quiet'], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr); assert.equal(run.stdout, ''); assertRecovered(f); }
  }
  {
    const f = fixture(); await updateService({ home: f.home }, f.seams);
    const unit = fs.readFileSync(path.join(f.home, 'units', 'dalan-unit.service'), 'utf8');
    const pre = unit.split('\n').filter(l => l.startsWith('ExecStartPre='));
    assert.deepEqual(pre, [`ExecStartPre=${process.execPath} ${path.join(f.home, 'current')}/bin/dalan.mjs service recover --home ${f.home} --quiet`]);
  }
  for (const configState of ['missing', 'partial']) {
    const f = fixture();
    const { candidate, oldReceipt } = interruptedSwitch(f, { config: configState });
    const controlReceipts = [];
    const seams = { ...f.seams, latestRelease: async () => ({ ...release, version: '0.6.0' }), controlService: async (r, action) => { controlReceipts.push(r); f.events.push(action); } };
    await updateService({ home: f.home }, seams);
    assert.equal(fs.realpathSync(path.join(f.home, 'current')), fs.realpathSync(f.repo));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, '.config', 'dot-bridge', 'service-install.json'), 'utf8')).home, f.home);
    assert.deepEqual(f.events.slice(0, 3), ['stop', 'daemon-reload', 'restart']);
    assert.ok(controlReceipts.every(r => r.repo === oldReceipt.repo));
    assert.notEqual(candidate, fs.realpathSync(path.join(f.home, 'current')));
  }
  {
    const f = fixture();
    const { candidate } = interruptedSwitch(f);
    fs.rmSync(path.join(f.home, 'update-backup', 'snapshot', '.snapshot-complete.json'));
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
    const original = [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }];
    const changed = [{ name: 'ping', inputSchema: { type: 'object', properties: { request_id: { type: 'string' } }, required: ['request_id'] } }];
    const f = fixture({
      probeService: async () => ({ version: '0.6.0', catalogs: { codex: original, muse: original } }),
      probeCandidate: async () => ({ version: '0.7.0', catalogs: { codex: original, muse: changed } }),
    });
    // A worker added after install is absent from the receipt but still must be checked.
    fs.writeFileSync(path.join(f.home, '.config/dot-bridge/workers.json'), JSON.stringify({ workers: { codex: { repos: [] }, muse: { repos: [] } } }));
    const result = await updateService({ home: f.home }, f.seams);
    assert.equal(result.outcome, 'connector_refresh_required');
    assert(!f.events.includes('stop'), 'a schema change confined to the last configured worker must not switch');
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
    let candidateHealthAttempts = 0;
    const timeouts = [];
    const f = fixture({ probeService: async (home, receipt, options) => {
      if (options?.timeout !== undefined) timeouts.push(options.timeout);
      const version = JSON.parse(fs.readFileSync(path.join(receipt.repo, 'package.json'), 'utf8')).version;
      if (version === '0.7.0') { candidateHealthAttempts++; throw new Error('candidate admin unavailable'); }
      return { version: '0.6.0', catalogs: { codex: [{ name: 'ping', inputSchema: { type: 'object' } }] } };
    } });
    await assert.rejects(updateService({ home: f.home, yes: true }, { ...f.seams, healthTimeoutMs: 80 }), /candidate admin unavailable/);
    assert.ok(candidateHealthAttempts <= 3, `candidate health retried ${candidateHealthAttempts} times`);
    assert.ok(timeouts.length > 0 && timeouts.every(timeout => timeout > 0 && timeout <= 1000));
    assert.equal(fs.realpathSync(path.join(f.home, 'current')), fs.realpathSync(f.repo));
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
    await assert.rejects(updateService({ home: f.home, yes: true }, { ...f.seams, healthTimeoutMs: 100 }), /rollback failed: service health check timed out.*old service unhealthy/);
    assert.equal(fs.realpathSync(path.join(f.home, 'current')), fs.realpathSync(f.repo));
  }
  {
    const f = fixture();
    const marker = path.join(f.home, '.config', 'dot-bridge', 'mutable');
    fs.writeFileSync(marker, 'old');
    const rename = fs.renameSync;
    fs.renameSync = function(source, destination) {
      if (destination === path.join(f.home, 'update-transaction.json') && fs.existsSync(source) && JSON.parse(fs.readFileSync(source, 'utf8')).phase === 'committed') {
        throw new Error('committed journal rename failed');
      }
      return rename.call(fs, source, destination);
    };
    try {
      const seams = { ...f.seams, probeService: async (_home, receipt) => {
        if (receipt.repo.includes('/0.7.0/')) fs.writeFileSync(marker, 'candidate mutation');
        return { version: receipt.repo.includes('/0.7.0/') ? '0.7.0' : '0.6.0', catalogs: { codex: [{ name: 'ping', inputSchema: { type: 'object' } }] } };
      } };
      await assert.rejects(updateService({ home: f.home }, seams), /committed journal rename failed/);
    } finally { fs.renameSync = rename; }
    assert.equal(fs.readFileSync(marker, 'utf8'), 'old');
    assert.equal(fs.realpathSync(path.join(f.home, 'current')), fs.realpathSync(f.repo));
  }
  {
    const f = fixture();
    const marker = path.join(f.home, '.config', 'dot-bridge', 'mutable'); fs.writeFileSync(marker, 'old');
    const rename = fs.renameSync;
    fs.renameSync = function(source, destination) {
      if (destination === path.join(f.home, 'update-transaction.json') && fs.existsSync(source) && JSON.parse(fs.readFileSync(source, 'utf8')).phase === 'committed') {
        rename.call(fs, source, destination);
        throw new Error('committed journal directory sync failed');
      }
      return rename.call(fs, source, destination);
    };
    let result;
    try {
      const seams = { ...f.seams, probeService: async (_home, receipt) => {
        if (receipt.repo.includes('/0.7.0/')) fs.writeFileSync(marker, 'candidate mutation');
        return { version: receipt.repo.includes('/0.7.0/') ? '0.7.0' : '0.6.0', catalogs: { codex: [{ name: 'ping', inputSchema: { type: 'object' } }] } };
      } };
      result = await updateService({ home: f.home }, seams);
    } finally { fs.renameSync = rename; }
    assert.equal(result.outcome, 'updated'); assert.match(result.cleanup_warning, /durability check failed/);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'candidate mutation');
    assert.equal(fs.realpathSync(path.join(f.home, 'current')), fs.realpathSync(path.join(f.home, 'versions', '0.7.0', 'node_modules', '@tnunamak', 'dalan')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, 'update-transaction.json'), 'utf8')).phase, 'committed');
    assert.ok(fs.existsSync(path.join(f.home, 'update-backup', 'snapshot', '.snapshot-complete.json')));
  }
  {
    const f = fixture();
    const marker = path.join(f.home, '.config', 'dot-bridge', 'mutable'); fs.writeFileSync(marker, 'old');
    const rename = fs.renameSync;
    fs.renameSync = function(source, destination) {
      if (destination === path.join(f.home, 'update-transaction.json') && fs.existsSync(source) && JSON.parse(fs.readFileSync(source, 'utf8')).phase === 'committed') {
        fs.writeFileSync(destination, '{ambiguous journal');
        throw new Error('committed journal visibility is ambiguous');
      }
      return rename.call(fs, source, destination);
    };
    try {
      const seams = { ...f.seams, probeService: async (_home, receipt) => {
        if (receipt.repo.includes('/0.7.0/')) fs.writeFileSync(marker, 'candidate mutation');
        return { version: receipt.repo.includes('/0.7.0/') ? '0.7.0' : '0.6.0', catalogs: { codex: [{ name: 'ping', inputSchema: { type: 'object' } }] } };
      } };
      await assert.rejects(updateService({ home: f.home }, seams), /commit state is uncertain/);
    } finally { fs.renameSync = rename; }
    assert.equal(fs.readFileSync(marker, 'utf8'), 'candidate mutation');
    assert.equal(fs.realpathSync(path.join(f.home, 'current')), fs.realpathSync(path.join(f.home, 'versions', '0.7.0', 'node_modules', '@tnunamak', 'dalan')));
    assert.ok(fs.existsSync(path.join(f.home, 'update-backup', 'snapshot', '.snapshot-complete.json')));
  }
  {
    // P2: a rolled-back release is not retried by later runs unless retry is explicit.
    const failOnce = f => { let armed = true; return async (_r, action) => { if (action === 'daemon-reload' && armed) { armed = false; throw new Error('reload failed'); } f.events.push(action); }; };
    const f = fixture(); f.seams.controlService = failOnce(f); f.seams.healthTimeoutMs = 200;
    await assert.rejects(updateService({ home: f.home }, f.seams), /reload failed/);
    assert.equal(serviceStatus({ home: f.home }).failed_release, '0.7.0');
    f.events.length = 0;
    const skipped = await updateService({ home: f.home }, f.seams);
    assert.equal(skipped.outcome, 'skipped_failed_release'); assert.equal(skipped.failed_version, '0.7.0');
    assert.equal(skipped.current_version, '0.6.0'); assert.equal(skipped.latest_version, '0.7.0');
    assert.deepEqual(f.events, []);
    assert.equal(serviceStatus({ home: f.home }).failed_release, '0.7.0');
    const retried = await updateService({ home: f.home, retry: true }, f.seams);
    assert.equal(retried.outcome, 'updated'); assert.ok(f.events.includes('install'));
    assert.equal(serviceStatus({ home: f.home }).failed_release, null);
    assert.equal(fs.existsSync(path.join(f.home, 'update-failed.json')), false);
  }
  for (const [label, next] of [['newer version', { version: '0.8.0', dist: { integrity: 'sha512-test' } }], ['different integrity', { dist: { integrity: 'sha512-other' } }]]) {
    const f = fixture(); let armed = true;
    f.seams.controlService = async (_r, action) => { if (action === 'daemon-reload' && armed) { armed = false; throw new Error('reload failed'); } f.events.push(action); };
    f.seams.healthTimeoutMs = 200;
    await assert.rejects(updateService({ home: f.home }, f.seams), /reload failed/);
    f.events.length = 0;
    const newer = { ...release, ...next };
    f.seams.latestRelease = async () => newer;
    f.seams.probeCandidate = async () => ({ version: newer.version, catalogs: { codex: [{ name: 'ping', inputSchema: { type: 'object' } }] } });
    const r = await updateService({ home: f.home }, f.seams);
    assert.equal(r.outcome, 'updated', label); assert.ok(f.events.includes('install'), label);
    assert.equal(serviceStatus({ home: f.home }).failed_release, null, label);
  }
  // 0.6.0 and 0.6.1 wrote WorkingDirectory from a path that ended in a slash, and ExecStart from the same path through path.join (no double slash).
  for (const slash of ['', '/']) {
    // A 0.6.0/0.6.1 service has no `current` link, no receipt.repo/node/unit_dir, and its package lives outside the updater tree.
    // The first update must adopt it from the unit itself, keep the unit's node binary, and need no hand step.
    const f = fixture();
    const receiptFile = path.join(f.home, '.config', 'dot-bridge', 'service-install.json');
    const legacyReceipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    for (const key of ['repo', 'node', 'unit_dir']) delete legacyReceipt[key];
    fs.writeFileSync(receiptFile, JSON.stringify(legacyReceipt), { mode: 0o600 });
    const legacyRepo = path.join(tmp, 'global-prefix', 'lib', 'node_modules', '@tnunamak', 'dalan'); fs.mkdirSync(legacyRepo, { recursive: true });
    fs.writeFileSync(path.join(legacyRepo, 'package.json'), JSON.stringify({ name: '@tnunamak/dalan', version: '0.6.0' }));
    fs.unlinkSync(path.join(f.home, 'current'));
    const xdg = path.join(tmp, 'xdg'), unitDir = path.join(xdg, 'systemd', 'user'); fs.mkdirSync(unitDir, { recursive: true });
    const misoNode = '/opt/mise/installs/node/24.22.1/bin/node';
    const unitFile = path.join(unitDir, 'dalan-unit.service');
    fs.writeFileSync(unitFile, `[Service]\nWorkingDirectory=${legacyRepo}${slash}\nExecStart=${misoNode} ${path.join(legacyRepo, 'src/server.mjs')}\n`, { mode: 0o600 });
    let probedWith; const previousXdg = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = xdg;
    try {
      f.seams.probeService = async home => ({ version: fs.existsSync(path.join(home, 'current')) && fs.realpathSync(path.join(home, 'current')).includes('0.7.0') ? '0.7.0' : '0.6.0', catalogs: { codex: [{ name: 'ping', inputSchema: { type: 'object' } }] } });
      f.seams.probeCandidate = async (_home, receipt) => { probedWith = receipt; return { version: '0.7.0', catalogs: { codex: [{ name: 'ping', inputSchema: { type: 'object' } }] } }; };
      const r = await updateService({ home: f.home }, f.seams);
      assert.equal(r.outcome, 'updated');
    } finally { if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousXdg; }
    assert.equal(probedWith.node, misoNode, 'the candidate runs under the service node binary, not the updater node');
    const adopted = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    assert.equal(adopted.node, misoNode); assert.equal(adopted.unit_dir, unitDir);
    assert.ok(adopted.repo.includes(`${path.sep}0.7.0${path.sep}`));
    const unit = fs.readFileSync(unitFile, 'utf8');
    assert.ok(unit.includes(`ExecStart=${misoNode} ${path.join(f.home, 'current')}/src/server.mjs`), unit);
    assert.ok(fs.existsSync(legacyRepo), 'the original package stays until a later update succeeds');
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
