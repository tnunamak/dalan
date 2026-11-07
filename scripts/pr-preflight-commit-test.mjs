import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.mjs';
import {preflightPR} from '../src/pr-preflight.mjs';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-pr-commit-'));
let now=Date.now();
const store=new Store(path.join(home,'bridge.db'),{now:()=>now});
const assignment=request_id=>({schema_version:1,request_id,brief:'Inspect README.md',expected_output:'findings',execution_scope:'read-only',inputs:[{github_repo:'fixture/repo',base_sha:'b'.repeat(40),head_sha:'a'.repeat(40),pr_number:1}],prepared_at:new Date(now).toISOString(),valid_until:new Date(now+30000).toISOString()});
try {
  const a=assignment('req_pr_commit_fixture');
  const evidence=await preflightPR(a,{now:()=>now,read:async()=>({state:'open',draft:false,head:{sha:'a'.repeat(40)}})});
  for(const bad of [null,{...evidence,head_sha:'c'.repeat(40)},{...evidence,checked_at:new Date(now-16000).toISOString()}]) {
    assert.throws(()=>store.submit(a,{mode:'none'},null,'owner',false,bad),/preflight/);
    assert.equal(store.hasAssignment(a.request_id),false,'refused submit leaked its transactional insert');
  }
  store.submit(a,{mode:'none'},null,'owner',false,evidence);
  now+=16000;
  assert.throws(()=>store.claim(a.request_id,'worker','subject',1,evidence),/preflight/);
  assert.equal(store.get(a.request_id).claim,undefined,'stale proof created a claim');
  assert.deepEqual(store.get(a.request_id).pr_preflights.map(row=>row.phase),['submit']);
  now+=14001;
  assert.throws(()=>store.claim(a.request_id,'worker','subject',1,{...evidence,checked_at:new Date(now).toISOString()}),/expired/);
  assert.equal(store.get(a.request_id).status,'queued');
  assert.equal(store.get(a.request_id).claim,undefined,'expiry at commit created a claim');
  assert.deepEqual(store.get(a.request_id).pr_preflights.map(row=>row.phase),['submit']);
  console.log('PASS PR commit guards: invalid/stale/missing proof rolls back submit, stale and expired first claim leave no claim or observation');
}finally {store.db.close();fs.rmSync(home,{recursive:true,force:true});}
