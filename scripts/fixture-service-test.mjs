import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {test} from 'node:test';
import {cleanupFixture,createFixtureService,listeningPort} from './lib/fixture-service.mjs';

class FakeChild extends EventEmitter {
  stdout=new EventEmitter();stderr=new EventEmitter();pid=123;exitCode=null;signalCode=null;kills=[];
  ignoreKill=false;
  exit(code,signal=null){this.exitCode=code;this.signalCode=signal;this.emit('exit',code,signal);this.emit('close',code,signal);}
  kill(signal){this.kills.push(signal);if(!this.ignoreKill)this.exit(null,signal);return true;}
}
function controlled(tick){
  const child=new FakeChild();let wall=0,mono=0,polls=0;
  const options={spawnChild:()=>child,attempt:1,round:9,phase:'initial',wallNow:()=>wall,monotonicNow:()=>mono,
    sleep:async ms=>{polls++;wall+=ms;mono+=ms;child.emit('spawn');tick?.({child,polls,jump:ms=>{wall+=ms;mono+=ms;}});}};
  return {child,options};
}
const rejection=async promise=>{try{await promise;assert.fail('expected rejection');}catch(error){return error;}};

test('silent startup reports the unchanged deadline and pre-cleanup lifecycle',async()=>{
  const c=controlled(({jump})=>jump(6990));const s=createFixtureService(c.options);
  const error=await rejection(s.ready());
  try {
    assert.equal(error.diagnostic?.classification,'readiness-timeout');
    assert.equal(error.diagnostic.budgetMs,7000);assert.equal(error.diagnostic.elapsedMs,7000);
    assert.equal(error.diagnostic.round,9);assert.equal(error.diagnostic.phase,'initial');
    assert.equal(error.diagnostic.spawnObserved,true);assert.equal(error.diagnostic.pidPresent,true);
    assert.equal(error.diagnostic.stdoutBytes,0);assert.equal(error.diagnostic.stderrBytes,0);
    assert.equal(error.diagnostic.exitObserved,false);assert.equal(error.diagnostic.exitCode,null);
    assert.equal(error.diagnostic.killRequested,false);assert.equal(c.child.kills.length,0);
    await s.stop('SIGKILL');assert.deepEqual(c.child.kills,['SIGKILL']);
    assert.equal(error.diagnostic.killRequested,false,'saved failure snapshot is immutable');
  } finally {await s.stop('SIGKILL');}
});

test('overdue poll reports observed delay without inventing a cause',async()=>{
  const c=controlled(({jump})=>jump(9990)),s=createFixtureService(c.options);
  const error=await rejection(s.ready());
  try {assert.equal(error.diagnostic?.elapsedMs,10000);assert.equal(error.diagnostic.maxPollGapMs,10000);assert(!('cause' in error.diagnostic));}
  finally {await s.stop('SIGKILL');}
});

test('zero and nonzero early exit remain failures with exact observed codes',async()=>{
  for(const code of [0,23]){
    const c=controlled(({child})=>child.exit(code)),s=createFixtureService(c.options);
    const error=await rejection(s.ready());
    try {assert.equal(error.diagnostic?.classification,'early-exit');assert.equal(error.diagnostic.exitCode,code);assert.equal(error.diagnostic.closeObserved,true);}
    finally {await s.stop('SIGKILL');}
  }
});

test('spawn errors expose safe codes, not messages or invented process state',async()=>{
  for(const synchronous of [false,true]){
    const error=Object.assign(new Error('SECRET_ENV_PAYLOAD'),{code:'ENOENT'});
    const c=controlled(({child})=>child.emit('error',error));c.child.pid=undefined;
    c.options.sleep=async()=>{c.child.emit('error',error);};
    if(synchronous)c.options.spawnChild=()=>{throw error;};
    let s;
    const failure=await rejection((async()=>{s=createFixtureService(c.options);await s.ready();})());
    try {assert.equal(failure.diagnostic?.classification,'spawn-error');assert.equal(failure.diagnostic.errorCode,'ENOENT');assert.equal(failure.diagnostic.pidPresent,false);assert.equal(failure.diagnostic.spawnObserved,false);assert(!JSON.stringify(failure.diagnostic).includes('SECRET_ENV_PAYLOAD'));}
    finally {await s?.stop('SIGKILL');}
  }
});

test('chunked readiness updates bounded evidence only after a complete line',async()=>{
  const chunks=['MCP listening on 0.0.0.0:43','127','\r\n'];
  const c=controlled(({child,polls})=>child.stdout.emit('data',Buffer.from(chunks[polls-1]))),s=createFixtureService(c.options);
  try {
    assert.equal(await s.ready(),43127);const before=s.snapshot();
    assert.equal(before.stdoutBytes,Buffer.byteLength(chunks.join('')));assert.equal(before.stdoutFirstMs,10);assert.equal(before.stdoutLastMs,30);
    await s.stop();c.child.stdout.emit('data',Buffer.alloc(100));assert.deepEqual(s.snapshot(),{...before,killRequested:true,killReturned:true,exitObserved:true,closeObserved:true,exitCode:null,signal:'SIGTERM'});
    assert.equal(c.child.stdout.listenerCount('data'),0);assert.equal(c.child.stderr.listenerCount('data'),0);
    for(const event of ['spawn','error','exit','close'])assert.equal(c.child.listenerCount(event),0);
  } finally {await s.stop('SIGKILL');}
});

test('complete/partial/invalid parser behavior is preserved',()=>{
  for(const value of ['MCP listening','MCP listening on 0.0.0.0:43','diagnostic MCP listening on 0.0.0.0:1\n'])assert.equal(listeningPort(value),null);
  assert.equal(listeningPort('MCP listening on 0.0.0.0:43127\n'),43127);
  for(const port of [0,65536])assert.throws(()=>listeningPort(`MCP listening on 0.0.0.0:${port}\n`));
});

test('diagnostic size and attempt state do not depend on secret output volume',async()=>{
  const c=controlled(({child,polls,jump})=>{if(polls===1){child.stderr.emit('data',Buffer.from('SECRET_ENV_PAYLOAD'.repeat(65536)));jump(6990);}});
  const s=createFixtureService(c.options),error=await rejection(s.ready());
  try {assert.ok(error.diagnostic);const formatted=JSON.stringify(error.diagnostic);assert(formatted.length<1500);assert(!formatted.includes('SECRET_ENV_PAYLOAD'));assert.equal(error.diagnostic.stderrBytes,Buffer.byteLength('SECRET_ENV_PAYLOAD'.repeat(65536)));}
  finally {await s.stop('SIGKILL');}
  const next=controlled(({child})=>child.stdout.emit('data',Buffer.from('MCP listening on 0.0.0.0:43128\n'))),fresh=createFixtureService({...next.options,attempt:2,phase:'restart'});
  try {c.child.stderr.emit('data',Buffer.from('LATE_OLD_CHILD'));assert.equal(await fresh.ready(),43128);assert.equal(fresh.snapshot().stderrBytes,0);assert.equal(fresh.snapshot().attempt,2);}
  finally {await fresh.stop('SIGKILL');}
});

test('real child readiness and stop leave no running child',async()=>{
  const s=createFixtureService({attempt:1,round:0,phase:'initial',spawnChild:()=>spawn(process.execPath,['-e','console.log("MCP listening on 0.0.0.0:43127");setInterval(()=>{},1000)'],{stdio:['ignore','pipe','pipe']})});
  try {assert.equal(await s.ready(),43127);assert.equal(s.snapshot().spawnObserved,true);assert.equal(s.snapshot().pidPresent,true);await s.stop('SIGKILL');assert.equal(s.snapshot().exitObserved,true);assert.throws(()=>process.kill(s.child.pid,0),{code:'ESRCH'});}
  finally {if(s.child.exitCode===null&&s.child.signalCode===null){const exited=once(s.child,'exit');s.child.kill('SIGKILL');await exited;}await s.stop('SIGKILL');}
});

test('settled cleanup clears its own timer and preserves external listeners',async()=>{
  const c=controlled(),external=()=>{};c.child.on('close',external);
  c.child.ignoreKill=true;
  const s=createFixtureService(c.options),setTimer=globalThis.setTimeout,clearTimer=globalThis.clearTimeout;
  const owned=new Set();
  globalThis.setTimeout=(...args)=>{const timer=setTimer(...args);owned.add(timer);return timer;};
  globalThis.clearTimeout=timer=>{owned.delete(timer);return clearTimer(timer);};
  try {
    const first=s.stop('SIGKILL');assert.equal(first,s.stop('SIGKILL'));
    c.child.exit(null,'SIGKILL');
    await first;assert.equal(owned.size,0);assert.deepEqual(c.child.listeners('close'),[external]);
    assert.deepEqual(c.child.kills,['SIGKILL']);
  } finally {globalThis.setTimeout=setTimer;globalThis.clearTimeout=clearTimer;await s.stop('SIGKILL');}
});

test('finalizer retains owned files and the primary failure after cleanup timeout',async()=>{
  const c=controlled(({jump})=>jump(6990));c.child.ignoreKill=true;
  const s=createFixtureService(c.options),primary=await rejection(s.ready());
  let owner=s,removed=0,webhookClosed=0;
  const recorded=[primary],finalize=()=>cleanupFixture({
    stop:async()=>{await owner.stop('SIGKILL');owner=null;},
    onStopError:error=>recorded.push(error),
    closeWebhook:async()=>{webhookClosed++;},removeRoot:async()=>{removed++;}
  });
  let timer;
  try {
    await Promise.race([finalize(),new Promise(resolve=>{timer=setTimeout(()=>{c.child.exit(0);resolve();},5500);})]);
    const cleanup=recorded[1];
    assert.equal(cleanup?.diagnostic?.classification,'cleanup-timeout');
    assert.equal(recorded[0],primary);assert.equal(primary.diagnostic?.classification,'readiness-timeout');
    assert.equal(cleanup.diagnostic.killRequested,true);assert.equal(cleanup.diagnostic.exitObserved,false);
    assert.deepEqual(c.child.kills,['SIGKILL']);assert.equal(owner,s,'unsettled service remains owned');
    assert.equal(removed,0,'unsettled service must retain its fixture files');assert.equal(webhookClosed,1);
    c.child.exit(0);await finalize();
    assert.equal(owner,null);assert.equal(removed,1,'confirmed close permits normal removal');
    assert.equal(recorded.length,2,'primary and cleanup failure stay recorded');
  } finally {clearTimeout(timer);c.child.exit(0);await s.stop('SIGKILL').catch(()=>{});}
});
