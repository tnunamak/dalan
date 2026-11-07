#!/usr/bin/env node
// Workspace list/read/apply must honour an assignment's scope_paths (V01). Assignments without scope_paths,
// or with the repo-wide scope ".", keep unrestricted access.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-bridge-scope-'));process.env.HOME=home;process.env.DOT_BRIDGE_WORKSPACE_ROOT=path.join(home,'work');
const {Store}=await import('../src/store.mjs'),{Workspace}=await import('../src/workspace.mjs'),{prepareGithubRepo}=await import('../src/projects.mjs');
const run=(cmd,args,cwd)=>{const x=spawnSync(cmd,args,{cwd,encoding:'utf8'});if(x.status!==0)throw new Error(x.stderr||x.stdout);return x.stdout.trim();};
const assert=(x,m)=>{if(!x)throw new Error(m);};
const denied=(fn,label)=>{try{fn();}catch(e){assert(/outside scope_paths/.test(e.message),`${label}: wrong error ${e.message}`);return;}throw new Error(`${label}: out-of-scope access accepted`);};
try {
 const repo=path.join(home,'repo');fs.mkdirSync(repo);run('git',['init','-q'],repo);run('git',['config','user.email','test@example.com'],repo);run('git',['config','user.name','Test'],repo);
 for(const [file,text] of [['allowed.txt','ok\n'],['src/a.txt','a\n'],['srcother/b.txt','b\n'],['private/outside.txt','secret\n'],['other.txt','other\n'],['retired/keep.txt','keep\n']]) {fs.mkdirSync(path.dirname(path.join(repo,file)),{recursive:true});fs.writeFileSync(path.join(repo,file),text);}
 run('git',['add','.'],repo);run('git',['commit','-qm','base'],repo);const base=run('git',['rev-parse','HEAD'],repo);run('git',['rm','-q','-r','retired'],repo);run('git',['commit','-qm','retire dir'],repo);const retiredHead=run('git',['rev-parse','HEAD'],repo);run('git',['checkout','-q',base],repo);
 process.env.DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE=repo;
 const store=new Store(path.join(home,'db.sqlite')),ws=new Workspace(store);
 const open=(scope_paths)=>{const id=`req_${randomUUID()}`,assignment={schema_version:1,request_id:id,brief:'fixture',inputs:[{github_repo:'example-owner/fixture',base_sha:base}],expected_output:'patch',execution_scope:'implementation'};if(scope_paths!==undefined)assignment.scope_paths=scope_paths;store.submit(assignment,'thread','environment','owner');return [id,store.claim(id,'dot','subject',10).claim_id];};
 const edit=(file,from,to)=>`diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${from}\n+${to}\n`;

 const [id,claim]=open(['allowed.txt','src']);
 assert(ws.read(id,claim,'subject','allowed.txt').text==='ok\n','in-scope file read');
 assert(ws.read(id,claim,'subject','src/a.txt').text==='a\n','file under an in-scope directory read');
 denied(()=>ws.read(id,claim,'subject','private/outside.txt'),'read');
 denied(()=>ws.read(id,claim,'subject','srcother/b.txt'),'read of a sibling that only shares a name prefix');
 const root=ws.list(id,claim,'subject').files;
 assert(root.includes('allowed.txt')&&root.includes('src/a.txt'),'root list keeps in-scope files');
 assert(!root.includes('private/outside.txt')&&!root.includes('srcother/b.txt')&&!root.includes('other.txt'),'root list leaks out-of-scope files');
 denied(()=>ws.list(id,claim,'subject','private'),'list');
 assert(ws.list(id,claim,'subject','src').files.join()==='src/a.txt','list of an in-scope directory');
 denied(()=>ws.apply(id,claim,'subject',edit('private/outside.txt','secret','changed')),'apply');
 assert(fs.readFileSync(path.join(home,'work/worktrees',id,'private/outside.txt'),'utf8')==='secret\n','rejected patch must not touch the tree');
 denied(()=>ws.apply(id,claim,'subject',edit('allowed.txt','ok','fine')+edit('private/outside.txt','secret','changed')),'apply mixing in-scope and out-of-scope files');
 assert(fs.readFileSync(path.join(home,'work/worktrees',id,'allowed.txt'),'utf8')==='ok\n','a patch with one out-of-scope file must apply nothing');
 assert(ws.apply(id,claim,'subject',edit('allowed.txt','ok','fine')).files.join()==='allowed.txt','in-scope patch');

 // An allowed descendant does not authorize a regular file at its ancestor path.
 const [ancestorId,ancestorClaim]=open(['allowed.txt/child.txt']);
 assert(ws.list(ancestorId,ancestorClaim,'subject','allowed.txt').files.length===0,'listing a file ancestor must not reveal an out-of-scope file');
 assert(ws.list(ancestorId,ancestorClaim,'subject').files.length===0,'root list must hide a file ancestor of scope');

 for(const [label,scope] of [['no scope_paths',undefined],['empty scope_paths',[]],['repo-wide scope',['.']]]) {
  const [rid,rclaim]=open(scope);
  assert(ws.read(rid,rclaim,'subject','private/outside.txt').text==='secret\n',`${label}: read`);
  assert(ws.list(rid,rclaim,'subject').files.includes('private/outside.txt'),`${label}: list`);
  assert(ws.apply(rid,rclaim,'subject',edit('private/outside.txt','secret','changed')).files[0]==='private/outside.txt',`${label}: apply`);
 }

 // output_paths (docs/usage.md "Creating new files"): declared NEW files, writable and readable, in implementation and read-only scope.
 const openWith=(extra)=>{const id=`req_${randomUUID()}`,assignment={schema_version:1,request_id:id,brief:'fixture',inputs:[{github_repo:'example-owner/fixture',base_sha:base}],expected_output:'patch',...extra};store.submit(assignment,'thread','environment','owner');return [id,store.claim(id,'dot','subject',50).claim_id];};
 const create=(file,text)=>`diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+${text}\n`;
 const codeOf=(fn)=>{try{fn();}catch(e){try{return JSON.parse(e.message).error;}catch{return e.message;}}return null;};
 {
  // An exact output file never grants its descendants, in either execution scope.
  const output='reports/example-analysis.md';
  for(const execution_scope of ['implementation','read-only']) {
   const [oid,oc]=openWith({execution_scope,scope_paths:['allowed.txt'],output_paths:[output,'src/new-report.md']});
   const wt=path.join(home,'work/worktrees',oid),nested=`${output}/nested/report.md`;
   let message='';
   try {ws.apply(oid,oc,'subject',create('src/new-report.md','report')+create(nested,'findings'));}catch(e){message=e.message;}
   assert(/List each new file in output_paths/.test(message),`${execution_scope}: actionable directory-output refusal: ${message}`);
   assert(message.includes(output)&&message.includes(nested),`${execution_scope}: refusal names the declared file and refused descendant`);
   assert(!fs.existsSync(path.join(wt,output))&&!fs.existsSync(path.join(wt,'src/new-report.md')),`${execution_scope}: mixed patch must apply nothing`);
   denied(()=>ws.read(oid,oc,'subject',nested),`${execution_scope}: nested output read`);
   denied(()=>ws.list(oid,oc,'subject',`${output}/nested`),`${execution_scope}: nested output list`);
   assert(ws.apply(oid,oc,'subject',create('src/new-report.md','report')).files[0]==='src/new-report.md','declared file in an existing directory');
   const outside=codeOf(()=>ws.apply(oid,oc,'subject',create('private/new.md','x')));
   assert(/outside scope_paths|read_only_assignment/.test(outside??''),'outside both lists stays refused');
   assert(!fs.existsSync(path.join(wt,'private/new.md')),'outside file not written');
   const sibling=codeOf(()=>ws.apply(oid,oc,'subject',create(`${output}-sibling/report.md`,'x')));
   assert(/outside scope_paths|read_only_assignment/.test(sibling??''),'sibling sharing a prefix stays refused');
   assert(ws.apply(oid,oc,'subject',create(output,'extensionless exact file')).files[0]===output,'extensionless exact output stays supported');
   assert(ws.read(oid,oc,'subject',output).text==='extensionless exact file\n','extensionless exact output is readable');
   const listed=ws.list(oid,oc,'subject').files;
   assert(listed.includes(output)&&!listed.includes('private/outside.txt'),'listing preserves exact output and read scope');
  }
 }
 {
  // implementation: a new file outside scope_paths is created only when declared; undeclared stays refused
  const [iid,ic]=openWith({execution_scope:'implementation',scope_paths:['allowed.txt'],output_paths:['docs/new/report.md']});
  denied(()=>ws.apply(iid,ic,'subject',create('docs/new/other.md','x')),'undeclared new file');
  assert(ws.apply(iid,ic,'subject',create('docs/new/report.md','hello')).files.join()==='docs/new/report.md','declared new file created');
  assert(ws.read(iid,ic,'subject','docs/new/report.md').text==='hello\n','created output file readable');
  assert(ws.list(iid,ic,'subject').files.includes('docs/new/report.md'),'created output file listed');
  assert(ws.apply(iid,ic,'subject',`diff --git a/docs/new/report.md b/docs/new/report.md\n--- a/docs/new/report.md\n+++ b/docs/new/report.md\n@@ -1 +1 @@\n-hello\n+hello again\n`).files.length===1,'output file editable after creation');
  assert(/patch rejected/.test(codeOf(()=>ws.apply(iid,ic,'subject',create('docs/new/report.md','again')))??''),'creating an existing output file is a plain git rejection');
  assert(ws.result(iid,ic,'subject').diff_preview.includes('docs/new/report.md'),'implementation diff shows the new file');
 }
{
  // A new file under a build-output directory name (node_modules, .venv, target, __pycache__) would be dropped from the patch
  // without an error, so apply_patch refuses it with generated_path. Other new files in scope still apply.
  const [gid,gc]=openWith({execution_scope:'implementation',scope_paths:['src']});
  assert(codeOf(()=>ws.apply(gid,gc,'subject',create('src/target/t.js','x')))==='generated_path','new file under target/ is refused with generated_path');
  assert(codeOf(()=>ws.apply(gid,gc,'subject',create('src/__pycache__/m.pyc','x')))==='generated_path','new file under __pycache__/ is refused with generated_path');
  assert(!fs.existsSync(path.join(home,'work/worktrees',gid,'src/target/t.js')),'refused generated-path file must not be written');
  assert(ws.apply(gid,gc,'subject',create('src/app.js','app')).files.join()==='src/app.js','new file outside generated dirs still applies');
  assert(ws.result(gid,gc,'subject').diff_preview.includes('src/app.js'),'the new source file is in the result patch');
}
 {
  // read-only: only output_paths are writable; anything else keeps read_only_assignment and applies nothing
  const [rid,rc]=openWith({execution_scope:'read-only',scope_paths:['allowed.txt','src'],output_paths:['notes/research.md','notes/extra.md']});
  assert(codeOf(()=>ws.apply(rid,rc,'subject',edit('allowed.txt','ok','changed')))==='read_only_assignment','modifying a scope file is refused');
  assert(codeOf(()=>ws.apply(rid,rc,'subject',create('notes/other.md','x')))==='read_only_assignment','undeclared new file is refused');
  assert(codeOf(()=>ws.apply(rid,rc,'subject',create('notes/research.md','x')+edit('allowed.txt','ok','changed')))==='read_only_assignment','a patch with one non-output file applies nothing');
  assert(!fs.existsSync(path.join(home,'work/worktrees',rid,'notes/research.md')),'refused mixed patch must not create the output file');
  assert(ws.apply(rid,rc,'subject',create('notes/research.md','findings')).files.join()==='notes/research.md','output file created in read-only scope');
  assert(ws.read(rid,rc,'subject','notes/research.md').text==='findings\n','output file readable');
  const result=ws.result(rid,rc,'subject');
  assert(result.diff_preview.includes('notes/research.md')&&!result.diff_preview.includes('allowed.txt'),'read-only diff carries the output file');
  // an exact changed-file set: anything outside output_paths (modified, untracked, deleted) refuses result and finish, never rides along
  const wt=path.join(home,'work/worktrees',rid);
  const violation=(fn,label)=>{let m=null;try{fn();}catch(e){m=e.message;}assert(/^output_paths_violation:/.test(m??''),`${label}: ${m}`);return m;};
  fs.writeFileSync(path.join(wt,'allowed.txt'),'tampered\n');
  assert(/allowed\.txt/.test(violation(()=>ws.result(rid,rc,'subject'),'modified non-output')),'violation names the file');
  violation(()=>ws.snapshot(rid,rc,'subject'),'snapshot with a modified non-output');
  fs.writeFileSync(path.join(wt,'allowed.txt'),'ok\n');
  fs.writeFileSync(path.join(wt,'scratch.txt'),'scratch\n');
  violation(()=>ws.result(rid,rc,'subject'),'untracked non-output');
  fs.rmSync(path.join(wt,'scratch.txt'));
  fs.rmSync(path.join(wt,'src/a.txt'));
  violation(()=>ws.result(rid,rc,'subject'),'deleted non-output');
  run('git',['checkout','--','src/a.txt'],wt);
  fs.rmSync(path.join(wt,'notes/extra.md'),{force:true});
  fs.symlinkSync('/etc/hostname',path.join(wt,'notes/extra.md'));
  violation(()=>ws.result(rid,rc,'subject'),'symlink at an output path');
  fs.rmSync(path.join(wt,'notes/extra.md'));
  const snap=ws.snapshot(rid,rc,'subject'),patch=ws.artifact(snap.patch_artifact.artifact_id,rid).bytes.toString();
  assert(/diff --git a\/notes\/research.md/.test(patch)&&!/allowed\.txt|scratch\.txt/.test(patch),'patch artifact holds only output files: '+patch.slice(0,200));
  // patch-gate shapes: whole patch refused, nothing applied
  const [gid,gc]=openWith({execution_scope:'read-only',scope_paths:['allowed.txt','src','retired'],output_paths:['retired','notes/a.md']});
  const del=f=>`diff --git a/${f} b/${f}\ndeleted file mode 100644\n--- a/${f}\n+++ /dev/null\n@@ -1 +0,0 @@\n-keep\n`;
  const gt=path.join(home,'work/worktrees',gid);
  for(const [label,patch] of [
   ['directory-to-file: create output + delete descendant',create('retired','x')+del('retired/keep.txt')],
   ['delete a non-output',del('retired/keep.txt')],
   ['rename into an output',`diff --git a/allowed.txt b/notes/a.md\nsimilarity index 100%\nrename from allowed.txt\nrename to notes/a.md\n`],
   ['rename out of an output',`diff --git a/notes/a.md b/allowed.txt\nsimilarity index 100%\nrename from notes/a.md\nrename to allowed.txt\n`],
   ['mode change of a non-output',`diff --git a/allowed.txt b/allowed.txt\nold mode 100644\nnew mode 100755\n`],
   ['symlink output',`diff --git a/notes/a.md b/notes/a.md\nnew file mode 120000\n--- /dev/null\n+++ b/notes/a.md\n@@ -0,0 +1 @@\n+/etc/hostname\n\\ No newline at end of file\n`],
   ['leading ./',create('./notes/a.md','x')],
   ['double slash',create('notes//a.md','x')],
   ['trailing slash',create('notes/a.md/','x')],
   ['case variant',create('Notes/a.md','x')],
   ['output plus non-output',create('notes/a.md','x')+edit('allowed.txt','ok','changed')],
  ]) {
   const e=codeOf(()=>ws.apply(gid,gc,'subject',patch));
   assert(e!==null&&e!=='read_only_assignment'?/symlink|invalid|mismatch|unsupported|renames/.test(e):e==='read_only_assignment',`${label}: ${e}`);
   assert(!fs.existsSync(path.join(gt,'notes/a.md'))&&fs.readFileSync(path.join(gt,'retired/keep.txt'),'utf8')==='keep\n'&&fs.readFileSync(path.join(gt,'allowed.txt'),'utf8')==='ok\n',`${label}: patch must apply nothing`);
  }
  // a mode-only change of a created output file is inside the exact set, and a deleted output leaves no trace
  assert(ws.apply(gid,gc,'subject',create('notes/a.md','x')).files.join()==='notes/a.md','output create');
  assert(ws.apply(gid,gc,'subject',`diff --git a/notes/a.md b/notes/a.md\nold mode 100644\nnew mode 100755\n`).files.join()==='notes/a.md','mode change of an output');
  // directory at head deleted: output 'retired' is a valid file path there, and the exact set stays clean
  fs.mkdirSync(path.join(home,'work'),{recursive:true});
 prepareGithubRepo({github_repo:'example-owner/fixture',base_sha:base,head_sha:retiredHead},{worker:'dot'});
 const [hid,hc]=openWith({execution_scope:'read-only',scope_paths:['allowed.txt'],output_paths:['retired'],inputs:[{github_repo:'example-owner/fixture',base_sha:base,head_sha:retiredHead}]});
  assert(ws.apply(hid,hc,'subject',create('retired','file now')).files.join()==='retired','create the file where the directory was');
  const hr=ws.result(hid,hc,'subject');
  assert(hr.diff_preview.includes('diff --git a/retired b/retired')&&!hr.diff_preview.includes('retired/keep.txt'),'head deleted the directory: the job diff holds only the output file');
  // an output path that already exists at the pinned revision is refused by the workspace, even when submit was bypassed; the file stays unchanged
  {
   const [xid,xc]=openWith({execution_scope:'read-only',scope_paths:['src'],output_paths:['src/a.txt']});
   const xe=codeOf(()=>ws.apply(xid,xc,'subject',edit('src/a.txt','a','changed')));
   assert(xe==='output_path_exists',`existing output edit: ${xe}`);
   let xm='';try{ws.apply(xid,xc,'subject',edit('src/a.txt','a','changed'));}catch(e){xm=e.message;}
   assert(/src\/a\.txt/.test(xm),'output_path_exists names the path: '+xm);
   assert(fs.readFileSync(path.join(home,'work/worktrees',xid,'src/a.txt'),'utf8')==='a\n','refused edit must leave the existing file unchanged');
   assert(codeOf(()=>ws.apply(xid,xc,'subject',create('src/a.txt','x')))==='output_path_exists','existing output create-over is refused by the workspace, not git');
   assert(fs.readFileSync(path.join(home,'work/worktrees',xid,'src/a.txt'),'utf8')==='a\n','refused create-over must leave the file unchanged');
  }
  {
   // a file the job itself created (absent at HEAD) stays editable by a later apply in read-only scope
   const [oid,oc]=openWith({execution_scope:'read-only',scope_paths:['allowed.txt'],output_paths:['notes/own.md']});
   assert(ws.apply(oid,oc,'subject',create('notes/own.md','first')).files.join()==='notes/own.md','read-only output created');
   assert(ws.apply(oid,oc,'subject',`diff --git a/notes/own.md b/notes/own.md\n--- a/notes/own.md\n+++ b/notes/own.md\n@@ -1 +1 @@\n-first\n+second\n`).files.join()==='notes/own.md','a second apply may edit the job-created output');
   assert(ws.read(oid,oc,'subject','notes/own.md').text==='second\n','job-created output holds the second edit');
  }
  // a read-only assignment without output_paths still refuses every write
  const [pid,pc]=openWith({execution_scope:'read-only',scope_paths:['allowed.txt']});
  assert(codeOf(()=>ws.apply(pid,pc,'subject',create('notes/x.md','x')))==='read_only_assignment','no output_paths: read-only');
  // run_check stays closed to read-only work even with output_paths
  let checkError=null;try{await ws.check(rid,rc,'subject','default');}catch(e){checkError=e.message;}
  assert(/read_only_assignment/.test(checkError??''),'run_check on read-only with output_paths: '+checkError);
 }
 console.log('PASS workspace list/read/apply honour scope_paths and output_paths');
} finally { fs.rmSync(home,{recursive:true,force:true}); }
