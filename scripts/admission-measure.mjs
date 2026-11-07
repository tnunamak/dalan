#!/usr/bin/env node
import { defaultPath } from '../src/paths.mjs';
// Read-only Move2 report. Request IDs and declared objective cohorts are proxies, not proven intent.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readLines } from '../src/request-log.mjs';
import { reasonsFromError } from '../src/work-order.mjs';
import { inferWorkerReport } from '../src/failure-type.mjs';

const preventableCodes=new Set(['unknown_scope_path','undeclared_path','ambiguous_path','unknown_path','brief_too_large','instructions_too_large','expected_output_too_large','missing_inputs','missing_scope','diff_outside_scope','contradictory_scope','output_path_taken','missing_test_scope','invalid_output_paths']);
const policyDenialCodes=new Set(['sensitive_path_hard','sensitive_path','secret_content','authority_claim','output_path_sensitive']);
const round=n=>Math.round(n*100)/100;
const pct=(n,d)=>d?round(100*n/d):null;
function percentile(values,p){if(!values.length)return null;const s=[...values].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.ceil(s.length*p)-1)];}
const labelDigest=(digest,legacy)=>typeof digest==='string'&&/^[0-9a-f]{64}$/.test(digest)?digest:typeof legacy==='string'&&legacy.trim()?createHash('sha256').update(legacy.trim()).digest('hex'):null;

export function measureRefusals(lines,{sinceMs=0,untilMs=Infinity,storedIds=new Set()}={}){
  const requestGroups=new Map(),objectiveGroups=new Map(),byCode={},legacyGuesses={},latencies=[];
  let refusalEvents=0,dryRuns=0,deferred=0,transportEvents=0,transportOrUnknown=0,missingIntentBinding=0,missingTimestamp=0,overflowReasons=0,overflowBytes=0,policyDenialEvents=0,preventableEvents=0;
  for(const line of lines){let e;try{e=JSON.parse(line);}catch{continue;}const at=Date.parse(e.at);if(!Number.isFinite(at)){if(['submit_dry_run','submit_rejected','submit_deferred'].includes(e.kind))missingTimestamp++;continue;}if(at<sinceMs||at>=untilMs)continue;
    if(e.kind==='submit_dry_run'){dryRuns++;continue;}
    if(!['submit_rejected','submit_deferred'].includes(e.kind))continue;
    if(e.status===503){transportEvents++;continue;}
    refusalEvents++;if(e.kind==='submit_deferred'||e.verdict==='defer')deferred++;
    const explicit=Array.isArray(e.reason_codes)?e.reason_codes:null;
    const guessed=explicit??reasonsFromError(new Error(e.reason??'')).map(r=>r.code);
    if(!explicit)for(const code of guessed)legacyGuesses[code]=(legacyGuesses[code]??0)+1;
    const codes=[...new Set(guessed)];
    for(const code of codes)byCode[code]=(byCode[code]??0)+1;
    if(explicit&&codes.some(c=>policyDenialCodes.has(c)))policyDenialEvents++;
    if(codes.length&&codes.every(c=>preventableCodes.has(c)))preventableEvents++;
    if(!codes.length||codes.some(c=>c==='refused'||c==='unknown'))transportOrUnknown++;
    if(codes.some(c=>['brief_too_large','instructions_too_large','expected_output_too_large'].includes(c))) {
      overflowReasons++;
      if(e.bytes?.after_expansion&&e.bytes?.over_by&&Object.values(e.bytes.over_by).some(n=>Number(n)>0)) overflowBytes++;
    }
    if(Number.isFinite(e.attempt_latency_ms)&&e.attempt_latency_ms>=0)latencies.push(e.attempt_latency_ms);
    const requestId=typeof e.request_id==='string'?e.request_id:null;
    if(requestId){const group=requestGroups.get(requestId)??{events:0,preventable:0};group.events++;if(codes.length&&codes.every(c=>preventableCodes.has(c)))group.preventable++;requestGroups.set(requestId,group);}
    const objective=labelDigest(e.objective_key_sha256,e.objective_key),revision=labelDigest(e.revision_sha256,e.revision);
    const key=objective&&revision&&e.task_kind?`${e.task_kind}\0${objective}\0${revision}`:null;
    if(key){const group=objectiveGroups.get(key)??{events:0,preventable:0,sources:new Set()};group.events++;if(codes.length&&codes.every(c=>preventableCodes.has(c)))group.preventable++;if(typeof e.source==='string')group.sources.add(e.source);objectiveGroups.set(key,group);}
    if(!key)missingIntentBinding++;
  }
  const requests=[...requestGroups.values()],objectives=[...objectiveGroups.values()];
  return {window:{since:new Date(sinceMs).toISOString(),until:Number.isFinite(untilMs)?new Date(untilMs).toISOString():null,boundary:'since inclusive; until exclusive',cohort:'submit event time'},missing_timestamp_events:missingTimestamp,
    refusal_events:refusalEvents,request_id_retry_groups:requests.length,request_id_proxy_preventable_groups:requests.filter(g=>g.preventable>0).length,request_id_proxy_preventable_events:preventableEvents,
    deduplicated_intent_denominator:{value:null,status:'unknown',missing_binding_events:refusalEvents,reason:'no authenticated binding establishes that separate requests share one user intent; source and producer labels are not identity'},
    declared_objective_cohorts:{groups:objectives.length,preventable_groups:objectives.filter(g=>g.preventable>0).length,preventable_events:objectives.reduce((n,g)=>n+g.preventable,0),missing_objective_tuple_events:missingIntentBinding,source_labels_are_not_identity:true},
    preventable_refusal_events:preventableEvents,explicit_typed_policy_denial_events:policyDenialEvents,deferred_events:deferred,transport_events:transportEvents,unknown_or_unmapped_events:transportOrUnknown,
    post_expansion_overflow:{reasons:overflowReasons,events_with_expanded_byte_counts:overflowBytes,events_missing_expanded_byte_counts:overflowReasons-overflowBytes,source:'request-log byte fields; observed bridge rejections only',coverage:'incomplete; zero unobserved provider overflows is not a guarantee'},dry_run_events:dryRuns,
    per_attempt_submit_response_latency_ms:{samples:latencies.length,missing:refusalEvents-latencies.length,p50:percentile(latencies,.5),p90:percentile(latencies,.9),definition:'server request arrival to submit response for each attempt; not first actionable response'},owner_read_latency_ms:{value:null,status:'unknown',reason:'request logs do not bind this response to an owner read'},intent_latency_ms:{value:null,status:'unknown'},
    request_id_proxy_later_stored:[...requestGroups.keys()].filter(id=>storedIds.has(id)).length,by_code:byCode,legacy_keyword_guesses:legacyGuesses};
}

export function measureTerminalFacts(db,sinceMs=0,untilMs=Date.now()){
  const exists=name=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if(!exists('assignments'))return {total:0,expired:0,owner_cancelled:0,lease_expired_operational_events:0,worker_reported_noncompleted:0,unknown_other:0,source:'no assignments table'};
  const since=new Date(sinceMs).toISOString(),until=new Date(untilMs).toISOString();
  const cancelled=db.prepare(`SELECT a.request_id,a.cancelled_reason,
    (SELECT e.actor FROM lifecycle_events e WHERE e.request_id=a.request_id AND e.type='cancelled' ORDER BY e.id DESC LIMIT 1) cancel_actor,
    EXISTS(SELECT 1 FROM lifecycle_events e WHERE e.request_id=a.request_id AND e.type='cancelled' AND e.actor='system' AND e.reason='expired' AND e.at>=? AND e.at<?) system_expiry
    FROM assignments a WHERE a.status='cancelled' AND a.cancelled_at>=? AND a.cancelled_at<?`).all(since,until,since,until);
  const reports=exists('reports')?db.prepare(`SELECT r.outcome,r.summary,r.result FROM reports r JOIN assignments a USING(request_id)
    WHERE a.status!='cancelled' AND r.outcome IS NOT NULL AND r.outcome!='completed' AND r.created_at>=? AND r.created_at<?`).all(since,until):[];
  let expired=0,owner=0,worker=0,workerUnknown=0,unknown=0;const workerTypes={};
  for(const r of cancelled){if(r.cancelled_reason==='expired'&&r.cancel_actor==='system'&&r.system_expiry)expired++;
    else if(r.cancel_actor==='owner')owner++;else unknown++;}
  for(const r of reports){const inferred=inferWorkerReport(r);worker++;workerTypes[inferred?.type??'unknown']=(workerTypes[inferred?.type??'unknown']??0)+1;if(!inferred||['unknown','worker_blocked'].includes(inferred.type))workerUnknown++;}
  const total=cancelled.length+reports.length;
  const leaseRows=db.prepare("SELECT count(*) n FROM lifecycle_events WHERE type='abandoned' AND actor='system' AND reason LIKE 'lease_expired%' AND at>=? AND at<?").get(since,until);
  return {window:{since,until:Number.isFinite(untilMs)?until:null,boundary:'since inclusive; until exclusive'},denominator:'terminal failures by terminal event time',total,expired,owner_cancelled:owner,lease_expired_operational_events:leaseRows.n,worker_reported_noncompleted:worker,worker_reported_types:workerTypes,unknown_other:unknown+workerUnknown,
    expired_share:pct(expired,total),expired_or_owner_cancelled_share:pct(expired+owner,total),unknown_other_share:pct(unknown+workerUnknown,total),
    provenance:{expired:'system cancelled lifecycle event with reason expired and terminal event inside window',owner_cancelled:'owner cancelled lifecycle event',lease_expired_operational_events:'bridge-observed lease expiry events; not terminal failures or proof of vendor silent drop',worker_reported_noncompleted:'worker report outcome; text categories are inference, not cause'} };
}
export function buildReport({lines,db,sinceMs,untilMs=Date.now(),storedIds=new Set()}){return {refusals:measureRefusals(lines,{sinceMs,untilMs,storedIds}),terminal_failures:measureTerminalFacts(db,sinceMs,untilMs),units:{terminal_shares:'percent (0..100)',response_latency:'milliseconds'},denominators:{deduplicated_intent:'unknown',declared_objective_cohorts:'request metadata proxy only',request_id:'retry-group proxy only; not intent',missingness:'reported separately'},notes:['No uplift claim before a deployment cohort.','Legacy reason strings are keyword guesses and are reported separately from explicit typed denials.','Defer, unknown and transport outcomes are not counted as correct policy denials.','No accept-click, productivity or owner-use credit is calculated.','Terminal outcomes use terminal event time; admission refusals use submit-event time.','Provider overflows that are absent from bridge request logs are unobserved.']};}

if(process.argv[1]&&path.resolve(process.argv[1])===new URL(import.meta.url).pathname){
  const args=process.argv.slice(2),option=n=>{const i=args.indexOf(n);return i>=0?args[i+1]:null;};
  const since=option('--since')??new Date(Date.now()-7*86400000).toISOString(),until=option('--until')??new Date().toISOString(),sinceMs=Date.parse(since),untilMs=Date.parse(until);if(!Number.isFinite(sinceMs)||!Number.isFinite(untilMs)||untilMs<=sinceMs)throw new Error('--since and --until require ordered RFC 3339 times');
  const dbFile=option('--db')??defaultPath(os.homedir(),'.local/share/dot-bridge/bridge.db'),logFile=option('--log')??defaultPath(os.homedir(),'.local/state/dot-bridge/requests.jsonl');
  const db=new DatabaseSync(dbFile,{readOnly:true});
  try {
    const stored=new Set(db.prepare('SELECT request_id FROM assignments WHERE created_at>=? AND created_at<?').all(new Date(sinceMs).toISOString(),new Date(untilMs).toISOString()).map(r=>r.request_id));
    const logAvailable=fs.existsSync(logFile);
    const report=buildReport({lines:readLines(logFile,{missingOk:true}),db,sinceMs,untilMs,storedIds:stored});
    if(!logAvailable) { report.refusals=null; report.notes.push('Request log is missing; admission metrics are unknown, not zero.'); }
    const source={db:dbFile,request_log:logFile,request_log_state:logAvailable?'available':'missing',coverage:'retained entries only; full-window completeness is not established'};
    console.log(JSON.stringify({since:new Date(sinceMs).toISOString(),until:new Date(untilMs).toISOString(),source,report},null,2));
  } finally { db.close(); }
}
