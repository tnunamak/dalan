import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const META_KEY='dot-bridge/idempotencyKey';

// Validate before argument auditing; metadata never enters argument summaries.
export function notifyKey(meta) {
  if(meta===undefined||meta===null) return undefined;
  if(typeof meta!=='object'||Array.isArray(meta)) throw new Error('invalid notification metadata');
  if(!Object.hasOwn(meta,META_KEY)) return undefined;
  const key=meta[META_KEY];
  if(typeof key!=='string'||!key.trim()||key.length>256) throw new Error('invalid notification idempotency key');
  return key;
}

// Positive results only; outside J3, with no cross-process or crash exactly-once claim.
export class NotifyLedger {
  constructor(file) {
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    if(!fs.existsSync(file)) { const fd=fs.openSync(file,'wx',0o600); fs.closeSync(fd); }
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||(stat.mode&0o777)!==0o600) throw new Error('notification ledger must be a regular mode 0600 file');
    this.db=new DatabaseSync(file);
    this.inFlight=new Map();
    try {
      this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS sent(key_sha256 TEXT PRIMARY KEY,result_json TEXT,state TEXT NOT NULL DEFAULT \'delivered\',sent_at INTEGER NOT NULL,reconcile_evidence TEXT) WITHOUT ROWID;');
      if(!this.db.prepare("SELECT 1 FROM pragma_table_info('sent') WHERE name='state'").get()) this.db.exec("ALTER TABLE sent ADD COLUMN state TEXT NOT NULL DEFAULT 'delivered'");
      if(!this.db.prepare("SELECT 1 FROM pragma_table_info('sent') WHERE name='reconcile_evidence'").get()) this.db.exec('ALTER TABLE sent ADD COLUMN reconcile_evidence TEXT');
      if(this.db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok') throw new Error('integrity check failed');
    } catch(error) { this.db.close(); throw new Error('notification ledger unavailable',{cause:error}); }
  }
  pending() { return this.db.prepare("SELECT key_sha256,sent_at FROM sent WHERE state='pending' ORDER BY sent_at,key_sha256").all().map(row=>({key_sha256:row.key_sha256,reserved_at:row.sent_at})); }
  reconcile({key_sha256,outcome,evidence}) {
    if(typeof key_sha256!=='string'||!/^[a-f0-9]{64}$/.test(key_sha256)||!['sent','unsent'].includes(outcome)||typeof evidence!=='string'||!evidence.trim()||evidence.length>2000) throw new Error('invalid notification reconciliation');
    if(this.inFlight.has(key_sha256)) throw new Error('notification still in flight');
    const evidenceHash=createHash('sha256').update(evidence.trim()).digest('hex');
    const result=outcome==='sent'
      ? this.db.prepare("UPDATE sent SET state='delivered',result_json=?,sent_at=?,reconcile_evidence=? WHERE key_sha256=? AND state='pending'").run(JSON.stringify({notified:true}),Date.now(),evidenceHash,key_sha256)
      : this.db.prepare("UPDATE sent SET state='retryable',result_json='{}',reconcile_evidence=? WHERE key_sha256=? AND state='pending'").run(evidenceHash,key_sha256);
    if(result.changes!==1) throw new Error('notification is not pending');
    return {key_sha256,outcome,state:outcome==='sent'?'delivered':'retryable'};
  }
  async send(worker,text,key,publish) {
    const hash=createHash('sha256').update(JSON.stringify([worker,key===undefined?'payload':'caller',key===undefined?text:key])).digest('hex');
    const pending=this.inFlight.get(hash);
    if(pending) return pending;
    // Set the promise before running any cache or network work.
    const promise=Promise.resolve().then(async()=>{
      const row=this.db.prepare('SELECT result_json,state FROM sent WHERE key_sha256=?').get(hash);
      if(row?.state==='pending') throw new Error('uncertain notification: reconcile receiver acceptance before retry');
      if(row?.state==='delivered') {
        const result=JSON.parse(row.result_json);
        if(result?.notified!==true||Object.keys(result).length!==1) throw new Error('invalid notification ledger result');
        return result;
      }
      if(row?.state==='retryable') {
        const changed=this.db.prepare("UPDATE sent SET state='pending',result_json='{}',sent_at=?,reconcile_evidence=NULL WHERE key_sha256=? AND state='retryable'").run(Date.now(),hash);
        if(changed.changes!==1) throw new Error('uncertain notification: another sender reserved this key');
      } else {
        const reservation=this.db.prepare("INSERT INTO sent(key_sha256,result_json,state,sent_at) VALUES(?,'{}','pending',?) ON CONFLICT(key_sha256) DO NOTHING").run(hash,Date.now());
        if(reservation.changes!==1) throw new Error('uncertain notification: another sender reserved this key');
      }
      try {
        const published=await publish(hash);
        if(published===false) throw Object.assign(new Error('notification was not accepted'),{notifyOutcome:'not_accepted'});
        const result={notified:true};
        // One synchronous autocommit; never a transaction held across publish.
        this.db.prepare("UPDATE sent SET result_json=?,state='delivered',sent_at=?,reconcile_evidence=NULL WHERE key_sha256=? AND state='pending'").run(JSON.stringify(result),Date.now(),hash);
        return result;
      } catch(error) {
        if(error?.notifyOutcome==='not_accepted') this.db.prepare("UPDATE sent SET state='retryable',reconcile_evidence=? WHERE key_sha256=? AND state='pending'").run(String(error.message).slice(0,2000),hash);
        throw error;
      }
    });
    this.inFlight.set(hash,promise);
    try { return await promise; }
    finally { if(this.inFlight.get(hash)===promise) this.inFlight.delete(hash); }
  }
  close() { this.db.close(); }
}
