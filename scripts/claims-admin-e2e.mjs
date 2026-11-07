#!/usr/bin/env node
// Owner-side claim controls through the real server: dot-worker claims / abandon over the admin socket,
// plus MCP-level lease fencing (a stale claim_id neither writes nor extends the new holder's lease).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { readLines } from '../src/request-log.mjs';

const repo=resolve(new URL('..',import.meta.url).pathname),home=await mkdtemp(join(tmpdir(),'dalan-bridge-claims-admin-'));
const port=Number(process.env.CLAIMS_ADMIN_PORT||18831);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const pass=message=>console.log(`PASS ${message}`);
const payload=id=>({schema_version:1,request_id:id,brief:'claims admin test',inputs:[{revision:'abc'}],expected_output:'one result',execution_scope:'read-only'});
const env={...process.env,HOME:home, DALAN_LEGACY_PROFILE: '1',DOT_BRIDGE_PORT:String(port),DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_ALLOW_PRIVATE_WEBHOOKS:'1',DOT_BRIDGE_T3_DRY_RUN:'1'};
const cli=(...args)=>new Promise(done=>{const c=spawn(process.execPath,['bin/dalan.mjs',...args],{cwd:repo,env,stdio:['ignore','pipe','pipe']});let out='',err='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);const parse=t=>{try{return JSON.parse(t);}catch{return t.trim();}};c.on('close',code=>done({code,out,err,value:out.trim()?parse(out):parse(err)}));});
const admin=(route,method='GET',body=null,headers={})=>new Promise((done,fail)=>{const bytes=body?JSON.stringify(body):'';const req=http.request({socketPath:join(home,'.local/share/dalan/admin.sock'),path:route,method,headers:{'content-type':'application/json','content-length':Buffer.byteLength(bytes),...headers}},res=>{let t='';res.on('data',b=>t+=b);res.on('end',()=>done({status:res.statusCode,value:JSON.parse(t)}));});req.on('error',fail);req.end(bytes);});
let service=null,side=null;
try {
  service=spawn(process.execPath,['src/server.mjs'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
  let out='';service.stdout.on('data',b=>out+=b);service.stderr.on('data',b=>process.stderr.write(b));
  for(let i=0;i<100&&!(out.includes('MCP listening')&&out.includes('admin socket'));i++) await sleep(100);
  assert.ok(out.includes('MCP listening')&&out.includes('admin socket'),'server did not start');
  const secret=(await readFile(join(home,'.config/dalan/env'),'utf8')).match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  const rpc=async(method,params={})=>(await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method,params})})).json();
  const tool=async(name,args)=>{const r=await rpc('tools/call',{name,arguments:args});return r.result.isError?{error:r.result.content[0].text}:JSON.parse(r.result.content[0].text);};
  side=new Store(join(home,'.local/share/dalan/bridge.db'));
  const claimRow=id=>side.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id);
  const backdate=(id,ms)=>side.db.prepare('UPDATE claims SET last_claim_activity_at=?,lease_deadline_at=?,lease_boot_id=NULL,lease_deadline_monotonic_ms=NULL WHERE request_id=?').run(new Date(Date.now()-ms).toISOString(),new Date(Date.now()-ms+3600000).toISOString(),id);

  // operator key is required on both routes
  assert.equal((await admin('/claims')).value.error,'invalid operator key');
  assert.equal((await admin('/abandon','POST',{id:'req_whatever_1'})).value.error,'invalid operator key');
  const empty=await cli('claims','--json');
  assert.equal(empty.code,0,empty.err);assert.deepEqual(empty.value,{lease_ms:3600000,claims:[]});
  const leaseMs=empty.value.lease_ms;
  pass('claims and abandon require the operator key; empty list carries the configured lease');

  // claims lists an active claim with its lease
  const id=`req_${randomUUID()}`;
  side.submit(payload(id),{mode:'none'},null,'owner');
  const c1=await tool('claim',{request_id:id,claimant:'dot'});
  assert.equal(c1.epoch,1);
  let listed=(await cli('claims','--json')).value.claims;
  assert.equal(listed.length,1);
  const entry=listed[0];
  assert.deepEqual(Object.keys(entry).sort(),['claim_id','claimant','claimed_at','epoch','expired','last_activity_at','lease_expires_at','priority','request_id','subject','uncertain_deliveries']);
  assert.deepEqual([entry.request_id,entry.claimant,entry.subject,entry.claim_id,entry.epoch,entry.expired,entry.priority,entry.uncertain_deliveries],[id,'dot','local-principal',c1.claim_id,1,false,'normal',0]);
  assert.equal(Date.parse(entry.lease_expires_at)-Date.parse(entry.last_activity_at),3600000);
  const pretty=await cli('claims');assert.equal(pretty.code,0);assert.equal(pretty.value.claims[0].claim_id,c1.claim_id);
  assert.equal((await cli('claims','--bogus')).code,1);
  pass('dot-worker claims lists request, holder, epoch and lease');

  // get does not extend the lease; a claim_id-authenticated call does
  backdate(id,30*60000);let lease=claimRow(id).last_claim_activity_at;
  await tool('get',{request_id:id});
  assert.equal(claimRow(id).last_claim_activity_at,lease,'get extended the lease');
  await tool('progress',{request_id:id,claim_id:c1.claim_id,note:'working'});
  assert.ok(Date.parse(claimRow(id).last_claim_activity_at)>Date.parse(lease),'progress did not extend the lease');
  pass('get leaves the lease alone; progress extends it');

  // expired lease: listed as expired, then another claimant takes over; the stale holder is fenced at the MCP boundary
  backdate(id,3600000+1000);
  listed=(await cli('claims','--json')).value.claims;
  assert.ok(listed.length===0||listed[0].expired===true,'an expired claim is either reported as expired or has already been swept');
  const staleCount=side.status().stale_claims.count;
  assert.ok(staleCount===0||staleCount===1,'the lease sweep may already have requeued the expired claim');
  // A claim idle since before the bridge started is held from the sweep (and from the stale count) for its lease after the start; it is still expired for a new claimant.
  if(listed.length===0)assert.equal(side.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(id).status,'queued');
  const taken=await tool('claim',{request_id:id,claimant:'second-process'});
  assert.equal(taken.epoch,2);assert.notEqual(taken.claim_id,c1.claim_id);
  backdate(id,10*60000);lease=claimRow(id).last_claim_activity_at;
  assert.match((await tool('progress',{request_id:id,claim_id:c1.claim_id,note:'stale'})).error,/claim_superseded/);
  assert.match((await tool('finish',{request_id:id,claim_id:c1.claim_id,outcome:'completed',summary:'stale',result:'stale'})).error,/claim_superseded/);
  assert.equal(claimRow(id).last_claim_activity_at,lease,'stale claim_id extended the new holder lease through the server');
  backdate(id,1000); // fresh: an idle own claim would rotate instead (resume wake); a live rival is refused
  assert.match((await tool('claim',{request_id:id,claimant:'dot'})).error,/"error":"claim_busy"/,'a different active run must be refused as claim_busy');
  pass('expired lease shows as expired; takeover bumps the epoch; stale holder cannot write or extend the lease');

  // abandon is refused while a delivery is uncertain, and changes nothing
  side.db.prepare('INSERT INTO notifications(id,kind,request_id,state,created_at) VALUES(?,?,?,?,?)').run(`evt_${randomUUID()}`,'blocker',id,'uncertain',side.stamp());
  assert.equal((await cli('claims','--json')).value.claims[0].uncertain_deliveries,1);
  const refused=await cli('abandon',id,'--reason','worker lost','--json');
  assert.equal(refused.code,1);assert.equal(refused.value.error,'uncertain_delivery: reconcile first');assert.equal(refused.value.http_status,400);
  assert.equal(claimRow(id).state,'active');assert.equal(claimRow(id).claim_id,taken.claim_id);
  assert.equal(side.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(id).status,'claimed');
  side.db.prepare("UPDATE notifications SET state='delivered' WHERE request_id=? AND state='uncertain'").run(id);
  pass('dot-worker abandon refuses while a delivery is uncertain and changes nothing');

  // abandon requeues; the old claim_id is fenced; the next claim is epoch 3
  const abandoned=await cli('abandon',id,'--reason','worker lost','--json');
  assert.equal(abandoned.code,0,abandoned.err);
  assert.deepEqual([abandoned.value.status,abandoned.value.abandoned.claim_id,abandoned.value.abandoned.epoch,abandoned.value.abandoned.reason,abandoned.value.abandoned.actor],['queued',taken.claim_id,2,'worker lost','operator']);
  assert.deepEqual((await cli('claims','--json')).value.claims,[]);
  assert.ok((await tool('list_pending',{})).assignments.some(x=>x.request_id===id),'abandoned assignment not pending');
  assert.equal((await tool('progress',{request_id:id,claim_id:taken.claim_id,note:'stale'})).error,'invalid claim');
  const again=await cli('abandon',id,'--json');
  assert.equal(again.code,1);assert.equal(again.value.error,'no active claim');
  const beforeReclaim=claimRow(id);
  assert.match((await tool('claim',{request_id:id,claimant:'dot'})).error,/claim_busy: prior lease has not expired/,'abandoned grant was reclaimed before its lease expired');
  assert.deepEqual([claimRow(id).claim_id,claimRow(id).last_claim_activity_at],[beforeReclaim.claim_id,beforeReclaim.last_claim_activity_at],'early reclaim changed the old grant');
  backdate(id,leaseMs+1000);
  const reclaimed=await tool('claim',{request_id:id,claimant:'dot'});
  assert.equal(reclaimed.epoch,3);assert.equal(reclaimed.duplicate,false);
  const defaultReason=await cli('abandon',id,'--json');
  assert.equal(defaultReason.value.abandoned.reason,'operator_abandon');
  assert.equal((await cli('abandon','--json')).code,1);
  assert.equal((await cli('abandon',id,'--reason')).code,1);
  const audit=[...readLines(join(home,'.local/state/dalan/requests.jsonl'))].filter(Boolean).map(JSON.parse).filter(x=>x.kind==='claim_abandoned');
  assert.deepEqual(audit.map(x=>x.epoch),[2,3]);
  pass('dot-worker abandon requeues, fences the old claim_id, and the next claim is a new epoch');
  pass('claims admin e2e');
} catch(error) { console.error(`FAIL ${error.stack||error}`); process.exitCode=1; }
finally { side?.db.close(); if(service&&service.exitCode===null){service.kill('SIGTERM');await new Promise(r=>service.once('exit',r));} await rm(home,{recursive:true,force:true}); }
