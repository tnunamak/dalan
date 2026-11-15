import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Store} from '../src/store.mjs';
import {loadOwnerWorkers,writeGenericProfile} from '../src/workers.mjs';

const home=fs.mkdtempSync(path.join(os.homedir(),'.tmp/relationship-enrollment-'));
const profile=path.join(home,'.config/dot-bridge/workers.json');
const database=path.join(home,'.local/share/dot-bridge/bridge.db');
const env={...process.env,HOME:home};
for(const key of Object.keys(env)) if(/^(DALAN_|DOT_BRIDGE_|XDG_(CONFIG|DATA|STATE|CACHE)_HOME$)/.test(key)) delete env[key];
env.DALAN_WORKERS_FILE=profile;
const cli=(repo,json=true)=>spawnSync(process.execPath,['bin/dot-worker.mjs','worker','allow','fixture',repo,...(json?['--json']:[])],{env,encoding:'utf8'});
try {
  fs.mkdirSync(path.dirname(profile),{recursive:true,mode:0o700});
  writeGenericProfile(profile,'fixture');
  fs.mkdirSync(path.dirname(database),{recursive:true,mode:0o700});
  fs.writeFileSync(database,'deliberately corrupt SQLite fixture');
  const policyBefore=fs.readFileSync(profile,'utf8');
  const denied=cli('example/repo');
  assert.equal(fs.readFileSync(profile,'utf8'),policyBefore,'relationship failure must leave repository policy unchanged');
  assert.notEqual(denied.status,0,'corrupt relationship database must refuse enrollment');
  assert.match(denied.stderr,/file is not a database/);

  fs.unlinkSync(database);
  let store=new Store(database);
  store.db.exec("CREATE TRIGGER fail_relationship_enrollment BEFORE INSERT ON relationships BEGIN SELECT RAISE(ABORT,'fixture relationship creation failed'); END;");
  store.db.close();
  const failedInsert=cli('example/repo',false);
  assert.equal(fs.readFileSync(profile,'utf8'),policyBefore,'failed relationship insertion must leave repository policy unchanged');
  assert.notEqual(failedInsert.status,0,'failed relationship creation must refuse enrollment');
  assert.match(failedInsert.stderr,/fixture relationship creation failed/);
  assert.deepEqual(loadOwnerWorkers(profile).repoPolicy('fixture').repos,[]);
  store=new Store(database);
  assert.equal(store.db.prepare('SELECT count(*) n FROM relationships').get().n,0);
  store.db.exec('DROP TRIGGER fail_relationship_enrollment');
  store.db.close();

  const repaired=cli('example/repo');
  assert.equal(repaired.status,0,repaired.stderr);
  store=new Store(database);
  try {
    assert.equal(store.db.prepare('SELECT count(*) n FROM relationships WHERE counterpart_ref=?').get('fixture').n,1);
  } finally {store.db.close();}
  assert.deepEqual(loadOwnerWorkers(profile).repoPolicy('fixture').repos,['example/repo']);
  console.log('PASS relationship database and insertion failures leave repository policy unchanged; retry enrolls before applying access');
} finally {fs.rmSync(home,{recursive:true,force:true});}
