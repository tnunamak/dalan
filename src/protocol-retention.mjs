import {createJobRetention} from './job-retention.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const transaction=store=>{if(!store.db.isTransaction)fail('transaction_required');};
// Internal helpers: callers authenticate their native owner/worker boundary first.
function binding(store,id,requirePolicy=true) {
  if(!store.isProtocolJob(id))return null;
  const row=store.db.prepare('SELECT owner_hash,target_worker,status FROM assignments WHERE request_id=?').get(id);
  const deadline=store.getProtocol(id)?.retain_until_ms;
  if(!row?.owner_hash||!row.target_worker||!Number.isSafeInteger(deadline)||deadline<0)
    fail('invalid_retention_binding');
  const policy=store.db.prepare('SELECT * FROM job_retention_policy WHERE job=?').get(id);
  if(requirePolicy&&!policy)fail('retention_not_found');
  if(policy&&(policy.owner!==row.owner_hash||policy.worker!==row.target_worker||policy.retain_until!==deadline))
    fail('retention_conflict');
  return {job:id,owner:row.owner_hash,worker:row.target_worker,retainUntil:deadline};
}
function component(store,b) {
  return createJobRetention({db:store.db,clock:()=>store.nowMs(),
    authorize:c=>c.job===b.job&&c.owner===b.owner&&c.worker===b.worker,
    readState:job=>{
      const row=store.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(job);
      return row?{status:row.status,compute_stopped:false}:null;
    },
    fence:()=>{
      const row=store.db.prepare('SELECT * FROM job_retention_tombstones WHERE job=?').get(b.job);
      return !!row&&row.owner===b.owner&&row.worker===b.worker&&
        row.retain_until===b.retainUntil&&row.purge_pending===1;
    },
    purge:()=>fail('physical_purge_forbidden')});
}
export function defineProtocolRetentionInTransaction(store,id) {
  transaction(store);
  const b=binding(store,id,false);
  return b?component(store,b).define(b):null;
}
export function expireProtocolRetentionInTransaction(store,id) {
  transaction(store);
  const b=binding(store,id);
  return b?component(store,b).expire(b):{deleted:false};
}
export function assertProtocolAvailable(store,id) {
  const b=binding(store,id);
  if(!b)return true;
  if(store.nowMs()>=b.retainUntil) {
    // With an outer transaction, its later throw rolls the tombstone back.
    // The immutable policy nevertheless fences access on every invocation.
    if(store.db.isTransaction)expireProtocolRetentionInTransaction(store,id);
    else store.transaction(()=>expireProtocolRetentionInTransaction(store,id));
  }
  // Outside a caller transaction expiry is committed before this throws.
  return component(store,b).assertAvailable(b);
}
