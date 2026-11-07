#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';

const dir=mkdtempSync(join(tmpdir(),'dalan-bridge-wait-store-'));
try {
  const store=new Store(join(dir,'bridge.db')),
    requestId=store.submit({schema_version:1,request_id:'req_wait_store_test',brief:'wait unit test',inputs:[],expected_output:'test',execution_scope:'read-only'},'thread','env','owner').request_id;
  const claim=store.claim(requestId,'dot');
  store.progress(requestId,claim.claim_id,'BLOCKED: before attach','local-principal',true);
  const cursor=store.deliveryCursor(requestId);
  store.finish(requestId,claim.claim_id,'completed','done','done');
  const reserved=store.claimWaiterDelivery(requestId,cursor);
  assert.equal(reserved.kind,'t3','waiter claimed a pre-attach blocker');
  assert.equal(store.db.prepare('SELECT state FROM notifications WHERE id=?').get(reserved.id).state,'waiting');
  store.releaseWaiterDelivery(reserved.id);
  assert.equal(store.db.prepare('SELECT state FROM notifications WHERE id=?').get(reserved.id).state,'pending');
  store.claimWaiterDelivery(requestId,cursor); store.recoverSends();
  assert.equal(store.db.prepare('SELECT state FROM notifications WHERE id=?').get(reserved.id).state,'waiting','live owner still has a response channel');
  store.releaseWaiterDelivery(reserved.id);
  store.db.prepare('INSERT INTO assignment_delivery_mutes(request_id,muted_at) VALUES(?,?)').run(requestId,store.stamp()); // legacy row: mute has no writer, the reader stays
  assert.equal(store.get(requestId).delivery_mode,'t3:thread','mute preserves destination');
  assert.equal(store.get(requestId).t3_muted,true);
  store.db.close();
  const reopened=new Store(join(dir,'bridge.db'));
  assert.equal(reopened.get(requestId).t3_muted,true,'mute survives reopen');
  assert.equal(reopened.get(requestId).delivery_mode,'t3:thread');
  reopened.db.close(); console.log('PASS waiter durable reservation, release, restart recovery, attach cursor, and a legacy mute row');
} finally { rmSync(dir,{recursive:true,force:true}); }
