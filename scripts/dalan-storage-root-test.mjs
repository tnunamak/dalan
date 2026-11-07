import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/store.mjs';
import {AckLedger} from '../src/ack-ledger.mjs';
import {defaultPath} from '../src/paths.mjs';

test('a complete-looking data sibling without the encryption key keeps the legacy DB, ACKs and successful startup',{timeout:15000},async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-storage-root-')),old=path.join(home,'.local/share/dot-bridge'),current=path.join(home,'.local/share/dalan');
 let child;
 try {
  fs.mkdirSync(old,{recursive:true});fs.mkdirSync(current,{recursive:true});
  const file=path.join(old,'bridge.db'),store=new Store(file);
  store.submit({schema_version:1,request_id:'req_key_continuity',brief:'retained job',inputs:[],scope_paths:[],execution_scope:'read-only',expected_output:'text'},{mode:'none'},null,'fixture-owner');
  store.subscribe('sub_key','https://fixture.invalid/events','synthetic-secret',new Date(Date.now()+3600000).toISOString());
  store.db.close();assert(fs.existsSync(file+'.secrets/storage.key'));
  const ack=new AckLedger(path.join(old,'delivery-acks.db')),key=ack.key('evt_key','retained body','retained binding');ack.record(key);ack.close();
  const notify=new DatabaseSync(path.join(old,'notify-sent.db'));notify.exec('CREATE TABLE fixture(value TEXT)');notify.close();fs.chmodSync(path.join(old,'notify-sent.db'),0o600);
  for(const name of ['receipts','artifact-index']) {fs.mkdirSync(path.join(old,name));fs.writeFileSync(path.join(old,name,'keep'),'legacy');}
  // Copy every previously checked durable component, but deliberately omit the nested secret key.
  for(const name of ['bridge.db','delivery-acks.db','notify-sent.db','receipts','artifact-index'])fs.cpSync(path.join(old,name),path.join(current,name),{recursive:true,preserveTimestamps:true});
  assert.equal(defaultPath(home,'.local/share/dot-bridge'),old);
  assert.throws(()=>{const incompleteDb=new Store(path.join(current,'bridge.db'));incompleteDb.db.close();},/storage key is missing/);
  assert.equal(defaultPath(home,'.local/share/dot-bridge'),old,'failed open scaffolding hid the legacy key');
  const config=path.join(home,'.config/dot-bridge');fs.mkdirSync(config,{recursive:true,mode:0o700});fs.writeFileSync(path.join(config,'workers.json'),JSON.stringify({workers:{dot:{repos:[],connections:[{issuer:'https://fixture.invalid',subject:'fixture',client_id:'fixture'}]}}}),{mode:0o600});
  child=spawn(process.execPath,['src/server.mjs'],{env:{HOME:home,PATH:process.env.PATH,DALAN_PORT:'0',DALAN_BIND_HOST:'127.0.0.1',DALAN_DEV_ALLOW_UNAUTHENTICATED:'1'},stdio:['ignore','pipe','pipe']});
  let ready=false,errors='';child.stdout.on('data',b=>{if(String(b).includes('MCP listening'))ready=true;});child.stderr.on('data',b=>errors+=b);
  for(let n=0;n<200&&!ready&&child.exitCode===null;n++)await new Promise(resolve=>setTimeout(resolve,25));assert(ready,errors);
  const db=new DatabaseSync(path.join(old,'bridge.db'),{readOnly:true});assert.equal(db.prepare("SELECT count(*) n FROM assignments WHERE request_id='req_key_continuity'").get().n,1);assert.match(db.prepare("SELECT secret FROM subscriptions WHERE id='sub_key'").get().secret,/^v1\./);db.close();
  const recoveredAck=new AckLedger(path.join(old,'delivery-acks.db'));assert(recoveredAck.has(recoveredAck.key('evt_key','retained body','retained binding')));recoveredAck.close();
  const cli=spawnSync(process.execPath,['bin/dalan.mjs','paths','--data-root'],{env:{HOME:home,PATH:process.env.PATH},encoding:'utf8'});assert.equal(cli.status,0,cli.stderr);assert.equal(cli.stdout.trim(),old);
  assert(!fs.existsSync(path.join(current,'bridge.db.secrets/storage.key')),'startup mixed or manufactured a key in the new root');
 } finally {
  if(child&&child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');});
  fs.rmSync(home,{recursive:true,force:true});
 }
});
