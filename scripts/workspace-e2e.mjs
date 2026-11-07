#!/usr/bin/env node
import './require-host-checks.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-bridge-workspace-'));process.env.HOME=home;process.env.DOT_BRIDGE_WORKSPACE_ROOT=path.join(home,'work');
const {Store}=await import('../src/store.mjs'),{Workspace}=await import('../src/workspace.mjs');
const run=(cmd,args,cwd)=>{const x=spawnSync(cmd,args,{cwd,encoding:'utf8'});if(x.status!==0)throw new Error(x.stderr||x.stdout);return x.stdout.trim();};
const assert=(x,m)=>{if(!x)throw new Error(m);};
let hostListener;
try {
 hostListener=net.createServer(socket=>socket.end('HOST NETWORK LEAK'));
 await new Promise(resolve=>hostListener.listen(0,'127.0.0.1',resolve));
 const hostPort=hostListener.address().port;
 const repo=path.join(home,'repo');fs.mkdirSync(repo);run('git',['init','-q'],repo);run('git',['config','user.email','test@example.com'],repo);run('git',['config','user.name','Test'],repo);
 fs.writeFileSync(path.join(repo,'hello.txt'),'before\n');fs.writeFileSync(path.join(repo,'package.json'),JSON.stringify({scripts:{test:'node --check probe.mjs'}}));fs.writeFileSync(path.join(repo,'probe.mjs'),`import fs from 'node:fs';import net from 'node:net';import { spawnSync } from 'node:child_process';
const forbidden=['/home/example-owner/.ssh','/home/example-owner/.config','/home/example-owner/.local/share/dot-bridge/admin.sock','/home/example-owner/code/dot-bridge/.git','/workspace/.git/objects','/run/user/1000/ssh-agent.sock','/etc/passwd','/etc/group','/etc/shadow','/etc/ssl/private'];
if(JSON.stringify(fs.readdirSync(process.env.HOME).sort())!==JSON.stringify(['.tmp']))throw new Error('HOME NOT ISOLATED');console.log('ISOLATED HOME');
const awk=spawnSync('awk',['BEGIN { print "awk-ok" }'],{encoding:'utf8'});
if(awk.status!==0||awk.stdout.trim()!=='awk-ok')throw new Error('AWK BROKEN '+(awk.stderr||awk.stdout));
console.log('AWK OK');
if(!/^[0-9,-]+$/.test(fs.readFileSync('/sys/devices/system/cpu/online','utf8').trim()))throw new Error('CPU ONLINE MISSING');
console.log('CPU ONLINE OK');
if(fs.existsSync('/sys/class/net'))throw new Error('SYSFS TOO BROAD');
console.log('SYSFS NARROW');
try{fs.writeFileSync('/etc/alternatives/awk','changed');throw new Error('ALTERNATIVES WRITABLE')}catch(e){if(e.message==='ALTERNATIVES WRITABLE')throw e;console.log('ALTERNATIVES READ ONLY')}
if(spawnSync('systemctl',['--user','stop','test.scope']).status===0)throw new Error('SYSTEMCTL MUTATION ALLOWED');
try{fs.writeFileSync('/runtime/systemctl','changed');throw new Error('SYSTEMCTL SHIM WRITABLE')}catch(e){if(e.message==='SYSTEMCTL SHIM WRITABLE')throw e;console.log('SYSTEMCTL SHIM READ ONLY')}
const scopes=spawnSync('systemctl',['--user','list-units','--all','--type=scope','--state=active','--no-legend','--plain','sample-project-*.scope'],{encoding:'utf8'});
if(scopes.status!==0||scopes.stdout!=='')throw new Error('SYSTEMCTL SCOPE STUB BROKEN');
if(spawnSync('systemctl',['--user','show-environment'],{encoding:'utf8'}).status===0)throw new Error('SYSTEMCTL USER BUS EXPOSED');
if(spawnSync('/usr/bin/systemctl',['--user','show-environment'],{encoding:'utf8'}).status===0)throw new Error('HOST USER BUS EXPOSED');
console.log('SYSTEMCTL USER BUS DENIED');
for(const p of forbidden){if(fs.existsSync(p))throw new Error('VISIBLE '+p);console.log('DENIED '+p)}
for(const action of [()=>fs.writeFileSync('/workspace/.git','gitdir: /tmp/evil'),()=>fs.unlinkSync('/workspace/.git'),()=>fs.renameSync('/workspace/.git','/workspace/old-git')]){try{action();throw new Error('GIT POINTER MUTABLE')}catch(e){if(e.message==='GIT POINTER MUTABLE')throw e;console.log('DENIED GIT POINTER')}}
for(const k of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','SSH_AUTH_SOCK']){if(process.env[k])throw new Error('ENV '+k);console.log('DENIED ENV '+k)}
for(const name of ['claude','codex','gemini','openai','t3code']){if(process.env.PATH.split(':').some(dir=>fs.existsSync(dir+'/'+name)))throw new Error('MODEL COMMAND '+name);console.log('DENIED MODEL '+name)}
const socket=net.connect(${hostPort},'127.0.0.1');socket.on('error',()=>{console.log('DENIED NETWORK');process.exit(0)});socket.on('connect',()=>{console.error('NETWORK ALLOWED');process.exit(2)});setTimeout(()=>process.exit(3),1500);
`);run('git',['add','.'],repo);run('git',['commit','-qm','base'],repo);const base=run('git',['rev-parse','HEAD'],repo);
 process.env.DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE=repo;
 fs.writeFileSync(path.join(repo,'.dot-bridge.json'),JSON.stringify({checks:{default:{argv:['/runtime/node','probe.mjs'],timeout_ms:5000,output_bytes:16384}}}),{mode:0o600});run('git',['add','.dot-bridge.json'],repo);run('git',['commit','-qm','check override'],repo);const checkBase=run('git',['rev-parse','HEAD'],repo);
 const store=new Store(path.join(home,'db.sqlite')),ws=new Workspace(store);ws.freeBytes=async()=>100*1024**3;const ids=[`req_${randomUUID()}`,`req_${randomUUID()}`];let claims=[];
 for(const id of ids){const payload={schema_version:1,request_id:id,brief:'fixture',inputs:[{github_repo:'example-owner/fixture',base_sha:checkBase}],expected_output:'patch',execution_scope:'implementation'};store.submit(payload,'thread-id','environment','owner');claims.push(store.claim(id,'dot','subject',2).claim_id);}
 assert(ws.read(ids[0],claims[0],'subject','hello.txt').text==='before\n','read');assert(ws.list(ids[0],claims[0],'subject').files.includes('hello.txt'),'list');{const many=path.join(home,'work/worktrees',ids[0],'many');fs.mkdirSync(many,{recursive:true});for(let i=0;i<30;i++) fs.writeFileSync(path.join(many,`f${i}.txt`),'x');const capped=ws.list(ids[0],claims[0],'subject','',5);assert(capped.files.length===5&&capped.truncated===true,'list truncates instead of failing');const sub=ws.list(ids[0],claims[0],'subject','many',200);assert(sub.files.length===30&&sub.files.every(f=>f.startsWith('many/'))&&!sub.truncated,'list walks only the requested subtree');fs.rmSync(many,{recursive:true});}
 assert(run('git',['-C',path.join(home,'work/mirrors/workers/dot/example-owner/fixture.git'),'remote']).trim()==='','mirror retained a remote');
 for(const bad of ['../hello.txt','/etc/passwd','.git','link/secret']) {if(bad==='link/secret')fs.symlinkSync('/etc',path.join(home,'work/worktrees',ids[0],'link'));try{ws.read(ids[0],claims[0],'subject',bad);throw new Error('unsafe path accepted '+bad);}catch(e){if(e.message.startsWith('unsafe path accepted'))throw e;}}
 fs.unlinkSync(path.join(home,'work/worktrees',ids[0],'link'));
 const patch='diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-before\n+after\n';const result=ws.apply(ids[0],claims[0],'subject',patch);assert(result.files[0]==='hello.txt','patch');assert(ws.read(ids[1],claims[1],'subject','hello.txt').text==='before\n','worktree interference');
 try{ws.apply(ids[1],claims[1],'subject',patch+'--- a/.git/config\n+++ b/.git/config\n');throw new Error('hidden patch header accepted');}catch(e){if(e.message==='hidden patch header accepted')throw e;}
 const added='diff --git a/added.txt b/added.txt\nnew file mode 100644\n--- /dev/null\n+++ b/added.txt\n@@ -0,0 +1 @@\n+new file\n';ws.apply(ids[0],claims[0],'subject',added);assert(ws.diff(path.join(home,'work/worktrees',ids[0])).patch.includes('added.txt'),'untracked file missing from diff');
 const dependencyDir=path.join(home,'work/worktrees',ids[0],'node_modules/pkg');fs.mkdirSync(dependencyDir,{recursive:true});fs.writeFileSync(path.join(dependencyDir,'index.js'),'generated\n');assert(!ws.diff(path.join(home,'work/worktrees',ids[0])).patch.includes('node_modules'),'installed dependencies entered patch');fs.rmSync(path.join(home,'work/worktrees',ids[0],'node_modules'),{recursive:true});
 const probe=await ws.check(ids[0],claims[0],'subject','default');console.log(probe.output_preview);assert(probe.exit_code===0&&!probe.timed_out&&probe.output_preview.includes('DENIED NETWORK'),'sandbox probe');
 const unknown=await ws.check(ids[0],claims[0],'subject','missing-check');assert(unknown.skipped&&unknown.available_checks.includes('default'),'unknown check must list available checks');
 assert(ws.result(ids[0],claims[0],'subject').available_checks.includes('default'),'workspace result must list checks');
 assert(ws.availableChecksFor({inputs:[{github_repo:'example-owner/fixture',base_sha:base}],execution_scope:'implementation'}).includes('default'),'package.json fallback check missing');
 fs.writeFileSync(path.join(home,'work/worktrees',ids[0],'.dot-bridge.json'),JSON.stringify({checks:{default:{argv:['/runtime/node','-e','const net=require("node:net");const server=net.createServer(socket=>socket.end("ok"));server.listen(0,"127.0.0.1",()=>{const client=net.connect(server.address().port,"127.0.0.1");client.on("data",data=>{if(String(data)!=="ok")process.exitCode=1;else console.log("LOOPBACK OK")});client.on("end",()=>server.close())})'],timeout_ms:5000,output_bytes:16384}}}));
 const loopback=await ws.check(ids[0],claims[0],'subject','default');assert(loopback.exit_code===0&&loopback.output_preview.includes('LOOPBACK OK'),'isolated loopback server failed');
 fs.writeFileSync(path.join(home,'work/worktrees',ids[0],'.dot-bridge.json'),JSON.stringify({checks:{default:{install_argv:['/runtime/node','-e','require("node:fs").writeFileSync("/cache/installed","ok");console.log("INSTALL COMPLETE")'],argv:['/runtime/node','-e','if(require("node:fs").readFileSync("/cache/installed","utf8")!=="ok")process.exit(1);console.log("CHECK COMPLETE")'],timeout_ms:5000,output_bytes:16384}}}));
 const phases=await ws.check(ids[0],claims[0],'subject','default');const phaseBytes=ws.artifact(phases.output_artifact_id,ids[0]).bytes;assert(phases.exit_code===0&&phases.phase==='check'&&phaseBytes.toString().includes('INSTALL COMPLETE')&&phaseBytes.toString().includes('CHECK COMPLETE')&&createHash('sha256').update(phaseBytes).digest('hex')===phases.output_sha256,'two-phase check evidence');
 fs.writeFileSync(path.join(home,'work/worktrees',ids[0],'.dot-bridge.json'),JSON.stringify({checks:{default:{argv:['/runtime/node','--check','probe.mjs'],timeout_ms:5000,output_bytes:16384}}}));
 const syntax=await ws.check(ids[0],claims[0],'subject','default');assert(syntax.exit_code===0,'syntax check');
 // Exercise PATH lookup and nested child processes in both install and check phases.
 const npmProbe=`const {spawnSync}=require('node:child_process');
for(const name of ['npm','npx']) {
  const result=spawnSync(name,['--version'],{encoding:'utf8'});
  if(result.error||result.status!==0||!/^\\d+\\.\\d+\\.\\d+/.test(result.stdout.trim()))throw new Error(name+' PATH lookup failed: '+(result.error||result.stderr));
}
const nested=spawnSync('node',['-e',"const r=require('node:child_process').spawnSync('npm',['--version'],{encoding:'utf8'});if(r.error||r.status!==0)process.exit(1);process.stdout.write(r.stdout)"],{encoding:'utf8'});
if(nested.status!==0||!nested.stdout.trim())throw new Error('nested npm failed');
for(const name of ['npm','npx']) {
  try {require('node:fs').writeFileSync('/runtime-bin/'+name,'changed');throw new Error('SHIM WRITABLE');}
  catch(error) {if(error.message==='SHIM WRITABLE')throw error;}
}
console.log('NPM NPX PATH OK');`;
 fs.writeFileSync(path.join(home,'work/worktrees',ids[0],'.dot-bridge.json'),JSON.stringify({checks:{default:{install_argv:['npm','--version'],argv:['node','-e',npmProbe],timeout_ms:15000,output_bytes:16384}}}));
 const npmCheck=await ws.check(ids[0],claims[0],'subject','default');assert(npmCheck.exit_code===0&&npmCheck.phase==='check'&&npmCheck.output_preview.includes('NPM NPX PATH OK'),'npm CLI install and nested check');
 fs.writeFileSync(path.join(home,'work/worktrees',ids[0],'.dot-bridge.json'),JSON.stringify({checks:{default:{install_argv:['node','-e',npmProbe],argv:['npm','--version'],timeout_ms:15000,output_bytes:16384}}}));
 const npmInstall=await ws.check(ids[0],claims[0],'subject','default');assert(npmInstall.exit_code===0&&npmInstall.phase==='check'&&npmInstall.output_preview.includes('NPM NPX PATH OK'),'nested npm install and npm CLI check');

 const changedAgain='diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-after\n+after-again\n';ws.apply(ids[0],claims[0],'subject',changedAgain);assert(ws.result(ids[0],claims[0],'subject').checks.every(c=>!c.matches_current_diff&&!c.applies_to_current_diff),'stale check marked current');await ws.check(ids[0],claims[0],'subject','default');assert(ws.result(ids[0],claims[0],'subject').checks.at(-1).matches_current_diff&&ws.result(ids[0],claims[0],'subject').checks.at(-1).applies_to_current_diff,'current check hash missing');
 const data=Buffer.alloc(100000,0x61),digest=createHash('sha256').update(data).digest('hex'),art=`art_${randomUUID()}`;const first=data.subarray(0,65536).toString('base64'),second=data.subarray(65536).toString('base64');ws.chunk(ids[0],claims[0],'subject',art,0,first);ws.chunk(ids[0],claims[0],'subject',art,0,first);ws.chunk(ids[0],claims[0],'subject',art,65536,second,true,digest);assert(ws.chunk(ids[0],claims[0],'subject',art,65536,second,true,digest).sealed,'sealed retry');const globalArt=store.db.prepare('SELECT id FROM artifacts WHERE request_id=? AND client_artifact_id=?').get(ids[0],art).id;assert(globalArt!==art&&ws.artifact(globalArt,ids[0]).bytes.equals(data),'T16 global artifact bytes');
 const interruptedUpload=`art_${randomUUID()}`,firstHalf=Buffer.from('part one'),lastHalf=Buffer.from('part two');ws.chunk(ids[0],claims[0],'subject',interruptedUpload,0,firstHalf.toString('base64'));fs.appendFileSync(store.db.prepare('SELECT path FROM artifacts WHERE request_id=? AND client_artifact_id=?').get(ids[0],interruptedUpload).path,lastHalf.subarray(0,3));const recovered=ws.chunk(ids[0],claims[0],'subject',interruptedUpload,firstHalf.length,lastHalf.toString('base64'),true,createHash('sha256').update(Buffer.concat([firstHalf,lastHalf])).digest('hex'));assert(recovered.sealed&&recovered.offset===firstHalf.length+lastHalf.length,'interrupted append recovery');
 const evidence=ws.snapshot(ids[0],claims[0],'subject'),patchBytes=ws.artifact(evidence.patch_artifact.artifact_id,ids[0]).bytes;assert(patchBytes.toString().includes('+after'),'patch artifact');assert(spawnSync('git',['apply','--check','-'],{cwd:repo,input:patchBytes}).status===0,'owner cannot apply patch artifact');store.finish(ids[0],claims[0],'completed','done','data','subject',evidence);const cancelWorkspace=path.join(home,'work/worktrees',ids[1]),cancelMarker=path.join(cancelWorkspace,'cancel-started');fs.writeFileSync(path.join(cancelWorkspace,'.dot-bridge.json'),JSON.stringify({checks:{default:{argv:['/runtime/node','-e',"require('node:fs').writeFileSync('cancel-started','yes');setInterval(()=>{},1000)"],timeout_ms:5000,output_bytes:16384}}}));const running=ws.check(ids[1],claims[1],'subject','default');const cancelDeadline=Date.now()+4000;while(!fs.existsSync(cancelMarker)&&Date.now()<cancelDeadline)await new Promise(resolve=>setTimeout(resolve,10));assert(fs.existsSync(cancelMarker),'cancellable sandbox did not start');store.cancel(ids[1]);const interrupted=await running;assert(interrupted.cancelled&&!interrupted.timed_out&&interrupted.duration_ms<3000,'cancelled check was not terminated');try{ws.apply(ids[1],claims[1],'subject',patch);throw new Error('cancelled mutation accepted');}catch(e){if(e.message==='cancelled mutation accepted')throw e;}
 const readOnly=`req_${randomUUID()}`,assignment={schema_version:1,request_id:readOnly,brief:'inspect',inputs:[{github_repo:'example-owner/fixture',base_sha:checkBase}],expected_output:'finding',execution_scope:'read-only'};store.submit(assignment,'thread','environment','owner');const readClaim=store.claim(readOnly,'dot','subject',1).claim_id;assert(ws.read(readOnly,readClaim,'subject','hello.txt').text==='before\n','read-only file');try{ws.apply(readOnly,readClaim,'subject',patch);throw new Error('read-only mutation accepted');}catch(e){if(e.message==='read-only mutation accepted')throw e;}
 const recovering=`req_${randomUUID()}`,recoveryAssignment={...assignment,request_id:recovering};store.submit(recoveryAssignment,'thread','environment','owner');const recoveryClaim=store.claim(recovering,'dot','subject',2).claim_id;run('git',['-C',path.join(home,'work/mirrors/workers/dot/example-owner/fixture.git'),'worktree','add','--detach',path.join(home,'work/worktrees',recovering),checkBase]);assert(ws.read(recovering,recoveryClaim,'subject','hello.txt').text==='before\n','unrecorded worktree recovery');
 store.finish(readOnly,readClaim,'completed','reviewed','done','subject');
 fs.writeFileSync(path.join(repo,'hello.txt'),'reviewed\n');run('git',['add','hello.txt'],repo);run('git',['commit','-qm','review head'],repo);const head=run('git',['rev-parse','HEAD'],repo);
 const reviewId=`req_${randomUUID()}`,reviewAssignment={...assignment,request_id:reviewId,inputs:[{github_repo:'example-owner/fixture',base_sha:checkBase,head_sha:head}]};(await import('../src/projects.mjs')).prepareGithubRepo(reviewAssignment.inputs[0],{worker:'dot'});store.submit(reviewAssignment,'thread','environment','owner');const reviewClaim=store.claim(reviewId,'dot','subject',2).claim_id;
 assert(ws.read(reviewId,reviewClaim,'subject','hello.txt').text==='reviewed\n','head revision not checked out');const reviewResult=ws.result(reviewId,reviewClaim,'subject');assert(reviewResult.head_sha===head&&reviewResult.diff_preview.includes('+reviewed'),'base-to-head review diff missing');
 const plainId=`req_${randomUUID()}`;store.submit({schema_version:1,request_id:plainId,brief:'plain review',inputs:[{revision:'abc'}],expected_output:'finding',execution_scope:'read-only'},'thread','environment','owner');const plainClaim=store.claim(plainId,'dot','subject',10).claim_id;
 const plainBytes=Buffer.from('review evidence'),plainArt=`art_${randomUUID()}`,plainSha=createHash('sha256').update(plainBytes).digest('hex');ws.chunk(plainId,plainClaim,'subject',plainArt,0,plainBytes.toString('base64'),true,plainSha);
 assert(!store.db.prepare('SELECT 1 FROM workspaces WHERE request_id=?').get(plainId),'plain upload created a workspace');
 assert(ws.result(plainId,plainClaim,'subject').artifacts.some(a=>a.id===plainArt),'plain upload absent from workspace_result');
 assert(ws.artifact(store.db.prepare('SELECT id FROM artifacts WHERE request_id=? AND client_artifact_id=?').get(plainId,plainArt).id,plainId).bytes.equals(plainBytes),'plain artifact download');
 try{ws.chunk(plainId,readClaim,'subject',`art_${randomUUID()}`,0,'YQ==');throw new Error('wrong claim uploaded artifact');}catch(e){if(e.message==='wrong claim uploaded artifact')throw e;}
 const realDeadline=process.env.DOT_BRIDGE_TEST_SHORT_DEADLINE!=='1';
 const slowWs=new Workspace(store,false,realDeadline?{}:{checkResponseOptions:{responseMs:250}});
 const slowId=`req_${randomUUID()}`,slowAssignment={schema_version:1,request_id:slowId,brief:'slow check',inputs:[{github_repo:'example-owner/fixture',base_sha:checkBase}],expected_output:'check',execution_scope:'implementation'};store.submit(slowAssignment,'thread','environment','owner');const slowClaim=store.claim(slowId,'dot','subject',10).claim_id;slowWs.ensure(slowId,slowClaim,'subject');
 fs.writeFileSync(path.join(home,'work/worktrees',slowId,'.dot-bridge.json'),JSON.stringify({checks:{default:{argv:['/runtime/node','-e',`setTimeout(()=>console.log("SLOW DONE"),${realDeadline?22000:1000})`],timeout_ms:30000,output_bytes:16384}}}));
 const slowStart=Date.now(),slowPromise=slowWs.check(slowId,slowClaim,'subject','default');await new Promise(resolve=>setTimeout(resolve,100));
 const duplicate=await slowWs.check(slowId,slowClaim,'subject','default');assert(duplicate.status==='running','duplicate slow check did not report running');
 const whileRunning=slowWs.result(slowId,slowClaim,'subject').checks.find(c=>c.check_run_id===duplicate.check_run_id);assert(whileRunning?.status==='running','running check missing from workspace_result');
 const started=await slowPromise;assert(started.status==='running'&&started.check_run_id===duplicate.check_run_id&&Date.now()-slowStart<(realDeadline?21500:3000),'slow check blocked beyond fast path');
 let completed;for(let tries=0;tries<60;tries++){completed=slowWs.result(slowId,slowClaim,'subject').checks.find(c=>c.check_run_id===duplicate.check_run_id);if(completed?.status==='completed')break;await new Promise(resolve=>setTimeout(resolve,100));}
 assert(completed?.status==='completed'&&completed.exit_code===0&&completed.output_preview.includes('SLOW DONE'),'slow check completion or preview missing');
 const expired=new Date(Date.now()-20*86400000).toISOString();store.db.prepare('UPDATE reports SET created_at=? WHERE request_id=?').run(expired,ids[0]);store.db.prepare('UPDATE artifacts SET retention_until=? WHERE request_id=?').run(expired,ids[0]);fs.mkdirSync(path.join(home,'work/caches',ids[0],'mod'),{recursive:true});fs.writeFileSync(path.join(home,'work/caches',ids[0],'mod/go.mod'),'');fs.chmodSync(path.join(home,'work/caches',ids[0],'mod'),0o555);const sweep=ws.cleanupExpired();assert(ws.cleanupExpired()===sweep,'second cleanup started while one was in flight');const swept=await sweep;assert(swept.workspaces_removed===1&&swept.artifacts_removed>=1&&swept.errors===0&&!swept.pressure,`cleanup summary ${JSON.stringify(swept)}`);const again=ws.cleanupExpired();assert(again!==sweep,'finished cleanup run was not released');assert((await again).workspaces_removed===0,'second sweep found work the first one left');assert(!fs.existsSync(path.join(home,'work/caches',ids[0])),'expired dependency cache retained');assert(!fs.existsSync(path.join(home,'work/worktrees',ids[0]))&&!store.db.prepare('SELECT 1 FROM workspaces WHERE request_id=?').get(ids[0]),'expired workspace retained');assert(!fs.existsSync(path.join(home,'work/artifacts',globalArt)),'expired artifact retained');
 // Review mode: implementation scope + review flag reads head_sha, rejects apply_patch, still runs checks and finishes.
 {const rid=`req_${randomUUID()}`,ra={schema_version:1,request_id:rid,brief:'review',inputs:[{github_repo:'example-owner/fixture',base_sha:checkBase,head_sha:head}],expected_output:'finding',execution_scope:'implementation'};
 store.submit(ra,'thread','environment','owner',true);
 assert(store.get(rid).review===true,'review flag not stored');
 let conflicted=false;try{store.submit(ra,'thread','environment','owner',false);}catch(e){conflicted=e.message==='request_id conflict';}assert(conflicted,'duplicate submit without review must conflict');
 assert(store.submit(ra,'thread','environment','owner',true).duplicate===true,'same-flag retry must be a duplicate');
 const rc=store.claim(rid,'dot','subject',99).claim_id;
 assert(ws.read(rid,rc,'subject','hello.txt').text==='reviewed\n','review mode must read head_sha');
 let rejected;try{ws.apply(rid,rc,'subject',patch);}catch(e){rejected=e.message;}assert(rejected&&JSON.parse(rejected).error==='review_mode_read_only','apply_patch must be rejected with a structured error');
 const rcheck=await ws.check(rid,rc,'subject','default');assert(rcheck.exit_code===0,'run_check must work in review mode');
 assert(ws.result(rid,rc,'subject').head_sha===head,'workspace_result reports head_sha');
 store.finish(rid,rc,'completed','reviewed','no findings','subject',ws.snapshot(rid,rc,'subject'));assert(store.get(rid).status==='finished','review finish must not be blocked by diff state');
 const plain=`req_${randomUUID()}`;store.submit({...ra,request_id:plain},'thread','environment','owner');assert(store.get(plain).review===false,'non-review default');
 const pc=store.claim(plain,'dot','subject',99).claim_id;assert(ws.read(plain,pc,'subject','hello.txt').text!=='reviewed\n','non-review implementation scope keeps checking out base_sha');}
 // Closed workspaces answer with a scoped, specific code; a second active assignment keeps working in the same session.
 {const code=fn=>{try{fn();}catch(e){try{return {...JSON.parse(e.message),raw:e.message};}catch{return {error:null,message:e.message,raw:e.message};}}return null;};
 const mk=()=>{const rid=`req_${randomUUID()}`;store.submit({schema_version:1,request_id:rid,brief:'scoped errors',inputs:[{github_repo:'example-owner/fixture',base_sha:checkBase,head_sha:head}],expected_output:'x',execution_scope:'implementation'},'thread','environment','owner');const claim=store.claim(rid,'dot','subject',99);return {rid,rc:claim.claim_id,guidance:claim.guidance};};
 const old=mk(),live=mk(),gone=mk();
 const up=(a,id,off,data,fin,sha)=>ws.chunk(a.rid,a.rc,'subject',id,off,data,fin,sha);
 const artId='art_scopedchunk01';
 const bad=(args,re,label)=>{const e=code(()=>up(live,...args));assert(e&&e.error===null&&re.test(e.message),`${label}: ${e?.message}`);};
 bad(['bad',0,'aGk='],/invalid artifact_id/,'bad id');bad([artId,-1,'aGk='],/invalid offset/,'bad offset');bad([artId,0,7],/invalid data_base64: must be a string/,'non-string data');bad([artId,0,'aGk=\n'],/standard padded base64 .*line breaks/,'bad base64');
 assert(/^final chunk needs sha256/.test(code(()=>up(live,artId,0,'aGk=',true)).message),'missing sha256 message');
 const hi=createHash('sha256').update('hi').digest('hex');assert(up(live,artId,2,'',true,hi.toUpperCase()).sealed===true,'upper-case sha256 accepted');
 store.finish(old.rid,old.rc,'completed','done','ok','subject',ws.snapshot(old.rid,old.rc,'subject'));
 for(const [label,fn] of [['result',()=>ws.result(old.rid,old.rc,'subject')],['read',()=>ws.read(old.rid,old.rc,'subject','hello.txt')],['chunk',()=>up(old,'art_afterfinish01',0,'aGk=')]]) {const e=code(fn);assert(e&&e.error==='assignment_finished'&&e.message.includes(old.rid)&&!e.message.includes(live.rid)&&/only/.test(e.message)&&!/revoked/.test(e.raw),`finished ${label}: ${e?.raw}`);}
 assert(ws.read(live.rid,live.rc,'subject','hello.txt').text,'second active assignment read_file must still work');
 store.cancel(gone.rid,'owner changed their mind');
 const c=code(()=>ws.result(gone.rid,gone.rc,'subject'));assert(c&&c.error==='assignment_cancelled'&&c.message.includes(gone.rid)&&/cancelled_reason/.test(c.message),'cancelled code: '+c?.raw);
 const e2=code(()=>ws.read(live.rid,live.rc,'subject','hello.txt'));assert(e2===null,'live assignment unaffected by cancel of another');
 const g=mk().guidance;assert(/does not affect another/.test(g)&&/separate, fresh owner request/.test(g)&&/never retry or rephrase/.test(g),'claim guidance: '+g);}
 // A read-only review of a local patch: the workspace applies input_patch; scope_excluded files stay denied inside scope '.'.
 {const old=run('git',['show',`${checkBase}:hello.txt`],repo);
 const p=`diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-${old}\n+patched under review /changed/\n`;
 const rid=`req_${randomUUID()}`;store.submit({schema_version:1,request_id:rid,brief:'review the local patch',inputs:[{github_repo:'example-owner/fixture',base_sha:checkBase,input_patch:p}],expected_output:'findings',execution_scope:'read-only',scope_paths:['.'],scope_excluded:[{path:'package.json',reason:'test'}]},'thread','environment','owner');
 const rc=store.claim(rid,'dot','subject',99).claim_id;
 assert(ws.read(rid,rc,'subject','hello.txt').text==='patched under review /changed/\n','read-only review must read the patched tree');
 assert(ws.result(rid,rc,'subject').diff_preview.includes('+patched under review'),'workspace_result must show the patch');
 let denied;try{ws.read(rid,rc,'subject','package.json');}catch(e){denied=e.message;}assert(/outside scope_paths/.test(denied??''),'scope_excluded file readable: '+denied);
 assert(!ws.list(rid,rc,'subject').files.includes('package.json')&&ws.list(rid,rc,'subject').files.includes('hello.txt'),'scope_excluded file listed');
 let refused;try{ws.apply(rid,rc,'subject',p);}catch(e){refused=e.message;}assert(JSON.parse(refused).error==='read_only_assignment'&&refused.includes(rid)&&/read-only/.test(refused),'read-only review applied a patch: '+refused);
 // content gates what names no longer do: a secret value is redacted before it is served, never the whole file refused
 const token=`ghp_${'A'.repeat(36)}`;
 fs.writeFileSync(path.join(home,'work','worktrees',rid,'leak.ts'),`export const k = "${token}";\n`);
 const got=ws.read(rid,rc,'subject','leak.ts');assert(!got.text.includes('ghp_')&&got.text.includes('[redacted secret]')&&got.redacted===1,'secret not redacted: '+JSON.stringify(got));
 assert(got.end_line===2&&!got.truncated,'redacted short read metadata');
 // a secret that straddles the 32 KiB cut leaves no fragment
 fs.writeFileSync(path.join(home,'work','worktrees',rid,'leak.ts'),`${'x'.repeat(32759)} ${token}\n`);
 const cut=ws.read(rid,rc,'subject','leak.ts');assert(!/ghp_|AAAA/.test(cut.text)&&cut.redacted===1,'secret fragment at the byte cut: '+cut.text.slice(32700));
 assert(cut.end_line===1&&cut.truncated&&Buffer.byteLength(cut.text)<=32768,'redacted byte cut metadata');
 // a secret on a line outside the window is not served and not counted in the text; a clean file has no redacted field
 fs.writeFileSync(path.join(home,'work','worktrees',rid,'leak.ts'),`a\nb "${token}"\nc\n`);
 const win=ws.read(rid,rc,'subject','leak.ts',3,5);assert(win.text==='c\n'&&win.redacted===1&&win.total_lines===4,'window read: '+JSON.stringify(win));
 assert(win.end_line===4&&!win.truncated,'redacted window metadata');
 fs.writeFileSync(path.join(home,'work','worktrees',rid,'leak.ts'),'plain\n');assert(ws.read(rid,rc,'subject','leak.ts').redacted===undefined,'redacted set on a clean file');}
console.log('PASS T8/T13–T16 worktrees, path denial, confined checks, artifacts, cancellation');store.db.close();
}finally{if(hostListener)await new Promise(resolve=>hostListener.close(resolve));fs.rmSync(home,{recursive:true,force:true});}
