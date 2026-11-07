import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/store.mjs';
import {AckLedger} from '../src/ack-ledger.mjs';

const root=path.resolve(new URL('..',import.meta.url).pathname);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(home) {
 const config=path.join(home,'.config/dot-bridge'),data=path.join(home,'.local/share/dot-bridge');fs.mkdirSync(config,{recursive:true,mode:0o700});fs.mkdirSync(data,{recursive:true});
 fs.writeFileSync(path.join(config,'env'),'BRIDGE_PATH_SECRET='+'1'.repeat(64)+'\n',{mode:0o600});fs.writeFileSync(path.join(config,'operator.key'),'2'.repeat(64)+'\n',{mode:0o600});
 fs.writeFileSync(path.join(config,'workers.json'),JSON.stringify({workers:{dot:{repos:[],connections:[{issuer:'https://fixture.invalid',subject:'fixture',client_id:'fixture'}]}}}),{mode:0o600});
 const store=new Store(path.join(data,'bridge.db'),{markProfileModeSeen:true});store.submit({schema_version:1,request_id:'req_mixed_roots',brief:'retained mixed-root job',inputs:[],scope_paths:[],expected_output:'text',execution_scope:'read-only'},{mode:'none'},null,'owner');store.db.close();
 const ledger=new AckLedger(path.join(data,'delivery-acks.db'));ledger.record(ledger.key('event','body','binding'));ledger.close();
 return {config,data};
}
async function serve(home,extra={}) {
 const child=spawn(process.execPath,['src/server.mjs'],{cwd:root,env:{HOME:home,PATH:process.env.PATH,DALAN_PORT:'0',DALAN_BIND_HOST:'127.0.0.1',DALAN_DEV_ALLOW_UNAUTHENTICATED:'1',...extra},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 for(let n=0;n<200&&!stdout.includes('MCP listening')&&child.exitCode===null;n++)await sleep(25);
 return {child,stdout,stderr,stop:async()=>{if(child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');});}};
}

test('complete config-only and data-only migrations start without writing alternate config/data roots',{timeout:15000},async()=>{
 const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-mixed-roots-'));let service;
 try {
  for(const area of ['config','data']) {
   const home=path.join(scratch,area),old=fixture(home),newConfig=path.join(home,'.config/dalan'),newData=path.join(home,'.local/share/dalan');
   const config=area==='config'?newConfig:old.config,data=area==='data'?newData:old.data;
   fs.renameSync(old[area],area==='config'?newConfig:newData);
   const before=new Map(['env','operator.key','workers.json'].map(name=>[name,fs.readFileSync(path.join(config,name))]));
   const key=fs.readFileSync(path.join(data,'bridge.db.secrets/storage.key'));
   service=await serve(home);assert(service.stdout.includes('MCP listening'),service.stderr);assert(fs.existsSync(path.join(data,'admin.sock')));
   const paths=spawnSync(process.execPath,['bin/dalan.mjs','paths','--json'],{cwd:root,env:{HOME:home,PATH:process.env.PATH},encoding:'utf8'});assert.equal(paths.status,0,paths.stderr);
   const resolved=JSON.parse(paths.stdout);assert.equal(resolved.config_dir,config);assert.equal(resolved.data_dir,data);
   // Once an area is explicitly migrated, missing companion roots use the new spelling.
   assert.equal(resolved.state_dir,path.join(home,'.local/state/dalan'));assert.equal(resolved.workspace_root,path.join(home,'.tmp/dalan'));
   assert(!fs.existsSync(area==='config'?old.config:newConfig),'startup wrote the alternate config root');assert(!fs.existsSync(area==='data'?old.data:newData),'startup wrote the alternate data root');
   for(const [name,bytes] of before)assert.deepEqual(fs.readFileSync(path.join(config,name)),bytes,name+' changed');
   assert.deepEqual(fs.readFileSync(path.join(data,'bridge.db.secrets/storage.key')),key);
   const db=new DatabaseSync(path.join(data,'bridge.db'),{readOnly:true});assert.equal(db.prepare("SELECT status FROM assignments WHERE request_id='req_mixed_roots'").get().status,'queued');db.close();
   const ledger=new AckLedger(path.join(data,'delivery-acks.db'));assert(ledger.has(ledger.key('event','body','binding')));ledger.close();
   await service.stop();service=null;
  }
 } finally {if(service)await service.stop();fs.rmSync(scratch,{recursive:true,force:true});}
});

test('an actually missing seen profile refuses mixed-root startup unless explicitly overridden',{timeout:15000},async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-mixed-profile-'));let service;
 try {
  const old=fixture(home),config=path.join(home,'.config/dalan');fs.renameSync(old.config,config);fs.unlinkSync(path.join(config,'workers.json'));
  service=await serve(home);assert(!service.stdout.includes('MCP listening'));assert.equal(service.child.exitCode,1);assert.match(service.stderr,/worker profile file.*missing.*DALAN_LEGACY_PROFILE=1/);
  assert(!fs.existsSync(path.join(home,'.local/share/dalan')));assert(!fs.existsSync(old.config));assert(!fs.existsSync(path.join(config,'workers-repos.json')));
  await service.stop();service=await serve(home,{DOT_BRIDGE_LEGACY_PROFILE:'1'});assert(service.stdout.includes('MCP listening'),service.stderr);
  assert(!fs.existsSync(path.join(home,'.local/share/dalan')));assert(!fs.existsSync(old.config));
 } finally {if(service)await service.stop();fs.rmSync(home,{recursive:true,force:true});}
});
