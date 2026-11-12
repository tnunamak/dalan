import {createHash, timingSafeEqual, randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const PULL_PAGE_PREFIX='pullpage_';
export function routingPolicy(value,assignment) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['version','allowed_workers','fan_out','deadline_at'].includes(key))) throw new Error('invalid routing policy: supported fields are version, allowed_workers, fan_out, deadline_at');
  if(value.version!==1||value.fan_out!==undefined&&value.fan_out!==1) throw new Error('routing v1 supports version=1 and fan_out=1 only');
  const names=value.allowed_workers;
  if(!Array.isArray(names)||!names.length||names.length>100||names.some(name=>typeof name!=='string'||!(/^[a-z][a-z0-9_-]{0,31}$/).test(name))||new Set(names).size!==names.length) throw new Error('routing requires 1-100 distinct explicit allowed_workers');
  if(assignment.execution_scope!=='read-only'||Object.hasOwn(assignment,'protocol')) throw new Error('routing v1 supports read-only assignments without protocol only');
  const deadline=value.deadline_at??assignment.valid_until;
  if(typeof deadline!=='string'||!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(deadline)||!Number.isFinite(Date.parse(deadline))) throw new Error('routing requires an explicit RFC3339 deadline_at or assignment.valid_until');
  const assignmentDeadline=assignment.valid_until===undefined?null:Date.parse(assignment.valid_until);
  if(assignmentDeadline!==null&&!Number.isFinite(assignmentDeadline))throw new Error('invalid assignment valid_until');
  return {version:1,allowed_workers:[...names].sort(),fan_out:1,deadline_at:new Date(Math.min(Date.parse(deadline),assignmentDeadline??Infinity)).toISOString()};
}
export function migratePullQueue(db) {
  db.exec(`CREATE TABLE policy_work_orders (
    work_order_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, intent_digest TEXT NOT NULL,
    owner_hash TEXT NOT NULL, payload TEXT NOT NULL, options TEXT NOT NULL, routing TEXT NOT NULL,
    approvals TEXT NOT NULL, created_at TEXT NOT NULL, priority TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued', owner_read_at TEXT, cancelled_at TEXT, cancelled_reason TEXT,
    child_request_id TEXT UNIQUE REFERENCES assignments(request_id),
    receipt TEXT, worker TEXT, subject TEXT, connection_id TEXT, acquisition_id TEXT
  ); CREATE INDEX policy_work_backlog ON policy_work_orders(state,priority,created_at);
  CREATE TRIGGER policy_work_intent_immutable BEFORE UPDATE OF work_order_id,request_id,intent_digest,owner_hash,payload,options,routing,approvals,created_at,priority ON policy_work_orders BEGIN SELECT RAISE(ABORT,'policy work intent is immutable'); END;`);
}

// A work order reserves the submitted request ID. Its one execution child takes
// that ID at acquisition, so the owner's durable capability and wait path survive.
export class PullQueue {
  constructor(store) {
    this.store=store;this.db=store.db;
    this.db.prepare("INSERT OR IGNORE INTO bridge_state(key,value) VALUES('pull_cursor_key',?)").run(randomBytes(32).toString('hex'));
    this.cursorKey=Buffer.from(this.db.prepare("SELECT value FROM bridge_state WHERE key='pull_cursor_key'").get().value,'hex');
  }
  cursor(worker,value) {
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.cursorKey,nonce);cipher.setAAD(Buffer.from(worker));
    const encrypted=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);
    return PULL_PAGE_PREFIX+Buffer.concat([nonce,cipher.getAuthTag(),encrypted]).toString('base64url');
  }
  readCursor(worker,cursor) {
    try {
      const bytes=Buffer.from(cursor.slice(PULL_PAGE_PREFIX.length),'base64url'),decipher=createDecipheriv('aes-256-gcm',this.cursorKey,bytes.subarray(0,12));
      decipher.setAAD(Buffer.from(worker));decipher.setAuthTag(bytes.subarray(12,28));
      const value=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString());
      if(!Array.isArray(value)||value.length!==3||value.some(n=>!Number.isSafeInteger(n)||n<0)||value[1]>1||value[2]>value[0])throw new Error();
      return value;
    }catch{throw new Error('assignment not found');}
  }
  row(id) { return this.db.prepare('SELECT rowid AS sequence,* FROM policy_work_orders WHERE request_id=?').get(id); }
  ownerRow(id) { return this.row(id); }
  inbox(id) {
    const row=this.row(id);if(!row||row.child_request_id)return null;
    const projected=this.project(row);
    return {target_worker:null,work_order_id:row.work_order_id,brief:projected.assignment.brief,created_at:row.created_at,finished_at:null,outcome:null,consumed:false,decision:null,delivered_t3:false,
      cancelled_at:projected.cancelled_at,cancelled_reason:projected.cancelled_reason,cancelled_by_owner:row.state==='cancelled',read:row.owner_read_at!==null,failure_type:projected.cancelled_reason==='expired'?'expired':row.state==='cancelled'?'owner_cancelled':null,failure_type_source:projected.cancelled_reason==='expired'?'bridge_observed_transition':row.state==='cancelled'?'bridge_observed_transition':null,unanswered_blocker:null};
  }
  consume(id) {
    const row=this.row(id);if(!row||row.child_request_id)return;
    if(this.project(row).status==='cancelled')this.db.prepare('UPDATE policy_work_orders SET owner_read_at=COALESCE(owner_read_at,?) WHERE request_id=?').run(this.store.stamp(),id);
  }
  assertOwner(row,token) {
    const got=createHash('sha256').update(token??'').digest();
    if(!row||!timingSafeEqual(got,Buffer.from(row.owner_hash,'hex'))) throw new Error('invalid owner capability');
  }
  project(row) {
    const assignment=JSON.parse(row.payload),routing=JSON.parse(row.routing),options=JSON.parse(row.options);
    const expired=row.state==='queued'&&Date.parse(routing.deadline_at)<=this.store.nowMs();
    return {request_id:row.request_id,work_order_id:row.work_order_id,child_request_id:row.child_request_id,
      status:expired?'cancelled':row.state,assignment,routing,created_at:row.created_at,
      target_worker:null,execution:options.execution,delivery_mode:options.delivery.mode==='t3'?`t3:${options.delivery.threadId}`:'none',
      thread_id:options.delivery.threadId??null,environment_id:options.environmentId??null,
      valid_until:routing.deadline_at,cancelled_at:row.cancelled_at,cancelled_reason:row.cancelled_reason??(expired?'expired':null),
      claim:null,report:null,progress:[],owner_notes:[],delivery:[],lifecycle_events:[],required_capabilities:[]};
  }
  submit(payload,identity,options,routing,approvals,ownerToken,{dryRun=false}={}) {
    const ownerHash=createHash('sha256').update(ownerToken).digest('hex');
    const intent=digest(canonical({identity,options,routing,approvals}));
    return this.store.inTransaction(()=>{
      const old=this.row(payload.request_id);
      if(old) {
        this.assertOwner(old,ownerToken);
        if(old.intent_digest!==intent) throw new Error('request_id conflict');
        return {request_id:old.request_id,work_order_id:old.work_order_id,status:old.child_request_id?this.store.get(old.child_request_id).status:this.project(old).status,duplicate:true,...(dryRun?{dry_run:true,stored:false,verdict:'admissible'}:{})};
      }
      if(this.store.hasAssignment(payload.request_id)) throw new Error('request_id conflict');
      if(Date.parse(routing.deadline_at)<=this.store.nowMs()) throw new Error('routing deadline expired');
      const workId='work_'+digest(payload.request_id).slice(0,32);
      if(!dryRun) this.db.prepare('INSERT INTO policy_work_orders(work_order_id,request_id,intent_digest,owner_hash,payload,options,routing,approvals,created_at,priority) VALUES(?,?,?,?,?,?,?,?,?,?)').run(workId,payload.request_id,intent,ownerHash,JSON.stringify(payload),JSON.stringify(options),JSON.stringify(routing),JSON.stringify(approvals),this.store.stamp(),options.priority);
      return {request_id:payload.request_id,work_order_id:workId,status:'queued',duplicate:false,...(dryRun?{dry_run:true,stored:false,verdict:'admissible'}:{})};
    });
  }
  eligible(row,worker,admit) {
    if(!row||!JSON.parse(row.routing).allowed_workers.includes(worker)) return false;
    try { admit(worker,JSON.parse(row.payload),JSON.parse(row.options).execution,JSON.parse(row.approvals)[worker]); return true; } catch { return false; }
  }
  get(id,worker,admit) {
    const row=this.row(id);
    if(!row||row.state!=='queued'||Date.parse(JSON.parse(row.routing).deadline_at)<=this.store.nowMs()||!this.eligible(row,worker,admit)) throw new Error('assignment not found');
    return {...this.project(row),guidance:'Claim this request_id with a fresh acquisition_id. The receipt names the immutable execution child; use its request_id and claim_id for all later tools.'};
  }
  list(worker,admit,cursor=null) {
    let after=0,rank=0,snapshot=this.db.prepare('SELECT COALESCE(max(rowid),0) n FROM policy_work_orders').get().n;
    if(cursor)[snapshot,rank,after]=this.readCursor(worker,cursor);
    const rows=this.db.prepare("SELECT rowid AS sequence,CASE priority WHEN 'normal' THEN 0 ELSE 1 END AS rank,* FROM policy_work_orders WHERE state='queued' AND rowid<=? AND (CASE priority WHEN 'normal' THEN 0 ELSE 1 END>? OR (CASE priority WHEN 'normal' THEN 0 ELSE 1 END=? AND rowid>?)) ORDER BY rank,rowid").iterate(snapshot,rank,rank,after);
    const items=[];let next=null;
    for(const row of rows) {
      if(Date.parse(JSON.parse(row.routing).deadline_at)<=this.store.nowMs()||!this.eligible(row,worker,admit)) continue;
      if(items.length===50) { const last=items.at(-1);next=this.cursor(worker,[snapshot,last._rank,last._sequence]);break; }
      items.push({request_id:row.request_id,work_order_id:row.work_order_id,title:JSON.parse(row.payload).brief.slice(0,160),created_at:row.created_at,priority:row.priority,deadline_at:JSON.parse(row.routing).deadline_at,remaining_result_slots:1,_sequence:row.sequence,_rank:row.rank});
    }
    return {items:items.map(({_sequence,_rank,...item})=>item),next_page_request_id:next,guidance:'Use get with next_page_request_id to read the next page. Use claim with an offered request_id and fresh acquisition_id to acquire its single result slot. Capacity limits claims, not this backlog.'};
  }
  acquire(id,{worker,subject,connectionId,claimant,acquisitionId,leaseMs,capacity,preflight,admit}) {
    if(typeof acquisitionId!=='string'||!(/^[A-Za-z0-9_-]{1,128}$/).test(acquisitionId)) throw new Error('policy work requires a fresh acquisition_id');
    return this.store.transaction(()=>{
      const row=this.row(id);
      if(!row||!JSON.parse(row.routing).allowed_workers.includes(worker)) throw new Error('assignment not found');
      if(row.child_request_id) {
        if(row.worker!==worker||row.subject!==subject||row.connection_id!==(connectionId??null)||row.acquisition_id!==acquisitionId) throw new Error('work order already acquired');
        if(this.store.get(id).status!=='claimed')throw new Error('assignment finished or cancelled');
        const receipt=JSON.parse(row.receipt),held=this.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id);
        if(held?.claimant!==claimant||held?.lease_ms!==(leaseMs??this.store.limits.leaseMs))throw new Error('acquisition_id conflict');
        this.store.assertClaim(id,receipt.claim_id,subject,worker);
        this.store.assertWorkerConnection(id,receipt.claim_id,subject,worker,connectionId);
        return {...receipt,duplicate:true};
      }
      if(row.state!=='queued') throw new Error('assignment cancelled');
      const payload=JSON.parse(row.payload),options=JSON.parse(row.options),routing=JSON.parse(row.routing),approval=JSON.parse(row.approvals)[worker];
      if(Date.parse(routing.deadline_at)<=this.store.nowMs()) throw new Error('routing deadline expired');
      admit(worker,payload,options.execution,approval);
      // Both insert and ordinary claim join this transaction. A failed capacity,
      // destination or preflight check leaves no child and no consumed slot.
      this.store.submitInTransaction({...payload,valid_until:routing.deadline_at},options.delivery,options.environmentId,'',options.review,preflight,options.priority,options.meta,payload,null,worker,options.execution,options.execution,null,null,null,null,approval??null,row.owner_hash);
      const claimed=this.store.claimInTransaction(id,claimant,subject,capacity,preflight,worker,acquisitionId,leaseMs??this.store.limits.leaseMs,connectionId);
      if(!claimed.claim_id) throw new Error('policy child admission refused');
      const held=this.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id);
      const receipt={...claimed,lease_expires_at:this.store.leaseExpiresAt(held),work_order_id:row.work_order_id,child_request_id:id};
      this.db.prepare("UPDATE policy_work_orders SET state='acquired',child_request_id=?,receipt=?,worker=?,subject=?,connection_id=?,acquisition_id=? WHERE request_id=?").run(id,JSON.stringify(receipt),worker,subject,connectionId??null,acquisitionId,id);
      return receipt;
    });
  }
  cancel(id,reason=null) {
    return this.store.inTransaction(()=>{
      const row=this.row(id);if(!row||row.child_request_id) return null;
      this.db.prepare("UPDATE policy_work_orders SET state='cancelled',cancelled_at=COALESCE(cancelled_at,?),cancelled_reason=COALESCE(cancelled_reason,?) WHERE request_id=?").run(this.store.stamp(),reason,id);
      return {request_id:id,status:'cancelled',cancellation_requested:true,authority_revoked:true,compute_stopped:false};
    });
  }
}
