// Inert dependency boundary, not a reference implementation of native commands.
// Only this controller changes its receiver/executor ledger; native HTTP and
// SQLite transitions still run in the product's private service components.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const fail=message=>{throw new Error(message);};
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const encode=x=>JSON.stringify(canonical(x));
export function createInertProtocolFixtures(home) {
  const file=path.join(home,'inert-receiver.json');
  const read=()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{transit:{},accepted:{},proofs:{},executions:{},stops:{},begins:0,accepts:0};
  function write(value) {
    const temp=file+'.'+randomUUID()+'.tmp',fd=fs.openSync(temp,'wx',0o600);
    try {fs.writeFileSync(fd,encode(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temp,file);
    const dir=fs.openSync(home,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
  }
  function begin(envelope) {
    const state=read(),prior=state.transit[envelope.attempt];
    if(prior&&encode(prior.envelope)!==encode(envelope))fail('inert transit conflict');
    if(!prior){state.transit[envelope.attempt]={envelope,status:'in_flight'};state.begins++;write(state);}
  }
  function injectDelivery(delivery,label,outcome) {
    const state=read(),transit=Object.values(state.transit).filter(x=>x.envelope.delivery===delivery).at(-1);
    if(!transit)fail('no original inert transit');
    const envelope=transit.envelope;
    if(['acknowledged','found'].includes(outcome)) {
      // Complete the original issued transit. This is not another dispatch.
      if(transit.status==='not_sent')fail('cancelled original transit');
      const prior=state.accepted[delivery];
      if(prior&&(prior.envelope.bodyDigest!==envelope.bodyDigest||prior.envelope.destination!==envelope.destination))fail('receiver binding conflict');
      if(!prior){state.accepted[delivery]={envelope};state.accepts++;}
      transit.status='accepted';
    } else if(['not_sent','not_found'].includes(outcome)) {
      if(state.accepted[delivery])fail('receiver already accepted');
      // The controlled transport cancels its original transit before proving
      // absence. An incomplete receiver search alone would not suffice.
      transit.status='not_sent';
    } else if(outcome!=='unknown')fail('invalid injected transport outcome');
    state.proofs[label]={envelope,outcome,receipt:label,authoritative:true};write(state);
  }
  function enroll(binding) {
    const state=read(),prior=state.executions[binding.invocation];
    if(prior&&encode(prior.binding)!==encode(binding))fail('inert execution binding conflict');
    if(!prior){state.executions[binding.invocation]={binding,stopped:false};write(state);}
  }
  function completeIssuedTransits() {
    for(const {envelope,status} of Object.values(read().transit))
      if(status==='in_flight')injectDelivery(envelope.delivery,'receiver-before-crash:'+envelope.attempt,'acknowledged');
  }
  function stop(binding,label) {
    const state=read(),execution=state.executions[binding.invocation];
    if(!execution||encode(execution.binding)!==encode(binding))fail('inert execution not enrolled');
    execution.stopped=true;
    state.stops[label]={binding,verified:true,stopped:true,remaining_pids:[]};write(state);
  }
  return {transport:{begin,result:async(e,label)=>read().proofs[label]??null,reconcile:async(e,label)=>read().proofs[label]??null},
    resolveStopEvidence:async(b,label)=>read().stops[label]??null,
    injectDelivery,completeIssuedTransits,enroll,stop,inspect:read};
}
