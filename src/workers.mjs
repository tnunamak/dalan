import { defaultPath } from './paths.mjs';
import { readEnv } from './env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { writeAtomic } from './as-files.mjs';
import { parseExecution } from './execution.mjs';

const fail=message=>{throw new Error(`workers: ${message}`);};
const object=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k))) fail(`expected object with keys ${keys.join(', ')}`);};
const text=v=>{if(typeof v!=='string'||!v||v.length>2048) fail('connection fields must be non-empty strings');return v;};
const legacyWorker={connections:[],capabilities:new Set(['t3']),guidance:'resume'};
const repoPart=/^[A-Za-z0-9_.-]+$/;
function validRepoName(repo) {
  if(typeof repo!=='string'||repo.split('/').length!==2) return false;
  return repo.split('/').every(part=>repoPart.test(part)&&part!=='.'&&part!=='..'&&!part.includes('..'));
}
export function parseRepoPattern(pattern) {
  if(typeof pattern!=='string'||!pattern) fail('repos must contain exact OWNER/REPO entries');
  if(!validRepoName(pattern)) fail(`invalid repository "${pattern}"; use exact OWNER/REPO (wildcards are unsupported)`);
  return pattern;
}
function normalizeRepoSettings(config,name) {
  if(Object.hasOwn(config,'repo_access')) fail(`${name}.repo_access is unsupported; use an exact repos list`);
  if(Object.hasOwn(config,'denied_repos')) fail(`${name}.denied_repos is unsupported; use an exact repos list`);
  const hasRepos=Object.hasOwn(config,'repos');
  if(hasRepos&&(!Array.isArray(config.repos)||config.repos.some(r=>typeof r!=='string'))) fail(`${name}.repos must be an array of exact OWNER/REPO entries`);
  const repos=hasRepos?config.repos.map(parseRepoPattern):[];
  if(repos&&new Set(repos.map(r=>r.toLowerCase())).size!==repos.length) fail(`${name}.repos must not contain duplicate repositories`);
  return {repos};
}
function repoMatches(pattern,repo) {
  if(!validRepoName(repo)) return false;
  const [owner,name]=repo.split('/'),[allowedOwner,allowedName]=pattern.split('/');
  return owner.toLowerCase()===allowedOwner.toLowerCase()&&name.toLowerCase()===allowedName.toLowerCase();
}
// Only configuration loading chooses legacy semantics; claims record the returned lane scope as a fact.
export const LEGACY_PROFILE={legacy:true,workers:new Map([['dot',legacyWorker]]),resolve:()=> 'dot',laneScope:'subject',defaultExecution:'host',
  allowsRepo:()=>false,repoPolicy:worker=>worker==='dot'?{mode:'exact',repos:[]}:null};
// An existing install is a database that already carries a schema. An empty or schema-less bridge.db (a touched file,
// a restore step) is not one. The check opens read-only, so it never creates or modifies the file.
export function hasInstalledDatabase(file) {
  let db;
  try {
    if(!fs.statSync(file).size) return false;
    db=new DatabaseSync(file,{readOnly:true});
    return db.prepare('PRAGMA user_version').get().user_version>0;
  } catch { return false; }
  finally { try { db?.close(); } catch {} }
}
// `dalan init --legacy` writes this file next to the generated authorization-server files. The server treats it as the
// owner's explicit choice of the single-worker legacy profile, so a first start needs no environment variable.
export const LEGACY_MARKER_FILE='legacy-profile';
export const legacyMarkerPath=configDir=>path.join(configDir,LEGACY_MARKER_FILE);
export function writeLegacyMarker(configDir) { writeAtomic(legacyMarkerPath(configDir),'legacy\n'); }
export function parseWorkers(value,{builtin=false,builtinConnectionIds}={}) {
  object(value,['workers','default_execution']); object(value.workers,Object.keys(value.workers??{}));
  const workers=new Map();
  for(const [name,config] of Object.entries(value.workers)) {
    if(name==='pool'||name==='unknown') fail(`worker name "${name}" is reserved and unsupported`);
    if(!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) fail('invalid worker name');
    if(Object.hasOwn(config??{},'pool')) fail(`${name}.pool is not supported`);
    object(config,['connections','capabilities','guidance','repos','repo_access','denied_repos','destination','workspaceAllowed']);
    const repoSettings=normalizeRepoSettings(config,name);
    if(config.guidance!==undefined&&config.guidance!=='resume') fail(`${name}.guidance may only be "resume"`);
    if(builtin&&config.connections!==undefined&&!(Array.isArray(config.connections)&&!config.connections.length)) fail(`${name}.connections must be absent in built-in mode; connections are recorded by dalan connect approve`);
    if(!builtin&&(!Array.isArray(config.connections)||!config.connections.length)) fail(`${name} needs connections`);
    const connections=(builtin?[]:config.connections).map(record=>{
      object(record,['issuer','subject','client_id','connection_id']);
      const result=Object.fromEntries(Object.entries(record).map(([k,v])=>[k,text(v)]));
      text(result.issuer);
      // The operator names the principal. connection_id and client_id only narrow it, so a record without a subject would
      // let any other allowed subject that presents the same pin become this worker.
      if(!result.subject) fail(`${name}: every connection record needs a subject; add "subject" (the token's sub claim) to the record`);
      text(result.subject);
      if(!result.connection_id) text(result.client_id);
      return result;
    });
    if(config.workspaceAllowed!==undefined&&typeof config.workspaceAllowed!=='boolean') fail(`${name}.workspaceAllowed must be boolean`);
    const caps=config.capabilities??[];
    if(!Array.isArray(caps)||caps.some(c=>c!=='t3')) fail('capabilities may only contain t3');
    workers.set(name,{connections,capabilities:new Set(caps),...(config.workspaceAllowed!==undefined?{workspaceAllowed:config.workspaceAllowed}:{}),...(config.guidance?{guidance:config.guidance}:{}),...repoSettings,
      ...(Object.hasOwn(config,'destination')?{destination:parseDestinationDeclaration(config.destination)}:{})});
  }
  if(!workers.size) fail('workers must not be empty');
  const defaultExecution=value.default_execution===undefined?'none':parseExecution(value.default_execution,'workers: default_execution');
  return {workers,...(builtin&&builtinConnectionIds?{builtinConnectionIds}:{}),laneScope:'worker',defaultExecution,allowsRepo(worker,repo){
    const setting=workers.get(worker);
    if(!setting||!validRepoName(repo)) return false;
    return setting.repos.some(pattern=>repoMatches(pattern,repo));
  },repoPolicy(worker){
    const setting=workers.get(worker);
    if(!setting) return null;
    return {mode:'exact',repos:[...setting.repos]};
  },resolve:principal=>{
    if(principal.local&&workers.has('dot')) return 'dot';
    const matches=[];
    for(const [name,worker] of workers) for(const record of worker.connections)
      if(Object.entries(record).every(([key,v])=>principal[key]===v)) matches.push(name);
    if(matches.length!==1) {
      const code=matches.length?'conflicting_connection':'unknown_connection';
      throw Object.assign(new Error(code),{code});
    }
    return matches[0];
  }};
}

const destinationFields=['operator','provider','data_categories','retention','training','terms'];
function parseDestinationDeclaration(value) {
  object(value,destinationFields);
  const result={};
  for(const field of destinationFields) {
    const entry=value[field]??null;
    if(field==='data_categories') {
      if(entry!==null&&(!Array.isArray(entry)||entry.length>32||entry.some(x=>typeof x!=='string'||!x.trim()||x.length>256)))
        fail('destination.data_categories must be null or at most 32 nonempty strings');
      result[field]=entry===null?null:[...new Set(entry)].sort();
    } else {
      if(entry!==null&&(typeof entry!=='string'||!entry.trim()||entry.length>2048))
        fail('destination.'+field+' must be null or a nonempty string of at most 2048 characters');
      result[field]=entry;
    }
  }
  return result;
}
// The digest of the connections a worker has now. A retry compares it with the approved snapshot without a full disclosure.
export function connectionsDigest(profile,worker) {
  const connections=profile.builtinConnectionIds
    ? [...new Set(profile.builtinConnectionIds(worker).map(text))].sort()
    : (profile.workers.get(worker).connections??[]).map(connection=>
    JSON.stringify([connection.issuer??null,connection.subject??null,connection.client_id??null,connection.connection_id??null])).sort();
  return 'sha256:'+createHash('sha256').update(JSON.stringify(connections)).digest('hex');
}
// Identity covers the normalized declaration, worker, execution and connection identities.
// Repository policy is a separate current restriction, not part of destination identity.
export function destinationDisclosure(profile,worker,execution,assignment={}) {
  if(!profile?.workers||!profile.workers.has(worker))throw new Error('destination configuration unavailable for worker '+worker);
  const declaration=profile.workers.get(worker).destination;
  if(declaration===undefined)return null;
  // Built-in mode records connections through dalan connect approve, so a
  // worker's configured connections are always empty there; the live set can
  // only come from the callback. Without it the disclosure would silently bind
  // the digest of the empty set, so refuse loudly instead. External-OAuth
  // workers always carry non-empty configured connections, so they never hit
  // this branch.
  if(typeof profile.builtinConnectionIds!=='function'&&(profile.workers.get(worker).connections??[]).length===0)
    throw new Error('destination live-connection callback required for worker '+worker+' in built-in mode');
  const connections_digest=connectionsDigest(profile,worker);
  const identity={schema_version:1,worker,execution,connections_digest,declaration:parseDestinationDeclaration(declaration)};
  const revision='sha256:'+createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const repositories=(assignment.inputs??[]).filter(input=>input?.github_repo!==undefined).map(input=>input.github_repo);
  return {...identity,revision,
    assurance:{worker:'checked',execution:'checked',...Object.fromEntries(destinationFields.map(field=>[field,identity.declaration[field]===null?'unknown':'declared']))},
    policy:{assurance:'checked',allowed:repositories.every(repo=>profile.allowsRepo(worker,repo)),repositories}};
}
export function destinationDifferences(approved,current) {
  const fields=['worker','execution','connections_digest',...destinationFields];
  return fields.flatMap(field=>{
    const before=destinationFields.includes(field)?approved?.declaration?.[field]??null:approved?.[field]??null;
    const after=destinationFields.includes(field)?current?.declaration?.[field]??null:current?.[field]??null;
    return JSON.stringify(before)===JSON.stringify(after)?[]:[{field,approved:before,current:after}];
  });
}
export function destinationError(details) {
  return Object.assign(new Error(JSON.stringify(details)),{destination:details});
}

export function loadWorkers(file=readEnv('DALAN_WORKERS_FILE')||defaultPath(os.homedir(),'.config/dot-bridge/workers.json'),options={}) {
  try {
    if((fs.statSync(file).mode&0o777)!==0o600) fail('file must be mode 0600');
    const {auditGrants=false,...parseOptions}=options;
    const profile=parseWorkers(JSON.parse(fs.readFileSync(file,'utf8')),parseOptions);
    if(auditGrants) auditProfileGrants(file,profile,parseOptions);
    return profile;
  } catch(error) {if(error.code==='ENOENT') return legacyRepoProfile(file,options.auditGrants===true);throw error;}
}
export function loadOwnerWorkers(file=readEnv('DALAN_WORKERS_FILE')||defaultPath(os.homedir(),'.config/dot-bridge/workers.json')) {
  try {
    if((fs.statSync(file).mode&0o777)!==0o600) fail('file must be mode 0600');
    return parseOwnerWorkers(JSON.parse(fs.readFileSync(file,'utf8')));
  } catch(error) { if(error.code==='ENOENT') return legacyRepoProfile(file);throw error; }
}
function parseOwnerWorkers(value) {
  const entries=Object.values(value?.workers??{});
  // Built-in profiles permit both absent and empty connection arrays. Only persisted records imply external OAuth.
  const external=entries.some(worker=>Array.isArray(worker?.connections)&&worker.connections.length>0);
  return parseWorkers(value,{builtin:!external});
}
export function resolveWorker(profile,principal) {
  if(principal.builtin) {
    const name=principal.connection?.worker;
    if(typeof name!=='string'||!profile.workers.has(name)) throw Object.assign(new Error('unknown_connection'),{code:'unknown_connection'});
    return name;
  }
  return profile.resolve(principal);
}
export const visibleTargets=(profile,worker)=>profile.workers.has(worker)?[worker]:[];
export const canSee=(profile,worker,target)=>profile.workers.has(worker)&&worker===target;
export const hasCapability=(profile,worker,capability)=>profile.workers.get(worker)?.capabilities.has(capability)===true;
export function assertTarget(profile,worker) {
  if(worker==='pool') throw new Error('worker "pool" is not supported');
  if(!profile.workers.has(worker)) throw new Error(`unknown worker "${worker}"; configured workers: ${[...profile.workers.keys()].join(', ')}`);
  return worker;
}
// One source of truth for a fresh generic host: one named worker, no t3 capability, no host execution. Never overwrites.
export function writeGenericProfile(file,name,{workspaceAllowed=false}={}) {
  parseWorkers({workers:{[name]:{}}},{builtin:true});
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  try { fs.writeFileSync(file,`${JSON.stringify({workers:{[name]:{repos:[],...(workspaceAllowed?{workspaceAllowed:true}:{})}},default_execution:'none'},null,2)}\n`,{mode:0o600,flag:'wx'}); }
  catch(error) { if(error.code==='EEXIST') throw new Error(`${file} already exists; init does not overwrite a worker profile`); throw error; }
  fs.chmodSync(file,0o600);
  return file;
}
// One private journal commits the seed and its audit together. Profile publication is
// restartable; an interrupted migration reuses this seed instead of scanning again.
export const workerRepoMigrationFile = file => path.join(path.dirname(file), path.basename(file, '.json') + '-repos.json');
function readRepoMigration(file) {
  const journal=workerRepoMigrationFile(file);
  let stat;
  try {stat=fs.lstatSync(journal);} catch(error) {if(error.code==='ENOENT')return null;throw error;}
  if(!stat.isFile()||(stat.mode&0o777)!==0o600||(typeof process.getuid==='function'&&stat.uid!==process.getuid()))fail('repository migration journal must be an owned mode-0600 regular file');
  let value;try {value=JSON.parse(fs.readFileSync(journal,'utf8'));} catch {fail('repository migration journal is not valid JSON');}
  object(value,['version','entries']);
  if(value.version!==1||!Array.isArray(value.entries))fail('invalid repository migration journal');
  const seen=new Set();
  for(const entry of value.entries) {
    object(entry,['worker','kind','repos','complete','event','queued_repositories']);
    if(!/^[a-z][a-z0-9_-]{0,31}$/.test(entry.worker)||seen.has(entry.worker)||!['legacy','profile'].includes(entry.kind)||typeof entry.complete!=='boolean')fail('invalid repository migration entry');
    seen.add(entry.worker);
    normalizeRepoSettings({repos:entry.repos},entry.worker);
    object(entry.event,['event_id','at','actor','worker','before','after']);
    object(entry.event.actor,['host_uid']);object(entry.event.before,['mode','repos']);object(entry.event.after,['mode','repos']);
    if(typeof entry.event.at!=='string'||!/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(entry.event.at)||!Number.isFinite(Date.parse(entry.event.at))||!entry.event.actor||!(entry.event.actor.host_uid===null||Number.isSafeInteger(entry.event.actor.host_uid)&&entry.event.actor.host_uid>=0))fail('invalid repository migration audit identity');
    if(entry.event?.worker!==entry.worker||entry.event.before?.mode!=='legacy-any'||entry.event.before.repos!==null||entry.event.after?.mode!=='exact'||!Array.isArray(entry.event.after.repos)||entry.event.after.repos.some(repo=>!validRepoName(repo))||!/^[0-9a-f-]{36}$/.test(entry.event.event_id))fail('invalid repository migration audit');
    if(entry.queued_repositories!==undefined) {
      if(!Array.isArray(entry.queued_repositories))fail('invalid queued repository evidence');
      for(const queued of entry.queued_repositories) {
        object(queued,['repo','request_ids']);
        if(!validRepoName(queued.repo)||!entry.event.after.repos.some(repo=>repo.toLowerCase()===queued.repo.toLowerCase()))fail('queued repository is not in the original seed');
        if(!Array.isArray(queued.request_ids)||!queued.request_ids.length||queued.request_ids.some(id=>typeof id!=='string'||!id)||new Set(queued.request_ids).size!==queued.request_ids.length)fail('invalid queued repository job IDs');
      }
    }
  }
  return value;
}
function legacyRepoProfile(file,auditGrants=false) {
  const entry=readRepoMigration(file)?.entries.find(item=>item.worker==='dot'&&item.kind==='legacy');
  if(!entry)return LEGACY_PROFILE;
  const repos=auditGrants?(reconcileGrants(file,()=>new Map([['dot',readRepoMigration(file)?.entries.find(item=>item.worker==='dot'&&item.kind==='legacy')?.repos??[]]])).applied.get('dot')??[]):entry.repos;
  return {...LEGACY_PROFILE,allowsRepo:(worker,repo)=>worker==='dot'&&repos.some(pattern=>repoMatches(pattern,repo)),
    repoPolicy:worker=>worker==='dot'?{mode:'exact',repos:[...repos],source:'admitted-history'}:null};
}
// Grants that stand in the configuration with no audit record. The audit trail is the migration journal's events followed
// by workers-audit.jsonl; a worker's audited list is the `after` list of its latest event (empty when it has none).
// A hand edit of workers.json (or of the legacy journal) is not a CLI change and writes no event itself.
//
// The audit log is append-only text that a same-user process can delete. Every append therefore also records a checkpoint
// (byte length and SHA-256 of the log, last event id) in a private SQLite file beside it, and that file doubles as the
// lock that serializes every writer of the audit. A log that is missing, shorter than its checkpoint, or whose recorded
// prefix changed fails closed: no grant without a matching event applies. Without a checkpoint (an install that was never
// audited) the existing list is recorded once. A same-user actor who deletes the checkpoint file and the log together
// leaves an install that looks never-audited; that actor can equally rewrite workers.json and the queue, so this check
// detects accidents and one-sided tampering, not a full compromise of the account.
const auditFileOf=workersFile=>path.join(path.dirname(workersFile),'workers-audit.jsonl');
const checkpointFileOf=workersFile=>path.join(path.dirname(workersFile),'workers-audit-checkpoint.sqlite');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const CHECKPOINT_SQL='CREATE TABLE IF NOT EXISTS checkpoint(id INTEGER PRIMARY KEY CHECK(id=1),size INTEGER NOT NULL,sha256 TEXT NOT NULL,last_event_id TEXT)';
export const AUDIT_INTEGRITY_HINT='Grants without a matching audit event are denied. Re-approve each grant you want with dalan worker allow NAME OWNER/REPO; the first allow or deny resets workers.json to the grants the surviving audit proves and records a new baseline.';
// Serializes read, compare and append for every writer of the audit (loaders and the worker allow/deny commands).
export function withAuditLock(workersFile,fn) {
  if(!fs.existsSync(path.dirname(workersFile))) return fn(null);
  const sidecar=checkpointFileOf(workersFile);
  try {fs.closeSync(fs.openSync(sidecar,'wx',0o600));} catch(error) {if(error.code!=='EEXIST')throw error;}
  const stat=fs.lstatSync(sidecar);
  if(!stat.isFile()||(stat.mode&0o777)!==0o600||(typeof process.getuid==='function'&&stat.uid!==process.getuid())) throw new Error('audit checkpoint file is not an owned mode-0600 regular file');
  const db=new DatabaseSync(sidecar);
  try {
    db.exec('PRAGMA busy_timeout=30000');
    db.exec('BEGIN EXCLUSIVE');
    let result;
    try {db.exec(CHECKPOINT_SQL);result=fn(db);} catch(error) {try {db.exec('ROLLBACK');} catch {/* report the original error */}throw error;}
    db.exec('COMMIT');
    return result;
  } finally {db.close();}
}
// null: no checkpoint (never audited). {error}: present but unreadable, which fails closed like a mismatch.
function readCheckpoint(workersFile,db) {
  const read=handle=>handle.prepare('SELECT size,sha256,last_event_id FROM checkpoint WHERE id=1').get()??null;
  if(db) return read(db);
  const sidecar=checkpointFileOf(workersFile);
  if(!fs.existsSync(sidecar)) return null;
  let handle;
  try {
    handle=new DatabaseSync(sidecar,{readOnly:true});
    handle.exec('PRAGMA busy_timeout=30000');
    if(!handle.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='checkpoint'").get()) return null;
    return read(handle);
  } catch {return {error:'the audit checkpoint cannot be read'};}
  finally {handle?.close();}
}
function recordCheckpoint(db,auditFile) {
  if(!db) return;
  const bytes=fs.readFileSync(auditFile),lines=bytes.toString('utf8').split('\n').filter(Boolean);
  let last=null;try {last=JSON.parse(lines.at(-1)??'null')?.event_id??null;} catch {/* torn tail; the next load reports it */}
  db.prepare('INSERT OR REPLACE INTO checkpoint(id,size,sha256,last_event_id) VALUES (1,?,?,?)').run(bytes.length,sha256(bytes),last);
}
// The log may be longer than the checkpoint (an append whose checkpoint did not commit), never shorter or different.
function integrityFailure(history,checkpoint) {
  if(!checkpoint) return null;
  const where='the audit log workers-audit.jsonl';
  if(checkpoint.error) return checkpoint.error;
  if(!history.raw) return `${where} is missing or unreadable, but audit events were recorded`;
  if(history.raw.length<checkpoint.size) return `${where} is shorter than its recorded checkpoint (truncated)`;
  if(sha256(history.raw.subarray(0,checkpoint.size))!==checkpoint.sha256) return `${where} does not match its recorded checkpoint (changed)`;
  return null;
}
function auditedRepoState(workersFile,db) {
  const auditFile=auditFileOf(workersFile);
  const history=readWorkerRepoHistory(auditFile,{workersFile,maxBytes:Infinity,keepRaw:true});
  const state=new Map();
  for(const event of history.events) if(event.after.mode==='exact') state.set(event.worker,event.after.repos);
  let pending=new Set();
  try {pending=new Set((readRepoMigration(workersFile)?.entries??[]).filter(entry=>entry.kind==='profile'&&!entry.complete).map(entry=>entry.worker));}
  catch {/* readWorkerRepoHistory already reports an unreadable journal as incomplete */}
  const checkpoint=readCheckpoint(workersFile,db);
  return {auditFile,history,state,pending,checkpoint,integrity_error:integrityFailure(history,checkpoint)};
}
const repoKey=repo=>repo.toLowerCase();
const diffRepos=(from,to)=>{const keys=new Set(from.map(repoKey));return to.filter(repo=>!keys.has(repoKey(repo)));};
function evaluateGrants(workersFile,current,write,db) {
  const {auditFile,history,state,pending,checkpoint,integrity_error}=auditedRepoState(workersFile,db);
  const applied=new Map(),unaudited=[];
  let needsWrite=false;
  for(const [worker,repos] of current) {
    const audited=state.get(worker)??[];
    const added=diffRepos(audited,repos),removed=diffRepos(repos,audited);
    // A pending migration's list comes from its own journal event, which readRepoMigration validates and
    // seedWorkerRepos publishes before it marks the worker complete: the journal is the audit record for that list.
    if(pending.has(worker)||(!added.length&&!removed.length)) {applied.set(worker,[...repos]);continue;}
    let recorded=false;
    if(write&&history.complete&&!integrity_error) {
      needsWrite=true;
      if(db) {
        try {appendWorkerRepoAudit(auditFile,worker,{mode:'exact',repos:audited},{mode:'exact',repos},'config-reconcile',db);recorded=true;}
        catch {/* fail closed below */}
      }
    }
    // A grant takes effect only once its audit event exists. A removal needs no event to be safe.
    applied.set(worker,recorded?[...repos]:repos.filter(repo=>!added.some(grant=>repoKey(grant)===repoKey(repo))));
    if(added.length&&!recorded)unaudited.push({worker,repos:added});
  }
  // Bind an unbound log (no checkpoint yet), or a log longer than its checkpoint, before anything else relies on it.
  if(write&&history.complete&&!integrity_error&&history.raw&&(!checkpoint||checkpoint.size!==history.raw.length)) {
    needsWrite=true;
    if(db) recordCheckpoint(db,auditFile);
  }
  return {applied,unaudited,history,integrity_error,needsWrite};
}
// `readCurrent` returns the current grants per worker. It runs again inside the lock, so a decision never rests on a
// view that a concurrent allow, deny or load has since replaced.
function reconcileGrants(workersFile,readCurrent,{write=true}={}) {
  const first=evaluateGrants(workersFile,readCurrent(),write,null);
  if(!write||!first.needsWrite) return first;
  try {return withAuditLock(workersFile,db=>evaluateGrants(workersFile,readCurrent(),true,db));}
  catch {
    // The lock or audit is unusable: fail closed, apply nothing that the audit does not already list.
    const denied=new Map(first.unaudited.map(item=>[item.worker,item.repos.map(repoKey)]));
    return {...first,applied:new Map([...first.applied].map(([worker,repos])=>[worker,repos.filter(repo=>!(denied.get(worker)??[]).includes(repoKey(repo)))]))};
  }
}
function auditProfileGrants(file,profile,parseOptions) {
  const readCurrent=()=>{
    const fresh=parseWorkers(JSON.parse(fs.readFileSync(file,'utf8')),parseOptions);
    return new Map([...fresh.workers].map(([name,setting])=>[name,setting.repos]));
  };
  const {applied}=reconcileGrants(file,readCurrent);
  for(const [name,setting] of profile.workers) setting.repos=applied.get(name)??[];
}
// Read-only view for doctor and worker list: grants that have no audit record yet, and grants the bridge recorded itself.
export function inspectGrantAudit(file) {
  const readCurrent=()=>{const profile=loadOwnerWorkers(file);return new Map([...profile.workers.keys()].map(name=>[name,profile.repoPolicy(name).repos]));};
  const {unaudited,history,integrity_error}=reconcileGrants(file,readCurrent,{write:false});
  const recorded=history.events.filter(event=>event.source==='config-reconcile'&&diffRepos(event.before.repos??[],event.after.repos??[]).length)
    .map(event=>({event_id:event.event_id,at:event.at,worker:event.worker,repos:diffRepos(event.before.repos??[],event.after.repos??[])}));
  return {unaudited,recorded,history_error:history.error,integrity_error:integrity_error??null};
}
export function seedWorkerRepos(file,db,{existingInstall=true,migrationNow=new Date().toISOString()}={}) {
  let journal=readRepoMigration(file);
  if(!journal) {
    const raw=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
    const names=raw?Object.keys(raw.workers):['dot'];
    const entries=[];
    // One instant for the whole migration, so a job cannot expire between two workers' scans.
    if(typeof migrationNow!=='string'||!Number.isFinite(Date.parse(migrationNow)))fail('invalid repository migration time');
    if(existingInstall)for(const worker of names) {
      if(raw&&Object.hasOwn(raw.workers[worker],'repos'))continue;
      const repos=new Map(),queuedRepositories=new Map();
      // Prior claims and live queued jobs preserve old grants. An expired queued row is no longer live evidence; the
      // service may be offline, so its expiry sweep has not necessarily changed its status yet.
      for(const {request_id,repo,status} of db.prepare(`SELECT a.request_id,json_extract(a.payload,'$.inputs[0].github_repo') AS repo,a.status FROM assignments a
        WHERE a.target_worker=? AND (
          (a.status<>'queued' AND EXISTS (SELECT 1 FROM claims c WHERE c.request_id=a.request_id)) OR
          (a.status='queued' AND a.cancelled_at IS NULL AND (a.valid_until IS NULL OR a.valid_until>? OR
            (COALESCE(a.valid_until_source,'')='queue_p90' AND EXISTS (SELECT 1 FROM claims c WHERE c.request_id=a.request_id))))
        ) ORDER BY repo COLLATE NOCASE,a.request_id`).all(worker,migrationNow)) {
        if(!validRepoName(repo))continue;
        const key=repo.toLowerCase();
        if(!repos.has(key))repos.set(key,repo);
        if(status==='queued') {
          const queued=queuedRepositories.get(key)??{repo,request_ids:[]};
          queued.request_ids.push(request_id);
          queuedRepositories.set(key,queued);
        }
      }
      const exact=[...repos.values()].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase()));
      const queuedExact=[...queuedRepositories.values()].sort((a,b)=>a.repo.toLowerCase().localeCompare(b.repo.toLowerCase()));
      const event={event_id:randomUUID(),at:new Date().toISOString(),actor:{host_uid:typeof process.getuid==='function'?process.getuid():null},worker,
        before:{mode:'legacy-any',repos:null},after:{mode:'exact',repos:exact}};
      // Keep the one-time causal evidence so migrate-repos can show which queued rows justified each repository grant.
      entries.push({worker,kind:raw?'profile':'legacy',repos:exact,complete:!raw,event,queued_repositories:queuedExact});
    }
    const value={version:1,entries},journalFile=workerRepoMigrationFile(file),temp=journalFile+'.'+randomUUID()+'.tmp';
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    try {
      writeAtomic(temp,JSON.stringify(value,null,2)+'\n');
      try {fs.linkSync(temp,journalFile);} catch(error) {if(error.code!=='EEXIST')throw error;}
      const fd=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    } finally {fs.rmSync(temp,{force:true});}
    journal=readRepoMigration(file);
  }
  for(const entry of journal.entries) {
    if(entry.kind!=='profile'||entry.complete)continue;
    // Never overwrite an explicit list, even after a crash between the two publications.
    if(!fs.existsSync(file))fail('worker profile disappeared during repository migration');
    const raw=JSON.parse(fs.readFileSync(file,'utf8'));
    const worker=raw.workers[entry.worker];
    if(worker&&!Object.hasOwn(worker,'repos')) {
      worker.repos=[...entry.repos];
      parseOwnerWorkers(raw);
      // Preserve an operator's existing workers.json symlink.
      writeAtomic(fs.realpathSync(file),JSON.stringify(raw,null,2)+'\n');
    }
    entry.complete=true;
    writeAtomic(workerRepoMigrationFile(file),JSON.stringify(journal,null,2)+'\n');
  }
  return {workers:journal.entries.map(entry=>{
    const queued=new Map((entry.queued_repositories??[]).map(row=>[row.repo.toLowerCase(),row.request_ids]));
    return {worker:entry.worker,mode:'exact',repos:entry.repos,source:'admitted-history',
      seeded_repositories:entry.event.after.repos.map(repo=>({repo,queued_request_ids:queued.get(repo.toLowerCase())??[]}))};
  })};
}
// A grant is recorded before it takes effect, so a grant never stands without its audit event. A removal takes effect
// first: failing closed is safe, and the error then says that the audit event is missing.
function commitRepoPolicyChange(action,auditFile,name,before,after,apply,db) {
  if(action!=='allow') {
    apply();
    try { appendWorkerRepoAudit(auditFile,name,before,after,undefined,db); }
    catch(error) { throw new Error(`repository policy was updated, but ${error.message}`); }
    return;
  }
  try { appendWorkerRepoAudit(auditFile,name,before,after,undefined,db); }
  catch(error) { throw new Error(`repository grant not applied: ${error.message}`); }
  try { apply(); }
  catch(error) {
    // The event now describes a grant that did not happen; add the reverse event so the history stays true.
    try { appendWorkerRepoAudit(auditFile,name,after,before,undefined,db); } catch { /* report the original error */ }
    throw error;
  }
}
export function updateWorkerRepoPolicy(file,name,action,repo) {
  // Validate before taking the lock, then hold it across the read, the audit append and the config write.
  if(!/^[a-z][a-z0-9_-]{0,31}$/.test(name)||['pool','unknown'].includes(name)) fail('invalid worker name');
  if(!['allow','deny'].includes(action)) fail('invalid repository policy action');
  if(repo==='--any') fail('--any is unsupported; provide an exact OWNER/REPO');
  parseRepoPattern(repo);
  return withAuditLock(file,db=>{
    const recovered=db?resetAfterIntegrityFailure(file,db):null;
    // A repository added by hand since the last load gets its own reconcile event first, so this command's event
    // records only the repository the operator named.
    if(db) evaluateGrants(file,currentGrants(file),true,db);
    const result=applyWorkerRepoPolicy(file,name,action,repo,db);
    return recovered?.length?{...result,reset_to_audited:recovered}:result;
  });
}
// The grants now in the configuration per worker, read without any loader (so no second lock).
function currentGrants(file) {
  if(fs.existsSync(file)) {
    const profile=parseOwnerWorkers(JSON.parse(fs.readFileSync(file,'utf8')));
    return new Map([...profile.workers].map(([name,setting])=>[name,setting.repos]));
  }
  const journal=readRepoMigration(file);
  return new Map((journal?.entries??[]).filter(entry=>entry.kind==='legacy').map(entry=>[entry.worker,entry.repos]));
}
// After the audit log failed its checkpoint, the first allow or deny is the operator's re-approval. It drops every grant
// that the surviving audit does not list, then records the log as the new baseline. Dropped grants stay denied until
// the operator allows them again.
function resetAfterIntegrityFailure(file,db) {
  const {auditFile,state,integrity_error,history}=auditedRepoState(file,db);
  if(!integrity_error) return null;
  const dropped=[];
  const journal=readRepoMigration(file);
  if(fs.existsSync(file)) {
    const raw=JSON.parse(fs.readFileSync(file,'utf8'));
    for(const [worker,setting] of Object.entries(raw.workers??{})) {
      const audited=state.get(worker)??[],listed=Array.isArray(setting.repos)?setting.repos:[];
      // Only drop: keep what both the configuration and the surviving audit list, never add from the audit.
      const kept=listed.filter(repo=>audited.some(k=>repoKey(k)===repoKey(repo)));
      if(kept.length!==listed.length) {dropped.push({worker,repos:listed.filter(repo=>!kept.includes(repo))});setting.repos=kept;}
    }
    if(dropped.length) writeAtomic(fs.realpathSync(file),JSON.stringify(raw,null,2)+'\n');
  } else if(journal) {
    for(const entry of journal.entries) if(entry.kind==='legacy') {
      const audited=state.get(entry.worker)??[];
      const kept=entry.repos.filter(repo=>audited.some(k=>repoKey(k)===repoKey(repo)));
      if(kept.length!==entry.repos.length) {dropped.push({worker:entry.worker,repos:entry.repos.filter(repo=>!kept.includes(repo))});entry.repos=kept;}
    }
    if(dropped.length) writeAtomic(workerRepoMigrationFile(file),JSON.stringify(journal,null,2)+'\n');
  }
  if(history.raw) recordCheckpoint(db,auditFile);
  else db.prepare('DELETE FROM checkpoint').run();
  return dropped;
}
function applyWorkerRepoPolicy(file,name,action,repo,db) {
  if(!fs.existsSync(file)) {
    const journal=readRepoMigration(file),entry=journal?.entries.find(item=>item.worker===name&&item.kind==='legacy');
    if(!entry)fail('no workers.json and no seeded repos-only policy; see docs/operations.md#legacy-repository-policy-migration (existing installs: dalan worker migrate-repos; new installs: dalan init --worker NAME)');
    const before={mode:'exact',repos:[...entry.repos]},repos=new Map(entry.repos.map(repo=>[repo.toLowerCase(),repo]));
    if(action==='allow')repos.set(repo.toLowerCase(),repo);else repos.delete(repo.toLowerCase());
    entry.repos=[...repos.values()];
    const after={mode:'exact',repos:[...entry.repos]};
    if(JSON.stringify(before.repos)===JSON.stringify(after.repos))return after;
    commitRepoPolicyChange(action,path.join(path.dirname(file),'workers-audit.jsonl'),name,before,after,
      ()=>writeAtomic(workerRepoMigrationFile(file),JSON.stringify(journal,null,2)+'\n'),db);
    return after;
  }
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()) fail('workers file must be a regular file');
  if((stat.mode&0o777)!==0o600) fail('file must be mode 0600');
  const raw=JSON.parse(fs.readFileSync(file,'utf8'));
  const parseProfile=()=>parseOwnerWorkers(raw);
  const profile=parseProfile();
  if(!profile.workers.has(name)) fail(`unknown worker "${name}"; configured workers: ${[...profile.workers.keys()].join(', ')}`);
  const selected=raw.workers[name];
  const before=normalizeRepoSettings(selected,name);
  const repos=new Map(before.repos.map(r=>[r.toLowerCase(),r]));
  if(action==='allow') repos.set(repo.toLowerCase(),repo); else repos.delete(repo.toLowerCase());
  selected.repos=[...repos.values()];
  const after=parseProfile().repoPolicy(name);
  if(JSON.stringify(before.repos)===JSON.stringify(after.repos)) return after;
  commitRepoPolicyChange(action,path.join(path.dirname(file),'workers-audit.jsonl'),name,{mode:'exact',repos:before.repos},after,()=>{
    const temp=`${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp,`${JSON.stringify(raw,null,2)}\n`,{mode:0o600,flag:'wx'});
      fs.chmodSync(temp,0o600);
      fs.renameSync(temp,file);
    } finally { fs.rmSync(temp,{force:true}); }
  },db);
  return after;
}
function appendWorkerRepoAudit(auditFile,worker,before,after,source,db) {
  const event={event_id:randomUUID(),at:new Date().toISOString(),actor:{host_uid:typeof process.getuid==='function'?process.getuid():null},worker,before,after,...(source?{source}:{})};
  try {
    const flags=fs.constants.O_APPEND|fs.constants.O_CREAT|fs.constants.O_WRONLY|(fs.constants.O_NOFOLLOW??0);
    const fd=fs.openSync(auditFile,flags,0o600);
    try {
      if(!fs.fstatSync(fd).isFile()) throw new Error('audit path is not a regular file');
      fs.fchmodSync(fd,0o600);
      const bytes=Buffer.from(JSON.stringify(event)+'\n');
      for(let offset=0;offset<bytes.length;) {
        const written=fs.writeSync(fd,bytes,offset,bytes.length-offset);
        if(!Number.isSafeInteger(written)||written<=0||written>bytes.length-offset) throw new Error('audit append made no valid progress');
        offset+=written;
      }
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const dirfd=fs.openSync(path.dirname(auditFile),'r');try{fs.fsyncSync(dirfd);}finally{fs.closeSync(dirfd);}
    recordCheckpoint(db,auditFile);
  } catch(error) { throw new Error(`its audit event could not be written to ${auditFile}: ${error.message}`); }
}
// A bounded snapshot of history must never make the current policy unavailable.
export function readWorkerRepoHistory(file,{workersFile=path.join(path.dirname(file),'workers.json'),maxBytes=1024*1024,keepRaw=false}={}) {
  let seeded=[],seedError=null;
  try {seeded=readRepoMigration(workersFile)?.entries.map(entry=>entry.event)??[];} catch {seedError='repository migration audit unavailable';}
  let fd;
  try {
    if(fs.lstatSync(file).isSymbolicLink()) throw new Error('unsafe audit file');
    fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||(stat.mode&0o777)!==0o600||(typeof process.getuid==='function'&&stat.uid!==process.getuid())) throw new Error('unsafe audit file');
    const offset=Math.max(0,stat.size-maxBytes),bytes=Buffer.alloc(stat.size-offset);
    let read=0;
    while(read<bytes.length) {const n=fs.readSync(fd,bytes,read,bytes.length-read,offset+read);if(!n)break;read+=n;}
    let text=bytes.subarray(0,read).toString('utf8'),complete=offset===0&&read===bytes.length,error=null;
    if(offset>0)text=text.slice(text.indexOf('\n')+1);
    if(text&&!text.endsWith('\n')) {text=text.slice(0,text.lastIndexOf('\n')+1);complete=false;error='incomplete audit record; history counts are unknown';}
    const events=[];
    const snapshot=value=>value&&typeof value==='object'&&(
      (value.mode==='legacy-any'&&value.repos===null)||
      (value.mode==='exact'&&Array.isArray(value.repos)&&value.repos.every(validRepoName)));
    for(const line of text.split('\n').filter(Boolean)) {
      try {
        const event=JSON.parse(line);
        if(!/^[0-9a-f-]{36}$/.test(event?.event_id)||typeof event.at!=='string'||!/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(event.at)||!Number.isFinite(Date.parse(event.at))||
          !/^[a-z][a-z0-9_-]{0,31}$/.test(event.worker)||!event.actor||!(event.actor.host_uid===null||Number.isSafeInteger(event.actor.host_uid)&&event.actor.host_uid>=0)||!snapshot(event.before)||!snapshot(event.after)) throw new Error('invalid record');
        const project=value=>({mode:value.mode,repos:value.repos});
        events.push({event_id:event.event_id,at:event.at,actor:{host_uid:event.actor.host_uid},worker:event.worker,before:project(event.before),after:project(event.after),...(event.source==='config-reconcile'?{source:event.source}:{})});
      } catch {complete=false;error='invalid audit record; history counts are unknown';}
    }
    return {events:[...seeded,...events],complete:complete&&!seedError,error:error??seedError,...(keepRaw&&offset===0?{raw:bytes.subarray(0,read)}:{})};
  } catch(error) {
    return error.code==='ENOENT'?{events:seeded,complete:!seedError,error:seedError}:{events:seeded,complete:false,error:'audit history unavailable; current policy is still shown'};
  } finally {if(fd!==undefined)fs.closeSync(fd);}
}
// Profile mode needs a named target. A one-worker profile defaults to that worker; otherwise the caller must choose.
export function submitTarget(profile,requested) {
  if(requested!==undefined) return assertTarget(profile,requested);
  if(profile.legacy===true) return undefined;
  const names=[...profile.workers.keys()];
  if(names.length===1) return names[0];
  throw new Error(`submit needs a target worker: use --worker NAME; configured: ${names.join(', ')}`);
}
