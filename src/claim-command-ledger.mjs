import { canonicalValue as canonical, canonicalJson as json, assertClaimAuthority, decide } from '../packages/job-core/index.mjs';

// Parent transaction owns native mutation, revision and immutable receipt.
const fail=c=>{throw Object.assign(new Error(c),{code:c});};
const str=v=>typeof v==='string'&&v.length>0&&v.length<=512;
const nat=v=>Number.isSafeInteger(v)&&v>=0;
export function migrateClaimCommands(db) {
  if(!db.isTransaction)fail('transaction_required');
  db.exec(`CREATE TABLE IF NOT EXISTS claim_command_revisions(job TEXT PRIMARY KEY,revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS claim_command_receipts(job TEXT NOT NULL,command_key TEXT NOT NULL,
      identity TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(job,command_key));`);
}
export function createClaimCommands({db,authorize,clock=Date.now,maxLeaseMs=3600000}) {
  if(typeof authorize!=='function'||!nat(maxLeaseMs)||maxLeaseMs===0)fail('invalid_configuration');
  const tx=()=>{if(!db.isTransaction)fail('transaction_required');};
  const revision=job=>db.prepare('SELECT revision FROM claim_command_revisions WHERE job=?').get(job)?.revision??null;
  function initialize(job,value) {
    tx();if(!str(job)||!nat(value))fail('invalid_revision');
    const current=revision(job);
    if(current!==null&&current!==value)fail('revision_conflict');
    if(current===null)db.prepare('INSERT INTO claim_command_revisions VALUES(?,?)').run(job,value);
    return value;
  }
  function advance(job,expected) {
    tx();if(!nat(expected)||expected>=Number.MAX_SAFE_INTEGER)fail('invalid_revision');
    const result=db.prepare('UPDATE claim_command_revisions SET revision=revision+1 WHERE job=? AND revision=?').run(job,expected);
    if(result.changes!==1)fail('revision_conflict');
    return expected+1;
  }
  function execute(command,mutate) {
    tx();
    const {job,subject,worker,claim,epoch,operation,key,expectedRevision,args}=command;
    if(![job,subject,worker,claim,operation,key].every(str)||!nat(epoch)||epoch<1||!nat(expectedRevision)||typeof mutate!=='function')fail('invalid_command');
    const now=clock();if(!nat(now))fail('invalid_clock');
    const authority=authorize({job,subject,worker,claim,epoch,operation,now});
    assertClaimAuthority({job,subject,worker,claim,epoch},authority,now);
    const identity=json(command);
    const old=db.prepare('SELECT identity,result FROM claim_command_receipts WHERE job=? AND command_key=?').get(job,key);
    if(old){if(old.identity!==identity)fail('command_conflict');return JSON.parse(old.result);}
    const decision=decide({revision:revision(job)},{expectedRevision,operation,args},{now,maxLeaseMs});
    const {leaseUntil}=decision;
    // No arbitrary worker callback: parent injects the trusted Store mutation.
    const nextRevision=advance(job,decision.effects[0].expectedRevision);
    const value=mutate({command,now,revision:nextRevision,...(leaseUntil===undefined?{}:{leaseUntil})});
    if(value&&typeof value.then==='function')fail('async_mutation_forbidden');
    const result={value:canonical(value??null),revision:nextRevision,...(leaseUntil===undefined?{}:{leaseUntil})};
    db.prepare('INSERT INTO claim_command_receipts VALUES(?,?,?,?)').run(job,key,identity,json(result));
    return result;
  }
  return {initialize,revision,advance,execute};
}
