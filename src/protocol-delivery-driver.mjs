import {createHash,randomUUID} from 'node:crypto';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const text=x=>typeof x==='string'&&x.length>0&&x.length<=512;
function canonical(x) {
  if(x===null||typeof x==='string'||typeof x==='boolean')return x;
  if(typeof x==='number'&&Number.isFinite(x))return x;
  if(Array.isArray(x))return x.map(canonical);
  if(x&&Object.getPrototypeOf(x)===Object.prototype)return Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])]));
  fail('invalid_input');
}
const json=x=>JSON.stringify(canonical(x));
const digest=x=>createHash('sha256').update(json(x)).digest('hex');
function closed(x,keys) {
  if(!x||Object.getPrototypeOf(x)!==Object.prototype||Object.keys(x).length!==keys.length||
    keys.some(k=>!Object.hasOwn(x,k)||!text(x[k])))fail('invalid_input');
}
export function migrateProtocolDelivery(db) {
  if(!db.isTransaction)fail('transaction_required');
  db.exec(`
    CREATE TABLE IF NOT EXISTS protocol_delivery_attempts (
      delivery_id TEXT PRIMARY KEY REFERENCES durable_waiter_deliveries(delivery_id),
      binding TEXT NOT NULL, state TEXT NOT NULL, attempt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS protocol_delivery_receipts (
      job TEXT NOT NULL, principal TEXT NOT NULL, operation TEXT NOT NULL,
      command_key TEXT NOT NULL, identity TEXT NOT NULL,
      reply TEXT NOT NULL, PRIMARY KEY(job,principal,operation,command_key));
  `);
}
// Private runtime interface: transport evidence is independently resolved by
// the injected trusted transport, never accepted from input.outcome alone.
export function createProtocolDeliveryDriver(store,{authorize,transport}={}) {
  if(typeof authorize!=='function'||!transport||
    ['begin','result','reconcile'].some(k=>typeof transport[k]!=='function'))fail('callbacks_required');
  const db=store.db;
  function auth(job,action,authority) {
    if(!text(job))fail('invalid_job');
    const principal=authorize({job,action,authority});
    if(!text(principal))fail('unauthorized');
    store.assertProtocolAvailable(job);
    if(!store.isProtocolJob(job))fail('protocol_required');
    return principal;
  }
  function native(job,delivery) {
    const row=db.prepare('SELECT * FROM durable_waiter_deliveries WHERE delivery_id=? AND job=?').get(delivery,job);
    if(!row)fail('delivery_not_found');
    const p=store.getProtocol(job);
    if(!p||!text(p.destination))fail('invalid_destination');
    const b={job,delivery,owner:row.owner,waiter:row.waiter,eventId:row.event_id,eventSeq:row.event_seq,
      destination:p.destination,bodyDigest:digest(JSON.parse(row.fact))};
    const side=db.prepare('SELECT * FROM protocol_delivery_attempts WHERE delivery_id=?').get(delivery);
    if(side&&side.binding!==json(b))fail('delivery_binding_mismatch');
    return {row,b,side,state:row.acknowledged_at!==null?'acknowledged':side?.state??'pending'};
  }
  function receipt(job,key,identity) {
    const {principal,action}=JSON.parse(identity);
    const r=db.prepare('SELECT identity,reply FROM protocol_delivery_receipts WHERE job=? AND principal=? AND operation=? AND command_key=?').get(job,principal,action,key);
    if(!r)return null;
    if(r.identity!==identity)fail('command_conflict');
    return JSON.parse(r.reply);
  }
  function save(job,key,identity,reply) {
    const {principal,action}=JSON.parse(identity);
    db.prepare('INSERT INTO protocol_delivery_receipts VALUES(?,?,?,?,?,?)').run(job,principal,action,key,identity,json(reply));
    return reply;
  }
  function prepare(job,authority,input,action) {
    const principal=auth(job,action,authority),n=native(job,input.delivery);
    const identity=json({job,principal,action,input,binding:n.b});
    return {...n,principal,identity,replay:receipt(job,input.key,identity)};
  }
  function currentQuestion(envelope) {
    const row=db.prepare('SELECT fact FROM durable_waiter_deliveries WHERE delivery_id=?').get(envelope.delivery);
    const fact=JSON.parse(row.fact);
    if(fact.type!=='questioned')return;
    const claim=db.prepare('SELECT * FROM claims WHERE request_id=?').get(envelope.job);
    const status=db.prepare('SELECT status FROM assignments WHERE request_id=?').get(envelope.job)?.status;
    if(!claim||claim.epoch!==fact.epoch||claim.state!=='active'||status!=='claimed'||store.leaseExpired(claim))fail('stale_delivery_epoch');
  }
  async function dispatch(job,authority,input) {
    closed(input,['key','delivery']);
    const start=store.transaction(()=>{
      const p=prepare(job,authority,input,'dispatch');
      if(p.replay)return {reply:p.replay};
      currentQuestion(p.b);
      if(p.state==='unknown')fail('DELIVERY_UNKNOWN');
      if(p.state!=='pending')fail('DELIVERY_STATE');
      const attempt=randomUUID(),envelope={...p.b,attempt};
      db.prepare('INSERT INTO protocol_delivery_attempts VALUES(?,?,?,?) ON CONFLICT(delivery_id) DO UPDATE SET binding=excluded.binding,state=excluded.state,attempt=excluded.attempt')
        .run(input.delivery,json(p.b),'sending',attempt);
      const reply=save(job,input.key,p.identity,{delivery:input.delivery,state:'sending'});
      return {reply,envelope};
    });
    if(!start.envelope)return start.reply;
    try {
      // Recheck immediately before the external boundary. A concurrent owner
      // ACK is never overwritten, and this call holds no SQLite transaction.
      const ready=store.transaction(()=>{
        auth(job,'dispatch',authority);
        const p=native(job,input.delivery);
        currentQuestion(p.b);
        return p.state==='sending'&&p.side.attempt===start.envelope.attempt;
      });
      if(ready)await transport.begin(Object.freeze({...start.envelope}));
    } catch {
      // Once sending commits, exceptions cannot establish definitely-not-sent.
      store.transaction(()=>{
        const p=native(job,input.delivery);
        if(p.state==='sending'&&p.side.attempt===start.envelope.attempt)
          db.prepare("UPDATE protocol_delivery_attempts SET state='unknown' WHERE delivery_id=? AND attempt=? AND state='sending'").run(input.delivery,start.envelope.attempt);
      });
    }
    return start.reply;
  }
  async function applyEvidence(job,authority,input,action) {
    closed(input,['key','delivery','outcome','receipt']);
    const allowed=action==='delivery_result'?['acknowledged','not_sent','unknown']:['found','not_found','unknown'];
    if(!allowed.includes(input.outcome))fail('invalid_input');
    const first=store.transaction(()=>{
      const p=prepare(job,authority,input,action);
      if(p.replay)return p;
      if(!p.side)fail('DELIVERY_STATE');
      if(p.state==='acknowledged')return p;
      if(action==='delivery_result'&&!['sending','unknown'].includes(p.state))fail('DELIVERY_STATE');
      if(action==='reconcile'&&p.state!=='unknown')fail('DELIVERY_STATE');
      return p;
    });
    if(first.replay)return first.replay;
    const envelope={...first.b,attempt:first.side.attempt};
    let resolved=null;
    if(first.state!=='acknowledged') {
      const resolve=action==='delivery_result'?transport.result:transport.reconcile;
      const value=await resolve.call(transport,Object.freeze({...envelope}),input.receipt);
      resolved=value===undefined?null:canonical(value);
    }
    return store.transaction(()=>{
      const p=prepare(job,authority,input,action);
      if(p.replay)return p.replay;
      if(!p.side||p.side.attempt!==envelope.attempt||json(p.b)!==json(first.b))fail('stale_delivery_attempt');
      // A real owner ACK dominates an in-flight lookup, including not_sent.
      if(p.state==='acknowledged')return save(job,input.key,p.identity,{delivery:input.delivery,state:'acknowledged'});
      if(action==='delivery_result'&&!['sending','unknown'].includes(p.state))fail('DELIVERY_STATE');
      if(action==='reconcile'&&p.state!=='unknown')fail('DELIVERY_STATE');
      if(!resolved||json(resolved.envelope)!==json(envelope)||resolved.outcome!==input.outcome||
        resolved.receipt!==input.receipt||resolved.authoritative!==true)fail('delivery_evidence_invalid');
      const state=['acknowledged','found'].includes(input.outcome)?'acknowledged':
        ['not_sent','not_found'].includes(input.outcome)?'pending':'unknown';
      if(state==='acknowledged') {
        const at=store.nowMs();if(!Number.isSafeInteger(at)||at<0)fail('invalid_clock');
        db.prepare('UPDATE durable_waiter_deliveries SET acknowledged_at=? WHERE delivery_id=? AND acknowledged_at IS NULL').run(at,input.delivery);
      }
      db.prepare('UPDATE protocol_delivery_attempts SET state=? WHERE delivery_id=? AND attempt=?').run(state,input.delivery,envelope.attempt);
      return save(job,input.key,p.identity,{delivery:input.delivery,state});
    });
  }
  function recover() {
    // Private startup operation, no transport effect. Owner ACK remains dominant.
    return store.transaction(()=>db.prepare("UPDATE protocol_delivery_attempts SET state='unknown' WHERE state='sending' AND delivery_id IN (SELECT delivery_id FROM durable_waiter_deliveries WHERE acknowledged_at IS NULL)").run().changes);
  }
  function deliveryState(deliveryId) {
    const row=db.prepare('SELECT job FROM durable_waiter_deliveries WHERE delivery_id=?').get(deliveryId);
    if(!row)return null;
    store.assertProtocolAvailable(row.job);
    return {delivery:deliveryId,state:native(row.job,deliveryId).state};
  }
  return {dispatch,deliveryResult:(...args)=>applyEvidence(...args,'delivery_result'),
    reconcile:(...args)=>applyEvidence(...args,'reconcile'),recover,deliveryState};
}
