import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,readFileSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {once} from 'node:events';
import os from 'node:os';
import path from 'node:path';
import {Deadman} from '../src/deadman.mjs';

const root=path.join(os.homedir(),'.tmp',`deadman-crash-${process.pid}`);
const token='deadman-crash-test-token'.padEnd(40,'x');
const dbFile=path.join(root,'deadman.sqlite'),marker=path.join(root,'published.txt');
if(process.argv[2]==='publish') {
  const childDb=process.argv[3],childMarker=process.argv[4];
  let elapsed=0;
  const monitor=new Deadman({dbFile:childDb,token,deadlineMs:5,clearMs:15,reminderMs:120,tickMs:1000,retryMs:1,
    now:()=>100,elapsedNow:()=>elapsed,
    publisher:async(_title,message,key)=>{writeFileSync(childMarker,`${key}\n${message}`);await new Promise(()=>{});}});
  elapsed=10;
  monitor.tick().catch(()=>{});
  setInterval(()=>{},1000);
} else {
  mkdirSync(root,{recursive:true,mode:0o700});
  const child=spawn(process.execPath,[new URL(import.meta.url).pathname,'publish',dbFile,marker],{cwd:path.resolve(new URL('..',import.meta.url).pathname),stdio:['ignore','ignore','inherit']});
  try {
    for(let n=0;n<500&&!existsSync(marker);n++)await new Promise(resolve=>setTimeout(resolve,10));
    assert(existsSync(marker),'receiver accepted the alert before the publisher returned');
    const exited=once(child,'exit');child.kill('SIGKILL');await exited;
    const [publicationId]=readFileSync(marker,'utf8').split('\n');
    const monitor=new Deadman({dbFile,token,now:()=>1000,elapsedNow:()=>1000,publisher:async()=>({accepted:true})});
    try {
      const episode=monitor.status().episodes[0];
      assert.equal(episode.initial_state,'uncertain','restart preserves the ambiguous delivery outcome');
      assert.equal(episode.initial_publication_id,publicationId,'the durable delivery reference identifies the attempt');
      assert.match(readFileSync(marker,'utf8'),new RegExp(`Delivery reference: ${publicationId}`));
      const reconciled=monitor.reconcilePublication({episodeId:episode.id,phase:'initial',outcome:'sent',receipt:'receiver confirmed delivery'});
      assert.equal(reconciled.initial_state,'sent','positive receiver evidence settles the interrupted alert');
      assert.throws(()=>monitor.reconcilePublication({episodeId:episode.id,phase:'initial',outcome:'unsent',receipt:'late contradiction'}),/not uncertain/);
    } finally {await monitor.close();}
    const closed=new Deadman({dbFile:path.join(root,'recovered.sqlite'),token,now:()=>1000,elapsedNow:()=>1000});
    try {
      closed.db.prepare("INSERT INTO episodes(opened_at,closed_at,initial_state,initial_publication_id,reminder_publication_id) VALUES(1,2,'uncertain','initial-ref','reminder-ref')").run();
      const result=closed.reconcilePublication({episodeId:1,phase:'initial',outcome:'unsent',receipt:'receiver confirms absent'});
      assert.equal(result.initial_state,'suppressed_recovered','a recovered outage does not leave an unserviceable retry pending');
    } finally {await closed.close();}
  } finally {
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    rmSync(root,{recursive:true,force:true});
  }
  console.log('PASS: interrupted dead-man delivery has a stable reference and explicit reconciliation');
}
