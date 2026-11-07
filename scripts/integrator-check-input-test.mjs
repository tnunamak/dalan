import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {verifySealedResult} from '../src/integrator.mjs';
const fixtureParent=path.join(os.homedir(),'.tmp/dalan-integrator');
fs.mkdirSync(fixtureParent,{recursive:true});
const root=fs.mkdtempSync(path.join(fixtureParent,'check-input-'));
async function scenario(name,files,changed,expected) {
 const repo=path.join(root,name);fs.mkdirSync(repo);
 const git=(...args)=>execFileSync('git',['-C',repo,'-c','user.name=test','-c','user.email=test@example.invalid',...args],{encoding:'utf8'}).trim();
 git('init','-q','-b','main');for(const [f,v] of Object.entries(files))fs.writeFileSync(path.join(repo,f),v);git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD');
 for(const [f,v] of Object.entries(changed))fs.writeFileSync(path.join(repo,f),v);git('add','.');const patch=Buffer.from(git('diff','--cached','--binary')+'\n');git('reset','--hard','-q');
 const store=new Store(':memory:');try {const result=await verifySealedResult({store,repoDir:repo,targetBaseRef:base,scratchRoot:root,sealedResult:{request_id:name,assignment:{execution_scope:'implementation',inputs:[{github_repo:'example/repo',base_sha:base}]},patch,patch_sha256:createHash('sha256').update(patch).digest('hex'),patch_base_sha:base}});
 assert.equal(result.status,'owner_approval_required');assert.match(result.verification.error,/patch changes how it is checked/);assert.deepEqual(result.verification.checks[0].changed_inputs,expected);assert.equal(result.verification_recorded,true);
 } finally {store.db.close();}
}
test('changed pinned runner requires owner approval',()=>scenario('runner',{'.dot-bridge.json':JSON.stringify({checks:{trusted:{argv:['/runtime/node','runner.mjs']}}}),'runner.mjs':'process.exit(1)\n'},{'runner.mjs':'process.exit(0)\n'},['runner.mjs']));
test('changed npm test and lifecycle hooks require owner approval',()=>scenario('npm',{'package.json':JSON.stringify({scripts:{test:'node test.js',pretest:'node pre.js'}}),'test.js':'', 'pre.js':''},{'package.json':JSON.stringify({scripts:{test:'true',pretest:'true'}})},['package.json']));
process.on('exit',()=>fs.rmSync(root,{recursive:true,force:true}));
test('changed check metadata requires owner approval',()=>scenario('metadata',{'.dot-bridge.json':JSON.stringify({checks:{trusted:{argv:['/runtime/node','-e','0']}}})},{'.dot-bridge.json':JSON.stringify({checks:{trusted:{argv:['/runtime/node','-e','1']}}})},['.dot-bridge.json']));
test('changed lockfile requires owner approval when check installs',()=>scenario('lock',{'package.json':JSON.stringify({scripts:{test:'node test.js'},dependencies:{x:'1.0.0'}}),'package-lock.json':'{}','test.js':''},{'package-lock.json':'{"changed":true}'},['package-lock.json']));

for(const file of ['pyproject.toml','pytest.ini','Cargo.toml','go.mod','Makefile','uv.lock','Cargo.lock','go.sum','npm-shrinkwrap.json','package-lock.json','pnpm-lock.yaml','yarn.lock']) {
 test(`changed ${file} requires owner approval without a separate install`,()=>scenario(`metadata-${file}`,{
  '.dot-bridge.json':JSON.stringify({checks:{trusted:{argv:['/runtime/node','-e','0']}}}),[file]:'original\n'
 },{[file]:'changed\n'},[file]));
}
for(const [name,files,changed] of [
 ['python',{'pyproject.toml':'[tool.pytest.ini_options]\ntestpaths = ["tests"]\n'},{'pyproject.toml':'[tool.pytest.ini_options]\ntestpaths = ["other"]\n'}],
 ['pytest',{'pytest.ini':'[pytest]\ntestpaths = tests\n'},{'pytest.ini':'[pytest]\ntestpaths = other\n'}],
 ['rust',{'Cargo.toml':'[package]\nname = "fixture"\nversion = "0.1.0"\n'},{'Cargo.toml':'[package]\nname = "changed"\nversion = "0.1.0"\n'}],
 ['go',{'go.mod':'module example.invalid/fixture\n'},{'go.mod':'module example.invalid/changed\n'}],
 ['make',{'Makefile':'test:\n\ttrue\n'},{'Makefile':'test:\n\tfalse\n'}],
]) test(`derived ${name} check cannot trust changed metadata`,()=>scenario(`derived-${name}`,files,changed,Object.keys(changed)));
