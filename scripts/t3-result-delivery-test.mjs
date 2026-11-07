#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createT3Destination } from '../src/destinations/t3.mjs';
import { resultDeliveryIds } from '../src/t3-transport.mjs';

const threadId='scratch-thread-123', environmentId='scratch-environment';
const jobId='job-result-retry', effectId='evt_durable_result';
const item={id:effectId,kind:'t3',request_id:jobId};
const row={request_id:jobId,delivery_mode:`t3:${threadId}`,thread_id:threadId,environment_id:environmentId,
  target_worker:'dot',status:'finished',report:{outcome:'completed',summary:'fixture result'},t3_muted:false};
const receipts=new Map(), messages=new Map(), runs=new Map(), sessions=[];
let dropFirstResponse=true;
const targetReads=[];
const destination=createT3Destination({
  store:{get:id=>{assert.equal(id,jobId);return row;},paused:()=>false,deliveryAttemptIsCurrent:()=>true},
  inspectThread:async(thread,environment)=>{
    targetReads.push([thread,environment]);
    return thread===threadId&&environment===environmentId?{state:'active'}:{state:'unavailable'};
  },
  quiet:()=>null,mainThreadIds:()=>[],env:{},
  callT3:async(_argv,message,options)=>{
    assert.match(message,/Fetch full report/);
    const {threadId:boundThread,environmentId:boundEnvironment,jobId:boundJob,effectId:boundEffect}=options.resultDelivery;
    assert.deepEqual([boundThread,boundEnvironment,boundJob,boundEffect],[threadId,environmentId,jobId,effectId]);
    const ids=resultDeliveryIds(boundJob,boundEffect);
    sessions.push({id:sessions.length+1,ids:{...ids}});
    if(!receipts.has(ids.commandId)) {
      receipts.set(ids.commandId,{threadId:boundThread,messageId:ids.messageId,text:message});
      messages.set(ids.messageId,{...receipts.get(ids.commandId)});
      runs.set(ids.commandId,{messageId:ids.messageId,effects:1});
      if(dropFirstResponse) { dropFirstResponse=false; throw new Error('response lost after commit'); }
    }
    return {accepted:true};
  },
});

const first=await destination.send(item,{started:{attempts:0,attempt_id:'attempt-first'}});
assert.equal(first.state,'uncertain','unknown response stays uncertain');
const retry=await destination.send(item,{started:{attempts:1,attempt_id:'attempt-retry'}});
assert.equal(retry.state,'delivered','receiver receipt makes retry safe');
assert.equal(sessions.length,2,'retry used a separate transport session');
assert.deepEqual(sessions[0].ids,sessions[1].ids,'stable identity survives session replacement');
assert.equal(receipts.size,1);
assert.equal(messages.size,1);
assert.equal(runs.size,1);
assert.equal([...runs.values()][0].effects,1);
assert.ok(targetReads.every(([thread,environment])=>thread===threadId&&environment===environmentId),'target binding checked on each attempt');
assert.notEqual(resultDeliveryIds(jobId,effectId).commandId,resultDeliveryIds('other-job',effectId).commandId);
assert.notEqual(resultDeliveryIds(jobId,effectId).commandId,resultDeliveryIds(jobId,'other-effect').commandId);
// Epoch is deliberately absent from the identity API: every epoch for this effect gets the same IDs.
for(const epoch of [1,2,99]) {
  void epoch;
  assert.deepEqual(resultDeliveryIds(jobId,effectId),sessions[0].ids);
}
console.log('PASS: retries across sessions persist one message, run, effect, and receipt with bound target');
