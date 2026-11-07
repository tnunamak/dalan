import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseWorkers, loadOwnerWorkers, updateWorkerRepoPolicy, readWorkerRepoHistory } from '../src/workers.mjs';

const exact=parseWorkers({workers:{alpha:{repos:['acme/project']},beta:{repos:[]}}},{builtin:true});
assert.equal(exact.allowsRepo('alpha','ACME/PROJECT'),true,'matching is case-insensitive');
for(const name of ['acme/project/','acme/project.git'])assert.equal(exact.allowsRepo('alpha',name),false,'exact allow-list rejects alternate spelling '+name);
assert.equal(exact.allowsRepo('alpha','acme/future'),false,'a future repository under the same owner stays denied');
assert.equal(exact.allowsRepo('beta','acme/project'),false,'same subject connections do not merge worker policies');
// Invalid-input controls: wildcard and retired allow-any policy must be rejected.
for(const config of [
  {repos:['acme/*']},{repo_access:'any'},{denied_repos:['acme/private']},
]) assert.throws(()=>parseWorkers({workers:{alpha:config}},{builtin:true}),/unsupported|invalid repository/);
for(const repos of [['*'],['acme/**'],['bad'],['acme/project','ACME/PROJECT']]) assert.throws(()=>parseWorkers({workers:{alpha:{repos}}},{builtin:true}));
assert.throws(()=>parseWorkers({workers:{alpha:{repos:'acme/project'}}},{builtin:true}));
const legacy=parseWorkers({workers:{alpha:{}}},{builtin:true});
assert.equal(legacy.allowsRepo('alpha','acme/project'),false);
assert.deepEqual(legacy.repoPolicy('alpha'),{mode:'exact',repos:[]});
for(const workers of [{alpha:{repos:[],connections:[]}},{alpha:{repos:[],connections:[]},beta:{repos:[]}}]) {
  assert.equal(parseWorkers({workers},{builtin:true}).workers.size,Object.keys(workers).length,'valid built-in connections:[] shapes remain accepted');
}
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'repo-policy-')),file=path.join(dir,'workers.json');
const save=value=>fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});
try {
  save({workers:{alpha:{connections:[],repos:[]}}});
  const noOp=updateWorkerRepoPolicy(file,'alpha','deny','acme/project');
  assert.deepEqual(noOp.repos,[]);assert.equal(fs.existsSync(path.join(dir,'workers-audit.jsonl')),false,'no-op edit has no audit event');
  updateWorkerRepoPolicy(file,'alpha','allow','acme/project');
  const events=fs.readFileSync(path.join(dir,'workers-audit.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.length,1);assert.equal(events[0].worker,'alpha');assert.equal(events[0].actor.host_uid,process.getuid());
  assert.deepEqual(events[0].before.repos,[]);assert.deepEqual(events[0].after.repos,['acme/project']);
  assert.match(events[0].event_id,/^[0-9a-f-]{36}$/);assert.ok(Date.parse(events[0].at));
  const auditFile=path.join(dir,'workers-audit.jsonl'),originalOpen=fs.openSync,originalWrite=fs.writeSync;
  const auditFds=new Set();let shortWrites=0;
  fs.openSync=(...args)=>{const fd=originalOpen(...args);if(args[0]===auditFile)auditFds.add(fd);return fd;};
  fs.writeSync=(fd,data,...args)=>{
    if(!auditFds.has(fd))return originalWrite(fd,data,...args);
    shortWrites++;
    if(typeof data==='string')return originalWrite(fd,data.slice(0,17));
    return originalWrite(fd,data,args[0],Math.min(17,args[1]),args[2]);
  };
  try {updateWorkerRepoPolicy(file,'alpha','allow','acme/second');}
  finally {fs.openSync=originalOpen;fs.writeSync=originalWrite;}
  assert.ok(shortWrites>1,'short append writes must be completed before success');
  const shortEvents=fs.readFileSync(auditFile,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(shortEvents.length,2);assert.deepEqual(shortEvents[1].after.repos,['acme/project','acme/second']);
  assert.deepEqual(readWorkerRepoHistory(auditFile),{events:shortEvents,complete:true,error:null});
  auditFds.clear();
  fs.openSync=(...args)=>{const fd=originalOpen(...args);if(args[0]===auditFile)auditFds.add(fd);return fd;};
  fs.writeSync=(fd,...args)=>auditFds.has(fd)?0:originalWrite(fd,...args);
  // The rollback reuses a closed descriptor number; forget it once closed.
  const originalClose=fs.closeSync;
  fs.closeSync=fd=>{auditFds.delete(fd);return originalClose(fd);};
  try {assert.throws(()=>updateWorkerRepoPolicy(file,'alpha','allow','acme/third'),/repository grant not applied: its audit event could not be written/);}
  finally {fs.openSync=originalOpen;fs.writeSync=originalWrite;fs.closeSync=originalClose;}
  assert.ok(!loadOwnerWorkers(file).repoPolicy('alpha').repos.includes('acme/third'),'a grant whose audit event cannot be written is never applied');
  assert.equal(readWorkerRepoHistory(auditFile).events.length,2,'zero progress cannot be reported as a published event');
  const goodAudit=fs.readFileSync(auditFile);
  fs.appendFileSync(auditFile,'{"private":"DO_NOT_ECHO_SENTINEL"');
  const incomplete=readWorkerRepoHistory(auditFile);
  assert.equal(incomplete.complete,false);assert.equal(incomplete.events.length,2);assert.doesNotMatch(JSON.stringify(incomplete),/DO_NOT_ECHO_SENTINEL/);
  fs.writeFileSync(auditFile,goodAudit,{mode:0o600});
  save({workers:{alpha:{connections:[],repos:['acme/project']}}});
  assert.throws(()=>updateWorkerRepoPolicy(file,'alpha','deny','acme/*'),/wildcards are unsupported/);assert.deepEqual(loadOwnerWorkers(file).repoPolicy('alpha').repos,['acme/project']);
  // Drop the checkpoint with the log so this exercises an unwritable audit, not the missing-log integrity check.
  fs.rmSync(path.join(dir,'workers-audit-checkpoint.sqlite'));
  fs.rmSync(path.join(dir,'workers-audit.jsonl'));fs.mkdirSync(path.join(dir,'workers-audit.jsonl'));
  assert.throws(()=>updateWorkerRepoPolicy(file,'alpha','deny','acme/project'),/policy was updated, but its audit event could not be written/);
  assert.deepEqual(loadOwnerWorkers(file).repoPolicy('alpha').repos,[],'audit failure is reported after the policy commit');
  assert.throws(()=>updateWorkerRepoPolicy(file,'alpha','allow','acme/project'),/repository grant not applied/);
  assert.deepEqual(loadOwnerWorkers(file).repoPolicy('alpha').repos,[],'an unrecorded grant leaves the profile unchanged');
  fs.rmSync(path.join(dir,'workers-audit.jsonl'),{recursive:true});
  save({workers:{alpha:{connections:[]}}});
  save({workers:{alpha:{connections:[{issuer:'https://issuer.example',subject:'owner',client_id:'alpha'}]},beta:{connections:[]}}});
  assert.throws(()=>loadOwnerWorkers(file),/needs connections/,'mixed external and built-in profiles remain invalid');
  save({workers:{alpha:{connections:[]}}});
  assert.deepEqual(updateWorkerRepoPolicy(file,'alpha','deny','acme/project').repos,[]);
  updateWorkerRepoPolicy(file,'alpha','allow','acme/project');
  assert.deepEqual(loadOwnerWorkers(file).repoPolicy('alpha').repos,['acme/project'],'first legacy allow narrows to the chosen exact list');
} finally {fs.rmSync(dir,{recursive:true,force:true});}
console.log('PASS exact repository policies, legacy narrowing, change audit and no-op behavior');
