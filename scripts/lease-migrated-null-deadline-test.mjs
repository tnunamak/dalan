import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../src/store.mjs';

const scratch=path.join(os.homedir(),'.tmp');fs.mkdirSync(scratch,{recursive:true});
const root=fs.mkdtempSync(path.join(scratch,'lease-migrated-null-'));
const file=path.join(root,'store.sqlite'),start=Date.parse('2026-11-05T12:00:00Z'),id='pre-v56-active-claim';
let now=start,store;
try {
  store=new Store(file,{now:()=>now,limits:{leaseMs:60000}});
  const payload={schema_version:1,request_id:id,brief:'legacy active claim',inputs:[],expected_output:'result',execution_scope:'read-only'};
  store.submit(payload,{mode:'none'},null,'owner');
  store.claim(id,'worker','subject',1,null,'dot',null,60000);
  store.db.prepare('UPDATE claims SET lease_deadline_at=NULL WHERE request_id=?').run(id);
  now=start+60000;
  assert.deepEqual(store.sweepStaleLeases(),[id],'a pre-v56 claim with a NULL migrated deadline must sweep from its legacy activity columns');
  assert.equal(store.get(id).status,'queued');
} finally {store?.db.close();fs.rmSync(root,{recursive:true,force:true});}
console.log('PASS pre-v56 active claim sweeps from its legacy activity columns');
