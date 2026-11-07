#!/usr/bin/env node
import assert from 'node:assert/strict';
import { DotBridgeAdapter } from './adapter-dot-bridge.mjs';

const a=new DotBridgeAdapter();
try {
  await a.init();await a.reset();
  const submit=await a.invoke('owner',{v:0,op:'submit',job:'J',key:'k1',body:{source:'git:BASE',scope:'read:fixture',policy:'P0',destination:'owner-inbox',retainUntil:1000}});
  assert.equal(submit.reply.ok,true);
  const claim=await a.invoke('W1',{v:0,op:'claim',job:'J',key:'c1',revision:1,body:{leaseMs:100}});
  assert.equal(claim.reply.value.leaseUntil,100);
  const requestId=a.maps.job.get('J');
  // Refused calls still update operational tool audit; authority and receipts must not change.
  const authority=()=>{const {tool_calls,last_tool,last_tool_at,last_tool_error,first_workspace_tool_at,...claim}=a.q1('SELECT * FROM claims WHERE request_id=?',requestId);return claim;};
  const facts=()=>({revision:a.rev('J'),events:a.journal('J'),receipts:a.q('SELECT * FROM claim_command_receipts WHERE job=? ORDER BY command_key',requestId),claim:authority()});
  const before=facts();
  await a.control({op:'advance',to:100});
  const renewal=await a.invoke('W1',{v:0,op:'renew',job:'J',key:'r1',revision:2,epoch:1,claim:claim.reply.value.claim,body:{leaseMs:100}});
  assert.equal(renewal.status,'OK');
  assert.deepEqual(renewal.reply,{ok:false,code:'LEASE_EXPIRED'});
  assert.equal(renewal.errorMapped,true);
  assert.deepEqual(renewal.events,[]);
  const calls=a.trace.filter(row=>row.kind==='mcp');
  assert.equal(calls.length,1);
  assert.equal(calls[0].name,'renew_claim');
  assert.equal(calls[0].args.claim_id,a.nativeClaim(claim.reply.value.claim));
  assert.match(calls[0].error,/lease_expired/);
  assert.deepEqual(facts(),before,'expired renewal mutated revision, events, receipts or claim/deadline');
  const audit=a.q1('SELECT last_tool,last_tool_error FROM claims WHERE request_id=?',requestId);
  assert.equal(audit.last_tool,'renew_claim');assert.match(audit.last_tool_error,/lease_expired/);
  assert(!a.trace.some(row=>row.kind==='mcp'&&row.name==='claim'),'renewal became a regrant');
  const row=a.q1('SELECT epoch FROM claims WHERE request_id=?',a.maps.job.get('J'));
  assert.equal(row.epoch,1);
  const actual=await a.mcp('W1','progress',{request_id:a.maps.job.get('J'),claim_id:a.nativeClaim(claim.reply.value.claim),note:'expired native authority',command_key:'expired-progress',expected_revision:2,epoch:1});
  assert.match(actual.error,/lease_expired/,'native authority remained usable at expiry');
  assert.deepEqual(facts(),before,'expired progress mutated durable authority');
  console.log('PASS native renewal at equality maps LEASE_EXPIRED without mutation or regrant; expired progress refused');
} finally {await a.close();}
