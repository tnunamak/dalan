import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {NotifyLedger} from '../src/notify-ledger.mjs';

const self=fileURLToPath(import.meta.url);
if(process.argv[2]==='child') {
  const ledger=new NotifyLedger(process.argv[3]);
  await ledger.send('worker','message','stable-key',async key=>{
    fs.writeFileSync(process.argv[4],`key:${key??''}`);
    process.kill(process.pid,'SIGKILL');
  });
}
const scratch=path.join(process.env.HOME||os.homedir(),'.tmp');fs.mkdirSync(scratch,{recursive:true});
const root=fs.mkdtempSync(path.join(scratch,'notify-crash-'));
const db=path.join(root,'notify.db'),marker=path.join(root,'published');
try {
  const child=spawnSync(process.execPath,[self,'child',db,marker],{encoding:'utf8'});
  assert.equal(child.signal,'SIGKILL','child must die after simulated receiver acceptance');
  assert.match(fs.readFileSync(marker,'utf8'),/^key:[a-f0-9]{64}$/,'receiver receives stable idempotency key');
  const ledger=new NotifyLedger(db);let published=0;
  try {
    await assert.rejects(ledger.send('worker','message','stable-key',async()=>{published++;}),/uncertain/);
    assert.equal(published,0,'recovery must not blindly republish a pending key');
  } finally {ledger.close();}
} finally {fs.rmSync(root,{recursive:true,force:true});}

console.log('PASS notification ledger crash remains uncertain and is not blindly republished');
