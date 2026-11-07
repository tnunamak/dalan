import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { createT3Destination } from '../src/destinations/t3.mjs';
import { fixtureEnv } from '../src/test-support/fixture-env.mjs';
import { skipCheck } from '../src/test-support/skipped-check.mjs';
import { prepublicSkip, readPrepublicFixture } from '../src/test-support/prepublic-fixtures.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'db88-'));
after(()=>fs.rmSync(root,{recursive:true,force:true}));
// The C3 checks upgrade a database written by the pre-public parent Store; they skip when that archive is absent.
const PARENT_ARCHIVE='src/test-support/worker-history/a727609.tgz';
const parentSkip=prepublicSkip(PARENT_ARCHIVE);
// 22 checks use the archive: 18 upgrade cases (2 deliveries × 3 states × 3 generations), 3 tie cases and 1 later-claim case.
if(parentSkip)skipCheck('C3 upgrade checks against the pre-public parent release',parentSkip,{count:22});
let ParentStore;
if(!parentSkip){
  const parent=path.join(root,'parent');fs.mkdirSync(parent);
  assert.equal(spawnSync('tar',['-xz','-C',parent],{input:readPrepublicFixture(PARENT_ARCHIVE)}).status,0);
  ({Store:ParentStore}=await import(pathToFileURL(path.join(parent,'src/store.mjs'))));
}
const payload=id=>({schema_version:1,request_id:id,brief:'review regression',inputs:[],expected_output:'one result',execution_scope:'read-only'});
const question='QUESTION: May I proceed?';
const rows=(store,id)=>store.db.prepare('SELECT * FROM notifications WHERE request_id=? ORDER BY rowid').all(id);

['none','t3'].forEach(delivery=>['pending','delivered','uncertain'].forEach(state=>['initial','prior-answer','prior-rotation'].forEach(generation=>{
  test(`C3 upgrade: ${delivery}, ${state}, ${generation} preserves the parent question`,{skip:parentSkip},t=>{
    let now=Date.parse('2026-10-27T12:00:00Z');
    const file=path.join(root,`${delivery}-${state}-${generation}.db`);
    let store=new ParentStore(file,{now:()=>now});t.after(()=>store.db.close());
    const id='req_upgrade';store.submit(payload(id),delivery==='none'?{mode:'none'}:'thread','environment','owner');
    let claim=store.claim(id,'holder');
    if(generation==='prior-answer')store.note(id,'First answer before this question.');
    if(generation==='prior-rotation')claim=store.resume(id,'local-principal');
    if(generation!=='initial')now++;
    store.progress(id,claim.claim_id,question);
    const notice=rows(store,id)[0];
    // Retain realistic send evidence as well as the old body and notification ID.
    store.db.prepare('UPDATE notifications SET state=?,attempt_id=?,attempt_started_at=?,attempts=2 WHERE id=?').run(state,'original-attempt',store.stamp(),notice.id);
    const before={...rows(store,id)[0]};assert.equal(before.body,JSON.stringify({note:question}));
    store.db.close();store=new Store(file,{now:()=>now});
    store.progress(id,claim.claim_id,question);store.progress(id,claim.claim_id,question);
    assert.deepEqual(rows(store,id).map(row=>({...row})),[before],'upgrade changed notification identity or transport evidence');
    // Even a same-millisecond answer must open a new generation, not match all legacy text.
    store.note(id,'Proceed to the next decision.');
    store.progress(id,claim.claim_id,question);store.progress(id,claim.claim_id,question);
    assert.equal(rows(store,id).length,2);assert.equal(rows(store,id)[1].state,'pending');
    assert.notEqual(rows(store,id)[1].id,notice.id);assert.deepEqual({...rows(store,id)[0]},before);
  });
})));

['pending','delivered','uncertain'].forEach(state=>test(`C3 tie: ${state} legacy rows cannot reveal answer order`,{skip:parentSkip},t=>{
  const now=Date.parse('2026-10-27T12:00:00Z'),id='req_tied_answer';
  t.mock.timers.enable({apis:['Date'],now});
  const seedFile=path.join(root,`tie-${state}-seed.db`);
  const seed=new ParentStore(seedFile,{now:()=>now});
  seed.submit(payload(id),{mode:'none'},null,'owner');const claim=seed.claim(id,'holder');seed.db.close();
  const histories=['answer-first','question-first'].map(order=>{
    const file=path.join(root,`tie-${state}-${order}.db`);fs.copyFileSync(seedFile,file);
    const parent=new ParentStore(file,{now:()=>now});
    const answer=()=>parent.note(id,'Proceed to the next decision.');
    if(order==='answer-first')answer();
    parent.progress(id,claim.claim_id,question);
    const notice=rows(parent,id)[0];
    if(state==='delivered') {
      const item=parent.claimWaiterDelivery(id,0);parent.settleWaiterDelivery(item.id);
    } else if(state==='uncertain') {
      const attempt=parent.startAttempt(notice.id,['fixture']);
      parent.finishAttempt(notice.id,attempt.attempt_id,'uncertain','fixture transport outcome unknown');
    }
    if(order==='question-first')answer();
    const original={...rows(parent,id)[0]};
    // Compare every table, including table-local rowids and sqlite_sequence. UUIDs
    // identify objects, but their random values encode no cross-table ordering.
    const tables=parent.db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name").all();
    const snapshot=tables.map(table=>({...table,rows:parent.db.prepare(`SELECT ${/WITHOUT ROWID/i.test(table.sql)?'*':'rowid AS _rowid_,*'} FROM "${table.name}" ORDER BY 1`).all()}));
    const identities=[[parent.ownerNotes(id)[0].id,'NOTE_ID'],[original.id,'NOTICE_ID'],[original.attempt_id,'ATTEMPT_ID']];
    const normalized=identities.reduce((text,[value,label])=>value?text.replaceAll(value,label):text,JSON.stringify(snapshot));
    parent.db.close();return {file,original,snapshot:JSON.parse(normalized)};
  });
  assert.deepEqual(histories[0].snapshot,histories[1].snapshot,'legacy rows unexpectedly distinguish opposite answer order');
  histories.forEach(({file,original})=>{
    let store=new Store(file,{now:()=>now});t.after(()=>store.db.close());
    store.progress(id,claim.claim_id,question);store.progress(id,claim.claim_id,question);
    assert.deepEqual({...rows(store,id)[0]},original,'upgrade changed the legacy delivery evidence');
    assert.equal(rows(store,id).length,2,'the ambiguous generation must receive one new notification');
    if(state==='pending') {
      const unsent=store.claimWaiterDelivery(id,0);assert.equal(unsent.id,original.id,'an unsent legacy question was dropped');
      store.settleWaiterDelivery(unsent.id);
    }
    const fresh=store.claimWaiterDelivery(id,0);assert.ok(fresh,'an undelivered post-answer question was suppressed');
    assert.notEqual(fresh.id,original.id);assert.deepEqual(JSON.parse(fresh.body),{note:question,epoch:claim.epoch,owner_note_seq:1});
    store.settleWaiterDelivery(fresh.id);
    store.db.close();store=new Store(file,{now:()=>now});
    store.progress(id,claim.claim_id,question);store.progress(id,claim.claim_id,question);
    assert.equal(rows(store,id).length,2,'restart created another notification in the same generation');
    assert.equal(store.claimWaiterDelivery(id,0),null,'retry delivered the modern generation twice');
    assert.equal(rows(store,id)[0].state,state==='pending'?'delivered':state);
    if(state!=='pending')assert.deepEqual({...rows(store,id)[0]},original,'restart changed old transport evidence');
  });
}));

test('C3 upgrade: a later claim cannot reuse a legacy question generation',{skip:parentSkip},t=>{
  const file=path.join(root,'later-claim.db'),now=Date.parse('2026-10-27T12:00:00Z');
  let store=new ParentStore(file,{now:()=>now});t.after(()=>store.db.close());
  const id='req_later_claim';store.submit(payload(id),{mode:'none'},null,'owner');
  const first=store.claim(id,'holder');store.progress(id,first.claim_id,question);
  const original=store.claimWaiterDelivery(id,0);store.settleWaiterDelivery(original.id);
  const current=store.resume(id,'local-principal');
  store.db.close();store=new Store(file,{now:()=>now});
  store.progress(id,current.claim_id,question);store.progress(id,current.claim_id,question);
  assert.equal(rows(store,id).length,2);assert.equal(rows(store,id)[1].state,'pending');
  assert.equal(rows(store,id)[0].id,original.id);assert.equal(rows(store,id)[0].state,'delivered');
});

test('C2: artifact-bearing MCP finish retry survives real retention cleanup',async t=>{
  const home=path.join(root,'mcp'),env=fixtureEnv(home,{DOT_BRIDGE_PORT:'0',DOT_BRIDGE_AUTH_MODE:'oauth',DOT_BRIDGE_TEST_OAUTH:'1',DOT_BRIDGE_ENABLE_WORKSPACE:'1',DOT_BRIDGE_MIN_FREE_BYTES:'0'});
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const jwk={...publicKey.export({format:'jwk'}),kid:'fixture',use:'sig'};
  const jwks=http.createServer((req,res)=>res.end(JSON.stringify({keys:[jwk]})));
  await new Promise(resolve=>jwks.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>jwks.close(resolve)));
  const issuer=`http://127.0.0.1:${jwks.address().port}/realm`,audience='https://fixture.example';
  fs.mkdirSync(path.join(home,'.config/dot-bridge'),{recursive:true});
  fs.writeFileSync(path.join(home,'.config/dot-bridge/oauth.env'),`OAUTH_ISSUER=${issuer}\nOAUTH_AUDIENCE=${audience}\nOAUTH_JWKS_URI=http://127.0.0.1:${jwks.address().port}/jwks\nOAUTH_ALLOWED_SUBJECTS=dot\n`,{mode:0o600});
  const data=path.join(home,'.local/share/dot-bridge');fs.mkdirSync(data,{recursive:true});
  const store=new Store(path.join(data,'bridge.db'),{now:()=>Date.now()-15*86400000});t.after(()=>store.db.close());
  const id='req_artifact_retry',artifact='art_fixture',file=path.join(home,'retained-upload');
  store.submit(payload(id),{mode:'none'},null,'owner');const claim=store.claim(id,'holder','dot');
  fs.writeFileSync(file,'test');
  store.db.prepare("INSERT INTO artifacts(id,request_id,claim_id,kind,path,size,sealed,created_at,retention_until) VALUES(?,?,?,'upload',?,4,1,?,?)").run(artifact,id,claim.claim_id,file,store.stamp(),new Date(Date.now()-86400000).toISOString());
  store.assertSealedArtifacts(id,claim.claim_id,[artifact]);
  const receipt=store.finish(id,claim.claim_id,'completed','done','report','dot');
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:new URL('..',import.meta.url),env,stdio:['ignore','pipe','pipe']});
  const closed=new Promise(resolve=>child.once('exit',resolve));
  t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await closed;}});
  let output='',errors='';child.stderr.on('data',b=>errors+=b);
  const port=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('MCP startup timeout: '+errors)),10000);
    child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);reject(new Error('MCP exited: '+errors));});
    child.stdout.on('data',b=>{output+=b;const found=/MCP listening on (?:127\.0\.0\.1|0\.0\.0\.0):(\d+)/.exec(output);if(found){clearTimeout(timer);resolve(Number(found[1]));}});
  });
  // Startup runs Workspace.cleanupExpired, which removes the expired file and metadata.
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{clearInterval(tick);reject(new Error('artifact retention cleanup timed out'));},10000);
    const tick=setInterval(()=>{
      if(!store.db.prepare('SELECT 1 FROM artifacts WHERE id=?').get(artifact)){clearTimeout(timer);clearInterval(tick);resolve();}
    },25);
  });
  assert.equal(fs.existsSync(file),false,'real retention left the artifact file behind');
  const secret=fs.readFileSync(path.join(home,'.config/dot-bridge/env'),'utf8').match(/^BRIDGE_PATH_SECRET=(.+)$/m)[1];
  const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'fixture'})).toString('base64url');
  const claims=Buffer.from(JSON.stringify({iss:issuer,aud:audience,exp:Math.floor(Date.now()/1000)+300,sub:'dot',scope:'dot-bridge.read dot-bridge.work'})).toString('base64url');
  const signed=header+'.'+claims,token=signed+'.'+sign('RSA-SHA256',Buffer.from(signed),privateKey).toString('base64url');
  const call=async changes=>{
    const response=await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'finish',arguments:{request_id:id,claim_id:claim.claim_id,outcome:'completed',summary:'done',result:'report',artifact_ids:[artifact],...changes}}})});
    assert.equal(response.status,200);return (await response.json()).result;
  };
  const control=await call({artifact_ids:[]});assert.equal(control.isError,false,JSON.stringify(control));
  assert.equal(JSON.parse(control.content[0].text).receipt_id,receipt.receipt_id);
  const retry=await call();assert.equal(retry.isError,false,JSON.stringify(retry));
  assert.equal(JSON.parse(retry.content[0].text).receipt_id,receipt.receipt_id);assert.equal(JSON.parse(retry.content[0].text).duplicate,true);
  const changed=await call({result:'changed'});assert.equal(changed.isError,true);assert.match(changed.content[0].text,/contradictory report/);
  assert.equal((await call({claim_id:'unknown-claim'})).isError,true);
  assert.equal(store.db.prepare('SELECT count(*) n FROM reports WHERE request_id=?').get(id).n,1);
  assert.equal(store.db.prepare("SELECT count(*) n FROM lifecycle_events WHERE request_id=? AND type='completed'").get(id).n,1);
  assert.equal(rows(store,id).filter(row=>row.body===null).length,1);
});

['disconnect','recovery','quiet'].forEach(mode=>test(`C4 internal cleanup: ${mode} cannot revive a finished question`,async t=>{
  const file=mode==='recovery'?path.join(root,'wait-recovery.db'):':memory:';
  const store=new Store(file);t.after(()=>store.db.close());
  const id='req_cleanup';store.submit(payload(id),mode==='quiet'?'thread':{mode:'none'},'environment','owner');
  const claim=store.claim(id,'holder');store.progress(id,claim.claim_id,question);const item=rows(store,id)[0];
  const finish=()=>store.finish(id,claim.claim_id,'completed','done','report');
  if(mode==='quiet') {
    const started=store.startAttempt(item.id,null);
    const destination=createT3Destination({store,env:{},quiet:()=> 'protected T3 destination',inspectThread:async()=>{finish();return {state:'active'};},callT3:async()=>assert.fail('finished question sent')});
    const result=await destination.send(item,{started,argv:destination.argv(item,store.get(id))});
    store.finishAttempt(item.id,started.attempt_id,result.state,result.reason);
  } else {
    store.claimWaiterDelivery(id,0);finish();
    if(mode==='disconnect')store.releaseWaiterDelivery(item.id);
    else {
      const reopened=new Store(file);t.after(()=>reopened.db.close());reopened.recoverSends();
      assert.equal(rows(reopened,id).find(row=>row.id===item.id).state,'waiting','reopening another Store released a live waiter reservation');
      reopened.releaseWaiterDelivery(item.id); // simulate the owning HTTP response channel closing
      assert.equal(rows(reopened,id).find(row=>row.id===item.id).state,'suppressed','released finished question was not retired');
    }
  }
  assert.equal(rows(store,id).find(row=>row.id===item.id).state,'suppressed');
  assert.equal(store.claimWaiterDelivery(id,0).body,null,'old question preceded the result');
}));
