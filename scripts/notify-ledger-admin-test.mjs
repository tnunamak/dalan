#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {NotifyLedger} from '../src/notify-ledger.mjs';

const tmp=path.join(os.homedir(),'.tmp');fs.mkdirSync(tmp,{recursive:true});
const home=fs.mkdtempSync(path.join(tmp,'notify-admin-'));
const socket=path.join(home,'.local/share/dalan/admin.sock');
const env={HOME:home,PATH:process.env.PATH,DALAN_LEGACY_PROFILE:'1',DALAN_PORT:'0',DALAN_BIND_HOST:'127.0.0.1',DALAN_DEV_ALLOW_UNAUTHENTICATED:'1',DALAN_ENABLE_WORKSPACE:'0'};
let child,ledger,output='';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate,label) {
  for(let i=0;i<400;i++){if(await predicate())return;await sleep(25);}
  throw new Error(`timeout waiting for ${label}: ${output}`);
}
function admin(route,payload,headers={}) {
  return new Promise((resolve,reject)=>{
    const body=payload?JSON.stringify(payload):'';
    const req=http.request({socketPath:socket,path:route,method:payload?'POST':'GET',headers:{...headers,'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{
      let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(text)});}catch(error){reject(error);}});
    });
    req.on('error',reject);req.end(body);
  });
}
try {
  child=spawn(process.execPath,['src/server.mjs'],{cwd:path.resolve(new URL('..',import.meta.url).pathname),env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  await waitFor(()=>{if(child.exitCode!==null)throw new Error(`server exited: ${output}`);return fs.existsSync(socket);},'admin socket');
  const operatorKey=fs.readFileSync(path.join(home,'.config/dalan/operator.key'),'utf8').trim();
  ledger=new NotifyLedger(path.join(home,'.local/share/dalan/notify-sent.db'));
  let publishes=0;
  await assert.rejects(ledger.send('worker','body','admin-reconcile',async()=>{publishes++;throw new Error('transport outcome uncertain');}),/uncertain/);
  const unauthorized=await admin('/notify-pending');
  assert.notEqual(unauthorized.status,200,'reconciliation requires operator authentication');
  const listed=await admin('/notify-pending',null,{'x-operator-key':operatorKey});
  assert.equal(listed.status,200);
  assert.equal(listed.body.notifications.length,1);
  const pending=listed.body.notifications[0];
  const reconciled=await admin('/notify-reconcile',{key_sha256:pending.key_sha256,outcome:'sent',evidence:'receiver confirms this idempotency key was accepted'},{'x-operator-key':operatorKey});
  assert.equal(reconciled.status,200,JSON.stringify(reconciled));
  assert.equal(reconciled.body.state,'delivered');
  assert.deepEqual(await ledger.send('worker','body','admin-reconcile',async()=>{publishes++;}),{notified:true});
  assert.equal(publishes,1,'reconciled delivery is not published again');
  console.log('PASS authenticated notification reconciliation settles a pending delivery without replay');
} finally {
  ledger?.close();
  if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}
  fs.rmSync(home,{recursive:true,force:true});
}
