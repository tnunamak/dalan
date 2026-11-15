import { createNoneDestination } from './none.mjs';

// Stored delivery values are 'none' or 't3:<thread>'; new submissions pass a parsed mode.
export const destinationName=delivery=>{
  if(delivery===undefined) return 'none';
  if(delivery==='none'||delivery?.mode==='none') return 'none';
  if(delivery==='t3') return 't3';
  // Persisted rows predate strict admission parsing and use t3:<opaque id>.
  if(typeof delivery==='string'&&/^t3:.+$/.test(delivery)) return 't3';
  if(delivery?.mode==='t3'&&typeof delivery.threadId==='string') return 't3';
  const error=new Error(`invalid delivery mode: ${String(delivery)}`);
  error.code='INVALID_DELIVERY_MODE';
  throw error;
};
// A destination is an adapter with this interface. Besides send and reconcile it has three methods for the parent it wakes:
//   capture(delivery)          -> string|null  what to record at submit about the parent. One opaque string: the Store keeps
//                                              it in assignments.parent_generation and never parses it.
//   readGeneration(row)        -> object|null  that string, read back by the destination that wrote it (null if none or bad).
//   canAdmitContinuation(row)  -> {ok,reason}  whether the parent may be woken now. Best effort: a read, and the send follows.
// validate(delivery) returns {environmentId,generation}, where generation is what capture would return from the same read.
export function createDestinations(deps) {
  const none=createNoneDestination(deps); let t3Promise;
  const loadT3=deps.loadT3??(()=>import('./t3.mjs').then(({createT3Destination})=>createT3Destination(deps)));
  const getT3=()=>{
    if(!t3Promise) t3Promise=Promise.resolve().then(loadT3).catch(error=>{ t3Promise=null; throw error; });
    return t3Promise;
  };
  return {none,for:async delivery=>destinationName(delivery)==='none'?none:getT3()};
}
