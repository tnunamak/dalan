const fail=code=>{throw Object.assign(new Error(code),{code});};
function canonical(value) {
  if(value===null||typeof value==='string'||typeof value==='boolean') return value;
  if(typeof value==='number'&&Number.isFinite(value)) return value;
  if(Array.isArray(value)) return value.map(canonical);
  if(value&&Object.getPrototypeOf(value)===Object.prototype) return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  fail('invalid_command');
}
const json=value=>JSON.stringify(canonical(value));

// One private owner mutation, receipt and revision in the caller's transaction.
// The raw capability is authenticated here and never enters the receipt table.
export function executeProtocolOwnerCommand(store,job,token,command,mutate) {
  const {db}=store;
  if(!db.isTransaction) fail('transaction_required');
  store.owner(job,token);
  if(!store.isProtocolJob(job)) fail('protocol_job_required');
  store.assertProtocolAvailable(job);
  const {key,revision,operation,args}=command??{};
  if(typeof key!=='string'||!key.length||key.length>512||!Number.isSafeInteger(revision)||revision<0||typeof operation!=='string'||!operation||typeof mutate!=='function') fail('invalid_command');
  const owner=db.prepare('SELECT owner_hash FROM assignments WHERE request_id=?').get(job).owner_hash;
  const identity=json({job,owner,key,expectedRevision:revision,operation,args});
  const prior=db.prepare('SELECT identity,result FROM claim_command_receipts WHERE job=? AND command_key=?').get(job,key);
  if(prior) {
    if(prior.identity!==identity) fail('command_conflict');
    return JSON.parse(prior.result);
  }
  if(store.protocolRevision(job)!==revision) fail('revision_conflict');
  const next=store.advanceProtocolRevisionInTransaction(job);
  const value=mutate();
  if(value&&typeof value.then==='function') fail('async_mutation_forbidden');
  const result={value,revision:next};
  db.prepare('INSERT INTO claim_command_receipts(job,command_key,identity,result) VALUES(?,?,?,?)').run(job,key,identity,json(result));
  return result;
}
