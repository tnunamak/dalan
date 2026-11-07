#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const recovery='If the old service is paused, keep it running. Let workers finish or wait for their leases to expire, run `dalan resume` under the old HOME, then retry this drain.';
async function main() {
  const timeoutMs=Number(process.env.DALAN_UPGRADE_DRAIN_TIMEOUT_MS??300000);
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000)throw new Error('DALAN_UPGRADE_DRAIN_TIMEOUT_MS must be an integer of at least 1000');
  const deadline=Date.now()+timeoutMs;
  const fail=message=>{throw new Error(message);};
  const cli=(...args)=>{
    const remaining=deadline-Date.now();
    if(remaining<=0)fail(`Upgrade drain timed out during ${args[0]}.`);
    const result=spawnSync(process.execPath,['bin/dot-worker.mjs',...args,'--json'],{encoding:'utf8',timeout:remaining,killSignal:'SIGKILL'});
    if(result.error?.code==='ETIMEDOUT')fail(`Upgrade drain timed out during ${args[0]}.`);
    if(result.status!==0)fail(`dalan ${args[0]} failed: ${(result.stderr||result.stdout||`exit ${result.status}`).trim()}.`);
    try { return JSON.parse(result.stdout); } catch { fail(`dalan ${args[0]} printed no JSON.`); }
  };
  cli('pause','--reason','upgrade drain');
  console.log('Claims paused. New submissions are still accepted while the drain waits.');
  while(true) {
    const {claims=[]}=cli('claims');
    const open=claims.filter(claim=>{
      const expiry=Date.parse(claim.lease_expires_at);
      return !Number.isFinite(expiry)||expiry>Date.now();
    });
    if(!open.length)break;
    for(const claim of open)console.log(`Waiting for ${claim.request_id}; lease expires ${claim.lease_expires_at}.`);
    if(Date.now()>=deadline)fail('Upgrade drain timed out while claims were still active.');
    await delay(Math.min(1000,Math.max(50,deadline-Date.now())));
  }
  console.log('No unexpired claims remain. An expired lease revokes its old claim ID but does not prove its process stopped; the new service will sweep the row back to the queue, where the claimant can resume the work only with a fresh claim epoch after stopping the old run.');
  console.log('Stop the old service, update the code, start the new service with the same HOME and configuration, then run `dalan resume` to release the persisted pause.');
}

main().catch(error=>{
  console.error(`${error?.message??String(error)}\n${recovery}`);
  process.exitCode=1;
});
