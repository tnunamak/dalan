import { workspaceRoot } from './paths.mjs';
import { readEnv } from './env.mjs';
import {gitEnv} from './git-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { checkOutcome } from './lifecycle.mjs';
import { checkResponse } from './check-response.mjs';
import { secretContent, isSensitiveRepoPath, isSourceExemptionPath, sensitivePolicyPaths } from './submission-policy.mjs';
import { argvTestFiles, assignmentInput, prepareGithubRepo, detectCheck, detectCheckWithOrigin, availableChecks, workspaceCheck, mirrorPath, withCheckMetadata, checkSpecsAt } from './projects.mjs';
import { hostBackend, hostReadiness, capabilityNotAvailable, TRUST, withEvidence } from './execution.mjs';
import { redactSecrets, redactOutput, privateKeyHeader } from './redaction.mjs';
import { hostCheckRefusal, hostCheckAuthorization } from './host-execution-policy.mjs';
import { ownerReportArtifactBytes } from './owner-report-artifact.mjs';
import { withCheckCoverage } from './check-coverage.mjs';
import { runHostBudget, parseHostBudget } from './host-budget.mjs';
import { readVerifiedHostStop, sealHostNotStarted } from './host-budget-receipts.mjs';
import { reverifyHostStop } from './host-stop-reverify.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const root=workspaceRoot();
const WORKSPACE_RETENTION_MS=6*3600000;
// Cleanup runs inside the live server, so every step is an awaited child process or fs.promises call:
// Synchronous cleanup can block restarts and periodic work; use asynchronous operations.
// What a check ran: its declared test_paths, else the test files its argv names.
const declaredOrNamedTestPaths=spec=>spec.test_paths??argvTestFiles(spec.argv);
// First declared (not detected) test path absent from the checkout, or null. A path that resolves outside the checkout counts as absent.
function missingDeclaredTestPath(dir,spec,origin) {
  if(origin?.from!=='owner_config'&&origin?.from!=='workspace_file') return null;
  let root;try{root=fs.realpathSync(dir);}catch{return null;}
  for(const p of spec.test_paths??[]) {
    if(p==='./...') continue;
    try{const real=fs.realpathSync(path.join(root,p));if(real===root||real.startsWith(root+path.sep)) continue;}catch{}
    return p;
  }
  return null;
}
const yieldLoop=()=>new Promise(resolve=>setImmediate(resolve));
function spawnAsync(cmd,args,timeout=60000,env=process.env) { return new Promise(resolve=>{ let stderr='';const child=spawn(cmd,args,{stdio:['ignore','ignore','pipe'],timeout,env});child.stderr.on('data',b=>{if(stderr.length<300)stderr+=b;});child.on('error',error=>resolve({status:null,stderr:error.message}));child.on('close',status=>resolve({status,stderr})); }); }
async function gitAsync(args) { const r=await spawnAsync('git',args,10000,gitEnv()); if(r.status!==0) throw new Error(`git failed: ${r.stderr.slice(0,300)}`); }
// Go and uv write their module caches read-only, so make the tree writable before removing it.
// A cache left behind costs disk space only, so a failure must not stop the rest of the cleanup.
async function removeCache(dir) {
  if(!fs.existsSync(dir)) return;
  await spawnAsync('chmod',['-R','u+w',dir]);
  try{await fs.promises.rm(dir,{recursive:true,force:true});}catch(error){console.error(`cache cleanup failed for ${dir}: ${error.message}`);}
}
const MIN_FREE_BYTES_DEFAULT=30*2**30, IDLE_CACHE_MS=7*86400000, MIRROR_IDLE_MS=7*86400000, mirrors=path.join(root,'mirrors');
export function savedWorkspaceMirror(workspaceDir,requestId) {
  try {
    const pointer=fs.readFileSync(path.join(workspaceDir,'.git'),'utf8').trim();
    if(!pointer.startsWith('gitdir: ')) return null;
    const gitdir=path.resolve(workspaceDir,pointer.slice(8));
    if(path.basename(gitdir)!==requestId||path.basename(path.dirname(gitdir))!=='worktrees') return null;
    const common=path.dirname(path.dirname(gitdir));
    if(!fs.statSync(common).isDirectory()) return null;
    const actual=fs.realpathSync(common),allowed=fs.realpathSync(mirrors);
    return actual.startsWith(allowed+path.sep)?actual:null;
  } catch { return null; }
}
const minFreeBytes=()=>Number(readEnv('DALAN_MIN_FREE_BYTES')??MIN_FREE_BYTES_DEFAULT);
// Last-use clocks are file mtimes (no schema); touched at most once a minute.
function touch(file) { try { const t=new Date();if(t-fs.statSync(file).mtime<60000) return;fs.utimesSync(file,t,t); } catch { try{fs.closeSync(fs.openSync(file,'a'));}catch{} } }
// Remove a directory that a concurrent check or submit may want next: the rename is atomic and sync, so no one can start using it after
// the caller decided it was idle, and the slow delete runs on the tombstone.
async function evictDir(dir) { const tomb=`${dir}.evicting-${randomUUID().slice(0,8)}`;fs.renameSync(dir,tomb);await removeCache(tomb); }
// The npm content store can contain attacker-controlled bytes. Partition it by worker and hash the exact repo identity so workers
// and distinct repo strings never share writable cache state. Only _cacache is shared within that boundary.
const repoCacheKey=repo=>typeof repo!=='string'||!repo?null:`r-${sha(repo)}`;
const workerCacheKey=worker=>`w-${sha(String(worker))}`;
const npmCacheKey=(worker,repo)=>{const repoKey=repoCacheKey(repo);return repoKey?`${workerCacheKey(worker)}-${repoKey}`:null;};
const payloadRepo=payload=>{try{return JSON.parse(payload).inputs?.[0]?.github_repo;}catch{return undefined;}};
const worktrees=path.join(root,'worktrees'), artifacts=path.join(root,'artifacts'), caches=path.join(root,'caches'), sharedNpm=path.join(caches,'shared','npm');
// Scoped, calm errors for a workspace that is closed to this claim. Each names the request and says only that request is affected.
// Callers match `error`, not the prose. Same JSON-in-message shape as review_mode_read_only.
const coded=(error,message)=>new Error(JSON.stringify({error,message}));
function closedWorkspace(a,requestId,claimId,claimEpoch,currentEpoch) {
  if(a.status==='finished') return coded('assignment_finished',`assignment ${requestId} is finished; its workspace closed when it finished. This affects only ${requestId}; your other assignments are unchanged.`);
  if(a.cancelled_at||a.status==='cancelled') return coded('assignment_cancelled',`assignment ${requestId} was cancelled${a.cancelled_reason?` (cancelled_reason: ${a.cancelled_reason})`:''}; its workspace is closed. This affects only ${requestId}; your other assignments are unchanged.`);
  if(a.status==='claimed'&&claimEpoch!==undefined&&currentEpoch!==undefined&&claimEpoch!==currentEpoch) return coded('claim_superseded',`claim ${claimId} for ${requestId} was superseded by epoch ${currentEpoch}; stop using this claim. This affects only ${requestId}.`);
  return coded('assignment_not_claimed',`assignment ${requestId} is not claimed (status ${a.status}); its workspace is not open. This affects only ${requestId}.`);
}
function git(args,opts={}) { const r=spawnSync('git',args,{encoding:'utf8',timeout:10000,maxBuffer:12*1024*1024,...opts,env:gitEnv(opts.env)}); if(r.error||r.status!==0) throw new Error(`git failed: ${(r.stderr||r.error?.message||'').slice(0,300)}`); return r.stdout; }
function relative(p,allowDot=false) { if (allowDot && (p===undefined||p==='')) return ''; if(typeof p!=='string'||!p||Buffer.byteLength(p)>1024||p.includes('\0')||path.isAbsolute(p)||p.split('/').some(x=>!x||x==='.'||x==='..'||x==='.git'||x.includes('\\'))) throw new Error('invalid project-relative path'); return p; }
function safePath(dir,p,existing=false) { p=relative(p); let cursor=dir; for(const part of p.split('/')) { cursor=path.join(cursor,part); try { if(fs.lstatSync(cursor).isSymbolicLink()) throw new Error('symlink traversal denied'); } catch(e) { if(e.code!=='ENOENT') throw e; if(existing) throw new Error('file not found'); } } return cursor; }
// scope_paths is the assignment's read/write allow-list (submission-policy `within`). No scope_paths, or the repo-wide
// scope ".", means unrestricted, as before. Entries are normalised the same way submission-policy normalises them.
// scope_excluded files (sensitive files a broad --exclude-sensitive scope keeps out) are denied inside any scope.
// Exclusions compare a canonical form: Unicode NFC, then toLowerCase (not full Unicode case folding), for every path component, so a case or normalization
// alias (docs/PRIVATE-NOTE.TXT, a decomposed "é") that a case-insensitive or normalizing filesystem (macOS APFS) opens as
// the excluded file is excluded too. On case-sensitive Linux this over-excludes a differently-cased sibling: that fails closed.
export const canonicalPath=p=>p.split('/').map(part=>part.normalize('NFC').toLowerCase()).join('/');
export const isExcludedPath=(p,excluded)=>excluded.has(canonicalPath(p));
function scopeOf(assignment) {
  const raw=assignment.scope_paths, excluded=new Set((assignment.scope_excluded||[]).map(d=>canonicalPath(d.path)));
  const scope=Array.isArray(raw)&&raw.length?raw.map(p=>String(p).replace(/^\.\//,'').replace(/\/$/,'')):[];
  const paths=!scope.length||scope.includes('.')?null:scope;
  const outputs=outputsOf(assignment);
  return paths||excluded.size||outputs.size?{paths,excluded,outputs}:null;
}
// output_paths: new files the job may create. They are readable and writable once they exist, and are the only writable
// files of a read-only assignment. Submit proved they are absent at the pinned revision and not sensitive.
const outputsOf=assignment=>new Set(Array.isArray(assignment.output_paths)?assignment.output_paths:[]);
// An output path that already exists at the checkout's HEAD is an existing file, not a new one, whatever the patch does to it.
// A file the job created (absent at HEAD, present in the worktree) stays editable. `ls-tree` lists an entry for a file or
// directory named exactly `file`; any git failure throws rather than reading as "absent".
function existsAtHead(dir,file) {
  const r=spawnSync('git',['-C',dir,'ls-tree','-z','HEAD','--',file],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024,env:gitEnv()});
  if(r.error||r.status!==0) throw new Error(`git ls-tree failed: ${(r.stderr||r.error?.message||'').slice(0,200)}`);
  return r.stdout.length>0;
}
const inScope=(p,scope)=>!scope||(!scope.paths||scope.outputs.has(p)||scope.paths.some(s=>p===s||p.startsWith(`${s}/`)))&&!isExcludedPath(p,scope.excluded);
// A directory that holds a scope entry may be listed so the walk can reach it.
const leadsToScope=(p,scope)=>!scope||!scope.paths||inScope(p,scope)||scope.paths.some(s=>s.startsWith(`${p}/`))||[...scope.outputs].some(o=>o.startsWith(`${p}/`));
function outputDirectoryHint(file,outputs) {
  const parent=[...outputs].find(p=>file.startsWith(`${p}/`));
  return parent?` output_paths entry ${parent} names one new file, not a directory. List each new file in output_paths (for example ${file}); ask the owner to resubmit with the exact file paths.`:'';
}
// The on-disk spelling of `file` relative to the worktree (native realpath returns the stored case on macOS), so the
// scope and exclusion checks see the real path as well as the requested one.
function realRelative(dir,file,fallback) { try { const rel=path.relative(fs.realpathSync.native(dir),fs.realpathSync.native(file)); return rel&&!rel.startsWith('..')&&!path.isAbsolute(rel)?rel.split(path.sep).join('/'):fallback; } catch { return fallback; } }
function requireScope(p,scope) { if(!inScope(p,scope)) throw new Error(`path outside scope_paths: ${p}${outputDirectoryHint(p,scope?.outputs??[])}`); }
// Walk from `start` and stop at `max` files. Large repos used to throw 'file tree limit' on every call,
// so the worker could not list anything; now it gets the first `max` files and truncated:true.
export function guardedFiles(dir,start='',max=2000,scope=null,after='') { const out=[];let truncated=false,passed=!after; function walk(base,depth) { if(out.length>=max) { truncated=true; return; } if(depth>16) { truncated=true; return; } const entries=fs.readdirSync(path.join(dir,base),{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0); for(const ent of entries) { if(out.length>=max) { truncated=true; return; } if(ent.name==='.git') continue; const rel=base?`${base}/${ent.name}`:ent.name; if(ent.isSymbolicLink()) continue; if(ent.isDirectory()) { if(leadsToScope(rel,scope)) walk(rel,depth+1); } else if(ent.isFile()&&inScope(rel,scope)) { if(!passed) { if(rel===after) passed=true; } else out.push(rel); } } } if(start&&!fs.lstatSync(path.join(dir,start)).isDirectory()) return {files:inScope(start,scope)?[start]:[],truncated:false}; walk(start,0); if(!passed) throw new Error('cursor not found: list again from the start'); return {files:out,truncated}; }
function patchPaths(patch) {
  const found=[];let current=null,inHeader=false,oldHeader=false,newHeader=false;
  for(const line of patch.split('\n')) {
    if(line.startsWith('diff --git ')) {
      if(current&&oldHeader!==newHeader) throw new Error('incomplete patch headers');
      const match=/^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if(!match||match[1]!==match[2]||match[1].includes('"')||/[\x00-\x1f]/.test(match[1])) throw new Error('renames or quoted paths unsupported');
      current=relative(match[1]);found.push(current);inHeader=true;oldHeader=false;newHeader=false;
      continue;
    }
    if(!current) {if(line.trim()) throw new Error('patch must start with diff --git');continue;}
    if(line.startsWith('@@')||line==='GIT binary patch') inHeader=false;
    if(!inHeader&&(line.startsWith('--- ')||line.startsWith('+++ '))) throw new Error('unexpected patch header');
    if(inHeader&&line.startsWith('--- ')) {if(line!=='--- /dev/null'&&line!==`--- a/${current}`)throw new Error('patch header path mismatch');oldHeader=true;}
    if(inHeader&&line.startsWith('+++ ')) {if(line!=='+++ /dev/null'&&line!==`+++ b/${current}`)throw new Error('patch header path mismatch');newHeader=true;}
    if(/^(new file mode|old mode|new mode) (120000|160000)/.test(line)||/^(rename|copy) (from|to) /.test(line)) throw new Error('symlink, submodule or rename denied');
  }
  if(current&&oldHeader!==newHeader) throw new Error('incomplete patch headers');
  if(!found.length||found.length>200) throw new Error('invalid patch file count');
  return [...new Set(found)];
}
export function validateIntegrationPatch(dir,patch,assignment) {
  const files=patchPaths(Buffer.from(patch).toString('utf8'));
  const scope=scopeOf(assignment);
  for(const file of files) {
    requireScope(file,scope);
    safePath(dir,file);
    if(isGenerated(file)&&!existsAtHead(dir,file)) throw coded('generated_path',`${file} is a new file under a build-output directory`);
  }
  return files;
}
function applyPatchToTree(dir,patch,scope=null) {
  if(Buffer.byteLength(patch)>262144) throw new Error('patch too large');
  const files=patchPaths(patch);
  for(const p of files) requireScope(p,scope);
  for(const p of files) safePath(dir,p);
  const check=spawnSync('git',['-C',dir,'apply','--check','-'],{input:patch,encoding:'utf8',timeout:10000,env:gitEnv()});
  if(check.status!==0) throw new Error(`patch rejected: ${(check.stderr||'').slice(0,200)}`);
  const applied=spawnSync('git',['-C',dir,'apply','-'],{input:patch,encoding:'utf8',timeout:10000,env:gitEnv()});
  if(applied.status!==0) throw new Error(`patch apply failed: ${(applied.stderr||'').slice(0,200)}`);
  for(const p of files) {const f=path.join(dir,p);if(fs.existsSync(f))safePath(dir,p,true);}
  return files;
}
// Failures land at the end of test output; keep both ends within the 8 KiB preview.
function previewHeadTail(text,head=2048,tail=6144) {
  if (text.length<=head+tail) return text;
  return `${text.slice(0,head)}\n…[${text.length-head-tail} chars omitted; full output in the check artifact]…\n${text.slice(-tail)}`;
}
function maskedOutputNote(paths,output) {
  if(!paths.length) return '';
  const text=output.toLowerCase();
  const mentioned=paths.filter(file=>text.includes(file.toLowerCase())||text.includes(path.posix.basename(file).toLowerCase()));
  const ordered=[...mentioned,...paths.filter(file=>!mentioned.includes(file))],shown=[];
  let size='masked as empty: '.length;
  for(const file of ordered) {
    const next=Buffer.byteLength(file)+(shown.length?2:0);
    if(size+next>800) break;
    shown.push(file);size+=next;
  }
  const omitted=paths.length-shown.length;
  return `\nmasked as empty: ${shown.join(', ')}${omitted?`, plus ${omitted} masked path(s) listed in check evidence`:''}`;
}

// Entries a check or install leaves behind that no patch carries: dependency and build caches.
const GENERATED_DIRS=new Set(['node_modules','.venv','target','__pycache__']);
const isGenerated=file=>file.split('/').some(part=>GENERATED_DIRS.has(part));
// File names are bytes. A name that is not valid UTF-8 cannot be a JS string without loss, so it is carried as `<non-utf8 HEX "shown">`:
// reversible (nameBytes), never equal to a scope path (so never writable), and readable in evidence and errors.
const RAW_NAME=/^<non-utf8 ([0-9a-f]+) /;
const decodeName=buf=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(buf);}catch{return `<non-utf8 ${buf.toString('hex')} ${JSON.stringify(buf.toString('latin1'))}>`;}};
const nameBytes=name=>{const m=RAW_NAME.exec(name);return m?Buffer.from(m[1],'hex'):Buffer.from(name);};
const splitRaw=buf=>{const out=[];let start=0;for(let i=0;i<buf.length;i++) if(buf[i]===0){if(i>start) out.push(buf.subarray(start,i));start=i+1;}if(start<buf.length) out.push(buf.subarray(start));return out;};
const splitNames=buf=>splitRaw(buf).map(decodeName);
const absBytes=(dir,name)=>Buffer.concat([Buffer.from(dir+path.sep),nameBytes(name)]);
// An untracked file above the cap, or one that cannot be read, is left out of the diff and named in `omissions` ({path,size,reason}).
// The diff stays bounded: the cap keeps `git diff --binary` output (base85, about 1.25x) well under its 12 MiB buffer.
const UNTRACKED_FILE_CAP=8*2**20, UNTRACKED_FILE_COUNT=200, DIFF_TOTAL_CAP=24*2**20;
const DIGEST_DEADLINE_MS=120000, CHANGED_PATHS_SHOWN=100, PREVIEW_SHOWN=25, DETAIL_ARTIFACT_CAP=2**20;
// What every receipt says it does not identify. Fixed text: no counts and no walk, so there is no partial number to misread.
export const NOT_IDENTIFIED='Ignored files, generated or dependency directories (node_modules, .venv, target, __pycache__, build output), unreadable or special files, content conversions (eol and ident attributes), nested repositories and submodule paths, and anything outside git\'s view of the workspace are not identified by this receipt. A check can read and execute them.';
// Async git call for the receipt digests (the live server must not block). Always the isolated environment.
function gitAsync2(dir,args,env,timeout=120000) { if(readEnv('DALAN_TEST_GIT_VIEW')==='fail') return Promise.resolve({status:128,stdout:'',buffer:Buffer.alloc(0),stderr:'fatal: simulated git failure'}); if(readEnv('DALAN_TEST_GIT_VIEW')==='timeout') return Promise.resolve({status:null,stdout:'',buffer:Buffer.alloc(0),stderr:'timed out'}); return new Promise(resolve=>{ const out=[];let err='';const child=spawn('git',['-C',dir,...args],{stdio:['ignore','pipe','pipe'],timeout,env});child.stdout.on('data',b=>out.push(b));child.stderr.on('data',b=>{if(err.length<300)err+=b;});child.on('error',e=>resolve({status:null,stdout:'',stderr:e.message}));child.on('close',status=>{const buffer=Buffer.concat(out);resolve({status,stdout:buffer.toString('utf8'),buffer,stderr:err});}); }); }
const resolveFrom=(dir,p)=>path.isAbsolute(p)?p:path.join(dir,p);
// Dependency and build directories git is told to leave out of an `add -A`, the same ones the diff leaves out.
const GENERATED_EXCLUDES=[...GENERATED_DIRS].map(name=>`:(exclude,glob)**/${name}/**`);
// Digest of git's view of the workspace: the tracked files plus the untracked files that are not ignored, as git would commit them.
// Git computes it (a copy of the real index, `add -u` for tracked changes, `add -A` for new files, `write-tree`), with the isolated
// environment, so symlinks are stored as links and never followed, and a path behind a symlinked directory is not read. New objects go to
// `scratch`, a throw-away directory, never into the mirror. Returns the tree id, or null with a reason when git could not read everything
// (an unreadable tracked file, an unreadable untracked directory, a timeout, a skip-worktree or assume-unchanged index entry, a missing
// index): then the receipt says the observation is unavailable instead of hashing a placeholder. The whole call has a 120 s deadline.
export async function treeDigest(dir,scratch) {
  const own=!scratch;if(own) fs.mkdirSync(path.join(root,'run'),{recursive:true,mode:0o700});scratch??=fs.mkdtempSync(path.join(root,'run','digest-'));
  try {
    const base=gitEnv(),deadline=Date.now()+DIGEST_DEADLINE_MS,left=()=>Math.max(1000,deadline-Date.now());
    const at=async args=>(await gitAsync2(dir,args,base,Math.min(30000,left())));
    const common=(await at(['rev-parse','--git-common-dir'])).stdout.trim(),indexSrc=(await at(['rev-parse','--git-path','index'])).stdout.trim();
    if(!common||!indexSrc) return {sha256:null,reason:'git_view_unavailable'};
    const objects=path.join(scratch,'objects');fs.mkdirSync(objects,{recursive:true});
    const index=path.join(scratch,`index-${randomUUID()}`);
    // A missing or unreadable index must not become an empty one: every file would then look new.
    // The copy keeps the original index's mtime. Git's racy-stat rule (a file no older than the index may have changed within the same
    // clock second without its size or mtime changing) compares file times with the index time; a copy stamped "now" would hide such a change.
    try{const source=resolveFrom(dir,indexSrc);fs.copyFileSync(source,index);const st=fs.statSync(source);fs.utimesSync(index,st.atime,st.mtime);}catch(error){return {sha256:null,reason:`index_copy_failed: ${error.code||'error'}`};}
    const env={...base,GIT_INDEX_FILE:index,GIT_OBJECT_DIRECTORY:objects,GIT_ALTERNATE_OBJECT_DIRECTORIES:path.join(resolveFrom(dir,common),'objects')};
    // git reads a tracked file it cannot stat (inside a mode-000 directory, say) as deleted. A path that is absent for any reason other
    // than not existing is unreadable, not deleted: no digest is promoted from it.
    // Index flags that tell git not to look at the worktree (skip-worktree, assume-unchanged) would hide changes from `add -u`.
    const flags=await gitAsync2(dir,['ls-files','-v','-z'],env,left());
    if(flags.status!==0) return {sha256:null,reason:flags.status===null?'git_timeout_or_error':`git_could_not_read_a_file: ${flags.stderr.split('\n')[0].slice(0,160)}`};
    if(flags.stdout.split('\0').some(record=>record&&(record[0]==='S'||/[a-z]/.test(record[0])))) return {sha256:null,reason:'index_flags_present'};
    const deleted=await gitAsync2(dir,['ls-files','--deleted','-z'],env,left());
    if(deleted.status!==0) return {sha256:null,reason:deleted.status===null?'git_timeout_or_error':`git_could_not_read_a_file: ${deleted.stderr.split('\n')[0].slice(0,160)}`};
    for(const file of deleted.stdout.split('\0').filter(Boolean)) {
      try{fs.lstatSync(path.join(dir,file));}catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR') continue;return {sha256:null,reason:`unreadable_path: ${error.code||'error'}`};}
    }
    for(const args of [['add','-u','--ignore-errors'],['add','-A','--',':/',...GENERATED_EXCLUDES]]) {
      const r=await gitAsync2(dir,args,env,left());
      // git only warns about an untracked directory it cannot open and exits 0: that is a partial view, not a clean one.
      if(r.status===0&&/could not open directory|Permission denied/i.test(r.stderr)) return {sha256:null,reason:'partial_unreadable_untracked'};
      if(r.status!==0) return {sha256:null,reason:r.status===null?`git_timeout_or_error: ${r.stderr.split('\n')[0].slice(0,160)}`:`git_could_not_read_a_file: ${r.stderr.split('\n')[0].slice(0,160)}`};
    }
    const tree=await gitAsync2(dir,['write-tree'],env,left());
    fs.rmSync(index,{force:true});
    return tree.status===0?{sha256:tree.stdout.trim(),reason:null,scratch}:{sha256:null,reason:'git_write_tree_failed'};
  } finally { if(own) fs.rmSync(scratch,{recursive:true,force:true}); }
}
// Paths that differ between two tree ids made by treeDigest in the same scratch directory (or a tree of the mirror). Null when unknown.
async function treePathsChanged(dir,scratch,common,a,b) {
  if(!a||!b) return null;
  if(a===b) return [];
  const env={...gitEnv(),GIT_OBJECT_DIRECTORY:path.join(scratch,'objects'),GIT_ALTERNATE_OBJECT_DIRECTORIES:path.join(common,'objects')};
  const r=await gitAsync2(dir,['diff-tree','-r','--name-only','--no-renames','-z',a,b],env,60000);
  return r.status===0?splitNames(r.buffer).sort():null;
}
// What a job may change, as a yes/no on a repository path. null means everything (an implementation job without a narrower scope_paths).
// Implementation: scope_paths and output_paths (minus scope_excluded). Read-only: output_paths only. This is the set apply_patch enforces.
export function writableScope(assignment) {
  if(assignment.execution_scope==='implementation') {const scope=scopeOf(assignment);return scope?p=>inScope(p,scope):null;}
  const outputs=outputsOf(assignment);return p=>outputs.has(p);
}
// git with a write to its stdin (checkout-index --stdin), never blocking the live server.
function gitAsyncInput(dir,args,env,input,timeout=60000) { return new Promise(resolve=>{ let err='';const child=spawn('git',['-C',dir,...args],{stdio:['pipe','ignore','pipe'],timeout,env});child.stderr.on('data',b=>{if(err.length<300)err+=b;});child.on('error',e=>resolve({status:null,stderr:e.message}));child.on('close',status=>resolve({status,stderr:err}));child.stdin.on('error',()=>{});child.stdin.end(input); }); }
// Put every path a command changed OUTSIDE the writable set back to its state in `preTree` (a tree made by treeDigest before the
// first phase ran). Git does it, with the isolated environment and no stash: the tree after the run is read with treeDigest, the paths
// that differ from `preTree` are listed with diff-tree, and
//   - a path the command added is removed (empty directories it leaves behind are pruned, unless writable),
//   - a path it changed or deleted is rewritten from `preTree` by `git checkout-index -f` on a temporary index read from that tree
//     (content, mode and symlink as committed; a symlink that replaced a directory is replaced back).
// Generated directories (node_modules, ...) are never touched. Afterwards the tree is read again and must equal `preTree` outside the
// writable set; the paths that still differ come back in `error`. Returns {paths (restored, sorted), error, before, after}: the tree
// digests just before and after the restore (`after` is the digest of what stays). It does not throw for a git failure; the caller
// records `error` and result/finish refuse with scope_violation if anything out of scope is left.
export async function restoreOutsideWritable({dir,scratch,preTree,writable}) {
  const before=await treeDigest(dir,scratch);
  if(!before.sha256) return {paths:[],error:`post_run_tree_unavailable: ${before.reason}`,before,after:before};
  let common;try{common=resolveFrom(dir,git(['-C',dir,'rev-parse','--git-common-dir']).trim());}catch(error){return {paths:[],error:error.message,before,after:before};}
  const env={...gitEnv(),GIT_OBJECT_DIRECTORY:path.join(scratch,'objects'),GIT_ALTERNATE_OBJECT_DIRECTORIES:path.join(common,'objects')};
  const listed=await gitAsync2(dir,['diff-tree','-r','--raw','--no-renames','-z',preTree,before.sha256],env,60000);
  if(listed.status!==0) return {paths:[],error:`diff_tree_failed: ${listed.stderr.split('\n')[0].slice(0,160)}`,before,after:before};
  // Tracked files under node_modules, target, ... are tracked files: they are in this list and restored like any other. Only untracked
  // generated output is exempt, and treeDigest never adds that to a tree, so it is never listed.
  const tokens=splitRaw(listed.buffer),entries=[];
  for(let i=0;i+1<tokens.length;i+=2) if(tokens[i][0]===0x3a) entries.push({status:tokens[i].toString().split(' ')[4]?.[0],path:decodeName(tokens[i+1])});
  const outside=entries.filter(entry=>!writable(entry.path));
  if(!outside.length) return {paths:[],error:null,before,after:before};
  const errors=[];
  // A path is removed or written only below real directories: a symlinked ancestor is itself a listed change and is handled on its own.
  const parentsOf=name=>{const bytes=nameBytes(name),out=[];for(let i=0;i<bytes.length;i++) if(bytes[i]===0x2f) out.push(bytes.subarray(0,i));return out;};
  const realParents=name=>{for(const parent of parentsOf(name)){try{if(!fs.lstatSync(Buffer.concat([Buffer.from(dir+path.sep),parent])).isDirectory()) return false;}catch{return true;}}return true;};
  for(const entry of outside.filter(e=>e.status==='A')) {
    if(!realParents(entry.path)) continue;
    try{fs.rmSync(absBytes(dir,entry.path),{recursive:true,force:true});}catch(error){errors.push(`${entry.path}: ${error.code||error.message}`);continue;}
    for(const parent of parentsOf(entry.path).reverse()) {if(writable(decodeName(parent))) break;try{fs.rmdirSync(Buffer.concat([Buffer.from(dir+path.sep),parent]));}catch{break;}}
  }
  const rewrite=outside.filter(e=>e.status!=='A').map(e=>e.path);
  if(rewrite.length) {
    const index=path.join(scratch,`restore-index-${randomUUID()}`),withIndex={...env,GIT_INDEX_FILE:index};
    try {
      const read=await gitAsync2(dir,['read-tree',preTree],withIndex,60000);
      if(read.status!==0) errors.push(`read_tree_failed: ${read.stderr.split('\n')[0].slice(0,160)}`);
      else {
        const out=await gitAsyncInput(dir,['checkout-index','-f','-z','--stdin'],withIndex,Buffer.concat(rewrite.flatMap(name=>[nameBytes(name),Buffer.from([0])])));
        if(out.status!==0) errors.push(`checkout_index_failed: ${String(out.stderr).split('\n')[0].slice(0,160)}`);
      }
    } finally { fs.rmSync(index,{force:true}); }
  }
  const after=await treeDigest(dir,scratch);
  let remaining=null;
  if(after.sha256) {
    const left=await treePathsChanged(dir,scratch,common,preTree,after.sha256);
    remaining=left===null?null:left.filter(file=>!writable(file));
  }
  if(remaining===null) errors.push(`restore_unverified: ${after.reason||'diff_tree_failed'}`);
  else if(remaining.length) errors.push(`restore_incomplete: ${remaining.slice(0,10).join(', ')}`);
  return {paths:[...new Set(outside.map(e=>e.path))].sort(),error:errors.length?errors.join('; ').slice(0,500):null,before,after};
}
// Tracked (and untracked, not ignored) sensitive files in the checkout. The check sandbox lays an empty read-only file over each one,
// including symlinks, so a check cannot read their target or print their contents.
const MASK_LIMIT=1000;
export function sensitiveMasks(dir,repo,copyDir) {
  const policy=sensitivePolicyPaths();
  if(policy.error) throw new Error('sensitive_policy_unavailable: restore a valid mode-0600 submission policy');
  const listed=git(['-C',dir,'ls-files','-z','--cached','--others','--exclude-standard'],{maxBuffer:64*1024*1024}).split('\0').filter(Boolean);
  const paths=[...new Set(listed)].filter(file=>!isGenerated(file)&&isSensitiveRepoPath(file,policy.paths)).filter(file=>{try{const st=fs.lstatSync(path.join(dir,file));return st.isFile()||st.isSymbolicLink();}catch{return false;}}).sort();
  const sourceExemptions=[];
  for(const approval of policy.sourceExemptions||[]) {
    if(approval.github_repo!==repo||!isSourceExemptionPath(approval.path)||!paths.includes(approval.path)) continue;
    try {
      const tracked=git(['-C',dir,'ls-files','-z','--error-unmatch','--',approval.path]).split('\0').filter(Boolean);
      if(tracked.length!==1||tracked[0]!==approval.path) continue;
      const full=path.join(dir,approval.path),before=fs.lstatSync(full);
      if(!before.isFile()||before.isSymbolicLink()) continue;
      const fd=fs.openSync(full,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
      let contents;
      try { const opened=fs.fstatSync(fd);if(!opened.isFile()||opened.ino!==before.ino||opened.dev!==before.dev||opened.size>16*1024*1024) continue;contents=fs.readFileSync(fd); }
      finally { fs.closeSync(fd); }
      const blobSha=createHash('sha1').update(`blob ${contents.length}\0`).update(contents).digest('hex');
      if(blobSha!==approval.blob_sha||secretContent.test(contents.toString('utf8'))) continue;
      const hostPath=path.join(copyDir,`${sourceExemptions.length}.source`);
      fs.writeFileSync(hostPath,contents,{flag:'wx',mode:0o444});
      sourceExemptions.push({path:approval.path,blob_sha:blobSha,hostPath});
    } catch {}
  }
  const exempt=new Set(sourceExemptions.map(entry=>entry.path));
  const maskedPaths=paths.filter(file=>!exempt.has(file));
  if(maskedPaths.length>MASK_LIMIT) throw new Error(`sensitive_mask_limit: ${maskedPaths.length} sensitive files in the checkout (limit ${MASK_LIMIT}); a check cannot be confined around that many`);
  return {paths:maskedPaths,sourceExemptions,policyError:policy.error};
}
// A list shown in the receipt: the first `shown` names, the true total, and a flag when the preview is shorter than the total.
const preview=(list,shown)=>list===null?null:({preview:list.slice(0,shown),total:list.length,truncated:list.length>shown});
// The lists go to one bounded artifact; null when every list is empty. The cap counts the serialized JSON, envelope and separators
// included. When a list does not fit, the artifact says "partial" and how much was kept; it never calls a cut list complete.
export function boundedDetail(lists,cap=DETAIL_ARTIFACT_CAP) {
  const names=Object.keys(lists).filter(name=>lists[name]?.length);
  if(!names.length) return null;
  const kept=Object.fromEntries(names.map(name=>[name,lists[name].slice()]));
  const build=()=>{const truncated={};for(const name of names) if(kept[name].length<lists[name].length) truncated[name]={kept:kept[name].length,total:lists[name].length};
    return Buffer.from(JSON.stringify({schema:2,complete:Object.keys(truncated).length===0,note:Object.keys(truncated).length?'PARTIAL: the artifact size cap was reached; see truncated for what was kept':'complete lists',lists:kept,truncated}));};
  let bytes=build();
  while(bytes.length>cap) { const longest=names.reduce((x,y)=>kept[y].length>kept[x].length?y:x);if(!kept[longest].length) break;kept[longest].length=Math.floor(kept[longest].length*0.9)||0;bytes=build(); }
  return bytes;
}

// Versions of what runs the check: the node binary bound into the sandbox, bwrap and pasta. Read once.
let runtimeCache=null;
function runtimeVersions() {
  if(runtimeCache) return runtimeCache;
  const first=(cmd,args)=>{try{const r=spawnSync(cmd,args,{encoding:'utf8',timeout:5000,env:{PATH:'/usr/bin:/bin'}});return (r.stdout||r.stderr||'').split('\n')[0].trim()||null;}catch{return null;}};
  const pasta=['/usr/bin/pasta','/usr/local/bin/pasta'].find(f=>fs.existsSync(f));
  return runtimeCache={node:process.version,bwrap:fs.existsSync('/usr/bin/bwrap')?first('/usr/bin/bwrap',['--version']):null,pasta:pasta?{path:pasta,version:first(pasta,['--version'])}:null};
}

export class Workspace {
  constructor(store,recover=true,{freeBytes,checkResponseOptions,stopReverify}={}) { this.checkResponseOptions=checkResponseOptions;this.stopReverify=stopReverify; if(freeBytes) this.freeBytes=freeBytes; this.store=store;this.activeChecks=new Set();this.checkEffects=new Map();fs.mkdirSync(worktrees,{recursive:true,mode:0o700});fs.mkdirSync(artifacts,{recursive:true,mode:0o700});fs.mkdirSync(caches,{recursive:true,mode:0o700});if(recover) this.sweepDigestScratch();if(recover) store.transaction(()=>{ for(const job of store.db.prepare("SELECT id,request_id,claim_id,check_id FROM check_jobs WHERE status='running'").all()) { store.db.prepare("UPDATE check_jobs SET status='interrupted',stop_verified=NULL,finished_at=? WHERE id=?").run(new Date().toISOString(),job.id); store.lifecycle(job.request_id,'check_failed','system',checkOutcome({...job,status:'interrupted'})[1],{claim_id:job.claim_id}); } });if(recover) this.reconcileHostStops(); }
  // Only called after expiry/revocation: the host supervisor observes loss of
  // authority and stops the whole unit. Await its receipt and discarded output.
  async quiesce(requestId) {
    await this.checkEffects.get(requestId);
    this.reconcileHostStops(requestId);
  }
  // Restart loses the pipe and in-memory promises. Only the trusted service's
  // immutable start + matching empty-cgroup stop can release that durable guard.
  reconcileHostStops(requestId) {
    const jobs=this.store.db.prepare("SELECT id,stop_evidence FROM check_jobs WHERE (? IS NULL OR request_id=?) AND status!='running' AND stop_verified IS NOT 1").all(requestId??null,requestId??null);
    const results=[];
    for(const job of jobs) {
      const options={receiptDir:path.join(root,'host-receipts'),checkRunId:job.id};
      // An unverified or missing stop is re-checked against fresh evidence: a changed boot id, or an inactive unit with an empty cgroup.
      let stop=readVerifiedHostStop(options)??reverifyHostStop(options,this.stopReverify);
      // Legacy invocations do not participate in admission sealing; absent
      // evidence for them remains unknown. New ones cannot start after sealing.
      if(!stop&&JSON.parse(job.stop_evidence??'null')?.host?.receipt_protocol===1) stop=sealHostNotStarted(options);
      if(!stop) {results.push({check_run_id:job.id,verified:false});continue;}
      results.push({check_run_id:job.id,verified:true,basis:stop.basis??null});
      this.store.transaction(()=>{
        const row=this.store.db.prepare('SELECT status,stop_verified FROM check_jobs WHERE id=?').get(job.id);
        if(!row||row.status==='running'||row.stop_verified===1) return;
        // Earlier partial-phase evidence cannot stand for this invocation's stop.
        this.store.db.prepare('UPDATE check_jobs SET stop_verified=1,stop_evidence=? WHERE id=?').run(JSON.stringify({host:{verified:true,reason:stop.notStarted?'durable_host_admission_sealed':stop.reverified?'durable_systemd_control_group_reverified':'durable_systemd_control_group_stopped',invocation_id:stop.invocationId,remaining_pids:[]}}),job.id);
      });
    }
    return results;
  }
  // Scratch directories of receipt digests left by a crash. Only old ones go, so a live check of another process is never touched.
  sweepDigestScratch(maxAgeMs=3600000) {
    const dir=path.join(root,'run');let names;try{names=fs.readdirSync(dir);}catch{return 0;}
    let removed=0;
    for(const name of names) { if(!name.startsWith('digest-')) continue;const full=path.join(dir,name);try{if(Date.now()-fs.statSync(full).mtimeMs>=maxAgeMs){fs.rmSync(full,{recursive:true,force:true});removed++;}}catch{} }
    return removed;
  }
  context(requestId,claimId,subject,write=false,worker='dot',allowOutputs=false) {
    if(!this.store.mayAct(worker,requestId)) throw new Error('assignment not found');
    const a=this.store.get(requestId),claim=this.store.assertClaim(requestId,claimId,subject,worker);
    if(a.status!=='claimed'||a.cancelled_at) throw closedWorkspace(a,requestId,claimId);
    if(write&&a.assignment.execution_scope!=='implementation'&&!(allowOutputs&&outputsOf(a.assignment).size)) throw coded('read_only_assignment',`${requestId} is read-only (execution_scope ${a.assignment.execution_scope}); apply_patch is not allowed for it. This affects only this action on ${requestId}; reads and checks still work.`);
    const input=assignmentInput(a.assignment);
    const saved=this.store.db.prepare('SELECT claim_id,path FROM workspaces WHERE request_id=?').get(requestId);
    let mirror=saved?.claim_id===claimId?savedWorkspaceMirror(saved.path,requestId):null;
    if(!mirror) mirror=mirrorPath(input.github_repo,{worker});
    if(!fs.existsSync(mirror)) mirror=prepareGithubRepo(input,{worker});
    touch(path.join(mirror,'dot-last-used'));
    const actual=git(['-C',mirror,'rev-parse','--verify',`${input.base_sha}^{commit}`]).trim();
    if(actual!==input.base_sha) throw new Error('base SHA missing from local mirror');
    return {a,claim,input,mirror};
  }
  ensure(requestId,claimId,subject,allowActive=false,worker='dot') {
    if(this.activeChecks.has(requestId)&&!allowActive) throw new Error('check still running');
    const ctx=this.context(requestId,claimId,subject,false,worker),dir=path.join(worktrees,requestId),checkoutSha=(ctx.a.assignment.execution_scope==='read-only'||ctx.a.review)&&ctx.input.head_sha?ctx.input.head_sha:ctx.input.base_sha;
    let row=this.store.db.prepare('SELECT * FROM workspaces WHERE request_id=?').get(requestId);
    if(!row) {
      if(fs.existsSync(dir)) {
        const pointer=fs.readFileSync(path.join(dir,'.git'),'utf8');
        const common=path.join(ctx.mirror,'worktrees')+path.sep;
        const listed=git(['-C',ctx.mirror,'worktree','list','--porcelain']).split('\n').includes(`worktree ${dir}`);
        if(fs.realpathSync(dir)!==dir||!pointer.startsWith('gitdir: '+common)||!listed||git(['-C',dir,'rev-parse','HEAD']).trim()!==checkoutSha) throw new Error('unrecorded workspace mismatch');
      } else {
        git(['-C',ctx.mirror,'worktree','add','--detach',dir,checkoutSha]);
        fs.chmodSync(dir,0o700);
      }
      this.store.db.prepare('INSERT INTO workspaces(request_id,claim_id,base_sha,path,created_at) VALUES(?,?,?,?,?)')
        .run(requestId,claimId,ctx.input.base_sha,dir,new Date().toISOString());
      row=this.store.db.prepare('SELECT * FROM workspaces WHERE request_id=?').get(requestId);
    }
    if(row.claim_id!==claimId||row.base_sha!==ctx.input.base_sha||row.path!==dir||git(['-C',dir,'rev-parse','HEAD']).trim()!==checkoutSha) throw new Error('workspace binding mismatch');
    if(!row.initial_patch_applied) {
      if(ctx.input.input_patch) {
        const reverse=spawnSync('git',['-C',dir,'apply','--reverse','--check','-'],{input:ctx.input.input_patch,encoding:'utf8',timeout:10000,env:gitEnv()});
        if(reverse.status!==0) applyPatchToTree(dir,ctx.input.input_patch);
      }
      this.store.db.prepare('UPDATE workspaces SET initial_patch_applied=1 WHERE request_id=?').run(requestId);
    }
    return {...ctx,dir};
  }
  list(requestId,claimId,subject,p='',limit=200,worker='dot',cursor='') { const {dir,a}=this.ensure(requestId,claimId,subject,false,worker),scope=scopeOf(a.assignment);relative(p,true);if(p&&!leadsToScope(p,scope)) throw new Error(`path outside scope_paths: ${p}`);if(p) safePath(dir,p,true);const listed=guardedFiles(dir,p,limit,scope,cursor);return listed.truncated?{files:listed.files,truncated:true,next_cursor:listed.files.at(-1)}:{files:listed.files,truncated:false}; }
  read(requestId,claimId,subject,p,start=1,max=200,worker='dot') { const {dir,a}=this.ensure(requestId,claimId,subject,false,worker);relative(p);requireScope(p,scopeOf(a.assignment));const file=safePath(dir,p,true);requireScope(realRelative(dir,file,p),scopeOf(a.assignment));const st=fs.statSync(file);if(!st.isFile()||st.size>1024*1024) throw new Error('file not readable');const whole=fs.readFileSync(file,'utf8');
    // Names no longer gate code files (submission-policy codeFile), so content does: every secret value is replaced before the line window and the 32 KiB cut, so no fragment of one reaches the worker. `redacted` tells the worker a value was masked.
    const {text:clean,redacted}=redactSecrets(whole);
    const lines=clean.split('\n'),window=lines.slice(start-1,start-1+max);
    let value=window.join('\n'),end=start+window.length-1;
    const truncated=Buffer.byteLength(value)>32768;
    if(truncated) {
      const bytes=Buffer.from(value),newline=bytes.lastIndexOf(10,32768);
      if(newline>=0) {
        // Keep complete lines, without a delimiter that would imply a further line.
        value=bytes.subarray(0,newline).toString('utf8');
      } else {
        // The first line alone exceeds the cap. Back up over a partial UTF-8 character.
        let cut=32768;while((bytes[cut]&0xc0)===0x80) cut--;
        value=bytes.subarray(0,cut).toString('utf8');
      }
      end=start+value.split('\n').length-1;
    }
    return {path:p,start_line:start,end_line:end,total_lines:lines.length,text:value,truncated,...(redacted?{redacted}:{})}; }
  // `only` (the output_paths of a read-only assignment): the diff is the job's own change against the checkout (HEAD), and its
  // exact changed-file set (both sides of any rename, deletions, mode changes, untracked files) must lie inside `only`. Git
  // pathspecs are not used for this: they also match descendants of a path. Any other change refuses with output_paths_violation
  // instead of riding along in the patch. An output that is a symlink refuses too.
  diff(dir,base='HEAD',only=null,scope=null) {
    if(only) {
      base='HEAD';
      const tracked=splitNames(git(['-C',dir,'diff','--name-only','-z','--no-renames',base],{encoding:'buffer'}));
      const untracked=spawnSync('git',['-C',dir,'ls-files','--others','--exclude-standard','-z'],{timeout:10000,maxBuffer:64*1024*1024,env:gitEnv()});
      if(untracked.status!==0) throw new Error('cannot enumerate untracked files');
      const outside=[...new Set([...tracked,...splitNames(untracked.stdout)])].filter(file=>!only.has(file));
      for(const file of only) {try{if(fs.lstatSync(path.join(dir,file)).isSymbolicLink()) outside.push(file);}catch(error){if(error.code!=='ENOENT'&&error.code!=='ENOTDIR') throw error;}}
      if(outside.length) throw Object.assign(new Error(`output_paths_violation: the workspace changed files outside output_paths (${[...only].join(', ')}): ${[...new Set(outside)].sort().slice(0,10).join(', ')}. A read-only job may change only its declared output files, as regular files; remove the others.`),{outputViolation:true});
    }
    let patch=git(['-C',dir,'diff','--no-ext-diff','--no-textconv','--binary',base]);
    const changed=new Set(splitNames(git(['-C',dir,'diff','--name-only','-z','--no-renames',base],{encoding:'buffer'})));
    const others=spawnSync('git',['-C',dir,'ls-files','--others','--exclude-standard','-z'],{timeout:10000,maxBuffer:64*1024*1024,env:gitEnv()});
    if(others.status!==0) throw new Error('cannot enumerate untracked files');
    const files=splitNames(others.stdout).filter(file=>!isGenerated(file));
    const omissions=[],omit=(file,size,reason)=>{omissions.push({path:file,size,reason});changed.add(file);};
    for(const file of files.slice(UNTRACKED_FILE_COUNT)) omit(file,null,'too_many_untracked_files');
    for(const file of files.slice(0,UNTRACKED_FILE_COUNT)) {
      // A check runs inside this workspace and may leave or briefly create entries the worker never addresses by path: lock files
      // that are symlinks, scratch dirs, temp files. They are not part of a patch (patchPaths refuses symlink modes), so an untracked
      // symlink is left out of the diff instead of failing every read-only tool. Its parent directories are still checked, and
      // read, list and apply_patch still refuse any symlink on a path they are given. An entry that vanished mid-run is skipped too.
      // Anything else the diff cannot carry (too large, unreadable, not a regular file) is named in `omissions`, never thrown: one
      // such file used to make diff throw, which lost the check result and every later workspace_result.
      // A name that is not UTF-8 cannot be read back by this code as a string: name it as omitted (and, in a scoped job, out of scope), never skip it.
      if(RAW_NAME.test(file)) {omit(file,null,'non_utf8_name');continue;}
      let entry;
      try{entry=fs.lstatSync(path.join(dir,file));}catch(error){if(error.code==='ENOENT') continue;throw error;}
      if(entry.isSymbolicLink()) {if(path.dirname(file)!=='.') safePath(dir,path.dirname(file),true);continue;}
      let source;try{source=safePath(dir,file,true);}catch(error){omit(file,entry.size,'unsafe_path');continue;}
      if(!entry.isFile()) {omit(file,entry.size,'not_regular_file');continue;}
      if(entry.size>UNTRACKED_FILE_CAP) {omit(file,entry.size,'too_large');continue;}
      try{fs.accessSync(source,fs.constants.R_OK);}catch{omit(file,entry.size,'unreadable');continue;}
      const result=spawnSync('git',['diff','--no-index','--no-ext-diff','--no-textconv','--binary','--','/dev/null',file],{cwd:dir,encoding:'utf8',timeout:10000,maxBuffer:12*1024*1024,env:gitEnv()});
      if(result.error||result.status!==1) {if(!fs.existsSync(source)) continue;omit(file,entry.size,result.error?.code==='ENOBUFS'?'too_large':'diff_failed');continue;}
      if(Buffer.byteLength(patch)+Buffer.byteLength(result.stdout)>DIFF_TOTAL_CAP) {omit(file,entry.size,'diff_total_cap');continue;}
      patch+=result.stdout;changed.add(file);
    }
    // Defense in depth for implementation jobs: apply_patch and the post-check restore keep the diff inside scope_paths and output_paths,
    // and this refuses a diff that still carries anything else. `changed` holds tracked changes (a tracked file under node_modules or target
    // counts) and untracked files other than generated output; omitted files are in it too.
    if(scope) {
      const outside=[...changed].filter(file=>!inScope(file,scope)).sort();
      if(outside.length) throw Object.assign(new Error(JSON.stringify({error:'scope_violation',message:`the workspace changed files outside scope_paths/output_paths: ${outside.slice(0,10).join(', ')}${outside.length>10?`, and ${outside.length-10} more`:''}. An implementation job may change only its scope_paths and output_paths. This job is stuck because of ${outside.length>3?`${outside.length} paths`:'these paths'}: no worker action can fix it (apply_patch cannot touch paths outside scope_paths). Tell the owner to cancel and resubmit the request. This affects only this request.`,paths:outside.slice(0,100),total:outside.length})),{scopeViolation:true,paths:outside});
    }
    return {patch,sha256:sha(patch),bytes:Buffer.byteLength(patch),omissions,paths:[...changed].sort()};
  }
  apply(requestId,claimId,subject,patch,worker='dot') { this.context(requestId,claimId,subject,true,worker,true);if(this.store.get(requestId).review) throw new Error(JSON.stringify({error:'review_mode_read_only',message:'apply_patch is disabled for review submissions; read files, run_check, and report findings with finish.'}));const {dir,input,a}=this.ensure(requestId,claimId,subject,false,worker);
    // A read-only assignment with output_paths may write those files and nothing else: one other file refuses the whole patch.
    if(a.assignment.execution_scope!=='implementation') {
      const outputs=outputsOf(a.assignment),outside=patchPaths(patch).filter(file=>!outputs.has(file));
      if(outside.length) throw coded('read_only_assignment',`${requestId} is read-only (execution_scope ${a.assignment.execution_scope}); apply_patch may only create or edit its output_paths (${[...outputs].join(', ')}). The patch also touches: ${outside.slice(0,10).join(', ')}.${outside.map(file=>outputDirectoryHint(file,outputs)).find(Boolean)||''} Nothing was applied. This affects only this action on ${requestId}.`);
      // Submit proves output_paths are absent at the pinned revision; this proves it again for an assignment that skipped submit.
      const existing=patchPaths(patch).filter(file=>existsAtHead(dir,file));
      if(existing.length) throw coded('output_path_exists',`${existing[0]} already exists at the pinned revision, so it is not a new output file. output_paths declare NEW files only. Nothing was applied. This affects only this action on ${requestId}; choose another path.`);
    }
    // A new file under a generated-name directory is build output to diff(), which leaves it out of workspace_result and the finish
    // patch with no error. Refuse it here instead. A tracked file under such a name is not new and is not refused (see restoreOutsideWritable).
    const generatedNew=patchPaths(patch).filter(file=>isGenerated(file)&&!existsAtHead(dir,file));
    if(generatedNew.length) throw coded('generated_path',`${generatedNew[0]} is a new file under a build-output directory. Files under node_modules/.venv/target/__pycache__ are treated as build output and are not included in the patch; choose another path. Nothing was applied. This affects only this action on ${requestId}.`);
    const files=this.store.transaction(()=>{const current=this.store.get(requestId);this.store.assertClaim(requestId,claimId,subject,worker);if(current.status!=='claimed'||current.cancelled_at) throw closedWorkspace(current,requestId,claimId);const changed=applyPatchToTree(dir,patch,scopeOf(a.assignment));this.noteIgnoredWritten(requestId,dir,changed);return changed;});return {files,diff_sha256:this.diff(dir,input.base_sha).sha256}; }
  // Paths a patch wrote that git ignores are outside the candidate source (a check can still run them). They are listed, not refused,
  // and kept beside the workspace (never inside it) until the next receipt carries them.
  ignoredWrittenFile(requestId) { return path.join(worktrees,`${requestId}.ignored-written.json`); }
  noteIgnoredWritten(requestId,dir,files) {
    const r=spawnSync('git',['-C',dir,'check-ignore','-z','--stdin'],{input:files.join('\0'),encoding:'utf8',timeout:10000,maxBuffer:4*1024*1024,env:gitEnv()});
    // check-ignore exits 0 (some ignored), 1 (none) or 128 (error). An error is recorded, never read as "none ignored".
    const failed=r.status!==0&&r.status!==1;
    const ignored=r.status===0?r.stdout.split('\0').filter(Boolean):[];
    if(!ignored.length&&!failed) return;
    const before=this.readIgnoredWritten(requestId);
    fs.writeFileSync(this.ignoredWrittenFile(requestId),JSON.stringify({paths:[...new Set([...before.paths,...ignored])].sort(),unavailable:failed?`git_check_ignore_failed: ${String(r.stderr||r.error?.message||'').split('\n')[0].slice(0,160)}`:before.unavailable}),{mode:0o600});
  }
  readIgnoredWritten(requestId) { try{const v=JSON.parse(fs.readFileSync(this.ignoredWrittenFile(requestId),'utf8'));return Array.isArray(v)?{paths:v,unavailable:null}:{paths:v.paths??[],unavailable:v.unavailable??null};}catch{return {paths:[],unavailable:null};} }
  retention(requestId) {return new Date(Date.now()+14*86400000).toISOString();}
  // Single-flight: an hourly tick during a long run gets the in-flight promise instead of a second sweep.
  cleanupExpired({log=entry=>console.error(JSON.stringify(entry))}={}) { return this.cleanupRun??=this.sweepExpired(log).finally(()=>{this.cleanupRun=null;}); }
  async freeBytes() { const s=await fs.promises.statfs(root); return Number(s.bavail)*Number(s.bsize); }
  activeNpmCacheKeys() {
    const keys=new Set();
    const assignmentById=this.store.db.prepare('SELECT payload,target_worker FROM assignments WHERE request_id=?');
    for(const id of this.activeChecks) { const row=assignmentById.get(id),key=npmCacheKey(row?.target_worker,payloadRepo(row?.payload)); if(key) keys.add(key); }
    return keys;
  }
  // Shared worker/repo npm stores are regenerable. Drop each one with no running check, always under pressure, otherwise after 7 idle days.
  // The idle test and the rename are one sync step, so a check starting later makes a fresh store instead of using one being deleted.
  async sweepSharedCaches(all) {
    let names,removed=0;try{names=await fs.promises.readdir(sharedNpm);}catch{return 0;}
    for(const name of names) {
      await yieldLoop();
      const dir=path.join(sharedNpm,name);let idleMs;
      try{idleMs=Date.now()-fs.statSync(dir).mtimeMs;}catch{continue;}
      if(this.activeNpmCacheKeys().has(name)||!all&&!name.includes('.evicting-')&&idleMs<IDLE_CACHE_MS) continue;
      try{await evictDir(dir);removed++;}catch(error){console.error(`shared cache cleanup failed for ${dir}: ${error.message}`);}
    }
    return removed;
  }
  // A bare mirror goes when no active assignment or live workspace uses it and it was unused for 7 days, or the disk is low
  // (oldest first, until space is back). The clock starts when the first sweep sees a mirror without a marker.
  async sweepMirrors(pressure,minFree) {
    const db=this.store.db,inUse=new Set();
    for(const row of db.prepare("SELECT request_id,payload,target_worker FROM assignments WHERE status IN ('queued','claimed')").all()) { try{inUse.add(mirrorPath(payloadRepo(row.payload),{worker:row.target_worker||'dot'}));}catch{} }
    for(const row of db.prepare('SELECT request_id,path FROM workspaces').all()) { const common=savedWorkspaceMirror(row.path,row.request_id);if(common) inUse.add(common); }
    const found=[];
    const visit=async dir=>{
      if(path.basename(dir).includes('.evicting-')) { await removeCache(dir);return; }
      let entries;try{entries=await fs.promises.readdir(dir,{withFileTypes:true});}catch{return;}
      if(path.basename(dir).endsWith('.git')&&entries.some(entry=>entry.name==='HEAD')) {
        const marker=path.join(dir,'dot-last-used');let used;
        try{used=fs.statSync(marker).mtimeMs;}catch{touch(marker);return;}
        found.push({dir,used});
        return;
      }
      for(const entry of entries) if(entry.isDirectory()) await visit(path.join(dir,entry.name));
    };
    await visit(mirrors);
    let removed=0;
    for(const {dir,used} of found.sort((x,y)=>x.used-y.used)) {
      await yieldLoop();
      if(inUse.has(dir)) continue;
      const stale=Date.now()-used>=MIRROR_IDLE_MS;
      if(!stale) { if(!pressure) continue; if(!(pressure=await this.freeBytes()<minFree)) break; }
      try{await evictDir(dir);removed++;}catch(error){console.error(`mirror cleanup failed for ${dir}: ${error.message}`);}
    }
    return removed;
  }
  // A per-assignment cache whose assignment is not queued or claimed (terminal, or its workspace row already gone) serves nothing.
  async sweepOrphanCaches() {
    let names;try{names=await fs.promises.readdir(caches);}catch{return 0;}
    const live=this.store.db.prepare("SELECT 1 FROM assignments WHERE request_id=? AND status IN ('queued','claimed')");
    let removed=0;
    for(const name of names) {
      await yieldLoop();
      if(name==='shared'||name.startsWith('check-metadata-')||this.activeChecks.has(name)||live.get(name)) continue;
      const dir=path.join(caches,name);
      try{await removeCache(dir);if(!fs.existsSync(dir)) removed++;}catch(error){console.error(`cache cleanup failed for ${dir}: ${error.message}`);}
    }
    return removed;
  }
  // Called before a tool call that may create a workspace: if the disk is below the floor, free space first instead of waiting for the hourly sweep.
  async makeRoom(requestId) {
    if(this.store.db.prepare('SELECT 1 FROM workspaces WHERE request_id=?').get(requestId)) return;
    if(await this.freeBytes()>=minFreeBytes()) return;
    await this.cleanupExpired();
  }
  async sweepExpired(log) {
    const now=new Date().toISOString(),summary={artifacts_removed:0,workspaces_removed:0,caches_removed:0,shared_caches_removed:0,mirrors_removed:0,pressure:false,errors:0},db=this.store.db;
    const failed=(entry,error)=>{summary.errors++;log({kind:'artifact_cleanup_error',...entry,reason:error.message});};
    const expiredArtifact=db.prepare('SELECT id,path FROM artifacts WHERE id=? AND retention_until IS NOT NULL AND retention_until<=?');
    const artifactIds=db.prepare('SELECT id FROM artifacts WHERE retention_until IS NOT NULL AND retention_until<=?').all(now).map(row=>row.id);
    for(let i=0;i<artifactIds.length;i++) {
      if(i%100===0) await yieldLoop();
      const row=expiredArtifact.get(artifactIds[i],now); if(!row) continue;
      try{await fs.promises.unlink(row.path);}catch(e){if(e.code!=='ENOENT'){failed({artifact_id:row.id},e);continue;}}
      db.prepare('DELETE FROM artifacts WHERE id=?').run(row.id);summary.artifacts_removed++;
    }
    const terminal=`SELECT w.request_id,w.path,a.payload,a.status,a.cancelled_at,r.created_at finished_at,
      w.fetched_at
      FROM workspaces w JOIN assignments a USING(request_id) LEFT JOIN reports r USING(request_id)
      WHERE a.status IN ('finished','cancelled')`;
    const current=db.prepare(`${terminal} AND w.request_id=?`);
    const terminalTime=row=>Date.parse(row.status==='cancelled'?row.cancelled_at:row.finished_at)||0;
    // Below the free-space floor, retention no longer protects terminal workspaces: drop idle shared caches, then evict oldest first until above it.
    const minFree=minFreeBytes();
    let pressure=await this.freeBytes()<minFree;
    if(pressure) { summary.pressure=true;summary.shared_caches_removed=await this.sweepSharedCaches(true);pressure=await this.freeBytes()<minFree; }
    const rows=db.prepare(terminal).all().sort((x,y)=>terminalTime(x)-terminalTime(y));
    for(const {request_id:requestId} of rows) {
      await yieldLoop();
      // State can change across awaits: re-read the row and the active checks right before acting.
      const idle=()=>{const row=current.get(requestId);return row&&!this.activeChecks.has(requestId)?row:null;};
      let row=idle(); if(!row) continue;
      let mirror=savedWorkspaceMirror(row.path,requestId);if(!mirror) continue;
      try {
        // A finished assignment cannot be claimed again; its patch and report remain in artifacts. Retaining each checkout for
        // 14 days can consume disk. Keep it 6 h, or less once the owner fetched the result (any read, peek included) or disk is low.
        const terminalAt=terminalTime(row);
        const expired=terminalAt&&terminalAt+WORKSPACE_RETENTION_MS<=Date.now();
        // The dependency cache serves only a claimed assignment's checks. Remove it as soon as the assignment is terminal,
        // even when the checkout remains available for the owner to fetch its result.
        const cache=path.join(caches,row.request_id);if(fs.existsSync(cache)) { await removeCache(cache);if(!fs.existsSync(cache)) summary.caches_removed++; }
        if(!expired&&!row.fetched_at) { if(!pressure) continue; if(!(pressure=await this.freeBytes()<minFree)) continue; if(!(row=idle())) continue; }
        if(row.path!==path.join(worktrees,row.request_id)) throw Object.assign(new Error('workspace cleanup path mismatch'),{request_id:requestId,summary});
        if(fs.existsSync(row.path)) await gitAsync(['-C',mirror,'worktree','remove','--force',row.path]);
        db.prepare('DELETE FROM workspaces WHERE request_id=?').run(row.request_id);fs.rmSync(this.ignoredWrittenFile(row.request_id),{force:true});summary.workspaces_removed++;
      } catch(error) { if(error.summary) throw error;failed({request_id:requestId},error); }
    }
    summary.caches_removed+=await this.sweepOrphanCaches();
    if(!pressure) summary.shared_caches_removed+=await this.sweepSharedCaches(false);
    summary.mirrors_removed=await this.sweepMirrors(pressure,minFree);
    return summary;
  }
  saveArtifact(requestId,claimId,kind,bytes,id=`art_${randomUUID()}`) {
    const rollback=[];
    try { return this.store.transaction(()=>this.saveArtifactInTransaction(requestId,claimId,kind,bytes,id,cleanup=>rollback.push(cleanup))); }
    catch(error) { for(const cleanup of rollback) cleanup();throw error; }
  }
  saveArtifactInTransaction(requestId,claimId,kind,bytes,id,onRollback) {
    if(!this.store.db.isTransaction||typeof onRollback!=='function') throw new Error('artifact requires caller transaction and rollback cleanup');
    if(kind==='owner-report') bytes=ownerReportArtifactBytes(bytes);
    else if(kind!=='patch') bytes=Buffer.from(redactSecrets(bytes.toString('utf8')).text);
    if(!/^art_[a-zA-Z0-9_-]{8,128}$/.test(id)) throw new Error('invalid artifact id');
    const grant=this.store.db.prepare('SELECT subject,worker FROM claims WHERE request_id=? AND claim_id=?').get(requestId,claimId);
    if(!grant) throw new Error('invalid claim');
    this.store.assertClaim(requestId,claimId,grant.subject,grant.worker);
    const current=this.store.get(requestId);
    if(current.status!=='claimed'||current.cancelled_at) throw closedWorkspace(current,requestId,claimId);
    const file=path.join(artifacts,id),fd=fs.openSync(file,'wx',0o600);
    onRollback(()=>fs.rmSync(file,{force:true}));
    try {fs.writeFileSync(fd,bytes);} finally {fs.closeSync(fd);}
    this.store.db.prepare('INSERT INTO artifacts(id,request_id,claim_id,kind,path,size,sha256,sealed,created_at,retention_until,origin_claim_id,origin_epoch) VALUES(?,?,?,?,?,?,?,?,?,?,?,(SELECT epoch FROM claims WHERE request_id=?))')
      .run(id,requestId,claimId,kind,file,bytes.length,sha(bytes),1,new Date().toISOString(),this.retention(requestId),claimId,requestId);
    return {artifact_id:id,size:bytes.length,sha256:sha(bytes),kind};
  }
  availableChecksFor(assignment,worker='dot') {
    const input=assignmentInput(assignment),mirror=fs.existsSync(mirrorPath(input.github_repo,{worker}))?mirrorPath(input.github_repo,{worker}):prepareGithubRepo(input,{worker});
    return withCheckMetadata(mirror,input.base_sha,dir=>availableChecks(input.github_repo,dir));
  }
  // Catalog data is response enrichment; keep it from discarding a committed claim or finish snapshot.
  // run_check uses the strict reader, so an invalid host check definition still cannot run.
  availableChecksResponse(assignment,dir=null,execution='host',worker='dot') {
    try {
      const repo=assignment.inputs[0].github_repo;
      const declared=dir?availableChecks(repo,dir):this.availableChecksFor(assignment,worker);
      if(execution!=='host') return {available_checks:declared};
      const baseRefusal=hostCheckRefusal(assignment);
      const readiness=hostReadiness();
      const candidates=baseRefusal||!readiness.ready?[]:declared.filter(id=>!hostCheckRefusal(assignment,repo,id));
      const reason=baseRefusal||(!readiness.ready?readiness.reason:null)||(!candidates.length?'host_check_not_allowlisted: no permitted owner-configured check is runnable':null);
      return {available_checks:candidates,host_execution_available:candidates.length>0,host_execution_unavailable_reason:reason};
    } catch(error) {
      if(!String(error?.message??'').includes('check metadata')) throw error;
      if(execution==='host'&&assignment.execution_scope!=='implementation') throw error;
      return {available_checks:[],available_checks_error:'invalid check metadata',...(execution==='host'?{host_execution_available:false,host_execution_unavailable_reason:'invalid check metadata'}:{})};
    }
  }
  checkMetadataFor(assignment,worker='dot') {
    const input=assignmentInput(assignment),mirror=fs.existsSync(mirrorPath(input.github_repo,{worker}))?mirrorPath(input.github_repo,{worker}):prepareGithubRepo(input,{worker});
    return checkSpecsAt(input.github_repo,mirror,input.base_sha);
  }
  // What the bridge itself observed about one host check, and nothing more. The receipt identifies the candidate source: git's view of
  // the workspace (tracked files plus untracked files that are not ignored) for the install input, the check input and the tree after
  // the run, the diff against base, the changed paths and the definition source. `not_identified` states what it does not identify.
  buildEvidence({input,spec,origin,baseSpec,backend,baseTree,installInput,checkInput,candidateInput,inputDiff,inputDiffError,changed,installChanged,mutatedPaths,post,rawPost,postDiff,postDiffError,receipt,phase,output,outputTruncated,stops,detailArtifact,workerIgnored,evidenceMs,detailTruncated,blocker,restoredPaths=[],restoreError=null,writeScope='unrestricted',masked={paths:[],policyError:null}}) {
    const inputSnap=checkInput||installInput||candidateInput,diffPaths=changed??inputDiff?.paths??[];
    const differs=inputSnap.sha256&&baseTree?inputSnap.sha256!==baseTree:diffPaths.length>0?true:'unknown';
    const mutated=inputSnap.sha256&&(rawPost??post).sha256?inputSnap.sha256!==(rawPost??post).sha256:null;
    const source=origin.from==='owner_config'?'owner_config':baseSpec&&JSON.stringify(baseSpec)===JSON.stringify(spec)?'base':'modified';
    const omissionsIn=inputDiff?.omissions??[],omissionsPost=postDiff?.omissions??[];
    const unverified=Object.entries(stops||{}).filter(([,x])=>!x?.verified).map(([phaseName,x])=>`${phaseName} (${x?.reason??'no stop record'})`);
    const evidence={schema:3,output_redaction_version:1,execution:'host',trust:TRUST.bridge,repo:input.github_repo,base_sha:input.base_sha,base_tree_sha256:baseTree,
      input_patch_sha256:input.input_patch?sha(input.input_patch):null,
      phase,input_phase:checkInput?'check':installInput?'install':'not_started',...(blocker?{blocker}:{}),
      input_tree_sha256:inputSnap.sha256,...(inputSnap.reason?{input_tree_unavailable:inputSnap.reason}:{}),
      install_input_tree_sha256:installInput?.sha256??null,
      ...(installInput&&checkInput?{check_input_differs_from_install_input:installInput.sha256&&checkInput.sha256?installInput.sha256!==checkInput.sha256:'unknown',install_changed_paths:preview(installChanged,PREVIEW_SHOWN)}:{}),
      input_diff_sha256:inputDiff?.sha256??null,...(inputDiffError?{input_diff_error:inputDiffError}:{}),
      candidate_differs_from_base:differs,changed_paths:preview(diffPaths,CHANGED_PATHS_SHOWN),
      diff_omissions:preview(omissionsIn,CHANGED_PATHS_SHOWN),
      definition:{check_id:spec.id,source,sha256:sha(JSON.stringify(spec)),base_sha256:baseSpec?sha(JSON.stringify(baseSpec)):null},
      argv:spec.argv,test_paths:declaredOrNamedTestPaths(spec),install_argv:spec.install_argv,timeout_ms:spec.timeout_ms,backend:{name:backend.name,version:backend.version,capabilities:backend.capabilities},
      exit_code:receipt.exit.code,timed_out:receipt.timedOut,cancelled:receipt.cancelled,
      output_sha256:sha(output),output_bytes:output.length,output_truncated:outputTruncated,sandbox_stop:stops,
      post_run_tree_sha256:post.sha256,...(rawPost&&rawPost.sha256!==post.sha256?{post_run_tree_before_restore_sha256:rawPost.sha256}:{}),write_scope:writeScope,restored_out_of_scope_paths:preview(restoredPaths,PREVIEW_SHOWN),...(restoreError?{scope_restore_error:restoreError}:{}),masked_sensitive_paths:preview(masked.paths,PREVIEW_SHOWN),...(masked.policyError?{masked_sensitive_paths_policy_error:masked.policyError}:{}),sandbox_source_exemptions:(masked.sourceExemptions||[]).map(({path,blob_sha})=>({path,blob_sha})),...(post.reason?{post_run_tree_unavailable:post.reason}:{}),tree_mutated_by_check:mutated,tree_mutated_paths:preview(mutatedPaths,PREVIEW_SHOWN),
      post_run_diff_sha256:postDiff?.sha256??null,...(postDiffError?{post_run_diff_error:postDiffError}:{}),post_run_diff_omissions:preview(omissionsPost,CHANGED_PATHS_SHOWN),
      claims:{trusted_bridge_execution:phase==='not_started'?'No phase launch was observed.':`The bridge observed the command launch, the runtime versions, backend, capabilities, exit code, timeout and output digest. ${unverified.length?`Stop NOT verified: ${unverified.join('; ')}.`:'Stop verified for every phase.'}`,source_observation:'git\'s view of the workspace at phase boundaries. It is not proof of the executed bytes and not an immutable snapshot.'},
      source_observation:inputSnap.sha256&&post.sha256&&(!installInput||checkInput)?'observed':'unavailable',
      evidence_ms:evidenceMs,detail_artifact_id:detailArtifact?.artifact_id??null,...(detailTruncated?{detail_artifact_truncated:detailTruncated}:{}),worker_written_ignored_paths:preview(workerIgnored?.paths??[],PREVIEW_SHOWN),...(workerIgnored?.unavailable?{worker_written_ignored_paths_unavailable:workerIgnored.unavailable}:{}),runtime:runtimeVersions(),not_identified:NOT_IDENTIFIED};
    const short=h=>h?h.slice(0,12):'unavailable';
    evidence.observed=[
      phase==='not_started'?'No phase was observed to start; the phase was not started or its launch receipt was lost.':`The bridge ran ${JSON.stringify(phase==='install'?spec.install_argv:spec.argv)} (phase ${phase}) confined by ${backend.name} v${backend.version}. The candidate source at the start of that phase had git tree ${short(inputSnap.sha256)}${inputSnap.reason?` (unavailable: ${inputSnap.reason})`:''} and a diff against base ${short(input.base_sha)} with digest ${short(inputDiff?.sha256)}.`,
      installInput&&checkInput?(evidence.check_input_differs_from_install_input===true?`The install phase changed the candidate source before the check ran: ${installChanged?.slice(0,10).join(', ')}.`:evidence.check_input_differs_from_install_input===false?'The install phase left the candidate source unchanged.':''):'',
      `The envelope ended with exit code ${receipt.exit.code}${receipt.timedOut?' after the time limit':''}${receipt.cancelled?' after a cancel':''}. The output has sha256 ${short(evidence.output_sha256)}${outputTruncated?' and was cut at the output cap':''}.`,
      `The check definition (sha256 ${short(evidence.definition.sha256)}) came from ${source==='base'?'the base commit and is unchanged':source==='modified'?'the candidate source and differs from the base commit':'the owner configuration'}.`,
      masked.outputNote||'',
      differs===true?`The candidate source differs from base${diffPaths.length?` in ${diffPaths.length} path(s): ${diffPaths.slice(0,10).join(', ')}`:''}.`:differs===false?'The candidate source has the same git tree as base.':'Whether the candidate source differs from base is unknown.',
      omissionsIn.length||omissionsPost.length?`${omissionsIn.length+omissionsPost.length} untracked file(s) were left out of the diff${detailArtifact?(detailTruncated?`; artifact ${detailArtifact.artifact_id} holds a partial list`:`; the complete list is in artifact ${detailArtifact.artifact_id}`):''}.`:'',
      mutated?`The command changed the candidate source (git tree after the run ${short((rawPost??post).sha256)}).`:'',
      restoredPaths.length?`The bridge restored ${restoredPaths.length} path(s) outside the job's writable scope (${writeScope==='output_paths'?'output_paths':'scope_paths and output_paths'}) to their pre-run state: ${restoredPaths.slice(0,10).join(', ')}.`:'',
      restoreError?`Restoring paths outside the writable scope reported: ${restoreError}. workspace_result and finish refuse (scope_violation) while such paths remain changed; the job is then stuck and the owner must cancel and resubmit it.`:'',
      masked.paths.length?`${masked.paths.length} sensitive path(s) were masked (read as empty, not writable) inside the sandbox: ${masked.paths.slice(0,10).join(', ')}. A check that needs one of them fails.`:'',
      `Not identified: ${NOT_IDENTIFIED}`,
      'This record states only what the bridge observed. A command or definition label does not show which program the command ran; owner review of the diff stays necessary.'].filter(Boolean).join(' ');
    return evidence;
  }
  async check(requestId,claimId,subject,checkId,worker='dot') {
    const context=this.context(requestId,claimId,subject,true,worker);
    // Execution capability (design section 3): only a host job runs repository code on this host, and never without the executor.
    const execution=this.store.db.prepare('SELECT execution FROM assignments WHERE request_id=?').get(requestId).execution;
    const refuse=reason=>{
      const result=capabilityNotAvailable(execution,reason);
      this.store.transaction(()=>this.store.lifecycle(requestId,'check_skipped',`worker:${subject}`,`check_id=${checkId};${result.reason}`,{claim_id:claimId}));
      return result;
    };
    if(execution!=='host') return refuse();
    // Refuse before resolving worker-controlled check metadata or launching either phase.
    const inputForPolicy=assignmentInput(context.a.assignment);
    const refusal=hostCheckRefusal(context.a.assignment,inputForPolicy.github_repo,checkId);
    if(refusal) return refuse(refusal);
    const readiness=hostReadiness();
    if(!readiness.ready) return refuse(`host_execution (${readiness.reason})`);
    if(this.activeChecks.has(requestId)) {
      const row=this.store.db.prepare("SELECT * FROM check_jobs WHERE request_id=? AND status='running' ORDER BY started_at DESC LIMIT 1").get(requestId);
      const workspace=this.store.db.prepare('SELECT path,base_sha FROM workspaces WHERE request_id=?').get(requestId);
      if(row?.claim_id===claimId&&row.check_id===checkId&&workspace&&row.diff_sha256===this.diff(workspace.path,workspace.base_sha).sha256) return {check_run_id:row.id,status:'running'};
      throw new Error('check already running');
    }
    const {dir,input,claim,a}=this.ensure(requestId,claimId,subject,false,worker),origin=detectCheckWithOrigin(input.github_repo,dir,checkId),spec=origin?.spec;
    if(!spec) { this.store.transaction(()=>this.store.lifecycle(requestId,'check_skipped',`worker:${subject}`,`check_id=${checkId};no_check_configured`,{claim_id:claimId})); return {check_id:checkId,skipped:true,reason:'no_check_configured',available_checks:availableChecks(input.github_repo,dir)}; }
    let currentAvailable;
    try { currentAvailable=availableChecks(input.github_repo,dir); }
    catch { return refuse('host_check_metadata_unavailable: current check metadata cannot be read'); }
    if(!currentAvailable.includes(checkId)) return refuse('host_check_not_available: this check is not in the current metadata catalog');
    const ownerAuthorization=hostCheckAuthorization(input.github_repo,checkId,spec);
    if(origin.from!=='owner_config'||ownerAuthorization.refusal) return refuse(ownerAuthorization.refusal||'host_check_owner_definition_required: this check has no current owner-configured definition');
    // A declared test path that is not in this checkout would make the command run a different set than the check promises: refuse before anything runs.
    const missingTestPath=missingDeclaredTestPath(dir,spec,origin);
    if(missingTestPath) {
      const error=`check_test_path_missing: ${missingTestPath}`;
      this.store.transaction(()=>this.store.lifecycle(requestId,'check_failed','system',`check_id=${checkId};blocker=${error}`,{claim_id:claimId}));
      return {check_id:checkId,status:'failed',blocker:'check_test_path_missing',error,test_paths:spec.test_paths};
    }
    // The same definition resolved from the base commit alone: equal means the candidate did not change what the check is.
    let baseSpec=null;
    try{baseSpec=withCheckMetadata(savedWorkspaceMirror(dir,requestId),input.base_sha,base=>detectCheck(input.github_repo,base,checkId));}catch{}
    // The owner definition and budget authorize execution. A repository edit
    // may lower that budget, but cannot replace the owner command or raise any limit.
    let authorizedBudget,candidateBudget;
    try {
      authorizedBudget=parseHostBudget(ownerAuthorization.spec.host_budget);
      const candidateSpec=workspaceCheck(input.github_repo,dir,checkId);
      candidateBudget=candidateSpec?.host_budget?parseHostBudget(candidateSpec.host_budget):authorizedBudget;
    } catch{return capabilityNotAvailable(execution,'host_budget_missing: declare a valid host_budget in owner configuration');}
    const jobBudget=Object.fromEntries(Object.entries(authorizedBudget).map(([key,value])=>[key,Math.min(value,candidateBudget[key])]));
    const checkRunId=`check_${randomUUID()}`;
    // A diff that git cannot produce (an unreadable path) is recorded as unavailable; the check still runs and its row is kept.
    let preDiff=null,preDiffError=null;try{preDiff=this.diff(dir,input.base_sha);}catch(error){preDiffError=error.message;}
    const diffSha=preDiff?.sha256??'unavailable';
    let baseTree=null;try{baseTree=git(['-C',dir,'rev-parse','--verify',`${input.base_sha}^{tree}`]).trim();}catch{}
    const commonDir=resolveFrom(dir,git(['-C',dir,'rev-parse','--git-common-dir']).trim());
    this.store.transaction(()=>{
      this.store.db.prepare('INSERT INTO check_jobs(id,request_id,claim_id,check_id,diff_sha256,status,started_at,stop_evidence) VALUES(?,?,?,?,?,?,?,?)').run(checkRunId,requestId,claimId,checkId,diffSha,'running',new Date().toISOString(),JSON.stringify({host:{verified:false,receipt_protocol:1,reason:'durable_host_admission_pending'}}));
      this.store.lifecycle(requestId,'check_started',`worker:${subject}`,`check_id=${checkId};check_run_id=${checkRunId}`,{claim_id:claimId});
    });
    // From here every mutation (apply_patch, a second check) is refused until the check ends, so the digest below is of the tree the command starts on.
    this.activeChecks.add(requestId);
    const work=(async()=>{ let scratch=null,hostInvoked=false; try {
      const assertCurrentAuthority=()=>{
        const assignment=this.store.get(requestId),currentClaim=this.store.assertClaim(requestId,claimId,subject,worker);
        if(assignment.status!=='claimed'||assignment.cancelled_at||currentClaim.epoch!==claim.epoch) throw closedWorkspace(assignment,requestId,claimId,claim.epoch,currentClaim.epoch);
      };
      // Observe the host candidate once. The execution copy is private and
      // deliberately not exported back into the host worktree.
      const backend=hostBackend();let evidenceMs=0;
      const timed=async fn=>{const t=Date.now();try{return await fn();}finally{evidenceMs+=Date.now()-t;}};
      fs.mkdirSync(path.join(root,'run'),{recursive:true,mode:0o700});scratch=fs.mkdtempSync(path.join(root,'run','digest-'));
      const firstSnap=await timed(()=>treeDigest(dir,scratch));
      const sourceCopyDir=path.join(scratch,'source-exemptions');fs.mkdirSync(sourceCopyDir,{mode:0o700});
      const masked=sensitiveMasks(dir,input.github_repo,sourceCopyDir);
      // One service reservation and one cumulative envelope cover preparation,
      // install and check. Mutations stay in the private tmpfs execution copy.
      assertCurrentAuthority();
      const launchRefusal=hostCheckRefusal(this.store.get(requestId).assignment,input.github_repo,checkId,spec);
      if(launchRefusal) throw new Error(launchRefusal);
      const hosted=await this.runConfined(requestId,dir,spec.argv,{...spec,host_budget:jobBudget,maskPaths:masked.paths,sourceExemptions:masked.sourceExemptions},{checkRunId,repo:input.github_repo,checkId,expectedSpec:spec,cancelled:()=>{
        try { assertCurrentAuthority(); return false; } catch { return true; }
      }});
      hostInvoked=!hosted.notStarted;
      this.store.recordSandboxStop(checkRunId,'host',{...(hosted.notStarted?{verified:true,reason:'host_supervisor_not_started'}:hosted.stop),receipt_protocol:1});
      assertCurrentAuthority(); // Discard output if authority expired while the host ran.
      const install=hosted.phases.find(p=>p.name==='install')??null;
      const check=hosted.phases.find(p=>p.name==='check')??null;
      const installInput=install?firstSnap:null;
      const checkInput=check?(install?{sha256:null,reason:'private_execution_copy_after_install'}:firstSnap):null;
      const inputDiff=install?null:preDiff,inputDiffError=install?'private_execution_copy_after_install':preDiffError;
      const blocker=hosted.error?redactSecrets(hosted.error).text:(!hosted.stop.verified?'host_stop_unverified':null);
      if(install) this.store.recordSandboxStop(checkRunId,'install',hosted.stop);
      if(check) this.store.recordSandboxStop(checkRunId,'check',hosted.stop);
      const receipt={...(check||install),exit:hosted.exit,timedOut:hosted.timedOut,cancelled:hosted.cancelled};
      const rawCombined=Buffer.concat([...(install?[Buffer.from('INSTALL\n'),install.bytes]:[]),...(check?[Buffer.from('\nCHECK\n'),check.bytes]:[])]);
      const completedPhase=check||install,failed=completedPhase?.exit.code!==0||completedPhase?.timedOut||completedPhase?.cancelled;
      const maskedNote=failed?maskedOutputNote(masked.paths,rawCombined.toString('utf8')):'';
      const diagnostic=Buffer.from(redactSecrets(maskedNote).text);
      const clean=Buffer.from(redactSecrets(rawCombined.toString('utf8')).text);
      const outputCap=Math.min(spec.output_bytes,hosted.budgets.output_bytes);
      const combined=diagnostic.length?Buffer.concat([clean.subarray(0,Math.max(0,outputCap-diagnostic.length)),diagnostic]):clean;
      const output=combined.subarray(0,outputCap);
      assertCurrentAuthority();

      // The host worktree did not receive the execution copy's writes. Do not
      // label host hashes as observations of that copy's phase/post-run tree.
      const post={sha256:null,reason:'private_execution_copy_not_exported'},rawPost=null;
      const postDiff=preDiff,postDiffError=preDiffError;
      const checkedDiff=postDiff?.sha256??null,phase=check?'check':install?'install':'not_started',inputSnap=checkInput||installInput||firstSnap;
      let changed=null,installChanged=null,mutatedPaths=null;
      await timed(async()=>{
        changed=await treePathsChanged(dir,scratch,commonDir,baseTree,inputSnap.sha256);
        installChanged=installInput&&checkInput?await treePathsChanged(dir,scratch,commonDir,installInput.sha256,checkInput.sha256):null;
        mutatedPaths=await treePathsChanged(dir,scratch,commonDir,inputSnap.sha256,(rawPost??post).sha256);
      });
      assertCurrentAuthority();
      const artifact=this.saveArtifact(requestId,claimId,'check-output',output);
      const workerIgnored=this.readIgnoredWritten(requestId);
      const restoredPaths=[],evidenceArgs={rawPost,restoredPaths,restoreError:null,writeScope:'private_execution_copy',masked:{...masked,outputNote:maskedNote},input,spec,workerIgnored,origin,baseSpec,backend,baseTree,installInput,checkInput,candidateInput:firstSnap,inputDiff,inputDiffError,changed,installChanged,mutatedPaths,post,postDiff,postDiffError,receipt,phase,output,stops:{...(install?{install:install.stop}:{}),...(check?{check:check.stop}:{})},outputTruncated:rawCombined.length+diagnostic.length>outputCap||hosted.truncated,evidenceMs,blocker};
      const detail=boundedDetail({changed_paths:changed??inputDiff?.paths??[],input_diff_omissions:inputDiff?.omissions??[],post_run_diff_omissions:postDiff?.omissions??[],install_changed_paths:installChanged??[],tree_mutated_paths:mutatedPaths??[],restored_out_of_scope_paths:restoredPaths,masked_sensitive_paths:masked.paths});
      const detailArtifact=detail?this.saveArtifact(requestId,claimId,'check-evidence-detail',detail):null;
      const detailParsed=detail?JSON.parse(detail.toString('utf8')):null,detailTruncated=detailParsed&&!detailParsed.complete?detailParsed.truncated:null;
      const evidence=redactOutput(this.buildEvidence({...evidenceArgs,detailArtifact,detailTruncated}));
      evidence.host_budget={dependencies:hosted.dependencies,limits:hosted.budgets,usage:hosted.usage,usage_complete:hosted.usage_complete,error:blocker,stop:hosted.stop};
      evidence.execution_storage='private_tmpfs_copy_not_exported';
      evidence.claims.source_observation='Host candidate observed before copying. Install/check mutations in the private execution copy are not exported or hashed by this receipt.';
      evidence.observed+=' Execution used a private tmpfs copy; phase and post-run hashes of that copy are unavailable.';
      const result={id:checkRunId,check_run_id:checkRunId,status:blocker?'failed':'completed',...(blocker?{blocker,error:blocker}:{}),request_id:requestId,claim_id:claimId,check_id:checkId,test_paths:evidence.test_paths,
        phase,exit_code:receipt.exit.code,timed_out:receipt.timedOut,cancelled:receipt.cancelled,output_artifact_id:artifact.artifact_id,
        output_sha256:artifact.sha256,diff_sha256:checkedDiff??diffSha,output_preview:previewHeadTail(redactSecrets(output.toString('utf8')).text),duration_ms:hosted.duration_ms,evidence_ms:evidenceMs,trust:evidence.trust,evidence};
      const saved=this.recordCheckResult(result,rawCombined,checkedDiff);
      this.reconcileHostStops(requestId);
      return saved;
    } catch(error) {
      if(error.hostInvoked) hostInvoked=true;
      if(!hostInvoked) this.store.recordSandboxStop(checkRunId,'host',{verified:true,reason:'host_not_started',receipt_protocol:1});
      this.store.transaction(()=>{
        this.store.db.prepare("UPDATE check_jobs SET status='failed',error=?,finished_at=? WHERE id=?").run(error.message,new Date().toISOString(),checkRunId);
        this.store.lifecycle(requestId,'check_failed','system',checkOutcome({id:checkRunId,check_id:checkId,status:'failed'})[1],{claim_id:claimId});
      });
      this.reconcileHostStops(requestId);
      return {check_run_id:checkRunId,status:'failed',error:error.message};
    } finally {if(scratch) fs.rmSync(scratch,{recursive:true,force:true});this.activeChecks.delete(requestId);this.checkEffects.delete(requestId);} })();
    this.checkEffects.set(requestId,work);
    return checkResponse(work,{check_run_id:checkRunId,status:'running'},this.checkResponseOptions);
  }
  // Classify original output before redacting metadata and storing the row atomically;
  // preview truncation must not discard skipped-segment metadata.
  recordCheckResult(result,output,checkedDiff=result.diff_sha256) {
    const saved=redactOutput(withCheckCoverage(result,output.toString('utf8')));
    this.store.transaction(()=>{
      const grant=this.store.db.prepare('SELECT subject,worker FROM claims WHERE request_id=? AND claim_id=?').get(saved.request_id,saved.claim_id);if(!grant) throw new Error('invalid claim');this.store.assertClaim(saved.request_id,saved.claim_id,grant.subject,grant.worker);const current=this.store.get(saved.request_id);if(current.status!=='claimed'||current.cancelled_at) throw closedWorkspace(current,saved.request_id,saved.claim_id);
      this.store.db.prepare('INSERT INTO check_runs(id,request_id,claim_id,check_id,exit_code,timed_out,output_artifact_id,output_sha256,duration_ms,created_at,diff_sha256,phase,evidence) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(saved.id,saved.request_id,saved.claim_id,saved.check_id,saved.exit_code,Number(saved.timed_out),saved.output_artifact_id,saved.output_sha256,saved.duration_ms,new Date().toISOString(),checkedDiff,saved.phase,JSON.stringify(saved.evidence));
      this.store.db.prepare('UPDATE check_jobs SET status=?,error=?,output_preview=?,finished_at=? WHERE id=?')
        .run(saved.status,saved.blocker??null,saved.output_preview,new Date().toISOString(),saved.id);
      const [type,reason]=saved.blocker?['check_failed',`check_id=${saved.check_id};check_run_id=${saved.id};blocker=${saved.blocker}${saved.check_summary?';'+saved.check_summary:''}`]:checkOutcome(saved,saved);
      this.store.lifecycle(saved.request_id,type,'system',reason,{claim_id:saved.claim_id});
    });
    return saved;
  }
  async runConfined(requestId,dir,command,spec,{cancelled,checkRunId,repo=null,checkId=null,expectedSpec=null}={}) {
    // Policy is rechecked at the only launch boundary; repository metadata
    // cannot opt the operator in or bypass the whole-repository read grant.
    const refusal=hostCheckRefusal(this.store.get(requestId).assignment,repo,checkId,expectedSpec);
    if(refusal) throw new Error(refusal);
    const budgets=parseHostBudget(spec.host_budget);
    budgets.wall_ms=Math.min(budgets.wall_ms,spec.timeout_ms??budgets.wall_ms);
    budgets.output_bytes=Math.min(budgets.output_bytes,spec.output_bytes??budgets.output_bytes);
    return runHostBudget({dir,budgets,...(checkRunId?{checkRunId,receiptDir:path.join(root,'host-receipts')}:{}),maskPaths:spec.maskPaths,sourceExemptions:spec.sourceExemptions,
      phases:[...(spec.install_argv?[{name:'install',argv:spec.install_argv}]:[]),{name:'check',argv:command}],
      cancelled:cancelled??(()=>this.store.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(requestId)?.status!=='claimed')});
  }

  // The files a diff of this assignment may carry: null (all) for implementation, the output_paths for read-only.
  diffFilter(assignment) { return assignment.execution_scope!=='implementation'&&outputsOf(assignment).size?outputsOf(assignment):null; }
  // The scope an implementation diff must stay inside (null: unrestricted, a read-only job, which diffFilter handles, or a review: its worktree is the PR head, so its diff against base is the PR's files).
  diffScope(request) { return request.assignment.execution_scope==='implementation'&&!request.review?scopeOf(request.assignment):null; }
  result(requestId,claimId,subject,worker='dot') {
    if(!this.store.mayAct(worker,requestId)) throw new Error('assignment not found');
    const a=this.store.get(requestId);this.store.assertClaim(requestId,claimId,subject,worker);
    if(a.status!=='claimed'||a.cancelled_at) throw closedWorkspace(a,requestId,claimId);
    const artifacts=this.store.db.prepare("SELECT COALESCE(client_artifact_id,id) id,size,sha256 FROM artifacts WHERE request_id=? AND claim_id=? AND kind='upload' AND sealed=1").all(requestId,claimId);
    if(!a.assignment.inputs?.some(input=>input.github_repo)) return {checks:[],artifacts:artifacts};
    const {dir,input}=this.ensure(requestId,claimId,subject,true,worker);
    // A diff git cannot produce (an unreadable path) is reported as unavailable instead of failing the whole result.
    let diff,diffError=null;try{diff=this.diff(dir,input.base_sha,this.diffFilter(a.assignment),this.diffScope(a));}catch(error){if(error.outputViolation||error.scopeViolation) throw error;diffError=error.message;diff={patch:'',sha256:null,bytes:0,omissions:[],paths:[]};}
    const checks=this.store.db.prepare('SELECT j.id check_run_id,j.status,j.check_id,CASE WHEN j.status=\'completed\' THEN COALESCE(r.diff_sha256,j.diff_sha256) ELSE j.diff_sha256 END diff_sha256,j.error,j.output_preview,r.phase,r.exit_code,r.timed_out,r.output_artifact_id,r.output_sha256,r.duration_ms,r.evidence FROM check_jobs j LEFT JOIN check_runs r ON r.id=j.id WHERE j.request_id=? ORDER BY j.started_at').all(requestId).map(withEvidence).map(check=>({...check,id:check.check_run_id,applies_to_current_diff:diff.sha256!==null&&(check.evidence?check.evidence.input_diff_sha256:check.diff_sha256)===diff.sha256,matches_current_diff:diff.sha256!==null&&(check.evidence?check.evidence.input_diff_sha256:check.diff_sha256)===diff.sha256}));
    let display=redactSecrets(diff.patch).text;
    if(/^GIT binary patch$/m.test(diff.patch)) display='[binary diff withheld; owner patch required]';
    if(diff.patch) {
      // Ordinary hunks may start inside a PEM body. Inspect complete tracked context
      // before displaying any hunk; the owner-only patch and its digest stay intact.
      try {
        const full=git(['-C',dir,'diff','--no-ext-diff','--no-textconv','--unified=2147483647',this.diffFilter(a.assignment)?'HEAD':input.base_sha]);
        if(privateKeyHeader.test(full)) display='[redacted secret: diff contains private key material; owner patch required]';
      } catch { display='[diff preview unavailable: complete secret scan failed]'; }
    }
    return redactOutput({base_sha:input.base_sha,head_sha:input.head_sha||null,execution:a.execution,...(checks.some(c=>c.evidence)?{not_identified:NOT_IDENTIFIED}:{}),output_redaction_version:1,diff_sha256:diff.sha256,...(diffError?{diff_unavailable:diffError}:{}),diff_bytes:diff.bytes,diff_omissions:diff.omissions.slice(0,CHANGED_PATHS_SHOWN),diff_omissions_total:diff.omissions.length,diff_preview:display.slice(0,32768),diff_preview_applicable:false,...this.availableChecksResponse(a.assignment,dir,a.execution),checks,artifacts});
  }
  snapshot(requestId,claimId,subject,worker='dot') {
    const rollback=[];
    try {return this.store.transaction(()=>this.snapshotInTransaction(requestId,claimId,subject,worker,cleanup=>rollback.push(cleanup)));}
    catch(error) {for(const cleanup of rollback)cleanup();throw error;}
  }
  snapshotInTransaction(requestId,claimId,subject,worker,onRollback) {
    if(!this.store.db.isTransaction)throw new Error('snapshot requires a caller-owned transaction');
    if(this.activeChecks.has(requestId))throw new Error('check still running');
    const row=this.store.db.prepare('SELECT * FROM workspaces WHERE request_id=?').get(requestId);
    if(!row)return null;
    const result=this.result(requestId,claimId,subject,worker),request=this.store.get(requestId);
    const diff=this.diff(row.path,result.base_sha,this.diffFilter(request.assignment),this.diffScope(request));
    const patch=this.saveArtifactInTransaction(requestId,claimId,'patch',Buffer.from(diff.patch),`art_${randomUUID()}`,onRollback);
    return {...result,artifacts:this.store.sealedUploads(requestId),patch_artifact:patch};
  }
  chunk(requestId,claimId,subject,id,offset,base64,final=false,expected,worker='dot',onMutation=null) {
    return this.store.transaction(()=>this.chunkInTransaction(requestId,claimId,subject,id,offset,base64,final,expected,worker,onMutation));
  }
  chunkInTransaction(requestId,claimId,subject,id,offset,base64,final=false,expected,worker='dot',onMutation=null) {
    if(!this.store.db.isTransaction) throw new Error('chunk requires a caller-owned transaction');
    if(onMutation!==null&&typeof onMutation!=='function') throw new Error('invalid native upload callback');
    if(!this.store.mayAct(worker,requestId)) throw new Error('assignment not found');
    const a=this.store.get(requestId);this.store.assertClaim(requestId,claimId,subject,worker);
    if(a.status!=='claimed'||a.cancelled_at) throw closedWorkspace(a,requestId,claimId);
    if(typeof id!=='string'||!/^art_[a-zA-Z0-9_-]{8,128}$/.test(id)) throw new Error('invalid artifact_id: must match art_ followed by 8 to 128 letters, digits, _ or -');
    if(!Number.isInteger(offset)||offset<0) throw new Error('invalid offset: must be a whole number, 0 or more, equal to the bytes stored so far');
    if(typeof base64!=='string') throw new Error('invalid data_base64: must be a string (an empty string is allowed)');
    if(!/^([A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error('invalid data_base64: must be standard padded base64 (A-Z a-z 0-9 + /) without line breaks or white space');
    const bytes=Buffer.from(base64,'base64');
    if(bytes.length>65536) throw new Error('chunk too large');
    const current=this.store.get(requestId);this.store.assertClaim(requestId,claimId,subject,worker);if(current.status!=='claimed'||current.cancelled_at) throw closedWorkspace(current,requestId,claimId);
    let row=this.store.db.prepare("SELECT * FROM artifacts WHERE request_id=? AND COALESCE(client_artifact_id,id)=? AND kind='upload'").get(requestId,id);
    const previous=row?{...row}:null;
    const publishMutation=duplicate=>{
      if(!onMutation) return;
      const native=this.store.db.prepare('SELECT * FROM artifacts WHERE id=?').get(row.id);
      const actual=fs.readFileSync(native.path);
      if(actual.length!==native.size) throw new Error('artifact integrity failure');
      const result=onMutation({row:native,duplicate,offset,chunkSize:bytes.length,chunkSha256:sha(actual.subarray(offset,offset+bytes.length)),size:actual.length,sha256:sha(actual),reference:native.id});
      if(result&&typeof result.then==='function') throw new Error('async native upload callback forbidden');
    };
    if(row&&row.claim_id!==claimId) throw new Error('artifact binding mismatch');
    if(!row) {
      if(offset!==0) throw new Error('wrong upload offset');
      const globalId='art_'+sha(Buffer.from(JSON.stringify([requestId,claimId,id]))).slice(0,48);
      if(this.store.db.prepare('SELECT 1 FROM artifacts WHERE id=?').get(globalId)) throw new Error('artifact id collision');
      const file=path.join(artifacts,globalId);
      this.store.db.prepare('INSERT INTO artifacts(id,request_id,claim_id,kind,path,size,sealed,created_at,retention_until,client_artifact_id,origin_claim_id,origin_epoch) VALUES(?,?,?,?,?,?,0,?,?,?,?,(SELECT epoch FROM claims WHERE request_id=?))')
        .run(globalId,requestId,claimId,'upload',file,0,new Date().toISOString(),this.retention(requestId),id,claimId,requestId);
      row=this.store.db.prepare('SELECT * FROM artifacts WHERE id=?').get(globalId);
    }
    if(!fs.existsSync(row.path)) {
      if(row.size!==0) throw new Error('upload file missing');
      fs.writeFileSync(row.path,Buffer.alloc(0),{flag:'wx',mode:0o600});
    }
    const readAt=position=>{const previous=Buffer.alloc(bytes.length),fd=fs.openSync(row.path,'r');try{fs.readSync(fd,previous,0,bytes.length,position);}finally{fs.closeSync(fd);}return previous;};
    if(row.sealed) {
      if(final&&typeof expected==='string'&&expected.toLowerCase()===row.sha256&&offset+bytes.length===row.size&&readAt(offset).equals(bytes)) {publishMutation(true);return {artifact_id:id,offset:row.size,sealed:true,sha256:row.sha256};}
      throw new Error('artifact sealed');
    }
    const actual=fs.statSync(row.path).size;
    if(actual<row.size) throw new Error('upload file truncated');
    if(actual>row.size) {
      const partial=actual-row.size;
      if(row.size+bytes.length>8*1024*1024) throw new Error('artifact too large');
      if(offset!==row.size||partial>bytes.length||!readAt(offset).subarray(0,partial).equals(bytes.subarray(0,partial))) throw new Error('interrupted upload differs; operator repair required');
      if(partial<bytes.length) {const fd=fs.openSync(row.path,'a');try{let written=partial;while(written<bytes.length)written+=fs.writeSync(fd,bytes,written,bytes.length-written);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
      this.store.db.prepare('UPDATE artifacts SET size=? WHERE id=?').run(row.size+bytes.length,row.id);
    } else if(offset<row.size) {
      if(offset+bytes.length>row.size||!readAt(offset).equals(bytes)) throw new Error('conflicting chunk retry');
    } else if(offset===row.size) {
      if(row.size+bytes.length>8*1024*1024) throw new Error('artifact too large');
      const fd=fs.openSync(row.path,'a');try{let written=0;while(written<bytes.length)written+=fs.writeSync(fd,bytes,written,bytes.length-written);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      this.store.db.prepare('UPDATE artifacts SET size=? WHERE id=?').run(row.size+bytes.length,row.id);
    } else throw new Error('wrong upload offset');
    const size=fs.statSync(row.path).size;
    if(final) {
      if(typeof expected!=='string'||!expected) throw new Error('final chunk needs sha256: the 64 hex digits of the whole file');
      expected=expected.toLowerCase();
      const digest=sha(fs.readFileSync(row.path));
      if(digest!==expected) throw new Error('artifact digest mismatch');
      this.store.db.prepare('UPDATE artifacts SET sha256=?,sealed=1 WHERE id=?').run(digest,row.id);
    }
    publishMutation(!!previous&&previous.size===size&&!!previous.sealed===final);
    return {artifact_id:id,offset:size,sealed:final,sha256:final?expected:null};
  }
  artifact(id,requestId) { this.store.assertProtocolAvailable(requestId);const row=this.store.db.prepare('SELECT * FROM artifacts WHERE id=? AND request_id=? AND sealed=1').get(id,requestId);if(!row) throw new Error('artifact not found');const bytes=fs.readFileSync(row.path);if(bytes.length!==row.size||sha(bytes)!==row.sha256) throw new Error('artifact integrity failure');return {row,bytes}; }
}
