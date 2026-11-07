#!/usr/bin/env node
// H1: attach the real target HTTP waiter BEFORE replacing the queued job.
import assert from 'node:assert/strict';
import http from 'node:http';
import { defaultPath } from '../src/paths.mjs';
import { harness } from './fault-cancel-finish-e2e.mjs';

const h=await harness('narrow-supersede');
let waitingRequest,deadline;
try {
  await h.start();
  const T=h.fixture(),U=h.fixture(),R=h.fixture();
  const submit=(f,extra={})=>h.admin('/submit',{delivery:'none',owner_token:f.owner,assignment:f.assignment,...extra});
  const replace=(sourceOwner=R.owner,targetOwner=T.owner)=>submit({...R,owner:sourceOwner},{supersedes:{target_id:T.id,target_token:targetOwner}});
  for(const f of [T,U])assert.equal((await submit(f)).status,200);
  const before=h.inspect(s=>({target:s.get(T.id),control:s.get(U.id)}));
  let settled=false;
  const wait=new Promise((resolve,reject)=>{
    waitingRequest=http.request({socketPath:defaultPath(h.home,'.local/share/dot-bridge/admin.sock'),
      path:'/wait?id='+encodeURIComponent(T.id)+'&timeout=30&peek=1',method:'GET',
      headers:{'x-owner-capability':T.owner}},response=>{
      let body='';response.on('data',chunk=>body+=chunk);
      response.on('end',()=>{try{resolve({status:response.statusCode,body:JSON.parse(body)});}catch(error){reject(error);}});
    });
    waitingRequest.on('error',reject);waitingRequest.end();
  });
  // Observe all rejections immediately; cleanup destroys this request on failure.
  wait.then(()=>{settled=true;},()=>{settled=true;});
  await h.waitFor(async()=>((await h.admin('/status')).body.owner_waiter_count===1),'target waiter attached');
  const bad=await replace(R.owner,'wrong-target');
  assert.equal(bad.status,400);assert.match(bad.body.error,/invalid owner capability/);
  h.inspect(s=>{assert.equal(s.hasAssignment(R.id),false);assert.deepEqual(s.get(T.id),before.target);assert.deepEqual(s.get(U.id),before.control);});
  assert.equal(settled,false);assert.equal((await h.admin('/status')).body.owner_waiter_count,1);
  const accepted=await replace();assert.equal(accepted.status,200);assert.equal(accepted.body.duplicate,false);
  const targetWait=await Promise.race([wait,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('target waiter not woken within 2 seconds')),2000);})]);
  clearTimeout(deadline);deadline=null;
  assert.equal(targetWait.status,200); // This response belongs to the request opened for T, not R.
  assert.equal(targetWait.body.status,'cancelled');
  assert.equal((await h.admin('/status')).body.owner_waiter_count,0);
  const rows=h.inspect(s=>({source:s.get(R.id),target:s.get(T.id),control:s.get(U.id)}));
  assert.equal(rows.source.status,'queued');assert.equal(rows.target.status,'cancelled');
  assert.equal(rows.source.supersedes.request_id,T.id);assert.equal(rows.target.superseded_by.request_id,R.id);
  assert.equal(rows.source.supersedes.created_at,rows.target.superseded_by.created_at);
  assert.deepEqual(rows.control,before.control);
  assert.equal(rows.target.cancellation_requested,true);assert.equal(rows.target.authority_revoked,true);
  const duplicate=await replace();assert.equal(duplicate.status,200);assert.equal(duplicate.body.duplicate,true);
  for(const [sourceOwner,targetOwner] of [['wrong-source',T.owner],[R.owner,'wrong-target']]){
    const refused=await replace(sourceOwner,targetOwner);assert.equal(refused.status,400);
    assert.match(refused.body.error,/invalid owner capability/);
  }
  h.inspect(s=>{assert.deepEqual(s.get(R.id),rows.source);assert.deepEqual(s.get(T.id),rows.target);assert.deepEqual(s.get(U.id),rows.control);});
  assert.equal((await h.admin('/status')).body.owner_waiter_count,0);
  const claimed=await h.tool('claim',{request_id:T.id,claimant:'supersede-http-worker'});
  assert.match(claimed.error,/assignment cancelled/);
  h.inspect(s=>assert.ok(!s.get(T.id).claim));
  console.log('PASS H1 owner checks, immutable retry, attached target waiter and later claim fence');
} finally {
  clearTimeout(deadline);waitingRequest?.destroy();await h.close();
}
