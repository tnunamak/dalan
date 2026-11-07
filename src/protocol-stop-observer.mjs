// Private native stop observations. Store installs the versioned state;
// runtime composition supplies scoped authority and trusted evidence.
const fail = code => { throw Object.assign(new Error(code), {code}); };
const text = x => typeof x === 'string' && x.length > 0 && x.length <= 512;
const nat = x => Number.isSafeInteger(x) && x >= 0;
function canonical(x) {
  if (x === null || typeof x === 'string' || typeof x === 'boolean') return x;
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (Array.isArray(x)) return x.map(canonical);
  if (x && Object.getPrototypeOf(x) === Object.prototype)
    return Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])]));
  fail('invalid_input');
}
const json = x => JSON.stringify(canonical(x));
function closed(x, keys) {
  if (!x || Object.getPrototypeOf(x) !== Object.prototype ||
      Object.keys(x).length !== keys.length || keys.some(k => !Object.hasOwn(x,k))) fail('invalid_input');
}
export function migrateProtocolStopObserver(db) {
  if (!db.isTransaction) fail('transaction_required');
  db.exec(`
    CREATE TABLE IF NOT EXISTS protocol_stop_enrollments (
      job TEXT PRIMARY KEY, binding TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS protocol_stop_observations (
      job TEXT PRIMARY KEY REFERENCES protocol_stop_enrollments(job),
      binding TEXT NOT NULL, observation TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS protocol_stop_receipts (
      job TEXT NOT NULL, observer TEXT NOT NULL, command_key TEXT NOT NULL,
      identity TEXT NOT NULL, reply TEXT NOT NULL, PRIMARY KEY(job,observer,command_key));
  `);
}
export function createProtocolStopObserver(store, {authorize,resolveEvidence} = {}) {
  if (typeof authorize !== 'function' || typeof resolveEvidence !== 'function') fail('callbacks_required');
  const db=store.db;
  function principal(job,action,authority) {
    if (!text(job)) fail('invalid_job');
    const id=authorize({job,action,authority});
    if (!text(id)) fail('unauthorized');
    store.assertProtocolAvailable(job);
    if (!store.isProtocolJob(job)) fail('protocol_required');
    return id;
  }
  const current = job => db.prepare('SELECT * FROM claims WHERE request_id=?').get(job);
  function binding(job,observer) {
    const row=db.prepare('SELECT binding FROM protocol_stop_enrollments WHERE job=?').get(job);
    if (!row) fail('execution_not_enrolled');
    const b=JSON.parse(row.binding), c=current(job);
    if (!c || c.claim_id!==b.claim || c.epoch!==b.epoch || b.observer!==observer) fail('stale_observer');
    return b;
  }
  function cached(job,input,identity) {
    const {observer}=JSON.parse(identity);
    const row=db.prepare('SELECT identity,reply FROM protocol_stop_receipts WHERE job=? AND observer=? AND command_key=?').get(job,observer,input.key);
    if (!row) return null;
    if (row.identity!==identity) fail('command_conflict');
    return JSON.parse(row.reply);
  }
  function enroll(job,authority,execution) {
    closed(execution,['claim','epoch','invocation','scope']);
    if (!text(execution.claim)||!nat(execution.epoch)||execution.epoch<1||
        !text(execution.invocation)||!text(execution.scope)) fail('invalid_execution');
    return store.transaction(()=>{
      const observer=principal(job,'enroll',authority),c=current(job);
      const status=db.prepare('SELECT status FROM assignments WHERE request_id=?').get(job)?.status;
      if (!c || c.claim_id!==execution.claim || c.epoch!==execution.epoch ||
          c.state!=='active' || status!=='claimed' || store.leaseExpired(c)) fail('stale_authority');
      const b={job,...execution,observer}, encoded=json(b);
      const old=db.prepare('SELECT binding FROM protocol_stop_enrollments WHERE job=?').get(job);
      if (old) {
        const prior=JSON.parse(old.binding);
        if (prior.epoch===b.epoch) {
          if (old.binding!==encoded) fail('enrollment_conflict');
          return b;
        }
        if (prior.epoch>b.epoch) fail('stale_authority');
        db.prepare('DELETE FROM protocol_stop_observations WHERE job=?').run(job);
      }
      db.prepare('INSERT INTO protocol_stop_enrollments VALUES(?,?) ON CONFLICT(job) DO UPDATE SET binding=excluded.binding').run(job,encoded);
      return b;
    });
  }
  async function observeStop(job,authority,input) {
    closed(input,['key','revision','stop','evidence']);
    if (!text(input.key)||!nat(input.revision)||!['confirmed','unverified'].includes(input.stop)||!text(input.evidence)) fail('invalid_input');
    const prepare=()=> {
      const observer=principal(job,'observe_stop',authority);
      const identity=json({job,observer,operation:'observe_stop',input});
      const replay=cached(job,input,identity);
      return {observer,b:replay?null:binding(job,observer),identity,replay};
    };
    const first=store.transaction(prepare);
    if (first.replay) return first.replay;
    // The label is only a lookup key for a trusted dependency, never proof.
    const resolved=await resolveEvidence({...first.b},input.evidence);
    const evidence=resolved===undefined?null:canonical(resolved);
    return store.transaction(()=>{
      const next=prepare();
      if (next.replay) return next.replay;
      if (next.identity!==first.identity||json(next.b)!==json(first.b)) fail('stale_observer');
      if (store.protocolRevision(job)!==input.revision) fail('revision_conflict');
      const status=db.prepare('SELECT status FROM assignments WHERE request_id=?').get(job)?.status;
      if (!['cancelled','finished'].includes(status)) fail('terminal_required');
      if (!evidence || evidence.verified!==true || json(evidence.binding)!==json(next.b) ||
          typeof evidence.stopped!=='boolean' || !Array.isArray(evidence.remaining_pids) ||
          evidence.remaining_pids.some(p=>!Number.isSafeInteger(p)||p<=0) ||
          (input.stop==='confirmed' && (!evidence.stopped || evidence.remaining_pids.length!==0)) ||
          (input.stop==='unverified' && evidence.stopped)) fail('stop_evidence_invalid');
      const old=db.prepare('SELECT observation FROM protocol_stop_observations WHERE job=?').get(job);
      if (old && JSON.parse(old.observation).stop==='confirmed' && input.stop!=='confirmed') fail('stop_regression');
      const revision=store.advanceProtocolRevisionInTransaction(job);
      const observation={stop:input.stop,assurance:'product-owned-observation',scope:next.b.scope,
        observer:next.observer,claim:next.b.claim,epoch:next.b.epoch,invocation:next.b.invocation,
        evidence:input.evidence,verified:evidence.verified,remaining_pids:evidence.remaining_pids,revision};
      db.prepare('INSERT INTO protocol_stop_observations VALUES(?,?,?) ON CONFLICT(job) DO UPDATE SET binding=excluded.binding,observation=excluded.observation')
        .run(job,json(next.b),json(observation));
      store.protocolEventInTransaction(job,'stop_observed',observation,next.b.epoch);
      const reply={revision,stop:input.stop};
      db.prepare('INSERT INTO protocol_stop_receipts VALUES(?,?,?,?,?)').run(job,next.observer,input.key,next.identity,json(reply));
      return reply;
    });
  }
  function getObservation(job) {
    store.assertProtocolAvailable(job);
    if (!store.isProtocolJob(job)) fail('protocol_required');
    const row=db.prepare('SELECT binding,observation FROM protocol_stop_observations WHERE job=?').get(job);
    if (!row) return null;
    const b=JSON.parse(row.binding),c=current(job);
    return c&&c.claim_id===b.claim&&c.epoch===b.epoch?JSON.parse(row.observation):null;
  }
  return {enroll,observeStop,getObservation};
}
