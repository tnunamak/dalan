#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { stopChild } from '../src/test-support/process.mjs';

const children=[];
async function start(stubborn=false) {
  const child=spawn(process.execPath,['--eval',`${stubborn?"process.on('SIGTERM',()=>{});":''}console.log('ready');setInterval(()=>{},1000);`],{stdio:['ignore','pipe','pipe']});
  children.push(child);
  let timer;
  try {
    await Promise.race([once(child.stdout,'data'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('fixture child did not start')),3000);})]);
  } finally {clearTimeout(timer);}
  return child;
}
try {
  const graceful=await start();await stopChild(graceful);
  assert.equal(graceful.signalCode,'SIGTERM');
  const stubborn=await start(true);await stopChild(stubborn,{graceMs:30,killMs:1000});
  assert.equal(stubborn.signalCode,'SIGKILL','stalled graceful shutdown was not escalated');
  assert.throws(()=>process.kill(stubborn.pid,0),{code:'ESRCH'},'fixture process remained alive');
  const alreadyGone=await start();const ended=once(alreadyGone,'exit');alreadyGone.kill('SIGTERM');await ended;
  alreadyGone.kill=()=>{throw new Error('must not signal an exited child');};
  await stopChild(alreadyGone);
  const signals=[],neverExits=Object.assign(new EventEmitter(),{pid:0,exitCode:null,signalCode:null,kill:signal=>{signals.push(signal);return true;}});
  await assert.rejects(stopChild(neverExits,{graceMs:5,killMs:5}),/did not exit after SIGKILL/);
  assert.deepEqual(signals,['SIGTERM','SIGKILL']);assert.equal(neverExits.listenerCount('exit'),0);
  console.log('PASS graceful, forced and already-exited fixture cleanup; final stop deadline refuses an uncollected child');
} finally {for(const child of children) await stopChild(child);}
