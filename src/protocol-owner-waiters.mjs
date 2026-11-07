import {createDurableWaiters,migrateDurableWaiters} from './durable-waiters.mjs';
import {executeProtocolOwnerCommand} from './protocol-owner-command.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const text=value=>typeof value==='string'&&value.length>0&&value.length<=512;
const natural=value=>Number.isSafeInteger(value)&&value>=0;
// Called only by the Store's versioned migration, never by an HTTP request.
export function migrateProtocolOwnerWaiters(db) {
  migrateDurableWaiters(db);
}

/** Private owner operations. Worker tools and notification ACKs do not use this ledger. */
export function createProtocolOwnerWaiters(store) {
  const {db}=store;
  const driverInstalled=!!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='protocol_delivery_attempts'").get();
  function authorize(job,token) {
    store.owner(job,token);
    if(!store.isProtocolJob(job)) fail('protocol_job_required');
    store.assertProtocolAvailable(job);
    // The raw owner capability is transient. Persist only the existing hash.
    return db.prepare('SELECT owner_hash FROM assignments WHERE request_id=?').get(job).owner_hash;
  }
  const waiters=createDurableWaiters({
    db,clock:()=>store.nowMs(),
    authorize:({job,owner})=>store.isProtocolJob(job)&&db.prepare('SELECT owner_hash FROM assignments WHERE request_id=?').get(job)?.owner_hash===owner,
    readEvents:({job,afterSeq})=>store.protocolFacts(job).filter(event=>event.seq>afterSeq).map(event=>({
      ...event,id:`${job}:${event.seq}`,job,type:event.type??event.event_type,
    })),
    predicates:{terminal:event=>['finished','cancelled'].includes(event.type),input:event=>event.type==='questioned',any:()=>true},
  });
  function register(job,token,input) { return store.transaction(()=>{
    const owner=authorize(job,token);
    const {key,revision,waiter,predicate,afterSeq,expiresAt}=input??{};
    if(!text(key)||!natural(revision)||!text(waiter)||!natural(afterSeq)||!natural(expiresAt)||!['terminal','input','any'].includes(predicate)) fail('invalid_registration');
    const receipt=executeProtocolOwnerCommand(store,job,token,{key,revision,operation:'wait',args:{waiter,predicate,afterSeq,expiresAt}},()=>{
      waiters.register({job,owner,waiter,key,predicate,afterSeq,expiresAt});
      store.protocolEventInTransaction(job,'waiter_registered',{waiter,predicate});
      waiters.materialize({job,owner,waiter});
      return {waiter,delivery:waiters.inbox({job,owner,waiter})[0]?.delivery??null};
    });
    return {...receipt.value,revision:receipt.revision};
  }); }
  function inbox(job,token,waiter) { return store.transaction(()=>{
    const owner=authorize(job,token);
    if(!text(waiter)) fail('invalid_waiter');
    waiters.materialize({job,owner,waiter});
    const epoch=db.prepare('SELECT epoch FROM claims WHERE request_id=?').get(job)?.epoch;
    return {deliveries:waiters.inbox({job,owner,waiter}).filter(row=>row.fact.type!=='questioned'||row.fact.epoch===epoch).map(row=>({
      delivery:row.delivery,waiter,job,event:row.eventId,
      state:driverInstalled?db.prepare('SELECT state FROM protocol_delivery_attempts WHERE delivery_id=?').get(row.delivery)?.state??'pending':'pending',receipt:null,
    }))};
  }); }
  function ack(job,token,waiter,delivery) { return store.transaction(()=>{
    const owner=authorize(job,token);
    const result=waiters.ack({job,owner,waiter,delivery});
    return {delivery:result.delivery,state:'acknowledged'};
  }); }
  function materializeAll(job) {
    if(!db.isTransaction)fail('transaction_required');
    for(const row of db.prepare('SELECT owner,waiter FROM durable_waiters WHERE job=?').all(job))
      waiters.materialize({job,owner:row.owner,waiter:row.waiter});
  }
  return {register,inbox,ack,materializeAll};
}
// Called by the native event transaction, so a committed result always carries
// its durable wake obligation even when nobody has polled the owner's inbox.
export const materializeProtocolWaiters=(store,job)=>createProtocolOwnerWaiters(store).materializeAll(job);
