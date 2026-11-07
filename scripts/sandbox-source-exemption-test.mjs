#!/usr/bin/env node
import './require-host-checks.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

const scratchRoot=path.join(os.homedir(),'.tmp');fs.mkdirSync(scratchRoot,{recursive:true});
const home=fs.mkdtempSync(path.join(scratchRoot,'dalan-source-exemption-'));
process.env.HOME=home;
process.env.DOT_BRIDGE_WORKSPACE_ROOT=path.join(home,'work');
process.env.DOT_BRIDGE_ALLOW_SHARED_NET_INSTALL='1';
const {Store}=await import('../src/store.mjs');
const {Workspace}=await import('../src/workspace.mjs');
const run=(cmd,args,cwd)=>{const result=spawnSync(cmd,args,{cwd,encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr||result.stdout);return result.stdout.trim();};
const repo=path.join(home,'repo');fs.mkdirSync(repo,{recursive:true});
run('git',['init','-q'],repo);run('git',['config','user.email','fixture@example.test'],repo);run('git',['config','user.name','Fixture'],repo);
const sensitive='vendor/mcp-server/src/credentials.mjs';
const source='export class CredentialError extends Error {}\nexport function loadScopedCredential(){return "fixture"}\n';
const sqlPath='queries/update-secret.sql';
const sqlSource='-- @terminator exec\nUPDATE fixtures SET value = :value WHERE id = :id;\n';
const importer='import {CredentialError,loadScopedCredential} from "../vendor/mcp-server/src/credentials.mjs";\nif(!(new CredentialError() instanceof Error)||loadScopedCredential()!=="fixture")process.exit(3);\nconsole.log("PINNED_SOURCE_IMPORT_OK");\n';
const readSensitive='import fs from "node:fs";\nconst values=[fs.readFileSync(".env","utf8"),fs.readFileSync("credential-store.json","utf8")];\nconsole.log(`EMPTY:${values.map(x=>x.length).join(":")}`);\n';
for(const [file,text] of Object.entries({[sensitive]:source,'test/import.mjs':importer,'test/read-sensitive.mjs':readSensitive,'.env':'SENTINEL_DOTENV_VALUE=not-for-worker\n','credential-store.json':'{"token":"SENTINEL_CREDENTIAL_VALUE"}\n','test/mutate.cjs':`const fs=require("node:fs");try{fs.writeFileSync(${JSON.stringify(sensitive)},"export const CredentialError=1;\\n");console.log("MUTATION_UNEXPECTEDLY_ALLOWED")}catch(e){console.log("MUTATION_BLOCKED:"+e.code)}\n`,[sqlPath]:sqlSource,'test/read-query.mjs':'import fs from "node:fs";if(!fs.readFileSync("queries/update-secret.sql","utf8").includes("@terminator exec"))process.exit(3);console.log("PINNED_QUERY_OK");\n','README.md':'base\n'})){const full=path.join(repo,file);fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,text);}
for(let i=0;i<30;i++)fs.writeFileSync(path.join(repo,`secret-${String(i).padStart(2,'0')}.json`),`fixture ${i}\n`);
const checkSpec={argv:['/runtime/node','test/import.mjs'],timeout_ms:30000,output_bytes:65536};
fs.writeFileSync(path.join(repo,'.dot-bridge.json'),JSON.stringify({checks:{default:checkSpec,sql:{argv:['/runtime/node','test/read-query.mjs'],timeout_ms:30000,output_bytes:65536},read:{argv:['/runtime/node','test/read-sensitive.mjs'],timeout_ms:30000,output_bytes:65536},mutate:{install_argv:['/runtime/node','test/mutate.cjs'],argv:['/runtime/node','test/import.mjs'],timeout_ms:30000,output_bytes:65536},slow:{argv:['/runtime/node','-e','setTimeout(()=>console.log("SLOW_DONE"),1000)'],timeout_ms:30000,output_bytes:65536}}}));
run('git',['add','-A'],repo);run('git',['commit','-qm','fixture base'],repo);
const base=run('git',['rev-parse','HEAD'],repo);
const blobSha=bytes=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const pin=blobSha(Buffer.from(source));
const policyFile=path.join(home,'.config/dot-bridge/submission-policy.json');fs.mkdirSync(path.dirname(policyFile),{recursive:true});
const writePolicy=entries=>fs.writeFileSync(policyFile,JSON.stringify({version:1,sensitive_paths:[],exceptions:[],sandbox_source_exemptions:entries}),{mode:0o600});
writePolicy([]);
process.env.DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE=repo;
process.env.DOT_BRIDGE_GITHUB_URL_OTHER_FIXTURE=repo;
const store=new Store(path.join(home,'bridge.sqlite'));
const ws=new Workspace(store);
const open=(revision=base,repoName='example-owner/fixture',extra={})=>{
  const id=`req_${randomUUID()}`,payload={schema_version:1,request_id:id,brief:'fixture',inputs:[{github_repo:repoName,base_sha:revision}],expected_output:'fixture',execution_scope:'implementation',scope_paths:['.'],...extra};
  store.submit(payload,'thread','environment','owner');const claim=store.claim(id,'dot','subject',99).claim_id;ws.ensure(id,claim,'subject');return{id,claim,dir:path.join(home,'work/worktrees',id)};
};
const check=async(a,id='default')=>{
  const started=await ws.check(a.id,a.claim,'subject',id);let row;
  for(let i=0;i<1200;i++){row=store.db.prepare('SELECT * FROM check_runs WHERE request_id=? ORDER BY created_at DESC LIMIT 1').get(a.id);if(row)break;await new Promise(resolve=>setTimeout(resolve,25));}
  assert(row,'check did not produce a result');const result=JSON.parse(row.evidence);return{started,row,evidence:result,output:ws.artifact(row.output_artifact_id,a.id).bytes.toString('utf8')};
};
const entry=(overrides={})=>({github_repo:'example-owner/fixture',path:sensitive,blob_sha:pin,reason:'Reviewed reference implementation source',...overrides});
try{
  const plain=open();const blank=await check(plain);
  assert.notEqual(blank.row.exit_code,0,'unpinned sensitive source stays masked and import fails');

  writePolicy([entry()]);
  const pinned=open(),success=await check(pinned);
  assert.equal(success.row.exit_code,0,success.output);
  assert.match(success.output,/PINNED_SOURCE_IMPORT_OK/);
  assert.deepEqual(success.evidence.sandbox_source_exemptions,[{path:sensitive,blob_sha:pin}]);
  assert.equal(success.evidence.masked_sensitive_paths.total,33,'only the exact approved source is unmasked');
  assert.match(blank.output,/masked as empty: .*vendor\/mcp-server\/src\/credentials\.mjs/s,'failure output names the dependency after more than 25 other masked paths');
  assert.match(blank.started.output_preview,/masked as empty: .*vendor\/mcp-server\/src\/credentials\.mjs/s,'failed check response puts the mask next to the error');
  assert(blank.evidence.masked_sensitive_paths.total>25);

  const excluded=open(base,'example-owner/fixture',{scope_excluded:[{path:sensitive}]});
  assert.throws(()=>ws.read(excluded.id,excluded.claim,'subject',sensitive),/outside scope_paths/,'sandbox pin never grants a worker read');
  assert.throws(()=>ws.apply(excluded.id,excluded.claim,'subject',`diff --git a/${sensitive} b/${sensitive}\n--- a/${sensitive}\n+++ b/${sensitive}\n@@ -1 +1 @@\n-export class CredentialError extends Error {}\n+export class OtherError extends Error {}\n`),/outside scope_paths/,'sandbox pin never grants a worker write');
  assert.equal((await check(excluded)).row.exit_code,0,'approved sandbox source can execute while worker access remains excluded');
  writePolicy([entry({path:sqlPath,blob_sha:blobSha(Buffer.from(sqlSource))})]);
  const sqlResult=await check(open(),'sql');assert.equal(sqlResult.row.exit_code,0,sqlResult.output);assert.match(sqlResult.output,/PINNED_QUERY_OK/);
  writePolicy([entry()]);
  const revisionPath=path.join(repo,'README.md');fs.writeFileSync(revisionPath,'second revision\n');run('git',['add','README.md'],repo);run('git',['commit','-qm','second revision'],repo);const secondBase=run('git',['rev-parse','HEAD'],repo);run('git',['-C',path.join(home,'work/mirrors/workers/dot/example-owner/fixture.git'),'fetch',repo,'+refs/heads/*:refs/heads/*'],repo);
  assert.equal((await check(open(secondBase))).row.exit_code,0,'same pinned blob is approved at another revision');

  const changed=open();fs.writeFileSync(path.join(changed.dir,sensitive),`${source}// changed\n`);const changedResult=await check(changed);
  assert.notEqual(changedResult.row.exit_code,0,'changed bytes do not inherit the approval');assert.equal(changedResult.evidence.sandbox_source_exemptions.length,0);

  const wrongRepo=open(base,'other/fixture'),wrongRepoResult=await check(wrongRepo);
  assert.notEqual(wrongRepoResult.row.exit_code,0,'a pin for another repository does not apply');assert.equal(wrongRepoResult.evidence.sandbox_source_exemptions.length,0);

  writePolicy([entry({blob_sha:'0'.repeat(40)})]);const wrongHash=await check(open());
  assert.notEqual(wrongHash.row.exit_code,0,'wrong blob hash stays masked');assert.equal(wrongHash.evidence.sandbox_source_exemptions.length,0);

  writePolicy([entry()]);const symlink=open();fs.unlinkSync(path.join(symlink.dir,sensitive));fs.symlinkSync('../../../../.env',path.join(symlink.dir,sensitive));const linkResult=await check(symlink);
  assert.notEqual(linkResult.row.exit_code,0,'a symlink cannot receive the source exemption');assert.equal(linkResult.evidence.sandbox_source_exemptions.length,0);

  writePolicy([{...entry(),extra:'untrusted'}]);const malformed=await check(open());
  assert.notEqual(malformed.row.exit_code,0,'malformed host policy fails closed');assert.equal(malformed.evidence.sandbox_source_exemptions.length,0);assert.match(malformed.evidence.masked_sensitive_paths_policy_error,/invalid sandbox source exemption/);

  for(const forbiddenPath of ['.env','credential-store.json']) {
    writePolicy([entry({path:forbiddenPath,blob_sha:'0'.repeat(40)})]);
    const data=await check(open(),'read');
    assert.equal(data.row.exit_code,0,data.output);assert.match(data.output,/EMPTY:0:0/);assert.doesNotMatch(data.output,/SENTINEL_(?:DOTENV|CREDENTIAL)_VALUE/);
    assert.match(data.evidence.masked_sensitive_paths_policy_error,/invalid sandbox source exemption path/);
  }

  writePolicy([entry()]);const mutation=await check(open(),'mutate');
  assert.equal(mutation.row.exit_code,0,mutation.output);assert.match(mutation.output,/MUTATION_BLOCKED:EROFS/);assert.match(mutation.output,/PINNED_SOURCE_IMPORT_OK/,'install cannot swap in new source bytes for check execution');

  const busy=open();const pending=ws.check(busy.id,busy.claim,'subject','slow');
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.throws(()=>ws.read(busy.id,busy.claim,'subject','vendor/mcp-server/src/credentials.mjs'),/check still running/,'worker reads remain blocked during check');
  assert.throws(()=>ws.apply(busy.id,busy.claim,'subject','diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-base\n+changed\n'),/check still running/,'worker writes remain blocked during check');
  const slowResponse=await pending;
  for(let i=0;i<1200;i++){const row=store.db.prepare('SELECT status FROM check_jobs WHERE id=?').get(slowResponse.check_run_id);if(row&&row.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,25));}
  assert.notEqual(store.db.prepare('SELECT status FROM check_jobs WHERE id=?').get(slowResponse.check_run_id)?.status,'running','slow check completed');
  console.log('sandbox-source-exemption-test: PASS');
}finally{store.db.close();fs.rmSync(home,{recursive:true,force:true});}
