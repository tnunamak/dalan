import { defaultPath } from './paths.mjs';
import { readEnv } from './env.mjs';
import { validateOwnerNote } from './submission-policy.mjs';
import { redactOutput } from './redaction.mjs';
import { statusEvidence } from './status-evidence.mjs';
import { assertPreflight } from './pr-preflight.mjs';
import { lifecycleSchema, backfillLifecycle, progressType } from './lifecycle.mjs';
import { objectiveSources, metaFields, normalizeMeta, toStoredSource, fromStoredSource, canonicalMetaValue, canonicalKindSql, canonicalKindLabel, storedObjectiveKey, storedTaskKind, verifyObjective } from './objectives.mjs';
import { legacyFixLoopName } from './legacy-names.mjs';
import { LEGACY_PROFILE, canSee, resolveWorker, destinationDisclosure, destinationDifferences, destinationError, connectionsDigest } from './workers.mjs';
import { TRUST } from './execution.mjs';
import { inferWorkerReport, observeTransition } from './failure-type.mjs';
import { DatabaseSync } from 'node:sqlite';
import { acquireSubscriptionStorage, SubscriptionCodec } from './subscription-storage.mjs';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import {migrateClaimCommands,createClaimCommands} from './claim-command-ledger.mjs';
import {migrateArtifactJournal} from './artifact-journal.mjs';
import {migrateResultBindings} from './result-binding.mjs';
import {migrateJobRetention} from './job-retention.mjs';
import {migrateProtocolOwnerWaiters,materializeProtocolWaiters} from './protocol-owner-waiters.mjs';
import {finishProtocol} from './protocol-finish.mjs';
import {answerProtocolQuestion,cancelProtocolJob} from './protocol-owner-mutations.mjs';
import {defineProtocolRetentionInTransaction,assertProtocolAvailable as checkProtocolAvailable} from './protocol-retention.mjs';
import {migrateProtocolDelivery} from './protocol-delivery-driver.mjs';
import {migrateProtocolStopObserver} from './protocol-stop-observer.mjs';

// A reserved HTTP response is a live effect channel. Persist its owner so a
// second process cannot reset a reservation whose callback can still respond.
function waiterProcessIdentity(pid=process.pid) {
  const identity={pid};
  if(process.platform==='linux') try {
    identity.boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
    identity.namespace=fs.readlinkSync(`/proc/${pid}/ns/pid`);
    const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');
    identity.start=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];
  } catch {}
  return identity;
}
function waiterOwnerGone(attemptId) {
  if(typeof attemptId!=='string'||!attemptId.startsWith('wait:')) return false;
  let owner;try{owner=JSON.parse(attemptId.slice(5));}catch{return false;}
  if(!Number.isSafeInteger(owner.pid)||owner.pid<1) return false;
  const local=waiterProcessIdentity();
  if(owner.boot&&local.boot&&owner.boot!==local.boot) return true;
  if(process.platform==='linux'&&(!owner.namespace||owner.namespace!==local.namespace)) return false;
  try{process.kill(owner.pid,0);}catch(error){return error.code==='ESRCH';}
  const current=waiterProcessIdentity(owner.pid);
  return !!(owner.boot&&owner.start&&current.boot&&current.start&&(owner.boot!==current.boot||owner.start!==current.start));
}

const SUPPORTED_SCHEMA_VERSION = 65;
const monotonicMs=()=>Number(process.hrtime.bigint())/1e6;
function systemBootId() {
  if(process.platform!=='linux') return null;
  try { const id=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(); return id||null; }
  catch { return null; }
}
const protocolError=code=>{throw Object.assign(new Error(code),{code});};
const protocolNat=value=>Number.isSafeInteger(value)&&value>=0;
export function validateProtocol(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||
    Object.keys(value).sort().join(',')!=='destination,policy,profile,retain_until_ms,scope,source'||
    value.profile!=='job-v0'||!['source','scope','policy','destination'].every(k=>typeof value[k]==='string'&&value[k].trim().length>0)||
    !protocolNat(value.retain_until_ms))protocolError('invalid_protocol');
  return value;
}

const questionError=(code,message)=>Object.assign(new Error(`${code}: ${message}`),{code});
function validateQuestion(questionId,text) {
  if(typeof questionId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(questionId)) throw new Error('invalid question_id');
  if(arguments.length>1&&(typeof text!=='string'||!text.trim()||Buffer.byteLength(text)>4096)) throw new Error('question text must be 1-4096 UTF-8 bytes');
}

function unsupportedSchemaVersion(found) {
  return new Error(`database schema version ${found} is newer than supported version ${SUPPORTED_SCHEMA_VERSION}; use matching or newer Dalan code, or restore a consistent compatible backup. Do not reset user_version.`);
}

// Owner decisions on a finished result, in the words the CLI takes. 'stale' is only ever written by the sweep.
export const decisionTypes=['accepted','applied','useful_no_change','useful_negative','not_useful','stale'];
export const MAX_INTEGRATION_PATCH_BYTES=262144;
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
// Only successful live claim/progress receipts may use this guidance. request_action is about this
// request; next_action stays the queued-work hint from nextQueued.
export function nonterminalOutcome(id,receipt) {
  const next=receipt.blocker_forwarded
    ? `Request ${id} remains open. Resolve the blocker within scope or call finish with outcome blocked; progress is not finish.`
    : `Keep working on request ${id}. Send progress about every minute. Call finish when done; progress is not finish.`;
  return {...receipt,terminal:false,request_action:next};
}
const stamp = () => new Date().toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');
function validateSubmitKey(key) {
  if(key!==null&&(typeof key!=='string'||key.length<1||key.length>128)) throw new Error('invalid command_key: use a nonempty string of at most 128 characters');
}
// Admission controls (queue caps, preflights) may change; the accepted job's intent cannot.
// Intent digests are persisted, so they hash the stored spelling of the source, objective key and task kind: a retry hashes the same before and after the rename.
const storedMeta=(meta,legacy)=>({...meta,objective_key:storedObjectiveKey(meta.objective_key,legacy),task_kind:storedTaskKind(meta.task_kind,legacy),source:toStoredSource(meta.source,legacy)});
function submitIntentDigest(identity,delivery,environmentId,review,priority,meta,targetWorker,execution,requiredCapabilities,destinationRevision=null,legacyFixNames=true) {
  return hash(JSON.stringify(canonical({payload:identity,delivery,environmentId:environmentId??'',review:!!review,priority,meta:storedMeta(normalizeMeta(meta),legacyFixNames),targetWorker,execution,requiredCapabilities,...(destinationRevision===null?{}:{destination_revision:destinationRevision})})));
}
const defaultRedeliveryLimits={intervalMs:600000,maxCount:3,silenceMs:1200000,leaseMs:3600000,laneCapacity:6,rewakeMs:90000,rewakeWindowMs:7200000,rewakeStaleMs:1200000,breakSilenceMs:1200000,breakProbeMs:1800000,maxClaimsPerHour:90,maxToolCallsPerHour:1000,maxToolCallsPer24h:10000,maxResponseBytesPerHour:8000000,maxResponseBytesPer24h:100000000};
const HOUR=3600000, iso=ms=>new Date(ms).toISOString();
export const QUEUE_WINDOW=Object.freeze({minSamples:5,factor:3,minMs:15*60000,maxMs:12*HOUR});
const queueKindSql=canonicalKindSql("COALESCE(a.task_kind,json_extract(a.payload,'$.task_kind'),CASE WHEN a.review=1 THEN 'review' ELSE json_extract(a.payload,'$.execution_scope') END,'unknown')");
export const breakNoticeText=ids=>`the worker is on a usage break; do this yourself with a cheap model if it is urgent, or leave it queued (requests: ${ids.slice(0,20).join(', ')}${ids.length>20?` and ${ids.length-20} more`:''})`;
// When a queued row most recently entered the queue: its latest lifecycle 'queued' event, or created_at if retention removed it.
const queuedAt="COALESCE((SELECT max(l.at) FROM lifecycle_events l WHERE l.request_id=a.request_id AND l.type='queued'),a.created_at)";
// The pause is temporary: a worker that gave up after this error never claimed again, so the message says to come back.
export const pausedClaimMessage='bridge paused (temporary): new claims are refused until the operator resumes. Keep working on jobs you already hold, then call list_pending and claim again later; claims are accepted as soon as the pause ends.';
// Priority orders list_pending and re-wake; it never hides or refuses work. Within a priority, an item the worker passed over
// (skipped_at) goes behind the others, then oldest first.
const LIST_ORDER="CASE priority WHEN 'normal' THEN 0 ELSE 1 END,skipped_at IS NOT NULL,created_at";
// An item is marked skipped_by_worker when the worker passes it over, by either of two signals:
//  - passed over: the worker claimed an assignment listed after it, SKIP_AFTER_PASSED times, while it had listed this one within
//    PASSED_SEEN_MS. This detects items repeatedly pushed behind newer work before they enter the claimable window.
//  - eligible: it sat in the first free_lanes entries (the ones the worker could claim) at a poll SKIP_AFTER_ELIGIBLE_MS after
//    the first such poll, and was not claimed. A poll that shows no free lane forgets this clock: waiting for a lane is not a skip.
const SKIP_AFTER_PASSED=3, PASSED_SEEN_MS=180000, SKIP_AFTER_ELIGIBLE_MS=600000, LISTED_POLL_GAP_MS=30000;
// Preparation expiry uses one predicate for every queued count, list, gate and sweep.
// Learned windows end at first claim; claims rows survive abandonment and requeue.
export const validUntilOf=payload=>{const ms=typeof payload?.valid_until==='string'?Date.parse(payload.valid_until):NaN;return Number.isFinite(ms)?iso(ms):null;};
const expired=nowMs=>`(valid_until IS NOT NULL AND valid_until<='${iso(nowMs)}' AND NOT (COALESCE(valid_until_source,'')='queue_p90' AND request_id IN (SELECT request_id FROM claims)))`;
const live=nowMs=>`NOT ${expired(nowMs)} AND (request_id NOT IN (SELECT request_id FROM protocol_jobs) OR request_id IN (
  SELECT p.request_id FROM protocol_jobs p JOIN job_retention_policy r ON r.job=p.request_id
  WHERE CAST(json_extract(p.settings,'$.retain_until_ms') AS INTEGER)>'${nowMs}'
    AND NOT EXISTS (SELECT 1 FROM job_retention_tombstones t WHERE t.job=p.request_id)
))`;
export const expiredError=(validUntil,{cancelled=false,requeue=false}={})=>`assignment_expired: its prepared inputs were valid until ${validUntil}; ${cancelled?'the bridge cancelled it and will not requeue it':requeue?'the bridge has not cancelled it; the expiry sweep will evaluate whether it can requeue it':'the bridge has not cancelled it yet and will not requeue it'}. Call list_pending, then claim another listed assignment.`;
const denialPattern=/auto-?review|guardian|denied|not approved|paused out of precaution/i;
export const workerGuidance='If auto-review or Guardian denies an action, stop that line of work, report BLOCKED: with the denied action, and never retry or rephrase to get around it. A denial or error about one assignment does not affect another: an error naming a different request_id (for example a finished assignment) is not a revocation of this one. An assignment with a new request_id that the owner submitted is a separate, fresh owner request, made after the owner saw the earlier outcome; it is not a retry of a denied action, so judge it on its own merits. If finish answers assignment_cancelled, the owner withdrew that request: this is not a denial and nothing to work around or retry; stop work on it and move on. Read the response to see whether bounded audit evidence was retained; output after the lease deadline is dropped. Check owner_notes on this assignment with get before finishing. Reading UI source that renders or validates a credential input field is ordinary UI work; the restriction is on revealing, copying, changing or transmitting actual secret values.';
export const matchesDenial=text=>denialPattern.test(text);
// Evidence that the worker cannot take work: its note says the reviewer denied a claim. The worker never retries a denied line, so
// re-waking that request is noise; a capacity-overrun denial means the worker is full, so no re-wake helps until a slot frees.
const capacityHoldMaxMs=30*60000;
const claimDenial=/\b(?:denied|rejected|refused|not approved)\b/i;

export function loadRedeliveryLimits(file=defaultPath(os.homedir(),'.config/dot-bridge/limits.json')) {
  if(!fs.existsSync(file)) return {...defaultRedeliveryLimits};
  if((fs.statSync(file).mode&0o777)!==0o600) throw new Error('limits policy must be mode 0600');
  const value=JSON.parse(fs.readFileSync(file,'utf8'));
  // Legacy keys, still validated so existing files load. Neither drives re-wake any more: the interval only sets the
  // alive_not_claiming status threshold (2x interval); max_count is ignored.
  const intervalMs=value.assignment_reannounce_interval_ms??defaultRedeliveryLimits.intervalMs;
  const maxCount=value.assignment_reannounce_max_count??defaultRedeliveryLimits.maxCount;
  if(!Number.isInteger(intervalMs)||intervalMs<60000||intervalMs>86400000) throw new Error('invalid assignment_reannounce_interval_ms');
  if(!Number.isInteger(maxCount)||maxCount<0||maxCount>10) throw new Error('invalid assignment_reannounce_max_count');
  const silenceMs=value.pause_suspected_silence_ms??defaultRedeliveryLimits.silenceMs;
  // A claim lease expires at last claim activity + leaseMs. stale_claim_ms is the legacy name, read only when claim_lease_ms is absent.
  const leaseKey=value.claim_lease_ms!=null?'claim_lease_ms':value.stale_claim_ms!=null?'stale_claim_ms':null;
  const leaseMs=leaseKey?value[leaseKey]:defaultRedeliveryLimits.leaseMs;
  if(!Number.isInteger(silenceMs)||silenceMs<60000||silenceMs>86400000) throw new Error('invalid pause_suspected_silence_ms');
  if(!Number.isInteger(leaseMs)||leaseMs<60000||leaseMs>604800000) throw new Error(`invalid ${leaseKey}`);
  // Denominator of utilization metrics: how many lanes the worker can work in parallel. Independent of the claim cap (max_claimed_outer_assignments).
  // worker_* limits keys are the current names; the dot_* names are read as aliases so existing files keep working.
  const laneCapacity=value.worker_lane_capacity??value.dot_lane_capacity??defaultRedeliveryLimits.laneCapacity;
  if(!Number.isInteger(laneCapacity)||laneCapacity<1||laneCapacity>10) throw new Error('invalid worker_lane_capacity');
  // Queue re-wake: minimum gap between wakes of one subscription, and how long after entering the queue an item is re-woken.
  const rewakeMs=value.queue_rewake_ms??defaultRedeliveryLimits.rewakeMs;
  if(!Number.isInteger(rewakeMs)||rewakeMs<30000||rewakeMs>3600000) throw new Error('invalid queue_rewake_ms');
  const rewakeWindowMs=value.queue_rewake_window_ms??defaultRedeliveryLimits.rewakeWindowMs;
  if(!Number.isInteger(rewakeWindowMs)||rewakeWindowMs<600000||rewakeWindowMs>86400000) throw new Error('invalid queue_rewake_window_ms');
  const rewakeStaleMs=value.queue_rewake_stale_ms??defaultRedeliveryLimits.rewakeStaleMs;
  if(!Number.isInteger(rewakeStaleMs)||rewakeStaleMs<300000||rewakeStaleMs>86400000) throw new Error('invalid queue_rewake_stale_ms');
  // Usage break: silence that infers a break, and the gap between probe wakes during one.
  const breakSilenceMs=value.worker_break_silence_ms??value.dot_break_silence_ms??defaultRedeliveryLimits.breakSilenceMs;
  if(!Number.isInteger(breakSilenceMs)||breakSilenceMs<60000||breakSilenceMs>86400000) throw new Error('invalid worker_break_silence_ms');
  const breakProbeMs=value.worker_break_probe_ms??value.dot_break_probe_ms??defaultRedeliveryLimits.breakProbeMs;
  if(!Number.isInteger(breakProbeMs)||breakProbeMs<60000||breakProbeMs>86400000) throw new Error('invalid worker_break_probe_ms');
  // Throttle: rolling-hour ceilings for drainer submits and re-wakes. The worker's own claim calls are never refused.
  const maxClaimsPerHour=value.max_claims_per_hour??defaultRedeliveryLimits.maxClaimsPerHour;
  if(!Number.isInteger(maxClaimsPerHour)||maxClaimsPerHour<1||maxClaimsPerHour>1000) throw new Error('invalid max_claims_per_hour');
  // Budget tool calls over rolling daily and hourly windows to limit bursts.
  const maxToolCallsPerHour=value.max_tool_calls_per_hour??defaultRedeliveryLimits.maxToolCallsPerHour;
  if(!Number.isInteger(maxToolCallsPerHour)||maxToolCallsPerHour<1||maxToolCallsPerHour>100000) throw new Error('invalid max_tool_calls_per_hour');
  const maxToolCallsPer24h=value.max_tool_calls_per_24h??defaultRedeliveryLimits.maxToolCallsPer24h;
  if(!Number.isInteger(maxToolCallsPer24h)||maxToolCallsPer24h<10||maxToolCallsPer24h>10000000) throw new Error('invalid max_tool_calls_per_24h');
  // Rolling-hour ceiling on the bytes of MCP responses to the worker's tool calls (a usage break likely meters tokens).
  // Use a rolling 24 h byte budget and an hourly burst ceiling. The rolling budget limits sustained response volume;
  // the hourly ceiling limits a short burst.
  const maxResponseBytesPerHour=value.max_response_bytes_per_hour??defaultRedeliveryLimits.maxResponseBytesPerHour;
  if(!Number.isInteger(maxResponseBytesPerHour)||maxResponseBytesPerHour<100000||maxResponseBytesPerHour>1000000000) throw new Error('invalid max_response_bytes_per_hour');
  const maxResponseBytesPer24h=value.max_response_bytes_per_24h??defaultRedeliveryLimits.maxResponseBytesPer24h;
  if(!Number.isInteger(maxResponseBytesPer24h)||maxResponseBytesPer24h<1000000||maxResponseBytesPer24h>10000000000) throw new Error('invalid max_response_bytes_per_24h');
  return {intervalMs,maxCount,silenceMs,leaseMs,laneCapacity,rewakeMs,rewakeWindowMs,rewakeStaleMs,breakSilenceMs,breakProbeMs,maxClaimsPerHour,maxToolCallsPerHour,maxToolCallsPer24h,maxResponseBytesPer24h,maxResponseBytesPerHour};
}

// Gates that cap one rolling hour. They hold background work before agent-requested work (see rollingUsage).
// A learned limit never cuts below this share of the configured one. This prevents a quiet period from reducing the limit
// below a useful fraction of the operator's configured value.
export const learnedFloorFraction=0.25;

// Configured resume workers and the legacy worker receive acquisition guidance. This does not enable idle rotation.
const defaultResumeIdleMs=120000;
// With a trusted OS clock across restarts, thirty minutes allows passive recovery but bounds the delivery hold.
export const UNCERTAIN_DELIVERY_MAX_AGE_MS=30*60_000;
export function resumeNudge(threshold=defaultResumeIdleMs) {
  const seconds=Math.max(30,Math.floor(threshold/2/30000)*30);
  const interval=seconds%60===0?`${seconds/60} minute${seconds===60?'':'s'}`:`${seconds} seconds`;
  return `Generate one random acquisition_id per run and pass it on every claim call, including retries. Keep that acquisition_id, claimant and returned claim_id in your own saved run state across QUESTION/answer pauses and reconnects: an answered question continues the same acquisition. A separate run must use its own acquisition_id; do not copy another run's grant from get. Post progress at least every ${interval} with what is done and what remains, so a resumed run can continue; if your run may end, post progress first.`;
}

function databasePath(file) {
  try {
    if(file instanceof URL) {
      const url=new URL(file);
      if(url.protocol!=='file:'||url.host) return null;
      url.search=''; url.hash='';
      return fileURLToPath(url);
    }
    if(typeof file!=='string'||file===':memory:') return null;
    if(file.startsWith('file:')) {
      const url=new URL(file);
      if(url.protocol!=='file:'||url.host) return null;
      url.search=''; url.hash='';
      return fileURLToPath(url);
    }
    return path.resolve(file);
  } catch { return null; }
}

// Resolve through the nearest existing ancestor before SQLite creates the filename.
function databaseLocation(file) {
  let existing=path.resolve(file);const missing=[];
  for(;;) {
    try { return path.join(fs.realpathSync(existing),...missing); }
    catch(error) {
      if(error.code!=='ENOENT'&&error.code!=='ENOTDIR') throw error;
      const parent=path.dirname(existing);if(parent===existing) throw error;
      missing.unshift(path.basename(existing));existing=parent;
    }
  }
}

function isDefaultHomeDatabase(file) {
  const requested=databasePath(file);
  if(!requested) return false;
  const homes=new Set([os.homedir()]);
  try { homes.add(os.userInfo().homedir); } catch {}
  const defaults=[];
  for(const home of homes) for(const name of ['dot-bridge','dalan']) defaults.push(path.join(home,'.local/share',name,'bridge.db'));
  for(const target of defaults) {
    if(path.resolve(requested)===path.resolve(target)) return true;
    // Canonical paths catch symlinks; device/inode also catches hard links.
    try {
      const canonicalTarget=databaseLocation(target);
      const canonicalRequested=databaseLocation(requested);
      if(canonicalRequested===canonicalTarget) return true;
      const targetStat=fs.statSync(target),requestedStat=fs.statSync(requested);
      if(targetStat.dev===requestedStat.dev&&targetStat.ino===requestedStat.ino) return true;
    } catch {}
  }
  return false;
}

function refuseDefaultHomeMigration(file, authorized) {
  // This prevents accidental imports/tools from migrating the service DB; it cannot constrain same-UID code.
  if(authorized||!isDefaultHomeDatabase(file)) return;
  const filename=databasePath(file);
  if(!filename) return;
  let exists;
  try { exists=fs.statSync(filename).isFile(); }
  catch(error) { if(error.code!=='ENOENT') throw error; }
  let version=0,db;
  try {
    if(exists) {
      db=new DatabaseSync(file,{readOnly:true});
      version=db.prepare('PRAGMA user_version').get().user_version;
    }
  } finally { db?.close(); }
  if(version<SUPPORTED_SCHEMA_VERSION) {
    throw new Error(`refusing to migrate default-home Dalan database at ${file} (schema ${version} < ${SUPPORTED_SCHEMA_VERSION}); service startup must pass allowDefaultHomeMigration: true. This is an accidental-migration guard, not a security boundary against same-UID code.`);
  }
}

export class Store {
  constructor(file, options={}) {
    this.resumeIdleOption=options.resumeIdleMs;
    this.workers=options.workers??LEGACY_PROFILE;
    this.destinationProfile=options.destinationProfile??null;
    // Server-side diagnostic only: receives the raw configuration error that destinationConfigurationError hides from callers.
    this.onConfigError=options.onConfigError??null;
    this.allowedDotSubjects=options.allowedDotSubjects??null;
    const wallNow=options.now??Date.now;
    this.monotonicNow=options.elapsedNow??monotonicMs;
    this.leaseBootId=options.bootId??(options.now?null:systemBootId());
    if(options.elapsedNow) {
      const epoch=wallNow(),elapsed=options.elapsedNow();
      this.nowMs=()=>Math.floor(epoch+options.elapsedNow()-elapsed);
    } else if(options.now) this.nowMs=options.now;
    else {
      const epoch=Date.now(),elapsed=process.hrtime.bigint();
      this.nowMs=()=>Math.floor(epoch+Number(process.hrtime.bigint()-elapsed)/1e6);
    }
    this.capacity=options.capacity??6;
    this.backgroundMaxInFlight=options.backgroundMaxInFlight??4;
    this.limits=options.limits??{...defaultRedeliveryLimits};
    this.skipExpireMs=options.skipExpireMs??6*3600000;
    this.connectionIsLive=options.connectionIsLive??null;
    this.stamp=()=>new Date(this.nowMs()).toISOString();
    this.startedMs=this.nowMs();
    refuseDefaultHomeMigration(file,options.allowDefaultHomeMigration===true);
    this.db = new DatabaseSync(file);
    let storage;
    try {
      this.db.exec('PRAGMA busy_timeout=30000');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > SUPPORTED_SCHEMA_VERSION) throw unsupportedSchemaVersion(version);
      storage = acquireSubscriptionStorage(file);
      const current = this.db.prepare('PRAGMA user_version').get().user_version;
      if (current > SUPPORTED_SCHEMA_VERSION) throw unsupportedSchemaVersion(current);
      const hasStorage = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='subscription_storage_meta'").get();
      this.subscriptionCodec = new SubscriptionCodec(storage.key ?? storage.loadKey(current >= 52 || hasStorage));
      this.db.exec(`PRAGMA secure_delete=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS assignments (request_id TEXT PRIMARY KEY, payload TEXT NOT NULL, payload_hash TEXT NOT NULL, thread_id TEXT NOT NULL, environment_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', created_at TEXT NOT NULL, cancelled_at TEXT);
        CREATE TABLE IF NOT EXISTS claims (request_id TEXT PRIMARY KEY REFERENCES assignments(request_id), claimant TEXT NOT NULL, claim_id TEXT NOT NULL UNIQUE, claimed_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS progress (id INTEGER PRIMARY KEY, request_id TEXT NOT NULL REFERENCES assignments(request_id), note TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reports (request_id TEXT PRIMARY KEY REFERENCES assignments(request_id), claim_id TEXT NOT NULL, outcome TEXT NOT NULL, summary TEXT NOT NULL, result TEXT NOT NULL, receipt_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, late INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, principal TEXT NOT NULL, url TEXT NOT NULL, args TEXT NOT NULL, secret TEXT NOT NULL, expires_at TEXT NOT NULL, verified_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, kind TEXT NOT NULL, request_id TEXT NOT NULL REFERENCES assignments(request_id), subscription_id TEXT, body TEXT, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, last_error TEXT, argv TEXT, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages (message_id TEXT PRIMARY KEY, text TEXT NOT NULL, text_sha256 TEXT NOT NULL, preview TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, acknowledged_at TEXT);
        CREATE TABLE IF NOT EXISTS bridge_state (key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS notifications_due ON notifications(state,next_at);`);
      this.migrate();
      this.initializeLeaseClock();
      this.initializeSubscriptionStorage();
    } catch(error) { this.db.close(); throw error; } finally { storage?.release(); }
    if(options.markProfileModeSeen===true) this.markProfileModeSeen();
    if(options.deferSubscriptionRetirement!==true) this.retireUnknownSubscriptions();
  }
  // Join the caller's transaction (touch runs inside claim admission) or open one, so check and write share one snapshot.
  inTransaction(fn) { return this.db.isTransaction?fn():this.transaction(fn); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result=fn(); this.db.exec('COMMIT'); return result; } catch(error) { this.db.exec('ROLLBACK'); throw error; } }
  profileModeSeen() { return this.db.prepare("SELECT 1 FROM bridge_state WHERE key='workers_profile_seen'").get()!==undefined; }
  markProfileModeSeen() { this.db.prepare("INSERT INTO bridge_state(key,value) VALUES('workers_profile_seen','1') ON CONFLICT(key) DO NOTHING").run(); }
  // Record one lifecycle event; callers run it inside the transaction of the state change it describes.
  // claim defaults to the claim in force (the active row); an explicit claim_id without epoch resolves its epoch from history.
  lifecycle(id,type,actor='system',reason=null,claim=this.db.prepare("SELECT claim_id,epoch FROM claims WHERE request_id=? AND state='active'").get(id)) {
    const epoch=claim?.claim_id&&claim.epoch==null?this.db.prepare('SELECT epoch FROM claims WHERE claim_id=?').get(claim.claim_id)?.epoch??this.db.prepare('SELECT epoch FROM lifecycle_events WHERE claim_id=? AND epoch IS NOT NULL LIMIT 1').get(claim.claim_id)?.epoch??null:claim?.epoch??null;
    const worker=claim?.worker??(claim?.claim_id?this.db.prepare('SELECT worker FROM claims WHERE claim_id=?').get(claim.claim_id)?.worker??this.db.prepare('SELECT worker FROM lifecycle_events WHERE claim_id=? LIMIT 1').get(claim.claim_id)?.worker:null)??'unknown';
    this.db.prepare("INSERT INTO lifecycle_events(request_id,claim_id,epoch,type,at,actor,source,reason,worker) VALUES(?,?,?,?,?,?,'live',?,?)").run(id,claim?.claim_id??null,epoch,type,this.stamp(),actor,reason,worker);
  }
  migrate() {
    this.transaction(() => {
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > SUPPORTED_SCHEMA_VERSION) throw unsupportedSchemaVersion(version);
      if(version>=35&&(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_migrations'").get()||!this.db.prepare("SELECT 1 FROM schema_migrations WHERE identity='s1v2-worker-facts-20261022'").get()))
        throw new Error('abandoned worker-isolation schema: missing s1v2-worker-facts-20261022; restore the pre-isolation backup');
      if (version < 2) {
        this.db.exec(`ALTER TABLE assignments ADD COLUMN owner_hash TEXT;
          ALTER TABLE subscriptions ADD COLUMN state TEXT NOT NULL DEFAULT 'active';
          ALTER TABLE subscriptions ADD COLUMN last_event_2xx_at TEXT;
          ALTER TABLE subscriptions ADD COLUMN auth_failures INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE subscriptions ADD COLUMN rotation_blocked INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE notifications ADD COLUMN attempt_started_at TEXT;
          ALTER TABLE notifications ADD COLUMN attempt_id TEXT;
          ALTER TABLE notifications ADD COLUMN last_reconciled_at TEXT;
          ALTER TABLE notifications ADD COLUMN uncertain_reason TEXT;
          CREATE TABLE watches (request_id TEXT PRIMARY KEY REFERENCES assignments(request_id), deadline TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL, notification_id TEXT);
          CREATE TABLE operator_state (id INTEGER PRIMARY KEY CHECK(id=1), paused_at TEXT, reason TEXT);
          INSERT INTO operator_state(id) VALUES(1);
          CREATE TABLE alert_episodes (condition TEXT PRIMARY KEY, active INTEGER NOT NULL, started_at TEXT, last_change_at TEXT NOT NULL);
          PRAGMA user_version=2;`);
      }
      if (version < 3) {
        this.db.exec(`CREATE TABLE IF NOT EXISTS workspaces (request_id TEXT PRIMARY KEY REFERENCES assignments(request_id), claim_id TEXT NOT NULL, base_sha TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS check_runs (id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES assignments(request_id), claim_id TEXT NOT NULL, check_id TEXT NOT NULL, exit_code INTEGER, timed_out INTEGER NOT NULL, output_artifact_id TEXT NOT NULL, output_sha256 TEXT NOT NULL, duration_ms INTEGER NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES assignments(request_id), claim_id TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, sha256 TEXT, sealed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
          ALTER TABLE claims ADD COLUMN subject TEXT NOT NULL DEFAULT 'local-principal';
          ALTER TABLE reports ADD COLUMN workspace_evidence TEXT;
          PRAGMA user_version=3;`);
      }
      if (version < 4) {
        this.db.exec(`ALTER TABLE artifacts ADD COLUMN retention_until TEXT;
          PRAGMA user_version=4;`);
      }
      if (version < 5) {
        this.db.exec(`ALTER TABLE check_runs ADD COLUMN diff_sha256 TEXT;
          PRAGMA user_version=5;`);
      }
      if (version < 6) {
        this.db.exec(`ALTER TABLE workspaces ADD COLUMN initial_patch_applied INTEGER NOT NULL DEFAULT 0;
          PRAGMA user_version=6;`);
      }
      if (version < 7) {
        this.db.exec(`CREATE TABLE IF NOT EXISTS assignment_reannouncements (request_id TEXT NOT NULL REFERENCES assignments(request_id), subscription_id TEXT NOT NULL REFERENCES subscriptions(id), count INTEGER NOT NULL DEFAULT 0, last_announced_at TEXT NOT NULL, PRIMARY KEY(request_id, subscription_id));
          PRAGMA user_version=7;`);
      }
      if (version < 8) {
        this.db.exec(`ALTER TABLE check_runs ADD COLUMN phase TEXT NOT NULL DEFAULT 'check';
          PRAGMA user_version=8;`);
      }
      if (version < 9) {
        this.db.exec(`CREATE TABLE IF NOT EXISTS messages (message_id TEXT PRIMARY KEY, text TEXT NOT NULL, text_sha256 TEXT NOT NULL, preview TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, acknowledged_at TEXT);
          CREATE INDEX IF NOT EXISTS messages_pending ON messages(status,created_at);
          PRAGMA user_version=9;`);
      }
      if (version < 10) {
        this.db.exec(`CREATE TABLE IF NOT EXISTS t3_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, call_id TEXT NOT NULL, subject TEXT NOT NULL, tool TEXT NOT NULL, args_summary TEXT NOT NULL, text_sha256 TEXT, text_preview TEXT, result_status TEXT NOT NULL, t3_ids TEXT NOT NULL DEFAULT '{}');
          CREATE INDEX IF NOT EXISTS t3_audit_at ON t3_audit(at);
          CREATE TRIGGER IF NOT EXISTS t3_audit_no_update BEFORE UPDATE ON t3_audit BEGIN SELECT RAISE(ABORT, 't3 audit is append-only'); END;
          CREATE TRIGGER IF NOT EXISTS t3_audit_no_delete BEFORE DELETE ON t3_audit BEGIN SELECT RAISE(ABORT, 't3 audit is append-only'); END;
          PRAGMA user_version=10;`);
      }
      if (version < 11) {
        this.db.exec(`CREATE TABLE notifications_new (id TEXT PRIMARY KEY, kind TEXT NOT NULL, request_id TEXT REFERENCES assignments(request_id), subscription_id TEXT, body TEXT, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, last_error TEXT, argv TEXT, created_at TEXT NOT NULL, attempt_started_at TEXT, attempt_id TEXT, last_reconciled_at TEXT, uncertain_reason TEXT, message_id TEXT REFERENCES messages(message_id));
          INSERT INTO notifications_new(id,kind,request_id,subscription_id,body,state,attempts,next_at,last_error,argv,created_at,attempt_started_at,attempt_id,last_reconciled_at,uncertain_reason)
            SELECT id,kind,request_id,subscription_id,body,state,attempts,next_at,last_error,argv,created_at,attempt_started_at,attempt_id,last_reconciled_at,uncertain_reason FROM notifications;
          DROP TABLE notifications;
          ALTER TABLE notifications_new RENAME TO notifications;
          CREATE INDEX notifications_due ON notifications(state,next_at);
          CREATE TABLE check_jobs (id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES assignments(request_id), claim_id TEXT NOT NULL, check_id TEXT NOT NULL, diff_sha256 TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, error TEXT, output_preview TEXT);
          CREATE INDEX check_jobs_request ON check_jobs(request_id,started_at);
          INSERT INTO check_jobs(id,request_id,claim_id,check_id,diff_sha256,status,started_at,finished_at)
            SELECT id,request_id,claim_id,check_id,COALESCE(diff_sha256,''),'completed',created_at,created_at FROM check_runs;
          PRAGMA user_version=11;`);
      }
      if (version < 12) {
        this.db.exec(`CREATE TABLE owner_notes (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, request_id TEXT NOT NULL REFERENCES assignments(request_id), at TEXT NOT NULL, text TEXT NOT NULL);
          CREATE INDEX owner_notes_request ON owner_notes(request_id,sequence);
          CREATE TRIGGER owner_notes_no_update BEFORE UPDATE ON owner_notes BEGIN SELECT RAISE(ABORT, 'owner notes are append-only'); END;
          CREATE TRIGGER owner_notes_no_delete BEFORE DELETE ON owner_notes BEGIN SELECT RAISE(ABORT, 'owner notes are append-only'); END;
          PRAGMA user_version=12;`);
      }
      if (version < 13) {
        this.db.exec(`ALTER TABLE assignments ADD COLUMN review INTEGER NOT NULL DEFAULT 0;
          PRAGMA user_version=13;`);
      }
      if (version < 14) {
        this.db.exec(`CREATE TABLE worker_activity (subject TEXT PRIMARY KEY, last_call_at TEXT NOT NULL, last_list_pending_at TEXT);
          ALTER TABLE claims ADD COLUMN last_progress_at TEXT;
          ALTER TABLE claims ADD COLUMN last_claim_activity_at TEXT;
          ALTER TABLE claims ADD COLUMN last_seen_note_seq INTEGER NOT NULL DEFAULT 0;
          UPDATE claims SET last_claim_activity_at=claimed_at, last_seen_note_seq=COALESCE((SELECT max(sequence) FROM owner_notes n WHERE n.request_id=claims.request_id),0);
          ALTER TABLE assignment_reannouncements ADD COLUMN next_due_at INTEGER;
          CREATE TABLE alert_cursors (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
          INSERT INTO alert_cursors(name,value) VALUES('denial_progress',COALESCE((SELECT max(id) FROM progress),0)),('denial_report',COALESCE((SELECT max(rowid) FROM reports),0));
          PRAGMA user_version=14;`);
      }
      if (version < 15) {
        // `waiting` is a durable reservation for one live owner long-poll.  It is
        // deliberately not a new delivery channel: a dropped connection releases
        // the row back to the ordinary T3 queue.
        this.db.exec(`PRAGMA user_version=15;`);
      }
      if (version < 16) {
        this.db.exec(`ALTER TABLE assignments ADD COLUMN delivery TEXT;
          UPDATE assignments SET delivery='t3:' || thread_id WHERE delivery IS NULL;
          PRAGMA user_version=16;`);
      }
      if (version < 17) {
        this.db.exec(`CREATE TABLE IF NOT EXISTS assignment_delivery_mutes (request_id TEXT PRIMARY KEY REFERENCES assignments(request_id), muted_at TEXT NOT NULL);
          PRAGMA user_version=17;`);
      }
      if (version < 18) {
        this.db.exec(`CREATE TABLE pr_preflights (request_id TEXT NOT NULL REFERENCES assignments(request_id), phase TEXT NOT NULL CHECK(phase IN ('submit','claim')), evidence TEXT NOT NULL, PRIMARY KEY(request_id,phase));
          PRAGMA user_version=18;`);
      }
      if (version < 19) {
        const hasPriority=this.db.prepare("SELECT 1 FROM pragma_table_info('assignments') WHERE name='priority'").get();
        if(!hasPriority) this.db.exec("ALTER TABLE assignments ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','background'))");
        this.db.exec(`CREATE INDEX IF NOT EXISTS assignments_pending_priority ON assignments(status,priority,created_at);
          PRAGMA user_version=19;`);
      }
      if (version < 20) {
        // Existing claims keep their claim_id at epoch 1 and stay active; the migration abandons nothing.
        const columns=new Set(this.db.prepare("SELECT name FROM pragma_table_info('claims')").all().map(x=>x.name));
        for(const [name,type] of [['epoch','INTEGER NOT NULL DEFAULT 1'],['state',"TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','abandoned'))"],['abandoned_at','TEXT'],['abandon_reason','TEXT']])
          if(!columns.has(name)) this.db.exec(`ALTER TABLE claims ADD COLUMN ${name} ${type}`);
        this.db.exec('PRAGMA user_version=20;');
      }
      if (version < 21) {
        // Backfill runs once, inside this startup transaction, so a serving process never sees a half-filled table.
        this.db.exec(lifecycleSchema);
        backfillLifecycle(this.db);
        this.db.exec('PRAGMA user_version=21;');
      }
      if (version < 22) {
        // Who submitted a row and for which objective/revision; nullable, outside the payload and its hash. Old rows stay null
        // until `dalan backfill-objectives` posts a tuple the server can verify.
        const columns=new Set(this.db.prepare("SELECT name FROM pragma_table_info('assignments')").all().map(x=>x.name));
        for(const [name,type] of [['objective_key','TEXT'],['revision','TEXT'],['task_kind','TEXT'],['source',`TEXT CHECK(source IN (${objectiveSources.map(x=>`'${x}'`).join(',')}))`]])
          if(!columns.has(name)) this.db.exec(`ALTER TABLE assignments ADD COLUMN ${name} ${type}`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS assignments_objective ON assignments(objective_key,created_at);
          PRAGMA user_version=22;`);
      }
      if (version < 23) {
        // covers: once the JSON list of items a per-item re-announce event charged, for refunds. Unused since the flat queue
        // re-wake (nothing is charged); kept so existing databases need no new migration. Always NULL on new rows.
        if(!this.db.prepare("SELECT 1 FROM pragma_table_info('notifications') WHERE name='covers'").get()) this.db.exec('ALTER TABLE notifications ADD COLUMN covers TEXT');
        this.db.exec('PRAGMA user_version=23;');
      }
      if (version < 24) {
        // wake_kind classifies availability event rows so re-wake reads assignment wake traffic without parsing bodies:
        // submit (an assignment's own event, also the old per-item re-announces), rewake, owner_note, message. NULL on
        // non-event rows. Partial indexes keep the per-tick re-wake queries independent of notification history.
        if(!this.db.prepare("SELECT 1 FROM pragma_table_info('notifications') WHERE name='wake_kind'").get()) this.db.exec("ALTER TABLE notifications ADD COLUMN wake_kind TEXT CHECK(wake_kind IN ('submit','rewake','owner_note','message'))");
        this.db.exec(`UPDATE notifications SET wake_kind=CASE WHEN message_id IS NOT NULL THEN 'message' WHEN body LIKE '%"title":"Owner note note\\_%' ESCAPE '\\' THEN 'owner_note' ELSE 'submit' END WHERE kind='event' AND wake_kind IS NULL;
          CREATE INDEX IF NOT EXISTS notifications_request_state ON notifications(request_id,state);
          CREATE INDEX IF NOT EXISTS notifications_wake_gate ON notifications(subscription_id,state) WHERE wake_kind IN ('submit','rewake');
          CREATE INDEX IF NOT EXISTS notifications_wake_time ON notifications(subscription_id,state,COALESCE(attempt_started_at,created_at)) WHERE wake_kind IN ('submit','rewake','owner_note');
          CREATE INDEX IF NOT EXISTS notifications_wake_latest ON notifications(request_id,subscription_id,created_at) WHERE wake_kind IN ('submit','rewake');
          PRAGMA user_version=24;`);
      }
      if (version < 25) {
        // Usage breaks (the worker stops calling tools, e.g. a platform usage limit): one row per break, the open row (until NULL)
        // is the current one; usage is the JSON snapshot of the 1h/6h/24h before since. worker_calls counts tool calls per
        // subject per minute (kept 48 h) for that snapshot and the throttle. break_notices makes the owner notice once per
        // break per target (a t3 thread, or one delivery=none request). Nothing existing changes: claims stay valid.
        this.db.exec(`CREATE TABLE IF NOT EXISTS dot_breaks (id INTEGER PRIMARY KEY AUTOINCREMENT, since TEXT NOT NULL, until TEXT, reason TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('owner','inferred')), end_source TEXT CHECK(end_source IN ('tool_call','owner')), usage TEXT NOT NULL, last_probe_at TEXT, start_alerted_at TEXT, end_alerted_at TEXT, created_at TEXT NOT NULL);
          CREATE UNIQUE INDEX IF NOT EXISTS dot_breaks_one_active ON dot_breaks(COALESCE(until,'')) WHERE until IS NULL;
          CREATE TABLE IF NOT EXISTS worker_calls (subject TEXT NOT NULL, minute INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(subject,minute));
          CREATE INDEX IF NOT EXISTS worker_calls_minute ON worker_calls(minute);
          CREATE TABLE IF NOT EXISTS break_notices (break_id INTEGER NOT NULL REFERENCES dot_breaks(id), target TEXT NOT NULL, request_ids TEXT NOT NULL, notification_id TEXT, created_at TEXT NOT NULL, PRIMARY KEY(break_id,target));
          PRAGMA user_version=25;`);
      }
      if (version < 26) {
        // Response-byte accounting: worker_calls gains a tool dimension and the serialized MCP response bytes per subject,
        // tool and minute (kept 48 h). Rows from before keep their counts under tool 'unrecorded' with bytes NULL (never
        // measured); bytes is never NULL on a newer row. Nothing else changes: claims stay valid.
        this.db.exec(`CREATE TABLE worker_calls_v26 (subject TEXT NOT NULL, minute INTEGER NOT NULL, tool TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, bytes INTEGER, PRIMARY KEY(subject,minute,tool));
          INSERT INTO worker_calls_v26(subject,minute,tool,count,bytes) SELECT subject,minute,'unrecorded',count,NULL FROM worker_calls;
          DROP TABLE worker_calls;
          ALTER TABLE worker_calls_v26 RENAME TO worker_calls;
          CREATE INDEX IF NOT EXISTS worker_calls_minute ON worker_calls(minute);
          PRAGMA user_version=26;`);
      }
      if (version < 27) {
        // Preparation expiry: valid_until mirrors the payload's (normalized ISO, NULL when absent or unparsable) so the sweep
        // reads an index; cancelled_reason says why a row was cancelled ('expired' by the sweep, NULL for an owner cancel).
        // Only open rows are backfilled; claims stay valid and nothing is cancelled here.
        const columns=new Set(this.db.prepare("SELECT name FROM pragma_table_info('assignments')").all().map(x=>x.name));
        for(const name of ['valid_until','cancelled_reason']) if(!columns.has(name)) this.db.exec(`ALTER TABLE assignments ADD COLUMN ${name} TEXT`);
        const set=this.db.prepare('UPDATE assignments SET valid_until=? WHERE request_id=?');
        for(const row of this.db.prepare("SELECT request_id,payload FROM assignments WHERE status IN ('queued','claimed') AND valid_until IS NULL").all()) { let v=null; try { v=validUntilOf(JSON.parse(row.payload)); } catch {} if(v) set.run(v,row.request_id); }
        this.db.exec(`CREATE INDEX IF NOT EXISTS assignments_expiry ON assignments(status,valid_until);
          PRAGMA user_version=27;`);
      }
      if (version < 28) {
        // Byte limits learned from a usage break: 70% of the bytes its ledger shows (1 h and 24 h before since). Only ever lower.
        this.db.exec(`CREATE TABLE IF NOT EXISTS learned_limits (name TEXT PRIMARY KEY CHECK(name IN ('response_bytes_per_hour','response_bytes_per_24h')), value INTEGER NOT NULL, break_id INTEGER, ledger_bytes INTEGER NOT NULL, at TEXT NOT NULL);
          PRAGMA user_version=28;`);
      }
      if (version < 29) {
        // learned_limits covers tool calls too (1 h and 24 h); the CHECK list cannot be altered in place, so rebuild.
        this.db.exec(`CREATE TABLE learned_limits_v29 (name TEXT PRIMARY KEY CHECK(name IN ('response_bytes_per_hour','response_bytes_per_24h','tool_calls_per_hour','tool_calls_per_24h')), value INTEGER NOT NULL, break_id INTEGER, ledger_bytes INTEGER NOT NULL, at TEXT NOT NULL);
          INSERT INTO learned_limits_v29 SELECT name,value,break_id,ledger_bytes,at FROM learned_limits;
          DROP TABLE learned_limits; ALTER TABLE learned_limits_v29 RENAME TO learned_limits;
          PRAGMA user_version=29;`);
      }
      if (version < 30) {
        // learned_limits covers claims too: 70% of the busiest rolling hour of claims in the 24 h before a break.
        this.db.exec(`CREATE TABLE learned_limits_v30 (name TEXT PRIMARY KEY CHECK(name IN ('response_bytes_per_hour','response_bytes_per_24h','tool_calls_per_hour','tool_calls_per_24h','claims_per_hour')), value INTEGER NOT NULL, break_id INTEGER, ledger_bytes INTEGER NOT NULL, at TEXT NOT NULL);
          INSERT INTO learned_limits_v30 SELECT name,value,break_id,ledger_bytes,at FROM learned_limits;
          DROP TABLE learned_limits; ALTER TABLE learned_limits_v30 RENAME TO learned_limits;
          PRAGMA user_version=30;`);
      }
      if (version < 31) {
        // The owner read a terminal row (any /get or /wait, peek included). Separate from the 'consumed' lifecycle event, which
        // consumers that count owner reads and peek reads must not create; only workspace eviction reads this column.
        const wcols=new Set(this.db.prepare("SELECT name FROM pragma_table_info('workspaces')").all().map(x=>x.name));
        if(!wcols.has('fetched_at')) this.db.exec('ALTER TABLE workspaces ADD COLUMN fetched_at TEXT');
        this.db.exec('PRAGMA user_version=31;');
      }
      if (version < 32) {
        // A queued request whose claim the worker's reviewer denied, as a worker note reported it (the denial never reaches the bridge).
        this.db.exec(`CREATE TABLE IF NOT EXISTS claim_denials (request_id TEXT PRIMARY KEY REFERENCES assignments(request_id), at TEXT NOT NULL, reported_in TEXT NOT NULL, capacity INTEGER NOT NULL, note TEXT NOT NULL);
          PRAGMA user_version=32;`);
      }
      if (version < 33) {
        // How often list_pending offered a claimable item without a claim, and when that made it skipped_by_worker.
        const cols=new Set(this.db.prepare("SELECT name FROM pragma_table_info('assignments')").all().map(x=>x.name));
        for(const [name,type] of [['listed_count','INTEGER NOT NULL DEFAULT 0'],['last_listed_at','TEXT'],['skipped_by_dot_at','TEXT']]) if(!cols.has(name)) this.db.exec(`ALTER TABLE assignments ADD COLUMN ${name} ${type}`);
        this.db.exec('PRAGMA user_version=33;');
      }
      if (version < 34) {
        // The signals behind skipped_by_worker: when an item last appeared in a list_pending answer, when it first sat in the
        // claimable window, and how many claims of items listed after it the worker made meanwhile.
        const cols=new Set(this.db.prepare("SELECT name FROM pragma_table_info('assignments')").all().map(x=>x.name));
        for(const [name,type] of [['last_seen_listed_at','TEXT'],['eligible_since','TEXT'],['passed_over','INTEGER NOT NULL DEFAULT 0']]) if(!cols.has(name)) this.db.exec(`ALTER TABLE assignments ADD COLUMN ${name} ${type}`);
        this.db.exec('PRAGMA user_version=34;');
      }
      if(version<35) {
        // The base build supported exactly one worker, 'dot'. Owner-created targets therefore are 'dot'. A subject-bearing
        // fact is 'dot' only when its persisted subject is allowed for this deployment; all other attribution is unknown.
        // Never infer identity from the new connection map, or from whoever holds the claim today.
        // The two target_worker columns are added with an empty default, then every row that exists at this point is set
        // to worker. A fresh database has no rows here, so its schema text and its rows never name worker; only a database that
        // held pre-35 rows gets 'dot', and only on those rows. Every insert names target_worker, so the default is never used.
        // Databases that already reached version 35 under the older step keep DEFAULT 'dot' in their stored schema text:
        // SQLite cannot change a column default without rebuilding the table. That is the only schema difference between
        // a fresh and an upgraded database.
        this.db.exec(`CREATE TABLE schema_migrations (identity TEXT PRIMARY KEY);
          INSERT INTO schema_migrations VALUES('s1v2-worker-facts-20261022');
          ALTER TABLE assignments ADD COLUMN target_worker TEXT NOT NULL DEFAULT '';
          ALTER TABLE messages ADD COLUMN target_worker TEXT NOT NULL DEFAULT '';
          UPDATE assignments SET target_worker='dot';
          UPDATE messages SET target_worker='dot';
          ALTER TABLE claims ADD COLUMN worker TEXT NOT NULL DEFAULT 'unknown';
          ALTER TABLE claims ADD COLUMN lane_key TEXT NOT NULL DEFAULT 'unknown';
          ALTER TABLE claims ADD COLUMN lane_scope TEXT NOT NULL DEFAULT 'subject';
          ALTER TABLE subscriptions ADD COLUMN worker TEXT NOT NULL DEFAULT 'unknown';
          ALTER TABLE subscriptions ADD COLUMN connection TEXT;
          ALTER TABLE reports ADD COLUMN worker TEXT NOT NULL DEFAULT 'unknown';
          ALTER TABLE progress ADD COLUMN worker TEXT NOT NULL DEFAULT 'unknown';
          ALTER TABLE claim_denials ADD COLUMN worker TEXT NOT NULL DEFAULT 'unknown';
          ALTER TABLE lifecycle_events ADD COLUMN worker TEXT NOT NULL DEFAULT 'unknown';
          ALTER TABLE artifacts ADD COLUMN client_artifact_id TEXT;
          UPDATE artifacts SET client_artifact_id=id WHERE kind='upload';
          CREATE UNIQUE INDEX artifacts_alias ON artifacts(request_id,client_artifact_id);
          DROP TRIGGER lifecycle_events_no_update;`);
        const subjects=this.allowedDotSubjects??this.db.prepare('SELECT subject FROM claims UNION SELECT principal FROM subscriptions UNION SELECT subject FROM worker_activity UNION SELECT subject FROM worker_calls').all().map(r=>r.subject);
        for(const subject of subjects) {
          this.db.prepare("UPDATE claims SET worker='dot',lane_key=subject WHERE subject=?").run(subject);
          this.db.prepare("UPDATE subscriptions SET worker='dot' WHERE principal=?").run(subject);
          this.db.prepare("UPDATE lifecycle_events SET worker='dot' WHERE actor=? OR actor='system' AND claim_id IN (SELECT claim_id FROM claims WHERE worker='dot')").run(`dot:${subject}`);
        }
        this.db.exec(`UPDATE reports SET worker=COALESCE((SELECT worker FROM claims c WHERE c.claim_id=reports.claim_id),'unknown');
          UPDATE progress SET worker=COALESCE((SELECT worker FROM claims c WHERE c.request_id=progress.request_id AND progress.created_at>=c.claimed_at),'unknown');
          UPDATE claim_denials SET worker=COALESCE((SELECT worker FROM claims c WHERE c.request_id=claim_denials.reported_in AND claim_denials.at>=c.claimed_at),'unknown');
          CREATE TRIGGER lifecycle_events_no_update BEFORE UPDATE ON lifecycle_events BEGIN SELECT RAISE(ABORT,'lifecycle events are append-only'); END;
          CREATE TABLE worker_activity_v35 (worker TEXT NOT NULL DEFAULT 'unknown',subject TEXT NOT NULL,last_call_at TEXT NOT NULL,last_list_pending_at TEXT,PRIMARY KEY(worker,subject));
          CREATE TABLE worker_calls_v35 (worker TEXT NOT NULL DEFAULT 'unknown',subject TEXT NOT NULL,minute INTEGER NOT NULL,tool TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,bytes INTEGER,PRIMARY KEY(worker,subject,minute,tool));`);
        const known=new Set(subjects);
        for(const r of this.db.prepare('SELECT * FROM worker_activity').all()) this.db.prepare('INSERT INTO worker_activity_v35 VALUES(?,?,?,?)').run(known.has(r.subject)?'dot':'unknown',r.subject,r.last_call_at,r.last_list_pending_at);
        for(const r of this.db.prepare('SELECT * FROM worker_calls').all()) this.db.prepare('INSERT INTO worker_calls_v35 VALUES(?,?,?,?,?,?)').run(known.has(r.subject)?'dot':'unknown',r.subject,r.minute,r.tool,r.count,r.bytes);
        this.db.exec(`DROP TABLE worker_activity; ALTER TABLE worker_activity_v35 RENAME TO worker_activity;
          DROP TABLE worker_calls; ALTER TABLE worker_calls_v35 RENAME TO worker_calls;
          CREATE INDEX worker_calls_minute ON worker_calls(minute); PRAGMA user_version=35;`);
        for(const [table,column] of [['assignments','target_worker'],['messages','target_worker'],['claims','worker'],['claims','lane_scope'],['subscriptions','worker'],['subscriptions','connection'],['reports','worker'],['progress','worker'],['claim_denials','worker'],['worker_calls','worker'],['worker_activity','worker']])
          this.db.exec(`CREATE TRIGGER ${table}_${column}_immutable BEFORE UPDATE OF ${column} ON ${table} BEGIN SELECT RAISE(ABORT,'${table}.${column} is immutable'); END;`);
        this.db.exec("CREATE TRIGGER claims_lane_key_epoch BEFORE UPDATE OF lane_key ON claims WHEN NEW.epoch<=OLD.epoch OR NEW.lane_key<>CASE NEW.lane_scope WHEN 'subject' THEN NEW.subject ELSE NEW.worker END BEGIN SELECT RAISE(ABORT,'claim lane key is recorded per epoch'); END;");
      }
      // Earlier review builds of this same, unreleased migration stored a subscription lane. It is derived state,
      // not an attribution fact. Remove it on reopen too; the identity check above still rejects abandoned schemas.
      if(this.db.prepare("SELECT 1 FROM pragma_table_info('subscriptions') WHERE name='lane_key'").get())
        this.db.exec('DROP TRIGGER IF EXISTS subscriptions_lane_key_immutable; ALTER TABLE subscriptions DROP COLUMN lane_key;');
      if (version < 37) {
        // Per-job execution capability. Like target_worker it is a column, never payload, so payload hashes and retry identity do
        // not change. Every older row ran checks on the host, so the default is 'host'; a rollback to older code ignores the columns.
        // required_capabilities is a JSON list of capability names the host backend must declare verified, or NULL.
        // check_runs.evidence is the bridge-observed record of one host check (workspace.mjs buildEvidence); older rows have none.
        const has=(table,name)=>this.db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`).get(name);
        if(!has('assignments','execution')) this.db.exec("ALTER TABLE assignments ADD COLUMN execution TEXT NOT NULL DEFAULT 'host'");
        if(!has('assignments','required_capabilities')) this.db.exec('ALTER TABLE assignments ADD COLUMN required_capabilities TEXT');
        if(!has('check_runs','evidence')) this.db.exec('ALTER TABLE check_runs ADD COLUMN evidence TEXT');
        this.db.exec('PRAGMA user_version=37;');
      }
      if (version < 38) {
        // Supervisor-verified stop: after each sandbox phase the bridge scans for what is left of it and records the answer here.
        // stop_verified is NULL until a phase ends, 1 while every ended phase was verified empty, 0 once any phase was not.
        const has=(table,name)=>this.db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`).get(name);
        if(!has('check_jobs','stop_verified')) this.db.exec('ALTER TABLE check_jobs ADD COLUMN stop_verified INTEGER');
        if(!has('check_jobs','stop_evidence')) this.db.exec('ALTER TABLE check_jobs ADD COLUMN stop_evidence TEXT');
        this.db.exec('PRAGMA user_version=38;');
      }
      if (version < 39) {
        // Per-claim record of what the worker did on this assignment, so a silent drop can be read from the claim.
        const has=(table,name)=>this.db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`).get(name);
        for(const [name,type] of [['tool_calls','INTEGER NOT NULL DEFAULT 0'],['last_tool','TEXT'],['last_tool_at','TEXT'],['last_tool_error','TEXT'],['first_workspace_tool_at','TEXT']])
          if(!has('claims',name)) this.db.exec(`ALTER TABLE claims ADD COLUMN ${name} ${type}`);
        this.db.exec('PRAGMA user_version=39;');
      }
      if (version < 40) {
        // When the owner read a cancelled row (get or wait, not a peek), so `dalan inbox` can list cancellations nobody has
        // seen. Finished rows use the 'consumed' lifecycle event. Rows cancelled before this column existed count as read.
        const has=(table,name)=>this.db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`).get(name);
        if(!has('assignments','owner_read_at')) this.db.exec('ALTER TABLE assignments ADD COLUMN owner_read_at TEXT');
        this.db.exec("UPDATE assignments SET owner_read_at=cancelled_at WHERE status='cancelled' AND owner_read_at IS NULL; PRAGMA user_version=40;");
      }
      if (version < 41) {
        // Where an upload first came from. rebindClaim moves claim_id on every new epoch; origin_* never moves, so the owner can see
        // that a finish cites bytes an earlier epoch sealed. NULL on rows made before this column existed (origin unknown).
        const has=(table,name)=>this.db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`).get(name);
        if(!has('artifacts','origin_claim_id')) this.db.exec('ALTER TABLE artifacts ADD COLUMN origin_claim_id TEXT');
        if(!has('artifacts','origin_epoch')) this.db.exec('ALTER TABLE artifacts ADD COLUMN origin_epoch INTEGER');
        this.db.exec('PRAGMA user_version=41;');
      }
      if (version < 42) {
        // Output a worker files after cancel. Audit only: apart from reports (results), one row per claim, size-bounded.
        // Reports with late=1 written before this table existed stay where they are.
        this.db.exec(`CREATE TABLE IF NOT EXISTS late_evidence (request_id TEXT NOT NULL REFERENCES assignments(request_id), claim_id TEXT NOT NULL, epoch INTEGER, worker TEXT NOT NULL, outcome TEXT NOT NULL, summary TEXT NOT NULL, result TEXT NOT NULL, full_sha256 TEXT NOT NULL, truncated INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(request_id,claim_id));
          PRAGMA user_version=42;`);
      }
      if (version < 43) {
        // A stable claimant can have overlapping runs. Only one acquisition may retry an active claim.
        if(!this.db.prepare("SELECT 1 FROM pragma_table_info('claims') WHERE name='acquisition_id'").get()) this.db.exec('ALTER TABLE claims ADD COLUMN acquisition_id TEXT');
        this.db.exec('PRAGMA user_version=43;');
      }
      if (version < 44) {
        // What the owner decided about a finished result (accepted, applied, useful_no_change, useful_negative, not_useful) or the
        // stale sweep decided for them ('stale', actor system). Append-only: the latest row is the decision, the rest stay as history.
        this.db.exec(`CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL REFERENCES assignments(request_id), decision TEXT NOT NULL CHECK(decision IN ('accepted','applied','useful_no_change','useful_negative','not_useful','stale')), note TEXT, actor TEXT NOT NULL CHECK(actor IN ('owner','system')), via TEXT NOT NULL, at TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS decisions_request ON decisions(request_id,id);
          CREATE TRIGGER IF NOT EXISTS decisions_no_update BEFORE UPDATE ON decisions BEGIN SELECT RAISE(ABORT,'decisions are append-only'); END;
          CREATE TRIGGER IF NOT EXISTS decisions_no_delete BEFORE DELETE ON decisions BEGIN SELECT RAISE(ABORT,'decisions are append-only'); END;
          `);
        // Persist the existing read projection, not newly verified owner authority.
        // In particular, LIKE and actor='owner' deliberately match latestDecision;
        // an accepted reason saying 'applied' is still only an accepted projection.
        const explicit = new Set(this.db.prepare('SELECT DISTINCT request_id FROM decisions').all().map(r => r.request_id));
        // Lifecycle history may outlive its assignment; leave such rows untouched.
        // Only existing assignments can own durable decisions under the existing FK.
        const legacy = this.db.prepare("SELECT e.request_id,e.type,e.at,e.reason FROM lifecycle_events e JOIN assignments a ON a.request_id=e.request_id WHERE e.type='accepted' OR e.type='consumed' AND e.reason LIKE 'rejected%' ORDER BY e.id").all();
        const insert = this.db.prepare("INSERT INTO decisions(request_id,decision,note,actor,via,at) VALUES(?,?,?,'owner','legacy-projection',?)");
        for (const row of legacy) {
          if (!explicit.has(row.request_id)) insert.run(row.request_id, row.type === 'accepted' ? 'accepted' : 'not_useful', row.reason, row.at);
        }
        this.db.exec('PRAGMA user_version=44;');
      }
      if (version < 45) {
        // Add nullable validity-window provenance. Historical rows stay NULL because their origin is unknown.
        if(!this.db.prepare("SELECT 1 FROM pragma_table_info('assignments') WHERE name='valid_until_source'").get()) this.db.exec('ALTER TABLE assignments ADD COLUMN valid_until_source TEXT');
        this.db.exec('PRAGMA user_version=45;');
      }
      if(version<46) {
        const columns=new Set(this.db.prepare("SELECT name FROM pragma_table_info('notifications')").all().map(x=>x.name));
        for(const [name,type] of [['terminal_at','TEXT'],['terminal_reason','TEXT']]) if(!columns.has(name)) this.db.exec(`ALTER TABLE notifications ADD COLUMN ${name} ${type}`);
        this.db.exec(`CREATE TABLE IF NOT EXISTS uncertain_delivery_alerts(notification_id TEXT PRIMARY KEY,request_id TEXT,created_at TEXT NOT NULL,logged_at TEXT,published_at TEXT,reason TEXT NOT NULL);
          PRAGMA user_version=46;`);
      }
      if(version<47) {
        this.db.exec(`CREATE TABLE IF NOT EXISTS integration_candidates (
            candidate_id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('patch','other')),
            linked_from TEXT REFERENCES integration_candidates(candidate_id),
            patch BLOB NOT NULL,
            patch_digest TEXT NOT NULL,
            patch_base_sha TEXT NOT NULL,
            target_sha TEXT NOT NULL,
            github_repo TEXT,
            created_at TEXT NOT NULL,
            CHECK(linked_from IS NULL OR linked_from<>candidate_id)
          );
          CREATE INDEX IF NOT EXISTS integration_candidates_request ON integration_candidates(request_id,created_at);
          CREATE TABLE IF NOT EXISTS integration_verifications (
            verification_id TEXT PRIMARY KEY,
            candidate_id TEXT NOT NULL REFERENCES integration_candidates(candidate_id),
            patch_digest TEXT NOT NULL,
            patch_base_sha TEXT NOT NULL,
            target_sha TEXT NOT NULL,
            target_ref TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('verified','failed','conflict')),
            checks_json TEXT NOT NULL,
            error TEXT,
            recorded_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS integration_verifications_candidate ON integration_verifications(candidate_id,recorded_at);
          CREATE TRIGGER IF NOT EXISTS integration_candidates_no_update BEFORE UPDATE ON integration_candidates BEGIN SELECT RAISE(ABORT,'integration candidates are immutable'); END;
          CREATE TRIGGER IF NOT EXISTS integration_candidates_no_delete BEFORE DELETE ON integration_candidates BEGIN SELECT RAISE(ABORT,'integration candidates are immutable'); END;
          CREATE TRIGGER IF NOT EXISTS integration_verifications_no_update BEFORE UPDATE ON integration_verifications BEGIN SELECT RAISE(ABORT,'integration verifications are append-only'); END;
          CREATE TRIGGER IF NOT EXISTS integration_verifications_no_delete BEFORE DELETE ON integration_verifications BEGIN SELECT RAISE(ABORT,'integration verifications are append-only'); END;
          PRAGMA user_version=47;`);
      }
      if(version<48) {
        this.db.exec(`DROP TRIGGER IF EXISTS integration_verifications_no_update;
          DROP TRIGGER IF EXISTS integration_verifications_no_delete;
          ALTER TABLE integration_verifications RENAME TO integration_verifications_old;
          CREATE TABLE integration_verifications (
            verification_id TEXT PRIMARY KEY,
            candidate_id TEXT NOT NULL REFERENCES integration_candidates(candidate_id),
            patch_digest TEXT NOT NULL, patch_base_sha TEXT NOT NULL, target_sha TEXT NOT NULL,
            target_ref TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('verified','failed','conflict','skipped')),
            checks_json TEXT NOT NULL, error TEXT, recorded_at TEXT NOT NULL
          );
          INSERT INTO integration_verifications SELECT * FROM integration_verifications_old;
          DROP TABLE integration_verifications_old;
          CREATE INDEX integration_verifications_candidate ON integration_verifications(candidate_id,recorded_at);
          CREATE TRIGGER integration_verifications_no_update BEFORE UPDATE ON integration_verifications BEGIN SELECT RAISE(ABORT,'integration verifications are append-only'); END;
          CREATE TRIGGER integration_verifications_no_delete BEFORE DELETE ON integration_verifications BEGIN SELECT RAISE(ABORT,'integration verifications are append-only'); END;
          PRAGMA user_version=48;`);
      }
      if(version<49) {
        this.db.exec(`DROP TRIGGER IF EXISTS integration_verifications_no_update;
          DROP TRIGGER IF EXISTS integration_verifications_no_delete;
          ALTER TABLE integration_verifications RENAME TO integration_verifications_old;
          CREATE TABLE integration_verifications (
            verification_id TEXT PRIMARY KEY,
            candidate_id TEXT NOT NULL REFERENCES integration_candidates(candidate_id),
            patch_digest TEXT NOT NULL, patch_base_sha TEXT NOT NULL, target_sha TEXT NOT NULL,
            target_ref TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('verified','failed','conflict','skipped','owner_approval_required')),
            checks_json TEXT NOT NULL, error TEXT, recorded_at TEXT NOT NULL
          );
          INSERT INTO integration_verifications SELECT * FROM integration_verifications_old;
          DROP TABLE integration_verifications_old;
          CREATE INDEX integration_verifications_candidate ON integration_verifications(candidate_id,recorded_at);
          CREATE TRIGGER integration_verifications_no_update BEFORE UPDATE ON integration_verifications BEGIN SELECT RAISE(ABORT,'integration verifications are append-only'); END;
          CREATE TRIGGER integration_verifications_no_delete BEFORE DELETE ON integration_verifications BEGIN SELECT RAISE(ABORT,'integration verifications are append-only'); END;
          PRAGMA user_version=49;`);
      }
      if(version<50) {
        // Legacy alert timestamps do not prove that a configured publisher accepted a notice.
        for(const [table,column] of [['alert_episodes','attention_sent_at'],['dot_breaks','alert_first_observed_at'],['dot_breaks','attention_published_at']]) {
          if(!this.db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`).get(column))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
        }
        this.db.exec('PRAGMA user_version=50;');
      }
      // Version 51 fences older servers before they can write plaintext to encrypted AS state.
      if(version<51) this.db.exec('PRAGMA user_version=51;');
      if(version<52 && !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='subscription_storage_meta'").get()) {
        this.db.exec('CREATE TABLE subscription_storage_meta (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL, verifier TEXT NOT NULL); DROP TRIGGER subscriptions_connection_immutable');
        for (const sub of this.db.prepare('SELECT id,secret,connection FROM subscriptions').all()) {
          if (sub.connection !== null) { try { JSON.parse(sub.connection); } catch { throw new Error('legacy subscription connection is invalid'); } }
          this.db.prepare('UPDATE subscriptions SET secret=?,connection=? WHERE id=?').run(this.sealSubscription(sub.id, 'secret', sub.secret), sub.connection === null ? null : this.sealSubscription(sub.id, 'connection', sub.connection), sub.id);
        }
        this.db.exec("CREATE TRIGGER subscriptions_connection_immutable BEFORE UPDATE OF connection ON subscriptions BEGIN SELECT RAISE(ABORT,'subscriptions.connection is immutable'); END");
        this.db.prepare("INSERT INTO subscription_storage_meta VALUES(1,'cleanup',?)").run(this.subscriptionCodec.seal('dot-bridge subscriptions v1', 'verifier'));
      }
      if(version<52) {
        this.validateSubscriptionStorage();
        this.db.exec('PRAGMA user_version=52;');
      }
      if(version<53) {
        // Pre-migration grants inherit the configured duration once.
        const columns=new Set(this.db.prepare("SELECT name FROM pragma_table_info('claims')").all().map(row=>row.name));
        if(!columns.has('lease_ms')) this.db.exec('ALTER TABLE claims ADD COLUMN lease_ms INTEGER');
        this.db.prepare('UPDATE claims SET lease_ms=? WHERE lease_ms IS NULL').run(this.limits.leaseMs);
        this.db.exec('PRAGMA user_version=53;');
      }
      if(version<54) this.db.exec(`CREATE TABLE IF NOT EXISTS owner_submit_commands(request_id TEXT PRIMARY KEY REFERENCES assignments(request_id), key_digest TEXT NOT NULL, intent_digest TEXT NOT NULL, receipt TEXT NOT NULL, owner_hash TEXT NOT NULL);
        PRAGMA user_version=54;`);
      if(version<55) this.db.exec(`CREATE TABLE job_questions (
        request_id TEXT NOT NULL REFERENCES assignments(request_id), question_id TEXT NOT NULL,
        claim_id TEXT NOT NULL, epoch INTEGER NOT NULL, worker TEXT NOT NULL, subject TEXT NOT NULL,
        text TEXT NOT NULL, asked_at TEXT NOT NULL, answer TEXT, answered_at TEXT, consumed_at TEXT,
        PRIMARY KEY(request_id,question_id));
        CREATE TABLE question_answer_wakes (
          notification_id TEXT PRIMARY KEY REFERENCES notifications(id),
          request_id TEXT NOT NULL, question_id TEXT NOT NULL, epoch INTEGER NOT NULL);
        PRAGMA user_version=55;`);
      if(version<56) {
        migrateClaimCommands(this.db);
        this.db.exec(`CREATE TABLE protocol_jobs(request_id TEXT PRIMARY KEY REFERENCES assignments(request_id),settings TEXT NOT NULL);
          CREATE TABLE protocol_events(request_id TEXT NOT NULL REFERENCES assignments(request_id),seq INTEGER NOT NULL,event_type TEXT NOT NULL,at TEXT NOT NULL,epoch INTEGER NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,details TEXT NOT NULL,PRIMARY KEY(request_id,seq));
          ALTER TABLE claims ADD COLUMN lease_deadline_at TEXT;
          PRAGMA user_version=56;`);
        migrateArtifactJournal(this.db);
        migrateResultBindings(this.db);
        migrateJobRetention(this.db);
        migrateProtocolOwnerWaiters(this.db);
      }
      if(version<57) {
        migrateProtocolDelivery(this.db);
        migrateProtocolStopObserver(this.db);
        this.db.exec('PRAGMA user_version=57');
      }
      if(version<58) this.db.exec(`CREATE TABLE submit_supersedes(
        request_id TEXT PRIMARY KEY REFERENCES assignments(request_id),
        target_id TEXT NOT NULL UNIQUE REFERENCES assignments(request_id),
        created_at TEXT NOT NULL,
        CHECK(request_id<>target_id));
        PRAGMA user_version=58;`);
      if(version<59) {
        // Preparation-expiry requeues: how many times a learned deadline was refreshed. Existing rows default to 0, i.e. a
        // full retry budget; no deadline is retimed here and claims stay valid.
        if(!this.db.prepare("SELECT 1 FROM pragma_table_info('assignments') WHERE name='expiry_requeues'").get()) this.db.exec('ALTER TABLE assignments ADD COLUMN expiry_requeues INTEGER NOT NULL DEFAULT 0');
        this.db.exec('PRAGMA user_version=59;');
      }
      if(version<60) {
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS destination_approvals(request_id TEXT PRIMARY KEY REFERENCES assignments(request_id) ON DELETE CASCADE,revision TEXT NOT NULL,snapshot TEXT NOT NULL,actor TEXT NOT NULL,approved_at TEXT NOT NULL);"+
          "CREATE TRIGGER IF NOT EXISTS destination_approvals_immutable BEFORE UPDATE ON destination_approvals BEGIN SELECT RAISE(ABORT,'destination approval is immutable'); END;"+
          "CREATE TRIGGER IF NOT EXISTS destination_approvals_no_delete BEFORE DELETE ON destination_approvals WHEN EXISTS(SELECT 1 FROM assignments WHERE request_id=OLD.request_id) BEGIN SELECT RAISE(ABORT,'destination approval is immutable'); END;"+
          "CREATE TABLE IF NOT EXISTS destination_blocks(request_id TEXT PRIMARY KEY REFERENCES assignments(request_id) ON DELETE CASCADE,body TEXT NOT NULL);");
        if(!this.db.prepare("SELECT 1 FROM pragma_table_info('claims') WHERE name='destination_revision'").get()) this.db.exec('ALTER TABLE claims ADD COLUMN destination_revision TEXT');
        this.db.exec('PRAGMA user_version=60;');
      }
      if(version<61) {
        // The built-in connection a grant was given to. NULL means unknown (older grants) or external OAuth; the
        // column is never inferred from the current live set.
        if(!this.db.prepare("SELECT 1 FROM pragma_table_info('claims') WHERE name='connection_id'").get()) this.db.exec('ALTER TABLE claims ADD COLUMN connection_id TEXT');
        this.db.exec('PRAGMA user_version=61;');
      }
      if(version<62) {
        if(!this.db.prepare("SELECT 1 FROM pragma_table_info('claims') WHERE name='lease_boot_id'").get()) this.db.exec('ALTER TABLE claims ADD COLUMN lease_boot_id TEXT');
        if(!this.db.prepare("SELECT 1 FROM pragma_table_info('claims') WHERE name='lease_deadline_monotonic_ms'").get()) this.db.exec('ALTER TABLE claims ADD COLUMN lease_deadline_monotonic_ms REAL');
        this.db.exec('PRAGMA user_version=62;');
      }
      if(version<63) {
        // The owner-managed tool registry: tools, per-worker grants, an argument-free audit log, and a durable outbox
        // for messages a handler could not deliver yet.
        this.db.exec(`CREATE TABLE IF NOT EXISTS registered_tools (name TEXT PRIMARY KEY, description TEXT NOT NULL, input_schema TEXT NOT NULL, class TEXT NOT NULL CHECK(class IN ('read','write')), handler TEXT NOT NULL, schema_hash TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS tool_grants (tool TEXT NOT NULL REFERENCES registered_tools(name) ON DELETE CASCADE, worker TEXT NOT NULL, granted_at TEXT NOT NULL, PRIMARY KEY(tool,worker));
          CREATE TABLE IF NOT EXISTS tool_registry_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, tool TEXT, worker TEXT, args_digest TEXT, outcome TEXT NOT NULL, schema_hash TEXT);
          CREATE TABLE IF NOT EXISTS tool_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, tool TEXT NOT NULL, worker TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, sent_at TEXT, thread_id TEXT NOT NULL DEFAULT '');
          PRAGMA user_version=63;`);
      }
      // Registry hardening, still schema 63 (unreleased). Idempotent, so a database already at 63 gains the tables.
      // tool_idempotency keeps one outcome per (worker, tool, key) for seven days, and a pending row holds a lease; tool_post_log is the argument-free
      // record of every t3_post attempt (message kind and outcome, never text); tool_registry_meta holds the
      // monotonic registry version.
      this.db.exec(`CREATE TABLE IF NOT EXISTS tool_idempotency (worker TEXT NOT NULL, tool TEXT NOT NULL, key TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','done')), outcome TEXT, created_at TEXT NOT NULL, lease_expires_at TEXT, completed_at TEXT, PRIMARY KEY(worker,tool,key));
        CREATE TABLE IF NOT EXISTS tool_post_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, tool TEXT NOT NULL, worker TEXT NOT NULL, message_kind TEXT NOT NULL, outcome TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS tool_post_log_tool_at ON tool_post_log(tool, at);
        CREATE TABLE IF NOT EXISTS tool_registry_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);`);
      // lease_expires_at: a pending row holds a lease; a NULL lease (older build) counts as expired.
      if(!this.db.prepare("SELECT 1 FROM pragma_table_info('tool_idempotency') WHERE name='lease_expires_at'").get()) this.db.exec('ALTER TABLE tool_idempotency ADD COLUMN lease_expires_at TEXT');
      // completed_at: when the result was stored; the seven-day retention counts from it (NULL falls back to created_at).
      if(!this.db.prepare("SELECT 1 FROM pragma_table_info('tool_idempotency') WHERE name='completed_at'").get()) this.db.exec('ALTER TABLE tool_idempotency ADD COLUMN completed_at TEXT');
      if(!this.db.prepare("SELECT 1 FROM pragma_table_info('tool_outbox') WHERE name='idempotency_key'").get()) this.db.exec('ALTER TABLE tool_outbox ADD COLUMN idempotency_key TEXT');
      // args_digest: sha256 of kind+text, so a reused idempotency key with other content is refused (NULL on older rows).
      if(!this.db.prepare("SELECT 1 FROM pragma_table_info('tool_outbox') WHERE name='args_digest'").get()) this.db.exec('ALTER TABLE tool_outbox ADD COLUMN args_digest TEXT');
      // uncertain_at: a post failed in a way that may still have delivered it; the timer never retries such a row.
      if(!this.db.prepare("SELECT 1 FROM pragma_table_info('tool_outbox') WHERE name='uncertain_at'").get()) this.db.exec('ALTER TABLE tool_outbox ADD COLUMN uncertain_at TEXT');
      if(version<65) {
        // Neutral names for the break table and the skip marker. They were named after the first worker. RENAME keeps the
        // data, the index, and the break_notices foreign key (SQLite rewrites the reference in the child table).
        // Roll back only from the backup taken before this upgrade: older code looks for the old names.
        // Steps 63 and 64 are reserved for migrations that are merged before this one.
        if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dot_breaks'").get()) this.db.exec('ALTER TABLE dot_breaks RENAME TO worker_breaks;');
        if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='dot_breaks_one_active'").get()) this.db.exec('DROP INDEX dot_breaks_one_active; CREATE UNIQUE INDEX IF NOT EXISTS worker_breaks_one_active ON worker_breaks(COALESCE(until,\'\')) WHERE until IS NULL;');
        if(this.db.prepare("SELECT 1 FROM pragma_table_info('assignments') WHERE name='skipped_by_dot_at'").get()) this.db.exec('ALTER TABLE assignments RENAME COLUMN skipped_by_dot_at TO skipped_at;');
        this.db.exec('PRAGMA user_version=65;');
      }
      // Which spelling of the fix-loop source this database stores. Schemas created before the rename list the earlier
      // spelling in the CHECK constraint on assignments.source; newer schemas list only the neutral one.
      this.legacyFixNames=!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assignments' AND instr(sql,?)>0").get(`'${legacyFixLoopName}'`);
      // An older Store already open before migration must not write plaintext afterward.
      for (const [operation, columns] of [['INSERT', ''], ['UPDATE', ' OF secret,connection']]) {
        this.db.exec(`CREATE TRIGGER IF NOT EXISTS subscriptions_encrypted_${operation.toLowerCase()} BEFORE ${operation}${columns} ON subscriptions
          WHEN substr(NEW.secret,1,3) <> 'v1.' OR (NEW.connection IS NOT NULL AND substr(NEW.connection,1,3) <> 'v1.')
          BEGIN SELECT RAISE(ABORT,'subscription storage requires encryption'); END`);
      }
    });
  }
  sealSubscription(id, field, value) { return this.subscriptionCodec.seal(value, `subscriptions:${id}:${field}`); }
  openSubscription(id, field, value) { return this.subscriptionCodec.open(value, `subscriptions:${id}:${field}`); }
  subscriptionConnection(sub) { return sub.connection === null ? null : JSON.parse(this.openSubscription(sub.id, 'connection', sub.connection)); }
  subscriptionSecret(sub) { return this.openSubscription(sub.id, 'secret', sub.secret); }
  validateSubscriptionStorage() {
    try {
      const marker = this.db.prepare('SELECT state,verifier FROM subscription_storage_meta WHERE id=1').get();
      if (!marker || !['cleanup', 'ready'].includes(marker.state) || this.subscriptionCodec.open(marker.verifier, 'verifier') !== 'dot-bridge subscriptions v1') throw new Error();
      for (const sub of this.db.prepare('SELECT id,secret,connection FROM subscriptions').all()) {
        this.subscriptionSecret(sub);
        this.subscriptionConnection(sub);
      }
      return marker;
    } catch { throw new Error('subscription encrypted storage could not be opened'); }
  }
  initializeLeaseClock() {
    // A claim in flight across the upgrade has no persisted deadline. Write the one its activity and lease imply, so a
    // break extends it and every reader judges it by the same deadline.
    // Only claims whose assignment is still claimed are in flight. A claim row keeps state 'active' after its job
    // finishes or is cancelled, so a long-lived queue holds thousands of them; touching each one at startup, one commit
    // per row, held the service before it listened. One transaction keeps the work proportional to the live claims.
    const inFlight="state='active' AND request_id IN (SELECT request_id FROM assignments WHERE status='claimed')";
    this.inTransaction(()=>{
      for(const claim of this.db.prepare(`SELECT * FROM claims WHERE ${inFlight} AND lease_deadline_at IS NULL`).all()) {
        const deadline=Date.parse(this.leaseExpiresAt(claim));
        if(Number.isFinite(deadline)) this.db.prepare('UPDATE claims SET lease_deadline_at=? WHERE request_id=? AND lease_deadline_at IS NULL').run(iso(deadline),claim.request_id);
      }
      if(!this.leaseBootId) return;
      const current=this.monotonicNow();
      for(const claim of this.db.prepare(`SELECT * FROM claims WHERE ${inFlight} AND (lease_boot_id IS NULL OR lease_boot_id<>?)`).all(this.leaseBootId)) {
        const deadline=Date.parse(this.leaseExpiresAt(claim));
        const remaining=Number.isFinite(deadline)?Math.max(0,deadline-this.nowMs()):0;
        this.db.prepare('UPDATE claims SET lease_boot_id=?,lease_deadline_monotonic_ms=? WHERE request_id=?')
          .run(this.leaseBootId,current+remaining,claim.request_id);
      }
    });
  }
  initializeSubscriptionStorage() {
    const marker = this.validateSubscriptionStorage();
    if (marker.state !== 'cleanup') return;
    try {
      const checkpoint = () => { const result = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); if (result.busy) throw new Error(); };
      checkpoint(); this.db.exec('VACUUM'); checkpoint();
      this.db.prepare("UPDATE subscription_storage_meta SET state='ready' WHERE id=1").run(); checkpoint();
    } catch { throw new Error('subscription encrypted storage could not be opened'); }
  }
  putIntegrationCandidate(candidate) {
    return this.transaction(()=>this.putIntegrationCandidateInTransaction(candidate));
  }
  putIntegrationCandidateInTransaction(candidate) {
    const patch=Buffer.from(candidate.patch);
    if(patch.length>MAX_INTEGRATION_PATCH_BYTES) throw new Error(`integration candidate patch too large (maximum ${MAX_INTEGRATION_PATCH_BYTES} bytes)`);
    if(hash(patch)!==candidate.patch_digest) throw new Error('integration candidate patch digest does not match its bytes');
    this.db.prepare('INSERT INTO integration_candidates(candidate_id,request_id,kind,linked_from,patch,patch_digest,patch_base_sha,target_sha,github_repo,created_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(candidate_id) DO NOTHING')
      .run(candidate.candidate_id,candidate.request_id,candidate.kind,candidate.linked_from??null,patch,candidate.patch_digest,candidate.patch_base_sha,
        candidate.target_sha,candidate.github_repo??null,this.stamp());
    const existing=this.db.prepare('SELECT * FROM integration_candidates WHERE candidate_id=?').get(candidate.candidate_id);
    if(!existing) throw new Error('integration candidate insert did not persist');
    const same=existing.request_id===candidate.request_id&&existing.kind===candidate.kind&&(existing.linked_from??null)===(candidate.linked_from??null)
      &&Buffer.from(existing.patch).equals(patch)&&existing.patch_digest===candidate.patch_digest&&existing.patch_base_sha===candidate.patch_base_sha
      &&existing.target_sha===candidate.target_sha&&(existing.github_repo??null)===(candidate.github_repo??null);
    if(!same) throw new Error('integration candidate identity is immutable');
    return {...existing,patch:Buffer.from(existing.patch)};
  }
  beginIntegrationVerification(candidates,verification) {
    if(!Array.isArray(candidates)||candidates.length<1) throw new Error('verification attempt needs at least one candidate');
    return this.transaction(()=>{
      const rows=candidates.map(candidate=>this.putIntegrationCandidateInTransaction(candidate));
      const attempt=this.recordIntegrationVerificationInTransaction(verification);
      return {candidates:rows,verification:attempt};
    });
  }
  getIntegrationCandidate(candidateId) {
    const row=this.db.prepare('SELECT * FROM integration_candidates WHERE candidate_id=?').get(candidateId);
    return row?{...row,patch:Buffer.from(row.patch)}:null;
  }
  recordIntegrationVerification(verification) {
    return this.transaction(()=>this.recordIntegrationVerificationInTransaction(verification));
  }
  recordIntegrationVerificationInTransaction(verification) {
    const verificationId=`iver_${randomUUID()}`;
    const candidate=this.db.prepare('SELECT patch_digest,patch_base_sha,target_sha FROM integration_candidates WHERE candidate_id=?').get(verification.candidate_id);
    if(!candidate) throw new Error('integration candidate not found');
    if(verification.patch_digest!==candidate.patch_digest||verification.patch_base_sha!==candidate.patch_base_sha||verification.target_sha!==candidate.target_sha)
      throw new Error('integration verification does not match candidate');
    this.db.prepare('INSERT INTO integration_verifications(verification_id,candidate_id,patch_digest,patch_base_sha,target_sha,target_ref,status,checks_json,error,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(verificationId,verification.candidate_id,candidate.patch_digest,candidate.patch_base_sha,candidate.target_sha,verification.target_ref,verification.status,JSON.stringify(redactOutput(verification.checks)),redactOutput(verification.error??null),this.stamp());
    const {checks_json,...row}=this.db.prepare('SELECT * FROM integration_verifications WHERE verification_id=?').get(verificationId);
    return {...row,checks:JSON.parse(checks_json)};
  }
  integrationVerifications(candidateId) {
    return this.db.prepare('SELECT * FROM integration_verifications WHERE candidate_id=? ORDER BY rowid').all(candidateId)
      .map(({checks_json,...row})=>({...row,checks:JSON.parse(checks_json)}));
  }
  recordSandboxStop(checkRunId,phase,stop) {
    const row=this.db.prepare('SELECT stop_verified,stop_evidence FROM check_jobs WHERE id=?').get(checkRunId);
    const phases={...(row?.stop_evidence?JSON.parse(row.stop_evidence):{}),[phase]:stop};
    this.db.prepare('UPDATE check_jobs SET stop_verified=?,stop_evidence=? WHERE id=?').run(Object.values(phases).every(x=>x.verified)?1:0,JSON.stringify(phases),checkRunId);
  }
  // "Cancel requested" and "compute stopped" are separate facts. compute_stopped is true only when the assignment is cancelled, a host
  // sandbox ran for it, no check is still running, and the bridge verified after every phase that nothing of that sandbox remained.
  // Anything else stays false and says why. The bridge cannot see a remote worker's own compute, so this speaks of the bridge host only.
  sandboxStop(id,cancelled) {
    const jobs=this.db.prepare('SELECT id,status,stop_verified,stop_evidence FROM check_jobs WHERE request_id=? ORDER BY started_at').all(id);
    const unverified=jobs.filter(j=>j.status==='running'||j.stop_verified!==1).map(j=>({check_run_id:j.id,status:j.status,reason:j.status==='running'?'check_still_running':j.stop_evidence?Object.values(JSON.parse(j.stop_evidence)).find(x=>!x.verified)?.reason:'stop_not_verified'}));
    const reason=!cancelled?'not_cancelled':!jobs.length?'no_host_sandbox_ran':unverified.length?'stop_not_verified':'verified';
    return {compute_stopped:reason==='verified',sandbox_stop:{reason,host_sandboxes:jobs.length,unverified}};
  }
  // First owner read of a terminal assignment; a no-op while it is live or has no workspace.
  recordFetched(id) { this.db.prepare("UPDATE workspaces SET fetched_at=? WHERE request_id=? AND fetched_at IS NULL AND EXISTS(SELECT 1 FROM assignments a WHERE a.request_id=workspaces.request_id AND a.status IN ('finished','cancelled'))").run(this.stamp(),id); }
  insertConfinedCheckAssignment(requestId,payload) {
    const body=JSON.stringify(payload);
    // "unknown" is a reserved name that no configured worker can have, so only the integrator ever touches this row.
    this.db.prepare('INSERT INTO assignments(request_id,payload,payload_hash,thread_id,environment_id,status,created_at,target_worker) VALUES(?,?,?,?,?,?,?,?)')
      .run(requestId,body,hash(body),'integrator','integrator','running',this.stamp(),'unknown');
    return this.db.prepare('SELECT * FROM assignments WHERE request_id=?').get(requestId);
  }
  // Queue waits are scoped to the selected worker and task kind, one sample per job. The first persisted claim is the
  // endpoint; a later reclaim or resume must not make an old wait appear longer. A row never claimed is a censored lower
  // bound: its wait runs to the latest learned-deadline requeue or system expiry. A claimed row's earlier requeues add
  // nothing, because its exact wait already exceeds them.
  queueWaitEvidence(worker, kind, days=7) {
    kind=canonicalKindLabel(kind);
    const since=iso(this.nowMs()-days*86400000);
    const rows=this.db.prepare(`SELECT a.created_at created,a.cancelled_at cancelled,a.cancelled_reason reason,
        EXISTS(SELECT 1 FROM lifecycle_events e INDEXED BY lifecycle_events_request WHERE e.request_id=a.request_id AND e.type='cancelled' AND e.actor='system' AND e.reason='expired') system_expiry,
        (SELECT min(e.at) FROM lifecycle_events e INDEXED BY lifecycle_events_request WHERE e.request_id=a.request_id AND e.type='claimed' AND e.worker=a.target_worker) claimed,
        (SELECT group_concat(e.at) FROM lifecycle_events e INDEXED BY lifecycle_events_request WHERE e.request_id=a.request_id AND e.type='queued' AND e.actor='system' AND e.reason='expired_requeued') requeued
      FROM assignments a WHERE a.created_at>=? AND a.target_worker=? AND ${queueKindSql}=?`).all(since,worker,kind);
    const observed=[]; let expiredLowerBounds=0;
    for(const row of rows) {
      const created=Date.parse(row.created);
      let ms=NaN, censored=false;
      if(row.claimed) ms=Date.parse(row.claimed)-created;
      else {
        const bounds=(row.requeued?.split(',')??[]).map(Date.parse);
        if(row.reason==='expired'&&row.system_expiry) bounds.push(Date.parse(row.cancelled));
        const finite=bounds.filter(Number.isFinite);
        if(finite.length) { ms=Math.max(...finite)-created; censored=true; }
      }
      if(!Number.isFinite(ms)||ms<0) continue;
      observed.push(ms);
      if(censored) expiredLowerBounds++;
    }
    observed.sort((a,b)=>a-b);
    return {waits_ms:observed,expired_lower_bounds:expiredLowerBounds,samples:observed.length,window_days:days,worker,kind};
  }
  queueWaitsMs(worker,kind,days=7) { return this.queueWaitEvidence(worker,kind,days).waits_ms; }
  defaultValidUntil(worker,kind,days=7) {
    const evidence=this.queueWaitEvidence(worker,kind,days), waits=evidence.waits_ms;
    if(waits.length<QUEUE_WINDOW.minSamples) return {valid_until:null,source:'insufficient_history',p90_ms:null,samples:waits.length,
      expired_lower_bounds:evidence.expired_lower_bounds,window_days:days,factor:QUEUE_WINDOW.factor,floor_ms:QUEUE_WINDOW.minMs,cap_ms:QUEUE_WINDOW.maxMs,
      min_samples:QUEUE_WINDOW.minSamples,worker,kind};
    const p90=waits[Math.min(waits.length-1,Math.ceil(waits.length*0.9)-1)];
    const windowMs=Math.min(QUEUE_WINDOW.maxMs,Math.max(QUEUE_WINDOW.minMs,p90*QUEUE_WINDOW.factor));
    return {valid_until:iso(this.nowMs()+windowMs),source:'queue_p90',window_ms:Math.round(windowMs),p90_ms:p90,samples:waits.length,min_samples:QUEUE_WINDOW.minSamples,
      expired_lower_bounds:evidence.expired_lower_bounds,window_days:days,factor:QUEUE_WINDOW.factor,floor_ms:QUEUE_WINDOW.minMs,cap_ms:QUEUE_WINDOW.maxMs,worker,kind};
  }
  owner(id, token) {
    const row = this.db.prepare('SELECT owner_hash FROM assignments WHERE request_id=?').get(id);
    if (!row) throw new Error('assignment not found');
    if (!row.owner_hash) throw new Error('legacy request requires operator adoption');
    const got = Buffer.from(hash(token || ''), 'hex'), expected = Buffer.from(row.owner_hash, 'hex');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new Error('invalid owner capability');
    this.assertProtocolAvailable(id);
  }
  destinationConfigurationError(id,error) {
    // The hook must never change the public failure, whatever it throws.
    try { this.onConfigError?.(error); } catch { /* diagnostic only */ }
    // Never return parser fragments, filesystem paths or resolver exception text.
    const cause=error instanceof SyntaxError?'invalid JSON configuration':'configuration could not be loaded';
    return destinationError({error:'destination_configuration_invalid',request_id:id,
      message:'Current destination configuration is unavailable or invalid; restore it before a new admission. Cause: '+cause});
  }
  destinationSnapshot(worker,execution,payload,{required=false,resolve=()=>this.destinationProfile()}={}) {
    try {
      if(!required&&this.destinationProfile===null&&this.workers.workers.get(worker)?.destination===undefined)return null;
      if(typeof this.destinationProfile!=='function')throw new Error('destination resolver required');
      const profile=resolve();
      if(profile&&typeof profile.then==='function')throw new Error('destination resolver must be synchronous');
      return destinationDisclosure(profile,worker,execution,payload);
    } catch(error) {
      throw this.destinationConfigurationError(payload.request_id,error);
    }
  }
  destinationApproval(id) {
    const row=this.db.prepare('SELECT * FROM destination_approvals WHERE request_id=?').get(id);
    return row?{revision:row.revision,snapshot:JSON.parse(row.snapshot),actor:JSON.parse(row.actor),approved_at:row.approved_at}:null;
  }
  destinationFields(id) {
    const approval=this.destinationApproval(id),block=this.db.prepare('SELECT body FROM destination_blocks WHERE request_id=?').get(id);
    return {...(approval?{destination_approval:approval}:{}),...(block?{destination_changed:JSON.parse(block.body)}:{})};
  }
  destinationClaimFields(id) {
    const revision=this.db.prepare('SELECT destination_revision FROM claims WHERE request_id=?').get(id)?.destination_revision;
    return revision?{destination_revision:revision}:{};
  }
  destinationGeneration(id) {
    const row=this.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(id);
    if(!row)return null;
    const claim=this.db.prepare('SELECT claim_id,epoch FROM claims WHERE request_id=?').get(id);
    return {status:row.status,claim_id:claim?.claim_id??null,epoch:claim?.epoch??0,
      approved_revision:this.destinationApproval(id)?.revision??null,protocol_revision:this.isProtocolJob(id)?this.protocolRevision(id):null};
  }
  recordDestinationRefusalInTransaction(id,observed,details) {
    if(!this.db.isTransaction)throw new Error('destination refusal requires transaction');
    const current=this.destinationGeneration(id);
    if(!observed||!current||!['queued','claimed'].includes(current.status)||
      JSON.stringify(current)!==JSON.stringify(observed))return false;
    const body=JSON.stringify(details),old=this.db.prepare('SELECT body FROM destination_blocks WHERE request_id=?').get(id);
    if(old?.body===body)return true;
    this.db.prepare('INSERT INTO destination_blocks(request_id,body) VALUES(?,?) ON CONFLICT(request_id) DO UPDATE SET body=excluded.body').run(id,body);
    const comparison=(details.differences??[]).map(d=>d.field+': '+JSON.stringify(d.approved)+' -> '+JSON.stringify(d.current)).join('; ');
    const note='BLOCKED: '+details.error+'. '+details.message+(comparison?' '+comparison:'');
    this.db.prepare('INSERT INTO notifications(id,kind,request_id,body,created_at) VALUES(?,?,?,?,?)').run(
      'evt_'+randomUUID(),this.deliveryKind(id,'blocker'),id,
      JSON.stringify({note,destination_change:true,destination_generation:observed}),this.stamp());
    return true;
  }
  destinationAdmissionInTransaction(id) {
    if(!this.db.isTransaction)throw new Error('destination admission requires transaction');
    const approval=this.destinationApproval(id);
    // No migration invents approval; unbound jobs must check the current declaration.
    const observed=this.destinationGeneration(id);
    const row=this.db.prepare('SELECT payload,target_worker,execution FROM assignments WHERE request_id=?').get(id);
    let current=null,details;
    // This synchronous read is the destination snapshot linearization point. No await
    // or external publication lock is claimed; later file edits apply to later admissions.
    try {
      current=this.destinationSnapshot(row.target_worker,row.execution,JSON.parse(row.payload),{required:!!approval});
    }
    catch(error){details=error.destination;}
    if(!details&&(!approval&&!current||approval&&current?.revision===approval.revision&&current.policy.allowed))return null;
    const error=details?.error??(!approval?'destination_approval_required':current?.revision!==approval.revision?'destination_changed':'destination_policy_denied');
    details={error,request_id:id,approved_revision:approval?.revision??null,current_revision:current?.revision??null,
      approved:approval?.snapshot??null,current,differences:destinationDifferences(approval?.snapshot,current),
      message:error==='destination_approval_required'?'The current worker declares a destination but this job has no approval. Ask the owner to cancel and resubmit a new request ID after approving its current revision.':
        error==='destination_changed'?'The declared destination changed. Cancel and resubmit a new request ID after approving its current revision.':
        error==='destination_policy_denied'?'Current repository policy refuses this destination; approval does not override policy.':
        'Current destination configuration is unavailable or invalid. Restore it; this job cannot fall back to legacy admission.'};
    this.recordDestinationRefusalInTransaction(id,observed,details);
    return {destination_refusal:details};
  }
  destinationGrantedInTransaction(id) {
    const approval=this.destinationApproval(id);
    if(approval)this.db.prepare('UPDATE claims SET destination_revision=? WHERE request_id=?').run(approval.revision,id);
    this.db.prepare('DELETE FROM destination_blocks WHERE request_id=?').run(id);
    this.db.prepare("UPDATE notifications SET state='suppressed',last_error='destination admission superseded refusal' WHERE request_id=? AND kind IN ('wait','blocker') AND state IN ('pending','failed') AND json_valid(body) AND json_extract(body,'$.destination_change')=1").run(id);
    return this.destinationClaimFields(id);
  }
  destinationOutcome(result) {
    // Throw only after the owning transaction committed its durable refusal.
    if(result?.destination_refusal)throw destinationError(result.destination_refusal);
    return result;
  }
  checkRetry(payload, deliveryOrThreadId, environmentId, ownerToken, review=false, priority='normal', meta=null, identity=payload, targetWorker=undefined, execution=null, requiredCapabilities=null, commandKey=null, supersedes=null, destinationRevision=null) {
    validateSubmitKey(commandKey);
    const m=normalizeMeta(meta);
    const delivery=typeof deliveryOrThreadId==='string'?{mode:'t3',threadId:deliveryOrThreadId}:deliveryOrThreadId;
    if(!delivery||!['t3','none'].includes(delivery.mode)||delivery.mode==='t3'&&!delivery.threadId) throw new Error('invalid delivery');
    if(!['normal','background'].includes(priority)) throw new Error('invalid priority');
    const deliveryValue=delivery.mode==='t3'?`t3:${delivery.threadId}`:'none';
    const old=this.db.prepare('SELECT * FROM assignments WHERE request_id=?').get(payload.request_id);
    if(supersedes!==null&&(!supersedes||typeof supersedes!=='object'||Array.isArray(supersedes)||
      Object.keys(supersedes).some(k=>!['target_id','target_token'].includes(k))||
      typeof supersedes.target_id!=='string'||!/^[-\w]{8,128}$/.test(supersedes.target_id))) throw new Error('invalid supersedes');
    const targetId=supersedes?.target_id??null;
    const previous=this.db.prepare('SELECT target_id FROM submit_supersedes WHERE request_id=?').get(payload.request_id);
    if(targetId===payload.request_id) throw new Error('supersede_cycle');
    // Both capabilities are required even when returning an already-committed receipt.
    if(old&&(supersedes||previous)) this.owner(payload.request_id,ownerToken);
    let target;
    if(supersedes) {
      target=this.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(targetId);
      if(!target) throw new Error('supersede_target_not_found');
      if(typeof supersedes.target_token!=='string') throw new Error('invalid owner capability');
      this.owner(targetId,supersedes.target_token);
      if(Object.hasOwn(payload,'protocol')||this.isProtocolJob(payload.request_id)||this.isProtocolJob(targetId))
        throw new Error('supersede_native_unsupported');
    }
    if(!old) {
      // A requeued claim is not proof that its remote compute stopped: refuse all claim history.
      if(supersedes&&(target.status!=='queued'||this.db.prepare('SELECT 1 FROM claims WHERE request_id=?').get(targetId)))
        throw new Error('supersede_target_not_queued');
      return null;
    }
    if(this.isProtocolJob(payload.request_id)) {
      this.owner(payload.request_id,ownerToken);
      this.assertProtocolAvailable(payload.request_id);
      identity={...identity,protocol:validateProtocol(payload.protocol)};
    }
    const payloadHash=hash(JSON.stringify(canonical(identity))),ownerHash=hash(ownerToken);
    const approval=this.destinationApproval(payload.request_id);
    // Authenticate before revealing or comparing the approval binding.
    if(approval)this.owner(payload.request_id,ownerToken);
    if((approval?.revision??null)!==destinationRevision)throw new Error('destination approval conflict: retry the original revision; cancel and resubmit to approve a change');
    const command=this.db.prepare('SELECT * FROM owner_submit_commands WHERE request_id=?').get(payload.request_id);
    // Authenticate before revealing key existence or replaying its receipt.
    if(commandKey!==null||command) this.owner(payload.request_id,ownerToken);
    if(commandKey!==null) {
      if(!command||command.key_digest!==hash(commandKey)) throw new Error('EXISTS: assignment already submitted under another command');
      const intent=submitIntentDigest(identity,deliveryValue,environmentId,review,priority,m,targetWorker??old.target_worker,execution??old.execution,requiredCapabilities,destinationRevision,this.legacyFixNames);
      if((previous?.target_id??null)!==targetId||command.owner_hash!==ownerHash||command.intent_digest!==intent) throw new Error('KEY_CONFLICT: command intent changed');
      return {...JSON.parse(command.receipt),duplicate:true,...(approval?{destination_approval:approval}:{})};
    }
    if(command) throw new Error('EXISTS: command_key required to retry this assignment');
    if ((previous?.target_id??null)!==targetId || (targetWorker!==undefined&&old.target_worker!==targetWorker) || (execution!==null&&old.execution!==execution) || (requiredCapabilities!==null&&old.required_capabilities!==JSON.stringify(requiredCapabilities)) || old.payload_hash!==payloadHash || old.delivery!==deliveryValue || old.environment_id!==(environmentId??'') || old.owner_hash!==ownerHash || !!old.review!==!!review || old.priority!==priority || metaFields.some(k=>old[k]!=null&&m[k]!=null&&canonicalMetaValue(k,old[k])!==canonicalMetaValue(k,m[k]))) throw new Error('request_id conflict');
    return {request_id:payload.request_id,status:old.status,duplicate:true,...(approval?{destination_approval:approval}:{})};
  }
  // identity: the assignment as the submitter sent it, when the stored payload differs (scope narrowing); a retry then still matches.
  submit(payload, deliveryOrThreadId, environmentId, ownerToken, review=false, preflight=null, priority='normal', meta=null, identity=payload, maxQueued=null, targetWorker=undefined, execution=null, defaultExecution='host', requiredCapabilities=null, defaultValidUntil=null, commandKey=null, supersedes=null, destinationRevision=null) { return this.transaction(() => {
    const protocol=!this.hasAssignment(payload.request_id)&&Object.hasOwn(payload,'protocol')?validateProtocol(payload.protocol):null;
    if(protocol)identity={...identity,protocol};
    if(targetWorker==='pool') throw new Error('worker \"pool\" is not supported');
    const delivery=typeof deliveryOrThreadId==='string'?{mode:'t3',threadId:deliveryOrThreadId}:deliveryOrThreadId;
    if(!delivery||!['t3','none'].includes(delivery.mode)||delivery.mode==='t3'&&!delivery.threadId) throw new Error('invalid delivery');
    const m=normalizeMeta(meta),threadId=delivery.threadId??'',deliveryValue=delivery.mode==='t3'?`t3:${threadId}`:'none';
    if(!['normal','background'].includes(priority)) throw new Error('invalid priority');
    const retry=this.checkRetry(payload,delivery,environmentId,ownerToken,review,priority,meta,identity,targetWorker,execution,requiredCapabilities,commandKey,supersedes,destinationRevision);
    if(retry) return retry;
    const id=payload.request_id, body=JSON.stringify(payload),payloadHash=hash(JSON.stringify(canonical(identity))),ownerHash=hash(ownerToken);
    // checkRetry validated this target in the same transaction; only counts containing it gain room.
    const supersededId=supersedes?.target_id??null;
    if(destinationRevision!==null&&(typeof destinationRevision!=='string'||!/^sha256:[a-f0-9]{64}$/.test(destinationRevision)))throw new Error('invalid destination_revision');
    const disclosure=this.destinationSnapshot(targetWorker??'dot',execution??defaultExecution,payload,{required:destinationRevision!==null});
    if(disclosure&&destinationRevision===null)throw destinationError({error:'destination_approval_required',request_id:id,current:disclosure,message:'Review the destination disclosure and submit its exact destination_revision.'});
    if((disclosure?.revision??null)!==destinationRevision)throw destinationError({error:'destination_changed',request_id:id,approved_revision:destinationRevision,current_revision:disclosure?.revision??null,current:disclosure,message:'The preview revision is stale; review the current disclosure before submission.'});
    if(disclosure&&!disclosure.policy.allowed)throw destinationError({error:'destination_policy_denied',request_id:id,current:disclosure,message:'Current repository policy refuses this destination.'});
    if(disclosure) {
      // Check the snapshot being approved, even if the live set changes before the next read.
      if(disclosure.connections_digest==='sha256:'+hash('[]'))throw destinationError({error:'destination_connection_required',request_id:id,current:disclosure,
        message:'Built-in mode requires a live connection before an approval can be recorded for this worker.'});
      // Built-in mode only: never record an approval that binds the empty
      // live-connection set. Such an approval would match again the next time
      // the set empties (pair, then revoke or expire), admitting claims from
      // a dead connection. External-OAuth profiles carry no live-set callback,
      // so this check does not apply to them.
      let profile=null;
      try {
        profile=typeof this.destinationProfile==='function'?this.destinationProfile():null;
        if(profile&&typeof profile.then==='function')throw new Error('destination resolver must be synchronous');
      } catch(error) {
        throw this.destinationConfigurationError(id,error);
      }
      const live=profile?.builtinConnectionIds;
      if(typeof live==='function') {
        let ids;
        try { ids=live(targetWorker??'dot'); }
        catch(error) { throw this.destinationConfigurationError(id,error); }
        if(!Array.isArray(ids)||ids.length===0)throw destinationError({error:'destination_connection_required',request_id:id,current:disclosure,
          message:'Built-in mode requires a live connection before an approval can be recorded for this worker.'});
      }
    }
    if(maxQueued!==null) {
      if(!Number.isSafeInteger(maxQueued)||maxQueued<1) throw new Error('invalid max_queued');
      const queued=this.db.prepare(`SELECT count(*) n FROM assignments WHERE status='queued' AND target_worker=? AND request_id IS NOT ? AND ${live(this.nowMs())}`).get(targetWorker??'dot',supersededId).n;
      if(queued>=maxQueued) throw new Error(`worker queue is full (${queued} queued, in-flight cap ${maxQueued})`);
    }
    if(priority==='background'&&this.db.prepare(`SELECT count(*) n FROM assignments WHERE priority='background' AND target_worker=? AND request_id IS NOT ? AND (status='claimed' OR status='queued' AND ${live(this.nowMs())})`).get(targetWorker??'dot',supersededId).n>=this.backgroundMaxInFlight) throw new Error('background_capacity_full');
    // The target is a column, not payload: an omitted worker means 'dot'.
    this.db.prepare('INSERT INTO assignments(request_id,payload,payload_hash,thread_id,environment_id,status,created_at,owner_hash,review,delivery,priority,objective_key,revision,task_kind,source,target_worker,execution,required_capabilities) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,body,payloadHash,threadId,environmentId??'','queued',this.stamp(),ownerHash,review?1:0,deliveryValue,priority,...metaFields.map(k=>k==='source'?toStoredSource(m[k],this.legacyFixNames):m[k]),targetWorker??'dot',execution??defaultExecution,requiredCapabilities?JSON.stringify(requiredCapabilities):null);
    if(disclosure)this.db.prepare('INSERT INTO destination_approvals(request_id,revision,snapshot,actor,approved_at) VALUES(?,?,?,?,?)').run(id,disclosure.revision,JSON.stringify(disclosure),JSON.stringify({kind:'owner_capability',id:ownerHash}),this.stamp());
    const requestedValidUntil=validUntilOf(payload);
    const mayUseDefault=priority==='normal'&&!this.paused()&&!((targetWorker??'dot')==='dot'&&this.holdingBreak());
    const effectiveValidUntil=requestedValidUntil??(mayUseDefault&&typeof defaultValidUntil==='string'?defaultValidUntil:null);
    this.db.prepare('UPDATE assignments SET valid_until=?,valid_until_source=? WHERE request_id=?').run(effectiveValidUntil,requestedValidUntil?'requester':effectiveValidUntil?'queue_p90':null,id);
    this.recordPrPreflight(id,'submit',payload,preflight);
    this.lifecycle(id,'queued','owner',null,null);
    if(protocol) {
      this.db.prepare('INSERT INTO protocol_jobs VALUES(?,?)').run(id,JSON.stringify(canonical(protocol)));
      defineProtocolRetentionInTransaction(this,id);
      this.protocolCommands().initialize(id,1);
      this.protocolEventInTransaction(id,'submitted',{},0);
    }
    if(supersedes) {
      // Source, immutable reference, cancellation facts and command receipt share this write transaction.
      this.db.prepare('INSERT INTO submit_supersedes(request_id,target_id,created_at) VALUES(?,?,?)').run(id,supersedes.target_id,this.stamp());
      this.cancelInTransaction(supersedes.target_id,'superseded');
    }
    for (const sub of this.activeSubscriptions()) this.submitWake(id,sub);
    const receipt={request_id:id,status:'queued',duplicate:false,...(protocol?{revision:1}:{}),...this.destinationFields(id)};
    if(commandKey!==null) {
      const intent=submitIntentDigest(identity,deliveryValue,environmentId,review,priority,m,targetWorker??'dot',execution??defaultExecution,requiredCapabilities,destinationRevision,this.legacyFixNames);
      this.db.prepare('INSERT INTO owner_submit_commands(request_id,key_digest,intent_digest,receipt,owner_hash) VALUES(?,?,?,?,?)').run(id,hash(commandKey),intent,JSON.stringify(receipt),ownerHash);
    }
    return receipt;
  }); }
  // Fills objective columns of rows that have none, only with tuples verifyObjective proves against the stored payload.
  // Idempotent: a row that already carries any objective column is never rewritten.
  backfillObjectives(tuples, {dryRun=false}={}) { return this.transaction(() => {
    if(!Array.isArray(tuples)||tuples.length>1000) throw new Error('tuples must be an array of at most 1000');
    const out={dry_run:dryRun,received:tuples.length,updated:0,already_set:0,conflict:0,not_found:0,rejected:0,by_source:{},rejected_examples:[]};
    const select=this.db.prepare('SELECT request_id,payload,objective_key,revision,task_kind,source FROM assignments WHERE request_id=?');
    const update=this.db.prepare('UPDATE assignments SET objective_key=?,revision=?,task_kind=?,source=? WHERE request_id=? AND objective_key IS NULL AND revision IS NULL AND task_kind IS NULL AND source IS NULL');
    for(const t of tuples) {
      const row=typeof t?.request_id==='string'?select.get(t.request_id):null;
      if(!row) { out.not_found++; continue; }
      const {request_id,...given}=t, why=verifyObjective(row,given);
      if(why) { out.rejected++; if(out.rejected_examples.length<20) out.rejected_examples.push({request_id,reason:why}); continue; }
      const tuple=normalizeMeta(given);
      if(metaFields.some(k=>row[k]!==null)) { out[metaFields.every(k=>canonicalMetaValue(k,row[k])===canonicalMetaValue(k,tuple[k]))?'already_set':'conflict']++; continue; }
      if(!dryRun) update.run(...metaFields.map(k=>k==='source'?toStoredSource(tuple[k],this.legacyFixNames):tuple[k]),request_id);
      out.updated++; out.by_source[tuple.source]=(out.by_source[tuple.source]??0)+1;
    }
    out.without_objective=this.db.prepare('SELECT count(*) n FROM assignments WHERE objective_key IS NULL').get().n-(dryRun?out.updated:0);
    out.total=this.db.prepare('SELECT count(*) n FROM assignments').get().n;
    return out;
  }); }
  isProtocolJob(id) { return !!this.db.prepare('SELECT 1 FROM protocol_jobs WHERE request_id=?').get(id); }
  assertProtocolAvailable(id) { return checkProtocolAvailable(this,id); }
  protocolListingLive(id) {
    const protocol=this.getProtocol(id);
    return !protocol||protocol.retain_until_ms>this.nowMs()&&!!this.db.prepare('SELECT 1 FROM job_retention_policy WHERE job=?').get(id)&&!this.db.prepare('SELECT 1 FROM job_retention_tombstones WHERE job=?').get(id);
  }
  getProtocol(id) { const r=this.db.prepare('SELECT settings FROM protocol_jobs WHERE request_id=?').get(id);return r?JSON.parse(r.settings):null; }
  protocolRevision(id) { return this.db.prepare('SELECT revision FROM claim_command_revisions WHERE job=?').get(id)?.revision??null; }
  protocolFacts(id) { return this.db.prepare('SELECT seq,event_type AS type,at,epoch,revision,state,details FROM protocol_events WHERE request_id=? ORDER BY seq').all(id).map(r=>({...r,details:JSON.parse(r.details)})); }
  protocolState(id) {
    const status=this.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(id)?.status;
    if(status!=='claimed') return status;
    const claim=this.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id);
    if(this.db.prepare('SELECT 1 FROM job_questions WHERE request_id=? AND claim_id=? AND epoch=? AND consumed_at IS NULL').get(id,claim.claim_id,claim.epoch)) return 'awaiting_input';
    if(this.db.prepare("SELECT 1 FROM artifacts WHERE request_id=? AND claim_id=? AND kind='upload' AND sealed=1 AND origin_claim_id=? AND origin_epoch=?").get(id,claim.claim_id,claim.claim_id,claim.epoch)) return 'result_staged';
    return claim.last_progress_at?'running':'leased';
  }
  protocolEventInTransaction(id,type,details={},epoch=null) {
    if(!this.db.isTransaction)protocolError('transaction_required');
    if(!this.isProtocolJob(id)||typeof type!=='string'||!type||epoch!==null&&!protocolNat(epoch))protocolError('invalid_protocol_event');
    const seq=this.db.prepare('SELECT COALESCE(max(seq),0)+1 AS seq FROM protocol_events WHERE request_id=?').get(id).seq;
    epoch??=this.db.prepare('SELECT epoch FROM claims WHERE request_id=?').get(id)?.epoch??0;
    this.db.prepare('INSERT INTO protocol_events VALUES(?,?,?,?,?,?,?,?)').run(id,seq,type,this.stamp(),epoch,this.protocolRevision(id),this.protocolState(id),JSON.stringify(canonical(details)));
    materializeProtocolWaiters(this,id);
    return seq;
  }
  advanceProtocolRevisionInTransaction(id) {
    if(!this.db.isTransaction)protocolError('transaction_required');
    return this.protocolCommands().advance(id,this.protocolRevision(id));
  }
  protocolCommands() {
    return createClaimCommands({db:this.db,clock:()=>this.nowMs(),maxLeaseMs:this.limits.leaseMs,
      authorize:c=>{
        const row=this.assertClaim(c.job,c.claim,c.subject,c.worker);
        const status=this.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(c.job)?.status;
        return {job:row.request_id,subject:row.subject,worker:row.worker,claim:row.claim_id,epoch:row.epoch,
          active:row.state==='active'&&status==='claimed',leaseUntil:this.leaseDeadlineClockMs(row)};
      }});
  }
  // The one place a native worker command checks the connection. It runs after the claim lookup and before the command
  // ledger replays or runs anything, in the transaction that commits the effect. A caller that omits connectionId is refused
  // in built-in mode (fail closed); external OAuth passes null and is unchanged.
  protocolMutationInTransaction(id,claimId,subject,worker,ctx,mutate,connectionId=null) {
    if(!this.db.isTransaction)protocolError('transaction_required');
    if(!this.isProtocolJob(id))protocolError('protocol_required');
    const claim=this.assertClaim(id,claimId,subject,worker);
    this.assertMutationConnection(id,claim,connectionId);
    const status=this.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(id)?.status;
    if(['finished','cancelled'].includes(status)) throw questionError('TERMINAL','assignment is terminal');
    if(!ctx||typeof ctx.key!=='string'||!ctx.key||!protocolNat(ctx.revision)||typeof mutate!=='function')protocolError('command_context_required');
    if(ctx.epoch!==undefined&&ctx.epoch!==claim.epoch)protocolError('stale_authority');
    return this.protocolCommands().execute({job:id,subject,worker,claim:claimId,epoch:claim.epoch,
      key:ctx.key,expectedRevision:ctx.revision,operation:ctx.operation,args:ctx.args},mutate);
  }
  setClaimDeadlineInTransaction(id,leaseMs) {
    const activity=this.db.prepare('SELECT last_claim_activity_at FROM claims WHERE request_id=?').get(id)?.last_claim_activity_at;
    const deadline=Date.parse(activity??this.stamp())+leaseMs;
    if(!protocolNat(deadline))protocolError('invalid_lease');
    this.db.prepare('UPDATE claims SET lease_deadline_at=?,lease_boot_id=?,lease_deadline_monotonic_ms=? WHERE request_id=?')
      .run(iso(deadline),this.leaseBootId,this.leaseBootId?this.monotonicNow()+leaseMs:null,id);
  }
  renewClaim(id,claimId,leaseMs,ctx,subject='local-principal',worker='dot',connectionId=null) {
    return this.transaction(()=>{
      const receipt=this.protocolMutationInTransaction(id,claimId,subject,worker,
      {...ctx,operation:'renew',args:{leaseMs}},({leaseUntil})=>{
        this.db.prepare('UPDATE claims SET lease_ms=?,lease_deadline_at=?,lease_boot_id=?,lease_deadline_monotonic_ms=? WHERE request_id=? AND claim_id=?')
          .run(leaseMs,iso(leaseUntil),this.leaseBootId,this.leaseBootId?this.monotonicNow()+leaseMs:null,id,claimId);
        const claim=this.assertClaim(id,claimId,subject,worker);
        this.protocolEventInTransaction(id,'renewed',{lease_ms:leaseMs,lease_deadline_at:iso(leaseUntil)},claim.epoch);
        return {request_id:id,claim_id:claimId,epoch:claim.epoch,lease_expires_at:iso(leaseUntil)};
      },connectionId);
      return {...receipt.value,revision:receipt.revision,leaseUntil:receipt.leaseUntil};
    });
  }
  protocolClaimInTransaction(id,claimant,subject,capacity,preflight,worker,acquisitionId,leaseMs,ctx,connectionId=null) {
    if(!this.db.isTransaction)protocolError('transaction_required');
    // HTTP authenticates the subject; native admission checks visibility before any receipt lookup.
    if(!this.mayAct(worker,id)||typeof subject!=='string'||!subject)throw new Error('assignment not found');
    this.assertProtocolAvailable(id);
    if(!ctx||typeof ctx.key!=='string'||!ctx.key||ctx.key.length>512||!protocolNat(ctx.revision))protocolError('command_context_required');
    const command={job:id,subject,worker,operation:'claim',key:ctx.key,expectedRevision:ctx.revision,
      args:{claimant,acquisitionId,leaseMs:Object.hasOwn(ctx,'requestedLeaseMs')?ctx.requestedLeaseMs:leaseMs}};
    const identity=JSON.stringify(canonical(command));
    const old=this.db.prepare('SELECT identity,result FROM claim_command_receipts WHERE job=? AND command_key=?').get(id,ctx.key);
    if(old) {
      const receipt=JSON.parse(old.result);
      const current=this.db.prepare("SELECT * FROM claims WHERE request_id=? AND state='active'").get(id);
      if(!current||current.subject!==subject||current.worker!==worker)protocolError('stale_authority');
      const priorCommand=JSON.parse(old.identity);
      if(priorCommand.operation==='claim'&&(current.claim_id!==receipt.claim_id||current.epoch!==receipt.epoch))protocolError('stale_authority');
      this.assertClaim(id,current.claim_id,subject,worker);
      if(this.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(id)?.status!=='claimed')protocolError('stale_authority');
      if(old.identity!==identity)protocolError('command_conflict');
      this.assertRetryConnection(id,current,worker,connectionId);
      return receipt;
    }
    if(this.protocolRevision(id)!==ctx.revision)protocolError('revision_conflict');
    const previous=this.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id);
    if(previous?.state==='active'&&!this.leaseExpired(previous))protocolError('claim_busy');
    const value=this.claimInTransaction(id,claimant,subject,capacity,preflight,worker,acquisitionId,leaseMs,connectionId);
    if(value?.destination_refusal)return value;
    // Same acquisition with a fresh key cannot renew or invent a native claimed fact.
    const revision=previous?.claim_id===value.claim_id?this.protocolRevision(id):this.advanceProtocolRevisionInTransaction(id);
    if(previous?.claim_id!==value.claim_id)this.protocolEventInTransaction(id,'claimed',{claim_id:value.claim_id},value.epoch);
    const receipt={...value,revision,lease_expires_at:this.leaseExpiresAt(this.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id))};
    this.db.prepare('INSERT INTO claim_command_receipts VALUES(?,?,?,?)').run(id,ctx.key,identity,JSON.stringify(canonical(receipt)));
    return receipt;
  }
  mayAct(worker,id) {
    const row=this.db.prepare('SELECT target_worker FROM assignments WHERE request_id=? UNION ALL SELECT target_worker FROM messages WHERE message_id=?').get(id,id);
    return !!row&&canSee(this.workers,worker,row.target_worker);
  }
  subscriptionVisible(sub) {
    if(!canSee(this.workers,sub.worker,sub.worker)) return false;
    try {
      // A pre-profile row cannot prove which OAuth client created it. Keep it only in legacy mode.
      if(sub.connection===null) return this.workers.legacy===true;
      const connection=this.subscriptionConnection(sub);
      if(connection.builtin&&(!this.connectionIsLive||!this.connectionIsLive(connection.connection_id))) return false;
      return resolveWorker(this.workers,connection)===sub.worker;
    } catch {return false;}
  }
  subscriptionActive(sub) { return !!sub&&sub.state==='active'&&sub.expires_at>this.stamp()&&this.subscriptionVisible(sub); }
  suppressSubscriptionRows(ids,reason) {
    for(const id of ids) {
      this.db.prepare("UPDATE subscriptions SET state='revoked' WHERE id=?").run(id);
      this.db.prepare("UPDATE notifications SET state='suppressed',last_error=? WHERE subscription_id=? AND state IN ('pending','failed')").run(reason,id);
    }
    return ids;
  }
  retireSubscription(id,reason='subscription inactive') { return this.transaction(()=>this.suppressSubscriptionRows([id],reason)); }
  retireConnectionSubscriptions(connectionId,reason='connection inactive') {
    if(!connectionId) return [];
    const ids=this.db.prepare('SELECT * FROM subscriptions').all().filter(sub=>{
      try { const connection=this.subscriptionConnection(sub); return connection?.builtin&&connection.connection_id===connectionId; } catch { return false; }
    }).map(sub=>sub.id);
    if(!ids.length) return [];
    return this.transaction(()=>this.suppressSubscriptionRows(ids,reason));
  }
  retireUnusableSubscription(sub,reason='subscription inactive') {
    if(!sub) return [];
    try {
      const connection=this.subscriptionConnection(sub);
      if(connection?.builtin&&this.connectionIsLive&&!this.connectionIsLive(connection.connection_id))
        return this.retireConnectionSubscriptions(connection.connection_id,reason);
    } catch { /* Retire the malformed or non-built-in subscription below. */ }
    return this.retireSubscription(sub.id,reason);
  }
  retireUnknownSubscriptions() {
    const retired=this.db.prepare("SELECT * FROM subscriptions WHERE state='active'").all().filter(sub=>!this.subscriptionActive(sub));
    if(!retired.length) return [];
    return this.transaction(()=>this.suppressSubscriptionRows(retired.map(sub=>sub.id),'subscription inactive'));
  }
  // Admission and wakes count shared worker lanes plus this subject's historical lanes, using recorded scope/key.
  // A takeover excludes the claim being replaced; changing or removing the profile cannot hide other active work.
  activeClaims(subject,worker,exceptId=null) {
    return this.db.prepare("SELECT c.* FROM claims c JOIN assignments a USING(request_id) WHERE a.status='claimed' AND c.state='active' AND c.worker=? AND (c.lane_scope='worker' OR c.lane_key=?) AND c.request_id IS NOT ?").all(worker,subject,exceptId);
  }
  subscriptionFreeLanes(sub,laneCapacity=this.limits.laneCapacity??6,claimCapacity=this.capacity) {
    return this.freeLanes(sub.principal,sub.worker,laneCapacity,claimCapacity);
  }
  activeSubscriptions() { return this.db.prepare("SELECT * FROM subscriptions WHERE state='active' AND expires_at>?").all(this.stamp()).filter(sub=>this.subscriptionActive(sub)); }
  // Text of a wake that names the queue head when several items wait: the worker claims oldest first via list_pending.
  queueHeadTitle(eligible,free) { return eligible.length>1?`${eligible.length} assignments queued (${free} free ${free===1?'lane':'lanes'}); claim oldest first via list_pending: ${JSON.parse(eligible[0].payload).brief}`:null; }
  // Wake for a new submission. When older items that this subscription may act on are queued, the wake names the queue head, not the
  // new item, so a worker that follows wakes does not take newer work ahead of older work. Who may claim what is unchanged.
  submitWake(id,sub) {
    // Skip items list_pending marks blocked (for example waiting on a destination approval): the worker cannot claim them now.
    const blocked=this.db.prepare('SELECT 1 FROM destination_blocks WHERE request_id=?');
    const eligible=this.rewakeCandidates(sub.id).filter(x=>!blocked.get(x.request_id));
    if(eligible.length>1&&eligible[0].request_id!==id&&eligible.some(x=>x.request_id===id))
      return this.queueEvent(id,sub,false,this.queueHeadTitle(eligible,this.subscriptionFreeLanes(sub,this.limits.laneCapacity??6)),'submit',eligible[0].request_id);
    return this.queueEvent(id,sub);
  }
  queueEvent(id, sub, force=false, title=null, wakeKind='submit', names=id) {
    sub=this.db.prepare('SELECT * FROM subscriptions WHERE id=?').get(sub.id);
    if(!this.subscriptionActive(sub)||!this.mayAct(sub.worker,id)) return null;
    // Only assignment wakes (submit, rewake) dedupe: an owner-note event for the item never stands in for one.
    const existing=this.db.prepare("SELECT id,state FROM notifications WHERE request_id=? AND subscription_id=? AND wake_kind IN ('submit','rewake') AND state IN ('pending','sending','failed','delivered') ORDER BY created_at DESC, rowid DESC LIMIT 1").get(id,sub.id);
    if (existing && (!force || existing.state!=='delivered')) return existing.id;
    const payload=JSON.parse(this.db.prepare('SELECT payload FROM assignments WHERE request_id=?').get(id).payload);
    const eventId=`evt_${randomUUID()}`, body=JSON.stringify({eventId,name:'assignment.available',timestamp:this.stamp(),data:{request_id:names,title:(title??payload.brief).slice(0,160)},cursor:null});
    this.db.prepare('INSERT INTO notifications(id,kind,request_id,subscription_id,body,created_at,wake_kind) VALUES(?,?,?,?,?,?,?)').run(eventId,'event',id,sub.id,body,this.stamp(),wakeKind);
    return eventId;
  }
  // Queued assignments in list_pending order (normal before background, then oldest) with queued_at (see queuedAt).
  queuedRows() {
    return this.db.prepare(`SELECT a.request_id,a.payload,a.priority,a.target_worker,${queuedAt} queued_at FROM assignments a WHERE a.status='queued' AND a.cancelled_at IS NULL AND ${live(this.nowMs())} ORDER BY ${LIST_ORDER}`).all();
  }
  // Break intervals [since, until or open] in ms. Owner since never reaches back before the previous break's end, so they are disjoint.
  breakIntervals() { return this.db.prepare('SELECT since,until FROM worker_breaks ORDER BY since').all().map(b=>[Date.parse(b.since),b.until?Date.parse(b.until):Infinity]); }
  // How long a row has been queued, minus usage-break time: the re-wake window and the unclaimed clock stand still during a break.
  queuedAgeMs(queuedAtText,now=this.nowMs(),breaks=this.breakIntervals()) {
    const from=Date.parse(queuedAtText);
    return breaks.reduce((age,[since,until])=>age-Math.max(0,Math.min(until,now)-Math.max(since,from)),now-from);
  }
  // Queued assignments that waited longer than the re-wake window, so re-wake no longer names them. Items with an uncertain or
  // sending owner delivery are left out: they wait for reconcile, not for the worker. Derived only: a requeue restarts the clock.
  unclaimedAfterReannounce(limits=this.limits,worker='dot') {
    const now=this.nowMs(), windowMs=limits.rewakeWindowMs??defaultRedeliveryLimits.rewakeWindowMs, breaks=worker==='dot'?this.breakIntervals():[];
    const rows=this.db.prepare(`SELECT a.request_id,${queuedAt} queued_at FROM assignments a WHERE a.target_worker=? AND a.status='queued' AND ${live(now)} ORDER BY queued_at`).all(worker).filter(r=>this.queuedAgeMs(r.queued_at,now,breaks)>=windowMs&&!this.uncertainDeliveries(r.request_id));
    return {count:rows.length,oldest_age_ms:rows.length?now-Date.parse(rows[0].queued_at):null,request_ids:rows.slice(0,10).map(r=>r.request_id)};
  }
  // Honest classification of queued work after its first event 2xx. Observations only: nothing here reclaims or cancels a claim.
  liveness(limits=this.limits, capacity=this.capacity, worker='dot') {
    const now=this.nowMs(), age=text=>now-Date.parse(text);
    const calls=this.db.prepare('SELECT max(last_call_at) call, max(last_list_pending_at) list FROM worker_activity WHERE worker=?').get(worker);
    const lastCall=calls.call??null, lastList=calls.list??null;
    const silence=lastCall?age(lastCall):Infinity;
    const claims=this.db.prepare("SELECT c.subject,c.worker,c.lane_key,c.lane_scope,c.lease_ms,c.lease_deadline_at,c.lease_boot_id,c.lease_deadline_monotonic_ms,c.claimed_at,c.last_claim_activity_at,c.last_progress_at,COALESCE(c.last_claim_activity_at,c.claimed_at) activity FROM claims c JOIN assignments a USING(request_id) WHERE a.status='claimed' AND c.state='active' AND c.worker=?").all(worker);
    const staleClaims=claims.filter(c=>this.leaseExpired(c)&&!this.heldAfterStart(c));
    const liveSubs=this.activeSubscriptions().filter(sub=>sub.worker===worker);
    const liveClaims=liveSubs.flatMap(sub=>this.activeClaims(sub.principal,sub.worker));
    const hasLiveClaim=liveClaims.some(c=>now-Date.parse(c.last_claim_activity_at??c.claimed_at)<this.claimLeaseMs(c));
    const atCapacity=liveSubs.length>0&&liveSubs.every(sub=>this.subscriptionFreeLanes(sub,limits.laneCapacity??6,capacity)===0);
    const hasSubscription=liveSubs.length>0;
    const items=this.db.prepare(`SELECT request_id,created_at,NOT (${live(now)}) expired FROM assignments WHERE target_worker=? AND status='queued' AND cancelled_at IS NULL ORDER BY created_at`).all(worker).map(row=>{
      // A queued row past its preparation's valid_until, or a protocol row past its retention, is 'expired', never alive_not_claiming: the worker cannot claim it.
      if(row.expired) return {request_id:row.request_id,class:'expired',event_2xx_age_ms:null};
      const first=this.db.prepare("SELECT min(COALESCE(attempt_started_at,created_at)) at FROM notifications WHERE kind='event' AND request_id=? AND state='delivered'").get(row.request_id).at;
      const eventAge=first?age(first):null;
      let cls=null;
      if(!hasSubscription) cls=null;
      else if(first===null) cls=age(row.created_at)>=limits.silenceMs?'transport_failing':null;
      else if(atCapacity&&hasLiveClaim) cls='at_capacity_healthy';
      else if(silence>=limits.silenceMs&&eventAge>=limits.silenceMs) cls='pause_suspected';
      else if(!atCapacity&&silence<limits.silenceMs&&eventAge>=2*limits.intervalMs) cls='alive_not_claiming';
      return {request_id:row.request_id,class:cls,event_2xx_age_ms:eventAge};
    });
    const queueClasses=Object.fromEntries(['pause_suspected','at_capacity_healthy','alive_not_claiming','transport_failing','expired'].map(name=>[name,items.filter(i=>i.class===name).length]));
    const ages=items.map(i=>i.event_2xx_age_ms).filter(x=>x!==null);
    return {
      claimed_outer_count:claims.length,max_claimed_outer_assignments:capacity,
      oldest_claim_age_ms:claims.length?Math.max(...claims.map(c=>age(c.claimed_at))):null,
      oldest_claim_progress_age_ms:claims.length?Math.max(...claims.map(c=>age(c.last_progress_at??c.claimed_at))):null,
      last_worker_call_at:lastCall,last_list_pending_at:lastList,
      oldest_unclaimed_event_2xx_age_ms:ages.length?Math.max(...ages):null,
      queue_classes:queueClasses,stale_claims:{count:staleClaims.length,max_idle_ms:staleClaims.length?Math.max(...staleClaims.map(c=>age(c.activity))):null},
      worker_silence_ms:Number.isFinite(silence)?silence:null,unclaimed_after_reannounce:this.unclaimedAfterReannounce(limits,worker),items
    };
  }
  recordWorkerCall(subject,tool,worker='dot') { return this.transaction(() => {
    const at=this.stamp();
    this.db.prepare(`INSERT INTO worker_activity(worker,subject,last_call_at,last_list_pending_at) VALUES(?,?,?,?)
      ON CONFLICT(worker,subject) DO UPDATE SET last_call_at=excluded.last_call_at,last_list_pending_at=COALESCE(excluded.last_list_pending_at,last_list_pending_at)`).run(worker,subject,at,tool==='list_pending'?at:null);
    this.db.prepare('INSERT INTO worker_calls(worker,subject,minute,tool,count,bytes) VALUES(?,?,?,?,1,0) ON CONFLICT(worker,subject,minute,tool) DO UPDATE SET count=count+1').run(worker,subject,Math.floor(this.nowMs()/60000),tool);
    // The worker's next authenticated tool call ends an active usage break.
    if(worker==='dot') { const active=this.activeBreak(); if(active) this.endBreak(active,'tool_call'); }
  }); }
  // Bytes of the serialized MCP response to one tool call, added once the response is written (the minute it was written).
  recordResponseBytes(subject,tool,bytes,worker='dot') {
    if(!Number.isInteger(bytes)||bytes<0) throw new Error('invalid response bytes');
    this.db.prepare('INSERT INTO worker_calls(worker,subject,minute,tool,count,bytes) VALUES(?,?,?,?,0,?) ON CONFLICT(worker,subject,minute,tool) DO UPDATE SET bytes=COALESCE(bytes,0)+excluded.bytes').run(worker,subject,Math.floor(this.nowMs()/60000),tool,bytes);
  }
  pruneWorkerCalls() { return this.db.prepare("DELETE FROM worker_calls WHERE minute<?").run(Math.floor((this.nowMs()-48*HOUR)/60000)).changes; }
  // Rolling-hour usage and the throttle verdicts. Claims are new claim epochs (lifecycle 'claimed', not 'resume').
  // Effective byte limits: the configured value, lowered by anything learned from a break ledger.
  byteLimits(limits=this.limits) {
    const learned=Object.fromEntries(this.db.prepare('SELECT name,value,break_id FROM learned_limits').all().map(r=>[r.name,r]));
    const lower=(configured,name)=>Math.min(configured,Math.max(learned[name]?.value??Infinity,Math.ceil(configured*learnedFloorFraction)));
    const hour=limits.maxResponseBytesPerHour??defaultRedeliveryLimits.maxResponseBytesPerHour, day=limits.maxResponseBytesPer24h??defaultRedeliveryLimits.maxResponseBytesPer24h;
    const callsHour=limits.maxToolCallsPerHour??defaultRedeliveryLimits.maxToolCallsPerHour, callsDay=limits.maxToolCallsPer24h??defaultRedeliveryLimits.maxToolCallsPer24h, claimsHour=limits.maxClaimsPerHour??defaultRedeliveryLimits.maxClaimsPerHour;
    return {hour:lower(hour,'response_bytes_per_hour'),day:lower(day,'response_bytes_per_24h'),callsHour:lower(callsHour,'tool_calls_per_hour'),callsDay:lower(callsDay,'tool_calls_per_24h'),claimsHour:lower(claimsHour,'claims_per_hour'),configuredClaims:claimsHour,
      configured:{hour,day},configuredCalls:{hour:callsHour,day:callsDay},learned};
  }

  rollingUsage(limits=this.limits) {
    const now=this.nowMs(), bl=this.byteLimits(limits), maxClaims=bl.claimsHour, maxCalls=bl.callsHour, maxCallsDay=bl.callsDay;
    const claims=this.db.prepare("SELECT count(*) n FROM lifecycle_events WHERE worker='dot' AND type='claimed' AND at>? AND COALESCE(reason,'')<>'resume'").get(iso(now-HOUR)).n;
    const minute=Math.floor(now/60000), {calls,bytes}=this.db.prepare("SELECT COALESCE(sum(count),0) calls,COALESCE(sum(bytes),0) bytes FROM worker_calls WHERE worker='dot' AND minute>?").get(minute-60);
    const {bytesDay,callsDay}=this.db.prepare("SELECT COALESCE(sum(bytes),0) bytesDay,COALESCE(sum(count),0) callsDay FROM worker_calls WHERE worker='dot' AND minute>?").get(minute-1440);
    const queued=this.db.prepare(`SELECT count(*) n FROM assignments WHERE status='queued' AND ${live(now)}`).get().n;
    // Estimates, not gates: the bridge holds work only on evidence (an owner-confirmed break, or a pause). Configured and
    // learned limits estimate usage; over_estimate names the limits reached for status and the usage_over_estimate alert.
    const overEstimate=[...(claims>=maxClaims?['claims_per_hour']:[]),...(calls>=maxCalls?['tool_calls_per_hour']:[]),...(callsDay>=maxCallsDay?['tool_calls_per_24h']:[]),...(bytes>=bl.hour?['response_bytes_per_hour']:[]),...(bytesDay>=bl.day?['response_bytes_per_24h']:[])];
    return {claims_last_hour:claims,tool_calls_last_hour:calls,tool_calls_last_24h:callsDay,response_bytes_last_hour:bytes,response_bytes_last_24h:bytesDay,queued,max_claims_per_hour:maxClaims,max_tool_calls_per_hour:maxCalls,max_tool_calls_per_24h:maxCallsDay,configured_tool_calls:bl.configuredCalls,configured_claims_per_hour:bl.configuredClaims,
      max_response_bytes_per_hour:bl.hour,max_response_bytes_per_24h:bl.day,configured_response_bytes:bl.configured,
      learned_response_bytes:Object.fromEntries(Object.entries(bl.learned).filter(([k])=>k.startsWith('response_bytes')).map(([k,r])=>[k,{value:r.value,break_id:r.break_id}])),
      learned_tool_calls:Object.fromEntries(Object.entries(bl.learned).filter(([k])=>k.startsWith('tool_calls')).map(([k,r])=>[k,{value:r.value,break_id:r.break_id}])),
      learned_claims_per_hour:bl.learned.claims_per_hour?{value:bl.learned.claims_per_hour.value,break_id:bl.learned.claims_per_hour.break_id}:null,
      over_estimate:overEstimate,
      // Kept for older readers: nothing is throttled by an estimate any more.
      rewake_throttled:false,submit_throttled:false,normal_rewake_throttled:false,holding:{rewake:[],submit:[]}};
  }
  // After a break is recorded, cut each byte and tool-call limit to 70% of what its ledger shows (DB-sourced, complete windows only).
  learnFromBreak(id,usage) {
    const put=this.db.prepare(`INSERT INTO learned_limits(name,value,break_id,ledger_bytes,at) VALUES(?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET value=excluded.value,break_id=excluded.break_id,ledger_bytes=excluded.ledger_bytes,at=excluded.at WHERE excluded.value<learned_limits.value`);
    for(const [name,window,field,partial] of [['response_bytes_per_hour','1h','response_bytes','response_bytes_partial'],['response_bytes_per_24h','24h','response_bytes','response_bytes_partial'],
      ['tool_calls_per_hour','1h','tool_calls','tool_calls_partial'],['tool_calls_per_24h','24h','tool_calls','tool_calls_partial']]) {
      const w=usage?.[window];
      if(!w||!Number.isInteger(w[field])||w[field]<=0||w[partial]) continue;
      put.run(name,Math.max(1,Math.floor(0.7*w[field])),id,w[field],this.stamp());
    }
    // Claims: the hour right before a break can be quiet, so learn from the busiest rolling hour of the 24 h.
    const peak=usage?.['24h']?.peak_claims_per_hour;
    if(Number.isInteger(peak)&&peak>0) put.run('claims_per_hour',Math.max(1,Math.floor(0.7*peak)),id,peak,this.stamp());
  }

  // Usage in the 1h/6h/24h before a break's since. tool_calls is null when worker_calls holds nothing older than since (the
  // counter did not exist yet), and tool_calls_partial marks a window that starts before the counter's first minute.
  // response_bytes (total and by tool) follows the same rule for byte accounting (migration 26). request_log holds what
  // break-usage-backfill merged from the request log; nothing here overwrites it except a new since (setBreak).
  usageBefore(sinceMs) {
    const first=this.db.prepare("SELECT min(minute) m FROM worker_calls WHERE worker='dot'").get().m, toMinute=Math.floor(sinceMs/60000);
    const firstBytes=this.db.prepare("SELECT min(minute) m FROM worker_calls WHERE worker='dot' AND bytes IS NOT NULL").get().m;
    return Object.fromEntries([['1h',HOUR],['6h',6*HOUR],['24h',24*HOUR]].map(([name,ms])=>{
      const from=iso(sinceMs-ms), to=iso(sinceMs), fromMinute=Math.floor((sinceMs-ms)/60000);
      const count=(type,extra='')=>this.db.prepare(`SELECT count(*) n FROM lifecycle_events WHERE worker='dot' AND type=? AND at>=? AND at<? ${extra}`).get(type,from,to).n;
      const calls=first===null||first>=toMinute?null:this.db.prepare("SELECT COALESCE(sum(count),0) n FROM worker_calls WHERE worker='dot' AND minute>=? AND minute<?").get(fromMinute,toMinute).n;
      const byTool=firstBytes===null||firstBytes>=toMinute?null:Object.fromEntries(this.db.prepare("SELECT tool,sum(bytes) bytes FROM worker_calls WHERE worker='dot' AND bytes>0 AND minute>=? AND minute<? GROUP BY tool ORDER BY sum(bytes) DESC,tool").all(fromMinute,toMinute).map(r=>[r.tool,r.bytes]));
      const peak=name==='24h'?(()=>{const t=this.db.prepare("SELECT at FROM lifecycle_events WHERE worker='dot' AND type='claimed' AND at>=? AND at<? AND COALESCE(reason,'')<>'resume' ORDER BY at").all(from,to).map(r=>Date.parse(r.at));let best=0,j=0;for(let i=0;i<t.length;i++){while(t[i]-t[j]>=HOUR)j++;best=Math.max(best,i-j+1);}return best;})():undefined;
      return [name,{claims:count('claimed',"AND COALESCE(reason,'')<>'resume'"),...(peak!==undefined?{peak_claims_per_hour:peak}:{}),finishes:count('completed'),tool_calls:calls,...(calls!==null&&first>fromMinute?{tool_calls_partial:true}:{}),
        checks_over_60s:this.db.prepare("SELECT count(*) n FROM check_runs r WHERE EXISTS(SELECT 1 FROM lifecycle_events e WHERE e.claim_id=r.claim_id AND e.worker='dot') AND duration_ms>60000 AND created_at>=? AND created_at<?").get(from,to).n,
        response_bytes:byTool&&Object.values(byTool).reduce((n,b)=>n+b,0),...(byTool?{response_bytes_by_tool:byTool}:{}),...(byTool&&firstBytes>fromMinute?{response_bytes_partial:true}:{})}];
    }));
  }
  // Operator backfill from the request log for a break whose snapshot predates byte accounting (or to add the log's view).
  // Each window gets a request_log entry (source 'request_log'); DB-sourced claims, finishes, checks, tool calls and bytes
  // are never touched. since must match the break's since, so a moved break is not filled with another window's numbers.
  mergeBreakUsage(id,since,windows) { return this.transaction(() => {
    const row=Number.isInteger(id)&&id>0?this.db.prepare('SELECT * FROM worker_breaks WHERE id=?').get(id):null;
    if(!row) throw new Error('break not found');
    if(since!==row.since) throw new Error(`since mismatch: break ${id} since is ${row.since}`);
    const count=v=>Number.isInteger(v)&&v>=0, names=['1h','6h','24h'];
    if(!windows||typeof windows!=='object'||Array.isArray(windows)||Object.keys(windows).sort().join()!==[...names].sort().join()) throw new Error('windows must have exactly 1h, 6h and 24h');
    const usage=JSON.parse(row.usage);
    for(const name of names) {
      const w=windows[name], tools=w?.by_tool&&typeof w.by_tool==='object'&&!Array.isArray(w.by_tool)?Object.entries(w.by_tool):null;
      if(!w||typeof w!=='object'||Object.keys(w).some(k=>!['response_bytes','calls','by_tool','partial'].includes(k))||!count(w.response_bytes)||!count(w.calls)||!tools||tools.length>64||
        w.partial!==undefined&&typeof w.partial!=='boolean'||tools.some(([tool,v])=>!/^[a-z0-9_]{1,64}$/.test(tool)||!v||typeof v!=='object'||Object.keys(v).sort().join()!=='bytes,calls'||!count(v.bytes)||!count(v.calls))||
        tools.reduce((n,[,v])=>n+v.bytes,0)!==w.response_bytes||tools.reduce((n,[,v])=>n+v.calls,0)!==w.calls) throw new Error(`invalid ${name} window`);
      const byTool=Object.fromEntries(tools.sort((a,b)=>b[1].bytes-a[1].bytes||a[0].localeCompare(b[0])).map(([tool,v])=>[tool,{calls:v.calls,bytes:v.bytes}]));
      usage[name]={...usage[name],request_log:{source:'request_log',response_bytes:w.response_bytes,calls:w.calls,by_tool:byTool,...(w.partial?{partial:true}:{})}};
    }
    const next=JSON.stringify(usage), updated=next!==row.usage;
    if(updated) this.db.prepare('UPDATE worker_breaks SET usage=? WHERE id=?').run(next,id);
    return {id,since:row.since,updated,usage_before:usage};
  }); }
  // Limitation: usage breaks are tracked only for the default worker (`dot`). Break evidence and probe budgets are not per worker.
  activeBreak() { return this.db.prepare('SELECT * FROM worker_breaks WHERE until IS NULL').get()??null; }
  // The break that holds work: only an owner-confirmed one. An inferred break (silence) is reported and alerted, not held on.
  holdingBreak() { const b=this.activeBreak(); return b?.source==='owner'?b:null; }
  breakState() {
    const b=this.activeBreak();
    return b?{active:true,id:b.id,since:b.since,reason:b.reason,source:b.source,duration_ms:this.nowMs()-Date.parse(b.since),last_probe_at:b.last_probe_at}:{active:false,since:null,reason:null,source:null,duration_ms:null};
  }
  breaks() {
    return this.db.prepare('SELECT * FROM worker_breaks ORDER BY id').all().map(b=>({id:b.id,since:b.since,until:b.until,reason:b.reason,source:b.source,end_source:b.end_source,
      duration_ms:(b.until?Date.parse(b.until):this.nowMs())-Date.parse(b.since),usage_before:JSON.parse(b.usage),last_probe_at:b.last_probe_at}));
  }
  startBreak({since,reason,source}) {
    const usage=this.usageBefore(Date.parse(since));
    const {lastInsertRowid}=this.db.prepare('INSERT INTO worker_breaks(since,reason,source,usage,created_at) VALUES(?,?,?,?,?)').run(since,reason,source,JSON.stringify(usage),this.stamp());
    // Only an owner-confirmed break teaches limits. An inferred break starts at the worker's last call, so the hour before it
    // is quiet by construction and 70% of it is no limit at all. An owner mark over an inferred break learns then.
    if(source==='owner') this.learnFromBreak(Number(lastInsertRowid),usage);
    return this.breakState();
  }
  learnedLimits() { return this.db.prepare('SELECT name,value,break_id,ledger_bytes ledger_value,at FROM learned_limits ORDER BY name').all(); }
  clearLearnedLimits() { return this.transaction(()=>{ const removed=this.learnedLimits(); this.db.prepare('DELETE FROM learned_limits').run(); return {cleared:removed.length,removed}; }); }
  // Estimated limits that usage has reached, with the configured value and, where a break lowered it, the learned one.
  overEstimate(limits=this.limits) {
    const u=this.rollingUsage(limits), learned=Object.fromEntries(this.learnedLimits().map(r=>[r.name,r]));
    const configured={response_bytes_per_hour:u.configured_response_bytes.hour,response_bytes_per_24h:u.configured_response_bytes.day,
      tool_calls_per_hour:u.configured_tool_calls.hour,tool_calls_per_24h:u.configured_tool_calls.day,claims_per_hour:u.configured_claims_per_hour};
    const effective={response_bytes_per_hour:u.max_response_bytes_per_hour,response_bytes_per_24h:u.max_response_bytes_per_24h,
      tool_calls_per_hour:u.max_tool_calls_per_hour,tool_calls_per_24h:u.max_tool_calls_per_24h,claims_per_hour:u.max_claims_per_hour};
    const used={response_bytes_per_hour:u.response_bytes_last_hour,response_bytes_per_24h:u.response_bytes_last_24h,
      tool_calls_per_hour:u.tool_calls_last_hour,tool_calls_per_24h:u.tool_calls_last_24h,claims_per_hour:u.claims_last_hour};
    return u.over_estimate.map(name=>({name,used:used[name],limit:effective[name],configured:configured[name],
      ...(learned[name]&&effective[name]<configured[name]?{learned:learned[name].value,break_id:learned[name].break_id}:{})}));
  }
  // Owner mark. Over an active break (e.g. an inferred one) it takes over: source owner, new reason, since if given, fresh snapshot.
  setBreak(reason,since=null) { return this.transaction(() => {
    if(typeof reason!=='string'||!reason.trim()||reason.length>512) throw new Error('invalid reason');
    const active=this.activeBreak(), at=since??active?.since??this.stamp();
    if(!Number.isFinite(Date.parse(at))||Date.parse(at)>this.nowMs()) throw new Error('since must not be in the future');
    const ended=this.db.prepare('SELECT max(until) u FROM worker_breaks WHERE until IS NOT NULL').get().u;
    if(ended&&Date.parse(at)<Date.parse(ended)) throw new Error(`since must not be before the end of the previous break (${ended})`);
    if(!active) return this.startBreak({since:at,reason,source:'owner'});
    const usage=this.usageBefore(Date.parse(at));
    this.db.prepare("UPDATE worker_breaks SET reason=?,source='owner',since=?,usage=? WHERE id=?").run(reason,at,JSON.stringify(usage),active.id);
    // Confirming an inferred break without --since keeps its since (the worker's last call), so its last hour is still quiet:
    // learn the 24 h budgets and the claims peak, not the hourly limits.
    this.learnFromBreak(active.id,active.source==='inferred'&&!since?{...usage,'1h':undefined}:usage);
    return this.breakState();
  }); }
  clearBreak() { return this.transaction(() => {
    const active=this.activeBreak();
    if(active) this.endBreak(active,'owner');
    return {cleared:!!active,...(active?{id:active.id,since:active.since}:{}),worker_break:this.breakState()};
  }); }
  // End a usage break, by owner clear or by the worker's next tool call. A break never moves a claim's lease deadline: only the
  // claimant's own progress extends a lease, so a claim with no progress for one lease period is released even across a break.
  // Call inside a transaction.
  endBreak(active,endSource) {
    this.db.prepare('UPDATE worker_breaks SET until=?,end_source=? WHERE id=?').run(this.stamp(),endSource,active.id);
  }
  // Inferred start: no worker tool call (any subject) for breakSilenceMs, an availability event got a 2xx after the last call,
  // and work is queued. since is the last call. A worker that never called is not inferred (no known silence start), and a break
  // that ended after the last call (an owner clear) is not re-inferred until the worker calls again.
  inferBreak(limits=this.limits) { return this.transaction(() => {
    if(this.activeBreak()) return null;
    const now=this.nowMs(), silenceMs=limits.breakSilenceMs??defaultRedeliveryLimits.breakSilenceMs;
    const last=this.db.prepare("SELECT max(last_call_at) at FROM worker_activity WHERE worker='dot'").get().at;
    if(!last||now-Date.parse(last)<silenceMs) return null;
    const event=this.db.prepare("SELECT max(last_event_2xx_at) at FROM subscriptions WHERE worker='dot'").get().at;
    if(!event||Date.parse(event)<=Date.parse(last)) return null;
    if(!this.db.prepare("SELECT 1 FROM assignments WHERE status='queued' AND target_worker='dot'").get()) return null;
    if(this.db.prepare('SELECT 1 FROM worker_breaks WHERE until>=?').get(last)) return null;
    return this.startBreak({since:last,reason:`inferred: no worker tool call for ${Math.round(silenceMs/60000)} min after an availability event was delivered, with work queued`,source:'inferred'});
  }); }
  // Breaks whose start or end alert has not gone out yet; the caller marks each after it publishes.
  breakAlertsDue() { return this.db.prepare('SELECT * FROM worker_breaks WHERE (until IS NULL AND attention_published_at IS NULL) OR (until IS NOT NULL AND attention_published_at IS NOT NULL AND end_alerted_at IS NULL) ORDER BY id').all(); }
  observeBreakAlert(id,at) { this.db.prepare('UPDATE worker_breaks SET alert_first_observed_at=? WHERE id=? AND attention_published_at IS NULL').run(at,id); }
  markBreakAlert(id,edge) {
    const now=this.stamp();
    if(edge==='start')this.db.prepare('UPDATE worker_breaks SET start_alerted_at=?,attention_published_at=? WHERE id=?').run(now,now,id);
    else this.db.prepare('UPDATE worker_breaks SET end_alerted_at=? WHERE id=?').run(now,id);
  }
  // A break notice is moot once its break ended or none of its requests is still queued.
  breakNoticeMoot(item) {
    const {break_id,request_ids=[]}=JSON.parse(item.body??'{}');
    if(this.db.prepare('SELECT until FROM worker_breaks WHERE id=?').get(break_id)?.until!==null) return true;
    return !request_ids.some(id=>this.db.prepare("SELECT 1 FROM assignments WHERE request_id=? AND status='queued'").get(id));
  }
  breakNotices(id) { return this.db.prepare('SELECT b.break_id,b.created_at at,b.request_ids FROM break_notices b, json_each(b.request_ids) j WHERE j.value=? ORDER BY b.created_at').all(id).map(r=>({break_id:r.break_id,at:r.at,text:breakNoticeText(JSON.parse(r.request_ids))})); }
  // Lease expiry only makes a claim eligible for takeover; it does not revoke the current holder. A takeover changes the active claim_id.
  // Only the active holder's claim_id extends the lease, so a stale holder cannot keep a new holder's claim alive.
  // A claim past its deadline is never refreshed (Store.assertClaim refuses it); only the sweep or a new claim moves it on.
  touchClaim(id,claimId,subject,worker='dot',connectionId=null) { return this.inTransaction(()=>
    this.touchHeldClaim(id,claimId,subject,worker,c=>this.assertMutationConnection(id,c,connectionId))); }
  // `authorize` runs on the live claim row before the write. An exact claim retry passes none: assertRetryConnection already proved the holder.
  touchHeldClaim(id,claimId,subject,worker,authorize=null) {
    const c=this.liveHeldClaim(id,claimId,subject,worker);
    if(!c)return;
    authorize?.(c);
    this.refreshClaimActivity(id,claimId);
  }
  refreshClaimActivity(id,claimId) {
    const at=this.stamp(), claim=this.db.prepare('SELECT lease_ms FROM claims WHERE request_id=? AND claim_id=?').get(id,claimId);
    if(this.isProtocolJob(id)) this.db.prepare('UPDATE claims SET last_claim_activity_at=? WHERE request_id=? AND claim_id=?').run(at,id,claimId);
    else this.db.prepare('UPDATE claims SET last_claim_activity_at=?,lease_deadline_at=?,lease_boot_id=?,lease_deadline_monotonic_ms=? WHERE request_id=? AND claim_id=?')
      .run(at,iso(Date.parse(at)+(claim?.lease_ms??this.limits.leaseMs)),this.leaseBootId,this.leaseBootId?this.monotonicNow()+(claim?.lease_ms??this.limits.leaseMs):null,id,claimId);
  }
  // The active, unexpired claim this worker holds under claimId, or null. A missing or expired claim is left to the caller's own error.
  liveHeldClaim(id,claimId,subject,worker) {
    if(!this.mayAct(worker,id))return null;
    const c=this.db.prepare("SELECT * FROM claims WHERE request_id=? AND claim_id=? AND state='active'").get(id,claimId);
    return !c||c.subject!==subject||c.worker!==worker||this.leaseExpired(c)?null:c;
  }
  // Read-only connection check for a workspace tool, run synchronously right before the tool body (after its last await).
  // It writes nothing, so a refusal leaves the worktree, the workspace rows and the activity counters as they were.
  assertWorkerConnection(id,claimId,subject,worker='dot',connectionId=null) {
    const c=this.liveHeldClaim(id,claimId,subject,worker);
    if(c)this.assertMutationConnection(id,c,connectionId);
  }
  // The `get` cursor. Only the live holding connection moves it; any other caller (revoked, replaced, a different
  // connection of the same worker) reads and changes nothing. Check and write share one transaction. Returns whether it moved.
  markNotesSeenByHolder(id,subject,worker='dot',connectionId=null) { return this.inTransaction(()=>{
    if(!this.mayAct(worker,id))return false;
    const claim=this.db.prepare("SELECT * FROM claims WHERE request_id=? AND subject=? AND worker=? AND state='active'").get(id,subject,worker);
    if(!claim)return false;
    try { this.assertMutationConnection(id,claim,connectionId); }
    catch(error) { if(error.destination?.error==='connection_not_live')return false; throw error; }
    this.markNotesSeen(id,subject,worker);
    return true;
  }); }
  // Unfenced: for callers that already proved the holder inside their own claim transaction (exact retry, resume). `get` uses markNotesSeenByHolder.
  markNotesSeen(id,subject,worker='dot') { if(!this.mayAct(worker,id)) return; this.db.prepare("UPDATE claims SET last_seen_note_seq=COALESCE((SELECT max(sequence) FROM owner_notes n WHERE n.request_id=claims.request_id),0) WHERE request_id=? AND subject=? AND worker=? AND state='active'").run(id,subject,worker); }
  // One UPDATE per tool call that names an assignment; it matches only that worker's active claim, so a denied or foreign call counts nowhere.
  recordToolActivity(id,subject,worker,tool,{workspace=false,error=null,connectionId=null}={}) { return this.inTransaction(()=>{
    const claim=this.db.prepare("SELECT * FROM claims WHERE request_id=? AND subject=? AND worker=? AND state='active'").get(id,subject,worker);
    if(!claim)return;
    this.assertMutationConnection(id,claim,connectionId);
    const at=this.stamp();
    this.db.prepare("UPDATE claims SET tool_calls=tool_calls+1,last_tool=?,last_tool_at=?,last_tool_error=?,first_workspace_tool_at=CASE WHEN ? THEN COALESCE(first_workspace_tool_at,?) ELSE first_workspace_tool_at END WHERE request_id=? AND subject=? AND worker=? AND state='active'").run(tool,at,error===null?null:String(error).slice(0,200),workspace?1:0,at,id,subject,worker);
  }); }
  static toolActivity(c) { return {acquisition_id:c.acquisition_id??null,tool_calls:c.tool_calls??0,last_tool:c.last_tool??null,last_tool_at:c.last_tool_at??null,last_tool_error:c.last_tool_error??null,first_workspace_tool_at:c.first_workspace_tool_at??null}; }
  // For example: "lease_expired: <calls>, last <tool> at <time>, no workspace tool".
  static expirySummary(c) {
    const a=Store.toolActivity(c), t=x=>x.slice(11,19)+'Z';
    return `lease_expired: ${a.tool_calls} call${a.tool_calls===1?'':'s'}${a.last_tool?`, last ${a.last_tool} at ${t(a.last_tool_at)}`:''}${a.first_workspace_tool_at?`, first workspace tool at ${t(a.first_workspace_tool_at)}`:', no workspace tool'}${a.last_tool_error?`, last error: ${a.last_tool_error.slice(0,80)}`:''}`;
  }
  failureFields(id) {
    const a=this.db.prepare('SELECT status,cancelled_reason FROM assignments WHERE request_id=?').get(id);
    if(!a) return {failure_type:'unknown',failure_type_source:'unknown'};
    const report=this.db.prepare('SELECT outcome,summary,result FROM reports WHERE request_id=?').get(id);
    const failedReport=!!report&&report.outcome!=='completed';
    const checkFailedObserved=!!this.db.prepare("SELECT 1 FROM lifecycle_events WHERE request_id=? AND type='check_failed' LIMIT 1").get(id);
    if(a.status!=='cancelled'&&!failedReport) return {failure_type:null,failure_type_source:null,check_failed_observed:checkFailedObserved};
    const cancelActor=a.status==='cancelled'?this.db.prepare("SELECT actor FROM lifecycle_events WHERE request_id=? AND type='cancelled' ORDER BY id DESC LIMIT 1").get(id)?.actor:null;
    const observed=observeTransition({status:a.status,reason:a.cancelled_reason,cancelActor,
      leaseExpired:a.status==='cancelled'&&!!this.db.prepare("SELECT 1 FROM lifecycle_events WHERE request_id=? AND type='abandoned' AND actor='system' AND reason LIKE 'lease_expired%' LIMIT 1").get(id)});
    const inferred=report?inferWorkerReport(report):null;
    const result=observed??inferred;
    return result?{failure_type:result.type,failure_type_source:result.source,check_failed_observed:checkFailedObserved}:{failure_type:'unknown',failure_type_source:'unknown',check_failed_observed:checkFailedObserved};
  }
  claimLeaseMs(claim) { return claim.lease_ms??this.limits.leaseMs; }
  leaseMonotonicDeadline(claim) {
    const deadline=Number(claim.lease_deadline_monotonic_ms);
    return this.leaseBootId&&claim.lease_boot_id===this.leaseBootId&&Number.isFinite(deadline)?deadline:null;
  }
  leaseDeadlineClockMs(claim) {
    const deadline=this.leaseMonotonicDeadline(claim);
    return deadline===null?Date.parse(this.leaseExpiresAt(claim)):Math.floor(this.nowMs()+deadline-this.monotonicNow());
  }
  leaseExpiresAt(claim) { return claim.lease_deadline_at??new Date(Date.parse(claim.last_claim_activity_at??claim.claimed_at)+this.claimLeaseMs(claim)).toISOString(); }
  // True while a claim idle since before this process started is inside its post-start window (start + its own lease).
  heldAfterStart(claim) {
    const activity=Date.parse(claim.activity??claim.last_claim_activity_at??claim.claimed_at);
    return activity<this.startedMs&&this.nowMs()<this.startedMs+this.claimLeaseMs(claim);
  }
  leaseExpired(claim) {
    const deadline=this.leaseMonotonicDeadline(claim);
    return deadline===null?this.nowMs()>=Date.parse(this.leaseExpiresAt(claim)):this.monotonicNow()>=deadline;
  }
  // A revoked grant cannot authorize a successor until its deadline and all
  // host effect channels have stopped. Unknown stop evidence fails closed.
  assertRegrantReady(claim) {
    if(!this.leaseExpired(claim)) throw new Error('claim_busy: prior lease has not expired');
    if(this.db.prepare("SELECT 1 FROM check_jobs WHERE request_id=? AND (status='running' OR stop_verified IS NOT 1) LIMIT 1").get(claim.request_id)) {
      throw new Error('claim_effects_unverified: prior host work has not verifiably stopped');
    }
  }
  // Deliveries that may already have reached a destination. Reclaim and abandon wait while this notice is uncertain or sending.
  // Aging ends automatic retries, not the authority fence: a terminal unknown can still land late.
  // Owner-facing deliveries only: a webhook availability event in flight is not a result that may have reached the owner.
  // A break notice is no result and never holds a claim or a re-wake back.
  uncertainDeliveries(id) {
    const notices=this.db.prepare("SELECT count(*) n FROM notifications WHERE request_id=? AND kind NOT IN ('event','break') AND state IN ('uncertain','sending','uncertain_terminal','waiting')").get(id).n;
    const questions=this.db.prepare(`SELECT count(*) n FROM protocol_delivery_attempts p
      JOIN durable_waiter_deliveries d USING(delivery_id)
      WHERE d.job=? AND d.acknowledged_at IS NULL AND p.state IN ('sending','unknown')
      AND json_extract(d.fact,'$.type')='questioned'`).get(id).n;
    return notices+questions;
  }
  assertNoUncertainDelivery(id) { if(this.uncertainDeliveries(id)) throw new Error('uncertain_delivery: reconcile first'); }
  // A new claim_id carries the worktree and the SEALED uploads over (artifacts keep origin_claim_id and origin_epoch); check jobs, check runs and their outputs keep the claim_id they ran under.
  // Unsealed staging stays bound to the old claim: it cannot be continued, cited or sealed. Its client alias is released (client_artifact_id NULL)
  // so the new epoch can upload a fresh artifact under the same alias. The old row and its bytes stay as evidence until retention cleanup removes them.
  rebindClaim(id,claimId) {
    // Called only after an actual epoch change, inside the claim transaction.
    // Retire only typed worker questions, not owner wait messages, result receipts,
    // watches or break notices. Generation fields, never timestamps, fence them.
    this.db.prepare(`UPDATE notifications SET state='suppressed',last_error='claim epoch superseded question'
      WHERE request_id=? AND kind IN ('blocker','wait') AND state IN ('pending','failed')
        AND CASE WHEN json_valid(body) THEN
          json_type(body,'$.note')='text' AND json_type(body,'$.epoch')='integer'
          AND json_type(body,'$.owner_note_seq')='integer'
          AND json_extract(body,'$.epoch')>=1
          AND json_extract(body,'$.epoch')<(SELECT epoch FROM claims WHERE request_id=? AND claim_id=?)
        ELSE 0 END`).run(id,id,claimId);
    // The worktree is not an artifact: it is mutable working state the new epoch is meant to continue, so it moves with the claim.
    this.db.prepare('UPDATE workspaces SET claim_id=? WHERE request_id=?').run(claimId,id);
    // Release only mutable alias heads; immutable upload history and old bytes stay.
    this.db.prepare('DELETE FROM artifact_journal_heads WHERE job=? AND sealed=0 AND origin_claim<>?').run(id,claimId);
    this.db.prepare("UPDATE artifacts SET client_artifact_id=NULL WHERE request_id=? AND kind='upload' AND claim_id<>? AND NOT (sealed=1 AND sha256 IS NOT NULL)").run(id,claimId);
    this.db.prepare("UPDATE artifacts SET claim_id=? WHERE request_id=? AND kind='upload' AND sealed=1 AND sha256 IS NOT NULL").run(claimId,id);
  }
  // Sealed uploads of an assignment. inherited is true when an earlier epoch created the upload and a later claim now holds it.
  sealedUploads(id,{clientIds=false}={}) {
    const epoch=this.db.prepare('SELECT epoch FROM claims WHERE request_id=?').get(id)?.epoch??null;
    return this.db.prepare(`SELECT ${clientIds?'COALESCE(client_artifact_id,id)':'id'} id,size,sha256,origin_claim_id,origin_epoch FROM artifacts WHERE request_id=? AND kind='upload' AND sealed=1`).all(id)
      .map(r=>({...r,inherited:r.origin_epoch!==null&&epoch!==null&&r.origin_epoch<epoch}));
  }
  // Claimed assignments of this subject with owner notes the claimant has not yet read through get or claim.
  attention(subject,worker='dot') {
    return this.db.prepare(`SELECT c.request_id,count(n.sequence) note_count FROM claims c JOIN assignments a USING(request_id) JOIN owner_notes n ON n.request_id=c.request_id AND n.sequence>c.last_seen_note_seq
      WHERE c.subject=? AND c.worker=? AND a.status='claimed' AND c.state='active' GROUP BY c.request_id ORDER BY min(n.sequence)`).all(subject,worker).filter(x=>this.mayAct(worker,x.request_id)).map(x=>({request_id:x.request_id,note_count:Number(x.note_count)}));
  }
  denialNotes() {
    const cursor=name=>this.db.prepare('SELECT value FROM alert_cursors WHERE name=?').get(name).value;
    const progress=this.db.prepare('SELECT id,note text FROM progress WHERE id>? ORDER BY id').all(cursor('denial_progress'));
    const reports=this.db.prepare('SELECT rowid id,summary text FROM reports WHERE rowid>? ORDER BY rowid').all(cursor('denial_report'));
    return {matches:[...progress,...reports].filter(x=>denialPattern.test(x.text)).map(x=>x.text),progressMax:progress.at(-1)?.id,reportMax:reports.at(-1)?.id};
  }
  ackDenialNotes({progressMax,reportMax}) {
    const set=this.db.prepare('UPDATE alert_cursors SET value=? WHERE name=?');
    if(progressMax!==undefined) set.run(progressMax,'denial_progress');
    if(reportMax!==undefined) set.run(reportMax,'denial_report');
  }
  // Flat queue re-wake. Per active subscription, each tick queues at most one ordinary availability event (wake_kind
  // 'rewake'), and only when the subscription's principal has a free lane, no assignment wake (submit or rewake) for the
  // subscription is pending, sending or failed (a failed one is being retried, at most a minute apart, and that retry is the
  // wake), the last wake that went out to it (submit, rewake or owner note; delivered or sending; a suppressed one woke
  // nobody) is at least rewakeMs old, and some queued item is eligible (rewakeCandidates). Message events and owner notes
  // never hold it back through pending or failed rows. The event names the first eligible item in list_pending order (the
  // oldest, normal work first) and says how many lanes are free; it marks nothing else delivered and touches no other row. startAttempt checks it again before it is sent.
  reannounceQueued(limits=this.limits) { return this.transaction(() => {
    // A lane freed since the last tick (laneFreed) waives the rewakeMs cadence once; every other gate below still applies.
    const dispatchNow=this.dispatchWake; this.dispatchWake=false;
    if (this.paused()||!this.db.prepare("SELECT 1 FROM assignments WHERE status='queued'").get()) return {announced:0};
    const now=this.nowMs(), rewakeMs=dispatchNow?0:limits.rewakeMs??defaultRedeliveryLimits.rewakeMs;
    // During an owner-confirmed usage break the only re-wake is one probe every breakProbeMs (first one breakProbeMs after
    // since). An inferred break is silence, not evidence, so it does not pace re-wakes.
    const brk=this.holdingBreak();
    let probe=false,heldBreak=false,heldCapacity=false;
    const outstanding=this.db.prepare("SELECT 1 FROM notifications WHERE subscription_id=? AND state IN ('pending','sending','failed') AND wake_kind IN ('submit','rewake') LIMIT 1");
    const lastWake=this.db.prepare(`SELECT max(at) at FROM (SELECT max(COALESCE(attempt_started_at,created_at)) at FROM notifications WHERE subscription_id=?1 AND state='delivered' AND wake_kind IN ('submit','rewake','owner_note')
      UNION ALL SELECT max(COALESCE(attempt_started_at,created_at)) FROM notifications WHERE subscription_id=?1 AND state='sending' AND wake_kind IN ('submit','rewake','owner_note'))`);
    let announced=0;
    for (const sub of this.activeSubscriptions()) {
      if(this.capacityHoldUntil(sub.worker)) {heldCapacity=true;continue;}
      if(sub.worker==='dot'&&brk&&(probe||now-Date.parse(brk.last_probe_at??brk.since)<(limits.breakProbeMs??defaultRedeliveryLimits.breakProbeMs))) {heldBreak=true;continue;}
      if(this.subscriptionFreeLanes(sub,limits.laneCapacity??6)<=0||outstanding.get(sub.id)) continue;
      const last=lastWake.get(sub.id).at;
      if(last&&rewakeMs&&now-Date.parse(last)<rewakeMs) continue;
      const eligible=this.rewakeCandidates(sub.id,limits);
      if(!eligible.length) continue;
      this.queueEvent(eligible[0].request_id,sub,true,this.queueHeadTitle(eligible,this.subscriptionFreeLanes(sub,limits.laneCapacity??6)),'rewake');
      announced++;
      if(brk&&sub.worker==='dot') { this.db.prepare('UPDATE worker_breaks SET last_probe_at=? WHERE id=?').run(this.stamp(),brk.id); probe=true; }
    }
    return {announced,...(probe?{probe:true}:{}),...(!announced&&heldBreak?{worker_break:true}:{}),...(!announced&&heldCapacity?{capacity_denied:true}:{})};
  }); }
  // Queued items a re-wake may name, in list_pending order: no uncertain or sending owner delivery (never re-wake those),
  // the latest assignment wake (submit or rewake; owner notes and messages do not count) for this subscription not rejected
  // by the callback with HTTP 410 or 413 (terminal), and, once queued rewakeWindowMs or longer, no wake delivered or sending
  // for the item in the last rewakeStaleMs (a backoff: a stale item stays eligible but is re-woken rarely).
  rewakeCandidates(subscriptionId,limits=this.limits) {
    const now=this.nowMs(), windowMs=limits.rewakeWindowMs??defaultRedeliveryLimits.rewakeWindowMs, staleMs=limits.rewakeStaleMs??defaultRedeliveryLimits.rewakeStaleMs, breaks=this.breakIntervals();
    const latest=this.db.prepare("SELECT state,last_error FROM notifications WHERE request_id=? AND subscription_id=? AND wake_kind IN ('submit','rewake') ORDER BY created_at DESC, rowid DESC LIMIT 1");
    const lastSent=this.db.prepare("SELECT max(COALESCE(attempt_started_at,created_at)) at FROM notifications WHERE request_id=? AND subscription_id=? AND state IN ('delivered','sending') AND wake_kind IN ('submit','rewake')");
    const sub=this.db.prepare('SELECT * FROM subscriptions WHERE id=?').get(subscriptionId);
    if(!sub||!this.subscriptionVisible(sub)) return [];
    const denied=new Set(this.deniedQueued(sub.worker).map(d=>d.request_id));
    return this.queuedRows().filter(row=>{
      if(!this.mayAct(sub.worker,row.request_id)||denied.has(row.request_id)||this.uncertainDeliveries(row.request_id)) return false;
      const event=latest.get(row.request_id,subscriptionId);
      if(event?.state==='suppressed'&&/^HTTP 41[03]$/.test(event.last_error??'')) return false;
      if(this.queuedAgeMs(row.queued_at,now,sub.worker==='dot'?breaks:[])<windowMs) return true;
      const sent=lastSent.get(row.request_id,subscriptionId).at;
      return !sent||now-Date.parse(sent)>=staleMs;
    });
  }
  // Why a queued re-wake must not be sent now, or null. Its eligibility was decided when it was queued; drain may send it
  // later, after the head was claimed, a delivery for it turned uncertain or the last free lane filled.
  rewakeStale(row) {
    const sub=this.db.prepare("SELECT * FROM subscriptions WHERE id=? AND state='active' AND expires_at>?").get(row.subscription_id,this.stamp());
    if(!sub||!this.subscriptionVisible(sub)) return 'subscription inactive';
    if(this.subscriptionFreeLanes(sub)<=0) return 'no free lane';
    if(this.capacityHoldUntil(sub.worker)) return 'the worker reported a capacity denial; waiting for a slot';
    if(!this.rewakeCandidates(row.subscription_id).some(x=>x.request_id===row.request_id)) return 'head no longer eligible';
    return null;
  }
  subscribe(id, url, secret, expires, principal='local-principal',worker='dot',connection=null) {
    const old=this.db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id);
    if(old&&old.worker!==worker) throw new Error('subscription worker conflict');
    if(connection&&resolveWorker(this.workers,connection)!==worker) throw new Error('subscription connection conflict');
    if(connection?.builtin&&(!this.connectionIsLive||!this.connectionIsLive(connection.connection_id))) throw new Error('subscription connection inactive');
    const recordedConnection=connection?JSON.stringify(canonical(connection)):null;
    const replacing=old&&(old.connection?JSON.stringify(canonical(this.subscriptionConnection(old))):null)!==recordedConnection;
    if(replacing&&(!connection||old.principal!==principal||old.url!==url)) throw new Error('subscription identity conflict');
    if (old && this.subscriptionSecret(old)!==secret) {
      const pending=this.db.prepare("SELECT count(*) n FROM notifications WHERE subscription_id=? AND state IN ('pending','sending','failed')").get(id).n;
      if (pending) {
        this.db.prepare('UPDATE subscriptions SET rotation_blocked=1 WHERE id=?').run(id);
        throw Object.assign(new Error('signing_key_rotation_blocked'), { pending });
      }
    }
    return this.transaction(() => {
    if(replacing) {
      // A verified re-subscribe creates a new row for the same worker, never updates an immutable connection.
      // Retire unsent events before replaying the queue for the new connection under the stable subscription ID.
      this.db.prepare("UPDATE notifications SET state='suppressed',last_error='subscription connection replaced' WHERE subscription_id=? AND state IN ('pending','sending','failed')").run(id);
      this.db.prepare('DELETE FROM assignment_reannouncements WHERE subscription_id=?').run(id);
      this.db.prepare('DELETE FROM subscriptions WHERE id=?').run(id);
    }
    this.db.prepare(`INSERT INTO subscriptions(id,principal,url,args,secret,expires_at,verified_at,state,rotation_blocked,worker,connection) VALUES(?,? ,?,'{}',?,?,?,'active',0,?,?)
      ON CONFLICT(id) DO UPDATE SET secret=excluded.secret,expires_at=excluded.expires_at,verified_at=excluded.verified_at,state='active',auth_failures=0,rotation_blocked=0`).run(id,principal,url,this.sealSubscription(id, 'secret', secret),expires,this.stamp(),worker,recordedConnection === null ? null : this.sealSubscription(id, 'connection', recordedConnection));
    const queued=this.db.prepare("SELECT request_id FROM assignments WHERE status='queued' ORDER BY created_at").all();
    for (const row of queued) if(!this.uncertainDeliveries(row.request_id)) this.queueEvent(row.request_id,{id},true);
    for (const row of this.db.prepare("SELECT message_id,preview FROM messages WHERE status='pending' ORDER BY created_at").all()) {
      const existing=this.db.prepare("SELECT 1 FROM notifications WHERE message_id=? AND subscription_id=? AND state IN ('pending','sending','failed','delivered')").get(row.message_id,id);
      if(!existing) this.queueMessageEvent(row.message_id,row.preview,{id});
    }
  }); }
  unsubscribe(id) { return this.transaction(() => {
    this.db.prepare("UPDATE subscriptions SET state='revoked' WHERE id=?").run(id);
    this.db.prepare("UPDATE notifications SET state='suppressed',last_error='subscription revoked' WHERE subscription_id=? AND state IN ('pending','failed')").run(id);
  }); }
  get(id) {
    const a=this.db.prepare('SELECT * FROM assignments WHERE request_id=?').get(id); if(!a) throw new Error('assignment not found');
    this.assertProtocolAvailable(id);
    const claimRow=this.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id);
    const claim=claimRow&&(({acquisition_id,tool_calls,last_tool,last_tool_at,last_tool_error,first_workspace_tool_at,destination_revision,...rest})=>({...rest,...(destination_revision?{destination_revision}:{}),lease_expires_at:this.leaseExpiresAt(claimRow),activity:Store.toolActivity(claimRow)}))(claimRow);
    const report=this.db.prepare('SELECT * FROM reports WHERE request_id=?').get(id);
    if(report?.workspace_evidence) report.workspace_evidence=JSON.parse(report.workspace_evidence);
    // Everything in a report is the worker's own statement. Only a check row carries bridge_verified, and only when the bridge ran it.
    if(report) { report.trust=TRUST.worker; Object.assign(report,Store.resultAuthority(!!report.late)); }
    const lateRow=this.db.prepare('SELECT summary,truncated,full_sha256,created_at FROM late_evidence WHERE request_id=? ORDER BY created_at LIMIT 1').get(id);
    const late_evidence=lateRow?{...lateRow,truncated:!!lateRow.truncated}:null;
    const progress=this.db.prepare('SELECT note,created_at FROM progress WHERE request_id=? ORDER BY id').all(id);
    const delivery=this.db.prepare('SELECT id,kind,state,attempts,last_error,argv,attempt_started_at,attempt_id,last_reconciled_at,uncertain_reason,terminal_at,terminal_reason FROM notifications WHERE request_id=? ORDER BY created_at').all(id).map(n=>({...n,argv:n.argv?JSON.parse(n.argv):null}));
    const watch=this.db.prepare('SELECT deadline,state,updated_at,notification_id FROM watches WHERE request_id=?').get(id) || null;
    const supersedes=this.db.prepare('SELECT target_id AS request_id,created_at FROM submit_supersedes WHERE request_id=?').get(id)??null;
    const superseded_by=this.db.prepare('SELECT request_id,created_at FROM submit_supersedes WHERE target_id=?').get(id)??null;
    const authorityRevoked=!!a.cancelled_at||this.isProtocolJob(id)&&a.status==='finished';
    return {...this.destinationFields(id),request_id:id,supersedes,superseded_by,target_worker:a.target_worker,assignment:JSON.parse(a.payload),delivery_mode:a.delivery,t3_muted:this.deliveryMuted(id),thread_id:a.thread_id||null,environment_id:a.environment_id||null,status:a.status,execution:a.execution,required_capabilities:a.required_capabilities?JSON.parse(a.required_capabilities):[],review:!!a.review,created_at:a.created_at,valid_until:a.valid_until??null,valid_until_source:a.valid_until_source??null,expiry_requeues:a.expiry_requeues??0,...this.failureFields(id),cancelled_at:a.cancelled_at,cancelled_reason:a.cancelled_reason??null,cancellation_requested:!!a.cancelled_at,authority_revoked:authorityRevoked,...this.sandboxStop(id,authorityRevoked),claim,progress,lifecycle_events:this.db.prepare("SELECT type,at,actor,reason FROM lifecycle_events WHERE request_id=? ORDER BY id").all(id),report:report??null,late_evidence,delivery,watch,owner_notes:this.ownerNotes(id),worker_break_notices:this.breakNotices(id),claim_denied:this.claimDenial(id),skipped_by_worker:a.skipped_at?{at:a.skipped_at,listed_count:a.listed_count,passed_over:a.passed_over}:null,pr_preflights:this.db.prepare("SELECT phase,evidence FROM pr_preflights WHERE request_id=? ORDER BY CASE phase WHEN 'submit' THEN 0 ELSE 1 END").all(id).map(row=>({phase:row.phase,...JSON.parse(row.evidence)}))};
  }
  recordPrPreflight(id,phase,assignment,evidence,replace=false) {
    assertPreflight(assignment,evidence,this.nowMs());
    if(evidence) this.db.prepare(`INSERT ${replace?'OR REPLACE ':''}INTO pr_preflights(request_id,phase,evidence) VALUES(?,?,?)`).run(id,phase,JSON.stringify(evidence));
  }
  hasAssignment(id) { return !!this.db.prepare('SELECT 1 FROM assignments WHERE request_id=?').get(id); }
  ownerNotes(id) { return this.db.prepare('SELECT id,at,text FROM owner_notes WHERE request_id=? ORDER BY sequence').all(id); }
  questions(id) { this.assertProtocolAvailable(id);return this.db.prepare('SELECT * FROM job_questions WHERE request_id=? ORDER BY rowid').all(id); }
  askQuestion(id,claimId,questionId,text,subject='local-principal',worker='dot',ctx=null,connectionId=null) {
    validateQuestion(questionId,text);
    return this.progress(id,claimId,`QUESTION: ${text}`,subject,false,worker,{questionId,text},ctx,connectionId);
  }
  assertQuestionGrant(id,question) {
    const claim=this.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id);
    if(!claim||claim.state!=='active'||claim.claim_id!==question.claim_id||claim.epoch!==question.epoch) throw questionError('STALE_EPOCH','question belongs to an earlier grant. Ask the worker to claim or continue this assignment and ask a new question with a new ID; then answer that new question.');
    try { return this.assertClaim(id,question.claim_id,question.subject,question.worker); }
    catch(error) {
      let refusal;try{refusal=JSON.parse(error.message);}catch{throw error;}
      if(refusal.error!=='lease_expired') throw error;
      throw new Error(JSON.stringify({...refusal,message:`The lease for question ${question.question_id} on ${id} expired. Ask the worker to reclaim this assignment and ask a new question with a new ID; then answer that new question. This unanswered question remains an audit fact and grants no authority.`}));
    }
  }
  answerQuestion(id,questionId,text,ctx=null,ownerToken=null) {
    return this.isProtocolJob(id)?answerProtocolQuestion(this,id,questionId,text,ownerToken,ctx):this.transaction(()=>this.answerQuestionInTransaction(id,questionId,text));
  }
  answerQuestionInTransaction(id,questionId,text) {
    if(!this.db.isTransaction)protocolError('transaction_required');
    validateQuestion(questionId,text);
    const assignment=this.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(id);
    if(!assignment) throw new Error('assignment not found');
    if(['finished','cancelled'].includes(assignment.status)) throw questionError('TERMINAL','assignment is terminal');
    const question=this.db.prepare('SELECT * FROM job_questions WHERE request_id=? AND question_id=?').get(id,questionId);
    if(!question) throw questionError('NO_QUESTION','question does not exist');
    const claim=this.assertQuestionGrant(id,question);
    if(question.answered_at!==null) throw questionError('ALREADY_ANSWERED','question already has an answer');
    this.db.prepare('UPDATE job_questions SET answer=?,answered_at=? WHERE request_id=? AND question_id=?').run(text,this.stamp(),id,questionId);
    this.lifecycle(id,'waiting','owner',`question:answer:${questionId}`,claim);
    this.db.prepare(`UPDATE notifications SET state='suppressed',last_error='structured question answered'
      WHERE request_id=? AND kind IN ('blocker','wait') AND state IN ('pending','failed','waiting')
      AND CASE WHEN json_valid(body) THEN json_extract(body,'$.question_id') END=?
      AND CASE WHEN json_valid(body) THEN json_extract(body,'$.epoch') END=?`).run(id,questionId,claim.epoch);
    for(const sub of this.activeSubscriptions().filter(sub=>sub.worker===claim.worker&&this.mayAct(sub.worker,id))) {
      const eventId=`evt_${randomUUID()}`;
      const body=JSON.stringify({eventId,name:'assignment.available',timestamp:this.stamp(),data:{request_id:id,title:`Answer available for question ${questionId}`},cursor:null});
      this.db.prepare("INSERT INTO notifications(id,kind,request_id,subscription_id,body,created_at,wake_kind) VALUES(?,'event',?,?,?,?,'owner_note')").run(eventId,id,sub.id,body,this.stamp());
      this.db.prepare('INSERT INTO question_answer_wakes(notification_id,request_id,question_id,epoch) VALUES(?,?,?,?)').run(eventId,id,questionId,claim.epoch);
    }
    return {request_id:id,question_id:questionId,answered:true};
  }
  consumeAnswer(id,claimId,questionId,subject='local-principal',worker='dot',ctx=null,connectionId=null) { return this.transaction(()=>{
    if(!this.isProtocolJob(id)) {
      this.assertMutationConnection(id,this.assertClaim(id,claimId,subject,worker),connectionId);
      return this.consumeAnswerInTransaction(id,claimId,questionId,subject,worker);
    }
    const receipt=this.protocolMutationInTransaction(id,claimId,subject,worker,{...ctx,operation:'consume',args:{question_id:questionId}},()=>{
      const result=this.consumeAnswerInTransaction(id,claimId,questionId,subject,worker);
      if(result.duplicate) protocolError('answer_already_consumed');
      this.protocolEventInTransaction(id,'consumed',{question_id:questionId},this.assertClaim(id,claimId,subject,worker).epoch);
      return result;
    },connectionId);
    return {...receipt.value,revision:receipt.revision};
  }); }
  consumeAnswerInTransaction(id,claimId,questionId,subject='local-principal',worker='dot') {
    if(!this.db.isTransaction)protocolError('transaction_required');
    validateQuestion(questionId);
    const claim=this.assertClaim(id,claimId,subject,worker);
    const assignment=this.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(id);
    if(['finished','cancelled'].includes(assignment?.status)) throw questionError('TERMINAL','assignment is terminal');
    const question=this.db.prepare('SELECT * FROM job_questions WHERE request_id=? AND question_id=?').get(id,questionId);
    if(!question) throw questionError('NO_QUESTION','question does not exist');
    if(question.claim_id!==claim.claim_id||question.epoch!==claim.epoch) throw questionError('STALE_EPOCH','question belongs to an earlier grant');
    if(question.answered_at===null) throw questionError('NO_ANSWER','question has not been answered');
    const duplicate=question.consumed_at!==null;
    if(!duplicate) {
      this.db.prepare('UPDATE job_questions SET consumed_at=? WHERE request_id=? AND question_id=?').run(this.stamp(),id,questionId);
      this.lifecycle(id,'working',`worker:${subject}`,`question:consume:${questionId}`,claim);
    }
    return {question_id:questionId,answer:question.answer,duplicate};
  }
  assertQuestionsResolved(id,claimId,outcome='completed') {
    if(['blocked','failed'].includes(outcome)) return true;
    const assignment=this.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(id);
    if(assignment?.status==='cancelled') return true; // Preserve late evidence after cancellation.
    if(this.db.prepare('SELECT 1 FROM job_questions WHERE request_id=? AND claim_id=? AND consumed_at IS NULL').get(id,claimId)) throw questionError('QUESTION_OPEN','consume the current grant\'s outstanding answers before finishing');
    return true;
  }
  questionWakeCurrent(row) {
    if(row.kind!=='event'||row.wake_kind!=='owner_note') return true;
    const wake=this.db.prepare('SELECT * FROM question_answer_wakes WHERE notification_id=?').get(row.id);
    if(!wake) return true;
    const assignment=this.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(wake.request_id);
    if(assignment?.status!=='claimed') return false;
    const question=this.db.prepare('SELECT * FROM job_questions WHERE request_id=? AND question_id=?').get(wake.request_id,wake.question_id);
    if(!question||question.answered_at===null||question.consumed_at!==null||question.epoch!==wake.epoch) return false;
    try { this.assertQuestionGrant(row.request_id,question);return true; } catch { return false; }
  }
  note(id,text) { return this.transaction(() => {
    this.assertProtocolAvailable(id);
    validateOwnerNote(text,this.ownerNotes(id));
    const assignment=this.db.prepare('SELECT payload FROM assignments WHERE request_id=?').get(id);
    if(!assignment) throw new Error('assignment not found');
    const note={id:`note_${randomUUID()}`,at:this.stamp(),text};
    this.db.prepare('INSERT INTO owner_notes(id,request_id,at,text) VALUES(?,?,?,?)').run(note.id,id,note.at,note.text);
    for(const sub of this.activeSubscriptions().filter(sub=>this.mayAct(sub.worker,id))) {
      const eventId=`evt_${randomUUID()}`;
      const body=JSON.stringify({eventId,name:'assignment.available',timestamp:this.stamp(),data:{request_id:id,title:`Owner note ${note.id}: `+JSON.parse(assignment.payload).brief.slice(0,120)},cursor:null});
      this.db.prepare("INSERT INTO notifications(id,kind,request_id,subscription_id,body,created_at,wake_kind) VALUES(?,?,?,?,?,?,'owner_note')").run(eventId,'event',id,sub.id,body,this.stamp());
    }
    return {request_id:id,...note};
  }); }
  tell(text,worker='dot') { return this.transaction(() => {
    if(worker==='pool') throw new Error('worker \"pool\" is not supported');
    const messageId=`msg_${randomUUID()}`, preview=text.slice(0,200), createdAt=this.stamp();
    this.db.prepare('INSERT INTO messages(message_id,text,text_sha256,preview,created_at,target_worker) VALUES(?,?,?,?,?,?)').run(messageId,text,hash(text),preview,createdAt,worker);
    for(const sub of this.activeSubscriptions()) this.queueMessageEvent(messageId,preview,sub);
    return {message_id:messageId,status:'pending',created_at:createdAt,text_sha256:hash(text),preview};
  }); }
  queueMessageEvent(messageId,title,sub) {
    sub=this.db.prepare('SELECT * FROM subscriptions WHERE id=?').get(sub.id);
    if(!this.subscriptionActive(sub)||!this.mayAct(sub.worker,messageId)) return null;
    const eventId=`evt_${randomUUID()}`;
    const body=JSON.stringify({eventId,name:'assignment.available',timestamp:this.stamp(),data:{message_id:messageId,title},cursor:null});
    this.db.prepare("INSERT INTO notifications(id,kind,request_id,message_id,subscription_id,body,created_at,wake_kind) VALUES(?,?,?,?,?,?,?,'message')").run(eventId,'event',null,messageId,sub.id,body,this.stamp());
    return eventId;
  }
  untell(id,worker=null) { return this.transaction(() => {
    const row=this.getMessage(id,worker);
    if(row.status==='acknowledged') throw new Error('message already acknowledged');
    if(row.status!=='withdrawn') {
      this.db.prepare("UPDATE messages SET status='withdrawn' WHERE message_id=?").run(id);
      this.db.prepare("UPDATE notifications SET state='suppressed',last_error='message withdrawn' WHERE message_id=? AND state IN ('pending','failed')").run(id);
    }
    return this.getMessage(id);
  }); }
  listMessages(worker='dot') { return this.db.prepare("SELECT message_id,preview,created_at FROM messages WHERE status='pending' ORDER BY created_at").all().filter(r=>this.mayAct(worker,r.message_id)).slice(0,50); }
  getMessage(id,worker=null) {
    if(worker!==null&&!this.mayAct(worker,id)) throw new Error('message not found');
    const row=this.db.prepare('SELECT message_id,text,text_sha256,preview,status,created_at,acknowledged_at FROM messages WHERE message_id=?').get(id);
    if(!row) throw new Error('message not found');
    return row;
  }
  ackMessage(id,worker='dot') { return this.transaction(() => {
    if(!this.mayAct(worker,id)) throw new Error('message not found');
    const row=this.db.prepare('SELECT status FROM messages WHERE message_id=?').get(id);
    if(!row) throw new Error('message not found');
    if(row.status==='withdrawn') throw new Error('message withdrawn');
    if(row.status!=='acknowledged') this.db.prepare("UPDATE messages SET status='acknowledged',acknowledged_at=? WHERE message_id=?").run(this.stamp(),id);
    return this.getMessage(id);
  }); }
  // Resume wake. DALAN_RESUME_IDLE_MS (default 120000; 0 disables everything below). A claim is idle when its holder made no
  // claim-bearing call (progress, workspace tools, finish, a repeated claim) for that long. last_claim_activity_at is the clock, not
  // last_tool_at: a read-only get names no claim_id and must not end the idle state before the resuming run calls claim.
  resumeIdleMs() {
    if(this.resumeIdleOption!==undefined) return this.resumeIdleOption;
    const raw=readEnv('DALAN_RESUME_IDLE_MS');
    if(raw===undefined||raw==='') return defaultResumeIdleMs;
    const n=Number(raw);
    return Number.isInteger(n)&&n>=0?n:defaultResumeIdleMs;
  }
  claimIdleMs(c) { return this.nowMs()-Date.parse(c.last_claim_activity_at??c.claimed_at); }
  // A running check is one long tool call: the claim is busy while it runs, so it is never idle (a resume would fence it).
  isIdleClaim(c) { const limit=this.resumeIdleMs(); return limit>0&&this.leaseExpired(c)&&this.claimIdleMs(c)>=limit&&!this.db.prepare("SELECT 1 FROM check_jobs WHERE request_id=? AND status='running' LIMIT 1").get(c.request_id); }
  // This worker's expired claims, eligible only after verified host cessation.
  idleClaims(worker) {
    if(this.resumeIdleMs()<=0) return [];
    return this.db.prepare("SELECT c.* FROM claims c JOIN assignments a USING(request_id) WHERE a.status='claimed' AND a.cancelled_at IS NULL AND c.state='active' AND c.worker=? ORDER BY c.last_claim_activity_at").all(worker).filter(c=>this.isIdleClaim(c));
  }
  guidanceFor(worker) { return this.workers.workers.get(worker)?.guidance==='resume'?`${workerGuidance} ${resumeNudge(this.resumeIdleMs()||defaultResumeIdleMs)}`:workerGuidance; }
  // Owner messages first (oldest first), then assignments in LIST_ORDER: normal before background, items the worker skipped last.
  // One bit for the public wake signal: a queued, live, uncancelled assignment targets one of these workers.
  hasQueuedFor(workerNames) {
    if(!workerNames.length) return false;
    return !!this.db.prepare(`SELECT 1 FROM assignments WHERE status='queued' AND cancelled_at IS NULL AND ${live(this.nowMs())} AND target_worker IN (${workerNames.map(()=>'?').join(',')}) LIMIT 1`).get(...workerNames);
  }
  // Wake bit: queued work, or an expired own claim ready for regrant.
  hasWakeFor(worker) { return this.hasQueuedFor([worker])||this.idleClaims(worker).length>0; }
  listPending(worker='dot') {
    // Recheck historical refusals against one lazily loaded configuration per listing.
    // Listing is read-only: it neither deletes audit evidence nor grants approval.
    let loaded=false,failed=false,profile,loadError;
    const fail=error=>{ failed=true; loadError=error??new Error('destination configuration could not be loaded'); };
    const resolve=()=>{
      if(!loaded) {
        loaded=true;
        try {
          profile=this.destinationProfile();
          // An asynchronous resolver is invalid; its rejection must not surface as an unhandled one.
          if(profile&&typeof profile.then==='function') { Promise.resolve(profile).catch(()=>{}); fail(new Error('destination resolver must be synchronous')); }
        } catch(error) { fail(error); }
      }
      if(failed)throw loadError;
      return profile;
    };
    const blocked=id=>{
      if(failed)return true; // a failed load is reported once per listing, whatever it threw or returned
      const row=this.db.prepare('SELECT payload,target_worker,execution FROM assignments WHERE request_id=?').get(id);
      const approval=this.destinationApproval(id);
      try {
        const current=this.destinationSnapshot(row.target_worker,row.execution,JSON.parse(row.payload),{required:!!approval,resolve});
        return !(!approval&&!current||approval&&current?.revision===approval.revision&&current.policy.allowed);
      } catch { return true; }
    };
    const assignments=this.db.prepare(`SELECT request_id,payload,created_at,EXISTS(SELECT 1 FROM destination_blocks b WHERE b.request_id=assignments.request_id) blocked FROM assignments WHERE status='queued' AND ${live(this.nowMs())} ORDER BY ${LIST_ORDER}`).all().filter(a=>this.mayAct(worker,a.request_id)&&this.protocolListingLive(a.request_id)).map(a=>({...a,blocked:!!a.blocked&&blocked(a.request_id)})).sort((a,b)=>Number(a.blocked)-Number(b.blocked)).slice(0,50).map(a=>({kind:'assignment',request_id:a.request_id,title:JSON.parse(a.payload).brief.slice(0,160),created_at:a.created_at,...(a.blocked?{blocked:true}:{})}));
    const messages=this.listMessages(worker).map(m=>({kind:'message',request_id:m.message_id,message_id:m.message_id,title:m.preview,created_at:m.created_at})).sort((a,b)=>a.created_at.localeCompare(b.created_at));
    const resumes=this.idleClaims(worker).filter(c=>this.protocolListingLive(c.request_id)).map(c=>({kind:'assignment',request_id:c.request_id,resume:true,idle_seconds:Math.floor(this.claimIdleMs(c)/1000),previous_epoch:c.epoch,
      ...(this.db.prepare('SELECT 1 FROM destination_blocks WHERE request_id=?').get(c.request_id)&&blocked(c.request_id)?{blocked:true}:{}),
      note:'The prior lease expired. Call claim(request_id, claimant, acquisition_id) to request a new epoch after old host work has verifiably stopped. Read progress and owner notes with get first.'}));
    return [...resumes,...messages,...assignments].sort((a,b)=>Number(!!a.blocked)-Number(!!b.blocked)).slice(0,50);
  }
  // Called for each list_pending answer to the worker: the first freeLanes assignments are the ones it could claim now. One that
  // is still there SKIP_AFTER_ELIGIBLE_MS after it first was, with no claim, is marked skipped_by_worker (and goes behind its
  // peers in LIST_ORDER). Every listed assignment is stamped as seen, which claim() uses to tell a pass-over from news.
  recordListed(listed,freeLanes,worker='dot') { return this.transaction(() => {
    const now=this.nowMs(), at=iso(now), cutoff=iso(now-LISTED_POLL_GAP_MS), due=iso(now-SKIP_AFTER_ELIGIBLE_MS);
    const assignments=listed.filter(x=>x.kind==='assignment'&&!x.blocked);
    const seen=this.db.prepare("UPDATE assignments SET last_seen_listed_at=? WHERE request_id=? AND status='queued'");
    for(const item of assignments) seen.run(at,item.request_id);
    if(freeLanes<=0) { for(const item of assignments) this.db.prepare("UPDATE assignments SET eligible_since=NULL WHERE request_id=?").run(item.request_id); return; }
    const touch=this.db.prepare("UPDATE assignments SET eligible_since=COALESCE(eligible_since,?1),listed_count=listed_count+(last_listed_at IS NULL OR last_listed_at<=?3),last_listed_at=CASE WHEN last_listed_at IS NULL OR last_listed_at<=?3 THEN ?1 ELSE last_listed_at END,skipped_at=CASE WHEN skipped_at IS NULL AND eligible_since IS NOT NULL AND eligible_since<=?4 THEN ?1 ELSE skipped_at END WHERE request_id=?2 AND status='queued'");
    for(const item of assignments.slice(0,freeLanes)) touch.run(at,item.request_id,cutoff,due);
  }); }
  // A claim of one assignment passes over every queued one listed before it that the worker saw a moment ago.
  recordPassedOver(claimedId,worker='dot') {
    const now=this.nowMs(), at=iso(now), seenAfter=iso(now-PASSED_SEEN_MS);
    const order=this.listPending(worker).filter(x=>x.kind==='assignment'&&!x.blocked).map(x=>x.request_id);
    const ahead=order.slice(0,Math.max(0,order.indexOf(claimedId)));
    const pass=this.db.prepare("UPDATE assignments SET passed_over=passed_over+1,skipped_at=CASE WHEN skipped_at IS NULL AND passed_over+1>=?3 THEN ?1 ELSE skipped_at END WHERE request_id=?2 AND status='queued' AND last_seen_listed_at>=?4");
    for(const id of ahead) pass.run(at,id,SKIP_AFTER_PASSED,seenAfter);
  }
  skippedByDot() { return this.db.prepare("SELECT request_id,skipped_at at,listed_count,passed_over FROM assignments WHERE status='queued' AND skipped_at IS NOT NULL ORDER BY skipped_at").all(); }
  // Built-in mode only: a fresh epoch is admitted only while the claimant's own
  // connection is in the worker's live set. The check runs synchronously inside
  // the admission transaction, after the server's awaited preflight/quiesce, so
  // a revoke that lands between token verification and admission is caught
  // here. Only stores without built-in liveness permit an omitted connection.
  // A legacy worker profile has no live-set callback; its authoritative
  // connectionIsLive callback still fences revoked built-in connections.
  assertLiveConnection(id,worker,connectionId) {
    if((connectionId===null||connectionId===undefined)&&typeof this.connectionIsLive!=='function')return;
    if(typeof connectionId!=='string'||!connectionId.trim())throw destinationError({error:'connection_not_live',request_id:id,
      message:'Claim refused: the claimant connection is not live.'});
    let profile=null;
    try {
      profile=typeof this.destinationProfile==='function'?this.destinationProfile():null;
      if(profile&&typeof profile.then==='function')throw new Error('destination resolver must be synchronous');
    } catch(error) {
      throw this.destinationConfigurationError(id,error);
    }
    if(typeof this.connectionIsLive==='function') {
      let active;
      try { active=this.connectionIsLive(connectionId); }
      catch(error) { throw this.destinationConfigurationError(id,error); }
      if(active!==true)throw destinationError({error:'connection_not_live',request_id:id,
        message:'Claim refused: the claimant connection is not live.'});
      if(profile?.legacy===true)return;
    }
    const live=profile?.builtinConnectionIds;
    if(typeof live!=='function')throw destinationError({error:'connection_not_live',request_id:id,
      message:'Claim refused: the worker live-connection set is unavailable.'});
    let ids;
    try { ids=live(worker); }
    catch(error) { throw this.destinationConfigurationError(id,error); }
    if(!Array.isArray(ids)||!ids.includes(connectionId))throw destinationError({error:'connection_not_live',request_id:id,
      message:'Claim refused: the claimant connection is not live.'});
  }
  // The live holder asking again with the claimant, subject and acquisition of its own grant.
  isExactClaimRetry(claim,claimant,subject,acquisitionId=null) {
    return claim?.state==='active'&&claim.claimant===claimant&&claim.subject===subject&&
      !this.leaseExpired(claim)&&claim.acquisition_id===acquisitionId;
  }
  // An exact retry (duplicate or native receipt replay) returns the grant the connection already holds. It is not a
  // new admission, so it does not re-run destination or repository policy; an owner edit between a lost reply and
  // its retry must not strand the holder. It needs the connection the grant was given to and, when the owner
  // approved a destination, the connection set that approval covered. Both checks use fixed text and write nothing:
  // a refusal here is not a destination-policy event. External OAuth presents no connection and records none.
  assertRetryConnection(id,claim,worker,connectionId) {
    this.assertLiveConnection(id,worker,connectionId);
    const refuse=message=>destinationError({error:'destination_changed',request_id:id,message});
    if(connectionId===null||connectionId===undefined) {
      if(claim.connection_id)throw refuse('Claim retry refused: this grant belongs to a built-in connection.');
      return;
    }
    // NULL is a grant made before the connection was recorded: it cannot be proved, so it is not recovered.
    if(claim.connection_id!==connectionId)throw refuse('Claim retry refused: this grant belongs to a different connection.');
    const approval=this.destinationApproval(id);
    if(!approval)return;
    let digest;
    try {
      if(typeof this.destinationProfile!=='function')throw new Error('destination resolver required');
      const profile=this.destinationProfile();
      if(profile&&typeof profile.then==='function')throw new Error('destination resolver must be synchronous');
      digest=connectionsDigest(profile,worker);
    } catch(error) { throw this.destinationConfigurationError(id,error); }
    if(digest!==approval.snapshot.connections_digest)throw refuse('Claim retry refused: the approved connection set changed.');
  }
  claim(id,claimant,subject='local-principal',capacity=1,preflight=null,worker='dot',acquisitionId=null,leaseMs=this.limits.leaseMs,ctx=null,connectionId=null) {
    const requestedLeaseMs=arguments[7]??null;
    return nonterminalOutcome(id,this.destinationOutcome(this.transaction(()=>this.isProtocolJob(id)
      ?this.protocolClaimInTransaction(id,claimant,subject,capacity,preflight,worker,acquisitionId,leaseMs,ctx?{...ctx,requestedLeaseMs}:ctx,connectionId)
      :this.claimInTransaction(id,claimant,subject,capacity,preflight,worker,acquisitionId,leaseMs,connectionId))));
  }
  claimInTransaction(id,claimant,subject='local-principal',capacity=1,preflight=null,worker='dot',acquisitionId=null,leaseMs=this.limits.leaseMs,connectionId=null) {
    if(!this.db.isTransaction)protocolError('transaction_required');
    if(!Number.isInteger(leaseMs)||leaseMs<1||leaseMs>this.limits.leaseMs) throw new Error(`invalid lease_ms: must be an integer from 1 to ${this.limits.leaseMs}`);
    if(acquisitionId!==null&&(typeof acquisitionId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(acquisitionId))) throw new Error('invalid acquisition_id: use 1-128 letters, digits, underscores or hyphens');
    if(!this.mayAct(worker,id)) throw new Error('assignment not found');
    if (this.paused()) throw new Error(pausedClaimMessage);
    const a=this.db.prepare('SELECT * FROM assignments WHERE request_id=?').get(id); if(!a) throw new Error('assignment not found');
    if(a.cancelled_at) throw new Error(a.cancelled_reason==='expired'?expiredError(a.valid_until,{cancelled:true}):'assignment cancelled'); if(a.status==='finished') throw new Error('assignment finished');
    if(a.status==='queued'&&this.db.prepare(`SELECT 1 FROM assignments WHERE request_id=? AND ${expired(this.nowMs())}`).get(id)) throw new Error(expiredError(a.valid_until,{requeue:a.valid_until_source==='queue_p90'&&(a.expiry_requeues??0)<2}));
    const old=this.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id);
    if(old&&old.worker!==worker) throw new Error('invalid claim');
    this.assertLiveConnection(id,worker,connectionId);
    const laneScope=old?.lane_scope??this.workers.laneScope;
    const laneKey=laneScope==='subject'?subject:worker;
    const takeover=old?.state==='active';
    if(this.isExactClaimRetry(old,claimant,subject,acquisitionId)) {
      this.assertRetryConnection(id,old,worker,connectionId);
      this.touchHeldClaim(id,old.claim_id,subject,worker); this.markNotesSeen(id,subject,worker);
      return {request_id:id,claim_id:old.claim_id,epoch:old.epoch,assignment:JSON.parse(a.payload),owner_notes:this.ownerNotes(id),duplicate:true,guidance:this.guidanceFor(worker),...this.destinationClaimFields(id)};
    }
    if(old && (old.state!=='active' || this.leaseExpired(old))) this.assertRegrantReady(old);
    if(takeover&&old.subject===subject&&this.isIdleClaim(old)) return this.rotateIdleClaim(old,a,claimant,subject,worker,acquisitionId,leaseMs,connectionId);
    if(takeover) {
      if(!this.leaseExpired(old)&&old.subject===subject&&this.resumeIdleMs()>0) throw new Error(JSON.stringify({error:'claim_busy',message:`Request ${id}: another run of this worker holds it and is active; pick other work or retry after its lease expires. This affects only ${id}.`,request_id:id}));
      if(!this.leaseExpired(old)) throw new Error('already claimed by another claimant');
    }
    const destinationRefusal=this.destinationAdmissionInTransaction(id);
    if(destinationRefusal)return destinationRefusal;
    // Every new epoch of an existing claim (takeover, claim after abandon) waits for reconcile.
    if(old) this.assertNoUncertainDelivery(id);
    if(this.activeClaims(subject,worker,id).length>=capacity) throw new Error('capacity_full');
    this.recordPrPreflight(id,'claim',JSON.parse(a.payload),preflight,!!old);
    if(takeover) { const why=Store.expirySummary(old); this.db.prepare("UPDATE claims SET state='abandoned',abandoned_at=?,abandon_reason=? WHERE request_id=?").run(this.stamp(),why,id); this.lifecycle(id,'abandoned','system',why,old); this.laneFreed(); }
    const claimId=`claim_${randomUUID()}`;
    const claimedAt=this.stamp(), seen=this.db.prepare('SELECT COALESCE(max(sequence),0) n FROM owner_notes WHERE request_id=?').get(id).n;
    if(old) {
      this.db.prepare("UPDATE claims SET claimant=?,claim_id=?,claimed_at=?,subject=?,last_claim_activity_at=?,last_seen_note_seq=?,last_progress_at=NULL,epoch=epoch+1,state='active',abandoned_at=NULL,abandon_reason=NULL,tool_calls=0,last_tool=NULL,last_tool_at=NULL,last_tool_error=NULL,first_workspace_tool_at=NULL,lane_key=?,acquisition_id=?,lease_ms=?,connection_id=? WHERE request_id=?").run(claimant,claimId,claimedAt,subject,claimedAt,seen,laneKey,acquisitionId,leaseMs,connectionId??null,id);
      this.rebindClaim(id,claimId);
    } else this.db.prepare('INSERT INTO claims(request_id,claimant,claim_id,claimed_at,subject,last_claim_activity_at,last_seen_note_seq,worker,lane_key,lane_scope,acquisition_id,lease_ms,connection_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,claimant,claimId,claimedAt,subject,claimedAt,seen,worker,laneKey,laneScope,acquisitionId,leaseMs,connectionId??null);
    this.setClaimDeadlineInTransaction(id,leaseMs);
    if(a.status==='queued') this.recordPassedOver(id,worker);
    this.db.prepare("UPDATE assignments SET status='claimed',listed_count=0,last_listed_at=NULL,skipped_at=NULL,eligible_since=NULL,passed_over=0 WHERE request_id=?").run(id);
    this.lifecycle(id,'claimed',`worker:${subject}`,takeover?'takeover':old?'reclaim':'new',{claim_id:claimId,epoch:old?old.epoch+1:1,worker});
    this.db.prepare('DELETE FROM claim_denials WHERE request_id=?').run(id);
    return {request_id:id,claim_id:claimId,epoch:old?old.epoch+1:1,assignment:JSON.parse(a.payload),owner_notes:this.ownerNotes(id),duplicate:false,guidance:this.guidanceFor(worker),...this.destinationGrantedInTransaction(id)};
  }
  // Resume wake: the same worker and subject claims its own idle claim. The claim moves to a new claim_id and the next epoch in one
  // transaction, so a run still alive under the old claim_id is refused on its next call (claim_superseded). Worktree and sealed
  // uploads move with it (rebindClaim). Lifecycle: a 'claimed' event with reason 'resume' (not counted as a new admission; the
  // event type list is closed, so no 'resumed' type). The previous epoch and the idle time go to the progress history.
  rotateIdleClaim(old,a,claimant,subject,worker,acquisitionId,leaseMs=this.limits.leaseMs,connectionId=null) {
    this.assertRegrantReady(old);
    this.assertLiveConnection(old.request_id,worker,connectionId);
    const id=old.request_id, idleS=Math.floor(this.claimIdleMs(old)/1000);
    const destinationRefusal=this.destinationAdmissionInTransaction(id);
    if(destinationRefusal)return destinationRefusal;
    this.assertNoUncertainDelivery(id);
    const claimId=`claim_${randomUUID()}`, at=this.stamp(), epoch=old.epoch+1;
    const seen=this.db.prepare('SELECT COALESCE(max(sequence),0) n FROM owner_notes WHERE request_id=?').get(id).n;
    this.db.prepare("UPDATE claims SET claimant=?,claim_id=?,claimed_at=?,last_claim_activity_at=?,last_seen_note_seq=?,last_progress_at=NULL,epoch=?,tool_calls=0,last_tool=NULL,last_tool_at=NULL,last_tool_error=NULL,first_workspace_tool_at=NULL,acquisition_id=?,lease_ms=?,connection_id=? WHERE request_id=?").run(claimant,claimId,at,at,seen,epoch,acquisitionId,leaseMs,connectionId??null,id);
    this.setClaimDeadlineInTransaction(id,leaseMs);
    this.rebindClaim(id,claimId);
    this.db.prepare('INSERT INTO progress(request_id,note,created_at,worker) VALUES(?,?,?,?)').run(id,`[bridge] run resumed: epoch ${old.epoch} lease expired after ${idleS}s without activity; epoch ${epoch} continues under a new claim`,at,worker);
    this.lifecycle(id,'claimed',`worker:${subject}`,'resume',{claim_id:claimId,epoch,worker});
    return {request_id:id,claim_id:claimId,epoch,previous_epoch:old.epoch,resumed:true,idle_seconds:idleS,assignment:JSON.parse(a.payload),owner_notes:this.ownerNotes(id),duplicate:false,guidance:this.guidanceFor(worker),...this.destinationGrantedInTransaction(id)};
  }
  // The same subject continues under a fresh claim_id and the next epoch, so a lost process holding the old claim_id is fenced off.
  resume(id,subject='local-principal',connectionId=null) { return this.destinationOutcome(this.transaction(() => {
    const a=this.db.prepare('SELECT * FROM assignments WHERE request_id=?').get(id); if(!a) throw new Error('assignment not found');
    if(a.cancelled_at) throw new Error('assignment cancelled'); if(a.status==='finished') throw new Error('assignment finished');
    const old=this.db.prepare("SELECT * FROM claims WHERE request_id=? AND state='active'").get(id);
    if(!old||old.subject!==subject||a.status!=='claimed') throw new Error('no active claim for this subject');
    this.assertLiveConnection(id,old.worker,connectionId);
    this.assertRegrantReady(old);
    const destinationRefusal=this.destinationAdmissionInTransaction(id);
    if(destinationRefusal)return destinationRefusal;
    this.assertNoUncertainDelivery(id);
    const claimId=`claim_${randomUUID()}`;
    this.db.prepare('UPDATE claims SET claim_id=?,epoch=epoch+1,last_claim_activity_at=?,connection_id=COALESCE(?,connection_id) WHERE request_id=?').run(claimId,this.stamp(),connectionId??null,id);
    this.rebindClaim(id,claimId);
    this.setClaimDeadlineInTransaction(id,this.claimLeaseMs(old));
    this.markNotesSeen(id,subject);
    this.lifecycle(id,'claimed',`worker:${subject}`,'resume',{claim_id:claimId,epoch:old.epoch+1});
    if(this.isProtocolJob(id)) {
      this.advanceProtocolRevisionInTransaction(id);
      this.protocolEventInTransaction(id,'claimed',{claim_id:claimId,resumed:true},old.epoch+1);
    }
    return {request_id:id,claim_id:claimId,epoch:old.epoch+1,previous_epoch:old.epoch,assignment:JSON.parse(a.payload),owner_notes:this.ownerNotes(id),guidance:workerGuidance,...this.destinationGrantedInTransaction(id)};
  })); }
  // Withdraw the active claim and requeue the assignment, never while a delivery for it may be in flight or already delivered.
  abandon(id,{actor='operator',reason='abandoned'}={}) { return this.transaction(() => {
    const a=this.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(id); if(!a) throw new Error('assignment not found');
    const old=this.db.prepare("SELECT * FROM claims WHERE request_id=? AND state='active'").get(id);
    if(a.status==='finished'||a.status==='cancelled') throw new Error('assignment is terminal');
    if(!old||a.status!=='claimed') throw new Error('no active claim');
    this.assertNoUncertainDelivery(id);
    const at=this.stamp();
    const expired=reason==='lease_expired'&&this.leaseExpired(old);
    if(reason==='lease_expired') reason=Store.expirySummary(old);
    this.db.prepare("UPDATE claims SET state='abandoned',abandoned_at=?,abandon_reason=? WHERE request_id=?").run(at,reason,id);
    this.db.prepare("UPDATE assignments SET status='queued' WHERE request_id=?").run(id);
    this.lifecycle(id,'abandoned',actor,reason,old);
    this.lifecycle(id,'queued',actor,'requeued',null);
    if(this.isProtocolJob(id)) {
      this.advanceProtocolRevisionInTransaction(id);
      this.protocolEventInTransaction(id,expired?'expired':'abandoned',{reason},old.epoch);
    }
    for(const sub of this.activeSubscriptions()) this.queueEvent(id,sub,true);
    this.laneFreed();
    return {request_id:id,status:'queued',abandoned:{claim_id:old.claim_id,epoch:old.epoch,claimant:old.claimant,subject:old.subject,abandoned_at:at,reason,actor}};
  }); }
  // Result hints for list_pending and claim. Free lanes are bounded by both the lane capacity and the claim cap, so the
  // count never invites a claim that capacity_full would refuse.
  laneState(subject,worker='dot',laneCapacity=this.limits.laneCapacity??6,claimCapacity=this.capacity) {
    return {free_lanes:this.freeLanes(subject,worker,laneCapacity,claimCapacity),queued:this.listPending(worker).filter(x=>x.kind==='assignment'&&!x.blocked).length};
  }
  // In-band dispatch notice for a worker that is busy, not silent. A webhook wake is a hint into one conversation and a 2xx only
  // means it was accepted: a conversation inside a long turn keeps calling tools (progress, get) but never lists. Those calls
  // are the one channel that reaches it, so they carry the queue head while work waits past the wake grace, lanes are free and
  // claims are allowed. Read-only, throttled per principal and worker; it never claims, wakes or marks anything.
  dispatchNotice(subject,worker='dot',laneCapacity=this.limits.laneCapacity??6,claimCapacity=this.capacity,{graceMs=this.limits.rewakeMs??defaultRedeliveryLimits.rewakeMs,everyMs=30000}={}) {
    const key=`${subject}\0${worker}`, now=this.nowMs();
    this.noticeAt??=new Map();
    if(now-(this.noticeAt.get(key)??-Infinity)<everyMs) return {};
    this.noticeAt.set(key,now);
    if(this.paused()||this.capacityHoldUntil(worker)) return {};
    const free=this.freeLanes(subject,worker,laneCapacity,claimCapacity);
    const next=this.nextQueued(free,null,worker);
    if(!next.next_queued?.length) return {};
    const head=this.queuedRows().find(r=>r.request_id===next.next_queued[0].request_id);
    const waitedMs=head?this.queuedAgeMs(head.queued_at,now,worker==='dot'?this.breakIntervals():[]):0;
    if(waitedMs<graceMs) return {};
    return {dispatch_notice:{free_lanes:free,oldest_waiting_s:Math.round(waitedMs/1000),...next,next_action:`Work waits unclaimed while ${free} ${free===1?'lane is':'lanes are'} free. Before more work on this job, ${next.next_action}.`}};
  }
  // A claimed assignment left its lane: the next reannounceQueued tick may wake the worker at once instead of waiting out rewakeMs.
  laneFreed() { this.dispatchWake=true; }
  // Up to `free` live queued assignments in list_pending order (oldest, normal work first), never `exceptId`, with the one-line prompt to claim them.
  nextQueued(free,exceptId=null,worker='dot') {
    if(free<=0) return {};
    const all=this.listPending(worker).filter(x=>x.kind==='assignment'&&!x.blocked&&x.request_id!==exceptId);
    if(!all.length) return {};
    const next=all.slice(0,free).map(({request_id,title})=>({request_id,title}));
    return {next_queued:next,next_action:`${all.length} queued and ${free} ${free===1?'lane':'lanes'} free: claim ${next.map(x=>x.request_id).join(', ')} now (oldest first)`};
  }
  freeLanes(subject,worker='dot',laneCapacity=this.limits.laneCapacity??6,claimCapacity=this.capacity) { return Math.max(0,Math.min(laneCapacity,claimCapacity)-this.activeClaims(subject,worker).length); }
  // Active claims for the operator, with the lease state that decides whether another claimant may take one over.
  claims() {
    return this.db.prepare("SELECT c.*,a.priority FROM claims c JOIN assignments a USING(request_id) WHERE a.status='claimed' AND c.state='active' ORDER BY c.claimed_at").all().map(c=>({
      request_id:c.request_id,claimant:c.claimant,subject:c.subject,claim_id:c.claim_id,epoch:c.epoch,claimed_at:c.claimed_at,last_activity_at:c.last_claim_activity_at??c.claimed_at,
      lease_expires_at:this.leaseExpiresAt(c),expired:this.leaseExpired(c),priority:c.priority,uncertain_deliveries:this.uncertainDeliveries(c.request_id)}));
  }
  // Uploads are rebound to each new claim_id. Bridge-written check output and patches keep the claim_id they ran under and stay citable.
  assertSealedArtifacts(id,claimId,artifactIds) { for(const artifactId of artifactIds) if(!this.db.prepare("SELECT 1 FROM artifacts WHERE COALESCE(client_artifact_id,id)=? AND request_id=? AND (claim_id=? OR kind<>'upload') AND sealed=1").get(artifactId,id,claimId)) throw new Error('invalid sealed artifact'); }
  // A worker mutation is refused at the lease deadline (now >= leaseExpiresAt) without refreshing the lease and without writing anything.
  // The sweep (sweepStaleLeases) or a takeover is what moves the claim to abandoned; until then the row stays active but cannot act.
  // A claim_id that an earlier epoch of this assignment held (rotation, takeover, reclaim) is superseded, not unknown. Only its own worker and subject learn that.
  refuseClaim(id,claimId,subject,worker) {
    const cur=this.mayAct(worker,id)?this.db.prepare("SELECT claim_id,epoch,subject,worker FROM claims WHERE request_id=? AND state='active'").get(id):null;
    if(cur&&cur.claim_id!==claimId&&cur.subject===subject&&cur.worker===worker&&this.db.prepare("SELECT 1 FROM lifecycle_events WHERE request_id=? AND claim_id=? AND type='claimed'").get(id,claimId))
      return new Error(JSON.stringify({error:'claim_superseded',message:`invalid claim: claim ${claimId} for ${id} was superseded by epoch ${cur.epoch}; stop using this claim. This affects only ${id}.`,request_id:id}));
    return new Error('invalid claim');
  }
  // Commit-time authority only: never re-admit the grant against destination/repository policy.
  assertMutationConnection(id,claim,connectionId=null) {
    if(connectionId==null&&claim.connection_id==null&&typeof this.connectionIsLive!=='function')return;
    const refuse=()=>destinationError({error:'connection_not_live',request_id:id,
      message:'Claim mutation refused: the granting connection is not live or does not match.'});
    if(typeof connectionId!=='string'||!connectionId.trim()||claim.connection_id!==connectionId||
      typeof this.connectionIsLive!=='function')throw refuse();
    let live=false;
    try { live=this.connectionIsLive(connectionId)===true; } catch { /* Fail closed without disclosing auth internals. */ }
    if(!live)throw refuse();
  }
  assertClaim(id,claimId,subject='local-principal',worker='dot') {
    const c=this.db.prepare("SELECT * FROM claims WHERE request_id=? AND claim_id=? AND state='active'").get(id,claimId);
    if(!c||c.subject!==subject||c.worker!==worker||!this.mayAct(worker,id)) throw this.refuseClaim(id,claimId,subject,worker);
    this.assertProtocolAvailable(id);
    if(this.isProtocolJob(id)&&this.db.prepare("SELECT 1 FROM assignments WHERE request_id=? AND status='finished'").get(id)) throw questionError('TERMINAL','assignment is terminal');
    if(this.leaseExpired(c)) {
      const deadline=this.leaseExpiresAt(c);
      const cancelled=this.db.prepare("SELECT 1 FROM assignments WHERE request_id=? AND status='cancelled'").get(id);
      throw new Error(JSON.stringify({error:cancelled?'assignment_cancelled':'lease_expired',
        message:cancelled?`Assignment ${id} was cancelled. This expired claim cannot submit a result or late output.`:
          `the lease on assignment ${id} ended at ${deadline}; claim ${claimId} can no longer act. This affects only ${id}. Claim it again to continue; the sweep may already have requeued it.`,
        request_id:id,lease_expires_at:deadline}));
    }
    return c;
  }
  // A worker note that reports a denied claim and names queued requests: stop re-waking them (rewakeCandidates) until claimed.
  // The ID, a claim and a denial must share one sentence: a note about a denied read that mentions another request is not one.
  recordClaimDenials(reportedIn,text,worker='dot') {
    if(!claimDenial.test(text)) return [];
    const queued=this.db.prepare("SELECT request_id FROM assignments WHERE status='queued' AND request_id<>? AND target_worker=?").all(reportedIn,worker).map(r=>r.request_id);
    const put=this.db.prepare(`INSERT INTO claim_denials(request_id,at,reported_in,capacity,note,worker) VALUES(?,?,?,?,?,?)
      ON CONFLICT(request_id) DO UPDATE SET at=excluded.at,reported_in=excluded.reported_in,capacity=max(capacity,excluded.capacity),note=excluded.note`);
    const named=new Set();
    for(const sentence of text.split(/(?<=[.!?;])\s+|\n+/)) {
      if(!claimDenial.test(sentence)||!/\bclaim(?:s|ed|ing)?\b/i.test(sentence)) continue;
      for(const rid of queued) if(new RegExp(`(?<![-\\w])${rid}(?![-\\w])`).test(sentence)) { put.run(rid,this.stamp(),reportedIn,Number(/\bcapacity\b/i.test(sentence)),text.slice(0,500),worker); named.add(rid); }
    }
    return [...named];
  }
  claimDenial(id) { const r=this.db.prepare('SELECT at,reported_in,capacity,note FROM claim_denials WHERE request_id=?').get(id); return r?{...r,capacity:!!r.capacity}:null; }
  deniedQueued(worker='dot') { return this.db.prepare("SELECT d.request_id,d.at,d.reported_in,d.capacity FROM claim_denials d JOIN assignments a USING(request_id) WHERE a.status='queued' AND d.worker=? AND a.target_worker=d.worker ORDER BY d.at").all(worker); }
  // Until when a capacity-overrun denial holds every re-wake: until a claimed assignment completes, is abandoned or cancelled
  // (a slot frees), at most capacityHoldMaxMs. null when no such hold applies.
  capacityHoldUntil(worker='dot') {
    const at=this.db.prepare('SELECT max(at) at FROM claim_denials WHERE capacity=1 AND worker=?').get(worker).at;
    if(!at||this.nowMs()>=Date.parse(at)+capacityHoldMaxMs) return null;
    // Only a claimed assignment ending frees a slot; cancelling or expiring queued work does not.
    if(this.db.prepare("SELECT 1 FROM lifecycle_events e WHERE e.type IN ('completed','abandoned','cancelled') AND e.at>? AND e.worker=? AND EXISTS(SELECT 1 FROM claims c WHERE c.request_id=e.request_id) LIMIT 1").get(at,worker)) return null;
    return iso(Date.parse(at)+capacityHoldMaxMs);
  }
  progress(id,claimId,note,subject='local-principal',blocker=false,worker='dot',question=null,ctx=null,connectionId=null) {
    const result=this.transaction(()=>{
      if(!this.isProtocolJob(id)) {
        this.assertMutationConnection(id,this.assertClaim(id,claimId,subject,worker),connectionId);
        return this.progressInTransaction(id,claimId,note,subject,blocker,worker,question);
      }
      const receipt=this.protocolMutationInTransaction(id,claimId,subject,worker,
        {...ctx,operation:question?'ask':'progress',args:{note,blocker,question}},()=>{
          const value=this.progressInTransaction(id,claimId,note,subject,blocker,worker,question);
          if(value.duplicate===true)protocolError('question_exists');
          this.protocolEventInTransaction(id,question?'questioned':'progressed',
            question?{question_id:question.questionId}:{note,blocker},this.assertClaim(id,claimId,subject,worker).epoch);
          return value;
        },connectionId);
      return {...receipt.value,revision:receipt.revision};
    });
    // Decorate after replay validation too, including receipts stored before this field existed.
    return question?result:nonterminalOutcome(id,result);
  }
  progressInTransaction(id,claimId,note,subject='local-principal',blocker=false,worker='dot',question=null) {
    if(!this.db.isTransaction) throw new Error('progress requires a caller-owned transaction');
    const claim=this.assertClaim(id,claimId,subject,worker);
    const a=this.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(id);
    if(a.status==='finished'||a.status==='cancelled') throw new Error('assignment is terminal: this job is already finished or cancelled; stop work on it and call list_pending for your next job');
    if(question) {
      validateQuestion(question.questionId,question.text);
      const old=this.db.prepare('SELECT * FROM job_questions WHERE request_id=? AND question_id=?').get(id,question.questionId);
      if(old) {
        if(old.claim_id!==claimId||old.epoch!==claim.epoch) throw questionError('STALE_EPOCH','question identity belongs to an earlier grant');
        if(old.text!==question.text) throw questionError('KEY_CONFLICT','question identity has different text');
        return {recorded:true,question_id:question.questionId,duplicate:true};
      }
      this.db.prepare('INSERT INTO job_questions(request_id,question_id,claim_id,epoch,worker,subject,text,asked_at) VALUES(?,?,?,?,?,?,?,?)').run(id,question.questionId,claimId,claim.epoch,worker,subject,question.text,this.stamp());
    }
    this.db.prepare('INSERT INTO progress(request_id,note,created_at,worker) VALUES(?,?,?,?)').run(id,note,this.stamp(),worker);
    this.recordClaimDenials(id,note,worker);
    this.db.prepare('UPDATE claims SET last_progress_at=? WHERE request_id=?').run(this.stamp(),id);
    this.refreshClaimActivity(id,claim.claim_id);
    const isBlocker=blocker||/^\s*(?:BLOCKED:|QUESTION:)/im.test(note);
    this.lifecycle(id,question?'waiting':progressType(note,blocker),`worker:${subject}`,question?`question:ask:${question.questionId}`:null,claim);
    if(isBlocker) {
      const ownerNoteSeq=this.db.prepare('SELECT COALESCE(max(sequence),0) sequence FROM owner_notes WHERE request_id=?').get(id).sequence;
      const body=JSON.stringify({note,epoch:claim.epoch,owner_note_seq:ownerNoteSeq,...(question?{question_id:question.questionId}:{})});
      // Legacy bodies have no generation fields. Preserve them only before any later answer/claim boundary;
      // equal timestamps at a boundary cannot prove the original generation, so do not suppress a fresh question.
      // Owner notes have no shared sequence with notifications; table-local rowids or a delivered-ID set cannot
      // distinguish answer-before-question from question-before-answer. See docs/operations.md#legacy-question-ties.
      const old=question?null:this.db.prepare(`SELECT n.id FROM notifications n WHERE n.kind IN ('blocker','wait') AND n.request_id=? AND
        (n.body=? OR n.body=? AND NOT EXISTS(SELECT 1 FROM owner_notes o WHERE o.request_id=n.request_id AND o.at>=n.created_at)
        AND (?=1 OR EXISTS(SELECT 1 FROM lifecycle_events e WHERE e.request_id=n.request_id AND e.type='claimed' AND e.claim_id=? AND e.at<n.created_at)))`).get(id,body,JSON.stringify({note}),claim.epoch,claimId);
      if(!old) this.db.prepare('INSERT INTO notifications(id,kind,request_id,body,created_at) VALUES(?,?,?,?,?)').run(`evt_${randomUUID()}`,this.deliveryKind(id,'blocker'),id,body,this.stamp());
    }
    return {recorded:true,blocker_forwarded:isBlocker,...(question?{question_id:question.questionId,duplicate:false}:{})};
  }
  // Output filed after cancel is audit evidence in late_evidence: never a result, never delivered, never a lane freed. Cancellation wins.
  static resultAuthority(late) { return {result_authority:!late,status:late?'cancelled':'finished',terminal:true}; }
  static clipBytes(text,max) { const buf=Buffer.from(text); if(buf.length<=max) return text; let end=max; while(end>0&&(buf[end]&0xC0)===0x80) end--; return buf.subarray(0,end).toString(); }
  static lateEvidenceLimits={summary:4096,result:64*1024};
  finish(id,claimId,outcome,summary,result,subject='local-principal',evidence=null,worker='dot',ctx=null,captureEvidence=null,connectionId=null) {
    if(this.isProtocolJob(id)&&this.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(id)?.status!=='cancelled')
      return finishProtocol(this,id,claimId,outcome,summary,result,subject,evidence,worker,ctx,captureEvidence,connectionId);
    const rollback=[];
    let done;
    try { done=this.transaction(() => this.finishOnce(id,claimId,outcome,summary,result,subject,evidence,worker,captureEvidence?()=>captureEvidence(cleanup=>rollback.push(cleanup)):null,connectionId)); }
    catch(error) {for(const cleanup of rollback)cleanup();throw error;}
    // Thrown after the transaction commits so the evidence row stays. TERMINAL: the worker has nothing more to do for this request.
    if(done.cancelled) throw new Error(JSON.stringify({error:'assignment_cancelled',message:`${id} was cancelled${done.reason?` (reason: ${done.reason})`:''} before this finish. Your output was kept as audit evidence only (not a result); nothing more is needed for ${id}; your other assignments are unaffected.${done.contradiction?' A different output was already kept for this request; this one was not stored.':''}`,request_id:id}));
    return done;
  }
  // A committed report retry reads its receipt; the original grant still binds worker and subject, but needs no live lease.
  assertFinishClaim(id,claimId,subject='local-principal',worker='dot') {
    const report=this.db.prepare('SELECT claim_id,worker FROM reports WHERE request_id=?').get(id);
    if(!report) return this.assertClaim(id,claimId,subject,worker);
    const claim=this.db.prepare("SELECT * FROM claims WHERE request_id=? AND claim_id=? AND state='active'").get(id,claimId);
    if(!claim||claim.subject!==subject||claim.worker!==worker||report.claim_id!==claimId||report.worker!==worker||!this.mayAct(worker,id)) throw this.refuseClaim(id,claimId,subject,worker);
    this.assertProtocolAvailable(id);
    return claim;
  }
  finishOnce(id,claimId,outcome,summary,result,subject,evidence,worker,captureEvidence=null,connectionId=null) {
    const claim=this.assertFinishClaim(id,claimId,subject,worker);
    this.assertMutationConnection(id,claim,connectionId);
    const old=this.db.prepare('SELECT * FROM reports WHERE request_id=?').get(id);
    if(old) { if(old.outcome!==outcome||old.summary!==summary||old.result!==result) throw new Error('contradictory report: this request already has a different stored report, which is kept; do not call finish again with other text. Call list_pending for your next job.'); return {receipt_id:old.receipt_id,request_id:id,duplicate:true,late:!!old.late,...Store.resultAuthority(!!old.late)}; }
    const a=this.db.prepare('SELECT status,cancelled_reason FROM assignments WHERE request_id=?').get(id);
    if(a.status==='cancelled') {
      this.recordClaimDenials(id,`${summary}\n${result}`,worker);
      const limits=Store.lateEvidenceLimits, full=createHash('sha256').update(summary+result).digest('hex');
      const kept=this.db.prepare('SELECT outcome,full_sha256 FROM late_evidence WHERE request_id=? AND claim_id=?').get(id,claimId);
      if(!kept) {
        const s=Store.clipBytes(summary,limits.summary), r=Store.clipBytes(result,limits.result);
        this.db.prepare('INSERT INTO late_evidence(request_id,claim_id,epoch,worker,outcome,summary,result,full_sha256,truncated,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,claimId,claim.epoch,worker,outcome,s,r,full,s!==summary||r!==result?1:0,this.stamp());
      }
      return {cancelled:true,reason:a.cancelled_reason,contradiction:!!kept&&(kept.outcome!==outcome||kept.full_sha256!==full)};
    }
    this.assertQuestionsResolved(id,claimId,outcome);
    if(captureEvidence) evidence=captureEvidence();
    this.recordClaimDenials(id,`${summary}\n${result}`,worker);
    const receipt=`report_${randomUUID()}`;
    this.db.prepare('INSERT INTO reports(request_id,claim_id,outcome,summary,result,receipt_id,created_at,late,workspace_evidence,worker) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,claimId,outcome,summary,result,receipt,this.stamp(),0,evidence?JSON.stringify(evidence):null,worker);
    // completed means the worker filed its terminal report; acceptance is only ever the owner's accept event.
    this.lifecycle(id,'completed',`worker:${subject}`,`outcome=${outcome}`,claim);
    if(outcome==='blocked') this.lifecycle(id,'blocked',`worker:${subject}`,null,claim);
    this.db.prepare("UPDATE assignments SET status='finished' WHERE request_id=?").run(id);
    this.db.prepare("UPDATE watches SET state='suppressed',updated_at=? WHERE request_id=? AND state IN ('armed','fired')").run(this.stamp(),id);
    this.db.prepare("UPDATE notifications SET state='suppressed',last_error='result superseded watch' WHERE request_id=? AND kind='watch' AND state IN ('pending','failed')").run(id);
    this.suppressFinishedQuestions(id);
    this.db.prepare('INSERT INTO notifications(id,kind,request_id,created_at) VALUES(?,?,?,?)').run(`evt_${randomUUID()}`,this.deliveryKind(id,'t3'),id,this.stamp());
    this.laneFreed();
    return {receipt_id:receipt,request_id:id,duplicate:false,late:false,...Store.resultAuthority(false),...this.nextQueued(this.freeLanes(claim.subject,claim.worker),id,worker)};
  }
  cancel(id,reason=null,ctx=null,ownerToken=null) {
    return this.isProtocolJob(id)?cancelProtocolJob(this,id,reason,ownerToken,ctx):this.transaction(()=>this.cancelInTransaction(id,reason));
  }
  cancelInTransaction(id,reason=null) {
    if(!this.db.isTransaction)protocolError('transaction_required');
    const a=this.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(id); if(!a) throw new Error('assignment not found'); if(a.status==='finished') throw new Error('already finished');
    if(a.status!=='cancelled') {
      this.assertNoUncertainDelivery(id);
      if(a.status==='claimed') this.laneFreed();
      this.db.prepare("UPDATE assignments SET status='cancelled',cancelled_at=?,cancelled_reason=? WHERE request_id=?").run(this.stamp(),reason,id);
      this.lifecycle(id,'cancelled','owner',reason);
      this.db.prepare("UPDATE notifications SET state='suppressed' WHERE request_id=? AND state IN ('pending','failed','waiting')").run(id);
      this.db.prepare("UPDATE watches SET state='suppressed',updated_at=? WHERE request_id=? AND state IN ('armed','fired')").run(this.stamp(),id);
    }
    return {request_id:id,status:'cancelled',cancellation_requested:true,authority_revoked:true,compute_stopped:false};
  }
  // Cancel only while the row is still queued, in one transaction, so a claim cannot slip in between a check and the cancel.
  // Returns the resulting state either way: cancelled:true when this call cancelled it, false when it was already claimed,
  // finished or cancelled (the status then says which). A claimed row keeps running; nothing is revoked.
  cancelIfQueued(id) { return this.transaction(() => {
    this.assertProtocolAvailable(id);
    if(this.isProtocolJob(id)) throw new Error('protocol jobs require keyed /cancel with command_key and expected_revision');
    const a=this.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(id); if(!a) throw new Error('assignment not found');
    if(a.status!=='queued') return {request_id:id,status:a.status,cancelled:false};
    this.db.prepare("UPDATE assignments SET status='cancelled',cancelled_at=? WHERE request_id=? AND status='queued'").run(this.stamp(),id);
    this.lifecycle(id,'cancelled','owner');
    this.db.prepare("UPDATE notifications SET state='suppressed' WHERE request_id=? AND state IN ('pending','failed','waiting')").run(id);
    this.db.prepare("UPDATE watches SET state='suppressed',updated_at=? WHERE request_id=? AND state IN ('armed','fired')").run(this.stamp(),id);
    return {request_id:id,status:'cancelled',cancelled:true};
  }); }
  // Lease sweep: a claim whose lease ran out with no claim activity is abandoned (actor system, reason lease_expired) through the
  // same path as `dalan abandon`, so the row is requeued and its lane is free at once. Before this, an expired lease only
  // let another claimant take the item over, and a dead claim held its lane for as long as nobody did. A usage break neither holds
  // the sweep nor moves a deadline: only the claimant's own activity extends a lease. After a bridge start, a claim whose last activity came before the start is not swept
  // before the start plus that claim's own lease (lease_ms), the full lease a restart would have given it, so a deadline that
  // passed while the bridge was down or draining does not requeue work the worker may still be running. A claim touched since
  // the start has no grace. A claim with an uncertain delivery waits for reconcile.
  // Returns the abandoned request ids.
  sweepStaleLeases(limit=20) {
    const done=[];
    const stale=this.db.prepare("SELECT c.request_id,c.worker,c.lease_ms,c.lease_deadline_at,c.lease_boot_id,c.lease_deadline_monotonic_ms,c.claimed_at,c.last_claim_activity_at,COALESCE(c.last_claim_activity_at,c.claimed_at) activity FROM claims c JOIN assignments a USING(request_id) WHERE a.status='claimed' AND c.state='active'").all()
      .filter(c=>!this.heldAfterStart(c))
      .filter(c=>this.leaseExpired(c)).sort((a,b)=>a.activity<b.activity?-1:1).slice(0,limit);
    for(const {request_id} of stale) {
      try { this.abandon(request_id,{actor:'system',reason:'lease_expired'}); done.push(request_id); }
      catch(e) { if(!/uncertain_delivery|no active claim|terminal/.test(e.message)) throw e; }
    }
    return done;
  }
  // Expiry sweep: queued rows whose preparation expired (valid_until <= now). A learned (queue_p90) row with requeue
  // budget left and a computable fresh deadline is requeued, not cancelled: it stays queued with a freshly computed
  // defaultValidUntil for its worker/kind, expiry_requeues incremented, and a lifecycle 'queued' event (actor system, reason
  // expired_requeued). The fresh deadline never passes created_at + QUEUE_WINDOW.maxMs (12 h): it is clamped to that cap,
  // and a row with less than QUEUE_WINDOW.minMs left before the cap is cancelled instead. Rows with no computable fresh deadline (insufficient history), with
  // expiry_requeues >= 2, and every requester-deadline row are cancelled as before: cancelled_reason 'expired', a lifecycle
  // 'cancelled' event (reason 'expired'), and pending events and watches suppressed as cancel does. Claimed rows are never
  // touched; rows without valid_until never match. Bounded and indexed, so the maintenance tick can run it while delivery is
  // paused. Returns the cancelled request ids, with the requeued ids on the returned array's `requeued` property for the
  // request log.
  sweepExpired(limit=100) { return this.transaction(() => {
    const at=this.stamp(), nowMs=this.nowMs(), rows=this.db.prepare(`SELECT a.request_id,a.valid_until_source,a.expiry_requeues,a.created_at,a.target_worker,${queueKindSql} kind FROM assignments a WHERE status='queued' AND ${expired(nowMs)} ORDER BY valid_until LIMIT ?`).all(limit);
    const cancelled=[], requeued=[];
    for(const row of rows) {
      if(row.valid_until_source==='queue_p90'&&(row.expiry_requeues??0)<2) {
        const fresh=this.defaultValidUntil(row.target_worker,row.kind), capMs=Date.parse(row.created_at)+QUEUE_WINDOW.maxMs;
        if(fresh.valid_until&&capMs-nowMs>=QUEUE_WINDOW.minMs) {
          const next=iso(Math.min(Date.parse(fresh.valid_until),capMs));
          this.db.prepare("UPDATE assignments SET valid_until=?,expiry_requeues=COALESCE(expiry_requeues,0)+1,skipped_at=NULL,passed_over=0,eligible_since=NULL,listed_count=0,last_listed_at=NULL WHERE request_id=? AND status='queued'").run(next,row.request_id);
          this.lifecycle(row.request_id,'queued','system','expired_requeued',null);
          requeued.push(row.request_id);
          continue;
        }
      }
      this.db.prepare("UPDATE assignments SET status='cancelled',cancelled_at=?,cancelled_reason='expired' WHERE request_id=? AND status='queued'").run(at,row.request_id);
      this.lifecycle(row.request_id,'cancelled','system','expired',null);
      this.db.prepare("UPDATE notifications SET state='suppressed',last_error='assignment expired' WHERE request_id=? AND state IN ('pending','failed','waiting')").run(row.request_id);
      this.db.prepare("UPDATE watches SET state='suppressed',updated_at=? WHERE request_id=? AND state IN ('armed','fired')").run(at,row.request_id);
      cancelled.push(row.request_id);
    }
    cancelled.requeued=requeued;
    return cancelled;
  }); }
  // Skip expiry sweep: a queued worker assignment that the worker has passed over for skipExpireMs (skipped_at old enough) and
  // at least SKIP_AFTER_PASSED times is cancelled with cancelled_reason 'skipped_by_worker', so its sender sees the cancellation.
  // Queued rows for target_worker 'dot' only; claimed rows are never touched. This maintenance runs while delivery is paused.
  // Returns the ids.
  sweepSkipped(limit=100) { return this.transaction(() => {
    const at=this.stamp(), due=iso(this.nowMs()-this.skipExpireMs);
    const ids=this.db.prepare("SELECT request_id FROM assignments WHERE status='queued' AND target_worker='dot' AND skipped_at IS NOT NULL AND skipped_at<=? AND passed_over>=? ORDER BY skipped_at LIMIT ?").all(due,SKIP_AFTER_PASSED,limit).map(r=>r.request_id);
    for(const id of ids) {
      this.db.prepare("UPDATE assignments SET status='cancelled',cancelled_at=?,cancelled_reason='skipped_by_worker' WHERE request_id=? AND status='queued'").run(at,id);
      this.lifecycle(id,'cancelled','system','skipped_by_worker',null);
      this.db.prepare("UPDATE notifications SET state='suppressed',last_error='skipped by worker' WHERE request_id=? AND state IN ('pending','failed','waiting')").run(id);
      this.db.prepare("UPDATE watches SET state='suppressed',updated_at=? WHERE request_id=? AND state IN ('armed','fired')").run(at,id);
    }
    return ids;
  }); }
  // Refresh or cancel an expired preparation before PR preflight; a bounded sweep may leave it expired and queued.
  refuseExpired(id) {
    const read=()=>this.db.prepare(`SELECT status,valid_until,valid_until_source,expiry_requeues,cancelled_at,cancelled_reason,${expired(this.nowMs())} expired FROM assignments WHERE request_id=?`).get(id);
    let a=read();
    if(a?.status==='queued'&&a.expired) { this.sweepExpired(); a=read(); }
    if(!a) return;
    if(a.cancelled_at&&a.cancelled_reason==='expired') throw new Error(expiredError(a.valid_until,{cancelled:true}));
    if(a.status==='queued'&&a.expired) throw new Error(expiredError(a.valid_until,{requeue:a.valid_until_source==='queue_p90'&&(a.expiry_requeues??0)<2}));
  }
  // Queued rows past valid_until, or protocol rows past their retention, that a bounded sweep has not reached yet.
  queuedExpired(worker=null) {
    const row=this.db.prepare(`SELECT count(*) n,min(valid_until) oldest FROM assignments WHERE status='queued' AND NOT (${live(this.nowMs())}) AND (? IS NULL OR target_worker=?)`).get(worker,worker);
    return {count:row.n,oldest_expired_at:row.oldest??null};
  }
  // Queued rows previously requeued after a preparation expiry (expiry_requeues > 0) that are still queued, with the oldest
  // current deadline among them. Reported as queued_expired_requeued next to queued_expired in status --json.
  queuedExpiredRequeued(worker=null) {
    const row=this.db.prepare(`SELECT count(*) n,min(valid_until) oldest FROM assignments WHERE status='queued' AND COALESCE(expiry_requeues,0)>0 AND (? IS NULL OR target_worker=?)`).get(worker,worker);
    return {count:row.n,oldest_valid_until:row.oldest??null};
  }
  deliveryMuted(id) { return !!this.db.prepare('SELECT 1 FROM assignment_delivery_mutes WHERE request_id=?').get(id); }
  suppressFinishedQuestions(requestId=null) {
    this.db.prepare("UPDATE notifications SET state='suppressed',last_error='result superseded question' WHERE (kind='blocker' OR kind='wait' AND body IS NOT NULL) AND state IN ('pending','failed') AND request_id IN (SELECT request_id FROM assignments WHERE status='finished' AND (? IS NULL OR request_id=?))").run(requestId,requestId);
  }
  quietDelivery(id,reason) {
    // Keep results/questions in the existing wait queue. Watches stay visible to
    // get without masquerading as a worker blocker or an outbound retry.
    this.db.prepare("UPDATE notifications SET kind=CASE WHEN kind='watch' THEN kind ELSE 'wait' END,state=CASE WHEN kind='watch' THEN 'quiet' ELSE 'pending' END,next_at=0,last_error=? WHERE id=? AND kind IN ('t3','blocker','watch','break') AND state IN ('pending','failed','sending')").run(reason,id);
    this.suppressFinishedQuestions(this.db.prepare('SELECT request_id FROM notifications WHERE id=?').get(id)?.request_id??null);
  }
  quarantineDelivery(id,reason) {
    return this.db.prepare("UPDATE notifications SET state='suppressed',last_error=?,uncertain_reason=NULL WHERE id=? AND state IN ('pending','failed')").run(String(reason).slice(0,500),id).changes===1;
  }
  retryDelivery(id,reason,delayMs=1000) {
    return this.db.prepare("UPDATE notifications SET state='pending',next_at=?,last_error=?,uncertain_reason=NULL WHERE id=? AND state IN ('pending','failed')").run(this.nowMs()+delayMs,String(reason).slice(0,500),id).changes===1;
  }
  paused() { return this.db.prepare('SELECT paused_at,reason FROM operator_state WHERE id=1').get().paused_at !== null; }
  setPause(reason) { return this.transaction(() => { this.db.prepare('UPDATE operator_state SET paused_at=?,reason=? WHERE id=1').run(reason?this.stamp():null,reason||null); return {paused:!!reason,reason:reason||null}; }); }
  suppressStaleQuestion(row) {
    if(!row||!['blocker','wait'].includes(row.kind)||!row.body) return false;
    let body;try{body=JSON.parse(row.body);}catch{return false;}
    if(typeof body.note!=='string'||!Number.isInteger(body.epoch)||!Number.isInteger(body.owner_note_seq)) return false;
    if(body.question_id!==undefined) {
      const question=this.db.prepare('SELECT * FROM job_questions WHERE request_id=? AND question_id=?').get(row.request_id,body.question_id);
      let current=false;
      if(question&&question.answered_at===null&&question.epoch===body.epoch) try{this.assertQuestionGrant(row.request_id,question);current=true;}catch{}
      if(!current) return this.db.prepare("UPDATE notifications SET state='suppressed',last_error='structured question no longer current' WHERE id=? AND state IN ('pending','failed','waiting')").run(row.id).changes===1;
      return false;
    }
    const claim=this.db.prepare('SELECT epoch FROM claims WHERE request_id=?').get(row.request_id);
    if(!claim||body.epoch>=claim.epoch) return false;
    return this.db.prepare("UPDATE notifications SET state='suppressed',last_error='claim epoch superseded question' WHERE id=? AND state IN ('pending','failed','waiting')").run(row.id).changes===1;
  }
  startAttempt(id,argv) { return this.transaction(() => {
    const row=this.db.prepare('SELECT * FROM notifications WHERE id=?').get(id);
    if (!row || !['pending','failed'].includes(row.state) || this.paused()) return null;
    if(this.suppressStaleQuestion(row)) return null;
    if(!this.questionWakeCurrent(row)) { this.db.prepare("UPDATE notifications SET state='suppressed',last_error='question answer wake no longer current' WHERE id=?").run(id);return null; }
    const a=row.request_id?this.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(row.request_id):null;
    const message=row.message_id?this.db.prepare('SELECT status FROM messages WHERE message_id=?').get(row.message_id):null;
    if (a?.status==='cancelled' || a?.status==='finished'&&(row.kind==='blocker'||row.kind==='wait'&&row.body!==null) || message && message.status!=='pending' || row.kind==='watch' && (a.status==='finished'||this.db.prepare('SELECT state,notification_id FROM watches WHERE request_id=?').get(row.request_id)?.notification_id!==id)) {
      this.db.prepare("UPDATE notifications SET state='suppressed' WHERE id=?").run(id); return null;
    }
    if(row.kind==='event'&&row.request_id&&this.isProtocolJob(row.request_id)&&!this.protocolListingLive(row.request_id)) {
      this.db.prepare("UPDATE notifications SET state='suppressed',last_error='protocol retention expired' WHERE id=?").run(id);return null;
    }
    // A re-wake no longer valid is suppressed unsent: it is no last wake, so the next tick recomputes the head. A still
    // valid retry keeps its id and body.
    const stale=row.wake_kind==='rewake'&&this.rewakeStale(row);
    if (stale) { this.db.prepare("UPDATE notifications SET state='suppressed',last_error=? WHERE id=?").run(`re-wake not sent: ${stale}`,id); return null; }
    if(row.kind==='event') {
      const sub=this.db.prepare('SELECT * FROM subscriptions WHERE id=?').get(row.subscription_id);
      if(!this.subscriptionActive(sub)||!this.mayAct(sub.worker,row.request_id??row.message_id)) {this.db.prepare("UPDATE notifications SET state='suppressed',last_error='worker cannot see event' WHERE id=?").run(id);return null;}
    }
    const attemptId=`attempt_${randomUUID()}`;
    this.db.prepare("UPDATE notifications SET state='sending',attempts=attempts+1,attempt_started_at=?,attempt_id=?,argv=? WHERE id=?").run(this.stamp(),attemptId,argv?JSON.stringify(argv):null,id);
    return {...row,attempt_id:attemptId};
  }); }
  deliveryAttemptIsCurrent(id,attemptId) { return !!this.db.prepare("SELECT 1 FROM notifications WHERE id=? AND state='sending' AND attempt_id=?").get(id,attemptId); }
  // Reserve a durable owner-attention delivery for a currently attached long-poll.
  // The caller must release it on socket close; only a completed response settles it.
  deliveryKind(requestId, t3Kind) { return this.db.prepare('SELECT delivery FROM assignments WHERE request_id=?').get(requestId).delivery==='none'?'wait':t3Kind; }
  deliveryCursor(requestId) { return this.db.prepare('SELECT COALESCE(max(rowid),0) cursor FROM notifications WHERE request_id=?').get(requestId).cursor; }
  claimWaiterDelivery(requestId, cursor) { return this.transaction(() => {
    const row=this.db.prepare("SELECT * FROM notifications WHERE request_id=? AND kind IN ('t3','blocker','wait') AND state='pending' AND (rowid>? OR kind='wait') ORDER BY rowid LIMIT 1").get(requestId,cursor);
    if(!row||this.suppressStaleQuestion(row)) return null;
    const attemptId='wait:'+JSON.stringify({...waiterProcessIdentity(),nonce:randomUUID()});
    const changed=this.db.prepare("UPDATE notifications SET state='waiting',attempt_started_at=?,attempt_id=? WHERE id=? AND state='pending'").run(this.stamp(),attemptId,row.id);
    return changed.changes===1?{...row,state:'waiting',attempt_id:attemptId}:null;
  }); }
  settleWaiterDelivery(id, consume=true) { return this.transaction(() => {
    const row=this.db.prepare('SELECT kind,request_id,body FROM notifications WHERE id=?').get(id);
    const changed=this.db.prepare("UPDATE notifications SET state='delivered',last_error='',uncertain_reason=NULL WHERE id=? AND state='waiting'").run(id).changes;
    // A result notification has no body; blocker attention carries the note.
    if(consume&&changed&&row?.request_id&&row.body===null) this.consumeOnce(row.request_id,'wait');
  }); }
  // The owner received a finished report (wait delivery or admin get). Only the first receipt per request counts.
  consumeOnce(id,via) {
    this.db.prepare("UPDATE assignments SET owner_read_at=? WHERE request_id=? AND status='cancelled' AND owner_read_at IS NULL").run(this.stamp(),id);
    if(this.db.prepare("SELECT status FROM assignments WHERE request_id=?").get(id)?.status!=='finished') return false;
    if(this.db.prepare("SELECT 1 FROM lifecycle_events WHERE request_id=? AND type='consumed' LIMIT 1").get(id)) return false;
    this.lifecycle(id,'consumed','owner',via);
    return true;
  }
  // Read-only view of one request for the owner's inbox: what the owner has and has not seen. Writes nothing.
  ownerInbox(id) {
    const a=this.db.prepare('SELECT status,payload,target_worker,created_at,cancelled_at,cancelled_reason,owner_read_at FROM assignments WHERE request_id=?').get(id);
    const one=(sql,...p)=>this.db.prepare(sql).get(...p);
    const report=one('SELECT outcome,created_at FROM reports WHERE request_id=?',id);
    const cancelActor=a.status==='cancelled'?one("SELECT actor FROM lifecycle_events WHERE request_id=? AND type='cancelled' ORDER BY rowid DESC LIMIT 1",id)?.actor??null:null;
    const blockers=this.db.prepare('SELECT note,created_at FROM progress WHERE request_id=? ORDER BY id').all(id).filter(p=>/^\s*(?:BLOCKED:|QUESTION:)/im.test(p.note));
    const lastAnswer=one('SELECT max(at) at FROM owner_notes WHERE request_id=?',id)?.at??null;
    const lastBlocker=blockers.at(-1)??null;
    return {
      target_worker:a.target_worker,brief:String(JSON.parse(a.payload).brief??''),created_at:a.created_at,
      finished_at:report?.created_at??null,outcome:report?.outcome??null,
      consumed:!!one("SELECT 1 FROM lifecycle_events WHERE request_id=? AND type='consumed' LIMIT 1",id),
      decision:this.latestDecision(id)?.decision??null,
      // The finished result reached the owner's T3 thread: a 't3' notification the bridge sent ('delivered' via finishAttempt) or
      // that the transcript check confirmed ('delivered' via reconciled). A sent-but-uncertain, failed or pending one does not count.
      delivered_t3:!!one("SELECT 1 FROM notifications WHERE request_id=? AND kind='t3' AND state='delivered' LIMIT 1",id),
      cancelled_at:a.cancelled_at,cancelled_reason:a.cancelled_reason??null,cancelled_by_owner:cancelActor==='owner',read:a.owner_read_at!==null,
      ...this.failureFields(id),
      unanswered_blocker:lastBlocker&&(lastAnswer===null||lastBlocker.created_at>lastAnswer)?{text:lastBlocker.note,at:lastBlocker.created_at}:null,
    };
  }
  // Owner action for `dalan inbox --mark-read`: the same read marker as get, without fetching the result. True when it was unread.
  markInboxRead(id,via) { return this.transaction(() => {
    const status=this.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(id).status, v=this.ownerInbox(id);
    const unread=status==='finished'?!v.consumed:status==='cancelled'?!v.read:false;
    this.consumeOnce(id,via); return unread;
  }); }
  recordConsumed(id,via) { return this.transaction(() => this.consumeOnce(id,via)); }
  // Latest decision on a request: the decisions table, else the legacy accept/reject events from before it existed.
  latestDecision(id) {
    const row=this.db.prepare('SELECT decision,actor,at FROM decisions WHERE request_id=? ORDER BY id DESC LIMIT 1').get(id);
    if(row) return row;
    const legacy=this.db.prepare("SELECT type,at FROM lifecycle_events WHERE request_id=? AND (type='accepted' OR type='consumed' AND reason LIKE 'rejected%') ORDER BY id DESC LIMIT 1").get(id);
    return legacy?{decision:legacy.type==='accepted'?'accepted':'not_useful',actor:'owner',at:legacy.at}:null;
  }
  // Record a decision on a finished report. Append-only: a different decision is added and the latest wins; the same decision
  // again is a no-op. accepted and applied also write the 'accepted' event, not_useful the legacy reject event, so readers of
  // those events keep working; an owner decision also counts as the owner read.
  decide(id,decision,opts={}) { return this.transaction(() => this.recordDecision(id,decision,opts)); }
  recordDecision(id,decision,{note=null,actor='owner',via='cli'}={}) {
    if(!decisionTypes.includes(decision)) throw new Error(`decision must be one of ${decisionTypes.join(', ')}`);
    const a=this.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(id); if(!a) throw new Error('assignment not found');
    if(a.status!=='finished') throw new Error('only a finished assignment can be decided');
    const latest=this.db.prepare('SELECT decision,actor FROM decisions WHERE request_id=? ORDER BY id DESC LIMIT 1').get(id);
    if(decision==='stale'&&(actor!=='system'||this.latestDecision(id))) return {request_id:id,decision:latest?.decision??null,duplicate:true};
    if(latest&&latest.decision===decision&&latest.actor===actor) return {request_id:id,decision,duplicate:true,at:this.stamp()};
    const at=this.stamp();
    this.db.prepare('INSERT INTO decisions(request_id,decision,note,actor,via,at) VALUES(?,?,?,?,?,?)').run(id,decision,note,actor,via,at);
    if(actor==='owner') {
      this.consumeOnce(id,'decide');
      if(decision==='accepted'||decision==='applied') this.lifecycle(id,'accepted','owner',decision==='applied'?(note?`applied: ${note}`:'applied'):note);
      else if(decision==='not_useful') this.lifecycle(id,'consumed','owner',note?`rejected: ${note}`:'rejected');
    }
    return {request_id:id,decision,note,at};
  }
  // Owner verdicts on a finished report (accept and reject, kept as aliases of decide accepted and not_useful).
  verdict(id,accepted,note=null) {
    const r=this.decide(id,accepted?'accepted':'not_useful',{note});
    return {request_id:id,verdict:accepted?'accepted':'rejected',decision:r.decision,note,at:r.at??this.stamp()};
  }
  // Finished reports with no decision for `days` days get decision 'stale' (actor system). Looks back at most 90 days and
  // records at most `limit` per call, oldest first, so a first run on an old database stays small.
  sweepStaleDecisions(days,{limit=500,now=Date.now()}={}) { return this.transaction(() => {
    const ids=this.db.prepare(`SELECT r.request_id FROM reports r JOIN assignments a USING(request_id) WHERE a.status='finished' AND r.created_at<? AND r.created_at>=?
      AND NOT EXISTS(SELECT 1 FROM decisions d WHERE d.request_id=r.request_id)
      AND NOT EXISTS(SELECT 1 FROM lifecycle_events e WHERE e.request_id=r.request_id AND (e.type='accepted' OR e.type='consumed' AND e.reason LIKE 'rejected%'))
      ORDER BY r.created_at LIMIT ?`).all(new Date(now-days*86400000).toISOString(),new Date(now-90*86400000).toISOString(),limit).map(r=>r.request_id);
    for(const id of ids) this.recordDecision(id,'stale',{actor:'system',via:'sweep',note:`no decision in ${days} days`});
    return ids;
  }); }
  // The fix loop reports a merged PR. Idempotent per request.
  integrated(id,reason=null) { return this.transaction(() => {
    if(!this.hasAssignment(id)) throw new Error('assignment not found');
    const old=this.db.prepare("SELECT at FROM lifecycle_events WHERE request_id=? AND type='integrated' LIMIT 1").get(id);
    if(old) return {request_id:id,integrated_at:old.at,duplicate:true};
    this.lifecycle(id,'integrated','fix-loop',reason);
    return {request_id:id,integrated_at:this.stamp(),duplicate:false};
  }); }
  releaseWaiterDelivery(id, reason='waiter disconnected') { return this.transaction(()=>{
    const row=this.db.prepare('SELECT * FROM notifications WHERE id=?').get(id);
    if(this.suppressStaleQuestion(row)) return;
    this.db.prepare("UPDATE notifications SET state='pending',next_at=0,last_error=? WHERE id=? AND state='waiting'").run(reason,id);
    this.suppressFinishedQuestions(row?.request_id??null);
  }); }
  finishAttempt(id,attemptId,state,reason='') { return this.transaction(() => {
    const row=this.db.prepare('SELECT kind,request_id,attempts FROM notifications WHERE id=?').get(id);
    const changed=this.db.prepare('UPDATE notifications SET state=?,last_error=?,uncertain_reason=?,next_at=? WHERE id=? AND attempt_id=? AND state=\'sending\'').run(state,reason,state==='uncertain'?reason:null,Date.now()+Math.min(60000,1000*2**Math.min(row.attempts,6)),id,attemptId).changes;
    // Webhook events are not a destination and write no lifecycle event.
    if(changed&&row.request_id&&['t3','blocker','watch'].includes(row.kind)&&(state==='delivered'||state==='uncertain')) this.lifecycle(row.request_id,state==='delivered'?'delivery_sent':'delivery_uncertain','system',row.kind);
  }); }
  recoverSends() { return this.transaction(() => {
    const rows=this.db.prepare("SELECT id,kind,request_id FROM notifications WHERE state='sending'").all();
    for (const row of rows) {
      this.db.prepare("UPDATE notifications SET state=?,uncertain_reason='interrupted send' WHERE id=?").run(row.kind==='event'?'failed':'uncertain',row.id);
      if(row.request_id&&['t3','blocker','watch'].includes(row.kind)) this.lifecycle(row.request_id,'delivery_uncertain','system',`${row.kind}: interrupted send`);
    }
    for(const row of this.db.prepare("SELECT * FROM notifications WHERE state='waiting'").all()) {
      // Absence of a local waiter Map is not evidence that another process died.
      if(!waiterOwnerGone(row.attempt_id)) continue;
      if(!this.suppressStaleQuestion(row)) this.db.prepare("UPDATE notifications SET state='pending',next_at=0,last_error='waiter owner exited' WHERE id=? AND state='waiting'").run(row.id);
    }
    this.suppressFinishedQuestions();
    return rows;
  }); }
  due() { return this.db.prepare("SELECT * FROM notifications WHERE kind IN ('event','t3','blocker','watch','break') AND state IN ('pending','failed') AND next_at<=? ORDER BY next_at,created_at,id LIMIT 10").all(Date.now()); }
  uncertain(id) { return this.db.prepare("SELECT * FROM notifications WHERE state IN ('uncertain','uncertain_terminal') AND kind IN ('t3','watch','blocker','break') AND (? IS NULL OR request_id=?) ORDER BY COALESCE(last_reconciled_at,'') ASC,created_at ASC").all(id??null,id??null); }
  uncertainOne(id) { return this.db.prepare("SELECT * FROM notifications WHERE state IN ('uncertain','uncertain_terminal') AND kind IN ('t3','watch','blocker','break') AND request_id=? ORDER BY COALESCE(last_reconciled_at,'') ASC,created_at ASC LIMIT 1").get(id)??null; }
  uncertainDue(now=this.nowMs()) { return this.uncertainBatch(now,1)[0]??null; }
  uncertainBatch(now=this.nowMs(),limit=25) {
    if(!Number.isFinite(now)||!Number.isInteger(now)||!Number.isFinite(new Date(now-60000).getTime())) return [];
    if(!Number.isInteger(limit)||limit<1||limit>25) throw new Error('invalid reconciliation batch limit');
    return this.db.prepare("SELECT * FROM notifications WHERE state IN ('uncertain','uncertain_terminal') AND kind IN ('t3','watch','blocker','event') AND next_at<=? AND (last_reconciled_at IS NULL OR last_reconciled_at<=?) ORDER BY COALESCE(last_reconciled_at,'') ASC,created_at ASC,id ASC LIMIT ?").all(now,iso(now-60000),limit);
  }
  reconciled(id,state,reason,{attemptId,threadId,environmentId,targetWorker,attemptStartedAt,body,argv,assignmentStatus,deliveryMode,reportSnapshot}={}) { return this.transaction(() => {
    const row=this.db.prepare('SELECT n.*,a.thread_id,a.environment_id,a.target_worker FROM notifications n LEFT JOIN assignments a USING(request_id) WHERE n.id=?').get(id);
    // get() projects legacy empty thread/environment strings as null in the captured snapshot.
    if(!row||!['uncertain','uncertain_terminal'].includes(row.state)||row.attempt_id!==attemptId||row.attempt_started_at!==attemptStartedAt||row.body!==body||row.argv!==argv||(row.thread_id||null)!==threadId||(row.environment_id||null)!==environmentId||row.target_worker!==targetWorker) return false;
    const assignment=this.db.prepare('SELECT status,delivery delivery_mode FROM assignments WHERE request_id=?').get(row.request_id);
    if((assignment?.status??null)!==assignmentStatus||(assignment?.delivery_mode??null)!==deliveryMode) return false;
    const report=this.db.prepare('SELECT outcome,summary,result FROM reports WHERE request_id=?').get(row.request_id)??null;
    if(JSON.stringify(report)!==reportSnapshot) return false;
    // Missing proof cannot turn an aged unknown into a fresh retry cycle.
    if(row.state==='uncertain_terminal'&&state==='uncertain') state='uncertain_terminal';
    const changed=this.db.prepare("UPDATE notifications SET state=?,last_reconciled_at=?,uncertain_reason=?,last_error=?,next_at=? WHERE id=? AND state IN ('uncertain','uncertain_terminal') AND attempt_id IS ? AND attempt_started_at IS ? AND body IS ? AND argv IS ?").run(state,this.stamp(),['uncertain','uncertain_terminal'].includes(state)?reason:null,reason,this.nowMs()+60000,id,attemptId,attemptStartedAt,body,argv).changes;
    if(changed&&state==='delivered'&&row.request_id&&!['break','event'].includes(row.kind)) this.lifecycle(row.request_id,'reconciled','system',row.kind);
    return changed===1;
  }); }
  releaseAgedUncertain(observedIds=null) { return this.transaction(()=>{
    const now=this.nowMs(); if(!Number.isFinite(now)||!Number.isInteger(now)||!Number.isFinite(new Date(now).getTime())) return [];
    if(observedIds!==null&&(!Array.isArray(observedIds)||observedIds.length>25||observedIds.some(id=>typeof id!=='string'))) throw new Error('invalid observed reconciliation IDs');
    if(observedIds?.length===0) return [];
    const filter=observedIds===null?'':` AND id IN (${observedIds.map(()=>'?').join(',')})`;
    const candidates=this.db.prepare("SELECT * FROM notifications WHERE state='uncertain' AND kind IN ('t3','watch','blocker','event')"+filter+" ORDER BY COALESCE(attempt_started_at,created_at) ASC,COALESCE(last_reconciled_at,'') ASC,created_at ASC LIMIT 100").all(...(observedIds??[]));
    const released=[];
    for(const row of candidates) {
      const started=Date.parse(row.attempt_started_at||row.created_at);
      if(!Number.isFinite(started)||now<started||now-started<UNCERTAIN_DELIVERY_MAX_AGE_MS) continue;
      const reason='delivery unknown, not proven undelivered; automatic retries ended after 30 minutes; new claims require positive reconciliation',at=this.stamp();
      const changed=this.db.prepare("UPDATE notifications SET state='uncertain_terminal',terminal_at=?,terminal_reason=?,last_error=?,uncertain_reason=? WHERE id=? AND state='uncertain'").run(at,reason,reason,reason,row.id).changes;
      if(!changed) continue;
      this.db.prepare('INSERT INTO uncertain_delivery_alerts(notification_id,request_id,created_at,reason) VALUES(?,?,?,?) ON CONFLICT(notification_id) DO NOTHING').run(row.id,row.request_id,at,reason);
      released.push({id:row.id,request_id:row.request_id,at,reason});
      if(released.length===25) break;
    }
    return released;
  }); }
  pendingDeliveryAlerts() { return this.db.prepare('SELECT x.*,n.message_id FROM uncertain_delivery_alerts x JOIN notifications n ON n.id=x.notification_id WHERE x.published_at IS NULL ORDER BY x.created_at,x.notification_id LIMIT 25').all(); }
  deliveryAlertLogged(id) { this.db.prepare('UPDATE uncertain_delivery_alerts SET logged_at=? WHERE notification_id=? AND logged_at IS NULL').run(this.stamp(),id); }
  deliveryAlertPublished(id) { this.db.prepare('UPDATE uncertain_delivery_alerts SET published_at=? WHERE notification_id=? AND published_at IS NULL').run(this.stamp(),id); }
  eventResult(subscriptionId,status) { this.db.prepare('UPDATE subscriptions SET last_event_2xx_at=CASE WHEN ? BETWEEN 200 AND 299 THEN ? ELSE last_event_2xx_at END,auth_failures=CASE WHEN ? IN (401,403) THEN auth_failures+1 ELSE 0 END WHERE id=?').run(status,this.stamp(),status,subscriptionId); }
  adopt(id,ownerToken) { return this.transaction(() => { const row=this.db.prepare('SELECT owner_hash FROM assignments WHERE request_id=?').get(id); if(!row) throw new Error('assignment not found'); if(row.owner_hash) throw new Error('request already owned'); this.db.prepare('UPDATE assignments SET owner_hash=? WHERE request_id=?').run(hash(ownerToken),id); return {request_id:id,adopted:true}; }); }
  status({limits=this.limits,capacity=this.capacity,backgroundMaxInFlight=this.backgroundMaxInFlight}={}) {
    // Queued counts are live: rows past valid_until are reported as queued_expired, and protocol jobs past retention are
    // left out, never counted as queue, cap or throttle room.
    const queuedExpired=this.queuedExpired(), queuedExpiredRequeued=this.queuedExpiredRequeued();
    const counts=this.db.prepare(`SELECT status,count(*) count FROM assignments WHERE status<>'queued' OR ${live(this.nowMs())} GROUP BY status`).all().filter(x=>x.count>0);
    const sub=this.db.prepare("SELECT * FROM subscriptions WHERE worker='dot' ORDER BY verified_at DESC LIMIT 1").get();
    const active=this.activeSubscriptions().filter(sub=>sub.worker==='dot');
    const oldest=this.db.prepare(`SELECT min(created_at) oldest FROM assignments WHERE target_worker='dot' AND status='queued' AND ${live(this.nowMs())}`).get().oldest;
    const lastClaim=this.db.prepare("SELECT max(claimed_at) last_claim FROM claims WHERE worker='dot'").get().last_claim;
    const uncertain=this.db.prepare("SELECT count(*) n FROM notifications WHERE state='uncertain' AND kind IN ('t3','watch','blocker','break','event')").get().n;
    const pause=this.db.prepare('SELECT paused_at,reason FROM operator_state WHERE id=1').get();
    const queued=this.queuedRows().filter(row=>row.target_worker==='dot').length;
    const dotQueuedWithoutSubscription=active.length===0&&!!this.db.prepare(`SELECT 1 FROM assignments WHERE target_worker='dot' AND status='queued' AND ${live(this.nowMs())} LIMIT 1`).get();
    const subscription={state:!sub?'absent':sub.state==='revoked'?'revoked':sub.rotation_blocked?'rotation_blocked':sub.auth_failures>=3?'callback_blocked':sub.expires_at<=this.stamp()?'expired':'active',expires_at:sub?.expires_at||null,last_verified_at:sub?.verified_at||null,last_event_2xx_at:sub?.last_event_2xx_at||null,last_claim_at:lastClaim,principal:sub?.principal||null,auth_failures:sub?.auth_failures||0};
    const priority_counts=Object.fromEntries(['normal','background'].map(priority=>[priority,Object.fromEntries(['queued','claimed'].map(status=>[status,this.db.prepare(`SELECT count(*) n FROM assignments WHERE priority=? AND status=? AND (status<>'queued' OR ${live(this.nowMs())})`).get(priority,status).n]))]));
    const throttle=this.rollingUsage(limits);
    const budget={window:'rolling_24h',calls_used:throttle.tool_calls_last_24h,calls_cap:throttle.max_tool_calls_per_24h,
      bytes_used:throttle.response_bytes_last_24h,bytes_cap:throttle.max_response_bytes_per_24h};
    budget.remaining_fraction=Math.round(Math.max(0,Math.min(1,1-budget.calls_used/budget.calls_cap,1-budget.bytes_used/budget.bytes_cap))*1000)/1000;
    const denied=this.deniedQueued();
    const dotCapacity=this.workerCapacityEvidence('dot',active,limits,capacity);
    const freeLanes=dotCapacity.free_lanes;
    const legacyScope=this.workers.legacy===true||this.workers.workers.has('dot')?'dot':'none';
    const dispatch={scope:legacyScope,state:pause.paused_at?'paused':freeLanes===null?'unknown':freeLanes<=0?'full':queued>0?'dispatch_gap':'supply_gap',free_lanes:freeLanes,queued_live:queued,oldest_unclaimed_age_ms:oldest?this.nowMs()-Date.parse(oldest):null};
    const workerNames=new Set([...this.workers.workers.keys(),...this.db.prepare('SELECT DISTINCT target_worker worker FROM assignments').all().map(r=>r.worker),...this.db.prepare('SELECT DISTINCT worker FROM claims').all().map(r=>r.worker)]);
    const by_worker=Object.fromEntries([...workerNames].sort().map(worker=>{
      const workerSubscriptions=worker==='dot'?active:this.activeSubscriptions().filter(row=>row.worker===worker);
      const liveness=this.liveness(limits,capacity,worker),expired=this.queuedExpired(worker);
      const requeued=this.queuedExpiredRequeued(worker);
      const workerCounts=this.db.prepare(`SELECT status,count(*) count FROM assignments WHERE target_worker=? AND (status<>'queued' OR ${live(this.nowMs())}) GROUP BY status`).all(worker).filter(row=>row.count>0);
      const liveQueued=this.queuedRows().filter(row=>row.target_worker===worker).length;
      return [worker,{scope:'worker',counts:workerCounts,queued_expired:expired,queued_expired_requeued:requeued,active_claims:liveness.claimed_outer_count,queued_live:liveQueued,subscriptions_active:workerSubscriptions.length,capacity:this.workerCapacityEvidence(worker,workerSubscriptions,limits,capacity),last_call_at:liveness.last_worker_call_at,last_list_pending_at:liveness.last_list_pending_at,stale_claims:liveness.stale_claims,queue_classes:liveness.queue_classes,unclaimed_after_reannounce:liveness.unclaimed_after_reannounce,oldest_claim_age_ms:liveness.oldest_claim_age_ms,oldest_claim_progress_age_ms:liveness.oldest_claim_progress_age_ms,oldest_unclaimed_event_2xx_age_ms:liveness.oldest_unclaimed_event_2xx_age_ms,silence_ms:liveness.worker_silence_ms}];
    }));
    const released=this.db.prepare("SELECT id,id notice_id,request_id,message_id,subscription_id,attempt_id,attempt_started_at,terminal_at,terminal_reason FROM notifications WHERE state='uncertain_terminal' ORDER BY terminal_at DESC LIMIT 20").all();
    return {dispatch,liveness_scope:legacyScope,counts,counts_scope:'global',by_worker,priority_counts,priority_counts_scope:'global',background_max_in_flight:backgroundMaxInFlight,skipped_by_worker:(skipped=>({count:skipped.length,request_ids:skipped.slice(0,20).map(x=>x.request_id)}))(this.skippedByDot()),claim_denied:{count:denied.length,request_ids:denied.map(d=>d.request_id).slice(0,20),capacity_hold_until:this.capacityHoldUntil()},subscriptions_active:active.length,last_verified:sub?.verified_at||null,oldest_pending:oldest,last_claim:lastClaim,last_claim_at:lastClaim,subscription,queued_without_active_subscription:dotQueuedWithoutSubscription,oldest_queue_age_ms:oldest?this.nowMs()-Date.parse(oldest):null,uncertain_deliveries:uncertain,uncertain_terminal_deliveries:released,queued_expired:queuedExpired,queued_expired_requeued:queuedExpiredRequeued,paused:!!pause.paused_at,pause_reason:pause.reason,...(({items,...rest})=>rest)(this.liveness(limits,capacity)),worker_break:this.breakState(),throttle,budget,...statusEvidence(this)};
  }
  workerCapacityEvidence(worker,subscriptions,limits,capacity) {
    const byPrincipal=[...new Map(subscriptions.map(sub=>[sub.principal,sub])).values()];
    const scope=this.workers.laneScope==='worker'?'worker':'principal';
    const unknown=reason=>({state:'unknown',scope,source:null,free_lanes:null,unknown_reason:reason});
    if(!byPrincipal.length) return unknown('no_active_subscription');
    const subjectKeys=this.db.prepare("SELECT DISTINCT c.lane_key FROM claims c JOIN assignments a USING(request_id) WHERE c.worker=? AND c.state='active' AND c.lane_scope='subject' AND a.status='claimed'").all(worker).map(row=>row.lane_key);
    const principals=[...new Set([...byPrincipal.map(sub=>sub.principal),...subjectKeys])];
    if((scope==='principal'||subjectKeys.length>0)&&principals.length>1) {
      return {...unknown('ambiguous_principal_scope'),by_principal:Object.fromEntries(principals.map(principal=>{
        const sub=byPrincipal.find(row=>row.principal===principal);
        return [principal,sub?{free_lanes:this.subscriptionFreeLanes(sub,limits.laneCapacity??6,capacity),lane_scope:'subject',lane_key:principal}:{free_lanes:null,lane_scope:'subject',lane_key:principal,unknown_reason:'no_active_subscription'}];
      }))};
    }
    const sub=byPrincipal[0];
    const lanes=this.subscriptionFreeLanes(sub,limits.laneCapacity??6,capacity);
    const laneEvidence=this.db.prepare("SELECT DISTINCT c.lane_scope,c.lane_key FROM claims c JOIN assignments a USING(request_id) WHERE c.worker=? AND c.state='active' AND a.status='claimed' ORDER BY c.lane_scope,c.lane_key").all(worker).map(row=>({lane_scope:row.lane_scope,lane_key:row.lane_key}));
    return {state:'known',scope,source:'subscription_policy',free_lanes:lanes,lane_capacity:Math.min(limits.laneCapacity??6,capacity),principal:scope==='principal'?sub.principal:undefined,lane_evidence:laneEvidence};
  }
}
