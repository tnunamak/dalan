import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {root,code,repo,AsStore,approve,declaration,assignment,cleanup,stateOf,assertRefusal,assertAuthorized,refusalCode} from './claim-statechart-fixture.mjs';
after(cleanup);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const IO_MS=5000,START_MS=20000,INIT_MS=30000;
// Test-only self-check: DALAN_STATECHART_MUTATE=http500|bad-token|wrong-claim corrupts the one call whose refusal a test asserts.
// Every strict test must then fail. Unset in normal runs.
const MUTATE=process.env.DALAN_STATECHART_MUTATE||'';
assert.ok(['','setup','http500','bad-token','wrong-claim'].includes(MUTATE),'unknown DALAN_STATECHART_MUTATE '+MUTATE);
async function deadline(promise,label,ms=IO_MS) {
  let timer;
  try {
    return await Promise.race([promise,new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error(label+' timed out')),ms);
    })]);
  } finally { clearTimeout(timer); }
}
const exited=child=>child.exitCode!==null||child.signalCode!==null;
async function stopChild(child) {
  if(exited(child))return;
  const stopped=once(child,'exit');
  child.kill('SIGTERM');
  try { await deadline(stopped,'SIGTERM child exit',2000); }
  catch(error) {
    if(!exited(child))child.kill('SIGKILL');
    await deadline(stopped,'SIGKILL child exit',2000);
  }
}
async function fixture(t) {
  const home=fs.mkdtempSync(path.join(root,'http-')),config=path.join(home,'.config/dalan'),data=path.join(home,'.local/share/dalan');
  let child,auth,stub;
  t.after(async()=>{try{if(child)await stopChild(child);}finally{auth?.close();stub?.close();fs.rmSync(home,{recursive:true,force:true});}});
  assert.notEqual(MUTATE,'setup','injected setup failure');
  const listener=net.createServer();
  let port;
  try {
    await deadline(new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);}), 'port reservation');
    port=listener.address().port;
  } finally {
    if(listener.listening)await deadline(new Promise((resolve,reject)=>listener.close(error=>error?reject(error):resolve())), 'port release');
  }
  const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('DALAN_')||k.startsWith('DOT_BRIDGE_'))delete env[k];
  Object.assign(env,{HOME:home,NODE_ENV:'test',DALAN_LOOPBACK:'1',DALAN_AUTH_MODE:'builtin',DALAN_PORT:String(port),DALAN_ENABLE_WORKSPACE:'1'});
  fs.mkdirSync(config,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(config,'workers.json'),JSON.stringify({default_execution:'worker',workers:{dot:{destination:declaration},other:{}}}),{mode:0o600});
  execFileSync(process.execPath,['bin/dalan.mjs','as-init','--public-url',`http://127.0.0.1:${port}`],{cwd:code,env,stdio:'pipe',timeout:INIT_MS,killSignal:'SIGKILL'});
  child=spawn(process.execPath,['--import',path.join(repo,'scripts/claim-statechart-barrier.mjs'),'src/server.mjs'],{cwd:code,env,stdio:['ignore','pipe','pipe','ipc']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  for(let i=0;i<START_MS/25&&!stdout.includes('MCP listening on')&&child.exitCode===null;i++)await delay(25);
  assert.match(stdout,/MCP listening on/,stderr);
  const secret=fs.readFileSync(path.join(config,'env'),'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1],resource=`http://127.0.0.1:${port}/${secret}/mcp`;
  auth=new AsStore(path.join(config,'as.sqlite'));
  function connect(name,worker='dot',replace=false) {
    const c=approve(auth,name,worker,replace,'grant-'+name,resource),iat=Math.floor(Date.now()/1000),token=randomUUID().replaceAll('-','');
    auth.upsert('Grant',c.grantId,{jti:c.grantId,kind:'Grant',accountId:'owner',clientId:c.client_id,iat,exp:iat+3600},3600);
    auth.upsert('AccessToken',token,{jti:token,kind:'AccessToken',accountId:'owner',clientId:c.client_id,grantId:c.grantId,aud:resource,scope:'dot-bridge.read dot-bridge.work',iat,exp:iat+3600},3600);
    return {...c,token};
  }
  function admin(route,body) {return new Promise((resolve,reject)=>{const req=http.request({socketPath:path.join(data,'admin.sock'),path:route,method:'POST',headers:{'content-type':'application/json'}},res=>{let s='';res.on('data',b=>s+=b);res.on('error',reject);res.on('end',()=>{try{assert.equal(res.statusCode,200,'admin '+route+' HTTP '+res.statusCode);resolve(JSON.parse(s));}catch(error){reject(error);}});});req.on('error',reject);req.setTimeout(IO_MS,()=>req.destroy(new Error('admin '+route+' timed out')));const timer=setTimeout(()=>req.destroy(new Error('admin '+route+' deadline')),IO_MS);req.once('close',()=>clearTimeout(timer));req.end(JSON.stringify(body));});}
  // One MCP tool call. Never throws on a refusal: the result keeps the HTTP status, the JSON-RPC error and the tool error
  // apart, so a test cannot mistake HTTP 500 or an invalid token for a handled refusal.
  async function rpc(c,name,args={},{url=resource,token=c.token}={}) {
    const r=await fetch(url,{signal:AbortSignal.timeout(IO_MS),method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args}})});
    if(!r.ok)return {http:r.status,toolError:`HTTP ${r.status}`};
    const b=await r.json();if(b.error)return {http:r.status,rpcError:b.error};
    const text=b.result.content[0].text;
    if(b.result?.isError)return {http:r.status,toolError:text,code:refusalCode(text)};
    return {http:r.status,data:JSON.parse(text)};
  }
  // The call under test for a refusal. DALAN_STATECHART_MUTATE corrupts exactly this call.
  async function mutated(c,name,args) {
    const options={};
    if(MUTATE==='http500') {
      stub??=http.createServer((req,res)=>{req.resume();res.statusCode=500;res.end('stub failure');});
      if(!stub.listening)await deadline(new Promise((resolve,reject)=>{stub.once('error',reject);stub.listen(0,'127.0.0.1',resolve);}),'stub listen');
      options.url=`http://127.0.0.1:${stub.address().port}/mcp`;
    }
    if(MUTATE==='bad-token')options.token='0'.repeat(32);
    if(MUTATE==='wrong-claim') args=args.claim_id?{...args,claim_id:'claim_'+randomUUID()}:{...args,request_id:'req_'+randomUUID()};
    return rpc(c,name,args,options);
  }
  const a=connect('A');
  async function submit(id) {
    const body={assignment:assignment(id),worker:'dot',owner_token:'owner',delivery:'none',execution:'worker'};
    const preview=await admin('/submit-preview',body);assert.ok(preview.destination_disclosure,JSON.stringify(preview));
    const result=await admin('/submit',{...body,destination_revision:preview.destination_disclosure.revision});assert.ok(!result.error,JSON.stringify(result));
  }
  const state=id=>{const db=new DatabaseSync(path.join(data,'bridge.db'),{readOnly:true});try{return stateOf(db,id,{telemetry:false});}finally{db.close();}};
  // Authorized setup calls: succeed with HTTP 200 and a decoded result, or the test stops.
  const ok=async(c,name,args,label=name)=>assertAuthorized(await rpc(c,name,args),label);
  const refuse=async(c,name,args,code,label=name)=>{const res=await mutated(c,name,args);assertRefusal(res,code,label);return res;};
  const claim=async(c,id)=>{
    const got=await ok(c,'claim',{request_id:id,claimant:'run',acquisition_id:'acq'});
    assert.match(got.claim_id,/^claim_/);assert.equal(got.epoch,1);
    const s=state(id);assert.equal(s.assignment.status,'claimed');assert.equal(s.claims.length,1);assert.equal(s.claims[0].claim_id,got.claim_id);assert.equal(s.claims[0].state,'active');
    return got;
  };
  const queued=async id=>{await submit(id);const s=state(id);assert.equal(s.assignment.status,'queued');assert.deepEqual(s.claims,[]);assert.deepEqual(s.reports,[]);};
  return {a,auth,child,connect,submit,rpc,ok,refuse,claim,queued,state,mutated,live:()=>auth.liveConnectionIds('dot')};
}

// Known limit (SECURITY.md, "Known limits"): get and list_pending are open to every authenticated worker connection of the
// worker, as PROTOCOL.md documents. After the owner replaces A with B, B can read a queued job that was approved for A.
// B still cannot claim it or change it. These two tests pin that read behavior and its no-write half, so closing the gap is a
// deliberate change. spec/tla/ClaimsReads.cfg expects the matching ReadAdmitted violation.
test('ReadAdmitted/get known limit: B can read the brief approved for A but changes nothing',async t=>{
  const f=await fixture(t);await f.queued('req_http_read_get');
  assert.equal((await f.ok(f.a,'get',{request_id:'req_http_read_get'},'A get before replacement')).assignment.brief,'CANARY state path'); // the job is readable by its approved connection
  const b=f.connect('B','dot',true);assert.deepEqual(f.live(),[b.connection_id]);
  const before=f.state('req_http_read_get');
  await f.queued('req_http_read_get_b'); // approved for B after it became live
  assert.equal((await f.ok(b,'get',{request_id:'req_http_read_get_b'},'B get of its own job')).assignment.brief,'CANARY state path'); // B is authorized and get works
  const res=await f.mutated(b,'get',{request_id:'req_http_read_get'});
  assert.equal(assertAuthorized(res,'B get of A job').assignment.brief,'CANARY state path'); // the limit: B reads A's brief
  assert.deepEqual(f.state('req_http_read_get'),before); // no claim, report, note-seen cursor or lifecycle change
});
test('ReadAdmitted/list_pending known limit: B lists the job approved for A but changes nothing',async t=>{
  const f=await fixture(t);await f.queued('req_http_read_list');
  const idsFor=async c=>(await f.ok(c,'list_pending',{},'list_pending')).assignments.map(x=>x.request_id);
  assert.deepEqual(await idsFor(f.a),['req_http_read_list']); // the job is listed for its approved connection
  const b=f.connect('B','dot',true);assert.deepEqual(f.live(),[b.connection_id]);
  const before=f.state('req_http_read_list');
  await f.queued('req_http_read_list_b'); // approved for B after it became live
  const listed=await idsFor(b);
  assert.ok(listed.includes('req_http_read_list_b'),'B list_pending must work and list its own job: '+listed); // B is authorized and the call works
  assert.ok(listed.includes('req_http_read_list'),'the limit: B lists the job approved for A: '+listed);
  assert.deepEqual(f.state('req_http_read_list'),before);
});
test('GrantAdmitted/http: live B cannot recover A claim with same run identifiers',async t=>{
  const f=await fixture(t);await f.queued('req_http_duplicate');
  const a=await f.claim(f.a,'req_http_duplicate');
  const b=f.connect('B','dot',true);assert.deepEqual(f.live(),[b.connection_id]);
  const before=f.state('req_http_duplicate');
  await f.queued('req_http_duplicate_b');
  const listed=(await f.ok(b,'list_pending',{},'B list_pending')).assignments.map(x=>x.request_id);
  assert.ok(listed.includes('req_http_duplicate_b'),'B must be authorized and see the job approved for it: '+listed); // refusal below is not an auth failure
  await f.refuse(b,'claim',{request_id:'req_http_duplicate',claimant:'run',acquisition_id:'acq'},'destination_changed','B replay of A claim');
  const after=f.state('req_http_duplicate');
  assert.deepEqual(after,before); // claim row, activity, deadline, report and lifecycle are unchanged
  assert.equal(after.claims[0].claim_id,a.claim_id);assert.deepEqual(after.reports,[]);
});
for(const revoke of [false,true]) test(revoke?'RevokedCannotCommit/http: revoke while finish waits in makeRoom':'RevokedCannotCommit/http control: live finish through makeRoom',async t=>{
  const f=await fixture(t);const id='req_http_revoke_finish';await f.queued(id);
  const a=await f.claim(f.a,id);
  const gate=once(f.child,'message',{signal:AbortSignal.timeout(IO_MS)});
  const finishing=f.mutated(f.a,'finish',{request_id:id,claim_id:a.claim_id,outcome:'completed',summary:'summary',result:'result'});
  // Attach a handler immediately: finish may fail before the barrier is reached.
  const settled=finishing.then(value=>({value}),error=>({error}));
  let before;
  try {
    const [msg]=await gate;assert.equal(msg.barrier,id); // finish was authenticated and admitted, then paused before commit
    before=f.state(id);assert.equal(before.assignment.status,'claimed');assert.deepEqual(before.reports,[]);
    if(revoke)f.auth.revokeGrant(f.a.grantId,'owner');
    assert.equal(f.live().includes(f.a.connection_id),!revoke,'connection liveness at barrier');
  } finally {
    if(f.child.connected&&!exited(f.child)) {
      await deadline(new Promise((resolve,reject)=>f.child.send({continue:true},error=>error?reject(error):resolve())),'barrier release');
    }
    // Reap the request even if the gate assertion or revoke failed.
    await deadline(settled,'finish settlement');
  }
  const outcome=await settled;if(outcome.error)throw outcome.error;
  const after=f.state(id);
  if(!revoke) {
    const result=assertAuthorized(outcome.value,'live finish');
    assert.equal(result.status,'finished');
    assert.equal(after.assignment.status,'finished');assert.equal(after.reports.length,1);
    assert.equal(after.reports[0].claim_id,a.claim_id);
    assert.equal(after.claims.length,1);assert.equal(after.claims[0].state,'active'); // claims.state is only active|abandoned; the assignment carries 'finished'
  } else {
    if(outcome.value.toolError!==undefined)assertRefusal(outcome.value,'connection_not_live','finish after revoke');
    else assertAuthorized(outcome.value,'finish after revoke');
    await t.test('desired contract',()=>{
      assertRefusal(outcome.value,'connection_not_live','finish after revoke');
      assert.deepEqual(after,before);
    });
  }
});
test('HTTP authentication refuses revoked A; other worker cannot get A job',async t=>{
  const f=await fixture(t);const id='req_http_isolation';await f.queued(id);const other=f.connect('C','other');
  assert.equal((await f.ok(f.a,'get',{request_id:id},'A get before revocation')).assignment.brief,'CANARY state path');
  assert.deepEqual(await f.ok(other,'list_pending',{},'C list_pending').then(x=>x.assignments),[]); // C is authorized and sees nothing of A
  const missing=await f.rpc(other,'get',{request_id:id});
  assert.equal(missing.http,200);assert.equal(missing.rpcError,undefined);assert.equal(missing.toolError,'message not found'); // another worker gets the same answer as for a missing job
  f.auth.revokeGrant(f.a.grantId,'owner');
  const revoked=await f.rpc(f.a,'get',{request_id:id});
  assert.equal(revoked.http,401); // a revoked bearer is refused at authentication, before any tool runs
  assert.equal(f.state(id).assignment.status,'queued');
});
