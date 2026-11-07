#!/usr/bin/env node
import './require-host-checks.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-bridge-npm-question-'));
process.env.DOT_BRIDGE_WORKSPACE_ROOT=path.join(home,'work');
const { Store }=await import('../src/store.mjs');
const { Workspace }=await import('../src/workspace.mjs');
const originalSpawn=childProcess.spawn;
const store=new Store(path.join(home,'db.sqlite'));
try {
  const requestId='req_npm_question_fixture',ownerThread='fake-owner-thread';
  store.submit({schema_version:1,request_id:requestId,brief:'fixture',inputs:[],expected_output:'tests',execution_scope:'implementation'},ownerThread,'fake-environment','fake-owner');
  const claimId=store.claim(requestId,'fake-worker','fake-subject').claim_id;
  const forwarded=[
    'QUESTION: first line',
    'Progress recorded.\nQUESTION: later line',
    'Progress recorded.\n  blocked: later indented line',
    'Progress recorded.\r\nQuestion: CRLF line'
  ];
  for(const note of forwarded) {
    assert.equal(store.progress(requestId,claimId,note,'fake-subject').blocker_forwarded,true);
    store.progress(requestId,claimId,note,'fake-subject');
  }
  for(const note of ['Normal progress','The prose mentions QUESTION: inline','Progress\nThe prose mentions BLOCKED: inline']) {
    assert.equal(store.progress(requestId,claimId,note,'fake-subject').blocker_forwarded,false);
  }
  assert.equal(store.progress(requestId,claimId,'Explicit flag','fake-subject',true).blocker_forwarded,true);
  const notifications=store.db.prepare("SELECT request_id,body FROM notifications WHERE kind='blocker' ORDER BY rowid").all();
  assert.equal(notifications.length,forwarded.length+1,'one queued notification per distinct blocker');
  assert.deepEqual(notifications.map(row=>JSON.parse(row.body).note),[...forwarded,'Explicit flag']);
  assert.ok(notifications.every(row=>row.request_id===requestId));
  assert.equal(store.get(requestId).thread_id,ownerThread);
  console.log('PASS anchored multiline blocker/question forwarding and deduplication (fake owner; no provider turn)');

  // Inspect actual runConfined construction without requesting nested namespaces.
  const calls=[];
  childProcess.spawn=(command,argv,options)=>{
    calls.push({command,argv,options});
    const child=new EventEmitter();
    child.stdout=new EventEmitter();child.stderr=new EventEmitter();
    process.nextTick(()=>child.emit('close',0,null));
    return child;
  };
  syncBuiltinESMExports();
  const ws=new Workspace(store),dir=path.join(home,'fixture');
  fs.mkdirSync(dir);
  for(const network of [true,false]) {
    const result=await ws.runConfined(requestId,dir,['npm','--version'],{network,timeout_ms:5000,output_bytes:4096});
    assert.equal(result.exit.code,0);
    // Every confined run starts through the launcher that closes inherited fds, then execs pasta, or sh, which execs bwrap.
    const call=calls.at(-1);
    assert.equal(call.command,'/usr/bin/bash');
    assert.equal(call.argv[0],'-c');assert.match(call.argv[1],/\/proc\/self\/fd\/\*.*exec "\$@"$/);
    const [innerCommand,...innerArgs]=call.argv.slice(3),viaPasta=innerCommand.endsWith('/pasta');
    const bwrapAt=innerArgs.indexOf('/usr/bin/bwrap'),argv=innerArgs.slice(bwrapAt+1);
    assert.equal(innerArgs[bwrapAt],'/usr/bin/bwrap');
    assert.equal(argv[argv.indexOf('--info-fd')+1],'3');
    assert.equal(viaPasta,network&&fs.existsSync('/usr/bin/pasta'));
    assert.equal(argv.includes('--share-net'),network&&!viaPasta);
    const pathAt=argv.indexOf('PATH');
    assert.equal(argv[pathAt-1],'--setenv');
    assert.equal(argv[pathAt+1],'/runtime-bin:/runtime:/usr/bin:/bin');
    const bindAt=argv.indexOf('/runtime-bin');
    assert.equal(argv[bindAt-2],'--ro-bind');
    const shimDir=argv[bindAt-1];
    assert.equal(shimDir,path.join(home,'work','runtime-bin'));
    assert.deepEqual(fs.readdirSync(shimDir).sort(),['npm','npx']);
    for(const name of ['npm','npx']) {
      const file=path.join(shimDir,name);
      assert.equal(fs.statSync(file).mode&0o777,0o755);
      assert.equal(fs.readFileSync(file,'utf8'),'#!/bin/sh\nexec /runtime/node /runtime/npm/bin/'+name+'-cli.js "$@"\n');
    }
    assert.deepEqual(argv.slice(-3),['--','npm','--version']);
  }
  assert.equal(calls.length,2);
  console.log('PASS npm/npx executable shims, read-only bind and PATH in install/check phases (mocked bwrap)');
  console.log('LIMITATION: real npm/npx sandbox execution is covered by workspace-e2e.mjs (npm test); test:sandbox does not run nested namespace integration tests.');
} finally {
  childProcess.spawn=originalSpawn;
  syncBuiltinESMExports();
  store.db.close();
  fs.rmSync(home,{recursive:true,force:true});
}
