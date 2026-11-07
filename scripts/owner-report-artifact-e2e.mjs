import assert from 'node:assert/strict';
import fs from 'node:fs';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir, homedir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {generateKeyPairSync,sign} from 'node:crypto';
import {spawn} from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import {Store} from '../src/store.mjs';
import {captureOwnerReportArtifact,prepareOwnerReportArtifact,ownerReportArtifactBytes,OWNER_REPORT_ARTIFACT_LIMIT} from '../src/owner-report-artifact.mjs';
import {redactSecrets} from '../src/redaction.mjs';
import {finishProtocol} from '../src/protocol-finish.mjs';

const canaryToken=['gh','p_','abcdefghijklmnopqrstuvwxyz','1234567890'].join('');
const dash='-',begin=['BE','GIN'].join(''),end=['EN','D'].join('');
const privateKeyLabel=['PRI','VATE',' ','K','EY'].join('');
const harmlessOpen=dash+'BEGIN harmless';
const harmlessClose='PRIVATE '+'KEY'+dash;

const root=mkdtempSync(join(tmpdir(),'owner-report-artifact-'));
const oldRoot=process.env.DOT_BRIDGE_WORKSPACE_ROOT;
process.env.DOT_BRIDGE_WORKSPACE_ROOT=join(root,'workspace');
const {Workspace}=await import('../src/workspace.mjs');
let store;
let httpRoot;
try {
  store=new Store(join(root,'bridge.sqlite'));
  const id='owner-report-case',subject='offline-owner';
  const assignment={schema_version:1,request_id:id,brief:'read-only archive regression',inputs:[],scope_paths:[],execution_scope:'read-only'};
  store.submit(assignment,{mode:'none'},null,'owner-capability',false);
  const claim=store.claim(id,'offline-claimant',subject,20);
  const first='DELIVERABLE part 1/2\n'+('research evidence '.repeat(400))+' '+canaryToken;
  const second='DELIVERABLE part 2/2\n'+('conclusions and limits '.repeat(400));
  store.progress(id,claim.claim_id,first,subject,false,'dot');
  store.progress(id,claim.claim_id,second,subject,false,'dot');
  let workspace=new Workspace(store,false);
  const rawId='owner-report-structured-writer';store.submit({...assignment,request_id:rawId},{mode:'none'},null,'owner-capability',false);
  const rawClaim=store.claim(rawId,'offline-claimant',subject,20),secret=canaryToken;
  const rawDoc={format:'dalan-owner-report',version:1,summary:'safe',result:secret,progress:[]};
  const prepared=prepareOwnerReportArtifact(rawDoc);
  assert.doesNotThrow(()=>prepareOwnerReportArtifact({...rawDoc,format:'dot-bridge-owner-report'}),'the original format id is still accepted');
  assert.throws(()=>prepareOwnerReportArtifact({...rawDoc,format:'other'}),/invalid owner report/);
  assert.throws(()=>workspace.saveArtifact(rawId,rawClaim.claim_id,'owner-report',Buffer.from(JSON.stringify(rawDoc))),/requires a prepared document/);
  assert.throws(()=>workspace.saveArtifact(rawId,rawClaim.claim_id,'owner-report',{...prepared}),/requires a prepared document/);
  const copiedBytes=ownerReportArtifactBytes(prepared);copiedBytes.fill(0);
  assert(JSON.parse(ownerReportArtifactBytes(prepared).toString()),'a returned byte copy cannot mutate prepared storage bytes');
  const rawRef=workspace.saveArtifact(rawId,rawClaim.claim_id,'owner-report',prepared);
  const rawSaved=JSON.parse(workspace.artifact(rawRef.artifact_id,rawId).bytes.toString());
  assert.equal(rawSaved.result,'[redacted secret]','structured writer must still redact raw string values');
  assert.throws(()=>prepareOwnerReportArtifact({...rawDoc,extra:secret}),/invalid owner report artifact document/);
  const ordinaryRef=workspace.saveArtifact(rawId,rawClaim.claim_id,'check-output',Buffer.from(secret));
  assert.equal(workspace.artifact(ordinaryRef.artifact_id,rawId).bytes.toString(),'[redacted secret]','other text artifacts retain existing redaction');
  for(const [label,summary,result,notes] of [
    ['armor',harmlessOpen,harmlessClose,[]],
    ['url','https://fixture-user:abcdef','@remote.invalid/',[]],
    ['progress','ordinary summary','ordinary result',[harmlessOpen,harmlessClose]],
    ['nested','ordinary summary','ordinary result',[harmlessOpen+dash.repeat(5)+begin+' '+privateKeyLabel+dash.repeat(5)+' x'+dash.repeat(5)+end+' '+privateKeyLabel+dash.repeat(5)+'\n'+harmlessClose]],
  ]) {
    const requestId=`owner-report-cross-${label}`;
    store.submit({...assignment,request_id:requestId},{mode:'none'},null,'owner-capability',false);
    const grant=store.claim(requestId,'offline-claimant',subject,20);
    for(const note of notes)store.progress(requestId,grant.claim_id,note,subject,false,'dot');
    store.finish(requestId,grant.claim_id,'completed',summary,result,subject,null,'dot',null,
      onRollback=>({owner_report_artifact:captureOwnerReportArtifact(store,workspace,{requestId,claimId:grant.claim_id,outcome:'completed',summary,result,onRollback})}));
    const ref=store.get(requestId).report.workspace_evidence.owner_report_artifact;
    const doc=JSON.parse(workspace.artifact(ref.artifact_id,requestId).bytes.toString());
    // The report is split-checked as one record: fragments that join into armor or URL userinfo across fields are
    // masked; a field that is complete on its own is masked on its own.
    if(label==='nested') {
      assert.equal(doc.summary,summary);assert.equal(doc.result,result);
      assert.deepEqual(doc.progress.map(row=>row.text),notes.map(note=>redactSecrets(note).text));
    } else {
      const fields=[doc.summary,doc.result,...doc.progress.map(row=>row.text)];
      for(const piece of [summary,result,...notes]) if(piece.startsWith(dash)||piece.startsWith('PRIVATE')||piece.includes('abcdef')) assert(!fields.includes(piece),`${label}: split fragment kept: ${piece}`);
      assert(doc.progress.every(row=>row.at!=='[redacted secret]'),'bridge timestamps stay readable');
    }
  }
  const receipt=store.finish(id,claim.claim_id,'completed','short summary','short result',subject,null,'dot',null,
    onRollback=>({owner_report_artifact:captureOwnerReportArtifact(store,workspace,{requestId:id,claimId:claim.claim_id,outcome:'completed',summary:'short summary',result:'short result',onRollback})}));
  assert.equal(receipt.result_authority,true);
  const evidence=store.get(id).report.workspace_evidence;
  assert.ok(evidence?.owner_report_artifact,`archive evidence missing; evidence keys: ${Object.keys(evidence??{}).join(',')}`);
  assert.equal(evidence.owner_report_artifact.kind,'owner-report');
  const archive=workspace.artifact(evidence.owner_report_artifact.artifact_id,id);
  assert.equal(archive.bytes.length,evidence.owner_report_artifact.size);
  assert.equal(createHash('sha256').update(archive.bytes).digest('hex'),evidence.owner_report_artifact.sha256);
  const document=JSON.parse(archive.bytes.toString());
  assert.equal(document.format,'dalan-owner-report');
  assert.equal(document.summary,'short summary');assert.equal(document.result,'short result');
  assert.deepEqual(document.progress.map(note=>note.text),[first.replace(/ghp_[A-Za-z0-9]{20,}/,'[redacted secret]'),second]);
  assert.equal(store.db.prepare("SELECT count(*) n FROM artifacts WHERE request_id=? AND kind='owner-report'").get(id).n,1);
  assert(OWNER_REPORT_ARTIFACT_LIMIT===8*1024*1024);
  const replay=store.finish(id,claim.claim_id,'completed','short summary','short result',subject,null,'dot');
  assert.equal(replay.receipt_id,receipt.receipt_id);
  assert.equal(store.db.prepare("SELECT count(*) n FROM artifacts WHERE request_id=? AND kind='owner-report'").get(id).n,1);
  store.db.close();store=new Store(join(root,'bridge.sqlite'));
  workspace=new Workspace(store,false);
  assert.equal(store.finish(id,claim.claim_id,'completed','short summary','short result',subject,null,'dot').receipt_id,receipt.receipt_id);
  assert.equal(store.db.prepare("SELECT count(*) n FROM artifacts WHERE request_id=? AND kind='owner-report'").get(id).n,1);
  const failed='owner-report-failure';
  store.submit({...assignment,request_id:failed},{mode:'none'},null,'owner-capability',false);
  const fc=store.claim(failed,'offline-claimant',subject,20);let published;
  assert.throws(()=>store.finish(failed,fc.claim_id,'completed','summary','result',subject,null,'dot',null,onRollback=>{
    published=captureOwnerReportArtifact(store,workspace,{requestId:failed,claimId:fc.claim_id,outcome:'completed',summary:'summary',result:'result',onRollback});
    throw new Error('injected failure after writer');
  }),/injected failure after writer/);
  assert.equal(store.db.prepare('SELECT count(*) n FROM reports WHERE request_id=?').get(failed).n,0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM artifacts WHERE request_id=?').get(failed).n,0);
  assert.equal(existsSync(join(process.env.DOT_BRIDGE_WORKSPACE_ROOT,'artifacts',published.artifact_id)),false);
  store.finish(failed,fc.claim_id,'completed','summary','result',subject,null,'dot',null,
    onRollback=>({owner_report_artifact:captureOwnerReportArtifact(store,workspace,{requestId:failed,claimId:fc.claim_id,outcome:'completed',summary:'summary',result:'result',onRollback})}));
  assert.equal(store.db.prepare('SELECT count(*) n FROM artifacts WHERE request_id=?').get(failed).n,1);

  const capped='owner-report-cap';store.submit({...assignment,request_id:capped},{mode:'none'},null,'owner-capability',false);
  const cc=store.claim(capped,'offline-claimant',subject,20);
  const insert=store.db.prepare('INSERT INTO progress(request_id,note,created_at,worker) VALUES(?,?,?,?)');
  store.transaction(()=>{for(let i=0;i<2100;i++)insert.run(capped,'x'.repeat(4096),store.stamp(),'dot');});
  assert.throws(()=>store.finish(capped,cc.claim_id,'completed','summary','result',subject,null,'dot',null,
    onRollback=>captureOwnerReportArtifact(store,workspace,{requestId:capped,claimId:cc.claim_id,outcome:'completed',summary:'summary',result:'result',onRollback})),/exceeds 8 MiB/);
  assert.equal(store.get(capped).status,'claimed');
  assert.equal(store.db.prepare('SELECT count(*) n FROM artifacts WHERE request_id=?').get(capped).n,0);
  const blocked='owner-report-blocked';store.submit({...assignment,request_id:blocked},{mode:'none'},null,'owner-capability',false);
  const bc=store.claim(blocked,'offline-claimant',subject,20);
  store.finish(blocked,bc.claim_id,'blocked','blocked','blocked text',subject,null,'dot',null,
    onRollback=>captureOwnerReportArtifact(store,workspace,{requestId:blocked,claimId:bc.claim_id,outcome:'blocked',summary:'blocked',result:'blocked text',onRollback}));
  assert.equal(store.db.prepare('SELECT count(*) n FROM artifacts WHERE request_id=?').get(blocked).n,0);
  const failedOutcome='owner-report-failed';store.submit({...assignment,request_id:failedOutcome},{mode:'none'},null,'owner-capability',false);
  const fc2=store.claim(failedOutcome,'offline-claimant',subject,20);
  store.finish(failedOutcome,fc2.claim_id,'failed','failed','failure facts',subject,null,'dot',null,
    onRollback=>captureOwnerReportArtifact(store,workspace,{requestId:failedOutcome,claimId:fc2.claim_id,outcome:'failed',summary:'failed',result:'failure facts',onRollback}));
  assert.equal(store.db.prepare('SELECT count(*) n FROM artifacts WHERE request_id=?').get(failedOutcome).n,0);
  const cancelled='owner-report-cancelled';store.submit({...assignment,request_id:cancelled},{mode:'none'},null,'owner-capability',false);
  const xc=store.claim(cancelled,'offline-claimant',subject,20);store.cancel(cancelled,'owner cancelled');let cancelledCapture=0;
  assert.throws(()=>store.finish(cancelled,xc.claim_id,'completed','late','late result',subject,null,'dot',null,onRollback=>{cancelledCapture++;return captureOwnerReportArtifact(store,workspace,{requestId:cancelled,claimId:xc.claim_id,outcome:'completed',summary:'late',result:'late result',onRollback});}),/assignment_cancelled/);
  assert.equal(cancelledCapture,0);assert.equal(store.db.prepare('SELECT count(*) n FROM artifacts WHERE request_id=?').get(cancelled).n,0);

  const strict=new Store(join(root,'strict.sqlite')),strictWorkspace=new Workspace(strict,false),strictId='owner-report-protocol';
  const strictAssignment={schema_version:1,request_id:strictId,brief:'protocol read-only archive regression',inputs:[],scope_paths:[],execution_scope:'read-only',protocol:{profile:'job-v0',source:'source',scope:'scope',policy:'policy',destination:'owner',retain_until_ms:Date.now()+86400000}};
  strict.submit(strictAssignment,{mode:'none'},null,'owner-capability',false);
  const strictContext=(key,revision,epoch)=>({key,revision,epoch,args:{artifact_ids:[]}});
  const strictClaim=strict.claim(strictId,'protocol-worker',subject,20,null,'dot',`acquisition-${strictId}`,60000,strictContext('claim',strict.protocolRevision(strictId),undefined));
  const strictResult=JSON.stringify({source:'source',policy:'policy',final:'brief final'}),strictReport={requestId:strictId,claimId:strictClaim.claim_id,outcome:'completed',summary:'protocol summary',result:strictResult};
  let protocolCaptures=0;
  const capture=onRollback=>{protocolCaptures++;return {owner_report_artifact:captureOwnerReportArtifact(strict,strictWorkspace,{...strictReport,onRollback})};};
  assert.throws(()=>finishProtocol(strict,strictId,strictClaim.claim_id,'completed',strictReport.summary,strictResult,subject,null,'dot',strictContext('finish',strict.protocolRevision(strictId)-1,strictClaim.epoch),capture),/revision_conflict/);
  assert.equal(protocolCaptures,0);assert.equal(strict.db.prepare('SELECT count(*) n FROM artifacts WHERE request_id=?').get(strictId).n,0);
  const strictCtx=strictContext('finish',strict.protocolRevision(strictId),strictClaim.epoch);
  const strictReceipt=finishProtocol(strict,strictId,strictClaim.claim_id,'completed',strictReport.summary,strictResult,subject,null,'dot',strictCtx,capture);
  assert.equal(protocolCaptures,1);
  const strictEvidence=strict.get(strictId).report.workspace_evidence.owner_report_artifact;
  assert.equal(strictEvidence.kind,'owner-report');
  assert(!strict.db.prepare('SELECT receipt FROM immutable_result_bindings WHERE job=?').get(strictId).receipt.includes(strictEvidence.artifact_id),'archive must not enter worker-selected binding');
  assert.equal(finishProtocol(strict,strictId,strictClaim.claim_id,'completed',strictReport.summary,strictResult,subject,null,'dot',strictCtx,capture).receipt_id,strictReceipt.receipt_id);
  assert.equal(protocolCaptures,1);assert.equal(strict.db.prepare("SELECT count(*) n FROM artifacts WHERE request_id=? AND kind='owner-report'").get(strictId).n,1);
  strict.db.close();

  // Public worker finish with workspace tools disabled, followed by owner GET/download.
  httpRoot=join(homedir(),'.tmp',`or-${process.pid}`);
  const config=join(httpRoot,'.config/dot-bridge'),data=join(httpRoot,'.local/share/dot-bridge');
  fs.mkdirSync(data,{recursive:true,mode:0o700});
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048}),jwk={...publicKey.export({format:'jwk'}),kid:'owner-report-test',use:'sig'};
  const jwks=http.createServer((req,res)=>res.end(JSON.stringify({keys:[jwk]})));
  await new Promise(resolve=>jwks.listen(0,'127.0.0.1',resolve));
  const issuer=`http://127.0.0.1:${jwks.address().port}/realm`;
  const portServer=await new Promise(resolve=>{const s=http.createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});
  const httpOwner='http-owner-capability',httpId='owner-report-http-case';
  const httpAssignment={schema_version:1,request_id:httpId,brief:'Read-only Mac first-open research',inputs:[{revision:'pinned'}],expected_output:'owner research report',execution_scope:'read-only'};
  const httpStore=new Store(join(data,'bridge.db'));httpStore.submit(httpAssignment,{mode:'none'},null,httpOwner,false);httpStore.db.close();
  const env={...process.env,HOME:httpRoot, DALAN_LEGACY_PROFILE: '1',DOT_BRIDGE_PORT:String(portServer),DOT_BRIDGE_AUTH_MODE:'oauth',DOT_BRIDGE_TEST_OAUTH:'1',DOT_BRIDGE_T3_DRY_RUN:'1',DOT_BRIDGE_ENABLE_WORKSPACE:'',DOT_BRIDGE_WORKSPACE_ROOT:join(httpRoot,'workspace'),OAUTH_ISSUER:issuer};
  fs.mkdirSync(config,{recursive:true});
  fs.writeFileSync(join(config,'oauth.env'),`OAUTH_ISSUER=${issuer}\nOAUTH_AUDIENCE=https://dot-bridge.test\nOAUTH_JWKS_URI=http://127.0.0.1:${jwks.address().port}/jwks\nOAUTH_ALLOWED_SUBJECTS=worker-subject\n`,{mode:0o600});
  const repoRoot=path.dirname(path.dirname(new URL(import.meta.url).pathname));let service,serviceOutput='';
  const start=async()=>{
    serviceOutput='';service=spawn(process.execPath,['src/server.mjs'],{cwd:repoRoot,env,stdio:['ignore','pipe','pipe']});
    service.stdout.on('data',chunk=>{serviceOutput+=String(chunk);});service.stderr.on('data',chunk=>{serviceOutput+=String(chunk);});
    for(let i=0;i<200&&!serviceOutput.includes('MCP listening');i++) await new Promise(resolve=>setTimeout(resolve,25));
    assert(serviceOutput.includes('MCP listening'),`HTTP bridge startup failed: ${serviceOutput.slice(-300)}`);
  };
  const stop=async()=>{if(service&&service.exitCode===null){const exited=new Promise(resolve=>service.once('exit',resolve));service.kill('SIGTERM');await exited;}};
  const jwt=()=>{const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'owner-report-test'})).toString('base64url'),claims=Buffer.from(JSON.stringify({iss:issuer,aud:'https://dot-bridge.test',exp:Math.floor(Date.now()/1000)+300,sub:'worker-subject',scope:'dot-bridge.read dot-bridge.work'})).toString('base64url'),input=`${header}.${claims}`;return `${input}.${sign('RSA-SHA256',Buffer.from(input),privateKey).toString('base64url')}`;};
  const base=()=>`http://127.0.0.1:${portServer}`;
  const mcp=()=>`${base()}/${fs.readFileSync(join(config,'env'),'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1]}/mcp`;
  const admin=(route,ownerToken)=>new Promise((resolve,reject)=>http.get({socketPath:join(data,'admin.sock'),path:route,headers:{'x-owner-capability':ownerToken}},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,bytes:Buffer.concat(chunks)}));}).on('error',reject));
  const call=async(name,args)=>{const response=await fetch(mcp(),{method:'POST',headers:{authorization:`Bearer ${jwt()}`,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),body=await response.json(),result=body.result;if(!result||result.isError)throw new Error(result?.content?.[0]?.text??'MCP call failed');return JSON.parse(result.content[0].text);};
  try {
    await start();const claimed=await call('claim',{request_id:httpId,claimant:'research-worker'});
    const part1='DELIVERABLE part 1/2\n'+('Source findings and evidence. '.repeat(120));
    const part2='DELIVERABLE part 2/2\n'+('Ranked causes, limits, and next steps. '.repeat(100))+' '+canaryToken;
    await call('progress',{request_id:httpId,claim_id:claimed.claim_id,note:part1});
    await call('progress',{request_id:httpId,claim_id:claimed.claim_id,note:part2});
    assert.deepEqual((await call('get',{request_id:httpId})).artifacts,[],'worker cannot see owner archive');
    const done=await call('finish',{request_id:httpId,claim_id:claimed.claim_id,outcome:'completed',summary:'Short investigation summary',result:'Short final result'});
    assert.deepEqual((await call('get',{request_id:httpId})).artifacts,[],'worker archive exclusion after finish');
    const ownerGet=async()=>{const response=await admin(`/get?id=${httpId}`,httpOwner);assert.equal(response.status,200);return JSON.parse(response.bytes.toString());};
    const firstOwner=await ownerGet(),archiveRef=firstOwner.artifacts.find(item=>item.kind==='owner-report');
    assert(archiveRef,'owner GET omitted archive');assert.equal(firstOwner.artifacts.filter(item=>item.kind==='owner-report').length,1);
    const download=(token=httpOwner)=>admin(`/artifact?id=${archiveRef.id}`,token);
    const denied=await download('wrong-owner');assert.notEqual(denied.status,200);
    const fetched=await download();assert.equal(fetched.status,200);const bytes=fetched.bytes,document=JSON.parse(bytes.toString());
    assert.equal(bytes.length,archiveRef.size);assert.equal(createHash('sha256').update(bytes).digest('hex'),archiveRef.sha256);
    assert.equal(document.summary,'Short investigation summary');assert.equal(document.result,'Short final result');
    assert.deepEqual(document.progress.map(note=>note.text),[part1,part2.replace(/ghp_[A-Za-z0-9]{20,}/,'[redacted secret]')]);
    assert(!bytes.toString().includes(canaryToken),'secret canary leaked');
    await stop();await start();
    const replay=await call('finish',{request_id:httpId,claim_id:claimed.claim_id,outcome:'completed',summary:'Short investigation summary',result:'Short final result'});
    assert.equal(replay.receipt_id,done.receipt_id);const afterRestart=await ownerGet();
    assert.equal(afterRestart.artifacts.filter(item=>item.kind==='owner-report').length,1);
    const check=new Store(join(data,'bridge.db'));
    assert.equal(check.db.prepare("SELECT count(*) n FROM artifacts WHERE request_id=? AND kind='owner-report'").get(httpId).n,1);
    assert.equal(check.db.prepare("SELECT count(*) n FROM lifecycle_events WHERE request_id=? AND type='completed'").get(httpId).n,1);
    check.db.close();
    const splitId='owner-report-http-cross-fields',splitSummary='https://fixture-user:abcdef',splitResult='@remote.invalid/';
    const splitStore=new Store(join(data,'bridge.db'));splitStore.submit({...httpAssignment,request_id:splitId},{mode:'none'},null,httpOwner,false);splitStore.db.close();
    const splitClaim=await call('claim',{request_id:splitId,claimant:'research-worker'});
    const longOpen=dash.repeat(5)+begin+' harmless',longClose=privateKeyLabel+dash.repeat(5);
    await call('progress',{request_id:splitId,claim_id:splitClaim.claim_id,note:longOpen});
    await call('progress',{request_id:splitId,claim_id:splitClaim.claim_id,note:longClose});
    const nestedArmorBody='SYNTHETIC_'+'BODY_NESTED';
    const oldNestedNote=longOpen+dash.repeat(5)+begin+' '+privateKeyLabel+dash.repeat(5)+' x'+dash.repeat(5)+end+' '+privateKeyLabel+dash.repeat(5)+'\n'+longClose;
    await call('progress',{request_id:splitId,claim_id:splitClaim.claim_id,note:oldNestedNote});
    const nestedArmorNote=oldNestedNote.replace(' x',' '+nestedArmorBody+'\n');
    const nestedArmorRedacted=redactSecrets(nestedArmorNote).text;
    assert(!nestedArmorRedacted.includes(nestedArmorBody),'nested armor body must be masked');
    await call('progress',{request_id:splitId,claim_id:splitClaim.claim_id,note:nestedArmorNote});
    const nestedNote='x'+oldNestedNote;
    assert.notEqual(redactSecrets(redactSecrets(nestedNote).text).text,redactSecrets(nestedNote).text,'counterexample must exercise a non-idempotent redactor');
    await call('progress',{request_id:splitId,claim_id:splitClaim.claim_id,note:nestedNote});
    await call('finish',{request_id:splitId,claim_id:splitClaim.claim_id,outcome:'completed',summary:splitSummary,result:splitResult});
    const splitGet=await admin(`/get?id=${splitId}`,httpOwner);assert.equal(splitGet.status,200);
    const splitRef=JSON.parse(splitGet.bytes.toString()).artifacts.find(row=>row.kind==='owner-report');
    const splitDownload=await admin(`/artifact?id=${splitRef.id}`,httpOwner);assert.equal(splitDownload.status,200);
    const splitDoc=JSON.parse(splitDownload.bytes.toString());
    // The archive is split-checked as one record: URL userinfo split between summary and result, and armor split
    // between progress notes, are masked.
    assert.equal(splitDoc.summary,'[redacted secret]');assert.equal(splitDoc.result,'[redacted secret]');
    const archived=splitDoc.progress.map(row=>row.text);
    assert(!archived.includes(longOpen)&&!archived.includes(longClose),`split armor fragments kept: ${JSON.stringify(archived)}`);
    assert.equal(archived.length,5);
    assert(splitDoc.progress.every(row=>!row.text.includes(nestedArmorBody)),'archived nested armor body must be absent');
    console.log('PASS HTTP read-only finish, owner-only archive/download, worker exclusion and restart replay');
  } finally {await stop();await new Promise(resolve=>jwks.close(resolve));}
  console.log('PASS owner report archive bytes, ordering, digest, metadata and single-row storage');
} finally {
  store?.db.close();
  if(oldRoot===undefined) delete process.env.DOT_BRIDGE_WORKSPACE_ROOT; else process.env.DOT_BRIDGE_WORKSPACE_ROOT=oldRoot;
  rmSync(root,{recursive:true,force:true});
  if(httpRoot) rmSync(httpRoot,{recursive:true,force:true});
}
