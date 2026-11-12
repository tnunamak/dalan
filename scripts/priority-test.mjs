#!/usr/bin/env node
import { preWorkerFixture } from '../src/test-support/pre-worker-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { explainStatus } from '../src/status-evidence.mjs';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-bridge-priority-'));
const assignment=id=>({schema_version:1,request_id:id,brief:id,inputs:[],expected_output:'test',execution_scope:'read-only'});
const submit=(store,id,priority='normal')=>store.submit(assignment(id),{mode:'none'},null,'owner',false,null,priority);
try {
  const ordered=new Store(path.join(dir,'ordered.db'));
  submit(ordered,'req_background_old','background');
  submit(ordered,'req_normal_old');
  submit(ordered,'req_normal_new');
  assert.deepEqual(ordered.listPending().map(row=>row.request_id),['req_normal_old','req_normal_new','req_background_old'],'normal work lists first, background after');
  const normal=ordered.claim('req_normal_old','dot','subject',10);
  ordered.finish('req_normal_old',normal.claim_id,'completed','done','done','subject');
  const normal2=ordered.claim('req_normal_new','dot','subject',10);
  ordered.finish('req_normal_new',normal2.claim_id,'completed','done','done','subject');
  assert.deepEqual(ordered.listPending().map(row=>row.request_id),['req_background_old'],'background returns after normal queue drains');
  assert.equal(ordered.db.prepare("SELECT priority FROM assignments WHERE request_id='req_background_old'").get().priority,'background');
  const status=ordered.status();
  assert.deepEqual(status.priority_counts,{normal:{queued:0,claimed:0},background:{queued:1,claimed:0}});
  assert.match(explainStatus(status),/normal=queued\/claimed\(0\/0\).*background=queued\/claimed\(1\/0\)/);
  ordered.db.close();

  const defaultCap=new Store(path.join(dir,'default-cap.db'));
  for(let i=0;i<4;i++) submit(defaultCap,`req_default_${i}`,'background');
  assert.throws(()=>submit(defaultCap,'req_default_over','background'),/background_capacity_full/,'default cap is four queued or claimed assignments');
  submit(defaultCap,'req_normal_unlimited');
  defaultCap.db.close();

  const customCap=new Store(path.join(dir,'custom-cap.db'),{backgroundMaxInFlight:2});
  submit(customCap,'req_custom_1','background');
  const claimed=customCap.claim('req_custom_1','dot','subject',10);
  submit(customCap,'req_custom_2','background');
  assert.throws(()=>submit(customCap,'req_custom_over','background'),/background_capacity_full/,'custom cap counts claimed and queued assignments');
  customCap.finish('req_custom_1',claimed.claim_id,'completed','done','done','subject');
  submit(customCap,'req_custom_after_finish','background');
  customCap.db.close();

  const source=path.join(dir,'real-shaped-source.db'),copy=path.join(dir,'real-shaped-copy.db');
  const current=new Store(source);
  submit(current,'req_legacy_shape');
  current.db.close();
  fs.copyFileSync(source,copy);
  fs.mkdirSync(`${copy}.secrets`,{mode:0o700});
  fs.copyFileSync(`${source}.secrets/storage.key`,`${copy}.secrets/storage.key`);
  fs.chmodSync(`${copy}.secrets`,0o700);
  fs.chmodSync(`${copy}.secrets/storage.key`,0o600);
  const legacy=new DatabaseSync(copy);
  preWorkerFixture({db:legacy});
  legacy.exec('DROP INDEX assignments_pending_priority; ALTER TABLE assignments DROP COLUMN priority; PRAGMA user_version=18;');
  legacy.close();
  const migrated=new Store(copy);
  assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version,66);
  assert.equal(migrated.db.prepare("SELECT priority FROM assignments WHERE request_id='req_legacy_shape'").get().priority,'normal','migration backfills existing assignments as normal');
  migrated.db.close();
  console.log('PASS priority ordering, yielding, default/custom background caps, status classes, and real-shaped v18 migration');
} finally { fs.rmSync(dir,{recursive:true,force:true}); }
