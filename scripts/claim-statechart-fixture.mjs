import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
export const repo=path.resolve(new URL('..',import.meta.url).pathname);
const scratch=process.env.DALAN_STATECHART_TMP??path.join(os.homedir(),'.tmp/dalan-statechart');
fs.mkdirSync(scratch,{recursive:true});
export const root=fs.mkdtempSync(path.join(scratch,'replay-'));
export const code=repo;
export const load=name=>import(pathToFileURL(path.join(code,'src',name)).href);
export const {Store}=await load('store.mjs');
export const {AsStore}=await load('as-store.mjs');
export const workers=await load('workers.mjs');
export const declaration={operator:'Fixture',provider:'Fixture',data_categories:['assignment','results'],retention:'30 days',training:'none',terms:'v1'};
export const assignment=id=>({schema_version:1,request_id:id,brief:'CANARY state path',inputs:[],expected_output:'report',execution_scope:'read-only'});
export function approve(auth,name,worker='dot',replace=false,grantId='grant-'+name,resource='https://fixture.invalid/mcp') {
  auth.closeWindow();const window=auth.openWindow(worker,10),client_id='client-'+name;
  auth.admission.run(window.generation,()=>auth.upsert('Client',client_id,{client_id}));
  if(!auth.find('Grant',grantId))auth.upsert('Grant',grantId,{clientId:client_id},3600);
  const snapshot={client_id,client_name:name,redirect_uri:'https://fixture.invalid/callback',resource,scopes:'dot-bridge.read dot-bridge.work',interaction_expires_at:Date.now()+600000};
  const pairing=auth.pairingFor('interaction-'+name,snapshot,window);
  if(!auth.reserve(pairing.code))throw new Error('reserve failed');
  return {...auth.commitApproval({code:pairing.code,worker,grantId,snapshot,replace}),grantId,client_id};
}
export function fixture(t) {
  const dir=fs.mkdtempSync(path.join(root,'store-')),file=path.join(dir,'bridge.db');
  const auth=new AsStore(path.join(dir,'as.sqlite'));
  let now=Date.now();
  const profile=workers.parseWorkers({default_execution:'worker',workers:{dot:{destination:declaration,guidance:'resume'},other:{destination:declaration}}},{builtin:true,builtinConnectionIds:w=>auth.liveConnectionIds(w)});
  const options={workers:profile,destinationProfile:()=>profile,now:()=>now,resumeIdleMs:1,connectionIsLive:c=>auth.connectionIsLive(c)};
  let store=new Store(file,options);
  t.after(()=>{store.db.close();auth.close();fs.rmSync(dir,{recursive:true,force:true});});
  const f={auth,profile,clock:ms=>now+=ms,restart:()=>{store.db.close();store=new Store(file,options);},get store(){return store;},
    approve:(name,w='dot',replace=false)=>approve(auth,name,w,replace)};
  f.submit=(id='req_statechart',revision=workers.destinationDisclosure(profile,'dot','worker',assignment(id)).revision)=>store.submit(assignment(id),{mode:'none'},'','owner',false,null,'normal',{source:'agent'},assignment(id),null,'dot','worker','worker',null,null,null,null,revision);
  f.claim=(id='req_statechart',who='run',acq='acq',conn=f.a.connection_id)=>store.claim(id,who,'owner',100,null,'dot',acq,10,null,conn);
  f.a=f.approve('A');return f;
}
export const cleanup=()=>fs.rmSync(root,{recursive:true,force:true});

// ---- Strict observations shared by the Store and HTTP replays ----
// Tool counters are telemetry; the HTTP replay excludes them because an authenticated refused call may count as a call.
const TELEMETRY=['tool_calls','last_tool','last_tool_at','last_tool_error','first_workspace_tool_at'];
// Everything a refusal must leave alone: assignment state, every claim row (claim id, epoch, activity, lease and
// deadline columns), every report row and the lifecycle log. Read-only SQL, so observing it changes nothing.
export function stateOf(db,id,{telemetry=true}={}) {
  const strip=row=>{if(telemetry)return row;const copy={...row};for(const key of TELEMETRY)delete copy[key];return copy;};
  return {
    assignment:db.prepare('SELECT status,cancelled_at,cancelled_reason FROM assignments WHERE request_id=?').get(id)??null,
    claims:db.prepare('SELECT * FROM claims WHERE request_id=? ORDER BY claim_id').all(id).map(strip),
    reports:db.prepare('SELECT * FROM reports WHERE request_id=? ORDER BY claim_id').all(id),
    lifecycle:db.prepare('SELECT claim_id,epoch,type,actor,reason FROM lifecycle_events WHERE request_id=? ORDER BY id').all(id)
  };
}
// The Store throws destinationError(details): the machine-readable code is error.destination.error, not message text.
export function assertDestinationRefusal(fn,code) {
  assert.throws(fn,error=>{
    assert.equal(error.destination?.error,code,'wrong or missing refusal code: '+String(error.message).slice(0,200));
    return true;
  });
}
// A tool result from the HTTP replay: {http, rpcError?, toolError?, code?, data?}. A handled refusal is HTTP 200 with a
// tool error whose JSON body carries the exact code. HTTP 500, 401, a JSON-RPC error or another code are never a refusal.
export function assertRefusal(res,code,label='call') {
  assert.equal(res.http,200,`${label}: expected a handled refusal (HTTP 200), got HTTP ${res.http} ${res.toolError??res.rpcError??''}`.slice(0,300));
  assert.equal(res.rpcError,undefined,`${label}: unexpected JSON-RPC error ${JSON.stringify(res.rpcError)}`);
  assert.equal(typeof res.toolError,'string',`${label}: expected a tool error, got ${JSON.stringify(res.data)?.slice(0,200)}`);
  assert.equal(res.code,code,`${label}: wrong refusal code (${res.code}): ${res.toolError.slice(0,200)}`);
}
// An authorized call: HTTP 200, no error of either kind, and a decoded result.
export function assertAuthorized(res,label='call') {
  assert.equal(res.http,200,`${label}: expected HTTP 200, got HTTP ${res.http} ${res.toolError??res.rpcError??''}`.slice(0,300));
  assert.equal(res.rpcError,undefined,`${label}: JSON-RPC error ${JSON.stringify(res.rpcError)}`);
  assert.equal(res.toolError,undefined,`${label}: tool error ${res.toolError}`);
  assert.equal(typeof res.data,'object',`${label}: no result`);
  return res.data;
}
export const refusalCode=text=>{try{const code=JSON.parse(text)?.error;return typeof code==='string'?code:undefined;}catch{return undefined;}};
