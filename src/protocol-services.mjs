import {createHmac,timingSafeEqual} from 'node:crypto';
import {createProtocolDeliveryDriver} from './protocol-delivery-driver.mjs';
import {createProtocolStopObserver} from './protocol-stop-observer.mjs';
import {readVerifiedHostStop} from './host-budget-receipts.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
export function protocolServiceCapability(operatorKey,role) {
  if(!['dispatcher','observer'].includes(role)||typeof operatorKey!=='string'||!operatorKey)fail('invalid_service_role');
  return createHmac('sha256',operatorKey).update('dot-bridge:protocol-v0:'+role).digest('hex');
}
function same(a,b) {
  return typeof a==='string'&&/^[a-f0-9]{64}$/.test(a)&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
}
function closed(body,keys) {
  if(!body||Object.getPrototypeOf(body)!==Object.prototype||Object.keys(body).length!==keys.length||
    keys.some(key=>!Object.hasOwn(body,key)))fail('invalid_input');
}
// The receiver for owner-inbox is the native durable inbox itself. Only its
// owner's persisted ACK proves acceptance; absence of that ACK proves nothing.
function inboxTransport(store) {
  function proof(envelope,label,kind) {
    const row=store.db.prepare('SELECT acknowledged_at FROM durable_waiter_deliveries WHERE job=? AND delivery_id=?').get(envelope.job,envelope.delivery);
    if(!row)return null;
    return {envelope,outcome:row.acknowledged_at!==null?(kind==='result'?'acknowledged':'found'):'unknown',receipt:label,authoritative:true};
  }
  return {
    begin(envelope) {if(envelope.destination!=='owner-inbox')fail('unsupported_protocol_destination');},
    result:(e,label)=>proof(e,label,'result'),reconcile:(e,label)=>proof(e,label,'reconcile'),
  };
}
export function createProtocolServices(store,{operatorKey,receiptDir,transport,resolveStopEvidence}={}) {
  const dispatchKey=protocolServiceCapability(operatorKey,'dispatcher');
  const observerKey=protocolServiceCapability(operatorKey,'observer');
  const authorize=(role,key)=>({authority})=>same(authority,key)?'service:'+role:null;
  const delivery=createProtocolDeliveryDriver(store,{authorize:authorize('dispatcher',dispatchKey),transport:transport??inboxTransport(store)});
  const resolveHostStop=(binding,label)=>{
    if(!receiptDir||!binding.scope.startsWith('host-check:'))return null;
    const checkRunId=binding.scope.slice('host-check:'.length);
    if(label!==checkRunId)return null;
    const job=store.db.prepare('SELECT request_id,claim_id FROM check_jobs WHERE id=?').get(checkRunId);
    if(!job||job.request_id!==binding.job||job.claim_id!==binding.claim)return null;
    const receipt=readVerifiedHostStop({receiptDir,checkRunId,invocationId:binding.invocation});
    return receipt?{binding,verified:true,stopped:true,remaining_pids:receipt.remaining_pids}:null;
  };
  const observer=createProtocolStopObserver(store,{authorize:authorize('observer',observerKey),resolveEvidence:resolveStopEvidence??resolveHostStop});
  delivery.recover();
  async function invoke(operation,authority,body) {
    const fields={dispatch:['key','delivery'],'delivery-result':['key','delivery','outcome','receipt'],
      reconcile:['key','delivery','outcome','receipt'],enroll:['execution'],
      'observe-stop':['key','revision','stop','evidence']}[operation];
    if(!fields)fail('invalid_input');
    closed(body,['id',...fields]);
    const {id,...input}=body;
    if(operation==='dispatch')return delivery.dispatch(id,authority,input);
    if(operation==='delivery-result')return delivery.deliveryResult(id,authority,input);
    if(operation==='reconcile')return delivery.reconcile(id,authority,input);
    if(operation==='enroll')return observer.enroll(id,authority,input.execution);
    return observer.observeStop(id,authority,input);
  }
  return {invoke,observation:job=>observer.getObservation(job),deliveryState:id=>delivery.deliveryState(id)};
}
