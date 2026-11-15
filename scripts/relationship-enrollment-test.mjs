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
  const partial=cli('example/repo');
  assert(loadOwnerWorkers(profile).repoPolicy('fixture').repos.includes('example/repo'),'the repository grant must already be committed');
  assert.equal(partial.status,0,'repository policy was committed but the command reported failure: '+partial.stderr);
  const receipt=JSON.parse(partial.stdout);
  assert.equal(receipt.partial,true);
  assert.equal(receipt.repository_policy_applied,true);
  assert.equal(receipt.relationship_enrollment.status,'pending');
  assert.match(receipt.relationship_enrollment.repair,/worker allow fixture example\/repo/);
  assert(receipt.relationship_enrollment.reason);

  const plain=cli('example/other',false);
  assert.equal(plain.status,0,plain.stderr);
  assert.match(plain.stdout,/repository policy applied/i);
  assert.match(plain.stdout,/relationship enrollment pending/i);
  assert.match(plain.stdout,/worker allow fixture example\/other/);
  assert(loadOwnerWorkers(profile).repoPolicy('fixture').repos.includes('example/other'));

  fs.unlinkSync(database);
  new Store(database).db.close();
  const repaired=cli('example/repo');
  assert.equal(repaired.status,0,repaired.stderr);
  assert.equal(JSON.parse(repaired.stdout).partial,undefined);
  const store=new Store(database);
  try {
    assert.equal(store.db.prepare('SELECT count(*) n FROM relationships WHERE counterpart_ref=?').get('fixture').n,1);
  } finally {store.db.close();}
  assert.deepEqual(loadOwnerWorkers(profile).repoPolicy('fixture').repos.sort(),['example/other','example/repo']);
  console.log('PASS worker allow reports applied policy and pending enrollment after a database fault; retry repairs enrollment');
} finally {fs.rmSync(home,{recursive:true,force:true});}
