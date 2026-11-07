import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const digest=value=>createHash('sha256').update(value).digest('hex');

// This ledger is deliberately outside bridge.db so a main-database rollback
// cannot erase positive transport acknowledgments.
export class AckLedger {
  constructor(file) {
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    const existed=fs.existsSync(file);
    if(existed&&(fs.statSync(file).mode&0o777)!==0o600) throw new Error('acknowledgment ledger must be mode 0600');
    if(!existed) { const fd=fs.openSync(file,'wx',0o600); fs.closeSync(fd); }
    this.db=new DatabaseSync(file);
    try {
      if((fs.statSync(file).mode&0o777)!==0o600) throw new Error('acknowledgment ledger must be mode 0600');
      this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS acknowledgments(event_id TEXT NOT NULL,body_sha256 TEXT NOT NULL,binding_sha256 TEXT NOT NULL,acknowledged_at TEXT NOT NULL,PRIMARY KEY(event_id,body_sha256,binding_sha256)) WITHOUT ROWID;');
      if(this.db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok') throw new Error('acknowledgment ledger integrity check failed');
    } catch(error) { this.db.close(); throw new Error(`acknowledgment ledger unavailable: ${error.message}`,{cause:error}); }
  }
  key(eventId,body,binding) {
    return {eventId,bodySha256:digest(body),bindingSha256:digest(binding)};
  }
  has(key) {
    return !!this.db.prepare('SELECT 1 FROM acknowledgments WHERE event_id=? AND body_sha256=? AND binding_sha256=?').get(key.eventId,key.bodySha256,key.bindingSha256);
  }
  record(key,at=new Date().toISOString()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO acknowledgments(event_id,body_sha256,binding_sha256,acknowledged_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(key.eventId,key.bodySha256,key.bindingSha256,at);
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw new Error(`acknowledgment ledger write failed: ${error.message}`,{cause:error}); }
  }
  close() { this.db.close(); }
}
