import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';

export async function cleanupFixture({stop,closeWebhook,removeRoot,onStopError}) {
  let stopped=false;
  try {await stop();stopped=true;}
  catch(error) {onStopError(error);}
  await closeWebhook();
  // A termination timeout leaves the child and its HOME under our ownership.
  if(stopped)await removeRoot();
}

export function listeningPort(stdout) {
  const match = stdout.match(/^MCP listening on [^\r\n]+:(\d+)\r?\n/m);
  if (!match) return null;
  const value = Number(match[1]);
  assert(Number.isInteger(value) && value > 0 && value <= 65535, 'invalid bound port');
  return value;
}

// Private fixture lifecycle: raw capture preserves the old failure dump, while
// diagnostic snapshots contain only a fixed set of safe scalar observations.
export function createFixtureService({spawnChild,attempt,round,phase,wallNow=Date.now,monotonicNow=()=>performance.now(),sleep=delay}) {
  assert(Number.isSafeInteger(attempt)&&attempt>0&&Number.isSafeInteger(round)&&round>=0&&['initial','restart'].includes(phase),'invalid fixture lifecycle metadata');
  let started=monotonicNow();
  const state={attempt,round,phase,budgetMs:7000,spawnObserved:false,pidPresent:false,errorCode:null,
    exitObserved:false,exitCode:null,signal:null,closeObserved:false,
    stdoutBytes:0,stderrBytes:0,stdoutFirstMs:null,stdoutLastMs:null,stderrFirstMs:null,stderrLastMs:null,
    lastPollMs:null,maxPollGapMs:0,killRequested:false,killReturned:null};
  const elapsed=()=>Math.max(0,Math.round(monotonicNow()-started));
  const snapshot=(classification='observation')=>Object.freeze({...state,classification,elapsedMs:elapsed()});
  const failure=classification=>Object.assign(new Error('fixture service '+classification),{diagnostic:snapshot(classification)});
  const safeCode=error=>typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)?error.code:null;
  let child=null,spawnError,stdout='',output='',resolveClose;
  let stopping,stopSignal;
  const closed=new Promise(resolve=>{resolveClose=resolve;});
  const spawned=()=>{state.spawnObserved=true;state.pidPresent=Number.isInteger(child.pid)&&child.pid>0;};
  const errored=error=>{spawnError=error;state.errorCode=safeCode(error);};
  const exited=(code,signal)=>{state.exitObserved=true;state.exitCode=code;state.signal=signal;};
  const capture=(kind,data)=>{
    const size=Buffer.isBuffer(data)?data.length:Buffer.byteLength(data);
    state[kind+'Bytes']+=size;
    state[kind+'FirstMs']??=elapsed();state[kind+'LastMs']=elapsed();
    if(kind==='stdout')stdout+=data;
    output+=data;
  };
  const out=data=>capture('stdout',data),err=data=>capture('stderr',data);
  const dispose=()=>{
    child?.stdout.off('data',out);child?.stderr.off('data',err);
    child?.off('spawn',spawned);child?.off('error',errored);child?.off('exit',exited);child?.off('close',close);
  };
  const close=()=>{state.closeObserved=true;resolveClose();dispose();};
  try {
    child=spawnChild();
    started=monotonicNow();
    state.pidPresent=Number.isInteger(child.pid)&&child.pid>0;
    child.stdout.on('data',out);child.stderr.on('data',err);
    child.on('spawn',spawned);child.on('error',errored);child.on('exit',exited);child.on('close',close);
  } catch(error) {spawnError=error;state.errorCode=safeCode(error);}
  // Preserve the original wall-clock budget and ten-millisecond polling cadence.
  const deadline=wallNow()+7000;
  return {
    child,
    get output(){return output;},
    snapshot,
    async ready(){
      for(;;){
        const poll=elapsed();
        if(state.lastPollMs!==null)state.maxPollGapMs=Math.max(state.maxPollGapMs,poll-state.lastPollMs);
        state.lastPollMs=poll;
        const port=listeningPort(stdout);
        if(port!==null)return port;
        if(spawnError)throw failure('spawn-error');
        if(state.exitObserved||child.exitCode!==null||child.signalCode!==null)throw failure('early-exit');
        if(wallNow()>=deadline)throw failure('readiness-timeout');
        await sleep(10);
      }
    },
    stop(signal='SIGTERM'){
      // A later explicit SIGKILL can escalate failed SIGTERM cleanup. Repeated
      // requests for the same signal share one attempt rather than double-kill.
      if(state.closeObserved)return closed;
      if(stopping&&stopSignal===signal)return stopping;
      stopSignal=signal;
      stopping=(async()=>{
        if(!child||(!state.pidPresent&&spawnError)){dispose();return;}
        if(!state.exitObserved&&child.exitCode===null&&child.signalCode===null){
          state.killRequested=true;state.killReturned=child.kill(signal);
        }
        let timer;
        try {
          await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure('cleanup-timeout')),5000);})]);
        } finally {clearTimeout(timer);}
      })();
      return stopping;
    }
  };
}
