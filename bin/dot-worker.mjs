#!/usr/bin/env node
import { defaultPath,workspaceRoot,rootWarnings } from '../src/paths.mjs';
import { readEnv } from '../src/env.mjs';
import http from 'node:http';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { prepareNodeModules } from '../src/prepared-node-modules.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID, createHash, createHmac } from 'node:crypto';
import { explainStatus } from '../src/status-evidence.mjs';
import { formatStatusSummary } from '../src/status-summary.mjs';
import { explainMetrics } from '../src/lifecycle.mjs';
import { normalizeMeta, metaFields, deriveObjectives } from '../src/objectives.mjs';
import { legacyFixLedgerPath } from '../src/legacy-names.mjs';
import { buildInbox, formatInbox, parseWhen, decideWords } from '../src/inbox.mjs';
import { decideDrained, drainedExitCodes, terminal } from '../src/drained.mjs';
import { takeSlot, releaseSlot } from '../src/drained-slot.mjs';
import { liveWaiter } from '../src/drained-owner.mjs';
import { resolveHelp } from '../src/cli-help.mjs';
import { readLines } from '../src/request-log.mjs';
import { lintChecksFile, formatChecksReport } from '../src/check-lint.mjs';
import { parseExecution, parseRequiredCapabilities, hostReadiness, hostBackend } from '../src/execution.mjs';
import { RESOURCE_LIMITS_UNAVAILABLE } from '../src/host-execution-policy.mjs';
import { summarizeRejections } from '../src/rejections.mjs';
import { VERDICT_EXIT, formatVerdict } from '../src/work-order.mjs';
import { connectCommand } from '../src/connect-cli.mjs';
import { initAsFiles, rotateKeys } from '../src/as-files.mjs';
import { docsUrl } from '../src/docs-url.mjs';
import { workerPrompt } from '../src/worker-prompt.mjs';
import { stoppedTrialFix } from '../src/try-command.mjs';
import { formatGetSummary, formatWaitLine } from '../src/get-summary.mjs';
import { cliCommand } from '../src/cli-name.mjs';
import { applyPatch } from '../src/patch-apply.mjs';
import { terminalSafe, jsonTerminalSafe } from '../src/terminal-safe.mjs';
import { loadOwnerWorkers, parseWorkers, submitTarget, updateWorkerRepoPolicy, writeGenericProfile, writeLegacyMarker, readWorkerRepoHistory, seedWorkerRepos, inspectGrantAudit, AUDIT_INTEGRITY_HINT } from '../src/workers.mjs';
import { adminSocketPathError } from '../src/admin-socket.mjs';

// Every line this command writes to stderr can quote a worker's report, error or path. JSON lines stay JSON; the rest is made inert.
const writeStderr=console.error.bind(console);
const jsonLine=text=>{ if(!text.startsWith('{')) return false; try { JSON.parse(text); return true; } catch { return false; } };
console.error=(...parts)=>writeStderr(...parts.map(part=>typeof part==='string'?(jsonLine(part)?jsonTerminalSafe(part):terminalSafe(part)):part));

let endNote=null;
const args = process.argv.slice(2), command = args.shift(), json = args.includes('--json');
const home=os.homedir(), root=defaultPath(home,'.local/share/dot-bridge'), socket=path.join(root,'admin.sock'), receipts=path.join(root,'receipts');
function missingProfileWarning(worker,policy) {
  if(policy?.source==='admitted-history')return `worker "${worker}" uses a persisted exact repository list; no identity profile was created`;
  return `worker "${worker}" has no workers.json; repository jobs are denied until an explicit repository allow-list is configured (docs/operations.md#legacy-repository-policy-migration)`;
}
// The bridge's public origin from its authorization server settings, without any path (the MCP path holds a secret).
function bridgeOrigin() {
  try { return new URL(JSON.parse(fs.readFileSync(defaultPath(home,'.config/dot-bridge/as.json'),'utf8')).public_url).origin; } catch { return null; }
}
function option(name) { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; }
const shellQuote=value=>`'${String(value).replaceAll("'","'\\''")}'`;
// first-job.json, a complete valid job, and the full submit walk-through live in the manual setup.
const FIRST_JOB_URL=docsUrl('docs/manual-setup.md','submit-finish-and-read-the-result'), JOB_EXAMPLE_URL=FIRST_JOB_URL;
// The commands that plain output tells the user to run next use the form they ran: `npx @tnunamak/dalan`, `dalan` or node and a path.
// --json output keeps `dalan`, so scripts see the same text as before.
const cli=json?'dalan':cliCommand(process.argv[1]);
// Every option a command reads. An option it does not know is refused, so a typo is not ignored in silence.
const SUBMIT_FLAGS=['--stdin','--json','--review','--wait','--dry-run','--queue-anyway','--refuse-defer','--allow-scope-prune','--fix-scope','--background','--allow-main','--exclude-sensitive'];
const SUBMIT_VALUES=['--eligible','--policy','--file','--brief','--worker','--thread','--deliver','--timeout','--execution','--require-capability','--objective-key','--revision','--task-kind','--source','--sensitive-scope-override','--defer-if-queued','--producer-thread'];
const SUBMIT_OPTIONS=[...SUBMIT_FLAGS,...SUBMIT_VALUES];
function refuseUnknownOptions(name,{flags=[],values=[]}) {
  for(let i=0;i<args.length;i++) {
    if(values.includes(args[i])) { i++; continue; }
    if(args[i].startsWith('-')&&!flags.includes(args[i])) throw new Error(`${name}: unknown option ${JSON.stringify(args[i])}. See the options with: dalan ${name} --help`);
  }
}
// Whether a bridge listens on the admin socket. Only connects; sends nothing.
function socketListening(file) {
  return new Promise(resolve => {
    const probe=net.connect(file); const done=value=>{probe.destroy();resolve(value);};
    probe.setTimeout(1000,()=>done(false)); probe.once('connect',()=>done(true)); probe.once('error',()=>done(false));
  });
}
// The admin socket is missing or nobody listens on it: the bridge for this home is not running. Say so, and how to start it.
function bridgeNotRunning(error) {
  const selected=process.env.DALAN_HOME, trialHome=selected&&fs.existsSync(path.join(home,'.dalan-trial'));
  const cause=`connect ${error.code} ${socket}`;
  if(trialHome) return Object.assign(error,{message:`cannot reach the bridge: the trial bridge in ${home} is not running (${cause})`,fix:[`start it in another terminal, then run this command again: ${cli} try --home ${shellQuote(home)}`]});
  if(selected) return Object.assign(error,{message:`cannot reach the bridge: no bridge is running for DALAN_HOME=${selected} (${cause})`,fix:[`start the bridge for this home the way you set it up (${docsUrl('docs/manual-setup.md','owner-and-requester-setup')}), then run this command again`]});
  return Object.assign(error,{message:`cannot reach the bridge: DALAN_HOME is not set and no bridge is running in ${home} (${cause})`,fix:[`export DALAN_HOME=DIR for the bridge home you made, or start a trial bridge with: ${cli} try`]});
}
function request(route, method = 'GET', payload, headers={}) {
  return new Promise((resolve, reject) => {
    const bytes = payload ? JSON.stringify(payload) : '';
    const transportFailure=error=>reject(Object.assign(error.syscall==='connect'&&['ENOENT','ECONNREFUSED'].includes(error.code)?bridgeNotRunning(error):error,{kind:'transport'}));
    const socketPathError=adminSocketPathError(socket); if(socketPathError) return reject(socketPathError);
    const req = http.request({ socketPath: socket, path: route, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bytes),...headers } }, res => {
      let out = '';
      res.on('data', b => out += b);
      res.on('error',transportFailure);
      res.on('aborted',()=>transportFailure(new Error('admin response aborted')));
      res.on('end', () => {
        let value;
        try { value=JSON.parse(out); }
        catch { return transportFailure(new Error('invalid admin response')); }
        if(res.statusCode<200||res.statusCode>=300) reject(Object.assign(new Error(value?.error||`HTTP ${res.statusCode}`),{kind:'http',http_status:res.statusCode,...(res.statusCode>=500&&value?.reason?{code:value.code??null,reason:value.reason}:{}),...(Array.isArray(value?.suggested_scope_paths)?{suggested_scope_paths:value.suggested_scope_paths}:{}),...(value?.verdict?{verdict:value.verdict,reasons:value.reasons,bytes:value.bytes,...(value.retry_after_seconds?{retry_after_seconds:value.retry_after_seconds}:{})}:{})}));
        else resolve(value);
      });
    });
    req.on('error',transportFailure); req.end(bytes);
  });
}

function download(id,output) { return new Promise((resolve,reject)=>{ const socketPathError=adminSocketPathError(socket); if(socketPathError) return reject(socketPathError); const req=http.request({socketPath:socket,path:'/artifact?id='+encodeURIComponent(id),headers:{'x-owner-capability':receiptForArtifact(id).token}},res=>{if(res.statusCode!==200){let body='';res.on('data',b=>body+=b);res.on('end',()=>reject(new Error(JSON.parse(body).error)));return;}const bytes=[];res.on('data',b=>bytes.push(b));res.on('end',()=>{const data=Buffer.concat(bytes),digest=createHash('sha256').update(data).digest('hex');if(digest!==res.headers['x-artifact-sha256']) return reject(new Error('artifact digest mismatch'));fs.writeFileSync(output,data,{flag:'wx',mode:0o600});resolve({artifact_id:id,output,bytes:data.length,sha256:digest});});});req.on('error',reject);req.end();}); }
const artifactIdPattern=/^art_[-\w]{8,128}$/;
function receiptForArtifact(id) { if(!artifactIdPattern.test(id)) throw new Error('invalid artifact ID');let requestId;try{requestId=fs.readFileSync(path.join(root,'artifact-index',id),'utf8').trim();}catch{throw new Error('artifact owner unknown; run dalan get REQUEST_ID or wait REQUEST_ID first');}return receipt(requestId); }
function canonical(value) { if(Array.isArray(value)) return value.map(canonical); if(value&&typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])); return value; }
function receiptPath(id) { if(!/^[-\w]{8,128}$/.test(id)) throw Object.assign(new Error(`invalid request ID ${JSON.stringify(String(id).slice(0,140))}: a request ID has 8 to 128 letters, digits, _ or -`),{fix:[`check the ID, or list your jobs with: ${cli} inbox --all`]}); return path.join(receipts,createHash('sha256').update(id).digest('hex')+'.json'); }
function receipt(id) {
  let text;
  try { text=fs.readFileSync(receiptPath(id),'utf8'); }
  catch(e) { if(e.code!=='ENOENT') throw e; const acp=acpReceipt(id); if(acp) return acp;
    // Every job this home submitted has a receipt, so a missing one means the ID is mistyped or the job came from another home.
    throw Object.assign(new Error(`no job "${id}" in this bridge home: ${home} has no receipt for it`),{code:'ENOENT',local_code:'unknown_request',fix:[`check the ID and DALAN_HOME, or list your jobs with: ${cli} inbox --all`]}); }
  const value=JSON.parse(text); if(value.request_id!==id) throw new Error('receipt mismatch'); return value;
}
// A row the ACP adapter (T3 worker provider) submitted has no CLI receipt: its owner token is HMAC(acp-secret, request id).
// Deriving it lets the T3 parent get, download, accept and reject that row. The bridge still checks the token.
function acpReceipt(id) {
  const file=process.env.DOT_ACP_SECRET_FILE||defaultPath(home,'.config/dot-bridge/acp-secret');
  let secret;
  try { if((fs.statSync(file).mode&0o777)!==0o600) return null; secret=fs.readFileSync(file,'utf8').trim(); } catch { return null; }
  if(secret.length<32) return null;
  return {request_id:id,token:createHmac('sha256',secret).update(id).digest('hex'),acp:true};
}
function writeReceipt(id, token, body, delivery, review=false, background=false, meta=null, producer=null, routing=null, destinationRevisions=null) {
  fs.mkdirSync(receipts,{recursive:true,mode:0o700});
  const file=receiptPath(id);
  try {
    const fd=fs.openSync(file,'wx',0o600);
    try { fs.writeSync(fd,JSON.stringify({request_id:id,token,body,delivery,...(delivery.startsWith('t3:')?{thread:delivery.slice(3)}:{}),...(review?{review:true}:{}),...(background?{background:true}:{}),...(meta?{meta}:{}),...(producer?{producer}:{}),...(routing?{routing,destination_revisions:destinationRevisions??{}}:{})})+'\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  } catch(e) { if(e.code!=='EEXIST') throw e; }
  const dir=fs.openSync(receipts,'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  return receipt(id);
}
function operator() { const file=defaultPath(home,'.config/dot-bridge/operator.key'); const mode=fs.statSync(file).mode&0o777; if(mode!==0o600) throw new Error('operator key must be mode 0600'); return fs.readFileSync(file,'utf8').trim(); }
async function waitForAssignment(id, timeout) {
  const seconds=timeout===null?300:Number(timeout);
  if(!Number.isInteger(seconds)||seconds<1||seconds>3600) throw new Error('wait timeout must be an integer from 1 to 3600 seconds');
  return request(`/wait?id=${encodeURIComponent(id)}&timeout=${seconds}`,'GET',null,{'x-owner-capability':receipt(id).token});
}
// Records which request owns each artifact so `artifact ART_ID` can find the owner receipt. Called by get and wait.
function indexArtifacts(requestId,result) {
  try { indexArtifactIds(requestId,result); } catch(e) { console.error(`dalan: could not index artifacts: ${e.message}`); }
}
function indexArtifactIds(requestId,result) {
  const index=path.join(root,'artifact-index');fs.mkdirSync(index,{recursive:true,mode:0o700});
  for(const entry of [...(result.artifacts||[]).map(x=>({artifact_id:x.id})),...(result.artifact_ids||[]).map(x=>({artifact_id:x})),...(result.checks||[]).map(x=>({artifact_id:x.output_artifact_id})),result.report?.workspace_evidence?.patch_artifact,...(result.report?.workspace_evidence?.artifacts||[]).map(x=>({artifact_id:x.id})),...(result.report?.workspace_evidence?.checks||[]).map(x=>({artifact_id:x.output_artifact_id}))]){
    const id=entry?.artifact_id; if(!id) continue;
    // Ids come from the bridge response. Never let one pick a path or abort the command that already got its result.
    if(typeof id!=='string'||!artifactIdPattern.test(id)) { console.error(`dalan: skipped invalid artifact id in response: ${JSON.stringify(String(id).slice(0,40))}`); continue; }
    try { fs.writeFileSync(path.join(index,id),requestId+'\n',{mode:0o600}); } catch(e) { console.error(`dalan: could not index artifact ${id}: ${e.message}`); }
  }
}
// stdout stays the JSON result; a timeout also gets one plain line on stderr, because exit 124 alone does not say what to do.
function waitTimeoutNote(id,result) {
  if(result?.status!=='timeout') return;
  const seconds=option('--timeout')===null?300:Number(option('--timeout'));
  console.error(`dalan: wait timed out after ${seconds} s: job ${id} is not finished yet (a worker may not have claimed it). Wait longer with: ${cli} wait ${id} --timeout 3600, or check it with: ${cli} get ${id}`);
}
function waitExitCode(status) {
  if(status==='finished') return 0;
  if(status==='blocker'||status==='question') return 3;
  if(status==='cancelled') return 4;
  if(status==='worker_break') return 5;
  if(status==='timeout') return 124;
  throw new Error(`unexpected wait status ${status}`);
}
// Per-tool calls and response bytes from the request log's mcp_outcome lines in the 1h/6h/24h before sinceMs. Reads
// complete (newline-terminated) lines only: a line being appended can be half-visible; skips lines that do not parse.
async function requestLogUsage(file,sinceMs) {
  const spans=[['1h',3600000],['6h',21600000],['24h',86400000]], windows=Object.fromEntries(spans.map(([name])=>[name,{response_bytes:0,calls:0,by_tool:{}}]));
  const log={file,lines:0,outcomes:0,skipped:0,first_at:null};
  const take=line=>{
    if(!line) return; log.lines++;
    if(!line.includes('"mcp_outcome"')) return;
    let entry; try { entry=JSON.parse(line); } catch { log.skipped++; return; }
    const at=Date.parse(entry.at);
    if(entry.kind!=='mcp_outcome'||!Number.isFinite(at)) return;
    if(log.first_at===null||at<Date.parse(log.first_at)) log.first_at=new Date(at).toISOString();
    if(typeof entry.tool!=='string'||!/^[a-z0-9_]{1,64}$/.test(entry.tool)||!Number.isInteger(entry.response_bytes)||entry.response_bytes<0) return;
    log.outcomes++;
    for(const [name,ms] of spans) if(at>=sinceMs-ms&&at<sinceMs) {
      const w=windows[name], t=w.by_tool[entry.tool]??={calls:0,bytes:0};
      t.calls++; t.bytes+=entry.response_bytes; w.calls++; w.response_bytes+=entry.response_bytes;
    }
  };
  for (const line of readLines(file)) take(line);
  // A window that starts before the log's first outcome is partial.
  for(const [name,ms] of spans) if(log.first_at===null||Date.parse(log.first_at)>sinceMs-ms) windows[name].partial=true;
  return {windows,log};
}
// The agent session a submit belongs to, so `wait --drained` can find that session's own work. Explicit flag first, then the
// harness session id (Claude Code sets CLAUDE_CODE_SESSION_ID, Codex sets CODEX_THREAD_ID in shell commands). Only the flag is
// validated strictly; an odd environment value is ignored, so it can never break a submit.
const producerPattern=/^[A-Za-z0-9._:%-]{1,256}$/;
function producerId() {
  const flag=option('--producer-thread');
  if(flag!==null) { if(!producerPattern.test(flag)) throw new Error('invalid --producer-thread'); return flag; }
  return [process.env.CLAUDE_CODE_SESSION_ID,process.env.CODEX_THREAD_ID].find(v=>v&&producerPattern.test(v))??null;
}
const drainedDir=defaultPath(home,'.local/state/dot-bridge/drained');
function drainedPidfile(producer) { return path.join(drainedDir,createHash('sha256').update(producer).digest('hex').slice(0,32)+'.json'); }
// Producer receipts. A parsed receipt never changes, so it is read once; one still being written is retried next time.
function producerReceipts(producer,cache) {
  let names=[]; try { names=fs.readdirSync(receipts); } catch {}
  for(const name of names) if(!cache.has(name)) {
    let r; try { r=JSON.parse(fs.readFileSync(path.join(receipts,name),'utf8')); } catch { continue; }
    cache.set(name,r&&typeof r==='object'&&(producer===null||r.producer===producer||r.thread===producer)?{id:r.request_id,token:r.token}:null);
  }
  return [...cache.values()].filter(Boolean);
}
// A failure worth retrying: the bridge restarting (transport) or unavailable (5xx).
const transient=e=>e.kind==='transport'||e.http_status>=500;
// /owner-states reads without recording an owner read. An older bridge lacks it; /get then works, but each finished task
// it sees is recorded as consumed once. A 4xx for one request (unknown, not owned) marks it unknown; anything else throws.
async function ownerStates(items,legacy) {
  if(!legacy.on) try {
    let out=null;
    for(let i=0;i===0||i<items.length;i+=500) { // the route takes at most 500 items
      const part=await request('/owner-states','POST',{items:items.slice(i,i+500).map(x=>({id:x.id,capability:x.token}))});
      out=out?{...part,states:[...out.states,...part.states]}:part;
    }
    return out;
  }
  catch(e) { if(e.http_status!==404) throw e; legacy.on=true; }
  const states=[];
  for(const x of items) {
    let got; try { got=await request('/get?id='+encodeURIComponent(x.id),'GET',null,{'x-owner-capability':x.token}); }
    catch(e) { if(transient(e)) throw e; states.push({request_id:x.id,error:'unreadable'}); continue; }
    if(typeof got.status!=='string') { states.push({request_id:x.id,error:'unreadable'}); continue; }
    const blockers=(got.progress??[]).map(p=>p.note).filter(n=>/^\s*(?:BLOCKED:|QUESTION:)/im.test(n));
    states.push({request_id:x.id,status:got.status,blocker_count:blockers.length,last_blocker:blockers.at(-1)??null});
  }
  const s=await request('/status');
  // Only evidence holds refill: a pause or an owner-confirmed break (not an inferred break, not an estimated limit).
  const held=s.paused?'paused':s.worker_break?.active&&s.worker_break.source==='owner'?'worker_break':null;
  return {states,refill:{held}};
}
// A peek at the owner's receipts: finished results nobody read, questions, and cancellations. Records no owner read.
// With --mark-read it records the owner read, without fetching results, for the listed ids or for items older than --before.
async function inbox() {
  const all=args.includes('--all'), explicit=option('--producer');
  if(args.includes('--producer')&&(explicit===null||!producerPattern.test(explicit))) throw new Error('invalid --producer');
  const markRead=args.includes('--mark-read'), valued=['--producer','--since','--before'];
  const ids=args.filter((a,i)=>!a.startsWith('-')&&!valued.includes(args[i-1]));
  const before=args.includes('--before')?option('--before'):null;
  if(args.includes('--before')&&!markRead) throw new Error('--before only applies to --mark-read');
  if(ids.length&&!markRead) throw new Error(`unexpected argument '${ids[0]}' (request IDs go after --mark-read)`);
  if(markRead&&!ids.length&&before===null) throw new Error('--mark-read needs request IDs or --before TIME (Nh, Nd or RFC3339); it never marks everything');
  if(markRead&&ids.length&&before!==null) throw new Error('--mark-read takes request IDs or --before, not both');
  if(markRead&&before==='all') throw new Error('--before needs a time (Nh, Nd or RFC3339), not all');
  const sinceText=args.includes('--since')?option('--since'):'72h', cutoff=parseWhen(sinceText), beforeCutoff=before===null?null:parseWhen(before);
  const detectedProducer=explicit??producerId();
  const scopeAll=all||(!markRead&&!detectedProducer);
  const producer=scopeAll||(markRead&&ids.length)?null:detectedProducer;
  if(!scopeAll&&!producer&&!(markRead&&ids.length)) throw new Error('inbox needs --producer ID (or CLAUDE_CODE_SESSION_ID / CODEX_THREAD_ID), or --all for every receipt on this host');
  const legacy={on:false}, receiptsInScope=producerReceipts(producer,new Map());
  if(markRead&&ids.length) {
    const byId=new Map(receiptsInScope.map(r=>[r.id,r])), missing=ids.filter(x=>!byId.has(x));
    if(missing.length) throw new Error(`no receipt on this host for ${missing.join(', ')}`);
    return markInboxRead(ids.map(x=>byId.get(x)));
  }
  const read=await ownerStates(receiptsInScope,legacy);
  if(legacy.on) throw new Error('this bridge predates dalan inbox; update and restart it');
  if(!markRead) return buildInbox(read.states,scopeAll?'all':producer,{cutoff});
  const due=buildInbox(read.states,all?'all':producer).items.filter(i=>i.group!=='question'&&i.group!=='undecided'&&Date.parse(i.updated_at)<beforeCutoff);
  const byId=new Map(receiptsInScope.map(r=>[r.id,r]));
  return markInboxRead(due.map(i=>byId.get(i.request_id)));
}
async function markInboxRead(items) {
  let marked=0, unknown=[];
  for(let i=0;i<items.length;i+=500) {
    let part; try { part=await request('/owner-mark-read','POST',{items:items.slice(i,i+500).map(x=>({id:x.id,capability:x.token}))}); }
    catch(e) { if(e.http_status===404) throw new Error('this bridge predates dalan inbox --mark-read; update and restart it'); throw e; }
    marked+=part.marked; unknown.push(...part.results.filter(r=>r.error).map(r=>r.request_id));
  }
  return {marked,requested:items.length,...(unknown.length?{unknown}:{})};
}
async function waitDrained() {
  const producer=producerId();
  if(!producer) throw new Error('wait --drained needs --producer-thread ID (or CLAUDE_CODE_SESSION_ID / CODEX_THREAD_ID)');
  const seconds=option('--timeout')===null?1740:Number(option('--timeout'));
  if(!Number.isInteger(seconds)||seconds<1||seconds>86400) throw new Error('wait --drained timeout must be an integer from 1 to 86400 seconds');
  const limits={};
  for(const [flag,key,fallback] of [['--max-claimed','maxClaimed',0],['--max-queued','maxQueued',1]]) {
    const v=option(flag)===null?fallback:Number(option(flag));
    if(!Number.isInteger(v)||v<0||v>100) throw new Error(`${flag} must be an integer from 0 to 100`);
    limits[key]=v;
  }
  const intervalMs=Number(process.env.DOT_DRAINED_INTERVAL_MS||15000);
  const unreachableMs=Number(process.env.DOT_DRAINED_UNREACHABLE_MS||600000);
  // One waiter per producer: a second one exits at once, so the hook and a forgetful agent cannot stack them.
  fs.mkdirSync(drainedDir,{recursive:true,mode:0o700});
  const file=drainedPidfile(producer), mine={pid:process.pid,token:randomBytes(8).toString('hex'),producer,started_at:new Date().toISOString()};
  const other=takeSlot(file,mine,{isLive:liveWaiter});
  if(other) return {status:'already_running',producer,pid:other.pid,started_at:other.started_at};
  const release=()=>releaseSlot(file,mine);
  process.once('exit',release);
  for(const signal of ['SIGTERM','SIGINT','SIGHUP']) process.once(signal,()=>{ release(); process.exit(128+({SIGTERM:15,SIGINT:2,SIGHUP:1})[signal]); });
  const cache=new Map(), memo={baseline:new Map(),startTerminal:new Set(),lastHeld:undefined}, legacy={on:false}, done=new Map();
  const deadline=Date.now()+seconds*1000;
  let failingSince=null;
  for(;;) {
    let read=null;
    try { read=await ownerStates(producerReceipts(producer,cache).filter(x=>!done.has(x.id)),legacy); failingSince=null; }
    catch(e) {
      // Keep waiting through a bridge restart; give up with a JSON line only after a sustained outage.
      if(!transient(e)) return {status:'error',producer,error:e.message};
      failingSince??=Date.now();
      if(Date.now()-failingSince>=unreachableMs) return {status:'bridge_unreachable',producer,error:e.message};
    }
    if(read) {
      // Terminal tasks stay terminal; they are never read from the bridge again.
      for(const s of read.states) if(terminal.has(s.status)) done.set(s.request_id,s.status);
      const unknown=read.states.filter(s=>s.error).map(s=>s.request_id);
      const states=[...read.states.filter(s=>!s.error&&!terminal.has(s.status)),...[...done].map(([id,status])=>({request_id:id,status,blocker_count:0,last_blocker:null}))];
      let outcome=decideDrained(states,read.refill,memo,limits);
      // Nothing readable and nothing finished (e.g. the bridge lost these requests): not a refill signal; hold to the timeout.
      if(outcome?.status==='drained'&&unknown.length&&!outcome.finished.length&&!states.some(s=>!terminal.has(s.status))) outcome=null;
      const extra={producer,...(unknown.length?{unknown}:{}),...(legacy.on?{legacy_reads:true}:{})};
      if(outcome) return {...outcome,...extra};
      if(Date.now()>=deadline) return {status:'timeout',in_flight:{queued:states.filter(s=>s.status==='queued').length,claimed:states.filter(s=>s.status==='claimed').length},...extra};
    } else if(Date.now()>=deadline) return {status:'timeout',producer,error:'bridge unreachable'};
    await new Promise(r=>setTimeout(r,Math.min(intervalMs,Math.max(0,deadline-Date.now()))));
  }
}
async function main() {
  let result, waitOutput=false, plainOutput=false;
  const help=resolveHelp([command,...args]);
  if(help){ if(help.stream==='stdout') console.log(help.text); else console.error(help.text); process.exitCode=help.code; return; }
  switch (command) {
    case 'paths': {
      const selectors={'--workspace-root':()=>workspaceRoot(home),'--config-root':()=>defaultPath(home,'.config/dot-bridge'),'--data-root':()=>root,'--state-root':()=>defaultPath(home,'.local/state/dot-bridge')};
      if(args.some(arg=>arg!=='--json'&&!Object.hasOwn(selectors,arg))||args.filter(arg=>Object.hasOwn(selectors,arg)).length>1)throw new Error('usage: dalan paths [--json | --workspace-root | --config-root | --data-root | --state-root]');
      const selector=args.find(arg=>Object.hasOwn(selectors,arg));
      const warnings=rootWarnings(home);
      if(!json||selector)for(const warning of warnings) console.error(`dalan: WARNING root_passed_over ${warning.area}: using ${JSON.stringify(warning.chosen)}; passed over ${JSON.stringify(warning.passed_over)}; missing ${JSON.stringify(warning.missing)}`);
      if(selector) {result=selectors[selector]();plainOutput=true;}
      else result={config_dir:selectors['--config-root'](),data_dir:root,state_dir:selectors['--state-root'](),workspace_root:workspaceRoot(home),...(json?{warnings}:{})};
      break;
    }
    case 'worker': {
      const [action,name,repo,...extra]=args.filter(a=>a!=='--json');
      if(args.filter(a=>a==='--json').length>1) throw new Error('usage: dalan worker allow|deny NAME OWNER/REPO [--json] | worker list [NAME] [--json]');
      const file=readEnv('DALAN_WORKERS_FILE')||defaultPath(home,'.config/dot-bridge/workers.json');
      if(action==='migrate-repos') {
        if(name!==undefined)throw new Error('usage: dalan worker migrate-repos [--json]; stop the service first');
        // Read existing history without opening Store or migrating its schema.
        const db=new DatabaseSync(path.join(root,'bridge.db'),{readOnly:true});
        // Name both inputs: a HOME and a DALAN_WORKERS_FILE from different bridges would seed one bridge's history into the other.
        try {loadOwnerWorkers(file);result={...seedWorkerRepos(file,db),database:path.join(root,'bridge.db'),workers_file:file};} finally {db.close();}
        break;
      }
      if(action==='list') {
        if(repo!==undefined||extra.length) throw new Error('usage: dalan worker list [NAME] [--json]');
        const profile=loadOwnerWorkers(file);
        const names=name===undefined?[...profile.workers.keys()]:[name];
        const history=readWorkerRepoHistory(path.join(path.dirname(file),'workers-audit.jsonl'),{workersFile:file});
        const grantAudit=fs.existsSync(file)?inspectGrantAudit(file):{unaudited:[],integrity_error:null},unauditedGrants=grantAudit.unaudited;
        const integrityNote=grantAudit.integrity_error?`${grantAudit.integrity_error}. ${AUDIT_INTEGRITY_HINT}`:null;
        const policies=names.map(worker=>{
          if(!profile.workers.has(worker)) throw new Error(`unknown worker "${worker}"; configured workers: ${[...profile.workers.keys()].join(', ')}`);
          const policy=profile.repoPolicy(worker);
          const changes=history.events.filter(event=>event.worker===worker),changeCount=history.complete?changes.length:null;
          const unaudited=unauditedGrants.find(item=>item.worker===worker)?.repos;
          return {worker,...policy,...(unaudited?{unaudited_grants:unaudited}:{}),...(integrityNote?{audit_integrity_error:integrityNote}:{}),changes:changes.slice(-20),change_count:changeCount,changes_truncated:!history.complete||changes.length>20,
            ...(history.error?{changes_error:history.error}:{}),...(!fs.existsSync(file)?{warning:missingProfileWarning(worker,policy)}:{})};
        });
        if(!json) { result=policies.map(policy=>`${policy.worker}: ${policy.mode}${policy.repos?.length?` (${policy.repos.join(', ')})`:''}${policy.warning?` WARNING: ${policy.warning}`:''}${policy.changes.map(event=>`\n  ${event.at} uid=${event.actor.host_uid}: ${event.before.repos?.join(', ')||'(none)'} -> ${event.after.repos?.join(', ')||'(none)'}`).join('')}${policy.changes_truncated?`\n  showing ${policy.changes.length} retained changes; ${policy.change_count===null?'older history count unknown':`${policy.change_count} recorded changes in total`}`:''}${policy.changes_error?`\n  WARNING: ${policy.changes_error}`:''}${policy.audit_integrity_error?`\n  WARNING: ${policy.audit_integrity_error}`:''}`).join('\n')||'No workers configured.'; plainOutput=true; }
        else result={workers:policies};
        break;
      }
      if(!['allow','deny'].includes(action)||!name||!repo||extra.length) throw new Error('usage: dalan worker allow|deny NAME OWNER/REPO [--json]');
      result=updateWorkerRepoPolicy(file,name,action,repo);
      if(!json) { result=`${name}: ${result.mode}${result.repos?.length?` (${result.repos.join(', ')})`:''}${result.denied?.length?` except ${result.denied.join(', ')}`:''}${result.reset_to_audited?.length?`\nthe audit log failed its checkpoint, so workers.json was reset to the audited grants; allow again: ${result.reset_to_audited.map(item=>`${item.worker}${item.repos.length?` (${item.repos.join(', ')})`:''}`).join('; ')}`:''}`; plainOutput=true; }
      break;
    }
    case 'submit': {
      refuseUnknownOptions('submit',{flags:SUBMIT_FLAGS,values:SUBMIT_VALUES});
      const thread = option('--thread'), requestedDelivery = option('--deliver'), file = option('--file');
      if (thread && requestedDelivery) throw new Error('submit accepts either --thread or --deliver, not both');
      const delivery = requestedDelivery ?? (thread ? `t3:${thread}` : 'none');
      if (delivery !== 'none' && !/^t3:[A-Za-z0-9._:%-]{8,1024}$/.test(delivery)) throw new Error('invalid delivery; expected none or t3:<thread-id>');
      const jobFix=(message,...fix)=>Object.assign(new Error(message),{fix});
      const stdin=args.includes('--stdin'), briefGiven=args.includes('--brief'), briefText=option('--brief');
      if (!file && !stdin && !briefGiven) throw jobFix('submit needs a job: pass --file PATH, --stdin or --brief TEXT', `for the first job: ${cli} submit --worker local --execution none --deliver none --file first-job.json`, `first-job.json is in ${FIRST_JOB_URL}`, `or for a text-only question: ${cli} submit --worker local --brief "your question"`);
      if ([file,stdin,briefGiven].filter(Boolean).length>1) throw jobFix('submit reads one job: pass exactly one of --file PATH, --stdin and --brief TEXT, not several', 'run the same command again with only one of them');
      if (briefGiven&&(briefText===undefined||briefText===null||SUBMIT_OPTIONS.includes(briefText)||!briefText.trim())) throw jobFix('--brief needs the text of the job, and it is empty or missing', `pass the text after --brief, in quotes: ${cli} submit --brief "your question"`);
      let input;
      if (briefGiven) {
        // A text-only job: the text is the brief exactly as typed, with no repository and no file access.
        input = JSON.stringify({ schema_version: 1, request_id: `req_${randomUUID()}`, brief: briefText, inputs: [], expected_output: 'A plain-text answer.', execution_scope: 'read-only' });
      } else {
        try { input = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8'); }
        catch(e) { if(!file) throw e; throw jobFix(`cannot read the job file ${JSON.stringify(file)}: ${e.code==='ENOENT'?'no such file':e.code==='EISDIR'?'it is a directory':e.message}`, 'check the path, then run the same dalan submit command again'); }
      }
      const source=briefGiven?'the --brief job':file?`the job file ${JSON.stringify(file)}`:'the job on standard input';
      let body;
      try { body=JSON.parse(input); }
      catch(e) { throw jobFix(`${source} is not valid JSON: ${e.message}`, 'correct the JSON, then run the same dalan submit command again', `a valid example: ${JOB_EXAMPLE_URL}`); }
      if(!body||typeof body!=='object'||Array.isArray(body)) throw jobFix(`${source} is not a job: it must be a JSON object`, `a valid example: ${JOB_EXAMPLE_URL}`);
      if(typeof body.request_id!=='string'||!/^[-\w]{8,128}$/.test(body.request_id)) throw jobFix('the job has no valid request_id: request_id is required and must be 8-128 letters, digits, _ or -', 'add "request_id": "req_" followed by a new UUID; make one with: node -e "console.log(require(\'node:crypto\').randomUUID())"');
      // A dry run leaves this to the bridge, which answers it with a typed verdict.
      if(!Array.isArray(body.inputs)&&!args.includes('--dry-run')) throw jobFix('the job has no inputs array: inputs must be an array', 'add "inputs": [] when the job has no repository input');
      const id=body.request_id, review=args.includes('--review'), background=args.includes('--background'), worker=option('--worker');
      if(args.includes('--worker')&&(!worker||worker.startsWith('--'))) throw new Error('--worker requires a name');
      if(args.includes('--eligible')&&args.includes('--policy'))throw new Error('use either --eligible or --policy');
      let routing=null,destinationRevisions={};
      if(args.includes('--eligible')) {
        const list=option('--eligible');if(!list||list.startsWith('--'))throw new Error('--eligible requires a comma-separated worker list');
        routing={version:1,allowed_workers:list.split(','),fan_out:1,...(body.valid_until?{deadline_at:body.valid_until}:{})};
      }
      if(args.includes('--policy')) {
        const file=option('--policy');if(!file||file.startsWith('--'))throw new Error('--policy requires a JSON file');
        const value=JSON.parse(fs.readFileSync(file,'utf8'));
        if(value?.routing&&Object.keys(value).some(key=>!['routing','destination_revisions'].includes(key)))throw new Error('unsupported policy file field');
        routing=value.routing??value;destinationRevisions=value.destination_revisions??{};
      }
      if(routing&&worker)throw new Error('--worker cannot be combined with --eligible or --policy');
      // Execution capability (none|worker|host) and required backend capabilities travel beside the assignment, like --worker.
      const execution=option('--execution'), requireCaps=option('--require-capability');
      if(args.includes('--execution')) parseExecution(execution);
      if(args.includes('--require-capability')&&(!requireCaps||requireCaps.startsWith('--'))) throw new Error('--require-capability requires a comma-separated list');
      const requiredCapabilities=requireCaps?parseRequiredCapabilities(requireCaps.split(',')):null;
      if(review&&body.execution_scope===undefined) body.execution_scope='implementation';
      for(const flag of ['--objective-key','--revision','--task-kind','--source']) if(args.includes(flag)&&(!option(flag)||option(flag).startsWith('--'))) throw new Error(`${flag} requires a value`);
      // Objective identity travels beside the assignment, never inside it; a plain dalan submit is an agent's.
      const given=normalizeMeta({objective_key:option('--objective-key'),revision:option('--revision'),task_kind:option('--task-kind'),source:option('--source')});
      const dryRun=args.includes('--dry-run'), queueAnyway=args.includes('--queue-anyway'), refuseDefer=args.includes('--refuse-defer');
      if(dryRun&&queueAnyway) throw new Error('--dry-run stores nothing; it cannot be combined with --queue-anyway');
      if(dryRun&&args.includes('--wait')) throw new Error('--dry-run stores nothing; it cannot be combined with --wait');
      if(args.includes('--defer-if-queued')&&!(Number.isSafeInteger(Number(option('--defer-if-queued')))&&Number(option('--defer-if-queued'))>=1)) throw new Error('--defer-if-queued requires a positive integer');
      // Refuse a new local request before creating its durable owner receipt. The server repeats this check from its current
      // workers.json, so a stale CLI profile cannot authorize an assignment.
      if(!dryRun&&!fs.existsSync(receiptPath(id))) {
        const policy=loadOwnerWorkers(readEnv('DALAN_WORKERS_FILE')||defaultPath(home,'.config/dot-bridge/workers.json'));
        const targets=routing?.allowed_workers??[submitTarget(policy,worker??undefined)??'dot'],inputs=body.inputs;
        for(const target of targets) {
          if(routing&&!policy.workers.has(target))throw new Error('unknown eligible worker '+target);
          if(Array.isArray(inputs)&&inputs.some(input=>input?.github_repo!==undefined)) {
            const repoName=inputs[0]?.github_repo;
            if(inputs.length!==1) throw new Error('one repository input per job; submit separate jobs for multiple repositories');
            if(typeof repoName!=='string'||!policy.allowsRepo(target,repoName)) throw new Error(`repository ${typeof repoName==='string'?repoName:'(invalid repository)'} is not allowed for worker "${target}"; update it with dalan worker allow ${target} OWNER/REPO, or choose another worker`);
          }
        }
      }
      const token=randomBytes(32).toString('hex');
      const write=()=>writeReceipt(id,token,JSON.stringify(body),delivery,review,background,{...given,source:given.source??'agent'},producerId(),routing,destinationRevisions);
      let saved;
      if(dryRun) {
        try { saved=receipt(id); }
        catch(error) { if(error.code!=='ENOENT') throw error; saved={request_id:id,token,delivery,body:input,...(routing?{routing,destination_revisions:destinationRevisions}:{})}; }
      } else saved=write();
      if(!routing&&saved.routing) {routing=saved.routing;destinationRevisions=saved.destination_revisions??{};}
      let fresh=!dryRun&&saved.token===token;
      // Receipts written by earlier releases may carry the old spelling of a source; compare the normalized form.
      const savedMeta=()=>{ try { return normalizeMeta(saved.meta); } catch { return {}; } };
      const conflicts=()=>{ const savedDelivery=saved.delivery ?? (saved.thread ? `t3:${saved.thread}` : null);
        return JSON.stringify(canonical(saved.routing??null))!==JSON.stringify(canonical(routing))||JSON.stringify(canonical(saved.destination_revisions??{}))!==JSON.stringify(canonical(destinationRevisions))||JSON.stringify(canonical(JSON.parse(saved.body)))!==JSON.stringify(canonical(body))||savedDelivery!==delivery||!!saved.review!==review||!!saved.background!==background||metaFields.some(k=>savedMeta()[k]!=null&&given[k]!==null&&savedMeta()[k]!==given[k]); };
      const conflict=()=>Object.assign(new Error('request_id conflict with local receipt'),{local_code:'receipt_conflict'});
      // A refused submit stores no assignment, so its receipt guards nothing. Replace it instead of refusing a corrected retry.
      if(dryRun&&conflicts()) throw conflict();
      if(!dryRun&&conflicts()) {
        const admission=await request('/admission?id='+encodeURIComponent(id)).catch(()=>null);
        if(admission?.exists!==false) throw conflict();
        fs.unlinkSync(receiptPath(id));saved=write();fresh=saved.token===token;
        if(conflicts()) throw conflict();
      }
      // A retry inherits what the receipt recorded for any flag it omits, so replaying a drainer request by hand stays one request.
      const meta=Object.fromEntries(metaFields.map(k=>[k,given[k]??savedMeta()[k]??(k==='source'?'agent':null)]));
      const send=()=>request(dryRun?'/submit-preview':'/submit', 'POST', { ...(worker?{worker}:{}), ...(routing?{routing,destination_revisions:destinationRevisions}:{}), delivery, assignment: body, owner_token:saved.token, review, ...(background?{background:true}:{}), meta, ...(args.includes('--sensitive-scope-override')?{sensitive_scope_override:option('--sensitive-scope-override')}:{}), ...(args.includes('--allow-main')?{allow_main:true}:{}), ...(args.includes('--exclude-sensitive')?{exclude_sensitive:true}:{}), ...(execution?{execution}:{}), ...(requiredCapabilities?{required_capabilities:requiredCapabilities}:{}), ...(dryRun?{dry_run:true}:{...(refuseDefer?{refuse_defer:true}:{}),...(queueAnyway?{queue_anyway:true}:{})}), ...(args.includes('--defer-if-queued')?{defer_queued:Number(option('--defer-if-queued'))}:{}) },args.includes('--allow-main')?{'x-operator-key':operator()}:{});
      try {
        try { result=await send(); }
        catch(error) {
          // Default: refuse with the exact scope fix. The bridge's suggested_scope_paths (brief files outside scope_paths added, unknown
          // scope paths dropped) are applied and the submit retried once only with --allow-scope-prune (--fix-scope is its old spelling).
          // The refused first submit stored nothing, so the same request_id and receipt stay valid.
          if(!(error.kind==='http'&&error.http_status===400&&error.suggested_scope_paths)) throw error;
          const was=body.scope_paths||[], added=error.suggested_scope_paths.filter(p=>!was.includes(p)), removed=was.filter(p=>!error.suggested_scope_paths.includes(p));
          const change=`${added.length?`added ${added.join(', ')}`:''}${added.length&&removed.length?'; ':''}${removed.length?`removed ${removed.join(', ')}`:''}`;
          if(!args.includes('--allow-scope-prune')&&!args.includes('--fix-scope')) {
            error.fix=[...(added.length?[`add these to scope_paths: ${added.join(', ')} (the brief names them; or remove the mentions from the brief)`]:[]),
              ...(removed.length?[`remove these from scope_paths: ${removed.join(', ')} (not in the repository tree at the pinned revision; to have the job CREATE a new file, list it in output_paths instead)`]:[]),
              `corrected scope_paths: ${JSON.stringify(error.suggested_scope_paths)}`,
              'or rerun with --allow-scope-prune to let submit apply this scope change and retry once'];
            throw error;
          }
          body.scope_paths=error.suggested_scope_paths;
          console.error(`dalan: --allow-scope-prune: changed scope_paths (${change}) and retried once`);
          result=await send();
        }
      } catch(error) {
        if(dryRun&&error.kind==='http'&&error.http_status===404) throw new Error('bridge does not support the safe /submit-preview route; no submission was attempted');
        if(error.kind==='http'&&error.http_status===400&&!error.fix&&!error.verdict&&/^invalid assignment\b/.test(error.message)) error.fix=['correct the job, then run the same dalan submit command again',`a valid example: ${JOB_EXAMPLE_URL}`];
        // Refused (400): the bridge stored nothing, so a receipt this call created goes too.
        if(fresh&&error.kind==='http'&&(error.http_status===400||error.http_status===409&&error.verdict==='defer')) try { fs.unlinkSync(receiptPath(id)); } catch {}
        throw error;
      }
      for(const w of result?.submission_warnings??[]) console.error(`dalan: WARNING: ${w}`);
      if(dryRun) { if(!json) console.error(formatVerdict(result)); process.exitCode=VERDICT_EXIT[result.verdict]??0; break; }
      if(args.includes('--wait')) { result=await waitForAssignment(id,option('--timeout')); indexArtifacts(id,result); waitOutput=true; process.exitCode=waitExitCode(result.status); if(!json) waitTimeoutNote(id,result); }
      // Discovery labels are not capabilities. Report only the persisted, validated binding.
      const producer=typeof saved.producer==='string'&&producerPattern.test(saved.producer)?saved.producer:null;
      const binding=producer===null?'missing':producer!==producerId()?'different':'saved';
      const recovery={producer,get:`${cli} get ${id}`,...(producer?{inbox:`${cli} inbox --producer ${producer}`}:{}),
        binding,wake:args.includes('--wait')?'wait_returned':delivery==='none'?'not_registered_by_this_submit':'delivery_destination'};
      if(json) result={...result,recovery};
      // Human mode: one plain next step on stderr, so stdout stays the JSON document. --json carries the full recovery record.
      else endNote=`${briefGiven?`Request ID: ${id}\nSend your worker: ${workerPrompt(id)}\n`:''}Next: ${recovery.wake==='wait_returned'?`read the result with: ${recovery.get}`:recovery.wake==='delivery_destination'?`the result goes to ${delivery}; check it any time with: ${recovery.get}`:`send your worker the job, then run: ${cli} wait ${id} (check it any time with: ${recovery.get})`}${recovery.inbox?`. List your jobs with: ${recovery.inbox}`:''}`;
      // On a terminal, a person reads the output: show the human lines instead of the JSON receipt. Piped output stays
      // the JSON document, so scripts that read submit's standard output keep working; --json always prints it.
      if(!json&&!waitOutput&&process.stdout.isTTY) { result=`Request ID: ${id}${briefGiven?`\nSend your worker: ${workerPrompt(id)}`:''}`; plainOutput=true; endNote=endNote.split('\n').filter(l=>!l.startsWith('Request ID: ')&&!l.startsWith('Send your worker: ')).join('\n'); }
      break;
    }
    case 'get': { refuseUnknownOptions('get',{flags:['--json']}); const id=args[0]; if(!id||id.startsWith('-')) throw new Error(`get needs a request ID: ${cli} get REQUEST_ID (list your jobs with: ${cli} inbox --all)`); const headers=id.startsWith('msg_')?{}:{'x-owner-capability':receipt(id).token}; result=await request('/get?id='+encodeURIComponent(id),'GET',null,headers); if(!id.startsWith('msg_')) indexArtifacts(id,result);
      // Human mode: one extra line on stderr so stdout stays the JSON document.
      if(!json&&result?.claim?.activity) { const a=result.claim.activity, age=a.last_tool_at?Math.max(0,Math.round((Date.now()-Date.parse(a.last_tool_at))/1000)):null;
        console.error(`worker activity: ${a.tool_calls} call${a.tool_calls===1?'':'s'}${a.last_tool?`, last ${a.last_tool} at ${a.last_tool_at.slice(11,19)}Z (${age<90?age+'s':age<5400?Math.round(age/60)+'m':Math.round(age/3600)+'h'} ago)`:''}${a.first_workspace_tool_at?'':', no workspace tool'}${a.last_tool_error?`, last error: ${a.last_tool_error}`:''}`); }
      // On a terminal, a person reads the output: show the short human view. Piped output stays the JSON document.
      if(!json&&!id.startsWith('msg_')&&process.stdout.isTTY) { result=formatGetSummary(result,{id,cli}); plainOutput=true; }
      else if(!json&&!id.startsWith('msg_')&&result?.status==='finished') endNote=`decide: ${cli} decide ${id} ${decideWords}`;
      break; }
    case 'cancel-if-queued': { const id=args[0]; if(!id||id.startsWith('-')) throw new Error('cancel-if-queued requires request id'); result=await request('/cancel-if-queued','POST',{id},{'x-owner-capability':receipt(id).token}); break; }
    case 'artifact': { const artifactId=args[0],output=option('--output');if(!artifactId||!output) throw new Error('artifact requires ID --output PATH');result=await download(artifactId,output);break; }
    case 'cancel': { const id=args[0]; if(!id) throw new Error('cancel requires request id'); result=await request('/cancel','POST',{id,reason:option('--reason')},{'x-owner-capability':receipt(id).token}); break; }
    case 'status': {
      refuseUnknownOptions('status',{flags:['--json','--explain']});
      result = await request('/status');
      if (args.includes('--explain')) {
        let metrics = null;
        try { metrics = await request('/metrics'); if (!metrics?.window) metrics = null; } catch { /* an older bridge has no /metrics */ }
        const explanation = explainStatus(result) + '\n' + (metrics ? explainMetrics(metrics) : 'metrics=unavailable');
        if (json) result = { ...result, explanation, ...(metrics ? { metrics } : {}) };
        else { result = explanation; plainOutput = true; }
      } else if (!json) { result = formatStatusSummary(result, { home, url: bridgeOrigin(), trial: fs.existsSync(path.join(home, '.dalan-trial')), cli, envHome: process.env.DALAN_HOME }); plainOutput = true; }
      break;
    }
    case 'tool': {
      const rest=args.filter(a=>a!=='--json'),[action,name,workerArg,...extra]=rest;
      const usage='usage: dalan tool add --file PATH | remove NAME | list | grant NAME WORKER | revoke NAME WORKER [--json]';
      const headers={'x-operator-key':operator()};
      if(action==='list'&&rest.length===1) result=await request('/tools','GET',null,headers);
      else if(action==='add'&&name==='--file'&&workerArg&&!extra.length) result=await request('/tools/add','POST',{spec:JSON.parse(fs.readFileSync(workerArg,'utf8'))},headers);
      else if(action==='remove'&&name&&workerArg===undefined) result=await request('/tools/remove','POST',{name},headers);
      else if((action==='grant'||action==='revoke')&&name&&workerArg&&!extra.length) result=await request('/tools/'+action,'POST',{name,worker:workerArg},headers);
      else throw new Error(usage);
      if(!json&&action==='list') { result=result.tools.length?result.tools.map(t=>`${t.name} [${t.class}${t.enabled?'':', disabled'}] ${t.schema_hash.slice(0,12)} workers: ${t.workers.join(', ')||'none'}${t.uncertain?`, ${t.uncertain} message(s) may have been delivered and are not retried`:''}`).join('\n'):'no registered tools'; plainOutput=true; }
      break;
    }
    case 'inbox': { result=await inbox(); if(!json) { result='marked' in result?`marked ${result.marked} read${result.unknown?` (${result.unknown.length} not owned: ${result.unknown.join(', ')})`:''}`:formatInbox(result); plainOutput=true; } break; }
    case 'wait': { refuseUnknownOptions('wait',{flags:['--json','--drained'],values:['--timeout','--producer-thread','--max-claimed','--max-queued']}); if(args.includes('--drained')) { result=await waitDrained(); waitOutput=true; process.exitCode=drainedExitCodes[result.status]; break; } const id=args[0]; if(!id||id.startsWith('-')) throw new Error(`wait needs a request ID: ${cli} wait REQUEST_ID (list your jobs with: ${cli} inbox --all)`); result=await waitForAssignment(id,option('--timeout')); indexArtifacts(id,result); waitOutput=true; process.exitCode=waitExitCode(result.status); if(!json&&process.stdout.isTTY) { result=formatWaitLine(result,{id,cli,seconds:option('--timeout')===null?300:Number(option('--timeout'))}); plainOutput=true; } else if(!json) waitTimeoutNote(id,result); break; }
    case 'note': { if(args.some(a=>a.startsWith('-')&&a!=='--json')) throw new Error('note accepts only --json as an option'); const [id,...parts]=args.filter(a=>a!=='--json'),text=parts.join(' '); if(!id||!text) throw new Error('note requires request id and text'); result=await request('/note','POST',{id,text},{'x-owner-capability':receipt(id).token}); break; }
    case 'questions': { const ids=args.filter(a=>a!=='--json');if(ids.length!==1||ids[0].startsWith('-')) throw new Error('questions requires one request id (optional --json)');result=await request('/questions?id='+encodeURIComponent(ids[0]),'GET',null,{'x-owner-capability':receipt(ids[0]).token});break; }
    case 'answer': { if(args.some(a=>a.startsWith('-')&&a!=='--json')) throw new Error('answer accepts only --json as an option');const [id,questionId,...parts]=args.filter(a=>a!=='--json'),text=parts.join(' ');if(!id||!questionId||!text) throw new Error('answer requires request id, question id and text');result=await request('/answer','POST',{id,question_id:questionId,text},{'x-owner-capability':receipt(id).token});break; }
    case 'tell': { const worker=option('--worker'),rest=args.filter((a,i)=>a!=='--worker'&&args[i-1]!=='--worker');if(rest.some(a=>a.startsWith('-')&&a!=='--json')) throw new Error('tell accepts --worker NAME and --json');const text=rest.filter(a=>a!=='--json').join(' ');if(!text) throw new Error('tell requires text');result=await request('/tell','POST',{text,...(worker?{worker}:{})});break; }
    case 'untell': { const worker=option('--worker'),rest=args.filter((a,i)=>a!=='--worker'&&args[i-1]!=='--worker'&&a!=='--json');if(rest.length!==1||rest[0].startsWith('-')) throw new Error('untell requires message ID (optional --worker NAME, --json)');result=await request('/untell','POST',{message_id:rest[0],...(worker?{worker}:{})});break; }
    case 'audit': { const since=option('--since'); result=await request('/audit'+(since?'?since='+encodeURIComponent(since):''),'GET',null,{'x-operator-key':operator()}); break; }
    case 'pause': { const reason=option('--reason'); if(!reason) throw new Error('pause requires --reason'); result=await request('/pause','POST',{reason},{'x-operator-key':operator()}); break; }
    case 'break': {
      if(args.some((a,i)=>a.startsWith('--')&&!['--json','--clear','--reason','--since'].includes(a)&&!['--reason','--since'].includes(args[i-1]))) throw new Error('break accepts only --reason TEXT, --since RFC3339, --clear and --json');
      if(args.includes('--clear')) { if(args.includes('--reason')||args.includes('--since')) throw new Error('break --clear takes no --reason or --since'); result=await request('/break','POST',{clear:true},{'x-operator-key':operator()}); break; }
      const reason=option('--reason'); if(!reason||reason.startsWith('--')) throw new Error('break requires --reason TEXT (or --clear)');
      if(args.includes('--since')&&(!option('--since')||option('--since').startsWith('--'))) throw new Error('--since requires an RFC 3339 time');
      result=await request('/break','POST',{reason,...(option('--since')?{since:option('--since')}:{})},{'x-operator-key':operator()}); break;
    }
    case 'learned': {
      if(args.some(a=>!['--json','--clear'].includes(a))) throw new Error('learned accepts only --clear and --json');
      result=args.includes('--clear')?await request('/learned','POST',{clear:true},{'x-operator-key':operator()}):await request('/learned','GET',null,{'x-operator-key':operator()}); break;
    }
    case 'breaks': { if(args.some(a=>a!=='--json')) throw new Error('breaks accepts only --json'); result=await request('/breaks','GET',null,{'x-operator-key':operator()}); break; }
    case 'break-usage-backfill': {
      if(args.some((a,i)=>a.startsWith('--')&&!['--json','--id','--log'].includes(a)&&!['--id','--log'].includes(args[i-1]))) throw new Error('break-usage-backfill accepts only --id N, --log PATH and --json');
      const breakId=Number(option('--id')), logFile=option('--log')??defaultPath(home,'.local/state/dot-bridge/requests.jsonl');
      if(!Number.isInteger(breakId)||breakId<1) throw new Error('break-usage-backfill requires --id N');
      if(args.includes('--log')&&(!option('--log')||option('--log').startsWith('--'))) throw new Error('--log requires a path');
      const key=operator(), target=(await request('/breaks','GET',null,{'x-operator-key':key})).breaks.find(b=>b.id===breakId);
      if(!target) throw new Error(`break ${breakId} not found`);
      const scanned=await requestLogUsage(logFile,Date.parse(target.since));
      result={...await request('/break-usage-backfill','POST',{id:breakId,since:target.since,windows:scanned.windows},{'x-operator-key':key}),log:scanned.log};
      break;
    }
    case 'resume': result=await request('/resume','POST',{}, {'x-operator-key':operator()}); break;
    case 'claims': { if(args.some(a=>a!=='--json')) throw new Error('claims accepts only --json'); result=await request('/claims','GET',null,{'x-operator-key':operator()}); break; }
    case 'abandon': { const id=args[0]; if(!id||id.startsWith('-')) throw new Error('abandon requires request id'); if(args.includes('--reason')&&!option('--reason')) throw new Error('--reason requires text'); result=await request('/abandon','POST',{id,...(args.includes('--reason')?{reason:option('--reason')}:{})},{'x-operator-key':operator()}); break; }
    case 'accept': case 'reject': { const id=args[0]; if(!id||id.startsWith('-')) throw new Error(`${command} requires request id`); if(args.includes('--note')&&!option('--note')) throw new Error('--note requires text'); result=await request(`/${command}`,'POST',{id,...(args.includes('--note')?{note:option('--note')}:{})},{'x-owner-capability':receipt(id).token}); break; }
    case 'decide': {
      const [id,decision]=args; if(!id||id.startsWith('-')||!decision||decision.startsWith('-')) throw new Error(`decide requires ID and one of ${decideWords}`);
      if(!decideWords.split('|').includes(decision)) throw new Error(`unknown decision '${decision}': use ${decideWords}`);
      if(args.includes('--note')&&!option('--note')) throw new Error('--note requires text');
      result=await request('/decide','POST',{id,decision,...(args.includes('--note')?{note:option('--note')}:{})},{'x-owner-capability':receipt(id).token});
      if(!json&&process.stdout.isTTY) { result=`Recorded ${id} as ${decision}.`; plainOutput=true; }
      break;
    }
    case 'apply': {
      const id=args[0]; if(!id||id.startsWith('-')) throw new Error('apply requires request id (optional --dir PATH, default the current directory)');
      if(args.includes('--dir')&&!option('--dir')) throw new Error('--dir requires a path');
      const dir=path.resolve(option('--dir')??process.cwd()), headers={'x-owner-capability':receipt(id).token};
      const got=await request('/get?id='+encodeURIComponent(id),'GET',null,headers); indexArtifacts(id,got);
      const ev=got.report?.workspace_evidence, art=ev?.patch_artifact;
      if(!art?.artifact_id||!art.size) throw new Error('this result has no patch artifact (nothing to apply)');
      const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dot-apply-')), file=path.join(tmp,'patch.diff');
      try {
        await download(art.artifact_id,file);
        const files=applyPatch({dir,patch:fs.readFileSync(file),sha256:art.sha256,baseSha:ev.base_sha??got.assignment?.inputs?.[0]?.base_sha});
        let decided; try { decided=await request('/decide','POST',{id,decision:'applied',via:'apply'},headers); } catch(e) { throw new Error(`patch applied in ${dir}, but recording the decision failed: ${e.message}; run dalan decide ${id} applied`); }
        result={request_id:id,applied:true,dir,files,decision:decided.decision};
      } finally { fs.rmSync(tmp,{recursive:true,force:true}); }
      if(!json) { const {files}=result; result=`applied ${files.length} file${files.length===1?'':'s'} in ${dir}; recorded decision applied for ${id}\n${files.map(f=>'  '+f).join('\n')}`; plainOutput=true; }
      break;
    }
    case 'integrate': { const id=args[0]; if(!id||id.startsWith('-')) throw new Error('integrate requires request id'); result=await request('/lifecycle','POST',{id,type:'integrated',...(option('--reason')?{reason:option('--reason')}:{})},{'x-operator-key':operator()}); break; }
    case 'metrics': {
      if(args.some((a,i)=>a.startsWith('--')&&!['--json','--since'].includes(a)&&args[i-1]!=='--since')) throw new Error('metrics accepts only --since RFC3339 and --json');
      if(args.includes('--since')&&!option('--since')) throw new Error('--since requires an RFC 3339 time');
      result=await request('/metrics'+(option('--since')?'?since='+encodeURIComponent(option('--since')):''));
      if(!json) { result=explainMetrics(result).replace(/ (?=[\w/]+=)/g,'\n  '); plainOutput=true; }
      break;
    }
    case 'backfill-objectives': {
      if(args.some(a=>!['--json','--dry-run'].includes(a))) throw new Error('backfill-objectives accepts only --dry-run and --json');
      const key=operator(), readJson=file=>{ try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return null; } };
      const list=dir=>fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>n.endsWith('.json')).map(n=>path.join(dir,n)):[];
      const ledgerFile=path.join(home,legacyFixLedgerPath);
      const ledger=fs.existsSync(ledgerFile)?fs.readFileSync(ledgerFile,'utf8').split('\n').filter(Boolean).flatMap(line=>{ try { return [JSON.parse(line)]; } catch { return []; } }):[];
      const derived=deriveObjectives({receipts:list(receipts).map(readJson).filter(r=>r&&typeof r.body==='string'&&r.body),manifests:list(path.join(root,'manifests')).map(readJson),ledger});
      const server={received:0,updated:0,already_set:0,conflict:0,not_found:0,rejected:0,by_source:{},rejected_examples:[]};
      let last=null;
      for(let i=0;i<derived.tuples.length||last===null;i+=200) {
        last=await request('/backfill-objectives','POST',{tuples:derived.tuples.slice(i,i+200),dry_run:args.includes('--dry-run')},{'x-operator-key':key});
        for(const k of ['received','updated','already_set','conflict','not_found','rejected']) server[k]+=last[k];
        for(const [src,n] of Object.entries(last.by_source)) server.by_source[src]=(server.by_source[src]??0)+n;
        server.rejected_examples.push(...last.rejected_examples.slice(0,20-server.rejected_examples.length));
      }
      const dry=args.includes('--dry-run');
      // In a dry run each batch reports nulls minus its own would-be updates, so subtract the earlier batches' too.
      result={dry_run:dry,derived:derived.counts,server,without_objective:dry?last.without_objective+last.updated-server.updated:last.without_objective,total:last.total};
      break;
    }
    case 'rejections': {
      // Refused submits by reason class, against submits the bridge accepted in the same window.
      args.forEach((a,i)=>{ if(!['--since','--log','--json'].includes(a)&&!['--since','--log'].includes(args[i-1])) throw new Error('rejections accepts only --since RFC3339, --log PATH and --json'); });
      const since=option('--since')??new Date(Date.now()-86400000).toISOString(), sinceMs=Date.parse(since);
      if(!Number.isFinite(sinceMs)) throw new Error('--since requires an RFC 3339 time');
      const summary=summarizeRejections(readLines(option('--log')??defaultPath(home,'.local/state/dot-bridge/requests.jsonl'),{missingOk:true}),sinceMs);
      const { DatabaseSync }=await import('node:sqlite'), db=new DatabaseSync(defaultPath(home,'.local/share/dot-bridge/bridge.db'),{readOnly:true});
      const accepted=db.prepare('SELECT count(*) n FROM assignments WHERE created_at>=?').get(new Date(sinceMs).toISOString()).n; db.close();
      result={since:new Date(sinceMs).toISOString(),accepted,refused:summary.refused,refused_fraction:summary.refused+accepted?Math.round(summary.refused/(summary.refused+accepted)*1000)/1000:null,classes:summary.classes,by_kind:summary.by_kind};
      if(!args.includes('--json')) { result=[`submits since ${result.since}: ${accepted} accepted, ${summary.refused} refused (${result.refused_fraction===null?'n/a':Math.round(result.refused_fraction*100)+'%'})`,...summary.classes.map(c=>`${String(c.count).padStart(6)}  ${c.reason} (${c.distinct_requests} requests) e.g. ${c.example.slice(0,120)}`)].join('\n'); plainOutput=true; }
      break;
    }
    // Built-in authorization server. init writes local files only (no running bridge needed); connect talks to the owner socket.
    case 'init': case 'as-init': {
      const publicUrl=option('--public-url'), legacy=args.includes('--legacy'), name=option('--worker'), profiled=command==='init';
      const flagged=['--json','--public-url','--worker','--legacy'];
      const usage='usage: dalan init --public-url https://HOST (--worker NAME | --legacy)';
      if(!publicUrl||args.some((a,i)=>!flagged.includes(a)&&!['--public-url','--worker'].includes(args[i-1]))||(!profiled&&(legacy||name))) throw new Error(profiled?usage:'usage: dalan as-init --public-url https://HOST');
      if(profiled&&legacy&&name) throw new Error('init takes --worker NAME or --legacy, not both');
      if(profiled&&!legacy&&(!name||name.startsWith('--'))) throw new Error(`init needs --worker NAME to create the first worker profile (or --legacy for an older single-worker host); ${usage}`);
      const config=defaultPath(home,'.config/dot-bridge'), workersFile=path.join(config,'workers.json');
      if(profiled&&!legacy) { parseWorkers({workers:{[name]:{}}},{builtin:true}); if(fs.existsSync(workersFile)) throw new Error(`${workersFile} already exists; init does not overwrite a worker profile`); }
      result=initAsFiles(config,{publicUrl,loopback:readEnv('DALAN_LOOPBACK')==='1',allowHttp:process.env.NODE_ENV!=='production'&&readEnv('DALAN_TEST_OAUTH')==='1'});
      if(profiled&&!legacy) result={...result,workers_profile:{file:writeGenericProfile(workersFile,name),worker:name,default_execution:'none'}};
      else if(profiled) { writeLegacyMarker(config); result={...result,workers_profile:null,legacy_profile:path.join(config,'legacy-profile')}; console.error('dalan: --legacy wrote no workers.json; it wrote a legacy-profile marker so the server starts in legacy mode. Legacy mode (implicit default worker, t3 capability, host execution) is for older single-worker hosts; new hosts should use --worker NAME.'); }
      break;
    }
    case 'as-rotate-keys': {
      const only=args.filter(a=>a!=='--json');
      if(only.some(a=>!['--jwks-only','--cookies-only'].includes(a))||only.length>1) throw new Error('usage: dalan as-rotate-keys [--jwks-only|--cookies-only]; stop the bridge, rotate, start');
      result={...rotateKeys(defaultPath(home,'.config/dot-bridge'),{jwks:!only.includes('--cookies-only'),cookies:!only.includes('--jwks-only')}),restart_required:true};
      break;
    }
    case 'connect': {
      const out=await connectCommand(args,{request,operator,option,json});
      result=out.result; plainOutput=out.plain===true;
      break;
    }
    case 'reconcile': { const id=args[0]; if(!id) throw new Error('reconcile requires id'); const adopt=args.includes('--adopt'); let ownerToken; if(adopt) ownerToken=writeReceipt(id,randomBytes(32).toString('hex'),'', '').token; result=await request('/reconcile','POST',{id,adopt,owner_token:ownerToken},{'x-operator-key':operator()}); break; }
    case 'verify-stops': { const id=args.find(a=>a!=='--json'); result=await request('/verify-stops','POST',id?{id}:{},{'x-operator-key':operator()}); break; }
    case 'prepare-deps': {
      const positional=args.filter(a=>!['--json','--replace-invalid'].includes(a));
      if(positional.length!==1||positional[0].startsWith('-')) throw new Error('usage: dalan prepare-deps SOURCE_DIRECTORY [--json] [--replace-invalid]');
      result=prepareNodeModules(positional[0],{replaceInvalid:args.includes('--replace-invalid')});
      break;
    }
    case 'doctor': {
      if(args.includes('--checks')) {
        // Local only: the owner's checks.json against each repo's default-branch tree (mirror). Warnings never fail the command; errors do.
        const repos=lintChecksFile();
        result=json?{checks:repos}:formatChecksReport(repos);plainOutput=!json;
        if(repos.some(r=>r.checks.some(c=>c.errors.length))) process.exitCode=1;
        break;
      }
      // Local only: what this host can execute and what the executor declares. No bridge call.
      // The host executor's sandbox backends are Linux-only, so on macOS doctor names none of them instead of listing backends that can never run.
      const macHost=process.platform==='darwin',macReason='unavailable on macOS: host checks are not available; jobs can still be delegated with --execution none (no host checks)';
      const readiness=macHost?{ready:false,reason:macReason}:hostReadiness(), backend=macHost?null:hostBackend(), pasta=macHost?null:['/usr/bin/pasta','/usr/local/bin/pasta'].find(f=>fs.existsSync(f))??null;
      // Doctor diagnoses a broken setup, so it runs with no bridge home selected and reports that as one finding. A home
      // directory with bridge files is a bridge home (an older single-worker host), so that counts as selected.
      const trialHome=path.join(home,'.local/share/dalan-trial');
      // A home with no bridge configuration has no worker profile: the legacy default worker it would imply is not shown.
      const hasProfile=!!readEnv('DALAN_WORKERS_FILE')||fs.existsSync(defaultPath(home,'.config/dot-bridge'));
      const homeSelected=!!process.env.DALAN_HOME||hasProfile;
      const noHomeYet='no bridge home here yet. To try Dalan, run: npx @tnunamak/dalan try';
      const bridgeHome=homeSelected?{selected:true}:{selected:false,warning:'no bridge home selected: DALAN_HOME is not set, so this checked the host and your home directory, not a bridge home',
        fix:fs.existsSync(path.join(trialHome,'.dalan-trial'))?`to check the trial bridge, run: export DALAN_HOME=${shellQuote(trialHome)}`:`${noHomeYet} (or export DALAN_HOME=DIR for a bridge home made with dalan init)`};
      const running=hasProfile?await socketListening(socket):false;
      const homeLine=!homeSelected?(fs.existsSync(path.join(trialHome,'.dalan-trial'))?`WARNING: ${bridgeHome.warning}. Fix: ${bridgeHome.fix}`:'No bridge home here yet. To try Dalan, run: npx @tnunamak/dalan try. For a bridge home made with dalan init, export DALAN_HOME=DIR first.')
        :hasProfile?`bridge home: ${home} (${fs.existsSync(path.join(home,'.dalan-trial'))?'trial bridge':'bridge'}, ${running?'running':'not running'})`:`bridge home: ${home}: ${noHomeYet}`;
      // A trial bridge lives only while `dalan try` runs, so a stopped one is the usual state after the terminal closed.
      if(homeSelected&&hasProfile&&!running&&fs.existsSync(path.join(home,'.dalan-trial'))) bridgeHome.fix=stoppedTrialFix(cli,home,os.userInfo().homedir);
      const workersFile=readEnv('DALAN_WORKERS_FILE')||defaultPath(home,'.config/dot-bridge/workers.json');
      const doctorWorkers=loadOwnerWorkers(workersFile);
      const repoPolicies=[...doctorWorkers.workers.keys()].map(worker=>({worker,...doctorWorkers.repoPolicy(worker)}));
      // A worker entry that lists `"repos": []` has no grants yet, which is normal for a new worker. The text output shows it
      // as a plain line, not a WARNING; --json keeps it in repository_access.warnings, because queued repository jobs wait on it.
      const rawWorkers=(()=>{try{return JSON.parse(fs.readFileSync(workersFile,'utf8')).workers??{};}catch{return {};}})();
      const noGrantsYet=policy=>policy.repos.length===0&&Array.isArray(rawWorkers[policy.worker]?.repos)&&rawWorkers[policy.worker].repos.length===0;
      const repoNotes=repoPolicies.filter(noGrantsYet).map(policy=>`worker "${policy.worker}" has no repository grants yet, which is normal for a new worker; repository jobs are denied until you run: dalan worker allow ${policy.worker} OWNER/REPO`);
      const repoWarnings=repoPolicies.filter(policy=>!noGrantsYet(policy)).flatMap(policy=>policy.repos.length===0
        ? [!fs.existsSync(workersFile)&&policy.source!=='admitted-history'?missingProfileWarning(policy.worker,policy):`worker "${policy.worker}" has an empty exact repository list; repository jobs are denied. Use dalan worker allow ${policy.worker} OWNER/REPO; see docs/operations.md#legacy-repository-policy-migration`]
        : !fs.existsSync(workersFile)?[missingProfileWarning(policy.worker,policy)]:[]);
      const repoHistory=readWorkerRepoHistory(path.join(path.dirname(workersFile),'workers-audit.jsonl'),{workersFile});
      const grantAudit=fs.existsSync(workersFile)?inspectGrantAudit(workersFile):{unaudited:[],recorded:[],history_error:null,integrity_error:null};
      if(grantAudit.integrity_error) repoWarnings.push(`${grantAudit.integrity_error}. ${AUDIT_INTEGRITY_HINT}`);
      repoWarnings.push(...grantAudit.unaudited.map(({worker,repos})=>`worker "${worker}" has repository grants with no audit record (${repos.join(', ')}), probably from editing workers.json by hand. The bridge records them when it next loads the file and applies them only if that record is written. Use dalan worker allow/deny to change grants.`),
        ...grantAudit.recorded.map(({worker,repos,at})=>`worker "${worker}": the bridge recorded ${repos.join(', ')} at ${at} because the grant had no audit record (workers.json edited by hand, or a list that predates the audit). Confirm you intended it.`));
      const t3Warnings=readEnv('DALAN_ENABLE_T3_TOOLS')==='1'?[]:[...doctorWorkers.workers].filter(([,worker])=>worker.capabilities.has('t3')).map(([worker])=>`worker "${worker}" has the t3 capability, but reverse-control tools are off; set DALAN_ENABLE_T3_TOOLS=1 (legacy: DOT_BRIDGE_ENABLE_T3_TOOLS=1) to retain them`);
      result={bridge_home:bridgeHome,host_executor:{ready:readiness.ready,reason:readiness.reason,pasta,checks_disabled:readiness.reason===RESOURCE_LIMITS_UNAVAILABLE},backend,repository_access:{workers:repoPolicies,warnings:[...repoNotes,...repoWarnings],unaudited_grants:grantAudit.unaudited,audit_integrity_error:grantAudit.integrity_error,changes:repoHistory.events},t3:{enabled:readEnv('DALAN_ENABLE_T3_TOOLS')==='1',warnings:t3Warnings},
        note:macHost?null:`Historical backend values come from ${backend.measured_by.script} (which measured v1). Live capabilities are unknown while the executor is disabled; execution probes report SKIP.`};
      if(!json) { result=[homeLine,...(bridgeHome.fix&&homeSelected?[`fix: ${bridgeHome.fix}`]:[]),macHost?`host executor: ${macReason}`:`host executor: ${backend.name} v${backend.version}: ${readiness.ready?'ready':readiness.reason===RESOURCE_LIMITS_UNAVAILABLE?'off (optional: only jobs that run checks on this computer need it; a first job does not)':`not ready (${readiness.reason})`}`,...(macHost?[]:[`pasta (install phase network): ${pasta??'not found; the install phase fails closed'}`,...(readiness.ready?['declared capabilities:',...Object.entries(backend.capabilities).map(([name,state])=>`  ${name}: ${state}`)]:['declared capabilities: not checked while host checks are off'])]),...(hasProfile?['repository access:',...repoPolicies.map(policy=>`  ${policy.worker}: ${policy.mode}${policy.repos?.length?` (${policy.repos.join(', ')})`:''}${policy.denied?.length?` except ${policy.denied.join(', ')}`:''}`),...repoNotes,...[...repoWarnings,...t3Warnings].map(warning=>`WARNING: ${warning}`)]:[]),
        ...(macHost?[]:[readiness.ready?'Host checks are on.':`Host checks are off. The first job does not need them; to turn them on, see ${docsUrl('docs/operations.md', 'execution-capability-and-check-evidence')}`])].join('\n'); plainOutput=true; }
      break;
    }
    default: throw new Error(`unknown command "${command}"`);
  }
  console.log(plainOutput ? terminalSafe(result) : jsonTerminalSafe(waitOutput||json ? JSON.stringify(result) : JSON.stringify(result, null, 2)));
  if(endNote) console.error(endNote);
}
// Human error text. A refused assignment that only failed the schema check reads like any other error: the cause, one
// fix with the example, and "nothing was queued". Byte counts are shown only when the bridge measured the brief.
function humanError(e) {
  const fixFor=r=>r.code==='invalid_schema'&&r.field==='assignment'?{...r,fix:`add the missing fields; a valid example: ${JOB_EXAMPLE_URL}`}:r;
  let fix=e.fix, verdict=e.verdict&&Array.isArray(e.reasons)?e:null;
  let message=e.message;
  if(verdict&&!fix&&e.reasons.length===1&&e.reasons[0].code==='invalid_schema'&&e.reasons[0].message===e.message) {
    fix=[fixFor(e.reasons[0]).fix]; verdict=null;
    // The bridge lists the fields it found missing or wrong as "brief, expected_output (a string)". Name each one.
    const wrong=/; missing or wrong: (.+)$/.exec(e.message)?.[1].split(', ').map(item=>{ const [,field,need]=/^(\S+)(?: \((?:must be |an? )?(.+)\))?$/.exec(item)??[null,item,null];
      return need?`${field} must be ${/^\d/.test(need)?need:`${/^[aeiou]/.test(need)?'an':'a'} ${need}`}`:`${field} is missing or invalid`; });
    if(wrong?.length) message=`the job is not a valid assignment: ${wrong.join('; ')}`;
  }
  const bytes=e.bytes?.limits&&(e.bytes.limits.brief||e.bytes.limits.instructions)?e.bytes:undefined;
  return `dalan: ${message}${e.reason?` (${e.code??'no code'}: ${e.reason.split('\n')[0]})`:''}${fix?`\n${fix.map(l=>`dalan: fix: ${l}`).join('\n')}\ndalan: nothing was queued or changed`:''}${verdict?`\n${formatVerdict({verdict:e.verdict,reasons:e.reasons.map(fixFor),bytes,retry_after_seconds:e.retry_after_seconds}).split('\n').map(l=>`dalan: ${l}`).join('\n')}`:''}`;
}
main().catch(e => { console.error(json ? JSON.stringify({ error:e.message,kind:e.kind??'local',...(e.suggested_scope_paths?{suggested_scope_paths:e.suggested_scope_paths}:{}),...(e.verdict?{verdict:e.verdict,reasons:e.reasons,bytes:e.bytes,...(e.retry_after_seconds?{retry_after_seconds:e.retry_after_seconds}:{})}:{}),...(e.fix?{fix:e.fix}:{}),...(Number.isInteger(e.http_status)?{http_status:e.http_status}:{}),...(e.local_code?{code:e.local_code}:{}),...(e.reason?{cause_code:e.code??null,reason:e.reason}:{}) }) : humanError(e)); process.exitCode = e.verdict&&e.verdict in VERDICT_EXIT ? VERDICT_EXIT[e.verdict] : 1; });
