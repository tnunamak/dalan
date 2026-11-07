import { readEnv } from './env.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { redactSecrets } from './redaction.mjs';

const textFields = ['message', 'prompt', 'text'];
const sha256 = value => createHash('sha256').update(value).digest('hex');

// Free text is never stored: only the digest is kept. Only short mode-like
// values of a few fields stay readable; any other string is hashed.
const readableFields=new Set(['workspaceMode','status','mode','provider','thinkingEffort','permission','interactionMode','speedMode','environmentMode','projectPolicy']);
const enumShaped=value=>/^[a-z][a-z0-9_-]{0,23}$/.test(value)&&!/[0-9a-f]{32,}/i.test(value)&&!/^whsec_/i.test(value);

const auditFields=new Set(['threadId','projectId','cwd','workspaceMode','status','detail','turns','firstTurn','maxChars','timeoutMs','mode','wakeSettled','provider','model','thinkingEffort','permission','interactionMode','speedMode','environmentMode','projectPolicy','open','options']);

export function prepareT3Audit(tool, args = {}, worker='dot') {
  const value = textFields.map(key => args[key]).find(item => typeof item === 'string');
  const summary = {};
  for(const [key,item] of Object.entries(args)) {
    if(!auditFields.has(key)) continue;
    const serialized=JSON.stringify(item);
    const bounded=typeof item==='string'&&readableFields.has(key)&&enumShaped(item)&&redactSecrets(item).redacted===0?item
      :typeof item==='boolean'||typeof item==='number'||item===null?item
      :{sha256:sha256(serialized),bytes:Buffer.byteLength(serialized)};
    if(Buffer.byteLength(JSON.stringify({...summary,[key]:bounded}))>2048) break;
    summary[key]=bounded;
  }
  return {
    call_id: randomUUID(), tool, worker, args_summary: JSON.stringify(summary),
    text_sha256: value === undefined ? null : sha256(value),
    text_preview: null,
  };
}

export function initT3Audit(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS t3_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    call_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    tool TEXT NOT NULL,
    args_summary TEXT NOT NULL,
    text_sha256 TEXT,
    text_preview TEXT,
    result_status TEXT NOT NULL,
    t3_ids TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS t3_audit_at ON t3_audit(at);
  CREATE TRIGGER IF NOT EXISTS t3_audit_no_update BEFORE UPDATE ON t3_audit BEGIN SELECT RAISE(ABORT, 't3 audit is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS t3_audit_no_delete BEFORE DELETE ON t3_audit BEGIN SELECT RAISE(ABORT, 't3 audit is append-only'); END;`);
  if(!db.prepare('PRAGMA table_info(t3_audit)').all().some(column=>column.name==='worker')) db.exec("ALTER TABLE t3_audit ADD COLUMN worker TEXT NOT NULL DEFAULT 'dot'");
  // Old rows have no trustworthy worker attribution. Keep them as history, never
  // charge them to a live principal merely because the migration default is 'dot'.
  if(!db.prepare('PRAGMA table_info(t3_audit)').all().some(column=>column.name==='budget_version')) db.exec('ALTER TABLE t3_audit ADD COLUMN budget_version INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS t3_audit_principal_at ON t3_audit(worker,subject,at) WHERE budget_version=1');
}

// One start or denial charges one call. Final records always fit an admitted
// call. Persisted rolling windows survive reconnects/restarts without deleting
// append-only history or charging another subject on the same worker.
export function admitT3Audit(db,worker,subject,{now=Date.now(),env=process.env}={}) {
  if(typeof subject!=='string'||!subject) throw new Error('T3 audit requires an authenticated subject');
  const limit=(name,fallback)=>{
    const value=readEnv(name,env)===undefined?fallback:Number(readEnv(name,env));
    if(!Number.isSafeInteger(value)||value<1) throw new Error(`invalid ${name}: expected a positive safe integer`);
    return value;
  };
  const perMinute=limit('DALAN_T3_CALLS_PER_MINUTE',60),perDay=limit('DALAN_T3_CALLS_PER_DAY',10000);
  const count=db.prepare(`SELECT count(*) n FROM t3_audit
    WHERE worker=? AND subject=? AND budget_version=1 AND at>? AND at<=?
      AND (result_status='started' OR result_status LIKE 'denied:%')`);
  const until=new Date(now).toISOString();
  const recent=count.get(worker,subject,new Date(now-60000).toISOString(),until).n;
  const daily=count.get(worker,subject,new Date(now-86400000).toISOString(),until).n;
  if(recent>=perMinute||daily>=perDay) throw new Error('t3_rate_limit: principal call budget exhausted (rolling 60-second/24-hour windows)');
}

// Result ids come from a remote service: keep plain id-shaped values readable, hash anything else.
// An unbroken 24+ character alphanumeric run is the shape of an opaque credential, so it is hashed too.
const plainId=value=>typeof value==='string'&&value.length<=512&&/^[A-Za-z0-9._:%-]+$/.test(value)&&!/[0-9a-f]{32,}/i.test(value)&&!/[A-Za-z0-9]{24,}/.test(value)&&!/^whsec_/i.test(value)&&redactSecrets(value).redacted===0;
const safeIds=value=>Array.isArray(value)?value.map(safeIds)
  :typeof value==='string'?(plainId(value)?value:`sha256:${sha256(value)}`)
  :value&&typeof value==='object'?safeKeys(value)
  :value;

// Keys come from the same remote service and get the same check. A hashed key that meets an existing name gets a
// numbered suffix, so no entry is lost.
function safeKeys(value) {
  const out={};
  for(const [key,item] of Object.entries(value)) {
    const base=plainId(key)?key:`sha256:${sha256(key)}`;
    let name=base,n=2;
    while(Object.hasOwn(out,name)) name=`${base} (${n++})`;
    out[name]=safeIds(item);
  }
  return out;
}

export function appendT3Audit(db, entry, subject, resultStatus, result) {
  const ids = result?._audit_ids && typeof result._audit_ids === 'object'
    ? result._audit_ids
    : result?.t3_ids && typeof result.t3_ids === 'object'
      ? result.t3_ids
      : result && typeof result === 'object'
        ? Object.fromEntries([
          ['threadIds', result.threadId ? [result.threadId] : []],
          ['projectIds', result.projectId ? [result.projectId] : []],
          ['runIds', result.runId ? [result.runId] : []],
          ['messageIds', result.messageId ? [result.messageId] : []],
        ].filter(([, items]) => items.length))
        : {};
  db.prepare(`INSERT INTO t3_audit(at,call_id,subject,tool,args_summary,text_sha256,text_preview,result_status,t3_ids,worker,budget_version)
    VALUES(?,?,?,?,?,?,?,?,?,?,1)`).run(new Date().toISOString(), entry.call_id, subject, entry.tool,
      entry.args_summary, entry.text_sha256, entry.text_preview, resultStatus, JSON.stringify(safeIds(ids)), entry.worker??'dot');
}

export function listT3Audit(db, since) {
  if (since && (!Number.isFinite(Date.parse(since)) || !/^\d{4}-\d\d-\d\dT/.test(since))) throw new Error('invalid audit since');
  return db.prepare(`SELECT * FROM t3_audit WHERE at >= ? ORDER BY id DESC`).all(since ? new Date(since).toISOString() : '0000')
    .map(row => ({...row, args_summary: JSON.parse(row.args_summary), t3_ids: JSON.parse(row.t3_ids)}));
}
