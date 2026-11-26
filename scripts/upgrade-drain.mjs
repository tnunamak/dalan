#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

// Default: quiesce when the running service has the gate (admission refused for seconds, live leases survive the restart), else pause
// and wait for leases (a claim blackout as long as the longest lease: up to 20 minutes per deploy for a worker whose lease is 15).
// --until-quiescent insists on the gate and fails without it; --pause insists on the old pause-and-wait drain. Only a positive answer
// from the service picks a mode: counters mean the gate; an HTTP 404 for the route means a legacy service. Any other failure is
// retried briefly, then the drain stops without touching the service and asks for an explicit flag.
const args=process.argv.slice(2);
const extraArgs=args.filter(arg=>arg!=='--until-quiescent'&&arg!=='--pause');
if(extraArgs.length){console.error(`upgrade-drain: unknown argument ${JSON.stringify(extraArgs[0])}. The options are --until-quiescent and --pause.`);process.exit(2);}
if(args.includes('--until-quiescent')&&args.includes('--pause')){console.error('upgrade-drain: --until-quiescent and --pause exclude each other.');process.exit(2);}
let untilQuiescent=args.includes('--until-quiescent');
const forcePause=args.includes('--pause');
const gateCounters=['admitted_in_flight','delivery_in_flight','host_checks_unverified'];
const quiesceRecovery='If the old service is still quiesced, keep it running and run `dalan quiesce off` under the old HOME before retrying.';
// The gate must never stay closed after an aborted drain: a closed gate starves every worker with no signal. It stays closed only
// after the poll succeeds, because the restart that follows reopens it. The reopen call has its own timeout, not the drain deadline.
let gateClosed=false;
// A cleanup call counts only when its reply shows the state it asked for; exit 0 alone does not.
const jsonOf=text=>{try{return JSON.parse(text);}catch{return null;}};
function reopenGate(why) {
  if(!gateClosed)return;
  const result=spawnSync(process.execPath,['bin/dot-worker.mjs','quiesce','off','--json'],{encoding:'utf8',timeout:10000,killSignal:'SIGKILL'});
  if(result.status===0&&jsonOf(result.stdout)?.on===false){gateClosed=false;console.error(`drain aborted (${why}); gate reopened`);}
  else console.error(`drain aborted (${why}); the gate could NOT be confirmed reopened: ${(result.stderr||result.stdout||`exit ${result.status}`).trim()}`);
}
// A pause this run issued must not outlive an aborted run: claims would stay refused with no signal. A pause that was already there
// belongs to the operator and is never released here. After the drain completes, the pause is the documented handoff to the restart.
let pausedByRun=false;
function resumeOwnedPause(why) {
  if(!pausedByRun)return;
  const result=spawnSync(process.execPath,['bin/dot-worker.mjs','resume','--json'],{encoding:'utf8',timeout:10000,killSignal:'SIGKILL'});
  if(result.status===0&&jsonOf(result.stdout)?.paused===false){pausedByRun=false;console.error(`drain aborted (${why}); claims resumed`);}
  else console.error(`drain aborted (${why}); the pause could NOT be confirmed released: ${(result.stderr||result.stdout||`exit ${result.status}`).trim()}`);
}
const abortCleanup=why=>{reopenGate(why);resumeOwnedPause(why);};
for(const [name,code] of [['SIGINT',130],['SIGTERM',143],['SIGHUP',129]])process.on(name,()=>{abortCleanup(name);process.exit(code);});
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
  if(!untilQuiescent&&!forcePause) {
    // 'gate': the service answered with the in-flight counters. 'legacy': it answered HTTP 404 for the route, so it predates the gate.
    // 'unknown': anything else (a transport error, a timeout, a bad body); that proves nothing about the service.
    const probeOnce=()=>{
      const probe=spawnSync(process.execPath,['bin/dot-worker.mjs','quiesce','status','--json'],{encoding:'utf8',timeout:Math.min(10000,Math.max(1,deadline-Date.now())),killSignal:'SIGKILL'});
      if(probe.status===0) {
        let status=null;
        try { status=JSON.parse(probe.stdout); } catch {}
        return status&&typeof status==='object'&&gateCounters.every(name=>Number.isSafeInteger(status[name])&&status[name]>=0)?'gate':'unknown';
      }
      let error=null;
      try { error=JSON.parse(probe.stderr||probe.stdout); } catch {}
      return error?.kind==='http'&&error.http_status===404?'legacy':'unknown';
    };
    let mode='unknown';
    for(let attempt=1;attempt<=3&&mode==='unknown';attempt++) {
      mode=probeOnce();
      if(mode==='unknown'&&attempt<3&&Date.now()<deadline)await delay(1000);
    }
    if(mode==='unknown')fail('could not tell whether the running service has the quiesce gate (the status call failed three times). Nothing was changed. Retry, or pass --until-quiescent or --pause.');
    untilQuiescent=mode==='gate';
    console.log(untilQuiescent
      ?'The running service has the quiesce gate: draining without a pause.'
      :'The running service has no quiesce gate: pausing claims and waiting for live leases (claims stay refused until the longest lease ends).');
  }
  if(untilQuiescent) {
    gateClosed=true;
    if(cli('quiesce','on')?.on!==true)fail('dalan quiesce on did not report the gate as closed.');
    console.log('Admission is quiesced. Live leases survive a restart using the same database and are not waited on.');
    const names=gateCounters;
    for(;;) {
      const status=cli('quiesce','status');
      if(!status||typeof status!=='object'||names.some(name=>!Number.isSafeInteger(status[name])||status[name]<0))
        fail('dalan quiesce status returned invalid in-flight counters.');
      if(status.on!==true)fail('dalan quiesce status says admission is open after quiesce on.');
      if(names.every(name=>status[name]===0))break;
      if(Date.now()>=deadline)fail('Upgrade drain timed out while work was still in flight.');
      await delay(Math.min(1000,Math.max(0,deadline-Date.now())));
    }
    gateClosed=false;
    console.log('No admitted calls, deliveries or unverified host checks remain. Restart with the same HOME and database; the new process starts with admission open. If you do not restart, run `dalan quiesce off` to reopen it.');
    return;
  }
  const before=cli('status');
  if(typeof before?.paused!=='boolean')fail('dalan status did not report whether claims are paused. Nothing was changed.');
  if(before.paused)console.log(`Claims were already paused${before.pause_reason?` (${before.pause_reason})`:''}; this drain leaves that pause as it is.`);
  else {
    pausedByRun=true;
    if(cli('pause','--reason','upgrade drain')?.paused!==true)fail('dalan pause did not report claims as paused.');
    console.log('Claims paused. New submissions are still accepted while the drain waits.');
  }
  while(true) {
    const {claims}=cli('claims');
    if(!Array.isArray(claims))fail('the claims list came back without a claims array. Nothing is known about live leases; retry.');
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
  pausedByRun=false;
  console.log('Stop the old service, update the code, start the new service with the same HOME and configuration, then run `dalan resume` to release the persisted pause.');
}

main().catch(error=>{
  abortCleanup('failure');
  console.error(`${error?.message??String(error)}\n${untilQuiescent?quiesceRecovery:recovery}`);
  process.exitCode=1;
});
