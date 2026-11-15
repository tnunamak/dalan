#!/usr/bin/env node
// C1 through the real server, the admin socket and the CLI: `dalan submit --revises`, the owner note, `get`, the stale
// refusal on decide/accept/apply, both commit orders, and a restart between. The worker side runs on the same SQLite file
// while the service is stopped (a kill, a Store claim and finish, a respawn); the Store-level cases and the lock-order
// proof are in revises-stale-guard-test.mjs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { portFromListeningBanner } from '../src/test-support/port.mjs';

const repo=resolve(new URL('..',import.meta.url).pathname), home=fs.mkdtempSync(join(tmpdir(),'dalan-revises-'));
const root=join(home,'.local/share/dalan'), pass=message=>console.log(`PASS ${message}`), sleep=ms=>new Promise(r=>setTimeout(r,ms));
const env={...process.env,HOME:home,DALAN_LEGACY_PROFILE:'1',DOT_BRIDGE_PORT:'0',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_T3_DRY_RUN:'1',DOT_BRIDGE_ENABLE_WORKSPACE:'0'};
for(const k of ['CLAUDE_CODE_SESSION_ID','CODEX_THREAD_ID']) delete env[k];
const job=id=>({schema_version:1,request_id:id,brief:'revises e2e',inputs:[],expected_output:'one result',execution_scope:'read-only'});
const cli=(args,input='')=>new Promise(done=>{const c=spawn(process.execPath,['bin/dalan.mjs',...args],{cwd:repo,env,stdio:['pipe','pipe','pipe']});let out='',err='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);const parse=t=>{try{return JSON.parse(t);}catch{return t.trim();}};c.on('close',code=>done({code,out,err,value:out.trim()?parse(out):parse(err)}));c.stdin.end(input);});
const admin=(route,body,headers={})=>new Promise((done,fail)=>{const bytes=JSON.stringify(body);const req=http.request({socketPath:join(root,'admin.sock'),path:route,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(bytes),...headers}},res=>{let t='';res.on('data',b=>t+=b);res.on('end',()=>done({status:res.statusCode,value:JSON.parse(t)}));});req.on('error',fail);req.end(bytes);});
const read=(sql,...params)=>{const db=new DatabaseSync(join(root,'bridge.db'),{readOnly:true});try{return db.prepare(sql).all(...params).map(r=>({...r}));}finally{db.close();}};
// Every durable row that belongs to one request, as JSON: what "byte-identical" compares.
const rowsOf=id=>JSON.stringify(read("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").flatMap(({name})=>{
  if(name==='job_revisions'||!read(`SELECT name FROM pragma_table_info('${name}')`).some(c=>c.name==='request_id')) return [];
  return [[name,read(`SELECT * FROM ${name} WHERE request_id=? ORDER BY rowid`,id)]];
}));
let service=null;
async function start() {
  service=spawn(process.execPath,['src/server.mjs'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
  let out='';service.stdout.on('data',b=>out+=b);service.stderr.on('data',b=>process.stderr.write(b));
  for(let i=0;i<150&&!(out.includes('MCP listening')&&out.includes('admin socket'));i++) await sleep(100);
  assert.ok(portFromListeningBanner(out)&&out.includes('admin socket'),'server did not start');
  env.DOT_BRIDGE_PORT=String(portFromListeningBanner(out));
}
async function stop() { const exited=new Promise(r=>service.once('exit',r)); service.kill('SIGKILL'); await exited; service=null; }
// The worker side, with the service stopped: run fn on a Store over the same file, then bring the service back.
async function whileStopped(fn) { await stop(); const s=new Store(join(root,'bridge.db')); try { return fn(s); } finally { s.db.close(); await start(); } }
const submit=(id,flags=[])=>cli(['submit','--stdin','--json','--objective-key','ctx:e2e',...flags],JSON.stringify(job(id)));
try {
  await start();

  // ---- A is running when the correction arrives.
  const a=await submit('req_old_aaaaaaa1',['--revision','r1']); assert.equal(a.code,0,a.err);
  const grant=await whileStopped(s=>s.claim('req_old_aaaaaaa1','W1','local-principal',100));
  assert.equal((await cli(['get','req_old_aaaaaaa1','--json'])).value.status,'claimed');

  // refusals first: nothing is stored
  const sameRevision=await submit('req_new_aaaaaaa1',['--revision','r1','--revises','req_old_aaaaaaa1']);
  assert.equal(sameRevision.code,2); assert.match(sameRevision.value.error,/revises_same_revision/);
  const unknown=await submit('req_new_aaaaaaa2',['--revision','r2','--revises','req_nope_aaaaa1']);
  assert.equal(unknown.code,1); assert.equal(unknown.value.code,"unknown_request"); assert.match(unknown.value.error,/req_nope_aaaaa1.*has no receipt for it/);
  const noValue=await submit('req_new_aaaaaaa3',['--revision','r2','--revises']);
  assert.equal(noValue.code,1); assert.match(JSON.stringify(noValue.value),/--revises requires the request ID/);
  const forged=await admin('/submit',{assignment:job('req_new_aaaaaaa4'),owner_token:'n'.repeat(64),delivery:'none',meta:{objective_key:'ctx:e2e',revision:'r2'},revises:{prior_id:'req_old_aaaaaaa1',prior_token:'f'.repeat(64)}});
  assert.equal(forged.status,400); assert.match(forged.value.error,/invalid owner capability/);
  const malformed=await admin('/submit',{assignment:job('req_new_aaaaaaa5'),owner_token:'n'.repeat(64),delivery:'none',revises:'req_old_aaaaaaa1'});
  assert.equal(malformed.status,400); assert.match(malformed.value.error,/invalid revises/);
  assert.deepEqual(read("SELECT request_id FROM assignments WHERE request_id LIKE 'req_new_%'"),[],'a refused revises stores no job');
  assert.deepEqual(read('SELECT * FROM job_revisions'),[]);
  const preview=await cli(['submit','--stdin','--json','--dry-run','--revision','r2','--revises','req_old_aaaaaaa1'],JSON.stringify(job('req_new_aaaaaaa6')));
  assert.equal(preview.code,0,preview.err+JSON.stringify(preview.value)); assert.deepEqual(read("SELECT request_id FROM assignments WHERE request_id='req_new_aaaaaaa6'"),[],'a dry run stores nothing');
  pass('refusals store nothing: same revision, unknown prior, no value, forged prior token, malformed shape; a dry run stores nothing');

  // ---- the correction commits while A runs
  const b=await submit('req_new_bbbbbbb1',['--revision','r2','--revises','req_old_aaaaaaa1']);
  assert.equal(b.code,0,b.err+JSON.stringify(b.value)); assert.equal(b.value.status,'queued'); assert.equal(b.value.duplicate,false);
  const olderView=(await cli(['get','req_old_aaaaaaa1','--json'])).value;
  assert.equal(olderView.status,'claimed','the prior job keeps running');
  assert.equal(olderView.revised_by.request_id,'req_new_bbbbbbb1');
  assert.equal(olderView.owner_notes.length,1); assert.match(olderView.owner_notes[0].text,/superseded by req_new_bbbbbbb1/);
  const newerView=(await cli(['get','req_new_bbbbbbb1','--json'])).value;
  assert.equal(newerView.revises.request_id,'req_old_aaaaaaa1'); assert.equal(newerView.revises.input_revision,'r2'); assert.equal(newerView.status,'queued');
  const retried=await submit('req_new_bbbbbbb1',['--revision','r2','--revises','req_old_aaaaaaa1']);
  assert.equal(retried.value.duplicate,true); assert.equal(read('SELECT * FROM job_revisions').length,1); assert.equal((await cli(['get','req_old_aaaaaaa1','--json'])).value.owner_notes.length,1);
  const retriedBare=await submit('req_new_bbbbbbb1',['--revision','r2']);
  assert.equal(retriedBare.value.duplicate,true,'a retry that omits --revises inherits the receipt');
  const moved=await submit('req_new_bbbbbbb1',['--revision','r2','--revises','req_old_aaaaaaa1x']);
  assert.equal(moved.code,1);
  pass('the correction commits while the prior job runs: it is queued, the prior is claimed and told, the link shows on both, retries replay');

  // ---- a restart between the correction and the finish (d), then the old job finishes (a)
  await whileStopped(s=>s.finish('req_old_aaaaaaa1',grant.claim_id,'completed','old summary','old result'));
  const afterRestart=(await cli(['get','req_old_aaaaaaa1','--json'])).value;
  assert.equal(afterRestart.status,'finished'); assert.equal(afterRestart.revised_by.request_id,'req_new_bbbbbbb1'); assert.equal(afterRestart.report.summary,'old summary');
  const decide=await cli(['decide','req_old_aaaaaaa1','accepted','--json']);
  assert.equal(decide.code,1); assert.match(JSON.stringify(decide.value),/stale_revision: req_old_aaaaaaa1 was revised by req_new_bbbbbbb1/);
  const accept=await cli(['accept','req_old_aaaaaaa1','--json']); assert.equal(accept.code,1); assert.match(JSON.stringify(accept.value),/stale_revision/);
  const direct=await admin('/decide',{id:'req_old_aaaaaaa1',decision:'applied',via:'apply'},{'x-owner-capability':JSON.parse(fs.readFileSync(join(root,'receipts',fs.readdirSync(join(root,'receipts')).find(f=>JSON.parse(fs.readFileSync(join(root,'receipts',f),'utf8')).request_id==='req_old_aaaaaaa1')),'utf8')).token});
  assert.equal(direct.status,400); assert.equal(direct.value.stale.revised_by,'req_new_bbbbbbb1'); assert.equal(direct.value.stale.request_id,'req_old_aaaaaaa1');
  assert.deepEqual(read('SELECT decision,actor,via,note FROM decisions WHERE request_id=?','req_old_aaaaaaa1'),[{decision:'stale',actor:'system',via:'revises',note:'revised by req_new_bbbbbbb1'}],'stale is recorded once');
  assert.deepEqual(read("SELECT type FROM lifecycle_events WHERE request_id=? AND type='accepted'",'req_old_aaaaaaa1'),[]);
  const apply=await cli(['apply','req_old_aaaaaaa1','--dir',home]); assert.equal(apply.code,1); assert.match(JSON.stringify(apply.value),/was revised by req_new_bbbbbbb1; its patch is not applied/);
  assert.equal((await cli(['decide','req_old_aaaaaaa1','not_useful','--json'])).code,0,'the owner can still reject it');
  pass('(a)+(d) correction first, restart, then the old job finishes: the report is kept, decide/accept/apply are refused, stale is recorded once');

  // the successor is ordinary work
  const bGrant=await whileStopped(s=>{const g=s.claim('req_new_bbbbbbb1','W1','local-principal',100);s.finish('req_new_bbbbbbb1',g.claim_id,'completed','new summary','new result');return g;});
  assert.equal(bGrant.request_id,'req_new_bbbbbbb1');
  assert.equal((await cli(['decide','req_new_bbbbbbb1','accepted','--json'])).code,0);
  pass('the successor is accepted normally');

  // ---- (b) the finish commits first, then the correction
  assert.equal((await submit('req_old_ccccccc1',['--revision','r1'])).code,0);
  await whileStopped(s=>{const g=s.claim('req_old_ccccccc1','W1','local-principal',100);s.finish('req_old_ccccccc1',g.claim_id,'completed','c summary','c result');});
  const terminal=rowsOf('req_old_ccccccc1');
  const d=await submit('req_new_ddddddd1',['--revision','r2','--revises','req_old_ccccccc1']);
  assert.equal(d.code,0,d.err+JSON.stringify(d.value));
  assert.equal(rowsOf('req_old_ccccccc1'),terminal,'the finished job\'s rows are byte-identical after the correction');
  assert.equal((await cli(['get','req_new_ddddddd1','--json'])).value.status,'queued','the successor is new work');
  const staleC=await cli(['decide','req_old_ccccccc1','accepted','--json']); assert.equal(staleC.code,1); assert.match(JSON.stringify(staleC.value),/stale_revision/);
  pass('(b) the finish commits first: the finished job is byte-identical after the correction, the successor is queued new work, accept is refused');

  // ---- an open question survives a correction (c), across a restart
  assert.equal((await submit('req_old_eeeeeee1',['--revision','r1'])).code,0);
  const eGrant=await whileStopped(s=>{const g=s.claim('req_old_eeeeeee1','W1','local-principal',100);s.askQuestion('req_old_eeeeeee1',g.claim_id,'Q1','which file?');return g;});
  const asked=JSON.stringify(read('SELECT * FROM job_questions WHERE request_id=? ORDER BY rowid','req_old_eeeeeee1'));
  assert.equal((await submit('req_new_eeeeeee1',['--revision','r2','--revises','req_old_eeeeeee1'])).code,0);
  await stop(); await start();
  assert.equal(JSON.stringify(read('SELECT * FROM job_questions WHERE request_id=? ORDER BY rowid','req_old_eeeeeee1')),asked,'the open question is unchanged by the correction and the restart');
  const answered=await cli(['answer','req_old_eeeeeee1','Q1','src/a.mjs','--json']); assert.equal(answered.code,0,answered.err+JSON.stringify(answered.value));
  await whileStopped(s=>{s.consumeAnswer('req_old_eeeeeee1',eGrant.claim_id,'Q1');s.finish('req_old_eeeeeee1',eGrant.claim_id,'completed','e','e');});
  assert.match(JSON.stringify((await cli(['decide','req_old_eeeeeee1','accepted','--json'])).value),/stale_revision/);
  pass('(c) an open question survives a correction and a restart, is answered through the CLI, and the finished result is then stale');
} finally {
  if(service) { const exited=new Promise(r=>service.once('exit',r)); service.kill('SIGKILL'); await exited; }
  fs.rmSync(home,{recursive:true,force:true});
}
