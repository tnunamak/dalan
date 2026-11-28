import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { updateService } from '../src/service-update.mjs';

test('a prepared update abort preserves the unit edit and original selection', async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-prepared-rollback-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, '.config/dot-bridge');
  const unitDir = path.join(home, 'systemd/user');
  const oldRepo = path.join(home, 'old');
  const candidate = path.join(home, 'versions/1.0.1/node_modules/@tnunamak/dalan');
  for (const dir of [config, unitDir, oldRepo, candidate]) fs.mkdirSync(dir, { recursive: true });
  const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  writeJson(path.join(oldRepo, 'package.json'), { name: '@tnunamak/dalan', version: '1.0.0' });
  writeJson(path.join(candidate, 'package.json'), { name: '@tnunamak/dalan', version: '1.0.1' });
  const current = path.join(home, 'current');
  fs.symlinkSync('old', current);
  const currentInode = fs.lstatSync(current).ino;
  const unit = path.join(unitDir, 'dalan-fixture.service');
  const originalUnit = '[Service]\nExecStart=/fixture/node /fixture/src/server.mjs\n';
  fs.writeFileSync(unit, originalUnit, { mode: 0o600 });
  writeJson(path.join(config, 'service-install.json'), {
    schema_version: 1, home, repo: oldRepo, version: '1.0.0',
    unit: 'dalan-fixture', unit_dir: unitDir, platform: 'linux', node: process.execPath,
  });
  const workers = path.join(config, 'workers.json');
  writeJson(workers, { workers: { w: {} } });
  const catalogs = { w: [] }, serviceCalls = [];
  const seams = {
    latestRelease: async () => ({ name: '@tnunamak/dalan', version: '1.0.1', dist: { integrity: 'sha512-fixture' } }),
    installRelease: async () => candidate,
    probeService: async () => ({ version: '1.0.0', catalogs }),
    probeCandidate: async () => ({ version: '1.0.1', catalogs }),
    controlService: async (_receipt, action) => {
      serviceCalls.push(action);
      if (serviceCalls.length === 1 && action === 'stop') {
        fs.appendFileSync(unit, '# operator edit\n');
        // The digest covers workers.json, not the service unit.
        writeJson(workers, { workers: { w: { fixtureEdit: true } } });
      }
    },
  };
  await assert.rejects(updateService({ home }, seams), /configuration changed while stopping/);
  assert.equal(fs.readFileSync(unit, 'utf8'), originalUnit + '# operator edit\n');
  assert.equal(fs.lstatSync(current).ino, currentInode, 'the selection symlink was never replaced');
  assert.equal(fs.realpathSync(current), oldRepo);
  assert.deepEqual(serviceCalls, ['stop', 'stop', 'daemon-reload', 'restart']);
});
