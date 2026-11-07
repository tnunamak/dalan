#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from '../src/store.mjs';

const assignment=request_id=>({schema_version:1,request_id,brief:'durable submit identity',inputs:[],expected_output:'one result',execution_scope:'read-only'});
const submit=(s,p,key,options={})=>s.submit(p,options.delivery??{mode:'none'},options.environment??null,options.owner??'fixture-owner',options.review??false,null,options.priority??'normal',options.meta??null,options.identity??p,null,options.worker,options.execution??null,'none',options.capabilities??null,null,key);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

if(process.argv[2]==='--race-child') {
  const [file,requestId,index,distinct,barrier]=process.argv.slice(3);
  const s=new Store(file);
  try {
    fs.writeFileSync(`${barrier}.${index}`,'ready');
    while(!fs.existsSync(barrier)) await sleep(5);
    try { console.log(JSON.stringify(submit(s,assignment(requestId),distinct==='yes'?`race-key-${index}`:'race-key'))); }
    catch(error) { console.log(JSON.stringify({error:error.message})); }
  } finally { s.db.close(); }
} else {
  const root=fs.mkdtempSync(path.join(process.env.TMPDIR??os.tmpdir(),'dalan-submit-keys-'));
  const file=path.join(root,'bridge.db');
  let s=new Store(file);
  const counts=id=>[s.db.prepare('SELECT count(*) n FROM assignments WHERE request_id=?').get(id).n,s.db.prepare('SELECT count(*) n FROM lifecycle_events WHERE request_id=?').get(id).n,s.db.prepare('SELECT count(*) n FROM owner_submit_commands WHERE request_id=?').get(id).n];
  try {
    const p=assignment('req_command_key');
    const first=submit(s,p,'private-fixture-key');
    assert.equal(first.duplicate,false);
    // This is the baseline defect: another key used to be treated as an exact retry.
    assert.throws(()=>submit(s,p,'different-key'),/^Error: EXISTS:/);
    assert.deepEqual(submit(s,p,'private-fixture-key'),{...first,duplicate:true});
    const before=counts(p.request_id);
    for(const options of [{delivery:{mode:'t3',threadId:'another-thread'}},{environment:'another-environment'},{review:true},{priority:'background'},{meta:{task_kind:'review'}},{worker:'another-worker'},{execution:'worker'},{capabilities:{network:'none'}}]) {
      assert.throws(()=>submit(s,p,'private-fixture-key',options),/^Error: KEY_CONFLICT:/);
      assert.deepEqual(counts(p.request_id),before);
    }
    assert.throws(()=>submit(s,{...p,brief:'changed intent'},'private-fixture-key'),/^Error: KEY_CONFLICT:/);
    for(const key of [null,'private-fixture-key','different-key']) assert.throws(()=>submit(s,p,key,{owner:'foreign-owner'}),/invalid owner capability/);
    assert.throws(()=>submit(s,p,null),/^Error: EXISTS:/,'keyed jobs require their original key');
    assert.deepEqual(counts(p.request_id),[1,1,1]);

    // Original decision survives later job transitions and a process-independent reopen.
    const claim=s.claim(p.request_id,'holder');
    s.finish(p.request_id,claim.claim_id,'completed','done','result');
    s.db.close(); s=new Store(file);
    assert.equal(s.get(p.request_id).status,'finished');
    assert.deepEqual(submit(s,p,'private-fixture-key'),{...first,duplicate:true});
    const command=s.db.prepare('SELECT * FROM owner_submit_commands WHERE request_id=?').get(p.request_id);
    assert.match(command.key_digest,/^[a-f0-9]{64}$/);
    assert(!JSON.stringify(command).includes('private-fixture-key'));
    assert(!JSON.stringify(command).includes('fixture-owner'));

    // Legacy jobs keep the existing payload-bound retry behavior. A key cannot adopt one silently.
    const legacy=assignment('req_unkeyed_legacy');
    submit(s,legacy,null);
    assert.equal(submit(s,legacy,null).duplicate,true);
    assert.throws(()=>submit(s,legacy,'new-key'),/^Error: EXISTS:/);
    assert.throws(()=>submit(s,legacy,null,{owner:'foreign-owner'}),/request_id conflict/);
    const other=assignment('req_other_key_scope');
    assert.equal(submit(s,other,'private-fixture-key',{owner:'another-owner'}).duplicate,false,'keys are scoped to a job and its owner');

    for(const invalid of ['',false,7,{},'x'.repeat(129)]) {
      const rejected=assignment('req_invalid_key');
      assert.throws(()=>submit(s,rejected,invalid),/invalid command_key/);
      assert.deepEqual(counts(rejected.request_id),[0,0,0]);
    }
    const rolled=assignment('req_rollback_key'),oldLifecycle=s.lifecycle;
    s.lifecycle=()=>{throw new Error('injected lifecycle failure');};
    assert.throws(()=>submit(s,rolled,'rollback-key'),/injected lifecycle failure/);
    s.lifecycle=oldLifecycle;
    assert.deepEqual(counts(rolled.request_id),[0,0,0]);
    assert.equal(submit(s,rolled,'rollback-key').duplicate,false);

    // Six real SQLite writers start together; the assignment and receipt commit once.
    for(const distinct of [false,true]) {
      const id=distinct?'req_race_distinct':'req_race_same',barrier=path.join(root,id);
      const children=Array.from({length:6},(_,index)=>{
        const child=spawn(process.execPath,[new URL(import.meta.url).pathname,'--race-child',file,id,String(index),distinct?'yes':'no',barrier],{stdio:['ignore','pipe','pipe']});
        let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
        const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve(JSON.parse(stdout)):reject(new Error(stderr)));});
        return {child,done};
      });
      try {
        for(let i=0;i<1000&&!children.every((_,index)=>fs.existsSync(`${barrier}.${index}`));i++) await sleep(10);
        assert(children.every((_,index)=>fs.existsSync(`${barrier}.${index}`)),'race children did not reach the start barrier');
        fs.writeFileSync(barrier,'go');
        const results=await Promise.all(children.map(child=>child.done));
        assert.equal(results.filter(result=>result.duplicate===false).length,1);
        assert.equal(results.filter(result=>result.duplicate===true).length,distinct?0:5);
        assert.equal(results.filter(result=>result.error?.startsWith('EXISTS:')).length,distinct?5:0);
        assert.deepEqual(counts(id),[1,1,1]);
      } finally {
        for(const {child} of children) if(child.exitCode===null) child.kill('SIGKILL');
        await Promise.allSettled(children.map(child=>child.done));
      }
    }
    assert.equal(s.db.prepare('PRAGMA user_version').get().user_version,65);
    console.log('submit-command-key-test ok: exact durable receipt, intent and owner binding, legacy compatibility, atomic rollback, 12 concurrent SQLite writers');
  } finally { s.db.close(); fs.rmSync(root,{recursive:true,force:true}); }
}
