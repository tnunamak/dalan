import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { loadWorkers, updateWorkerRepoPolicy, readWorkerRepoHistory, inspectGrantAudit, withAuditLock } from '../src/workers.mjs';

// Serialization and tamper detection for the grant audit: concurrent writers write one event per real change, a
// deleted or truncated audit log fails closed, and an install that was never audited is recorded once.
const workersModule=new URL('../src/workers.mjs',import.meta.url).href;
const cli=fileURLToPath(new URL('../bin/dot-worker.mjs',import.meta.url));
const fresh=()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'grant-audit-int-'));
  const file=path.join(dir,'workers.json'),auditFile=path.join(dir,'workers-audit.jsonl');
  return {dir,file,auditFile,save:value=>fs.writeFileSync(file,JSON.stringify(value),{mode:0o600}),
    events:()=>fs.existsSync(auditFile)?readWorkerRepoHistory(auditFile).events:[],
    load:()=>loadWorkers(file,{builtin:true,auditGrants:true})};
};
const child=(args,env)=>new Promise(resolve=>{
  const p=spawn(process.execPath,args,{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
  let err='';p.stderr.on('data',d=>{err+=d;});p.on('close',code=>resolve({code,err}));
});
const loader=(file)=>child(['--input-type=module','-e',`import {loadWorkers} from ${JSON.stringify(workersModule)};loadWorkers(${JSON.stringify(file)},{builtin:true,auditGrants:true});`],{});
const dirs=[];
const diffRepos=(from,to)=>to.filter(repo=>!from.map(r=>r.toLowerCase()).includes(repo.toLowerCase()));
try {
  // 1. Parallel loaders of one hand-edited file write exactly one event.
  {
    const t=fresh();dirs.push(t.dir);
    t.save({workers:{acme:{repos:[]}}});updateWorkerRepoPolicy(t.file,'acme','allow','octo/cli');
    t.save({workers:{acme:{repos:['octo/cli','octo/handedit']}}});
    const results=await Promise.all(Array.from({length:12},()=>loader(t.file)));
    for(const r of results) assert.equal(r.code,0,r.err);
    const reconciled=t.events().filter(e=>e.source==='config-reconcile');
    assert.equal(reconciled.length,1,'twelve parallel loaders record the grant once');
    assert.deepEqual(reconciled[0].after.repos,['octo/cli','octo/handedit']);
  }

  // 2. A deny racing loaders never leaves a later event that lists the denied repository.
  for(let round=0;round<8;round++) {
    const t=fresh();dirs.push(t.dir);
    t.save({workers:{acme:{repos:[]}}});
    updateWorkerRepoPolicy(t.file,'acme','allow','octo/cli');updateWorkerRepoPolicy(t.file,'acme','allow','octo/x');
    const raw=JSON.parse(fs.readFileSync(t.file,'utf8'));raw.workers.acme.repos.push('octo/y');t.save(raw);
    const jobs=[...Array.from({length:6},()=>loader(t.file)),
      child([cli,'worker','deny','acme','octo/x','--json'],{DALAN_WORKERS_FILE:t.file,HOME:t.dir})];
    const results=await Promise.all(jobs);
    for(const r of results) assert.equal(r.code,0,r.err);
    const events=t.events(),denyAt=events.findIndex(e=>e.source===undefined&&e.before.repos.includes('octo/x')&&!e.after.repos.includes('octo/x'));
    assert.ok(denyAt>=0,'the deny was recorded');
    for(const e of events.slice(denyAt+1)) assert.ok(!e.after.repos.includes('octo/x'),`round ${round}: event after the deny still lists the denied repository`);
    t.save({workers:{acme:{repos:[...JSON.parse(fs.readFileSync(t.file,'utf8')).workers.acme.repos,'octo/x']}}});
    assert.equal(t.load().allowsRepo('acme','octo/x'),true,'a later hand re-add is recorded, then applies');
    assert.ok(t.events().at(-1).after.repos.includes('octo/x')&&t.events().at(-1).source==='config-reconcile','the re-add has its own event');
  }

  // 3. Deleting the audit log after a hand edit does not launder the grant.
  {
    const t=fresh();dirs.push(t.dir);
    t.save({workers:{acme:{repos:[]}}});updateWorkerRepoPolicy(t.file,'acme','allow','octo/cli');
    assert.equal(t.load().allowsRepo('acme','octo/cli'),true);
    const raw=JSON.parse(fs.readFileSync(t.file,'utf8'));raw.workers.acme.repos.push('octo/evil');t.save(raw);
    fs.rmSync(t.auditFile);
    const profile=t.load();
    assert.equal(profile.allowsRepo('acme','octo/evil'),false,'a hand-added grant does not apply once the log is gone');
    assert.equal(profile.allowsRepo('acme','octo/cli'),false,'a grant without a matching event is denied (fail closed)');
    assert.equal(t.events().length,0,'a failed integrity check writes no event');
    const inspected=inspectGrantAudit(t.file);
    assert.match(inspected.integrity_error??'',/missing|removed/);
    assert.ok(inspected.unaudited.some(u=>u.repos.includes('octo/evil')));
    const run=(...args)=>spawnSync(process.execPath,[cli,...args,'--json'],{encoding:'utf8',env:{...process.env,DALAN_WORKERS_FILE:t.file,HOME:t.dir}});
    const doctor=JSON.parse(run('doctor').stdout);
    assert.ok(doctor.repository_access.warnings.some(w=>/audit log/.test(w)&&/dalan worker allow/.test(w)),'doctor tells the operator how to re-approve');
    assert.match(JSON.parse(run('worker','list').stdout).workers[0].audit_integrity_error??'',/audit log/);
    // Re-approval through the audited command resets the file to the audited grants and records a new baseline.
    const r=run('worker','allow','acme','octo/cli');assert.equal(r.status,0,r.stderr);
    const after=JSON.parse(fs.readFileSync(t.file,'utf8')).workers.acme.repos;
    assert.deepEqual(after,['octo/cli'],'the hand-added grant was not re-approved, so it is dropped');
    assert.equal(inspectGrantAudit(t.file).integrity_error??null,null);
    assert.equal(t.load().allowsRepo('acme','octo/cli'),true);assert.equal(t.load().allowsRepo('acme','octo/evil'),false);
  }

  // 4. Truncating the log fails closed.
  {
    const t=fresh();dirs.push(t.dir);
    t.save({workers:{acme:{repos:[]}}});
    updateWorkerRepoPolicy(t.file,'acme','allow','octo/one');updateWorkerRepoPolicy(t.file,'acme','allow','octo/two');
    const firstLine=fs.readFileSync(t.auditFile,'utf8').split('\n')[0]+'\n';
    fs.writeFileSync(t.auditFile,firstLine,{mode:0o600});
    const profile=t.load();
    assert.equal(profile.allowsRepo('acme','octo/two'),false,'a grant whose event was truncated away is denied');
    assert.equal(t.events().length,1,'no event is written while the log fails its checkpoint');
    assert.ok(inspectGrantAudit(t.file).integrity_error);
    // A log rewritten to the same length with different bytes also fails.
    const u=fresh();dirs.push(u.dir);
    u.save({workers:{acme:{repos:[]}}});updateWorkerRepoPolicy(u.file,'acme','allow','octo/one');
    const text=fs.readFileSync(u.auditFile,'utf8');
    fs.writeFileSync(u.auditFile,text.replace('octo/one','octo/onf'),{mode:0o600});
    assert.ok(inspectGrantAudit(u.file).integrity_error,'a changed byte is detected');
  }

  // 5. An install that was never audited is recorded once, and keeps working.
  {
    const t=fresh();dirs.push(t.dir);
    t.save({workers:{acme:{repos:['octo/one']}}});
    assert.equal(fs.existsSync(t.auditFile),false);
    assert.equal(t.load().allowsRepo('acme','octo/one'),true);
    assert.equal(t.events().length,1);assert.equal(t.events()[0].source,'config-reconcile');
    t.load();assert.equal(t.events().length,1,'idempotent');
    assert.equal(inspectGrantAudit(t.file).integrity_error??null,null);
  }
  // 6. A reset after a failed integrity check drops grants not independently trusted by a pending seed.
  {
    const t=fresh();dirs.push(t.dir);
    t.save({workers:{acme:{repos:[]}}});
    updateWorkerRepoPolicy(t.file,'acme','allow','octo/a');updateWorkerRepoPolicy(t.file,'acme','allow','octo/b');
    const forged={event_id:randomUUID(),at:new Date().toISOString(),actor:{host_uid:null},worker:'acme',before:{mode:'exact',repos:[]},after:{mode:'exact',repos:['octo/a','octo/zzz']}};
    fs.writeFileSync(t.auditFile,JSON.stringify(forged)+'\n',{mode:0o600});
    assert.ok(inspectGrantAudit(t.file).integrity_error,'the forged log fails its checkpoint');
    const beforeRecovery=t.load();
    assert.equal(beforeRecovery.allowsRepo('acme','octo/a'),false,'a valid-looking event in a changed prefix cannot retain A');
    assert.equal(beforeRecovery.allowsRepo('acme','octo/b'),false,'a valid-looking event in a changed prefix cannot retain B');
    updateWorkerRepoPolicy(t.file,'acme','allow','octo/c');
    const repos=JSON.parse(fs.readFileSync(t.file,'utf8')).workers.acme.repos;
    assert.ok(!repos.includes('octo/zzz'),'a repository only the forged log lists is not added');
    assert.ok(!repos.includes('octo/a')&&!repos.includes('octo/b'),'untrusted prior grants are dropped on recovery');
    assert.deepEqual(repos,['octo/c'],'only the explicit re-approval survives');
    const afterRecovery=t.load();
    assert.equal(afterRecovery.allowsRepo('acme','octo/c'),true);
    assert.equal(afterRecovery.allowsRepo('acme','octo/a'),false,'recovery cannot make a forged earlier event authoritative again');
    assert.equal(afterRecovery.allowsRepo('acme','octo/b'),false);
  }

  // 7. A hand-added repository gets its own reconcile event before `worker allow` records its own change.
  for(const mode of ['workers.json','legacy journal']) {
    const t=fresh();dirs.push(t.dir);
    const journalFile=path.join(t.dir,'workers-repos.json');
    if(mode==='workers.json') {
      t.save({workers:{acme:{repos:[]}}});updateWorkerRepoPolicy(t.file,'acme','allow','octo/a');
      const raw=JSON.parse(fs.readFileSync(t.file,'utf8'));raw.workers.acme.repos.push('octo/hand');t.save(raw);
      updateWorkerRepoPolicy(t.file,'acme','allow','octo/b');
    } else {
      const event={event_id:randomUUID(),at:new Date().toISOString(),actor:{host_uid:null},worker:'dot',before:{mode:'legacy-any',repos:null},after:{mode:'exact',repos:['octo/a']}};
      fs.writeFileSync(journalFile,JSON.stringify({version:1,entries:[{worker:'dot',kind:'legacy',repos:['octo/a'],complete:true,event}]}),{mode:0o600});
      updateWorkerRepoPolicy(t.file,'dot','allow','octo/seed');
      const journal=JSON.parse(fs.readFileSync(journalFile,'utf8'));journal.entries[0].repos.push('octo/hand');
      fs.writeFileSync(journalFile,JSON.stringify(journal),{mode:0o600});
      updateWorkerRepoPolicy(t.file,'dot','allow','octo/b');
    }
    const events=t.events(),last=events.at(-1),reconcile=events.at(-2);
    assert.equal(reconcile.source,'config-reconcile',`${mode}: the hand-added repository has its own event`);
    assert.deepEqual(diffRepos(reconcile.before.repos,reconcile.after.repos),['octo/hand']);
    assert.equal(last.source,undefined,`${mode}: the allow event follows`);
    assert.deepEqual(diffRepos(last.before.repos,last.after.repos),['octo/b'],`${mode}: the allow event adds only the named repository`);
  }

  // 8. Writers wait for the audit lock. Hold it from a second connection: a loader and an allow neither write an event
  // nor apply an unaudited grant until it is released.
  {
    const t=fresh();dirs.push(t.dir);
    t.save({workers:{acme:{repos:[]}}});updateWorkerRepoPolicy(t.file,'acme','allow','octo/a');
    const raw=JSON.parse(fs.readFileSync(t.file,'utf8'));raw.workers.acme.repos.push('octo/hand');t.save(raw);
    const eventsBefore=t.events().length;
    const holder=new DatabaseSync(path.join(t.dir,'workers-audit-checkpoint.sqlite'));
    holder.exec('BEGIN EXCLUSIVE');
    let released=false;
    const track=promise=>{const state={done:false};state.promise=promise.then(r=>{state.done=true;state.r=r;return r;});return state;};
    const loading=track(loader(t.file));
    const allowing=track(child([cli,'worker','allow','acme','octo/b','--json'],{DALAN_WORKERS_FILE:t.file,HOME:t.dir}));
    await new Promise(resolve=>setTimeout(resolve,2000));
    assert.equal(loading.done,false,'a loader waits for the audit lock');
    assert.equal(allowing.done,false,'worker allow waits for the audit lock');
    assert.equal(t.events().length,eventsBefore,'no event is written while the lock is held');
    assert.ok(!JSON.parse(fs.readFileSync(t.file,'utf8')).workers.acme.repos.includes('octo/b'),'no grant is applied while the lock is held');
    holder.exec('ROLLBACK');holder.close();released=true;
    const [l,a]=await Promise.all([loading.promise,allowing.promise]);
    assert.equal(l.code,0,l.err);assert.equal(a.code,0,a.err);
    assert.ok(released&&t.events().length>eventsBefore,'events are written once the lock is released');
  }
  // 9. The lock itself: while a writer holds it, a second connection with no busy wait cannot take a write lock on the
  // checkpoint file; once the writer returns, it can. Case 8 alone does not prove this, because the holder there also
  // blocks the writers' own checkpoint access.
  {
    const t=fresh();dirs.push(t.dir);
    t.save({workers:{acme:{repos:[]}}});
    const sidecar=path.join(t.dir,'workers-audit-checkpoint.sqlite');
    const tryWriteLock=()=>{
      const probe=new DatabaseSync(sidecar);
      try {probe.exec('PRAGMA busy_timeout=0');probe.exec('BEGIN IMMEDIATE');probe.exec('ROLLBACK');return 'acquired';}
      catch(error) {return /locked|busy/i.test(String(error?.message))?'busy':`error: ${error?.message}`;}
      finally {probe.close();}
    };
    const inside=withAuditLock(t.file,()=>tryWriteLock());
    assert.equal(inside,'busy','another connection cannot take a write lock while the audit lock is held');
    assert.equal(tryWriteLock(),'acquired','the audit lock is released when the writer returns');
  }
} finally {for(const d of dirs) fs.rmSync(d,{recursive:true,force:true});}
console.log('PASS grant audit is serialized and fails closed when its log is removed or truncated');
