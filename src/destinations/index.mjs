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
export function createDestinations(deps) {
  const none=createNoneDestination(deps); let t3Promise;
  const loadT3=deps.loadT3??(()=>import('./t3.mjs').then(({createT3Destination})=>createT3Destination(deps)));
  const getT3=()=>{
    if(!t3Promise) t3Promise=Promise.resolve().then(loadT3).catch(error=>{ t3Promise=null; throw error; });
    return t3Promise;
  };
  return {none,for:async delivery=>destinationName(delivery)==='none'?none:getT3()};
}
