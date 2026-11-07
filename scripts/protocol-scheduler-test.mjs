import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.mjs';

const root=process.env.DOT_BRIDGE_TEST_TMP??path.join(os.homedir(),'.tmp');
fs.mkdirSync(root,{recursive:true});
const dir=fs.mkdtempSync(path.join(root,'protocol-scheduler-'));
let now=100000;
const store=new Store(path.join(dir,'state.db'),{now:()=>now});
function make(id) {
  store.submit({schema_version:1,request_id:id,brief:'scheduler boundary',inputs:[],expected_output:'one',execution_scope:'read-only',
    protocol:{profile:'job-v0',source:'git:BASE',scope:'read:fixture',policy:'P0',destination:'owner-inbox',retain_until_ms:1000000}},
    {mode:'none'},null,'owner');
  return store.claim(id,'worker','subject',10,null,'dot','acq',100,{key:'claim',revision:1});
}
try {
  const a=make('fixed-progress');
  now=100030;
  store.progress('fixed-progress',a.claim_id,'working','subject',false,'dot',null,{key:'p',revision:2});
  now=100100;
  assert(store.sweepStaleLeases().includes('fixed-progress'),'progress cannot postpone a fixed deadline');
  const expired=store.protocolFacts('fixed-progress').at(-1);
  assert.equal(expired.type,'expired');assert.equal(expired.state,'queued');
  assert.equal(expired.revision,store.protocolRevision('fixed-progress'));
  now=101000;
  const b=make('fixed-renew');
  now=101020;
  store.renewClaim('fixed-renew',b.claim_id,100,{key:'r',revision:2},'subject','dot');
  now=101100;
  assert(!store.sweepStaleLeases().includes('fixed-renew'),'renewal must prevent premature expiry');
  now=101120;
  assert(store.sweepStaleLeases().includes('fixed-renew'),'expiry is inclusive at the renewed deadline');
  now=102000;
  const c=make('claim-policy-retry');
  assert.deepEqual(store.claim('claim-policy-retry','worker','subject',11,null,'dot','acq',100,{key:'claim',revision:1}),c,
    'changing operator capacity is not a change to caller claim intent');
  const fact=store.protocolFacts('claim-policy-retry').at(-1);
  assert.equal(fact.revision,2);assert.equal(fact.state,'leased');assert.equal(fact.epoch,1);
  console.log('PASS fixed-deadline sweeps, renewal, claim replay and persisted native revision/state');
} finally {store.db.close();fs.rmSync(dir,{recursive:true,force:true});}
