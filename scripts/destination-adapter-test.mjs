#!/usr/bin/env node
// Drives adapters with injected fakes plus one isolated fake-CLI process test.
// No real T3 or store file; the process fixture restores its temporary env.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createT3Destination, quietReason } from '../src/destinations/t3.mjs';
import { createNoneDestination } from '../src/destinations/none.mjs';
import { createDestinations, destinationName } from '../src/destinations/index.mjs';
import { Store } from '../src/store.mjs';
import { sendArgs, marker, inspectThread, deliverT3, reconcileMarker, readArgs } from '../src/t3.mjs';

const thread='thread-under-test', environment='env-under-test', rid='req_adapter_test';
const report={outcome:'completed',summary:'x'.repeat(600)};
const baseRow=(over={})=>({request_id:rid,delivery_mode:`t3:${thread}`,thread_id:thread,environment_id:environment,status:'finished',report,watch:null,t3_muted:false,...over});
const items={
  t3:{id:'evt_t3',kind:'t3',request_id:rid},
  blocker:{id:'evt_blocker',kind:'blocker',request_id:rid,body:JSON.stringify({note:'QUESTION: which branch?'})},
  watch:{id:'evt_watch',kind:'watch',request_id:rid},
};
const watchRow=(over={})=>baseRow({status:'claimed',watch:{state:'fired',notification_id:'evt_watch'},...over});

// One scenario: rows[i] is what store.get returns on its i-th call (last repeats); inspect/quiet likewise per call.
async function run({kind='t3',rows=[baseRow(kind==='blocker'?{status:'claimed'}:{})],inspect=[{state:'active'},{state:'active'}],quiet=[null,null],paused=false,pauseOnSecondInspect=false,attemptCurrent=true,send=async()=>({}),attempts=0,dryRun=false,maxRetry=8,crash=false}) {
  const seen={gets:0,order:[],inspects:[],quietCalls:0,quieted:[],notified:[],sends:[],logs:[],exits:[]};
  const pick=(list,i)=>list[Math.min(i,list.length-1)];
  const store={
    get(id) { assert.equal(id,rid); return pick(rows,seen.gets++); },
    paused:()=>seen.pauseRaised|| (typeof paused==='function'?paused():paused),
    deliveryAttemptIsCurrent:()=>typeof attemptCurrent==='function'?attemptCurrent():attemptCurrent,
    quietDelivery(id,reason) { seen.quieted.push([id,reason]); },
  };
  const destination=createT3Destination({
    store,
    inspectThread:async(t,e)=>{ const step=pick(inspect,seen.inspects.length); seen.inspects.push([t,e]); seen.order.push('inspect'); if(pauseOnSecondInspect&&seen.inspects.length===2) seen.pauseRaised=true; if(step instanceof Error) throw step; return step; },
    callT3:async(argv,input)=>{ seen.sends.push([argv,input]); seen.order.push('send'); return send(argv,input); },
    quiet:()=>{ seen.order.push('quiet'); return pick(quiet,seen.quietCalls++); },
    notify:id=>seen.notified.push(id),
    log:entry=>seen.logs.push(entry),
    crashAt:(point,id)=>crash&&point==='after_t3_send'&&id===rid,
    exit:code=>seen.exits.push(code),
    env:dryRun?{DOT_BRIDGE_T3_DRY_RUN:'1'}:{},
    authRetryMax:()=>maxRetry,
    mainThreadIds:()=>{ throw new Error('mainThreadIds must not be read when quiet is injected'); },
  });
  const item=items[kind], argv=destination.argv(item,rows[0]);
  const result=await destination.send(item,{started:{...item,attempts,attempt_id:'attempt_x'},argv});
  return {result,seen,argv,item};
}
const expectNoSend=seen=>assert.equal(seen.sends.length,0,'no T3 send');
const expectMessage=(kind,row=baseRow())=>kind==='watch'?`${marker('evt_watch')} Attention: request ${rid} remains ${row.status}. Inspect with dalan get ${rid} --json.`:
  kind==='blocker'?`${marker('evt_blocker')} Worker question for request ${rid}: QUESTION: which branch?\nReply with dalan note ${rid} "your answer" so the assigned worker receives it.`:
  `${marker('evt_t3')} Request ${rid}: completed — ${'x'.repeat(500)}\nFetch full report: dalan get ${rid} --json`;
const passed=[];
const row=async(name,fn)=>{ await fn(); passed.push(name); };

// argv: exact t3code argv, blocker steers, others queue.
for(const kind of ['t3','blocker','watch']) assert.deepEqual(createT3Destination({store:{}}).argv(items[kind],baseRow()),['threads','send','--thread',thread,'--stdin','--if-busy','steer']);
assert.deepEqual(createT3Destination({store:{}}).argv(items.t3,baseRow()),sendArgs(thread,'t3'));

await row('request cancelled before attempt → suppressed "request resolved"',async()=>{
  const {result,seen}=await run({rows:[baseRow({status:'cancelled'})]});
  assert.deepEqual(result,{state:'suppressed',reason:'request resolved',sendStarted:false}); assert.equal(seen.inspects.length,0); expectNoSend(seen);
});
await row('watch on finished / superseded request → suppressed "request resolved"',async()=>{
  for(const rows of [[watchRow({status:'finished'})],[watchRow({watch:{state:'fired',notification_id:'evt_other'}})]]) {
    const {result,seen}=await run({kind:'watch',rows});
    assert.deepEqual(result,{state:'suppressed',reason:'request resolved',sendStarted:false}); assert.equal(seen.inspects.length,0); expectNoSend(seen);
  }
});
await row('dry run → delivered, t3_dry_run log with argv and message, no inspect or send',async()=>{
  for(const kind of ['t3','blocker']) {
    const {result,seen,argv}=await run({kind,dryRun:true});
    assert.deepEqual(result,{state:'delivered',reason:'',sendStarted:false});
    assert.deepEqual(seen.logs,[{kind:'t3_dry_run',event_id:items[kind].id,argv,message:expectMessage(kind)}]);
    assert.equal(seen.inspects.length,0); expectNoSend(seen);
  }
});
await row('dry run + crash hook → exit(72)',async()=>{ const {seen}=await run({dryRun:true,crash:true}); assert.deepEqual(seen.exits,[72]); });
await row('quiet after first inspect → quietDelivery + notify, pending, one inspect',async()=>{
  for(const reason of ['assignment delivery muted','protected T3 destination','delivery policy unavailable: boom']) {
    const {result,seen}=await run({quiet:[reason]});
    assert.deepEqual(result,{state:'pending',reason:'',sendStarted:false});
    assert.deepEqual(seen.quieted,[['evt_t3',reason]]); assert.deepEqual(seen.notified,[rid]);
    assert.equal(seen.inspects.length,1); assert.equal(seen.quietCalls,1); expectNoSend(seen);
  }
});
await row('quiet wins over paused and inactive thread (check order)',async()=>{
  const {result,seen}=await run({quiet:['assignment delivery muted'],paused:true,inspect:[{state:'stopped'}]});
  assert.equal(result.state,'pending'); assert.equal(result.reason,''); assert.equal(seen.quieted.length,1);
});
await row('paused before send → pending "bridge paused before send"',async()=>{
  const {result,seen}=await run({paused:true,inspect:[{state:'stopped'}]});
  assert.deepEqual(result,{state:'pending',reason:'bridge paused before send',sendStarted:false}); assert.equal(seen.quieted.length,0); expectNoSend(seen);
});
await row('cancelled between attempt and send → suppressed "request resolved before send"',async()=>{
  const {result,seen}=await run({rows:[baseRow(),baseRow({status:'cancelled'})]});
  assert.deepEqual(result,{state:'suppressed',reason:'request resolved before send',sendStarted:false}); assert.equal(seen.inspects.length,1); expectNoSend(seen);
});
await row('watch resolved before send (finished, not fired, superseded) → suppressed',async()=>{
  for(const later of [watchRow({status:'finished'}),watchRow({watch:{state:'cleared',notification_id:'evt_watch'}}),watchRow({watch:{state:'fired',notification_id:'evt_new'}}),watchRow({watch:null})]) {
    const {result}=await run({kind:'watch',rows:[watchRow(),later]});
    assert.deepEqual(result,{state:'suppressed',reason:'request resolved before send',sendStarted:false});
  }
});
await row('precedence: paused before resolved, resolved before inactive thread',async()=>{
  let {result}=await run({paused:true,rows:[baseRow(),baseRow({status:'cancelled'})],inspect:[{state:'stopped'}]});
  assert.deepEqual(result,{state:'pending',reason:'bridge paused before send',sendStarted:false});
  ({result}=await run({rows:[baseRow(),baseRow({status:'cancelled'})],inspect:[{state:'uncertain_lifecycle'}]}));
  assert.deepEqual(result,{state:'suppressed',reason:'request resolved before send',sendStarted:false});
});
await row('first inspect not active → suppressed "thread <state>", uncertain_lifecycle → uncertain',async()=>{
  for(const state of ['stopped','settled','archived','deleted','cancelled','canceled','unavailable']) {
    const {result,seen}=await run({inspect:[{state}]});
    assert.deepEqual(result,{state:'suppressed',reason:`thread ${state}`,sendStarted:false}); assert.equal(seen.inspects.length,1); expectNoSend(seen);
  }
  const {result,seen}=await run({inspect:[{state:'uncertain_lifecycle'}]});
  assert.deepEqual(result,{state:'uncertain',reason:'thread uncertain_lifecycle',sendStarted:false}); assert.equal(seen.inspects.length,1); expectNoSend(seen);
});
await row('quiet after second inspect → quietDelivery + notify, pending, two inspects',async()=>{
  const {result,seen}=await run({quiet:[null,'protected T3 destination'],inspect:[{state:'active'},{state:'stopped'}]});
  assert.deepEqual(result,{state:'pending',reason:'',sendStarted:false});
  assert.deepEqual(seen.quieted,[['evt_t3','protected T3 destination']]); assert.deepEqual(seen.notified,[rid]); assert.equal(seen.inspects.length,2); expectNoSend(seen);
});
await row('second inspect await rechecks pause, cancellation, target/body binding and attempt before ACK/send',async()=>{
  const cases=[
    {name:'paused',pauseOnSecondInspect:true,rows:[baseRow(),baseRow(),baseRow()],expected:'pending'},
    {name:'cancelled',rows:[baseRow(),baseRow(),baseRow({status:'cancelled'})],expected:'suppressed'},
    {name:'rebound',rows:[baseRow(),baseRow(),baseRow({thread_id:'thread-new',delivery_mode:'t3:thread-new'})],expected:'pending'},
    {name:'body changed',rows:[baseRow(),baseRow(),baseRow({report:{...report,summary:'changed'}})],expected:'pending'},
    {name:'attempt changed',attemptCurrent:false,expected:'pending'},
  ];
  for(const test of cases) {
    const {result,seen}=await run(test);
    assert.equal(result.state,test.expected,test.name);
    expectNoSend(seen);
  }
});
await row('second inspect not active → suppressed / uncertain',async()=>{
  let {result,seen}=await run({inspect:[{state:'active'},{state:'stopped'}]});
  assert.deepEqual(result,{state:'suppressed',reason:'thread stopped',sendStarted:false}); assert.equal(seen.inspects.length,2); expectNoSend(seen);
  ({result,seen}=await run({inspect:[{state:'active'},{state:'uncertain_lifecycle'}]}));
  assert.deepEqual(result,{state:'uncertain',reason:'thread uncertain_lifecycle',sendStarted:false}); expectNoSend(seen);
});
await row('active, active → send exact argv and message → delivered',async()=>{
  for(const kind of ['t3','blocker','watch']) {
    const rows=kind==='watch'?[watchRow()]:[baseRow(kind==='blocker'?{status:'claimed'}:{})];
    const {result,seen,argv}=await run({kind,rows});
    assert.deepEqual(result,{state:'delivered',reason:'',sendStarted:true});
    assert.deepEqual(seen.inspects,[[thread,environment],[thread,environment]]);
    assert.deepEqual(seen.order,['inspect','quiet','inspect','quiet','send'],'policy is reread after each inspect, the last one right before the send');
    assert.deepEqual(seen.sends,[[argv,expectMessage(kind,rows[0])]]);
    assert.equal(seen.gets,3,'row read before message, re-read after each inspect'); assert.deepEqual(seen.exits,[]);
  }
});
await row('delivered + crash hook → exit(72); non-delivered + crash hook → no exit',async()=>{
  assert.deepEqual((await run({crash:true})).seen.exits,[72]);
  assert.deepEqual((await run({crash:true,inspect:[{state:'stopped'}]})).seen.exits,[]);
  assert.deepEqual((await run({crash:true,send:async()=>{ throw new Error('boom'); }})).seen.exits,[]);
});
const authError=()=>{ throw new Error('t3code exit 1: Invalid session credential'); };
await row('pre-accept auth rejection below max → pending, will retry',async()=>{
  const {result}=await run({send:authError,attempts:0});
  assert.deepEqual(result,{state:'pending',reason:'pre-accept auth rejection (attempt 1/8), will retry: t3code exit 1: Invalid session credential',sendStarted:true});
  assert.equal((await run({send:authError,attempts:1,maxRetry:3})).result.reason,'pre-accept auth rejection (attempt 2/3), will retry: t3code exit 1: Invalid session credential');
});
await row('pre-accept auth rejection at max → uncertain, persisted',async()=>{
  const {result}=await run({send:authError,attempts:7});
  assert.deepEqual(result,{state:'uncertain',reason:'pre-accept auth rejection persisted for 8 attempts: t3code exit 1: Invalid session credential',sendStarted:true});
  assert.equal((await run({send:authError,attempts:9})).result.reason,'pre-accept auth rejection persisted for 10 attempts: t3code exit 1: Invalid session credential');
});
await row('other send error → uncertain with the error message',async()=>{
  const {result,seen}=await run({send:async()=>{ throw new Error('t3code timeout after 15000ms'); }});
  assert.deepEqual(result,{state:'uncertain',reason:'t3code timeout after 15000ms',sendStarted:true}); assert.deepEqual(seen.logs,[]);
});
await row('inspect throws → pending, delivery_error log, never sends',async()=>{
  for(const inspect of [[new Error('t3 down')],[{state:'active'},new Error('t3 down')]]) {
    const {result,seen}=await run({inspect});
    assert.deepEqual(result,{state:'pending',reason:'t3 down',sendStarted:false});
    assert.deepEqual(seen.logs,[{kind:'delivery_error',event_id:'evt_t3',reason:'t3 down'}]); expectNoSend(seen);
  }
});

// Default quiet policy, validate, admit, reconcile.
await row('quietReason: muted, protected, policy unavailable, none',async()=>{
  assert.equal(quietReason(baseRow({t3_muted:true}),()=>{ throw new Error('unread'); }),'assignment delivery muted');
  assert.equal(quietReason(baseRow(),()=>[thread]),'protected T3 destination');
  assert.equal(quietReason(baseRow(),()=>{ throw new Error('bad limits'); }),'delivery policy unavailable: bad limits');
  assert.equal(quietReason(baseRow(),()=>['other']),null);
  assert.equal(quietReason(baseRow({thread_id:null}),()=>{ throw new Error('unread'); }),null);
  const d=createT3Destination({store:{},mainThreadIds:()=>[thread]});
  assert.equal(d.quietReason(baseRow()),'protected T3 destination','default quiet uses injected mainThreadIds');
});
await row('validate: exact inspect argv, environment binding, thread unavailable',async()=>{
  const calls=[];
  const make=data=>createT3Destination({store:{},callT3:async argv=>{ calls.push(argv); return data; }});
  assert.deepEqual(await make({thread:{id:thread},runtime:{environmentId:'env1'}}).validate({mode:'t3',threadId:thread}),{environmentId:'env1'});
  assert.deepEqual(calls[0],['threads','inspect','--thread',thread]);
  for(const data of [{},{thread:{id:thread,deletedAt:'x'},runtime:{environmentId:'e'}},{thread:{id:thread},runtime:{}},{thread:{id:'different'},runtime:{environmentId:'e'}},{thread:{},runtime:{environmentId:'e'}}]) await assert.rejects(make(data).validate({mode:'t3',threadId:thread}),/^Error: thread unavailable$/);
});
await row('admit: protected destination refused unless allowMain',async()=>{
  const d=createT3Destination({store:{},mainThreadIds:()=>[thread]});
  assert.throws(()=>d.admit({mode:'t3',threadId:thread}),/^Error: protected T3 destination$/);
  assert.throws(()=>d.admit({mode:'t3',threadId:thread},{allowMain:false}),/protected T3 destination/);
  d.admit({mode:'t3',threadId:thread},{allowMain:true}); d.admit({mode:'t3',threadId:'other-thread'});
  assert.throws(()=>createT3Destination({store:{},mainThreadIds:()=>{ throw new Error('bad limits'); }}).admit({mode:'t3',threadId:thread},{allowMain:true}),/bad limits/,'policy read errors propagate even with allowMain');
});
await row('reconcile: passes marker outcome through, error → ambiguous',async()=>{
  const args=[];
  const ok=createT3Destination({store:{},reconcileMarker:async(...a)=>{ args.push(a); return {state:'confirmed'}; }});
  assert.deepEqual(await ok.reconcile({id:'evt_t3'},baseRow()),{state:'confirmed'}); assert.deepEqual(args,[[thread,environment,'evt_t3']]);
  const bad=createT3Destination({store:{},reconcileMarker:async()=>{ throw new Error('t3 down'); }});
  assert.deepEqual(await bad.reconcile({id:'evt_t3'},baseRow()),{state:'ambiguous',reason:'t3 down'});
});


await row('metadata process: inspect only, fail-closed identity and lifecycle; transcript reconciliation stays read',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'t3-inspect-test-'));
  const bin=path.join(dir,'fake-t3'), input=path.join(dir,'metadata.json'), log=path.join(dir,'calls.jsonl');
  const names=['NODE_ENV','DOT_BRIDGE_T3CODE_BIN'];
  const saved=new Map(names.map(k=>[k,process.env[k]]));
  fs.writeFileSync(bin, '#!'+process.execPath+'\n'+
    'const fs=require("fs");const args=process.argv.slice(2);'+
    'const data=JSON.parse(fs.readFileSync('+JSON.stringify(input)+',"utf8"));'+
    'fs.appendFileSync('+JSON.stringify(log)+',JSON.stringify(args)+"\\n");'+
    'if(args[3]!=="threads")process.exit(9);'+
    'if(args[4]==="inspect"){if(data.unsupported){console.error("unknown command: inspect");process.exit(2);}console.log(JSON.stringify({ok:true,data:data.metadata}));}'+
    'else if(args[4]==="read"&&args.includes("messages"))console.log(JSON.stringify({ok:true,data:data.transcript}));'+
    'else if(args[4]==="send")console.log(JSON.stringify({ok:true,data:{}}));'+
    'else {console.error("metadata transcript read forbidden");process.exit(3);}',{mode:0o700});
  const readLog=()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  const set=(metadata,more={})=>{fs.writeFileSync(input,JSON.stringify({metadata,...more}));fs.writeFileSync(log,'');};
  try {
    process.env.NODE_ENV='test';process.env.DOT_BRIDGE_T3CODE_BIN=bin;
    const active={thread:{id:thread,status:'active'},runtime:{environmentId:environment}};
    set(active);
    assert.deepEqual(await inspectThread(thread,environment),{state:'active'});
    assert.deepEqual(readLog(),[['--json','--origin','http://127.0.0.1:3773','threads','inspect','--thread',thread]]);
    // Source assertion complements the real fake-process call: no test timeout override.
    const source=fs.readFileSync(new URL('../src/t3.mjs',import.meta.url),'utf8');
    assert.match(source,/const timeoutMs = options.timeoutMs \?\? 15000/);
    for(const metadata of [{},{thread:null,runtime:active.runtime},{thread:{id:'other',status:'active'},runtime:active.runtime},
      {thread:active.thread},{thread:active.thread,runtime:{}},{thread:active.thread,runtime:{environmentId:'wrong'}}]) {
      set(metadata);assert.deepEqual(await inspectThread(thread,environment),{state:'unavailable'});
      assert.equal(readLog().length,1);assert.equal(readLog()[0][4],'inspect');
    }
    set({thread:active.thread});assert.deepEqual(await inspectThread(thread,undefined),{state:'unavailable'});
    for(const [fields,state] of [
      [{status:'stopped'},'stopped'],[{status:'settled'},'settled'],[{status:'archived'},'archived'],
      [{status:'deleted'},'deleted'],[{status:'active',archivedAt:'2026-01-01'},'archived'],
      [{status:'active',deletedAt:'2026-01-01'},'unavailable'],
      [{status:'active',latestRun:{status:'stopped'}},'stopped'],
      [{status:'unknown'},'uncertain_lifecycle'],[{},'uncertain_lifecycle']]) {
      set({thread:{id:thread,...fields},runtime:active.runtime});
      assert.deepEqual(await inspectThread(thread,environment),{state});
      const outcome=await deliverT3(thread,environment,'evt_fixture','fixture');
      assert.equal(outcome.state,'definite_failure');
      assert.ok(readLog().every(argv=>argv[4]==='inspect'),'inactive metadata must never send/read');
    }
    set(active,{unsupported:true});
    await assert.rejects(inspectThread(thread,environment),/requires supported threads inspect.*unknown command: inspect/);
    assert.equal(readLog().length,1);assert.equal(readLog()[0][4],'inspect');
    // Reconciliation has genuinely different transcript data, not metadata masquerading as messages.
    set(active,{transcript:{thread:{id:thread,messages:[{role:'user',text:marker('evt_fixture')}]},runtime:active.runtime}});
    assert.deepEqual(await reconcileMarker(thread,environment,'evt_fixture'),{state:'confirmed'});
    assert.deepEqual(readLog(),[['--json','--origin','http://127.0.0.1:3773','threads','read','--thread',thread,'--detail','messages']]);
    for(const transcript of [
      {thread:{id:'other',messages:[{role:'user',text:marker('evt_fixture')}]},runtime:active.runtime},
      {thread:{id:thread,messages:[{role:'assistant',text:marker('evt_fixture')}]},runtime:active.runtime},
      {thread:{id:thread,messages:[{role:'tool',text:marker('evt_fixture')}]},runtime:active.runtime},
      {thread:{id:thread,messages:[{role:'user',text:marker('evt_fixture'),textTruncated:true}]},runtime:active.runtime},
      {thread:{id:thread,messages:[]},runtime:{environmentId:'wrong'}}
    ]) {
      set(active,{transcript});
      const outcome=await reconcileMarker(thread,environment,'evt_fixture');
      assert.notEqual(outcome.state,'confirmed','marker evidence must be exact, user-authored, untruncated and environment-bound');
    }
    assert.deepEqual(readArgs({thread,detail:'answers',turns:1,max_chars:100}),
      ['threads','read','--thread',thread,'--detail','answers','--turns','1','--max-chars','100']);
  } finally {
    for(const [k,v] of saved)if(v===undefined)delete process.env[k];else process.env[k]=v;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
await row('validate: unsupported inspect fails closed without transcript fallback',async()=>{
  const calls=[];
  const d=createT3Destination({store:{},callT3:async argv=>{calls.push(argv);throw new Error('unknown command: inspect');}});
  await assert.rejects(d.validate({mode:'t3',threadId:thread}),/requires supported threads inspect/);
  assert.deepEqual(calls,[['threads','inspect','--thread',thread]]);
});

// none adapter.
await row('none adapter: no argv, no environment, quiets to the wait queue, never touches T3',async()=>{
  const quieted=[],notified=[];
  const none=createNoneDestination({store:{quietDelivery:(id,reason)=>quieted.push([id,reason]),get(){ throw new Error('none must not read the row'); }},notify:id=>notified.push(id)});
  assert.equal(none.name,'none'); assert.equal(none.argv(items.t3,baseRow({delivery_mode:'none'})),null);
  assert.deepEqual(await none.validate({mode:'none',threadId:null}),{environmentId:null}); none.admit({mode:'none'},{allowMain:false});
  assert.equal(typeof none.quietReason(baseRow({delivery_mode:'none'})),'string','drain quiets any stray none item before an attempt');
  assert.deepEqual(await none.send(items.t3,{started:{attempts:0},argv:null}),{state:'pending',reason:'',sendStarted:false});
  assert.deepEqual(quieted,[['evt_t3','no outbound delivery destination']]); assert.deepEqual(notified,[rid]);
  assert.equal((await none.reconcile(items.t3,baseRow())).state,'ambiguous');
});
await row('index: selects by assignments.delivery',async()=>{
  const d=createDestinations({store:{}});
  for(const [value,name] of [['none','none'],[{mode:'none'},'none'],[undefined,'none']]) { assert.equal(destinationName(value),name); assert.equal((await d.for(value)).name,name); }
  assert.equal((await d.for()).name,'none');
  assert.throws(()=>destinationName(null),/invalid delivery mode/);
  assert.equal(destinationName('t3'),'t3');
  assert.equal((await d.for('t3')).name,'t3');
  assert.equal(destinationName(`t3:${thread}`),'t3');
  assert.equal((await d.for(`t3:${thread}`)).name,'t3');
  assert.equal(destinationName('t3:t'),'t3','legacy stored opaque thread IDs keep selecting the T3 adapter');
  assert.throws(()=>destinationName('smtp:other'),/invalid delivery mode/);
  assert.throws(()=>destinationName({mode:'typo'}),/invalid delivery mode/);
});

await row('transient T3 adapter load failure retries and the next valid row delivers',async()=>{
  let loads=0; const delivered=[];
  const d=createDestinations({store:{},loadT3:async()=>{
    if(++loads===1) throw new Error('temporary adapter import failure');
    return {name:'t3',send:async item=>{delivered.push(item.id);return {state:'delivered'};}};
  }});
  await assert.rejects(d.for('t3:first'),/temporary adapter import failure/);
  const destination=await d.for('t3:next');
  assert.deepEqual(await destination.send({id:'evt_next'}),{state:'delivered'});
  assert.deepEqual(delivered,['evt_next']); assert.equal(loads,2);
  const server=fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../src/server.mjs'),'utf8');
  assert.match(server,/error\?\.code==='INVALID_DELIVERY_MODE'[\s\S]*quarantineDelivery[\s\S]*retryDelivery/,'only invalid stored modes are quarantined; adapter failures are deferred');
});

await row('transient destination failure stays pending until its retry backoff expires',async()=>{
  const store=new Store(':memory:');
  try {
    store.db.prepare('INSERT INTO assignments(request_id,payload,payload_hash,thread_id,environment_id,status,created_at,delivery) VALUES(?,?,?,?,?,?,?,?)').run('req_adapter_retry','{}','hash','thread','environment','queued',new Date().toISOString(),'t3:thread');
    store.db.prepare('INSERT INTO notifications(id,kind,request_id,created_at) VALUES(?,?,?,?)').run('evt_adapter_retry','t3','req_adapter_retry',new Date().toISOString());
    assert.equal(store.retryDelivery('evt_adapter_retry','destination unavailable',30),true);
    const pending=store.db.prepare('SELECT state,next_at,last_error FROM notifications WHERE id=?').get('evt_adapter_retry');
    assert.equal(pending.state,'pending'); assert.equal(pending.last_error,'destination unavailable');
    assert.equal(store.due().some(item=>item.id==='evt_adapter_retry'),false,'backoff must keep the row out of the current drain');
    await new Promise(resolve=>setTimeout(resolve,40));
    assert.equal(store.due().some(item=>item.id==='evt_adapter_retry'),true,'row becomes due after the retry delay');
  } finally { store.db.close(); }
});

await row('persisted delivery mode reaches all four server boundaries unchanged',()=>{
  const server=fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../src/server.mjs'),'utf8');
  assert.ok(server.includes('destinations.for(immediate.delivery_mode)'), 'attached waiter must pass the stored value unchanged');
  assert.equal([...server.matchAll(/destinations\.for\(row\.delivery_mode\)/g)].length,3,'request reconciliation, reconciliation tick and drain must pass the stored value unchanged');
  assert.doesNotMatch(server,/delivery_mode\?\?\s*undefined/,'stored null must reach the registry and be rejected');
  assert.match(server,/const runDrain=createDrainRunner\(drain,log\)/,'drain triggers must share the guarded runner');
  assert.match(server,/setInterval\(runDrain,500\)\.unref\(\); runDrain\(\);/,'scheduled and startup drains must use the guarded runner');
  assert.throws(()=>destinationName(null),/invalid delivery mode/);
});

await row('all drain triggers use a rejection-catching runner',async()=>{
  const server=fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../src/server.mjs'),'utf8');
  const release=server.match(/const release=\(\)=>\{[\s\S]*?\n  \};/)?.[0]??'';
  const abandon=server.match(/if\(url\.pathname==='\/abandon'&&req\.method==='POST'\) \{[\s\S]*?\n    \}/)?.[0]??'';
  assert.match(release,/runDrain\(\)/,'waiter disconnect must use the guarded drain runner');
  assert.match(abandon,/runDrain\(\)/,'abandon must use the guarded drain runner');
  assert.match(server,/setInterval\(runDrain,500\)\.unref\(\); runDrain\(\);/,'scheduled and startup drains must use the guarded runner');
  const {createDrainRunner}=await import('../src/drain-runner.mjs');
  const unhandled=[],logs=[],listener=error=>unhandled.push(error);
  process.on('unhandledRejection',listener);
  try {
    await createDrainRunner(async()=>{throw new Error('injected drain failure');},entry=>logs.push(entry))();
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(unhandled,[]);
    assert.deepEqual(logs,[{kind:'delivery_drain_error',reason:'injected drain failure'}]);
  } finally { process.off('unhandledRejection',listener); }
});

// Import graph: none.mjs must not reach T3 code, statically or dynamically.
const srcRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../src');
const destinationIndex=fs.readFileSync(path.join(srcRoot,'destinations/index.mjs'),'utf8');
assert.match(destinationIndex,/import\(['"]\.\/t3\.mjs['"]\)/,'T3 adapter must load on demand');
assert.doesNotMatch(destinationIndex,/from\s+['"]\.\/t3\.mjs['"]|import\s+['"]\.\/t3\.mjs['"]/,'T3 adapter must not be a static dependency');
function importGraph(entry) {
  const seen=new Set(), stack=[path.resolve(entry)];
  while(stack.length) {
    const file=stack.pop(); if(seen.has(file)) continue; seen.add(file);
    // Comments cannot hide an import: import/*x*/('../t3.mjs') is valid syntax.
    const text=fs.readFileSync(file,'utf8').replace(/\/\*[\s\S]*?\*\//g,' ').replace(/(^|[^:'"`])\/\/.*$/gm,'$1');
    const specs=[...text.matchAll(/\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\s*\(\s*([^)]*)\)/g)].map(m=>{
      if(m[3]===undefined) return m[1]??m[2];
      const literal=/^(['"`])([^'"`$]+)\1$/.exec(m[3].trim());
      assert.ok(literal,`${path.relative(srcRoot,file)}: non-literal dynamic import(${m[3]}) cannot be checked`);
      return literal[2];
    });
    for(const spec of specs) {
      if(spec.startsWith('.')) stack.push(path.resolve(path.dirname(file),spec));
      else assert.ok(spec.startsWith('node:'),`${path.relative(srcRoot,file)}: unexpected non-builtin import ${spec}`);
    }
  }
  return [...seen].map(f=>path.relative(srcRoot,f));
}
await row('import graph: none.mjs never reaches t3.mjs or t3-control.mjs',async()=>{
  const graph=importGraph(path.join(srcRoot,'destinations/none.mjs'));
  assert.deepEqual(graph,['destinations/none.mjs'],'none.mjs graph');
  for(const f of graph) assert.ok(!/(^|\/)t3(-control)?\.mjs$/.test(f),`none graph reaches ${f}`);
  // Positive controls prove the walker follows edges.
  assert.ok(importGraph(path.join(srcRoot,'destinations/t3.mjs')).includes('t3.mjs'));
  assert.ok(importGraph(path.join(srcRoot,'t3-control.mjs')).includes('t3.mjs'));
  const indexGraph=importGraph(path.join(srcRoot,'destinations/index.mjs'));
  assert.ok(indexGraph.includes('destinations/none.mjs')&&indexGraph.includes('t3.mjs')&&indexGraph.includes('delivery.mjs'));
});

console.log(`PASS destination adapters: ${passed.length} transition rows\n${passed.map(n=>`  - ${n}`).join('\n')}`);
