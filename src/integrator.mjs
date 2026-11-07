import { readEnv } from './env.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPatch } from './patch-apply.mjs';
import { gitEnv } from './git-env.mjs';
import { MAX_INTEGRATION_PATCH_BYTES, Store } from './store.mjs';
import { TRUST } from './execution.mjs';
import { availableChecks, detectCheckWithOrigin, CHECK_INPUT_FILES } from './projects.mjs';
import { redactSecrets, redactOutput } from './redaction.mjs';
import { safeDiagnostic } from './diagnostic.mjs';
import { withCheckCoverage } from './check-coverage.mjs';
import { sensitiveMasks, validateIntegrationPatch } from './workspace.mjs';

const modulePath=fileURLToPath(import.meta.url);
const buildScratch=path.join(os.homedir(),'.tmp','dalan-integrator');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fullSha=/^[0-9a-f]{40,64}$/;
const shortJson=(value,max=4000)=>String(value??'').slice(0,max);
// Owner-side verification uses a fixed ceiling; a worker's evidence plan cannot
// raise it or enable host execution. Each check gets its own service envelope.
export const INTEGRATOR_HOST_BUDGET=Object.freeze({cpu_ms:30000,wall_ms:60000,memory_bytes:512*1024*1024,processes:64,disk_write_bytes:64*1024*1024,output_bytes:262144});

function withinBuildScratch(candidate) {
  const resolved=path.resolve(candidate);
  const allowed=path.resolve(process.argv[2]==='--confined-check-runner'&&readEnv('DALAN_INTEGRATOR_SCRATCH_ROOT')||buildScratch);
  if(resolved!==allowed&&!resolved.startsWith(allowed+path.sep)) throw new Error(`scratch paths must stay under ${allowed}`);
  return resolved;
}

function makeHostEnv(root) {
  const home=path.join(root,'host-home'),tmp=path.join(root,'host-tmp');
  fs.mkdirSync(home,{recursive:true,mode:0o700});
  fs.mkdirSync(tmp,{recursive:true,mode:0o700});
  return gitEnv({PATH:'/usr/bin:/bin',HOME:home,TMPDIR:tmp,LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'UTC',GIT_ASKPASS:'/usr/bin/false',GIT_TERMINAL_PROMPT:'0'});
}

function git(dir,args,{env,input,timeout=30000}={}) {
  const result=spawnSync('git',['-C',dir,...args],{input,encoding:'utf8',timeout,maxBuffer:64*1024*1024,env});
  if(result.error||result.status!==0) {
    // Mask the whole stderr, then clip: a credential crossing the cut leaves no prefix.
    throw new Error(`git ${args[0]} failed: ${safeDiagnostic(String(result.stderr||result.error?.message||'').trim(),500)}`);
  }
  return result.stdout.trim();
}

function resolveCheckout(repoDir,env) {
  const top=git(repoDir,['rev-parse','--show-toplevel'],{env});
  return fs.realpathSync(top);
}

function resolveTarget(repoDir,ref,env) {
  if(typeof ref!=='string'||!ref.trim()||ref.length>1024||ref.includes('\0')||ref.startsWith('-')) throw new Error('invalid target base ref');
  const sha=git(repoDir,['rev-parse','--verify','--end-of-options',`${ref}^{commit}`],{env});
  if(!fullSha.test(sha)) throw new Error('target base ref did not resolve to a full commit SHA');
  return sha;
}

function filterSafeCheckoutEnv(checkoutDir,env) {
  const result=spawnSync('git',['-C',checkoutDir,'config','--null','--get-regexp','^filter\\..*\\.(smudge|clean|process)$'],
    {encoding:'utf8',timeout:30000,maxBuffer:1024*1024,env});
  if(result.error||result.status!==0&&!(result.status===1&&!result.stdout&&!result.stderr))
    throw new Error(`could not inspect Git filter configuration: ${(result.stderr||result.error?.message||'').trim().slice(0,500)}`);
  if(result.status===1) return env;
  const keys=[...new Set(result.stdout.split('\0').filter(Boolean).map(entry=>{
    const separator=entry.indexOf('\n');
    if(separator<1) throw new Error('could not parse Git filter configuration');
    return entry.slice(0,separator);
  }))];
  const first=Number(env.GIT_CONFIG_COUNT??0);
  if(!Number.isInteger(first)||first<0||first+keys.length>256) throw new Error('too many Git filter settings to disable safely');
  const isolated={...env,GIT_CONFIG_COUNT:String(first+keys.length)};
  keys.forEach((key,index)=>{
    const slot=first+index;
    isolated[`GIT_CONFIG_KEY_${slot}`]=key;
    isolated[`GIT_CONFIG_VALUE_${slot}`]='';
  });
  return isolated;
}

export function checkoutWorktreeWithoutFilters(checkoutDir,sha,env) {
  const safeEnv=filterSafeCheckoutEnv(checkoutDir,env);
  git(checkoutDir,['checkout','--detach',sha],{env:safeEnv});
  return safeEnv;
}

function worktree(repoDir,sha,root,env,label) {
  const dir=path.join(root,`${label}-${randomUUID()}`);
  git(repoDir,['worktree','add','--no-checkout','--detach',dir,sha],{env});
  const checkoutEnv=checkoutWorktreeWithoutFilters(dir,sha,env);
  return {dir,env:checkoutEnv};
}

function candidateId(requestId,patchDigest,baseSha,targetSha) {
  const body=[requestId,patchDigest,baseSha,targetSha].join('\0');
  return `cand_${digest(Buffer.from(body)).slice(0,32)}`;
}

function validateEvidencePlan(plan) {
  if(!plan||typeof plan!=='object'||Array.isArray(plan)||Object.keys(plan).some(key=>!['schema_version','checks'].includes(key))||plan.schema_version!==1||!Array.isArray(plan.checks)||plan.checks.length>30) throw new Error('invalid evidence plan: expected schema_version 1 and at most 30 checks');
  const allowed=new Set(['id','argv','issuer','trust_profile']);
  for(const [index,check] of plan.checks.entries()) {
    if(!check||typeof check!=='object'||Array.isArray(check)||Object.keys(check).some(key=>!allowed.has(key))||Object.keys(check).length!==allowed.size) throw new Error(`invalid evidence plan check ${index}: expected id, argv, issuer, and trust_profile only`);
    if(typeof check.id!=='string'||check.id.length>128||!/^[A-Za-z0-9_.-]+$/.test(check.id)) throw new Error(`invalid evidence plan check ${index}: invalid id`);
    if(!Array.isArray(check.argv)||check.argv.length<1||check.argv.length>64||check.argv.some(arg=>typeof arg!=='string'||!arg||arg.length>8192||arg.includes('\0'))) throw new Error(`invalid evidence plan check ${check.id}: invalid argv`);
    if(typeof check.issuer!=='string'||!check.issuer.trim()||check.issuer.length>200) throw new Error(`invalid evidence plan check ${check.id}: invalid issuer`);
    if(typeof check.trust_profile!=='string'||!check.trust_profile.trim()||check.trust_profile.length>200) throw new Error(`invalid evidence plan check ${check.id}: invalid trust_profile`);
  }
  return plan.checks;
}

function copyForCheck(source,root,checkId,index) {
  const dir=path.join(root,`check-${index}-${digest(Buffer.from(checkId)).slice(0,12)}`);
  fs.cpSync(source,dir,{recursive:true,dereference:false,errorOnExist:true});
  return dir;
}

function defaultRunnerRoot(checkoutDir) {
  return withinBuildScratch(path.join(path.dirname(checkoutDir),`integrator-runner-${randomUUID()}`));
}

function runIsolatedCheck(check,checkoutDir,runnerRoot,repoName) {
  const root=withinBuildScratch(runnerRoot);
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const sourceCopyDir=path.join(root,'source-exemptions');
  fs.mkdirSync(sourceCopyDir,{mode:0o700});
  const masked=sensitiveMasks(checkoutDir,repoName,sourceCopyDir);
  const request={checkout_dir:checkoutDir,runner_root:root,argv:check.argv,github_repo:repoName,maskPaths:masked.paths,sourceExemptions:masked.sourceExemptions};
  const env={PATH:'/usr/bin:/bin',HOME:path.join(root,'home'),TMPDIR:path.join(root,'tmp'),LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'UTC',NODE_ENV:'production',DALAN_WORKSPACE_ROOT:path.join(root,'workspace'),DALAN_INTEGRATOR_SCRATCH_ROOT:buildScratch};
  if(readEnv('DALAN_HOST_CHECKS')==='1') env.DALAN_HOST_CHECKS='1';
  if(process.env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR=process.env.XDG_RUNTIME_DIR;
  if(process.env.DBUS_SESSION_BUS_ADDRESS) env.DBUS_SESSION_BUS_ADDRESS=process.env.DBUS_SESSION_BUS_ADDRESS;
  fs.mkdirSync(env.HOME,{recursive:true,mode:0o700});
  fs.mkdirSync(env.TMPDIR,{recursive:true,mode:0o700});
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[modulePath,'--confined-check-runner'],{env,stdio:['pipe','pipe','pipe'],detached:true});
    let stdout='',stderr='',stderrTruncated=false,settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{if(stdout.length<1024*1024) stdout+=chunk;});
    child.stderr.on('data',chunk=>{if(stderr.length+chunk.length>4000) stderrTruncated=true;else if(!stderrTruncated) stderr+=chunk;});
    child.on('error',error=>finish(error));
    child.on('close',code=>{
      if(code!==0) return finish(new Error(`confined check runner exited ${code}: ${stderrTruncated?'[runner error output withheld]':shortJson(redactSecrets(stderr).text,1000)}`));
      try {
        const result=JSON.parse(stdout);
        finish(null,{...result,bytes:Buffer.from(result.bytes??'','base64')});
      } catch { finish(new Error('confined check runner returned invalid output')); }
    });
    const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{};finish(new Error('confined check runner timed out'));},180000);
    child.stdin.end(JSON.stringify(request));
  });
}

export function evidenceCheckResult(check,raw) {
  const bytes=Buffer.from(raw.bytes??'');
  const output=redactSecrets(bytes.toString('utf8')).text;
  const successful=[0,77].includes(raw.exit?.code)&&!raw.timedOut&&!raw.cancelled&&raw.stop?.verified===true;
  const row={id:check.id,check_id:check.id,argv:check.argv,issuer:check.issuer,trust_profile:check.trust_profile,status:successful?'completed':'failed',exit_code:raw.exit?.code??null,
    timed_out:!!raw.timedOut,cancelled:!!raw.cancelled,stop_verified:raw.stop?.verified===true,duration_ms:Number(raw.duration_ms)||0,
    output_sha256:digest(Buffer.from(output)),output_bytes:Buffer.byteLength(output),output_preview:shortJson(output),output_redaction_version:1,...(raw.host_budget?{host_budget:raw.host_budget}:{}),...(raw.error?{error:redactSecrets(String(raw.error)).text}:{})};
  const result=withCheckCoverage(row,output);
  if(result.status==='completed') result.status='passed';
  return redactOutput(result);
}

export function evidencePlanStatus(checks) {
  if(!checks.length||checks.some(check=>!['passed','skipped'].includes(check.status))) return 'failed';
  if(checks.some(check=>check.status==='skipped')) return 'skipped';
  return checks.every(check=>check.status==='passed')?'verified':'failed';
}

export async function runEvidencePlan(plan,checkoutDir,repoName='integrator/local') {
  const checks=validateEvidencePlan(plan);
  if(checks.length===0) return [{id:'evidence-plan',issuer:'assignment',trust_profile:TRUST.bridge,status:'failed',error:'no checks are declared'}];
  const resolvedCheckout=withinBuildScratch(checkoutDir);
  if(!fs.statSync(resolvedCheckout).isDirectory()) throw new Error('checkoutDir must be a directory');
  const root=defaultRunnerRoot(resolvedCheckout);
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const results=[];
  for(const [index,check] of checks.entries()) {
    try {
      const perCheck=copyForCheck(resolvedCheckout,root,check.id,index);
      const raw=await runIsolatedCheck(check,perCheck,path.join(root,`runner-${index}`),repoName);
      results.push(evidenceCheckResult(check,raw));
    } catch(error) {
      const message=redactSecrets(String(error?.message??error)).text;
      results.push(evidenceCheckResult(check,{bytes:Buffer.from(message),error:message}));
    }
  }
  return results;
}

export async function loadSealedResult(store,requestId) {
  const result=store.get(requestId),evidence=result.report?.workspace_evidence;
  const artifactId=evidence?.patch_artifact?.artifact_id;
  if(!artifactId) throw new Error('stored report has no patch artifact');
  const { Workspace }=await import('./workspace.mjs');
  const reader=Object.create(Workspace.prototype);reader.store=store;
  const artifact=reader.artifact(artifactId,requestId);
  if(artifact.row.kind!=='patch'||artifact.row.sealed!==1) throw new Error('stored result artifact is not a sealed patch');
  const input=result.assignment?.inputs?.find(item=>item.github_repo);
  const baseSha=evidence.base_sha??input?.base_sha;
  if(!fullSha.test(baseSha??'')||input?.base_sha&&input.base_sha!==baseSha) throw new Error('stored patch base SHA is missing or inconsistent');
  if(evidence.patch_artifact.sha256!==artifact.row.sha256) throw new Error('stored report patch digest is inconsistent');
  return {request_id:requestId,assignment:result.assignment,review:result.review,patch:artifact.bytes,patch_sha256:artifact.row.sha256,patch_base_sha:baseSha,
    github_repo:input?.github_repo};
}

function failedCheck(id,error,issuer='dot-bridge') {
  const bytes=Buffer.from(String(error));
  return {id,issuer,trust_profile:TRUST.bridge,status:'failed',exit_code:null,timed_out:false,cancelled:false,stop_verified:false,duration_ms:0,
    output_sha256:digest(bytes),output_bytes:bytes.length,output_preview:shortJson(redactSecrets(bytes.toString('utf8')).text),output_redaction_version:1,error:redactSecrets(String(error)).text};
}

function defaultEvidencePlan(repoName,repoDir,baseSha,scratchRoot,env) {
  const metadataCheckout=worktree(repoDir,baseSha,scratchRoot,env,'assignment-checks').dir;
  const ids=availableChecks(repoName,metadataCheckout);
  const checks=ids.map(id=>{
    const resolved=detectCheckWithOrigin(repoName,metadataCheckout,id);
    if(!resolved?.spec) throw new Error(`assignment check ${id} could not be resolved at ${baseSha}`);
    return {id,argv:resolved.spec.argv,install_argv:resolved.spec.install_argv,issuer:resolved.from==='owner_config'?'owner-config':resolved.from==='workspace_file'?'repository-config':`repository:${resolved.from}`,trust_profile:TRUST.bridge};
  });
  return {schema_version:1,checks};
}

function changedCheckInputs(files,plan) {
  const named=new Set(CHECK_INPUT_FILES);
  for(const check of plan.checks) {
    const commands=[check.argv,...(check.install_argv?[check.install_argv]:[])];
    for(const argv of commands) for(const arg of argv) for(const word of arg.split(/[\s'"=;&|()<>]+/)) {
      const file=word.replace(/^\.\//,'').replace(/^\/workspace\//,'');
      if(file&&!file.startsWith('/')&&!file.startsWith('-')) named.add(file);
    }
  }
  return files.filter(file=>named.has(file)).sort();
}

function isPatchConflict(error) {
  const message=String(error?.message??error);
  if(/whitespace/i.test(message)) return false;
  return /not applied:|git apply --check failed|different line of history|not an ancestor|base [0-9a-f]{12} is not in this checkout/i.test(message);
}

export async function verifySealedResult({store,sealedResult,repoDir,targetBaseRef,scratchRoot=path.join(buildScratch,'integrator')}) {
  if(!store||typeof store.putIntegrationCandidate!=='function'||typeof store.beginIntegrationVerification!=='function') throw new Error('a migration-ready Store is required');
  const requestId=sealedResult?.request_id,assignment=sealedResult?.assignment;
  if(typeof requestId!=='string'||!requestId||!assignment||sealedResult.review===true||assignment.execution_scope!=='implementation') throw new Error('only implementation patch results can be verified');
  const input=assignment.inputs?.find(item=>item.github_repo);
  const repoName=sealedResult.github_repo??input?.github_repo;
  if(typeof repoName!=='string'||!repoName) throw new Error('sealed result has no repository identity');
  const patch=Buffer.from(sealedResult.patch??[]),patchDigest=sealedResult.patch_sha256,patchBaseSha=sealedResult.patch_base_sha;
  if(patch.length>MAX_INTEGRATION_PATCH_BYTES) throw new Error(`sealed patch too large (maximum ${MAX_INTEGRATION_PATCH_BYTES} bytes)`);
  if(!patch.length||!fullSha.test(patchBaseSha??'')||!/^[a-f0-9]{64}$/.test(patchDigest??'')||digest(patch)!==patchDigest) throw new Error('sealed patch digest or recorded base SHA is invalid');
  const scratch=withinBuildScratch(scratchRoot);
  fs.mkdirSync(scratch,{recursive:true,mode:0o700});
  const baseEnv=makeHostEnv(scratch);
  const repository=resolveCheckout(repoDir,baseEnv);
  const targetSha=resolveTarget(repository,targetBaseRef,baseEnv);
  const originalId=candidateId(requestId,patchDigest,patchBaseSha,patchBaseSha);
  const originalCandidate={candidate_id:originalId,request_id:requestId,kind:'patch',linked_from:null,patch,patch_digest:patchDigest,
    patch_base_sha:patchBaseSha,target_sha:patchBaseSha,github_repo:repoName};
  const changedBase=targetSha!==patchBaseSha;
  const currentId=changedBase?candidateId(requestId,patchDigest,patchBaseSha,targetSha):originalId;
  const candidateInput=changedBase?{candidate_id:currentId,request_id:requestId,kind:'patch',linked_from:originalId,patch,patch_digest:patchDigest,
    patch_base_sha:patchBaseSha,target_sha:targetSha,github_repo:repoName}:originalCandidate;
  const {candidates:storedCandidates}=store.beginIntegrationVerification(changedBase?[originalCandidate,candidateInput]:[originalCandidate],{
    candidate_id:currentId,patch_digest:patchDigest,patch_base_sha:patchBaseSha,target_sha:targetSha,target_ref:targetBaseRef,status:'failed',checks:[],
    error:'verification interrupted before completion',
  });
  const original=storedCandidates[0],candidate=changedBase?storedCandidates[1]:original;
  let checkoutDir=null,status='failed',checks=[],error=null,plan=null;
  try {
    const checkout=worktree(repository,targetSha,scratch,baseEnv,'candidate');
    checkoutDir=checkout.dir;
    const files=validateIntegrationPatch(checkoutDir,patch,assignment);
    applyPatch({dir:checkoutDir,patch,sha256:patchDigest,baseSha:patchBaseSha,env:checkout.env});
    plan=defaultEvidencePlan(repoName,repository,patchBaseSha,scratch,baseEnv);
    const changedInputs=changedCheckInputs(files,plan);
    if(changedInputs.length) {
      status='owner_approval_required';
      error='patch changes how it is checked';
      checks=[{id:'check-inputs',issuer:'dot-bridge',trust_profile:TRUST.bridge,status,changed_inputs:changedInputs}];
    } else {
      checks=await runEvidencePlan({schema_version:1,checks:plan.checks.map(({install_argv,...check})=>check)},checkoutDir,repoName);
      status=evidencePlanStatus(checks);
    }
  } catch(caught) {
    error=redactSecrets(String(caught?.message??caught)).text;
    if(isPatchConflict(caught)) status='conflict';
    else if(checks.length===0) checks=[failedCheck('integration',error)];
  }
  const record={candidate_id:currentId,patch_digest:patchDigest,patch_base_sha:patchBaseSha,target_sha:targetSha,target_ref:targetBaseRef,status,checks,error};
  let stored=null,recordingError=null;
  try { stored=store.recordIntegrationVerification(record); }
  catch(caught) { recordingError=String(caught?.message??caught); }
  const verification=stored?{...stored,checks}:{...record,verification_id:null,recorded:false,recording_error:recordingError};
  return {status,candidate,original_candidate_id:original.candidate_id,verification,verification_recorded:!!stored,scratch_dir:checkoutDir};
}

async function confinedCheckRunner() {
  let input='';for await(const chunk of process.stdin) input+=chunk;
  const request=JSON.parse(input),root=withinBuildScratch(request.runner_root),checkoutDir=withinBuildScratch(request.checkout_dir);
  process.env.DALAN_WORKSPACE_ROOT=path.join(root,'workspace');
  const store=new Store(':memory:',{deferSubscriptionRetirement:true});
  const requestId=`integrator_${randomUUID()}`;
  const payload={inputs:[{github_repo:request.github_repo,base_sha:'0'.repeat(40)}],execution_scope:'implementation'};
  store.insertConfinedCheckAssignment(requestId,payload);
  const { Workspace }=await import('./workspace.mjs');
  const workspace=new Workspace(store,false);
  const raw=await workspace.runConfined(requestId,checkoutDir,request.argv,{timeout_ms:INTEGRATOR_HOST_BUDGET.wall_ms,output_bytes:INTEGRATOR_HOST_BUDGET.output_bytes,host_budget:INTEGRATOR_HOST_BUDGET,network:false,maskPaths:request.maskPaths,sourceExemptions:request.sourceExemptions},{cancelled:()=>false});
  const bytes=Buffer.from(raw.bytes??'');
  process.stdout.write(JSON.stringify({exit:raw.exit,timedOut:raw.timedOut,cancelled:raw.cancelled,stop:raw.stop,duration_ms:raw.duration_ms,bytes:bytes.toString('base64'),truncated:raw.truncated,error:raw.error??null,host_budget:{limits:raw.budgets,usage:raw.usage}}));
  store.db.close();
}

if(process.argv[1]===modulePath&&process.argv[2]==='--confined-check-runner') {
  confinedCheckRunner().catch(error=>{process.stderr.write(safeDiagnostic(error?.stack??error,4000));process.exitCode=1;});
}
