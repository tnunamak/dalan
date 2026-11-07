// Logical deletion/fencing, not secure byte erasure. Parent owns audit/payload tables.
const fail=c=>{throw Object.assign(new Error(c),{code:c});};
const str=v=>typeof v==='string'&&v.length>0&&v.length<=512;
const nat=v=>Number.isSafeInteger(v)&&v>=0;
export function migrateJobRetention(db){
 if(!db.isTransaction)fail('transaction_required');
 db.exec(`CREATE TABLE IF NOT EXISTS job_retention_policy(
 job TEXT PRIMARY KEY,owner TEXT NOT NULL,worker TEXT NOT NULL,retain_until INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS job_retention_tombstones(
 job TEXT PRIMARY KEY,owner TEXT NOT NULL,worker TEXT NOT NULL,retain_until INTEGER NOT NULL,
 deleted_at INTEGER NOT NULL,native_status TEXT NOT NULL,purge_pending INTEGER NOT NULL);`);
}
export function createJobRetention({db,authorize,clock=Date.now,readState,fence,purge}){
 if([authorize,clock,readState,fence,purge].some(f=>typeof f!=='function'))fail('callbacks_required');
 const tx=()=>{if(!db.isTransaction)fail('transaction_required');};
 const now=()=>{const n=clock();if(!nat(n))fail('invalid_clock');return n;};
 const policy=job=>db.prepare('SELECT * FROM job_retention_policy WHERE job=?').get(job);
 function guard(job,owner,worker,operation){
  if(![job,owner,worker].every(str)||authorize({job,owner,worker,operation})!==true)fail('unauthorized');
  const p=policy(job);
  if(p&&(p.owner!==owner||p.worker!==worker))fail('unauthorized');
  return p;
 }
 // Call on lookup AND before submission idempotency/reuse handling.
 function assertAvailable({job,owner,worker}){
  const p=guard(job,owner,worker,'access');
  if(db.prepare('SELECT 1 FROM job_retention_tombstones WHERE job=?').get(job)||(p&&now()>=p.retain_until))fail('TOMBSTONE');
  return true;
 }
 function define({job,owner,worker,retainUntil}){
  tx();assertAvailable({job,owner,worker});
  if(!nat(retainUntil)||retainUntil<=now())fail('invalid_retention');
  const p=policy(job);
  if(p){if(p.retain_until!==retainUntil)fail('retention_conflict');return {...p};}
  db.prepare('INSERT INTO job_retention_policy VALUES(?,?,?,?)').run(job,owner,worker,retainUntil);
  return {...policy(job)};
 }
 function expire({job,owner,worker}){
  tx();const p=guard(job,owner,worker,'expire');if(!p)fail('retention_not_found');
  const at=now();if(at<p.retain_until)return {deleted:false};
  let tomb=db.prepare('SELECT * FROM job_retention_tombstones WHERE job=?').get(job);
  if(tomb)return {...tomb,deleted:true};
  const state=readState(job);
  if(!state||!str(state.status))fail('native_state_required');
  // Install the durable logical fence before the trusted hook observes it.
  // Every parent entrypoint must call assertAvailable; this is not a physical stop.
  const terminal=['finished','cancelled','deleted'].includes(state.status);
  const canPurge=terminal&&state.compute_stopped===true;
  db.prepare('INSERT INTO job_retention_tombstones VALUES(?,?,?,?,?,?,?)')
   .run(job,owner,worker,p.retain_until,at,state.status,Number(!canPurge));
  // Synchronous hook validates/enforces this fence in the same transaction.
  // Throwing or returning anything other than true rolls the tombstone back.
  if(fence({job,owner,worker,reason:'retention'})!==true)fail('fence_not_confirmed');
  if(canPurge&&purge({job,owner,worker,retainAudit:true})!==true)fail('purge_not_confirmed');
  return {...db.prepare('SELECT * FROM job_retention_tombstones WHERE job=?').get(job),deleted:true};
 }
 function completePurge({job,owner,worker}){
  tx();guard(job,owner,worker,'purge');
  const tomb=db.prepare('SELECT * FROM job_retention_tombstones WHERE job=?').get(job);
  if(!tomb)fail('tombstone_required');
  if(!tomb.purge_pending)return {purged:true};
  const state=readState(job);
  if(!state||!['finished','cancelled','deleted'].includes(state.status)||state.compute_stopped!==true)return {purged:false};
  if(purge({job,owner,worker,retainAudit:true})!==true)fail('purge_not_confirmed');
  db.prepare('UPDATE job_retention_tombstones SET purge_pending=0 WHERE job=?').run(job);
  return {purged:true};
 }
 return {assertAvailable,define,expire,completePurge};
}
