import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultPath,rootWarnings} from '../src/paths.mjs';
import {workspaceCheck} from '../src/projects.mjs';
test('passed-over warnings name missing files only for populated incomplete config, data and state roots',()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-root-warnings-'));
 try {
  for(const [area,parent,missing] of [['config','.config','limits.json'],['data','.local/share','bridge.db.secrets/storage.key'],['state','.local/state','requests.jsonl']]) {
   const home=path.join(base,area),legacy=path.join(home,parent,'dot-bridge'),current=path.join(home,parent,'dalan');
   fs.mkdirSync(path.dirname(path.join(legacy,missing)),{recursive:true});fs.writeFileSync(path.join(legacy,missing),'private legacy contents');
   assert.deepEqual(rootWarnings(home),[],'an absent new root is not passed over');
   fs.mkdirSync(path.join(current,'empty-subdir'),{recursive:true});fs.writeFileSync(path.join(current,'.keep'),'');
   assert.equal(defaultPath(home,parent+'/dot-bridge'),legacy);assert.deepEqual(rootWarnings(home),[],'empty scaffolding is not passed over');
   fs.writeFileSync(path.join(current,'keep'),'private current contents');
   assert.equal(defaultPath(home,parent+'/dot-bridge'),legacy);
   assert.deepEqual(rootWarnings(home),[{area,chosen:legacy,passed_over:current,missing:[missing]}]);
   fs.mkdirSync(path.dirname(path.join(current,missing)),{recursive:true});fs.writeFileSync(path.join(current,missing),'replacement contents');
   assert.equal(defaultPath(home,parent+'/dot-bridge'),current);assert.deepEqual(rootWarnings(home),[],'a complete new root wins without warning');
  }
 } finally {fs.rmSync(base,{recursive:true,force:true});}
});
test('passed-over warnings report each area once and keep signal token rotation grouped',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-root-warning-areas-'));
 try {
  const expected=[];
  for(const [area,parent,missing] of [['config','.config','limits.json'],['data','.local/share','bridge.db'],['state','.local/state','requests.jsonl']]) {
   const legacy=path.join(home,parent,'dot-bridge'),current=path.join(home,parent,'dalan');
   fs.mkdirSync(legacy,{recursive:true});fs.mkdirSync(current,{recursive:true});
   fs.writeFileSync(path.join(legacy,missing),'legacy');fs.writeFileSync(path.join(current,'keep'),'current');
   expected.push({area,chosen:legacy,passed_over:current,missing:[missing]});
  }
  const legacy=expected[0].chosen,current=expected[0].passed_over;
  for(const name of ['signal-token.worker-a','signal-token.old'])fs.writeFileSync(path.join(legacy,name),'private token value');
  expected[0].missing.push('signal-token.old','signal-token.worker-a');assert.deepEqual(rootWarnings(home),expected);
  fs.writeFileSync(path.join(current,'signal-token'),'rotated private token');expected[0].missing=['limits.json'];
  assert.deepEqual(rootWarnings(home),expected);assert.equal(defaultPath(home,'.config/dot-bridge'),legacy);
  fs.writeFileSync(path.join(current,'limits.json'),'current');assert.equal(defaultPath(home,'.config/dot-bridge'),current);
  assert.deepEqual(rootWarnings(home),expected.slice(1));
 } finally {fs.rmSync(home,{recursive:true,force:true});}
});
test('paths exposes warning metadata in JSON and on plain stderr without changing selected stdout',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-paths-warning-cli-'));
 try {
  const legacy=path.join(home,'.config/dot-bridge'),current=path.join(home,'.config/dalan'),privateValue='private-fixture-must-not-be-printed';
  fs.mkdirSync(legacy,{recursive:true});fs.mkdirSync(current,{recursive:true});fs.writeFileSync(path.join(legacy,'limits.json'),privateValue);
  const cli=(args)=>{const result=spawnSync(process.execPath,['bin/dalan.mjs','paths',...args],{env:{HOME:home,PATH:process.env.PATH},encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert(!result.stdout.includes(privateValue));assert(!result.stderr.includes(privateValue));return result;};
  for(const variant of ['empty','partial','complete']) {
   if(variant==='partial')fs.writeFileSync(path.join(current,'keep'),privateValue);
   if(variant==='complete')fs.writeFileSync(path.join(current,'limits.json'),privateValue);
   const warnings=variant==='partial'?[{area:'config',chosen:legacy,passed_over:current,missing:['limits.json']}]:[],chosen=variant==='complete'?current:legacy;
   const json=cli(['--json']),plain=cli([]),selected=cli(['--config-root']);
   assert.equal(JSON.parse(json.stdout).config_dir,chosen);assert.deepEqual(JSON.parse(json.stdout).warnings,warnings);assert(!json.stderr.includes('root_passed_over'));
   assert.equal(JSON.parse(plain.stdout).config_dir,chosen);assert.equal(selected.stdout.trim(),chosen);
   for(const result of [plain,selected]) {
    const lines=result.stderr.split('\n').filter(line=>line.startsWith('dalan: WARNING root_passed_over '));assert.equal(lines.length,warnings.length);
    if(warnings.length)for(const value of ['config',legacy,current,'limits.json'])assert(lines[0].includes(value));
   }
  }
 } finally {fs.rmSync(home,{recursive:true,force:true});}
});
test('old-only, new-only, neither and both select roots without moving data',()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-paths-'));
 try {
  for(const area of ['.config','.local/share','.local/state','.tmp']) for(const variant of ['old','new','neither','both']) {
   const home=path.join(base,area.replaceAll('/','-')+'-'+variant),legacy=path.join(home,area,'dot-bridge'),current=path.join(home,area,'dalan');
   for(const [name,dir] of [['old',legacy],['new',current]]) if(variant===name||variant==='both'){fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'keep'),name);}
   const wanted=variant==='old'?legacy:current;
   assert.equal(defaultPath(home,area+'/dot-bridge','secret'),path.join(wanted,'secret'));
   if(variant==='old'||variant==='both')assert.equal(fs.readFileSync(path.join(legacy,'keep'),'utf8'),'old');
   if(variant==='neither')assert(!fs.existsSync(home));
  }
  for(const variant of ['old','new','neither','both']) {
   const home=path.join(base,'cache-'+variant);
   for(const [kind,name] of [['old','.dot-bridge'],['new','.dalan']])if(variant===kind||variant==='both')fs.mkdirSync(path.join(home,name),{recursive:true});
   assert.equal(defaultPath(home,'.dot-bridge/prepared-node-modules'),path.join(home,variant==='old'?'.dot-bridge':'.dalan','prepared-node-modules'));
  }
  const home=path.join(base,'existing-install');fs.mkdirSync(path.join(home,'.config/dot-bridge'),{recursive:true});
  assert.equal(defaultPath(home,'.local/share/dot-bridge'),path.join(home,'.local/share/dot-bridge'));
 } finally {fs.rmSync(base,{recursive:true,force:true});}
});
test('fresh CLI init creates dalan config; old homes preserve their keys and roster',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-init-'));
 try {
  for(const legacy of [false,true]) {
   const home=path.join(root,legacy?'old':'new'),config=path.join(home,'.config',legacy?'dot-bridge':'dalan');
   if(legacy){fs.mkdirSync(config,{recursive:true,mode:0o700});fs.writeFileSync(path.join(config,'operator.key'),'synthetic-existing-key\n',{mode:0o600});}
   const result=spawnSync(process.execPath,['bin/dalan.mjs','init','--worker','local','--public-url','https://bridge.example.test','--json'],{env:{HOME:home,PATH:process.env.PATH},encoding:'utf8'});
   assert.equal(result.status,0,result.stderr);assert(fs.existsSync(path.join(config,'workers.json')));
   assert.equal(fs.statSync(path.join(config,'as-jwks.json')).mode&0o777,0o600);
   if(legacy){assert.equal(fs.readFileSync(path.join(config,'operator.key'),'utf8'),'synthetic-existing-key\n');assert(!fs.existsSync(path.join(home,'.config/dalan')));}
  }
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('repository metadata prefers .dalan.json and keeps the legacy fallback',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-repo-config-'));
 const write=(file,value)=>fs.writeFileSync(path.join(dir,file),JSON.stringify({checks:{probe:{argv:['node','-e',value]}}}));
 try {
  write('.dot-bridge.json','old');assert.equal(workspaceCheck('acme/repo',dir,'probe').argv[2],'old');
  write('.dalan.json','new');assert.equal(workspaceCheck('acme/repo',dir,'probe').argv[2],'new');
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('accidental database migration guard protects both product names',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-db-guard-'));
 try {
  for(const name of ['dot-bridge','dalan']) {
   const home=path.join(root,name);fs.mkdirSync(home);
   const file=path.join(home,'.local/share',name,'bridge.db');
   const result=spawnSync(process.execPath,['--input-type=module','-e',`import {Store} from './src/store.mjs';try {new Store(${JSON.stringify(file)});process.exitCode=1;}catch(error){if(!error.message.includes('accidental-migration guard'))throw error;}`],{env:{HOME:home,PATH:process.env.PATH},encoding:'utf8'});
   assert.equal(result.status,0,result.stderr);assert.deepEqual(fs.readdirSync(home),[]);
  }
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('empty or uninitialized dalan siblings cannot hide populated legacy roots',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-empty-siblings-'));
 try {
  for(const area of ['.config','.local/share','.local/state','.tmp']) {
   const old=path.join(home,area,'dot-bridge'),current=path.join(home,area,'dalan');
   fs.mkdirSync(old,{recursive:true});fs.writeFileSync(path.join(old,'keep'),'existing state');
   fs.mkdirSync(path.join(current,'empty-subdir'),{recursive:true});fs.writeFileSync(path.join(current,'.keep'),'');
   assert.equal(defaultPath(home,area+'/dot-bridge','keep'),path.join(old,'keep'));
  }
  const other=path.join(home,'companion');fs.mkdirSync(path.join(other,'.config/dot-bridge'),{recursive:true});fs.writeFileSync(path.join(other,'.config/dot-bridge/env'),'existing');
  fs.mkdirSync(path.join(other,'.config/dalan'),{recursive:true});
  assert.equal(defaultPath(other,'.local/share/dot-bridge'),path.join(other,'.local/share/dot-bridge'));
  assert(!fs.existsSync(path.join(other,'.local/share')));
 } finally {fs.rmSync(home,{recursive:true,force:true});}
});
test('backup command resolves old, new, both, empty, fresh and legacy workspace settings',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-workspace-recipe-'));
 try {
  for(const [kind,settings,wanted] of [
   ['old',{DOT_BRIDGE_WORKSPACE_ROOT:'/old-workspace'},'/old-workspace'],
   ['new',{DALAN_WORKSPACE_ROOT:'/new-workspace'},'/new-workspace'],
   ['both',{DOT_BRIDGE_WORKSPACE_ROOT:'/old',DALAN_WORKSPACE_ROOT:'/new'},'/new'],
   ['empty',{DOT_BRIDGE_WORKSPACE_ROOT:'/old',DALAN_WORKSPACE_ROOT:''},null],
   ['fresh',{},null],['legacy',{},'legacy']]) {
   const home=path.join(root,kind);fs.mkdirSync(home);
   if(kind==='legacy'){fs.mkdirSync(path.join(home,'.config/dot-bridge'),{recursive:true});fs.writeFileSync(path.join(home,'.config/dot-bridge/env'),'existing');fs.mkdirSync(path.join(home,'.config/dalan'),{recursive:true});}
   const result=spawnSync('/bin/sh',['-ec','bridge_workspace_root="$(node bin/dalan.mjs paths --workspace-root)"; printf %s "$bridge_workspace_root"'],{env:{HOME:home,PATH:process.env.PATH,...settings},encoding:'utf8'});
   assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,wanted==='legacy'?path.join(home,'.tmp/dot-bridge'):wanted??path.join(home,'.tmp/dalan'));
  }
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('partial bootstrap files cannot shadow the legacy authorization components',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-partial-root-'));
 try {
  const old=path.join(home,'.config/dot-bridge'),current=path.join(home,'.config/dalan');fs.mkdirSync(old,{recursive:true});fs.mkdirSync(current,{recursive:true});
  for(const name of ['env','operator.key','as.json','as-jwks.json','as-cookie-keys.json','as-storage.key','as.sqlite'])fs.writeFileSync(path.join(old,name),'legacy component');
  fs.writeFileSync(path.join(current,'as-owner.sqlite'),'bootstrap lock');fs.writeFileSync(path.join(current,'operator.key'),'partial key');fs.writeFileSync(path.join(current,'env'),'partial secret');
  assert.equal(defaultPath(home,'.config/dot-bridge'),old);assert.equal(defaultPath(home,'.local/share/dot-bridge'),path.join(home,'.local/share/dot-bridge'));
  for(const name of ['as.json','as-jwks.json','as-cookie-keys.json','as-storage.key','as.sqlite'])fs.writeFileSync(path.join(current,name),'initialized new component');
  assert.equal(defaultPath(home,'.config/dot-bridge'),current);
 } finally {fs.rmSync(home,{recursive:true,force:true});}
});

test('profile A and profile B homes stay isolated when only one receives a partial new root',()=>{
 const owner=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-profile-homes-'));
 try {
  const homes=['profile-a','profile-b'].map(name=>path.join(owner,'.local/share',name));
  const names=[['worker-a'],['worker-b','worker-c']];
  for(const [index,home] of homes.entries()) {
   const config=path.join(home,'.config/dot-bridge'),data=path.join(home,'.local/share/dot-bridge');fs.mkdirSync(config,{recursive:true});fs.mkdirSync(data,{recursive:true});
   fs.writeFileSync(path.join(config,'workers.json'),JSON.stringify({workers:Object.fromEntries(names[index].map(name=>[name,{repos:[]}]))}),{mode:0o600});fs.writeFileSync(path.join(data,'bridge.db'),'populated legacy data');
  }
  const cli=(home,args)=>{const result=spawnSync(process.execPath,['bin/dalan.mjs',...args],{env:{HOME:home,PATH:process.env.PATH},encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
  const beforeSecond=fs.readFileSync(path.join(homes[1],'.config/dot-bridge/workers.json'));
  for(const partial of [false,true]) {
   if(partial) {fs.mkdirSync(path.join(homes[0],'.config/dalan'),{recursive:true});fs.writeFileSync(path.join(homes[0],'.config/dalan/env'),'partial scaffold');fs.mkdirSync(path.join(homes[0],'.local/share/dalan'),{recursive:true});}
   for(const [index,home] of homes.entries()) {
    assert.equal(cli(home,['paths','--config-root']),path.join(home,'.config/dot-bridge'));assert.equal(cli(home,['paths','--data-root']),path.join(home,'.local/share/dot-bridge'));
    assert.deepEqual(JSON.parse(cli(home,['worker','list','--json'])).workers.map(worker=>worker.worker),names[index]);
   }
   assert.deepEqual(fs.readFileSync(path.join(homes[1],'.config/dot-bridge/workers.json')),beforeSecond);assert(!fs.existsSync(path.join(homes[1],'.config/dalan')));assert(!fs.existsSync(path.join(homes[1],'.local/share/dalan')));
  }
 } finally {fs.rmSync(owner,{recursive:true,force:true});}
});
test('a new config root that lacks a legacy restriction, audit or per-worker token file does not shadow the legacy root',()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-paths-protect-'));
 try {
  const listed=['env','operator.key','workers.json','oauth.env'];
  for(const missing of ['limits.json','alerts.env','workers-audit.jsonl','acp-secret']) {
   const home=path.join(base,missing),legacy=path.join(home,'.config/dot-bridge'),current=path.join(home,'.config/dalan');
   fs.mkdirSync(legacy,{recursive:true});fs.mkdirSync(current,{recursive:true});
   for(const name of [...listed,missing])fs.writeFileSync(path.join(legacy,name),'legacy\n');
   for(const name of listed)fs.writeFileSync(path.join(current,name),'current\n');
   assert.equal(defaultPath(home,'.config/dot-bridge/limits.json'),path.join(legacy,'limits.json'),`new root without ${missing} was chosen`);
   fs.writeFileSync(path.join(current,missing),'current\n');
   assert.equal(defaultPath(home,'.config/dot-bridge/limits.json'),path.join(current,'limits.json'),`complete new root with ${missing} was not chosen`);
  }
 } finally {fs.rmSync(base,{recursive:true,force:true});}
});
test('signal tokens count as a family: rotation and stale copies neither block nor hide a new root',()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-paths-signal-'));
 try {
  const listed=['env','operator.key','workers.json','oauth.env'];
  const cases=[
   {name:'rotated',legacy:['signal-token'],current:['signal-token.worker-a'],wins:true},
   {name:'stale-copy',legacy:['signal-token.worker-a','signal-token.old'],current:['signal-token.worker-a'],wins:true},
   {name:'no-token',legacy:['signal-token'],current:[],wins:false},
   {name:'no-legacy-token',legacy:[],current:[],wins:true},
  ];
  for(const c of cases) {
   const home=path.join(base,c.name),legacy=path.join(home,'.config/dot-bridge'),current=path.join(home,'.config/dalan');
   fs.mkdirSync(legacy,{recursive:true});fs.mkdirSync(current,{recursive:true});
   for(const name of [...listed,...c.legacy])fs.writeFileSync(path.join(legacy,name),'legacy\n');
   for(const name of [...listed,...c.current])fs.writeFileSync(path.join(current,name),'current\n');
   assert.equal(defaultPath(home,'.config/dot-bridge/env'),path.join(c.wins?current:legacy,'env'),c.name);
  }
 } finally {fs.rmSync(base,{recursive:true,force:true});}
});
