import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadWorkers, loadOwnerWorkers, updateWorkerRepoPolicy, readWorkerRepoHistory, inspectGrantAudit } from '../src/workers.mjs';

// A repository grant takes effect only with an audit record. Editing workers.json by hand writes none, so the
// bridge records one when it loads the file, and applies the grant only if that record was written.
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'grant-audit-')),file=path.join(dir,'workers.json'),auditFile=path.join(dir,'workers-audit.jsonl');
const save=value=>fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});
const events=()=>fs.existsSync(auditFile)?readWorkerRepoHistory(auditFile).events:[];
const load=()=>loadWorkers(file,{builtin:true,auditGrants:true});
try {
  save({workers:{acme:{repos:[]}}});
  updateWorkerRepoPolicy(file,'acme','allow','octo/cli');
  assert.equal(events().length,1);
  assert.deepEqual(inspectGrantAudit(file).unaudited,[],'a CLI grant is audited');

  // 1. Hand edit: the grant must not apply without an audit record.
  save({workers:{acme:{repos:['octo/cli','octo/handedit']}}});
  assert.deepEqual(inspectGrantAudit(file).unaudited,[{worker:'acme',repos:['octo/handedit']}],'doctor input names the unaudited grant');
  assert.equal(events().length,1,'inspection alone writes nothing');
  let profile=load();
  assert.equal(profile.allowsRepo('acme','octo/handedit'),true,'the grant applies once its record is written');
  assert.equal(profile.allowsRepo('acme','octo/cli'),true);
  const recorded=events();
  assert.equal(recorded.length,2,'loading the config recorded the hand-edited grant');
  assert.equal(recorded[1].source,'config-reconcile');
  assert.deepEqual(recorded[1].before.repos,['octo/cli']);assert.deepEqual(recorded[1].after.repos,['octo/cli','octo/handedit']);
  assert.deepEqual(inspectGrantAudit(file).unaudited,[]);
  assert.equal(inspectGrantAudit(file).recorded[0].repos[0],'octo/handedit','doctor still reports the grant the bridge had to record');
  load();assert.equal(events().length,2,'reloading is idempotent');

  // 2. If the record cannot be written, the grant is not applied.
  save({workers:{acme:{repos:['octo/cli','octo/handedit','octo/blocked']}}});
  fs.rmSync(auditFile);fs.mkdirSync(auditFile);
  profile=load();
  assert.equal(profile.allowsRepo('acme','octo/blocked'),false,'a grant whose audit record cannot be written is not applied');
  assert.deepEqual(profile.repoPolicy('acme').repos,[],'with an unreadable audit trail no unaudited grant applies');
  fs.rmSync(auditFile,{recursive:true});

  // 3. A corrupt audit trail cannot be appended to safely: unaudited grants stay denied.
  save({workers:{acme:{repos:['octo/one']}}});
  fs.writeFileSync(auditFile,'{"torn":',{mode:0o600});
  assert.equal(load().allowsRepo('acme','octo/one'),false);
  fs.rmSync(auditFile);
  // An install that was never audited has no checkpoint (the integrity test covers a log removed after one exists).
  fs.rmSync(path.join(dir,'workers-audit-checkpoint.sqlite'));

  // 4. Upgrade path: an existing explicit list with no audit history is recorded once and keeps working.
  save({workers:{acme:{repos:['octo/one','octo/two']},beta:{repos:[]}}});
  profile=load();
  assert.deepEqual(profile.repoPolicy('acme').repos,['octo/one','octo/two']);
  assert.equal(events().length,1);assert.equal(events().filter(e=>e.worker==='beta').length,0,'an empty list needs no record');

  // 5. Removal by hand edit is safe and is recorded, so a later re-add is not mistaken for an audited grant.
  save({workers:{acme:{repos:['octo/one']},beta:{repos:[]}}});
  load();assert.deepEqual(events().at(-1).after.repos,['octo/one']);
  save({workers:{acme:{repos:['octo/one','octo/two']},beta:{repos:[]}}});
  assert.deepEqual(inspectGrantAudit(file).unaudited,[{worker:'acme',repos:['octo/two']}]);
  assert.deepEqual(loadOwnerWorkers(file).repoPolicy('acme').repos,['octo/one','octo/two'],'owner CLI view shows the file as written');

  // 6. dalan doctor and dalan worker list report an unaudited grant without writing anything.
  const cli=fileURLToPath(new URL('../bin/dot-worker.mjs',import.meta.url));
  const run=(...args)=>{const r=spawnSync(process.execPath,[cli,...args,'--json'],{encoding:'utf8',env:{...process.env,DALAN_WORKERS_FILE:file,HOME:dir}});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  const before=events().length;
  const doctor=run('doctor');
  assert.deepEqual(doctor.repository_access.unaudited_grants,[{worker:'acme',repos:['octo/two']}]);
  assert.ok(doctor.repository_access.warnings.some(w=>/octo\/two/.test(w)&&/no audit record/.test(w)),'doctor warns about the unaudited grant');
  assert.deepEqual(run('worker','list').workers[0].unaudited_grants,['octo/two']);
  assert.equal(events().length,before,'doctor and list never write audit events');
} finally {fs.rmSync(dir,{recursive:true,force:true});}
console.log('PASS hand-edited repository grants are audited before they apply');
