import { readEnv } from '../env.mjs';
import * as t3 from '../t3.mjs';
import { loadMainThreadIds } from '../limits.mjs';

export function quietReason(row, mainThreadIds=loadMainThreadIds) {
  if(row.t3_muted) return 'assignment delivery muted';
  try { if(row.thread_id&&mainThreadIds().includes(row.thread_id)) return 'protected T3 destination'; }
  catch(error) { return `delivery policy unavailable: ${error.message}`; }
  return null;
}
export function messageFor(item,row) {
  const questionId=item.kind==='blocker'?JSON.parse(item.body).question_id:null;
  const reply=questionId?`dalan answer ${item.request_id} ${questionId} "your answer"`:`dalan note ${item.request_id} "your answer"`;
  return item.kind==='watch'?`${t3.marker(item.id)} Attention: request ${item.request_id} remains ${row.status}. Inspect with dalan get ${item.request_id} --json.`:
    item.kind==='break'?`${t3.marker(item.id)} ${JSON.parse(item.body).note}`:
    item.kind==='blocker'?`${t3.marker(item.id)} Worker question for request ${item.request_id}: ${JSON.parse(item.body).note}\nReply with ${reply} so the assigned worker receives it.`:
    `${t3.marker(item.id)} Request ${item.request_id}: ${row.report.outcome} — ${row.report.summary.slice(0,500)}\nFetch full report: dalan get ${item.request_id} --json`;
}
const resolved=(row,item)=>row.status==='cancelled'||row.status==='finished'&&['blocker','watch'].includes(item.kind)||item.kind==='watch'&&row.watch?.notification_id!==item.id;
const resolvedBeforeSend=(row,item)=>resolved(row,item)||item.kind==='watch'&&row.watch?.state!=='fired';
const lifecycleOutcome=target=>({state:target.state==='uncertain_lifecycle'?'uncertain':'suppressed',reason:`thread ${target.state}`});

// Every dependency is injectable so the transition table can be driven without T3 or process state.
export function createT3Destination({store,callT3=t3.callT3,inspectThread=t3.inspectThread,reconcileMarker=t3.reconcileMarker,ackLedger=null,mainThreadIds=loadMainThreadIds,quiet=row=>quietReason(row,mainThreadIds),notify=()=>{},log=()=>{},crashAt=()=>false,exit=code=>process.exit(code),env=process.env,authRetryMax=t3.authRetryMax}={}) {
  const quietItem=(item,reason)=>{ store.quietDelivery(item.id,reason); notify(item.request_id); };
  // A usage-break notice is moot once the break ended or none of its requests is still queued.
  const moot=item=>item.kind==='break'&&store.breakNoticeMoot(item);
  return {
    name:'t3',
    quietReason:quiet,
    admit(delivery,{allowMain=false}={}) { if(mainThreadIds().includes(delivery.threadId)&&allowMain!==true) throw new Error('protected T3 destination'); },
    async validate(delivery) {
      const inspected=await t3.inspectMetadata(delivery.threadId,callT3);
      if(!inspected?.thread||inspected.thread.id!==delivery.threadId||inspected.thread.deletedAt||!inspected.runtime?.environmentId) throw new Error('thread unavailable');
      return {environmentId:inspected.runtime.environmentId};
    },
    argv:(item,row)=>t3.sendArgs(row.thread_id,item.kind),
    // A quieted item reports 'pending', but finishAttempt is then a no-op: quietDelivery already moved it out of 'sending'.
    async send(item,{started,argv}) {
      let state='failed',reason='',sendStarted=false;
      try {
        const row=store.get(item.request_id);
        if(resolved(row,item)||moot(item)) {state='suppressed';reason='request resolved';}
        else {
          const message=messageFor(item,row);
          if(readEnv('DALAN_T3_DRY_RUN',env)==='1') { state='delivered'; log({kind:'t3_dry_run',event_id:item.id,argv,message}); }
          else {
            const target=await inspectThread(row.thread_id,row.environment_id);
            const current=store.get(item.request_id);
            const currentQuietReason=quiet(current);
            if(currentQuietReason) { quietItem(item,currentQuietReason); state='pending'; }
            else if(store.paused()) { state='pending'; reason='bridge paused before send'; }
            else if(resolvedBeforeSend(current,item)||moot(item)) { state='suppressed'; reason='request resolved before send'; }
            else if(target.state!=='active') ({state,reason}=lifecycleOutcome(target));
            else {
              const latest=await inspectThread(row.thread_id,row.environment_id);
              const final=store.get(item.request_id);
              const finalQuietReason=quiet(final);
              if(finalQuietReason) { quietItem(item,finalQuietReason); state='pending'; }
              else if(store.paused()) { state='pending'; reason='bridge paused before send'; }
              else if(resolvedBeforeSend(final,item)||moot(item)) { state='suppressed'; reason='request resolved before send'; }
              else if(final.thread_id!==row.thread_id||final.environment_id!==row.environment_id||final.target_worker!==row.target_worker||final.delivery_mode!==row.delivery_mode) { state='pending'; reason='T3 destination binding changed before send'; }
              else if(store.deliveryAttemptIsCurrent&&!store.deliveryAttemptIsCurrent(item.id,started.attempt_id)) { state='pending'; reason='delivery attempt changed before send'; }
              else if(latest.state!=='active') ({state,reason}=lifecycleOutcome(latest));
              else {
                const finalMessage=messageFor(item,final);
                if(finalMessage!==message) { state='pending'; reason='T3 delivery body changed before send'; }
                else {
                sendStarted=true;
                try {
                  const ack=ackLedger?.key(item.id,finalMessage,`t3\0${final.target_worker}\0${final.thread_id}\0${final.environment_id}`);
                  if(ack&&ackLedger.has(ack)) { state='delivered'; reason='recovered from durable T3 acceptance acknowledgment'; }
                  else {
                    const resultDelivery=item.kind==='t3'?{threadId:final.thread_id,environmentId:final.environment_id,jobId:final.request_id,effectId:item.id}:undefined;
                    await callT3(t3.sendArgs(final.thread_id),finalMessage,resultDelivery?{resultDelivery}:undefined);
                    if(ack) ackLedger.record(ack); state='delivered';
                  }
                }
                catch(error) {
                  if(t3.preAcceptAuthRejection(error)) {
                    const attempt=started.attempts+1;
                    if(attempt<authRetryMax()) { state='pending'; reason=`pre-accept auth rejection (attempt ${attempt}/${authRetryMax()}), will retry: ${error.message}`; }
                    else { state='uncertain'; reason=`pre-accept auth rejection persisted for ${attempt} attempts: ${error.message}`; }
                  } else { state='uncertain'; reason=error.message; }
                }
                }
              }
            }
          }
          if(crashAt('after_t3_send',item.request_id)&&state==='delivered') exit(72);
        }
      } catch(e) { reason=e.message; state=sendStarted?'uncertain':'pending'; log({kind:'delivery_error',event_id:item.id,reason}); }
      return {state,reason,sendStarted};
    },
    async reconcile(item,row) {
      try { return await reconcileMarker(row.thread_id,row.environment_id,item.id); }
      catch(error) { return {state:'ambiguous',reason:error.message}; }
    },
    async reconcilePositiveAck(item,row) {
      const current=store.get(item.request_id);
      // Local proof lookup has no outbound effect, even while sending is paused or muted.
      if(current.thread_id!==row.thread_id||current.environment_id!==row.environment_id||current.target_worker!==row.target_worker) return {state:'ambiguous',reason:'delivery binding changed'};
      if(!row.thread_id||!row.environment_id) return {state:'ambiguous',reason:'stored thread/environment binding unavailable'};
      if(!ackLedger) return {state:'ambiguous',reason:'durable acceptance ledger unavailable'};
      const key=ackLedger.key(item.id,messageFor(item,current),`t3\0${row.target_worker}\0${row.thread_id}\0${row.environment_id}`);
      return ackLedger.has(key)?{state:'confirmed'}:{state:'ambiguous',reason:'no durable acceptance acknowledgment; bounded transcript lookup unsupported'};
    },
  };
}
