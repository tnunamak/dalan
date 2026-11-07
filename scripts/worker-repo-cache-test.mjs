import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mirrorPath } from '../src/projects.mjs';
const root=fs.mkdtempSync(path.join(os.homedir(),'.tmp','worker-cache-test-'));
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const previous=process.env.DOT_BRIDGE_WORKSPACE_ROOT;
const previousHome=process.env.HOME;
process.env.DOT_BRIDGE_WORKSPACE_ROOT=root;
process.env.HOME=root;
const {savedWorkspaceMirror}=await import('../src/workspace.mjs');
const {prepareGithubRepo}=await import('../src/projects.mjs');
const {admitImplementation}=await import('../src/check-readiness.mjs');
try {
  const source=path.join(root,'source');fs.mkdirSync(source);git('-C',source,'init','-q');git('-C',source,'config','user.name','fixture');git('-C',source,'config','user.email','fixture@example.test');
  fs.writeFileSync(path.join(source,'private.txt'),'alpha object\n');git('-C',source,'add','private.txt');git('-C',source,'commit','-qm','fixture');const sha=git('-C',source,'rev-parse','HEAD');
  const legacy=mirrorPath('acme/project');fs.mkdirSync(path.dirname(legacy),{recursive:true});git('init','--bare','-q',legacy);git('-C',legacy,'fetch','-q',source,sha);
  process.env.DOT_BRIDGE_GITHUB_URL_ACME_PROJECT=source;
  const alpha=prepareGithubRepo({github_repo:'acme/project',base_sha:sha},{worker:'alpha'});
  const beta=prepareGithubRepo({github_repo:'acme/project',base_sha:sha},{worker:'beta'});
  assert.notEqual(alpha,beta);git('-C',alpha,'cat-file','-e',sha);git('-C',beta,'cat-file','-e',sha);
  const commitObject=path.join(alpha,'objects',sha.slice(0,2),sha.slice(2));assert.ok(fs.existsSync(commitObject));assert.ok(fs.existsSync(path.join(beta,'objects',sha.slice(0,2),sha.slice(2))));
  const alphaObject=fs.statSync(commitObject),betaObject=fs.statSync(path.join(beta,'objects',sha.slice(0,2),sha.slice(2)));assert.ok(alphaObject.dev!==betaObject.dev||alphaObject.ino!==betaObject.ino,'worker caches do not hardlink object files');
  fs.unlinkSync(commitObject);assert.throws(()=>git('-C',alpha,'cat-file','-e',sha));git('-C',beta,'cat-file','-e',sha);
  const ready=admitImplementation({execution_scope:'implementation',inputs:[{github_repo:'acme/project',base_sha:sha}],scope_paths:['README.md'],brief:'Inspect README.md'},{execution:'worker',worker:'beta'});assert.ok(ready,'check readiness uses the resolved worker cache');
  const requestId='req_workspacefixture123456';const workspace=path.join(root,'worktrees',requestId);fs.mkdirSync(path.dirname(workspace),{recursive:true});git('-C',legacy,'worktree','add','--detach',workspace,sha);
  assert.equal(savedWorkspaceMirror(workspace,requestId),legacy,'a saved legacy common directory remains discoverable for an existing workspace');
  const {Store}=await import('../src/store.mjs');
  const {parseWorkers}=await import('../src/workers.mjs');
  const {Workspace}=await import('../src/workspace.mjs');
  const store=new Store(path.join(root,'bridge.db'),{workers:parseWorkers({workers:{alpha:{repos:['acme/project']},beta:{repos:[]}}},{builtin:true})});
  try {
    const assignment={schema_version:1,request_id:requestId,brief:'Continue the existing checked-out source',inputs:[{github_repo:'acme/project',base_sha:sha}],scope_paths:['private.txt'],expected_output:'One line',execution_scope:'read-only'};
    store.submit(assignment,{mode:'none'},null,'synthetic-owner',false,null,'normal',null,assignment,null,'alpha');
    const claim=store.claim(requestId,'stable-worker','holder',6,null,'alpha','retained-run');
    store.db.prepare('INSERT INTO workspaces(request_id,claim_id,base_sha,path,created_at) VALUES(?,?,?,?,?)').run(requestId,claim.claim_id,sha,workspace,store.stamp());
    const bridgeWorkspace=new Workspace(store,false);
    const read=bridgeWorkspace.read(requestId,claim.claim_id,'holder','private.txt',1,20,'alpha');
    assert.match(read.text,/alpha object/,'the live saved grant must read its legacy workspace even while its new scoped cache is missing an object');
    assert.equal(store.db.prepare('SELECT path FROM workspaces WHERE request_id=?').get(requestId).path,workspace);
    assert.throws(()=>bridgeWorkspace.read(requestId,claim.claim_id,'holder','private.txt',1,20,'beta'),/assignment not found/,'the saved legacy workspace is not another worker’s fallback');
    assert.equal(store.finish(requestId,claim.claim_id,'completed','continued','one line','holder',null,'alpha').duplicate,false,'the retained grant still finishes normally');
  } finally {store.db.close();}
  for(const mirror of [alpha,beta]) assert.equal(fs.existsSync(path.join(mirror,'objects','info','alternates')),false,'worker caches do not share alternate object stores');
} finally { if(previous===undefined) delete process.env.DOT_BRIDGE_WORKSPACE_ROOT;else process.env.DOT_BRIDGE_WORKSPACE_ROOT=previous;if(previousHome===undefined)delete process.env.HOME;else process.env.HOME=previousHome;fs.rmSync(root,{recursive:true,force:true}); }
console.log('PASS worker cache isolation, independent Git objects, and saved legacy workspace continuation');
