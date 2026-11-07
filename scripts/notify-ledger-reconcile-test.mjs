#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {NotifyLedger} from '../src/notify-ledger.mjs';
import {publishAlert} from '../src/alerts.mjs';

const scratch=path.join(os.homedir(),'.tmp');fs.mkdirSync(scratch,{recursive:true});
const root=fs.mkdtempSync(path.join(scratch,'notify-reconcile-'));
const childFile=fileURLToPath(import.meta.url), db=path.join(root,'ledger.db'), accepted=path.join(root,'accepted');
if(process.argv[2]==='crash-before-publish'||process.argv[2]==='crash-after-accept') {
  const childDb=process.argv[3], childAccepted=process.argv[4];
  const ledger=new NotifyLedger(childDb);
  await ledger.send('worker','message',process.argv[2],async key=>{
    if(process.argv[2]==='crash-after-accept') fs.writeFileSync(childAccepted,key);
    process.kill(process.pid,'SIGKILL');
  });
}

try {
  process.env.DALAN_ALERTS_FILE=path.join(root,'missing-alerts.env');
  {
    const ledger=new NotifyLedger(db);
    try {
      let attempts=0;
      const rejected=Object.assign(new Error('receiver rejected request'),{notifyOutcome:'not_accepted'});
      await assert.rejects(ledger.send('worker','rejected','definite-rejection',async()=>{attempts++;throw rejected;}),/receiver rejected/);
      await ledger.send('worker','rejected','definite-rejection',async()=>{attempts++;});
      assert.equal(attempts,2,'a definitely rejected publish releases its key for one retry');
    } finally {ledger.close();}
  }
  for(const mode of ['crash-before-publish','crash-after-accept']) {
    const child=spawnSync(process.execPath,[childFile,mode,db,accepted],{encoding:'utf8'});
    assert.equal(child.signal,'SIGKILL',`${mode} child must die at the publish boundary`);
    const ledger=new NotifyLedger(db);
    try {
      const pending=ledger.pending();
      assert.equal(pending.length,1,`${mode} leaves one durable reservation`);
      if(mode==='crash-after-accept') assert.equal(fs.readFileSync(accepted,'utf8'),pending[0].key_sha256);
      const outcome=mode==='crash-after-accept'?'sent':'unsent';
      assert.equal(ledger.reconcile({key_sha256:pending[0].key_sha256,outcome,evidence:`receiver checked ${mode}`}).outcome,outcome);
      let publishes=0;
      assert.deepEqual(await ledger.send('worker','message',mode,async key=>{
        publishes++;
        assert.equal(key,pending[0].key_sha256,'retries keep the receiver idempotency key');
      }),{notified:true});
      assert.equal(publishes,mode==='crash-after-accept'?0:1,
        'confirmed delivery is cached; confirmed non-delivery can retry once');
    } finally {ledger.close();}
  }

  const ledger=new NotifyLedger(db);
  try {
    await assert.rejects(ledger.send('worker','missing publisher','missing-publisher',key=>publishAlert('title','body',()=>{},{requirePublisher:true,idempotencyKey:key})),
      error=>error.notifyOutcome==='not_accepted','a configured requirement with no publisher is a definite rejection');
    assert.equal(ledger.pending().length,0,'missing publisher does not strand an uncertain reservation');

    const key='retained-after-a-day';
    let published=0;
    await ledger.send('worker','same body',key,async()=>{published++;});
    const savedNow=Date.now;
    try {
      Date.now=()=>savedNow()+30*24*60*60*1000;
      const reopened=new NotifyLedger(db);
      try { await reopened.send('worker','same body',key,async()=>{published++;}); }
      finally {reopened.close();}
    } finally {Date.now=savedNow;}
    assert.equal(published,1,'a wall-clock jump and restart cannot prune a delivered idempotency key');
  } finally {ledger.close();}
  console.log('PASS pending notifications reconcile after crashes, definite rejection retries, and caller keys survive clock jumps');
} finally {fs.rmSync(root,{recursive:true,force:true});}
