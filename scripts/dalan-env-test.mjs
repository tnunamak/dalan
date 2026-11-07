import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {readEnv} from '../src/env.mjs';
test('old-only, new-only, both set, and explicitly empty new settings',()=>{
  assert.equal(readEnv('PORT',{DOT_BRIDGE_PORT:'old'}),undefined);
  assert.equal(readEnv('DOT_BRIDGE_PORT',{DOT_BRIDGE_PORT:'old'}),'old');
  assert.equal(readEnv('DOT_BRIDGE_PORT',{DALAN_PORT:'new'}),'new');
  assert.equal(readEnv('DOT_BRIDGE_PORT',{DOT_BRIDGE_PORT:'old',DALAN_PORT:'new'}),'new');
  assert.equal(readEnv('DALAN_PORT',{DOT_BRIDGE_PORT:'old',DALAN_PORT:''}),'');
});
test('legacy fallback warns once across settings, without logging values',()=>{
 const result=spawnSync(process.execPath,['--input-type=module','-e',`import {readEnv} from './src/env.mjs'; const env={DOT_BRIDGE_PORT:'secret-one',DOT_BRIDGE_AUTH_MODE:'secret-two'};for(let i=0;i<3;i++){readEnv('PORT',env);readEnv('DOT_BRIDGE_PORT',env);readEnv('DOT_BRIDGE_AUTH_MODE',env);}`],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'DOT_BRIDGE_* environment settings are deprecated; use DALAN_* instead.\n');
});
test('worker list honors the same precedence in a real CLI process',async()=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-env-'));
 try {
  for(const name of ['old','new'])fs.writeFileSync(path.join(home,name+'.json'),JSON.stringify({workers:{[name]:{repos:[]}}}),{mode:0o600});
  const old=path.join(home,'old.json'),current=path.join(home,'new.json');
  fs.mkdirSync(path.join(home,'.config/dalan'),{recursive:true});fs.writeFileSync(path.join(home,'.config/dalan/workers.json'),JSON.stringify({workers:{default:{repos:[]}}}),{mode:0o600});
  for(const [settings,expected,deprecated] of [[{DOT_BRIDGE_WORKERS_FILE:old},'old',true],[{DALAN_WORKERS_FILE:current},'new',false],[{DOT_BRIDGE_WORKERS_FILE:old,DALAN_WORKERS_FILE:current},'new',false],[{DOT_BRIDGE_WORKERS_FILE:old,DALAN_WORKERS_FILE:''},'default',false]]) {
   const result=spawnSync(process.execPath,['bin/dalan.mjs','worker','list','--json'],{env:{HOME:home,PATH:process.env.PATH,...settings},encoding:'utf8'});
   assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).workers[0].worker,expected);
   assert.equal(result.stderr.includes('deprecated'),deprecated);
  }
 } finally {fs.rmSync(home,{recursive:true,force:true});}
});

test('empty new auth is unset and preserves legacy auth; other empty settings intentionally override legacy',()=>{
 assert.equal(readEnv('DALAN_AUTH_MODE',{DALAN_AUTH_MODE:'',DOT_BRIDGE_AUTH_MODE:'builtin'}),'builtin');
 assert.equal(readEnv('DALAN_AUTH_MODE',{DALAN_AUTH_MODE:''}),undefined,'empty auth without a legacy mode stays fail-closed');
 assert.equal(readEnv('DALAN_AUTH_MODE',{DALAN_AUTH_MODE:'oauth',DOT_BRIDGE_AUTH_MODE:'builtin'}),'oauth');
 for(const name of ['BIND_HOST','CATALOG_PROFILE','WORKERS_FILE'])assert.equal(readEnv('DALAN_'+name,{['DALAN_'+name]:'',['DOT_BRIDGE_'+name]:'legacy'}),'',name+' intentionally uses its empty-value default or refusal');
});
