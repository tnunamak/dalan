import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {Store} from '../src/store.mjs';
const payload=id=>({schema_version:1,request_id:id,brief:'waiter fence',inputs:[],expected_output:'one reply',execution_scope:'read-only'});
if(process.argv[2]==='reserve') {
  const s=new Store(process.argv[3]);const id=process.argv[4],c=s.get(id).claim;
  s.progress(id,c.claim_id,'QUESTION: child-owned response','owner');
  const held=s.claimWaiterDelivery(id,0);process.send({id:held.id});setInterval(()=>{},1000);
} else {
  for(const mode of ['idle','resume','reclaim']) {
    let now=100000;const s=new Store(':memory:',{now:()=>now,resumeIdleMs:1,limits:{leaseMs:1000}}),id='req_wait_'+mode;
    const rotate=()=>{if(mode==='resume')return s.resume(id,'owner');if(mode==='reclaim')s.abandon(id);return s.claim(id,'second','owner',6,null,'dot','second');};
    try {
      s.submit(payload(id),{mode:'t3',threadId:'fixture'},'env','owner');const first=s.claim(id,'first','owner',6,null,'dot','first');
      s.progress(id,first.claim_id,'QUESTION: old epoch','owner');const held=s.claimWaiterDelivery(id,0);assert(held);
      now+=1000;assert.throws(rotate,/uncertain_delivery/);
      s.recoverSends();assert.equal(s.db.prepare('SELECT state FROM notifications WHERE id=?').get(held.id).state,'waiting');
      assert.throws(rotate,/uncertain_delivery/,'another Store startup cannot reset a live HTTP callback');
      s.releaseWaiterDelivery(held.id);assert.equal(rotate().epoch,2);
      assert.equal(s.db.prepare('SELECT state FROM notifications WHERE id=?').get(held.id).state,'suppressed');
      assert.equal(s.startAttempt(held.id,[]),null);
      // Defense in depth for rows resurrected by legacy recovery or an external repair.
      s.db.prepare("UPDATE notifications SET state='pending' WHERE id=?").run(held.id);
      assert.equal(s.claimWaiterDelivery(id,0),null);assert.equal(s.startAttempt(held.id,[]),null);
      console.log('PASS reserved waiter '+mode+' holds epoch until disconnect and old question cannot resurrect');
    }finally{s.db.close();}
  }
  const root=fs.mkdtempSync(path.join(os.homedir(),'.tmp','waiter-death-')),db=path.join(root,'db'),id='req_dead_waiter';let s,child;
  try {
    s=new Store(db);s.submit(payload(id),{mode:'t3',threadId:'fixture'},'env','owner');s.claim(id,'first','owner',6);s.db.close();s=null;
    child=fork(new URL(import.meta.url),['reserve',db,id],{stdio:['ignore','ignore','inherit','ipc']});
    const [held]=await once(child,'message',{signal:AbortSignal.timeout(10000)});
    s=new Store(db);s.recoverSends();assert.equal(s.db.prepare('SELECT state FROM notifications WHERE id=?').get(held.id).state,'waiting');
    const exited=once(child,'exit');child.kill('SIGKILL');await exited;
    s.recoverSends();assert.equal(s.db.prepare('SELECT state FROM notifications WHERE id=?').get(held.id).state,'pending');
    assert(s.claimWaiterDelivery(id,0));console.log('PASS real owner SIGKILL releases only that dead waiter, permitting owner recovery');
  }finally{if(child?.exitCode===null&&child?.signalCode===null)child.kill('SIGKILL');s?.db.close();fs.rmSync(root,{recursive:true,force:true});}
  if(process.argv.includes('--http')) {
    const {DotBridgeAdapter}=await import('./conformance/adapter-dot-bridge.mjs');
    const adapter=new DotBridgeAdapter({serverEnv:{DOT_BRIDGE_WAIT_RESPONSE_DELAY_MS:'500'}});
    const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw new Error('waiter barrier timeout');};
    try {
      await adapter.init();
      for(const disconnect of [false,true]) {
        await adapter.reset();
        const job=disconnect?'disconnect':'response',id=adapter.requestId(job),owner=adapter.ownerToken(job);
        const submitted=await adapter.admin('POST','/submit',{assignment:payload(id),delivery:'none',owner_token:owner});assert(!submitted.error,submitted.error);
        const first=await adapter.mcp('W1','claim',{request_id:id,claimant:'first',acquisition_id:'first'});assert(first.value,first.error);
        const abort=new AbortController();
        const waiting=adapter.admin('GET',`/wait?id=${id}&timeout=3`,undefined,owner,{signal:abort.signal}).catch(error=>({aborted:true,error:error.message}));
        const progress=await adapter.mcp('W1','progress',{request_id:id,claim_id:first.value.claim_id,note:'QUESTION: delayed old response'});assert(progress.value,progress.error);
        await until(()=>adapter.q1("SELECT count(*) n FROM notifications WHERE request_id=? AND state='waiting'",id).n===1);
        await adapter.control({op:'advance',to:60000});
        const blocked=await adapter.mcp('W2','claim',{request_id:id,claimant:'second',acquisition_id:'second'});assert.match(blocked.error??'',/uncertain_delivery/);
        if(disconnect)abort.abort();
        const reply=await waiting;
        if(disconnect)assert(reply.aborted);else assert(JSON.stringify(reply.value).includes('delayed old response'));
        await until(()=>adapter.q1("SELECT count(*) n FROM notifications WHERE request_id=? AND state='waiting'",id).n===0);
        const next=await adapter.mcp('W2','claim',{request_id:id,claimant:'second',acquisition_id:'second'});assert.equal(next.value?.epoch,2,JSON.stringify(next));
        assert.equal(adapter.q1("SELECT count(*) n FROM notifications WHERE request_id=? AND state IN ('pending','failed','waiting') AND body IS NOT NULL",id).n,0);
        console.log('PASS real HTTP delayed '+(disconnect?'disconnect':'response')+' blocks regrant until response channel closes');
      }
    }finally{await adapter.close();}
  }

}
