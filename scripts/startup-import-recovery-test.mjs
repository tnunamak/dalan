#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initAsFiles, asFiles } from '../src/as-files.mjs';
import { stopChild } from '../src/test-support/process.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const node=process.execPath;
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-import-guard-'));
const homes=[];
const makeHome=()=>{const home=fs.mkdtempSync(path.join(scratch,'home-'));homes.push(home);return home;};
const run=(args,env)=>new Promise((resolve,reject)=>{
  const child=spawn(node,args,{cwd:root,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
  const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
  let stdout='',stderr='';child.stdout.setEncoding('utf8').on('data',s=>stdout+=s);child.stderr.setEncoding('utf8').on('data',s=>stderr+=s);
  child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr});});
});
const dbFixture=(file,version=53)=>{fs.mkdirSync(path.dirname(file),{recursive:true});const db=new DatabaseSync(file);db.exec(`CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('preserve'); PRAGMA user_version=${version};`);db.close();};
const version=file=>{const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare('PRAGMA user_version').get().user_version;}finally{db.close();}};
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clean=()=>fs.rmSync(scratch,{recursive:true,force:true});

try {
  // Import must stay inert in a brand-new isolated home.
  const importHome=makeHome();
  const importCheck=await run(['--input-type=module','-e',`const events=['exit','SIGINT','SIGTERM','SIGHUP']; const listeners=events.map(e=>process.listenerCount(e)); const before=process._getActiveHandles().filter(x=>x.constructor?.name==='Server').length; const m=await import(${JSON.stringify(path.join(root,'src/server.mjs'))}); const after=process._getActiveHandles().filter(x=>x.constructor?.name==='Server').length; if(typeof m.main!=='function'||before!==after||events.some((e,i)=>process.listenerCount(e)!==listeners[i]))process.exit(12);`],{HOME:importHome});
  assert.equal(importCheck.code,0,importCheck.stderr);
  assert.deepEqual(fs.readdirSync(importHome),[],'import created home files or directories');

  const freshHome=makeHome();
  const freshInvalid=await run(['src/server.mjs'],{HOME:freshHome,DOT_BRIDGE_AUTH_MODE:'',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'',DOT_BRIDGE_PORT:'0'});
  assert.notEqual(freshInvalid.code,0,'invalid auth unexpectedly started');assert.match(freshInvalid.stderr,/without OAuth/);
  assert.equal(fs.existsSync(path.join(freshHome,'.local/share/dot-bridge/bridge.db')),false,'invalid auth created a database');
  const symlinkHome=makeHome(),entry=path.join(scratch,'server-link.mjs');fs.symlinkSync(path.join(root,'src/server.mjs'),entry);
  const symlinkStart=await run([entry],{HOME:symlinkHome,DOT_BRIDGE_AUTH_MODE:'',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'',DOT_BRIDGE_PORT:'0'});
  assert.notEqual(symlinkStart.code,0,'direct symlink entry silently skipped main');assert.match(symlinkStart.stderr,/without OAuth/);
  assert.equal(fs.existsSync(path.join(symlinkHome,'.local/share/dot-bridge/bridge.db')),false);
  const badPortHome=makeHome();
  const badPort=await run(['src/server.mjs'],{HOME:badPortHome,DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_PORT:'not-a-port'});
  assert.notEqual(badPort.code,0);assert.match(badPort.stderr,/ERR_SOCKET_BAD_PORT/);
  assert.equal(fs.existsSync(path.join(badPortHome,'.local/share/dot-bridge/bridge.db')),false,'invalid port created a database');

  // Invalid public auth must fail before Store can mutate an older default-home database.
  const invalidHome=makeHome(),oldDb=path.join(invalidHome,'.local/share/dot-bridge/bridge.db');dbFixture(oldDb);
  const invalid=await run(['src/server.mjs'],{HOME:invalidHome,DOT_BRIDGE_AUTH_MODE:'',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'',DOT_BRIDGE_PORT:'0'});
  assert.notEqual(invalid.code,0,'invalid auth unexpectedly started');
  assert.match(invalid.stderr,/without OAuth/);
  assert.equal(version(oldDb),53);
  {const db=new DatabaseSync(oldDb,{readOnly:true});try{assert.equal(db.prepare('SELECT value FROM sentinel').get().value,'preserve');}finally{db.close();}}

  // Constructor guard refuses an older DB at either recognized default home, but permits a nondefault fixture.
  const guardHome=makeHome(),defaultDb=path.join(guardHome,'.local/share/dot-bridge/bridge.db');dbFixture(defaultDb);
  const alias=path.join(guardHome,'.local/share/dot-bridge/alias.db'),hardlink=path.join(guardHome,'.local/share/dot-bridge/hardlink.db');
  fs.symlinkSync(defaultDb,alias);fs.linkSync(defaultDb,hardlink);
  const beforeDigest=digest(defaultDb);
  const guard=await run(['--input-type=module','-e',`import {Store} from ${JSON.stringify(path.join(root,'src/store.mjs'))}; import {pathToFileURL} from 'node:url'; const files=[${JSON.stringify(defaultDb)},${JSON.stringify(alias)},${JSON.stringify(hardlink)},pathToFileURL(${JSON.stringify(defaultDb)})]; for(const file of files) { try { new Store(file); process.exit(21); } catch(e) { if(!e.message.includes('accidental-migration guard')) throw e; } }`],{HOME:guardHome});
  assert.equal(guard.code,0,guard.stderr);assert.equal(version(defaultDb),53);assert.equal(digest(defaultDb),beforeDigest,'refusal changed database bytes');
  assert.equal(fs.existsSync(path.join(guardHome,'.config')),false,'refusal created key/config files');
  const nondefault=path.join(guardHome,'fixtures/nondefault.db');dbFixture(nondefault,0);
  const migrate=await run(['--input-type=module','-e',`import {Store} from ${JSON.stringify(path.join(root,'src/store.mjs'))}; new Store(${JSON.stringify(nondefault)}).db.close();`],{HOME:guardHome});
  assert.equal(migrate.code,0,migrate.stderr);assert.equal(version(nondefault),66);
  for(const defaultIsSymlink of [true,false]) {
    const linkedHome=makeHome(),relocated=path.join(linkedHome,'relocated'),defaultLink=path.join(linkedHome,'.local/share/dot-bridge');
    fs.mkdirSync(path.dirname(defaultLink),{recursive:true});
    if(defaultIsSymlink) {fs.mkdirSync(relocated);fs.symlinkSync(relocated,defaultLink);}
    else {fs.mkdirSync(defaultLink);fs.symlinkSync(defaultLink,relocated);}
    const requestedMissing=path.join(relocated,'bridge.db');
    const missingAlias=await run(['--input-type=module','-e',`import {Store} from ${JSON.stringify(path.join(root,'src/store.mjs'))}; import {pathToFileURL} from 'node:url'; for(const file of [${JSON.stringify(requestedMissing)},pathToFileURL(${JSON.stringify(requestedMissing)})]) { try { const s=new Store(file);s.db.close();process.exit(21); } catch(e) { if(!e.message.includes('accidental-migration guard')) throw e; } }`],{HOME:linkedHome});
    assert.equal(missingAlias.code,0,missingAlias.stderr||'directory alias initialized a missing default DB');
    assert.deepEqual(fs.readdirSync(relocated),[],'alias refusal created database or key files');
  }
  const absentHome=makeHome(),absentDb=path.join(absentHome,'.local/share/dot-bridge/bridge.db');
  const absent=await run(['--input-type=module','-e',`import {Store} from ${JSON.stringify(path.join(root,'src/store.mjs'))}; new Store(${JSON.stringify(absentDb)});`],{HOME:absentHome});
  assert.notEqual(absent.code,0);assert.match(absent.stderr,/accidental-migration guard/);assert.deepEqual(fs.readdirSync(absentHome),[],'refusal initialized a default home');
  const currentHome=makeHome(),currentDb=path.join(currentHome,'.local/share/dot-bridge/bridge.db');
  fs.mkdirSync(path.dirname(currentDb),{recursive:true});
  const current=await run(['--input-type=module','-e',`import {Store} from ${JSON.stringify(path.join(root,'src/store.mjs'))}; new Store(${JSON.stringify(currentDb)},{allowDefaultHomeMigration:true}).db.close(); new Store(${JSON.stringify(currentDb)}).db.close(); new Store(':memory:').db.close();`],{HOME:currentHome});
  assert.equal(current.code,0,current.stderr);assert.equal(version(currentDb),66);

  const badKeysHome=makeHome(),badKeysConfig=path.join(badKeysHome,'.config/dot-bridge');
  initAsFiles(badKeysConfig,{publicUrl:'http://127.0.0.1:9',allowHttp:true});fs.chmodSync(asFiles(badKeysConfig).jwks,0o644);
  const badKeys=await run(['src/server.mjs'],{HOME:badKeysHome,DOT_BRIDGE_AUTH_MODE:'builtin',DOT_BRIDGE_TEST_OAUTH:'1',DOT_BRIDGE_PORT:'0'});
  assert.notEqual(badKeys.code,0);assert.match(badKeys.stderr,/0600|private/);
  assert.equal(fs.existsSync(path.join(badKeysHome,'.local/share/dot-bridge/bridge.db')),false,'invalid auth keys created a database');

  // Direct service startup is explicitly authorized and migrates only its isolated fixture.
  const serviceHome=makeHome(),serviceDb=path.join(serviceHome,'.local/share/dot-bridge/bridge.db');dbFixture(serviceDb,0);
  const conf=path.join(serviceHome,'.config/dot-bridge');
  initAsFiles(conf,{publicUrl:'http://127.0.0.1:9',allowHttp:true});
  const service=spawn(node,['src/server.mjs'],{cwd:root,env:{...process.env,HOME:serviceHome,DALAN_LEGACY_PROFILE:'1',DOT_BRIDGE_AUTH_MODE:'builtin',DOT_BRIDGE_TEST_OAUTH:'1',DOT_BRIDGE_PORT:'0'},stdio:['ignore','pipe','pipe']});
  let serviceOut='',serviceErr='';service.stdout.setEncoding('utf8').on('data',s=>serviceOut+=s);service.stderr.setEncoding('utf8').on('data',s=>serviceErr+=s);
  try {
    const started=await new Promise(resolve=>{const timer=setTimeout(()=>resolve(false),8000);service.stdout.on('data',()=>{if(serviceOut.includes('MCP listening')){clearTimeout(timer);resolve(true);}});service.once('exit',()=>{clearTimeout(timer);resolve(false);});});
    assert.equal(started,true,serviceErr||serviceOut);assert.equal(version(serviceDb),66);
  } finally {await stopChild(service);}
  console.log('PASS import is inert; invalid auth preserves schema 53; default-home guard refuses; current, nondefault and authorized migrations work');
} finally {clean();}
