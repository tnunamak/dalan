#!/usr/bin/env node
// Objective meta through the real server and CLI: dot-worker submit flags, admin /submit meta validation and conflicts,
// receipts, metrics/explain, and dot-worker backfill-objectives (operator key, dry run, verified-only, idempotent).
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { drainerRequestId, fixLoopRequestId } from '../src/objectives.mjs';
import { legacyFixLedgerPath } from '../src/legacy-names.mjs';

const repo=resolve(new URL('..',import.meta.url).pathname), home=fs.mkdtempSync(join(tmpdir(),'dalan-bridge-objectives-'));
// A fixed port collided with other projects' fixtures on this host; take a free one unless OBJECTIVES_E2E_PORT pins it.
const root=join(home,'.local/share/dalan'), port=Number(process.env.OBJECTIVES_E2E_PORT)||await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',reject);probe.listen(0,'127.0.0.1',()=>{const {port}=probe.address();probe.close(()=>resolve(port));});});
const sleep=ms=>new Promise(r=>setTimeout(r,ms)), pass=message=>console.log(`PASS ${message}`), sha=c=>c.repeat(40);
const payload=(id,extra={})=>({schema_version:1,request_id:id,brief:'objectives e2e',inputs:[],expected_output:'one result',execution_scope:'read-only',...extra});
const env={...process.env,HOME:home, DALAN_LEGACY_PROFILE: '1',DOT_BRIDGE_PORT:String(port),DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_T3_DRY_RUN:'1',DOT_BRIDGE_ENABLE_WORKSPACE:'0'};
const cli=(args,input='')=>new Promise(done=>{const c=spawn(process.execPath,['bin/dalan.mjs',...args],{cwd:repo,env,stdio:['pipe','pipe','pipe']});let out='',err='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);const parse=t=>{try{return JSON.parse(t);}catch{return t.trim();}};c.on('close',code=>done({code,out,err,value:out.trim()?parse(out):parse(err)}));c.stdin.end(input);});
const admin=(route,method='GET',body=null,headers={})=>new Promise((done,fail)=>{const bytes=body?JSON.stringify(body):'';const req=http.request({socketPath:join(root,'admin.sock'),path:route,method,headers:{'content-type':'application/json','content-length':Buffer.byteLength(bytes),...headers}},res=>{let t='';res.on('data',b=>t+=b);res.on('end',()=>done({status:res.statusCode,value:JSON.parse(t)}));});req.on('error',fail);req.end(bytes);});
const meta=id=>{const db=new DatabaseSync(join(root,'bridge.db'),{readOnly:true});try{return {...db.prepare('SELECT objective_key,revision,task_kind,source FROM assignments WHERE request_id=?').get(id)};}finally{db.close();}};
const receipt=id=>JSON.parse(fs.readFileSync(join(root,'receipts',createHash('sha256').update(id).digest('hex')+'.json'),'utf8'));
let service=null;
try {
  service=spawn(process.execPath,['src/server.mjs'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
  let out='';service.stdout.on('data',b=>out+=b);service.stderr.on('data',b=>process.stderr.write(b));
  for(let i=0;i<100&&!(out.includes('MCP listening')&&out.includes('admin socket'));i++) await sleep(100);
  assert.ok(out.includes('MCP listening')&&out.includes('admin socket'),'server did not start');
  const key=fs.readFileSync(join(home,'.config/dalan/operator.key'),'utf8').trim();

  // ---- dot-worker submit: flags, default source, receipt, conflicts
  const keyed=`req_${randomUUID()}`, plain=`req_${randomUUID()}`;
  const a=await cli(['submit','--stdin','--json','--objective-key','manual:fix-login','--revision',sha('a'),'--task-kind','fix'],JSON.stringify(payload(keyed)));
  assert.equal(a.code,0,a.err); assert.deepEqual(meta(keyed),{objective_key:'manual:fix-login',revision:sha('a'),task_kind:'fix',source:'agent'});
  assert.deepEqual(receipt(keyed).meta,{objective_key:'manual:fix-login',revision:sha('a'),task_kind:'fix',source:'agent'});
  const b=await cli(['submit','--stdin','--json'],JSON.stringify(payload(plain)));
  assert.equal(b.code,0,b.err); assert.deepEqual(meta(plain),{objective_key:null,revision:null,task_kind:null,source:'agent'},'plain dot-worker submit is source agent');
  assert.equal((await cli(['submit','--stdin','--json'],JSON.stringify(payload(keyed)))).value.duplicate,true,'a retry without flags inherits the receipt meta');
  const moved=await cli(['submit','--stdin','--json','--revision',sha('b')],JSON.stringify(payload(keyed)));
  assert.equal(moved.code,1); assert.equal(moved.value.code,'receipt_conflict');
  const badSource=await cli(['submit','--stdin','--json','--source','producer'],JSON.stringify(payload(`req_${randomUUID()}`)));
  assert.equal(badSource.code,1); assert.match(badSource.value.error,/invalid meta.source/);
  const missing=await cli(['submit','--stdin','--json','--objective-key','--json'],JSON.stringify(payload(`req_${randomUUID()}`)));
  assert.equal(missing.code,1); assert.match(missing.value.error,/--objective-key requires a value/);
  pass('dot-worker submit sends --objective-key/--revision/--task-kind/--source as meta (default source agent), records it in the receipt, and refuses a changed field');

  // ---- admin /submit: validation and the both-sides-present conflict rule
  const owner='o'.repeat(64), direct=`req_${randomUUID()}`, submit=(id,m)=>admin('/submit','POST',{delivery:'none',assignment:payload(id),owner_token:owner,...(m===undefined?{}:{meta:m})});
  for(const [bad,msg] of [[{source:'robot'},'invalid meta.source'],[{objective_key:'x'.repeat(513)},'invalid meta.objective_key'],[{revision:1},'invalid meta.revision'],[{other:'x'},'invalid meta'],['drainer','invalid meta']]) {
    const r=await submit(`req_${randomUUID()}`,bad); assert.equal(r.status,400); assert.equal(r.value.error,msg);
  }
  assert.equal((await submit(direct,{objective_key:'k',revision:'r1',task_kind:'t',source:'unknown'})).status,200);
  assert.equal((await submit(direct,{objective_key:'k',revision:'r1',task_kind:'t',source:'unknown'})).value.duplicate,true);
  assert.equal((await submit(direct)).value.duplicate,true,'a retry without meta is accepted');
  assert.equal((await submit(direct,{revision:'r2'})).value.error,'request_id conflict');
  const legacy=`req_${randomUUID()}`; assert.equal((await submit(legacy)).status,200);
  assert.deepEqual(meta(legacy),{objective_key:null,revision:null,task_kind:null,source:null},'admin submit without meta guesses no source');
  assert.equal((await submit(legacy,{objective_key:'k',revision:'r',task_kind:'t',source:'agent'})).value.duplicate,true,'a legacy row accepts a retry with meta');
  assert.equal(meta(legacy).source,null);
  pass('admin /submit validates meta, never guesses a source, and conflicts only when both sides carry a different value');

  // ---- metrics and explain carry coverage
  const metrics=(await cli(['metrics','--json'])).value;
  assert.deepEqual(metrics.objective_coverage.by_source,{agent:{keyed:1,total:2},unknown:{keyed:1,total:2}});
  assert.match((await cli(['status','--explain'])).out,/rework=0 duplicates=0 objective_coverage=2\/4/);
  pass('metrics report rework, duplicates and objective coverage per source; status --explain shows coverage');

  // ---- backfill-objectives: host receipts + fix ledger -> verified tuples -> admin route
  const db=new DatabaseSync(join(root,'bridge.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const insert=p=>db.prepare("INSERT INTO assignments(request_id,payload,payload_hash,thread_id,environment_id,status,created_at,owner_hash,review,delivery,priority) VALUES(?,?,'h','','','finished',?,'o',0,'none','background')").run(p.request_id,JSON.stringify(p),new Date().toISOString());
  const writeReceipt=p=>fs.writeFileSync(join(root,'receipts',createHash('sha256').update(p.request_id).digest('hex')+'.json'),JSON.stringify({request_id:p.request_id,token:'t',body:JSON.stringify(p),delivery:'none'}),{mode:0o600});
  const pr=drainerRequestId('o/r','pr-review:o/r#4',sha('1'),'review'), fix=fixLoopRequestId({id:'bug-1',repo:'o/r'}), orphan=drainerRequestId('o/r','lost',sha('3'),'review');
  for(const p of [payload(pr,{inputs:[{github_repo:'o/r',base_sha:sha('0'),head_sha:sha('1'),pr_number:4}]}),payload(fix,{inputs:[{github_repo:'o/r',base_sha:sha('2')}]}),payload(orphan,{inputs:[{github_repo:'o/r',base_sha:sha('3')}]})]) { insert(p); writeReceipt(p); }
  db.close();
  fs.mkdirSync(dirname(join(home,legacyFixLedgerPath)),{recursive:true}); fs.writeFileSync(join(home,legacyFixLedgerPath),JSON.stringify({id:'bug-1',repo:'o/r',stage:'assigned',request_id:fix,base_sha:sha('2')})+'\n');
  assert.equal((await admin('/backfill-objectives','POST',{tuples:[]})).value.error,'invalid operator key');
  assert.equal((await admin('/backfill-objectives','POST',{tuples:[],dry_run:'yes'},{'x-operator-key':key})).value.error,'invalid dry_run');
  const dry=await cli(['backfill-objectives','--dry-run','--json']);
  assert.equal(dry.code,0,dry.err);
  assert.deepEqual(dry.value.derived,{receipts:5,verified:{manifest:0,ledger:1,payload:1},unverified:3});
  assert.deepEqual([dry.value.server.updated,dry.value.server.by_source,dry.value.without_objective,dry.value.total],[2,{drainer:1,'fix-loop':1},3,7]);
  assert.equal(meta(pr).source,null,'dry run wrote');
  const real=await cli(['backfill-objectives','--json']);
  assert.equal(real.code,0,real.err); assert.deepEqual([real.value.dry_run,real.value.server.updated,real.value.without_objective],[false,2,3]);
  assert.deepEqual(meta(pr),{objective_key:'pr-review:o/r#4',revision:sha('1'),task_kind:'review',source:'drainer'});
  assert.deepEqual(meta(fix),{objective_key:'fix-loop:o/r#bug-1',revision:sha('2'),task_kind:'fix-loop',source:'fix-loop'});
  assert.equal(meta(orphan).source,null,'no source of truth: stays null');
  const again=await cli(['backfill-objectives','--json']);
  assert.deepEqual([again.value.server.updated,again.value.server.already_set],[0,2],'backfill is not idempotent');
  assert.match((await cli(['backfill-objectives','--force'])).err,/accepts only --dry-run and --json/);
  pass('backfill-objectives posts only verified tuples from receipts and the fix ledger, needs the operator key, dry-runs without writing, and is idempotent');
  console.log('PASS objectives e2e');
} catch(error) { console.error('FAIL',error); process.exitCode=1; }
finally {
  if(service&&service.exitCode===null){const exited=new Promise(r=>service.once('exit',r));service.kill('SIGTERM');await exited;}
  fs.rmSync(home,{recursive:true,force:true});
}
