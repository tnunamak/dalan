import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as integrator from '../src/integrator.mjs';
import { Store } from '../src/store.mjs';
import { dropEmptyPost54FixtureState } from '../src/test-support/pre-worker-fixture.mjs';
import { redactOutput } from '../src/redaction.mjs';
import { sensitiveMasks, validateIntegrationPatch } from '../src/workspace.mjs';

fs.mkdirSync(path.join(os.homedir(),'.tmp/dalan-integrator'),{recursive:true,mode:0o700});
const root=fs.mkdtempSync(path.join(os.homedir(),'.tmp/dalan-integrator/integrator-safety-'));
const repo=path.join(root,'repo'); fs.mkdirSync(repo);
const git=(...args)=>execFileSync('git',['-C',repo,'-c','user.name=Test','-c','user.email=test@example.invalid',...args],{encoding:'utf8'}).trim();
git('init','-q','-b','main');
fs.writeFileSync(path.join(repo,'note.txt'),'before\n');
fs.writeFileSync(path.join(repo,'.dot-bridge.json'),JSON.stringify({checks:{trusted:{argv:['/runtime/node','-e','0']}}}));
git('add','.'); git('commit','-qm','base');
const base=git('rev-parse','HEAD');
fs.writeFileSync(path.join(repo,'note.txt'),'after\n'); git('add','note.txt');
const patch=Buffer.from(git('diff','--cached','--binary')+'\n'); git('reset','--hard','-q');
const store=new Store(path.join(root,'store.db'));
const sealed={request_id:'req_safety',assignment:{execution_scope:'implementation',scope_paths:['allowed'],inputs:[{github_repo:'example/repo',base_sha:base}],evidence_plan:{schema_version:1,checks:[{id:'evil',argv:['/runtime/node','-e','0'],issuer:'dot-bridge',trust_profile:'bridge_verified'}]}},patch,patch_sha256:createHash('sha256').update(patch).digest('hex'),patch_base_sha:base};
const verify=assignment=>integrator.verifySealedResult({store,sealedResult:{...sealed,assignment},repoDir:repo,targetBaseRef:base,scratchRoot:root});

test('rejects out-of-scope sealed patches before applying',async()=>{
  const result=await verify(sealed.assignment);
  assert.match(result.verification.error??'',/outside scope_paths/);
  assert.equal(fs.readFileSync(path.join(result.scratch_dir,'note.txt'),'utf8'),'before\n');
});

test('enforces exclusions, output grants, symlinks, and generated paths',()=>{
  assert.throws(()=>validateIntegrationPatch(repo,patch,{scope_excluded:[{path:'note.txt'}]}),/outside scope_paths/);
  assert.doesNotThrow(()=>validateIntegrationPatch(repo,patch,{scope_paths:['elsewhere'],output_paths:['note.txt']}));
  const link=Buffer.from('diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+note.txt\n');
  assert.throws(()=>validateIntegrationPatch(repo,link,{}),/symlink/);
  const generated=Buffer.from('diff --git a/target/new b/target/new\nnew file mode 100644\n--- /dev/null\n+++ b/target/new\n@@ -0,0 +1 @@\n+data\n');
  assert.throws(()=>validateIntegrationPatch(repo,generated,{}),/generated_path/);
});

test('sensitive files are identified for the confined runner',()=>{
  fs.writeFileSync(path.join(repo,'.env'),'private');
  const copy=path.join(root,'exemptions');fs.mkdirSync(copy);
  assert.ok(sensitiveMasks(repo,'example/repo',copy).paths.includes('.env'));
  fs.unlinkSync(path.join(repo,'.env'));
});

test('redacts check output before persistence and API serialization',()=>{
  const secret='ghp_'+'a'.repeat(36);
  const row=integrator.evidenceCheckResult({id:'check',argv:['test'],issuer:'bridge',trust_profile:'bridge_verified'},{exit:{code:0},stop:{verified:true},bytes:Buffer.from(secret)});
  assert.equal(row.output_redaction_version,1);
  assert.doesNotMatch(JSON.stringify(row),new RegExp(secret));
  assert.match(redactOutput(row).output_preview,/redacted secret/);
  const candidate=store.putIntegrationCandidate({candidate_id:'redaction',request_id:'req',kind:'patch',patch,patch_digest:sealed.patch_sha256,patch_base_sha:base,target_sha:base});
  store.recordIntegrationVerification({candidate_id:candidate.candidate_id,patch_digest:sealed.patch_sha256,patch_base_sha:base,target_sha:base,target_ref:base,status:'skipped',checks:[{...row,error:secret}],error:secret});
  const stored=store.db.prepare('SELECT checks_json,error FROM integration_verifications WHERE candidate_id=?').get('redaction');
  assert.doesNotMatch(JSON.stringify(stored),new RegExp(secret));
});

test('exit 77 records skipped coverage',()=>{
  const row=integrator.evidenceCheckResult({id:'check',argv:['test'],issuer:'bridge',trust_profile:'bridge_verified'},{exit:{code:77},stop:{verified:true},bytes:Buffer.from('SKIP example\n')});
  assert.equal(row.status,'skipped');
  assert.deepEqual(row.skipped_segment_names,['example']);
  assert.equal(integrator.evidencePlanStatus([row]),'skipped');
  assert.equal(integrator.evidencePlanStatus([row,{status:'failed'}]),'failed');
  assert.equal(integrator.evidencePlanStatus([row,{status:'passed'}]),'skipped');
});

test('migration preserves records and append-only protection',()=>{
  store.recordIntegrationVerification({candidate_id:'redaction',patch_digest:sealed.patch_sha256,patch_base_sha:base,target_sha:base,target_ref:base,status:'verified',checks:[]});
  dropEmptyPost54FixtureState(store.db);
  store.db.exec('PRAGMA user_version=47');
  store.migrate();
  assert.deepEqual(store.integrationVerifications('redaction').map(row=>row.status),['skipped','verified']);
  assert.throws(()=>store.db.prepare('DELETE FROM integration_verifications WHERE candidate_id=?').run('redaction'),/append-only/);
});

test('ignores worker-supplied check plan',async()=>{
  const result=await verify({...sealed.assignment,scope_paths:['note.txt']});
  assert.deepEqual(result.verification.checks.map(c=>c.id),['trusted']);
  assert.equal(result.verification.checks[0].issuer,'repository-config');
});
process.on('exit',()=>{store.db.close();fs.rmSync(root,{recursive:true,force:true});});
