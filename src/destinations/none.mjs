// delivery=none has no outbound channel: owner attention stays in the wait queue
// (store.deliveryKind already files it as 'wait', so drain never sees it). Must never import T3 code.
const reason='no outbound delivery destination';

export function createNoneDestination({store,notify=()=>{}}={}) {
  return {
    name:'none',
    quietReason:()=>reason,
    admit() {},
    async validate() { return {environmentId:null}; },
    argv:()=>null,
    async send(item) { store.quietDelivery(item.id,reason); notify(item.request_id); return {state:'pending',reason:'',sendStarted:false}; },
    async reconcile() { return {state:'ambiguous',reason}; },
  };
}
