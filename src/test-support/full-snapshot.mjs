// Test oracle for "a refusal changed nothing": every row of every table that belongs to one assignment, plus the
// files the bridge keeps for it. Built from the live schema, so a table added later is covered automatically.
// A table that has neither a request_id nor a job column must be listed below on purpose; otherwise the
// snapshot throws instead of silently skipping it.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

// Not scoped to one assignment, and written by background timers or by call accounting that runs before any claim
// check (worker_calls and worker_activity count every authenticated call, refused or not).
const unscopedIgnored=new Set(['alert_cursors','alert_episodes','break_notices','bridge_state','worker_breaks','integration_verifications',
  'learned_limits','lifecycle_daily','lifecycle_retention','operator_state','protocol_delivery_attempts','schema_migrations',
  'subscription_storage_meta','worker_activity','worker_calls']);
// Not scoped to one assignment, but a claim-bound tool call must never write them.
const unscopedCompared=new Set(['messages','subscriptions','t3_audit','registered_tools','tool_grants','tool_registry_log',
  'tool_outbox','tool_idempotency','tool_post_log','tool_registry_meta']);

export function fullSnapshot(db,id) {
  const out={};
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  for(const {name} of tables) {
    const columns=db.prepare(`PRAGMA table_info(${name})`).all().map(column=>column.name);
    const key=columns.includes('request_id')?'request_id':columns.includes('job')?'job':null;
    if(key) { out[name]=db.prepare(`SELECT * FROM ${name} WHERE ${key}=? ORDER BY rowid`).all(id); continue; }
    if(unscopedCompared.has(name)) { out[name]=db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(); continue; }
    if(!unscopedIgnored.has(name)) throw new Error(`full snapshot cannot scope table ${name}: add a request_id/job column or list it`);
  }
  return out;
}

// Relative path and sha256 of every file that belongs to the assignment under `root`: any path with a segment equal to
// the request id, or starting with `<id>.`. Everything below a matching directory counts.
export function fileSnapshot(root,id) {
  const out={};
  const walk=(dir,inside)=>{
    let entries;try {entries=fs.readdirSync(dir,{withFileTypes:true});} catch(error) {if(error.code==='ENOENT')return;throw error;}
    for(const entry of entries.sort((a,b)=>a.name<b.name?-1:1)) {
      const full=path.join(dir,entry.name),matches=inside||entry.name===id||entry.name.startsWith(id+'.');
      if(entry.isDirectory()) walk(full,matches);
      else if(matches) out[path.relative(root,full)]=entry.isSymbolicLink()?'symlink:'+fs.readlinkSync(full):
        createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root,false);
  return out;
}

// Names of the columns that differ between two rows (or [] when equal).
export function changedColumns(before,after) {
  return Object.keys({...before,...after}).filter(key=>JSON.stringify(before?.[key])!==JSON.stringify(after?.[key]));
}
