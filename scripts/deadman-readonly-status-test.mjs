#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Deadman} from '../src/deadman.mjs';

const root=fs.mkdtempSync(path.join(os.homedir(),'.tmp','deadman-readonly-'));
const token='read-only-status-test-token'.padEnd(40,'x');
const cli=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../bin/dot-deadman.mjs');
const runCli=(args,db,port)=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[cli,...args],{cwd:path.dirname(path.dirname(cli)),env:{PATH:process.env.PATH,HOME:root,DOT_DEADMAN_TOKEN:token,DOT_DEADMAN_DB:db,DOT_DEADMAN_PORT:String(port)},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));
});
async function livePublisher(db) {
  let release,started;
  const blocked=new Promise(resolve=>{release=resolve;}), entered=new Promise(resolve=>{started=resolve;});
  let calls=0;
  const owner=new Deadman({dbFile:db,token,publisher:async()=>{calls++;started();await blocked;return {accepted:true};},deadlineMs:1000});
  const address=await owner.start({host:'127.0.0.1',port:0});
  const now=Date.now();
  owner.db.prepare('UPDATE monitor SET active_episode_id=1,started_at=?,logical_now=?,wall_at=? WHERE id=1').run(now-5000,now-5000,now-5000);
  owner.db.prepare("INSERT INTO episodes(id,opened_at,initial_state,next_attempt_at) VALUES(1,?,'pending',0)").run(now-4000);
  const tick=owner.tick();
  await entered;
  return {owner,release,opened:tick,port:address.port,calls:()=>calls};
}

try {
  {
    const db=path.join(root,'status.sqlite'),live=await livePublisher(db);
    try {
      const result=await runCli(['status'],db,live.port);
      assert.equal(result.code,0,result.stderr);
      live.release();await live.opened;
      assert.equal(live.owner.status().episodes[0].initial_state,'sent',
        'reading status while POST is live must not erase its successful outcome');
      assert.equal(live.calls(),1,'status must not initiate or cause a second publication');
    } finally {live.release();await live.owner.close();}
  }
  {
    const db=path.join(root,'reconcile.sqlite'),live=await livePublisher(db);
    try {
      const result=await runCli(['reconcile','1','initial','unsent','--evidence','checked receiver'],db,live.port);
      assert.notEqual(result.code,0,'the owning daemon must refuse reconciliation while its publisher is live');
      live.release();await live.opened;
      assert.equal(live.calls(),1,'reconciliation must not enable a duplicate while the original POST can still complete');
    } finally {live.release();await live.owner.close();}
  }
  console.log('PASS status reads live sends without mutation and the owning daemon refuses reconciliation during publication');
} finally {fs.rmSync(root,{recursive:true,force:true});}
