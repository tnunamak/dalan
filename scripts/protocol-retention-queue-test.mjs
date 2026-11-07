import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';

const dir=mkdtempSync(join(os.tmpdir(),'protocol-retention-queue-'));
let now=1800000000000;
const store=new Store(join(dir,'store.sqlite'),{now:()=>now});
const id='expired_protocol_queue';
try {
  store.subscribe('queue-waker','http://127.0.0.1:9/event','secret',new Date(now+10*3600000).toISOString(),'fixture','dot');
  const payload={schema_version:1,request_id:id,brief:'Expired protocol queue',inputs:[],scope_paths:[],execution_scope:'analysis',expected_output:'proof',
    protocol:{profile:'job-v0',source:'source',scope:'scope',policy:'policy',destination:'owner',retain_until_ms:now+100}};
  store.submit(payload,{mode:'none'},null,'owner',false,null,'normal',null,payload,null,'dot','worker');
  now+=100;
  const status=store.status();
  assert.equal(status.counts.some(row=>row.status==='queued'),false,'expired protocol work is absent from global status totals');
  assert.equal(status.by_worker.dot.counts.some(row=>row.status==='queued'),false,'expired protocol work is absent from worker status totals');
  assert.equal(status.priority_counts.normal.queued,0,'expired protocol work is absent from priority totals');
  assert.deepEqual(store.queuedRows().map(row=>row.request_id),[], 'expired protocol work is not listed as queued');
  assert.equal(store.hasQueuedFor(['dot']),false,'expired protocol work does not raise the worker wake bit');
  assert.equal(store.status().priority_counts.normal.queued,0,'expired protocol work does not count as queued');
  assert.equal(status.counts.find(row=>row.status==='queued'),undefined);
  assert.equal(status.by_worker.dot.counts.find(row=>row.status==='queued'),undefined);
  now+=30*60000;
  const liveness=store.liveness();
  assert.equal(liveness.queue_classes.transport_failing,0,'retention-expired protocol work does not make liveness report transport_failing');
  assert.equal(liveness.queue_classes.expired,1,'retention-expired protocol work is classed expired');
  assert.equal(liveness.items.length,1,'the row stays visible to liveness until something ends it');
  assert.equal(store.status().queued_expired.count,1,'retention-expired protocol work stays visible in queued_expired');
  assert.equal(store.status().by_worker.dot.queued_expired.count,1,'and in the worker view');
  const wake=store.db.prepare("SELECT id FROM notifications WHERE request_id=? AND kind='event'").get(id);
  assert(wake,'the queued job emitted its original wake before retention expired');
  assert.equal(store.startAttempt(wake.id,null),null,'an already queued wake is suppressed after retention expires');
  assert.equal(store.db.prepare('SELECT state FROM notifications WHERE id=?').get(wake.id).state,'suppressed');
} finally {store.db.close();rmSync(dir,{recursive:true,force:true});}
console.log('PASS: expired protocol work is excluded from queue liveness');
