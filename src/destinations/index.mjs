import { createNoneDestination } from './none.mjs';

const t3ThreadIdPattern = /^[A-Za-z0-9._:%-]+$/;
export const maxT3ThreadIdLength = 1024;

// T3 uses UUIDs, `mcp:<uuid>`, and opaque delegated/provider IDs.  Keep this
// deliberately bounded while accepting the characters present in those forms.
export function validT3ThreadId(value) {
  return typeof value === 'string'
    && value.length >= 8
    && value.length <= maxT3ThreadIdLength
    && t3ThreadIdPattern.test(value);
}

const destinations=new Map();
const split=value=>{
  const colon=value.indexOf(':');
  return colon<0?[value,undefined]:[value.slice(0,colon),value.slice(colon+1)];
};

export function registerDestination(name,{parse,load,...builtIn}={}) {
  if(typeof name!=='string'||!/^[a-z][a-z0-9-]*$/.test(name)||typeof parse!=='function'||typeof load!=='function')
    throw new TypeError('invalid destination registration');
  if(destinations.has(name)) throw new Error(`destination already registered: ${name}`);
  destinations.set(name,{parse,load,...builtIn});
}

registerDestination('none',{
  form:'none', bare:true,
  routes:(value,address)=>address===undefined,
  parse:address=>address===undefined?{mode:'none',threadId:null}:null,
  load:createNoneDestination,
});
registerDestination('t3',{
  form:'t3:<thread-id>',
  // Persisted rows predate strict admission parsing and can carry an opaque short ID.
  routes:(value,address)=>typeof value==='string'?(address===undefined||/^.+$/.test(address)):typeof value?.threadId==='string',
  parse:address=>validT3ThreadId(address)?{mode:'t3',threadId:address}:null,
  load:deps=>deps.loadT3?deps.loadT3():import('./t3.mjs').then(({createT3Destination})=>createT3Destination(deps)),
});

export function parseDelivery(value) {
  if(typeof value==='string') {
    const [mode,address]=split(value), adapter=destinations.get(mode);
    if(adapter&&(adapter.bare||address)) {
      try {
        const parsed=adapter.parse(address);
        if(parsed?.mode===mode) return parsed;
      } catch { /* Keep the admission diagnostic independent of the opaque address. */ }
    }
  }
  const forms=[...destinations].map(([name,adapter])=>adapter.form??`${name}:<address>`);
  throw new Error(`invalid delivery; expected ${forms.join(' or ')}`);
}

export const destinationName=delivery=>{
  if(delivery===undefined) return 'none';
  const [mode,address]=typeof delivery==='string'?split(delivery):[delivery?.mode,undefined];
  const adapter=destinations.get(mode);
  if(adapter&&(adapter.routes?adapter.routes(delivery,address):address!=='')) return mode;
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
  const none=destinations.get('none').load(deps), loaded=new Map();
  return {none,for:async delivery=>{
    const name=destinationName(delivery);
    if(name==='none') return none;
    if(!loaded.has(name)) loaded.set(name,Promise.resolve().then(()=>destinations.get(name).load(deps)).catch(error=>{
      loaded.delete(name);
      throw error;
    }));
    return loaded.get(name);
  }};
}
