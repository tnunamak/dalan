import {inspect} from 'node:util';
import { loopbackRequestAllowed } from './loopback.mjs';
import { defaultPath,workspaceRoot,rootWarnings } from './paths.mjs';
import { readEnv } from './env.mjs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createBuiltinHttpServer } from './builtin-http.mjs';
import { createProtocolOwnerWaiters } from './protocol-owner-waiters.mjs';
import {createProtocolServices} from './protocol-services.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { loadWorkers, hasInstalledDatabase, legacyMarkerPath, seedWorkerRepos, resolveWorker, hasCapability, assertTarget, submitTarget } from './workers.mjs';
import { Store, validateProtocol, loadRedeliveryLimits, resumeNudge } from './store.mjs';
import {protocolArtifactChunk} from './protocol-artifact-commands.mjs';
import { sendWebhook, validSecret } from './webhooks.mjs';
import { checkAlerts, publishAlert, redactNote } from './alerts.mjs';
import { redactOutput, redactSinkText, redactLogEntry, registerSecret } from './redaction.mjs';
import { isCrash, safeDiagnostic } from './diagnostic.mjs';
import { Workspace, NOT_IDENTIFIED } from './workspace.mjs';
import { captureOwnerReportArtifact } from './owner-report-artifact.mjs';
import { loadBackgroundMaxInFlight, loadMainThreadIds, t3ReadToolsOff } from './limits.mjs';
import { parseDelivery } from './delivery.mjs';
import { createDestinations } from './destinations/index.mjs';
import { AckLedger } from './ack-ledger.mjs';
import { NotifyLedger, notifyKey } from './notify-ledger.mjs';
import { createDrainRunner } from './drain-runner.mjs';
import { renderAssignment, validateSubmissionAsync } from './submission-policy.mjs';
import { compileWorkOrder, reasonsFromError, strongest } from './work-order.mjs';
import { assertNoDeclaredConsumer, unprovenSource } from './consumers.mjs';
import { preflightPR } from './pr-preflight.mjs';
import { admitImplementation } from './check-readiness.mjs';
import { parseExecution, parseRequiredCapabilities, admitHostExecution, withEvidence } from './execution.mjs';
import { loadCapacity } from './projects.mjs';
import { authConfig, assertPublicRouteAuth, isLoopbackBindHost, protectedResource, challenge, verifyBearer, needScope } from './auth.mjs';
import { beginMcpOutcome, recordMcpResponse, pathShape } from './mcp-outcome.mjs';
import { lifecycleMetrics, retainLifecycle } from './lifecycle.mjs';
import { normalizeMeta } from './objectives.mjs';
import { createRequestLog } from './request-log.mjs';
import { logShutdownSignals } from './shutdown-signal.mjs';
import { ADVERTISED_SCOPES, legacyScopeNames, wireScope } from './scopes.mjs';
import { acquireAsOwner, loadAsConfig, loadKeys } from './as-files.mjs';
import { createSignal } from './signal.mjs';
import { adminSocketPathError } from './admin-socket.mjs';
import { createToolRegistry, createT3PostHandler, RegistryError } from './tool-registry.mjs';

export async function main({protocolServiceAdapters,loopbackOnly=false}={}) {
if(typeof loopbackOnly!=='boolean')throw new Error('loopbackOnly must be boolean');
process.umask(0o077);
const home = os.homedir();
const configDir = defaultPath(home,'.config/dot-bridge');
const dataDir = defaultPath(home,'.local/share/dot-bridge');
const stateDir = defaultPath(home,'.local/state/dot-bridge');
const socketPathError=adminSocketPathError(path.join(dataDir,'admin.sock'));
if(socketPathError) throw socketPathError;
const pathWarnings=rootWarnings(home); // Capture before startup creates any files.
const loopback=readEnv('DALAN_LOOPBACK')==='1';
if(loopback && readEnv('DALAN_AUTH_MODE')!=='builtin') throw new Error('DALAN_LOOPBACK=1 requires DALAN_AUTH_MODE=builtin and valid bearer tokens');
const builtinMode=readEnv('DALAN_AUTH_MODE')==='builtin';
// Refuse a second owner before creating or changing env, operator keys, databases, logs or sockets.
const configuredBind=readEnv('DALAN_BIND_HOST');
if((loopback||builtinMode||loopbackOnly) && configuredBind!==undefined && configuredBind!=='127.0.0.1') throw new Error('loopback mode requires DALAN_BIND_HOST=127.0.0.1');
const testHttpAllowed=process.env.NODE_ENV!=='production'&&readEnv('DALAN_TEST_OAUTH')==='1';
// The effective listener host: loopback modes bind 127.0.0.1, otherwise the configured host or the 0.0.0.0 default.
const effectiveBindHost=(loopback||builtinMode||loopbackOnly)?'127.0.0.1':(configuredBind||'0.0.0.0');
const externalPublicBind=readEnv('DALAN_AUTH_MODE')==='oauth'&&!loopback&&!loopbackOnly&&!isLoopbackBindHost(configuredBind||'0.0.0.0');
const insecureFlags=['DALAN_DEV_ALLOW_UNAUTHENTICATED','DALAN_ALLOW_INSECURE_PUBLIC'].filter(name=>process.env.NODE_ENV!=='production'&&readEnv(name)==='1');
if(externalPublicBind && readEnv('DALAN_TRUST_PROXY')!=='1' && !testHttpAllowed) {
  if(insecureFlags.length) throw new Error(`refusing to start on a non-loopback bind with ${insecureFlags.join(' and ')} set: neither flag bypasses the TLS reverse proxy requirement; unset the flag, bind to loopback (DALAN_BIND_HOST=127.0.0.1, ::1 or localhost), or put a TLS reverse proxy in front and set DALAN_TRUST_PROXY=1`);
  throw new Error('non-loopback HTTP requires a TLS reverse proxy and DALAN_TRUST_PROXY=1; use DALAN_LOOPBACK=1 for local HTTP');
}
const asOwner=builtinMode?acquireAsOwner(configDir):null;
for (const dir of [configDir, dataDir, stateDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const envPath = path.join(configDir, 'env');
if (!fs.existsSync(envPath)) fs.writeFileSync(envPath, `BRIDGE_PATH_SECRET=${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
fs.chmodSync(envPath, 0o600);
const secret = /^BRIDGE_PATH_SECRET=(.+)$/m.exec(fs.readFileSync(envPath, 'utf8'))?.[1];
if (!secret || !/^[a-f0-9]{64}$/.test(secret)) throw new Error('invalid BRIDGE_PATH_SECRET');
const operatorFile=path.join(configDir,'operator.key');
if (!fs.existsSync(operatorFile)) fs.writeFileSync(operatorFile,randomBytes(32).toString('hex')+'\n',{mode:0o600,flag:'wx'});
fs.chmodSync(operatorFile,0o600);
const operatorKey=fs.readFileSync(operatorFile,'utf8').trim();
// The path secret and operator key are credentials this process holds: every sink masks them by value.
registerSecret(secret);registerSecret(operatorKey);
const externalOauth=builtinMode?null:authConfig();
const workersFile=readEnv('DALAN_WORKERS_FILE')||path.join(configDir,'workers.json');
const workers=loadWorkers(workersFile,{builtin:builtinMode,auditGrants:true}),legacyProfile=workers.legacy===true;
const redeliveryLimits=loadRedeliveryLimits();
const asConfig=builtinMode?loadAsConfig(configDir,{loopback,allowHttp:process.env.NODE_ENV!=='production'&&readEnv('DALAN_TEST_OAUTH')==='1'}):null;
if(builtinMode) loadKeys(configDir);
const oauth= builtinMode ? {builtin:true,OAUTH_AUDIENCE:new URL(`/${secret}/mcp`,asConfig.public_url).href,OAUTH_CHALLENGE_SCOPE:'dalan.read dalan.work'} : externalOauth;
assertPublicRouteAuth(oauth,undefined,{bindHost:effectiveBindHost});
const oauthMetadata=oauth??authConfig(undefined,false);
if(oauthMetadata&&readEnv('DALAN_CATALOG_PROFILE')==='legacy-v46') oauthMetadata.legacyScopeNames=true;
if(oauthMetadata) oauthMetadata.OAUTH_RESOURCE_METADATA=new URL(`/.well-known/oauth-protected-resource/${secret}/mcp`,oauthMetadata.OAUTH_AUDIENCE).href;
const claimCapacity=loadCapacity();
const backgroundMaxInFlight=loadBackgroundMaxInFlight();
const catalogProfile=readEnv('DALAN_CATALOG_PROFILE')||'stable';
const t3ToolsSetting=readEnv('DALAN_ENABLE_T3_TOOLS')??'0';
if(!['0','1'].includes(t3ToolsSetting))throw new Error('DALAN_ENABLE_T3_TOOLS must be 0 or 1');
const t3ToolsEnabled=t3ToolsSetting==='1';
if(!['stable','questions-v1','protocol-v0','legacy-v46'].includes(catalogProfile)) throw new Error('DALAN_CATALOG_PROFILE must be stable, questions-v1 or protocol-v0; legacy-v46 is also supported');
if(protocolServiceAdapters&&catalogProfile!=='protocol-v0')throw new Error('protocol dependencies require protocol-v0 profile');
const port=Number(readEnv('DALAN_PORT')||8787);
if(!Number.isInteger(port)||port<0||port>65535) { const error=new RangeError(`options.port should be >= 0 and < 65536. Received ${port}`); error.code='ERR_SOCKET_BAD_PORT'; throw error; }
if(loopback && (new URL(asConfig.public_url).origin!==`http://127.0.0.1:${port}` || port===0)) throw new Error('loopback public_url must be http://127.0.0.1:<DALAN_PORT> with a fixed port');
const envDeferQueued=readEnv('DALAN_DEFER_QUEUED')===undefined?null:Number(readEnv('DALAN_DEFER_QUEUED'));
if(envDeferQueued!==null&&(!Number.isSafeInteger(envDeferQueued)||envDeferQueued<1)) throw new Error('DALAN_DEFER_QUEUED must be a positive integer');
loadMainThreadIds();
t3ReadToolsOff();
if(t3ToolsEnabled&&!legacyProfile) {
  const t3Workers=[...workers.workers].filter(([,worker])=>worker.capabilities.has('t3'));
  if(t3Workers.length) {
    const {t3Available}=await import('./t3.mjs');
    for(const [name] of t3Workers) if(!t3Available()) { console.error(`dalan: startup: worker ${name} has capability t3 but t3code was not found on PATH; install T3 Code or remove the capability`); process.exit(1); }
  }
}
function currentRepoPolicy() {
  if(!legacyProfile&&!fs.existsSync(workersFile)) throw new Error('worker profile disappeared; repository policy is unavailable');
  return loadWorkers(workersFile,{builtin:builtinMode,auditGrants:true,
    builtinConnectionIds:worker=>as.store.liveConnectionIds(worker)});
}
// Owner-only log line: keep nested causes, but bound the size and never run a custom inspect hook from a loaded error.
const CONFIG_ERROR_INSPECT={depth:6,maxStringLength:8192,maxArrayLength:50,breakLength:Infinity,customInspect:false};
const existingInstall=hasInstalledDatabase(path.join(dataDir,'bridge.db'));
const explicitLegacy=readEnv('DALAN_LEGACY_PROFILE')==='1'||fs.existsSync(legacyMarkerPath(configDir));
// A start with no workers.json used to invent a worker named "dot". Only an install that already has a database keeps
// that behavior; a fresh install must name its worker. `dalan init --legacy` (which writes the legacy-profile marker) or
// DALAN_LEGACY_PROFILE=1 opts back in for hand-run setups. An empty or schema-less bridge.db does not count as an install.
if(legacyProfile&&!existingInstall&&!explicitLegacy) {
  asOwner?.release();
  console.error(`dalan: startup: no worker is configured (${workersFile} is missing); run \`dalan init --worker NAME\` to create one, or \`dalan init --legacy\` (or set DALAN_LEGACY_PROFILE=1) to keep the single-worker legacy profile`);
  process.exit(1);
}
const store = new Store(path.join(dataDir, 'bridge.db'),{
  // The caller sees one fixed configuration error; the real one stays in this server's log.
  onConfigError:error=>log({kind:'destination_configuration_error',reason:inspect(error,CONFIG_ERROR_INSPECT)}),
  workers,destinationProfile:currentRepoPolicy,allowedDotSubjects:externalOauth?externalOauth.OAUTH_ALLOWED_SUBJECTS.split(','):['local-principal'],
  limits:redeliveryLimits,
  ...(process.env.CONFORMANCE_CLOCK_FILE?{elapsedNow:Date.now,bootId:'conformance-clock'}:{}),
  skipExpireMs:(h=>Number.isFinite(h)&&h>0?h*3600000:undefined)(Number(readEnv('DALAN_SKIP_EXPIRE_HOURS'))),
  // Intentional service startup opts past Store's accidental-migration footgun guard.
  deferSubscriptionRetirement:true,markProfileModeSeen:!legacyProfile,allowDefaultHomeMigration:true
});
const ackLedger=new AckLedger(path.join(dataDir,'delivery-acks.db'));
const notifyLedger=new NotifyLedger(path.join(dataDir,'notify-sent.db'));
process.on('exit',()=>{try{ackLedger.close();}catch{}try{notifyLedger.close();}catch{}});
if(legacyProfile&&store.profileModeSeen()&&readEnv('DALAN_LEGACY_PROFILE')!=='1') {
  store.db.close();
  asOwner?.release();
  console.error(`dalan: startup: worker profile file ${workersFile} is missing after a profile was loaded; restore it or set DALAN_LEGACY_PROFILE=1 to allow legacy mode`);
  process.exit(1);
}
seedWorkerRepos(workersFile,store.db,{existingInstall});
let t3AuditPromise;
const loadT3Audit=()=>t3AuditPromise??=import('./t3-audit.mjs').then(audit=>{audit.initT3Audit(store.db);return audit;});
if(t3ToolsEnabled) await loadT3Audit();
// A valid but unallocated ID preserves each tool's existing absent-request errors. Never accept it as an owner target.
const absentId=`req_${randomUUID()}`;
if(store.hasAssignment(absentId)) throw new Error('absent gate id collision');
const socket = path.join(dataDir, 'admin.sock');
const log = createRequestLog(path.join(stateDir, 'requests.jsonl'));
logShutdownSignals(log);
// The owner-side tool registry. It has no MCP surface here: changing it never changes tools/list.
const t3PostHandler=createT3PostHandler({store,now:()=>store.nowMs()});
const toolRegistry=createToolRegistry({store,now:()=>store.nowMs(),handlers:{t3_post:t3PostHandler},
  audit:entry=>log({kind:'tool_registry',...entry})});
for(const warning of pathWarnings) {
  const entry={kind:'root_passed_over',...warning};
  log(entry);console.error(JSON.stringify(redactLogEntry(entry)));
}
const publicPath = `/${secret}/mcp`;
if(!t3ToolsEnabled)for(const [worker,profile] of workers.workers)if(profile.capabilities.has('t3')) {
  log({kind:'t3_tools_disabled',worker,setting:'DALAN_ENABLE_T3_TOOLS=1'});
  console.error(`dalan: startup WARNING: worker "${worker}" has t3 capability but reverse-control tools are off; set DALAN_ENABLE_T3_TOOLS=1`);
}
if(t3ToolsEnabled)for(const [worker,profile] of workers.workers)if(profile.capabilities.has('t3')) console.error(`dalan: startup NOTICE: worker "${worker}" holds the t3 capability: it can list, read and send to any T3 thread and project on this computer. Grant it only to your own harness.`);
const startupPolicy=currentRepoPolicy();
for(const worker of workers.workers.keys()) if(startupPolicy.repoPolicy(worker)?.repos.length===0) {
  const blocked=store.db.prepare("SELECT count(*) n FROM assignments WHERE target_worker=? AND status='queued' AND json_type(payload,'$.inputs[0].github_repo')='text'").get(worker).n;
  const entry={kind:'repository_policy_empty',worker,queued_repo_jobs_blocked:blocked};
  log(entry);console.error(JSON.stringify(redactLogEntry(entry)));
}
// Built-in authorization server (DALAN_AUTH_MODE=builtin): the bridge issues and checks its own opaque tokens. Without it,
// DALAN_AUTH_MODE=oauth keeps the external-issuer path (Keycloak JWTs) exactly as it was.
let as=null;
if(builtinMode) {
  const { createAs } = await import('./as.mjs');
  const testHttp=process.env.NODE_ENV!=='production'&&readEnv('DALAN_TEST_OAUTH')==='1';
  const mcpUrl=oauth.OAUTH_AUDIENCE;
  as=createAs({owner:asOwner,dir:configDir,resource:mcpUrl,allowHttp:testHttp,loopback,workerNames:()=>[...workers.workers.keys()],log,
    onConnectionRevoked:(connectionId,reason)=>store.retireConnectionSubscriptions(connectionId,`connection ${reason}`)});
  oauth.OAUTH_ISSUER=as.issuer; oauth.OAUTH_AUDIENCE=as.resource;
  store.connectionIsLive=connectionId=>as.store.connectionIsLive(connectionId);
}
// Wake signal for hook-driven workers: built-in mode only, so oauth and legacy modes have no such route.
const signal=as?createSignal({dir:configDir,store,workerNames:()=>[...workers.workers.keys()],publicUrl:as.publicUrl,log}):null;
store.retireUnknownSubscriptions();
// Config and auth validation above must finish before Store opens or migrates the database.
store.capacity=claimCapacity; store.limits=redeliveryLimits; store.backgroundMaxInFlight=backgroundMaxInFlight;
const workspaceEnabled=!!oauth && readEnv('DALAN_ENABLE_WORKSPACE')==='1';
const workspace=workspaceEnabled?new Workspace(store):null;
const protocolServices=catalogProfile==='protocol-v0'?createProtocolServices(store,{
  operatorKey,receiptDir:path.join(workspaceRoot(home),'host-receipts'),
  transport:protocolServiceAdapters?.transport,resolveStopEvidence:protocolServiceAdapters?.resolveStopEvidence,
}):null;
const iconBytes=fs.readFileSync(new URL('../docs/t3-connector-icon.png',import.meta.url));
const iconSource=`data:image/png;base64,${iconBytes.toString('base64')}`;
if(Buffer.byteLength(iconSource)>10000) throw new Error('server icon exceeds 10 KB');
const serverInfo={name:catalogProfile==='legacy-v46'?'dot-bridge':'dalan',version:catalogProfile==='legacy-v46'?'0.2.0':'0.5.0',icons:[{src:iconSource,mimeType:'image/png',sizes:['128x128']}]};
// A quiet-delivery job in profile mode has no T3 thread; its response must not carry the T3 fields. Legacy profile keeps them.
const withoutT3=response=>{ if(legacyProfile||response.delivery_mode!=='none') return response; const {t3_muted,thread_id,...rest}=response; return rest; };
function mayPrepareCheckMetadata(response,worker,subject=null) {
  const target=response.target_worker??worker;
  const repo=response.assignment.inputs?.find(input=>input?.github_repo!==undefined)?.github_repo;
  if(repo===undefined||repoPolicyFor(response.assignment).allowsRepo(target,repo)) return true;
  // Revocation blocks new preparation, but an existing live grant may still finish.
  const claim=store.db.prepare('SELECT * FROM claims WHERE request_id=?').get(response.request_id);
  return response.status==='claimed'&&!response.cancelled_at&&claim?.state==='active'&&claim.worker===target&&
    (subject===null||claim.subject===subject)&&!store.leaseExpired(claim);
}
function withAvailableChecks(response,workerSurface=false,worker='dot',subject=null) {
  response=withoutT3(response);
  const artifacts=store.sealedUploads(response.request_id,{clientIds:workerSurface});
  // origin_claim_id is a claim capability: worker replies never carry it, and the owner surface keeps it.
  if(workerSurface) for(const artifact of artifacts) delete artifact.origin_claim_id;
  if(!workerSurface) artifacts.push(...store.db.prepare("SELECT id,kind,size,sha256 FROM artifacts WHERE request_id=? AND sealed=1 AND kind='owner-report' ORDER BY created_at,id").all(response.request_id));
  const checks=store.db.prepare("SELECT j.id check_run_id,j.check_id,CASE WHEN j.status='completed' THEN COALESCE(r.diff_sha256,j.diff_sha256) ELSE j.diff_sha256 END diff_sha256,j.status,j.error,j.output_preview,r.exit_code,r.timed_out,r.output_artifact_id,r.output_sha256,r.duration_ms,r.evidence FROM check_jobs j LEFT JOIN check_runs r ON r.id=j.id WHERE j.request_id=? ORDER BY j.started_at").all(response.request_id).map(withEvidence);
  const blocker=workerSurface?null:queuedRepositoryBlocker(response);
  const enriched={...response,artifacts,checks,...(blocker?{queue_blocker:blocker}:{}),...(checks.some(c=>c.evidence)?{not_identified:NOT_IDENTIFIED}:{})};
  if(!workspaceEnabled||response.assignment?.execution_scope!=='implementation') return enriched;
  const target=store.db.prepare('SELECT target_worker FROM assignments WHERE request_id=?').get(response.request_id)?.target_worker??worker;
  if(!mayPrepareCheckMetadata(response,target,subject)) return {...enriched,available_checks:[],available_checks_error:'repository_policy_denied'};
  const execution=response.execution??store.db.prepare('SELECT execution FROM assignments WHERE request_id=?').get(response.request_id).execution;
  return {...enriched,...workspace.availableChecksResponse(response.assignment,null,execution,target)};
}
// Worker-written text in an owner read is masked on the way out. The database keeps the exact text, so a retried finish
// with the same body stays the same finish.
const maskText=value=>typeof value==='string'?redactOutput(value):value;
function maskedForOwner(response) {
  const out={...response};
  if(out.report) out.report={...out.report,summary:maskText(out.report.summary),result:maskText(out.report.result)};
  if(out.late_evidence) out.late_evidence={...out.late_evidence,summary:maskText(out.late_evidence.summary)};
  if(Array.isArray(out.progress)) out.progress=out.progress.map(row=>({...row,note:maskText(row.note)}));
  if(out.claim?.activity) out.claim={...out.claim,activity:{...out.claim.activity,last_tool_error:maskText(out.claim.activity.last_tool_error)}};
  return out;
}
const publicClaimFields=['request_id','claimant','subject','claimed_at','last_progress_at','last_claim_activity_at','worker','epoch','state','abandoned_at','abandon_reason','lease_expires_at','activity','destination_revision'];
// Worker-visible get must never carry claim capability values. The claim-field
// allowlist above already drops claim_id; this recursive pass additionally drops
// claim_id, origin_claim_id and acquisition_id from every other generated
// worker-get field (claim activity, sealed-upload metadata, check and report
// evidence, delivery arguments, nested objects and arrays included). The
// submitted assignment is split out first and restored unchanged: same-named
// keys inside assignment inputs or prose are ordinary data, not capability
// values. Key-based redaction does not remove capability values embedded in
// arbitrary strings or assignment prose. Owner reads do not use this
// projection and keep the full evidence, as do stored reports, artifact
// provenance and database rows. A successful claim response still returns the
// newly acquired grant; that delivery is not a worker get.
const workerHiddenMetadataKeys=new Set(['claim_id','origin_claim_id','acquisition_id']);
function omitWorkerCapabilityKeys(value) {
  if(Array.isArray(value)) return value.map(omitWorkerCapabilityKeys);
  if(value&&typeof value==='object') return Object.fromEntries(Object.entries(value).filter(([key])=>!workerHiddenMetadataKeys.has(key)).map(([key,child])=>[key,omitWorkerCapabilityKeys(child)]));
  return value;
}
function publicWorkerGet(response) {
  if(response.destination_approval) {
    const {actor,...approval}=response.destination_approval;
    response={...response,destination_approval:approval};
  }
  const questions=store.questions(response.request_id).map(({claim_id,subject,...question})=>question);
  if(questions.length) response={...response,questions};
  const {assignment,...rest}=response;
  const projected=rest.claim?{...rest,claim:Object.fromEntries(publicClaimFields.filter(key=>Object.hasOwn(rest.claim,key)).map(key=>[key,rest.claim[key]]))}:rest;
  const redacted=omitWorkerCapabilityKeys(projected);
  return Object.hasOwn(response,'assignment')?{...redacted,assignment}:redacted;
}
function crashAt(point, requestId) { return readEnv('DALAN_CRASH_AT')===point && (!readEnv('DALAN_CRASH_REQUEST_ID') || readEnv('DALAN_CRASH_REQUEST_ID')===requestId); }
const T3_READ_TOOLS_OFF={off:true,message:'T3 thread tools are off; the needed context is inlined in your assignment.'};
// The final boundary for every HTTP response: error text and error data pass the redactor whatever path built them.
function json(res, status, value) { if (value && typeof value === 'object' && !Array.isArray(value)) for (const key of ['error', 'reason', 'check_metadata_error']) if (value[key] !== undefined) value = { ...value, [key]: redactOutput(value[key]) };
  const body = JSON.stringify(value), bytes = Buffer.byteLength(body); recordMcpResponse(res,value,bytes); res.writeHead(status, { 'content-type': 'application/json', 'content-length': bytes }); res.end(body); }
async function readBody(req, outcome) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) { if(outcome)outcome.error_type='body_too_large';throw new Error('body too large'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function rpcError(id, code, message, data) { return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } }; }
function str(value, name, max = 65536) { if (typeof value !== 'string' || !value || Buffer.byteLength(value) > max) throw new Error(`invalid ${name}`); return value; }
function id(value,name='request_id') { const s=str(value,name,128); if(!/^[-\w]{8,128}$/.test(s)) throw new Error(`invalid ${name}`); return s; }
function authorize(received,expected,label) { const a=Buffer.from(received||''),b=Buffer.from(expected); if(a.length!==b.length||!timingSafeEqual(a,b)) throw new Error(`invalid ${label}`); }
function adminOwner(req,idValue) { store.owner(id(idValue),req.headers['x-owner-capability']); }
function adminOperator(req) { authorize(req.headers['x-operator-key'],operatorKey,'operator key'); }

const event = {
  name: 'assignment.available', description: 'An assignment or lightweight message is available. Claim assignments by request_id; read messages by message_id. Use list_pending after missed events.',
  delivery: ['webhook'], inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  payloadSchema: { type: 'object', properties: { request_id: { type: 'string' }, message_id: { type: 'string' }, title: { type: 'string' } }, required: ['title'], additionalProperties: false }
};
const schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const string={type:'string'}, integer={type:'integer'};
const threadId={type:'string',maxLength:128};
const short={type:'string',maxLength:512};
const hashField={type:'string',maxLength:128},keyField={type:'string',minLength:1,maxLength:128};
const message={type:'string',maxLength:262144};
const bool={type:'boolean'};
const optionsArray={type:'array',items:string,maxItems:16};
const tools = [
  { name:'list_pending',description:'List up to 50 queued assignment IDs and titles.',inputSchema:schema({}) },
  { name:'claim',description:'Claim one immutable assignment and see available_checks before choosing run_check.check_id. lease_ms sets this grant’s duration, up to the owner-configured maximum. An exact live retry retains the grant and its stored duration.',inputSchema:schema({request_id:string,claimant:string,acquisition_id:{type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9_-]+$'},lease_ms:{type:'integer',minimum:1,maximum:store.limits.leaseMs}},['request_id','claimant']) },
  { name:'get',description:'Read assignment, available_checks, cancellation, progress, report and delivery facts.',inputSchema:schema({request_id:string},['request_id']) },
  { name:'ack_message',description:'Acknowledge a lightweight message after reading it; no claim or finish is needed.',inputSchema:schema({message_id:string},['message_id']) },
  { name:'progress',description:'Append progress. Set blocker:true or start note with BLOCKED: or QUESTION: to forward a question to the owner thread. A note over 4096 bytes is cut.',inputSchema:schema({request_id:string,claim_id:string,note:message,blocker:bool},['request_id','claim_id','note']) },
  { name:'ask_question',description:'Ask an identified question under the current grant. The owner answers this question explicitly; ordinary notes do not answer it. Consume its answer before reporting completed.',inputSchema:schema({request_id:string,claim_id:string,question_id:{type:'string',minLength:1,maxLength:128},text:{type:'string',minLength:1,maxLength:4096}},['request_id','claim_id','question_id','text']) },
  { name:'consume_answer',description:'Read and durably consume the identified question answer under its original current grant. Refuses unanswered or stale-epoch questions.',inputSchema:schema({request_id:string,claim_id:string,question_id:{type:'string',minLength:1,maxLength:128}},['request_id','claim_id','question_id']) },
  { name:'finish',description:'Store a terminal worker report; completion is not owner acceptance. summary is optional: when absent it is the first line of result, and one over 4096 bytes is cut.',inputSchema:schema({request_id:string,claim_id:string,outcome:{type:'string',enum:['completed','blocked','failed']},summary:message,result:{type:'string',maxLength:262144},artifact_ids:{type:'array',items:string,maxItems:8}},['request_id','claim_id','outcome','result']) },
  { name:'list_files',description:"List files in this assignment's checked-out repository workspace. Read-only; scoped to the assignment. When truncated is true, pass next_cursor as cursor to get the next page.",inputSchema:schema({request_id:string,claim_id:string,path:string,limit:{type:'integer',minimum:1,maximum:200},cursor:{type:'string',maxLength:1024}},['request_id','claim_id']) },
  { name:'read_file',description:"Read a file from this assignment's checked-out repository workspace. Read-only; scoped to the assignment. The result has end_line (the last line included) and truncated (true when the 32 KiB cap cut the requested window).",inputSchema:schema({request_id:string,claim_id:string,path:string,start_line:{type:'integer',minimum:1},max_lines:{type:'integer',minimum:1,maximum:200}},['request_id','claim_id','path']) },
  { name:'apply_patch',description:"Apply a unified diff to this assignment's private workspace copy. Changes stay local until the owner reviews them; nothing is pushed.",inputSchema:schema({request_id:string,claim_id:string,patch:{type:'string',maxLength:262144}},['request_id','claim_id','patch']) },
  { name:'run_check',description:'Start a listed repository check. Returns immediately for long checks; poll workspace_result for status and result. Fast checks may return a completed receipt. Unknown check_id returns available IDs.',inputSchema:schema({request_id:string,claim_id:string,check_id:string},['request_id','claim_id','check_id']) },
  { name:'workspace_result',description:'Read the current diff, available_checks, check receipts, and artifact references.',inputSchema:schema({request_id:string,claim_id:string},['request_id','claim_id']) },
  { name:'artifact_chunk',description:'Upload a sealed artifact for any claimed assignment, including read-only assignments.',inputSchema:schema({request_id:string,claim_id:string,artifact_id:string,offset:{type:'integer',minimum:0},data_base64:string,final:{type:'boolean'},sha256:{type:'string',pattern:'^[a-fA-F0-9]{64}$'}},['request_id','claim_id','artifact_id','offset','data_base64']) },
  { name:'t3_thread_list',description:'List T3 threads across projects or filter by project/cwd and status.',inputSchema:schema({projectId:threadId,cwd:short,workspaceMode:short,status:{type:'string',enum:['active','settled','all']}}) },
  { name:'t3_thread_read',description:'Read a bounded T3 thread transcript.',inputSchema:schema({threadId,detail:{type:'string',enum:['answers','messages','full']},turns:{type:'integer',minimum:1,maximum:100},firstTurn:bool,maxChars:{type:'integer',minimum:1,maximum:20000}},['threadId']) },
  { name:'t3_thread_create',description:'Create a T3 thread in any project or directory and start its first turn.',inputSchema:schema({projectId:threadId,cwd:short,prompt:message,workspaceMode:short,projectPolicy:short,provider:short,model:short,thinkingEffort:short,permission:short,interactionMode:short,environmentMode:short,speedMode:short,open:short,options:optionsArray},['prompt']) },
  { name:'t3_thread_send',description:'Send to any T3 thread, including settled threads when wakeSettled is true.',inputSchema:schema({threadId,message,mode:{type:'string',enum:['refuse','queue','steer','restart']},wakeSettled:bool,provider:short,model:short,thinkingEffort:short,permission:short,interactionMode:short,speedMode:short,options:optionsArray},['threadId','message']) },
  { name:'t3_thread_wait',description:'Wait at most 120 seconds for a T3 turn; returns partial state on timeout.',inputSchema:schema({threadId,timeoutMs:{type:'integer',minimum:1,maximum:120000},detail:{type:'string',enum:['answers','messages','full']},maxChars:{type:'integer',minimum:1,maximum:20000}},['threadId']) },
  { name:'t3_thread_set',description:'Change a T3 thread provider, model, effort, permission, or mode.',inputSchema:schema({threadId,provider:short,model:short,thinkingEffort:short,permission:short,interactionMode:short,speedMode:short,options:optionsArray},['threadId']) },
  { name:'notify_owner',description:'Send a short notification to the owner through the configured ntfy alert path.',inputSchema:schema({text:{type:'string',maxLength:1000}},['text']) },
  { name:'list_tools',description:'Call this first to learn which tools you can use. Returns registry_version and each available tool with its description, input schema, class (read or write) and schema_hash.',inputSchema:schema({}) },
  { name:'call_tool_read',description:'Run an available read-only tool by name, as listed by list_tools. Pass its schema_hash from list_tools.',inputSchema:schema({tool:short,arguments:{type:'object',additionalProperties:true},schema_hash:hashField,idempotency_key:keyField},['tool','arguments']) },
  { name:'call_tool_write',description:'Run an available tool that changes state or sends something, by name, as listed by list_tools. Requires its schema_hash from list_tools and an idempotency_key that is new for each distinct request.',inputSchema:schema({tool:short,arguments:{type:'object',additionalProperties:true},schema_hash:hashField,idempotency_key:keyField},['tool','arguments','schema_hash','idempotency_key']) }
].filter(tool=>(catalogProfile!=='stable'||!['ask_question','consume_answer'].includes(tool.name))&&(t3ToolsEnabled||!tool.name.startsWith('t3_')));
// Opt-in compatibility catalog only; grant and lease enforcement are unchanged.
if(catalogProfile==='legacy-v46') {
  const names=new Set(['list_pending','claim','get','ack_message','progress','finish',
    'list_files','read_file','apply_patch','run_check','workspace_result','artifact_chunk']);
  for(let i=tools.length-1;i>=0;i--) if(!names.has(tools[i].name)) tools.splice(i,1);
  const claim=tools.find(tool=>tool.name==='claim');
  claim.description='Claim one immutable assignment and see available_checks before choosing run_check.check_id. With resume wake enabled, only a retry with the same claimant and acquisition_id receives the same active claim.';
  delete claim.inputSchema.properties.lease_ms;
  // The frozen v46 catalog predates optional summaries and the uncapped summary and note fields; the server still repairs them.
  const frozenProgress=tools.find(tool=>tool.name==='progress'),frozenFinish=tools.find(tool=>tool.name==='finish');
  frozenProgress.description='Append progress. Set blocker:true or start note with BLOCKED: or QUESTION: to forward a question to the owner thread.';
  frozenProgress.inputSchema.properties.note={type:'string',maxLength:4096};
  frozenFinish.description='Store a terminal worker report; completion is not owner acceptance.';
  frozenFinish.inputSchema.properties.summary={type:'string',maxLength:4096};
  frozenFinish.inputSchema.required=['request_id','claim_id','outcome','summary','result'];
  // The frozen v46 catalog predates list_files paging.
  const listing=tools.find(tool=>tool.name==='list_files');
  listing.description="List files in this assignment's checked-out repository workspace. Read-only; scoped to the assignment.";
  delete listing.inputSchema.properties.cursor;
  // The frozen v46 catalog predates the end_line and truncated result fields.
  tools.find(tool=>tool.name==='read_file').description="Read a file from this assignment's checked-out repository workspace. Read-only; scoped to the assignment.";
}
// Protocol fields are an explicit catalog release. Existing profiles retain their
// definitions byte for byte, including their argument validation.
if(catalogProfile==='protocol-v0') {
  tools.push({name:'renew_claim',description:'Renew a current protocol grant using a durable command key and expected revision. An exact retry returns the original deadline; expired grants cannot renew.',inputSchema:schema({request_id:string,claim_id:string,lease_ms:{type:'integer',minimum:1,maximum:store.limits.leaseMs}},['request_id','claim_id','lease_ms'])});
  const commands=new Set(['claim','progress','ask_question','consume_answer','finish','artifact_chunk','renew_claim']);
  for(const tool of tools) if(commands.has(tool.name)) Object.assign(tool.inputSchema.properties,{
    command_key:{type:'string',minLength:1,maxLength:512},
    expected_revision:{type:'integer',minimum:0},
    epoch:{type:'integer',minimum:1},
  });
  tools.find(tool=>tool.name==='artifact_chunk').inputSchema.properties.size={type:'integer',minimum:0};
}
// Catalog v2: MCP annotations and three fixed registry tools. The four T3 worker tools (create, send, wait, set) stay
// top-level tools, advertised only with DALAN_ENABLE_T3_TOOLS=1.
// legacy-v46 stays byte for byte. New abilities are registered tools behind call_tool_read and call_tool_write,
// never new tool names, descriptions or schemas.
const READ={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const WRITE=idempotentHint=>({readOnlyHint:false,destructiveHint:false,idempotentHint,openWorldHint:false});
const toolAnnotations={
  list_pending:READ,get:READ,list_files:READ,read_file:READ,workspace_result:READ,t3_thread_list:READ,t3_thread_read:READ,t3_thread_wait:READ,t3_thread_create:WRITE(false),t3_thread_send:WRITE(false),t3_thread_set:WRITE(true),list_tools:READ,call_tool_read:READ,call_tool_write:WRITE(false),
  claim:WRITE(true),ack_message:WRITE(true),progress:WRITE(false),ask_question:WRITE(true),consume_answer:WRITE(true),finish:WRITE(true),
  apply_patch:WRITE(false),run_check:WRITE(false),artifact_chunk:WRITE(true),renew_claim:WRITE(true),
  notify_owner:{...WRITE(false),openWorldHint:true},
};
if(catalogProfile!=='legacy-v46') for(const item of tools) {
  if(!toolAnnotations[item.name]) throw new Error(`tool ${item.name} has no annotations`);
  item.annotations={...toolAnnotations[item.name]};
}
// Hidden tools also stay out of validation, so knowing a name cannot bypass the profile.
const toolNames=new Set(tools.map(item=>item.name));
const disabled=new Set(['list_files','read_file','apply_patch','run_check','workspace_result','artifact_chunk']);
const readTools=new Set(['list_pending','get','list_files','read_file','workspace_result','list_tools','call_tool_read']);
const t3ReadTools=new Set(['t3_thread_list','t3_thread_read','t3_thread_wait']);
const t3Tools=new Set([...t3ReadTools,'t3_thread_create','t3_thread_send','t3_thread_set']);
const notifyTools=new Set(['notify_owner']);
// T3 tools use the existing scopes to preserve the current grant behavior.
const scopeFor=name=>t3ReadTools.has(name)||readTools.has(name)?'dalan.read':'dalan.work';
// Same name mapping as the protected-resource metadata and the 401 challenge, so all three surfaces agree.
const advertisedScope=name=>wireScope(scopeFor(name),legacyScopeNames(oauth));
if(oauth) for(const item of tools) item.securitySchemes=[{type:'oauth2',scopes:[advertisedScope(item.name)]}];
// A refusal that must stay tells the worker the next call and what to change; workers often do not retry a bare "invalid X".
const argumentFixes={
  finish:{
    result:'send result as 1 to 262144 bytes of text (put the verdict on the first line), then call finish again with the same claim_id',
    outcome:'outcome must be completed, blocked or failed; call finish again with one of them',
    artifact_ids:'artifact_ids must be at most 8 strings; call finish again with fewer ids',
    summary:'summary must be text; call finish again with a string or leave summary out'
  },
  progress:{note:'send note as 1 to 4096 bytes of text; call progress again with a shorter note'}
};
const SUMMARY_MAX=4096,NOTE_MAX=4096;
const clipWithMarker=(text,max,marker)=>`${Store.clipBytes(text,max-Buffer.byteLength(marker))}${marker}`;
// Fixable summary and note problems are repaired, not refused: the worker already has its result and may never retry.
// Returns the repaired arguments and the marks to put in the receipt. Anything not repairable is left for validate() to refuse.
function repairArguments(name,args) {
  const marks={};
  if(!args||typeof args!=='object'||Array.isArray(args)) return {args,marks};
  if(name==='progress'&&typeof args.note==='string'&&Buffer.byteLength(args.note)>NOTE_MAX) {
    marks.note_truncated=true;
    return {args:{...args,note:clipWithMarker(args.note,NOTE_MAX,' [note truncated]')},marks};
  }
  if(name!=='finish') return {args,marks};
  const given=args.summary;
  if(typeof given==='string'&&given.trim()) {
    if(Buffer.byteLength(given)<=SUMMARY_MAX) return {args,marks};
    marks.summary_truncated=true;
    return {args:{...args,summary:clipWithMarker(given,SUMMARY_MAX,' [summary truncated]')},marks};
  }
  if(given!==undefined&&typeof given!=='string') return {args,marks};
  const first=typeof args.result==='string'?args.result.split(/\r?\n/).map(line=>line.trim()).find(Boolean):undefined;
  if(!first) return {args,marks};
  marks.summary_derived=true;
  return {args:{...args,summary:Store.clipBytes(first,SUMMARY_MAX)},marks};
}
function validate(name,args) {
  const definition=tools.find(x=>x.name===name); if(!definition) throw new Error('unknown tool');
  const refuse=(kind,field)=>{
    const fix=argumentFixes[name]?.[field];
    // repairArguments already derives a missing summary, so a summary that is still missing means the result cannot supply one.
    if(name==='finish'&&field==='summary'&&kind==='missing') return new Error(`missing summary and no result to derive it from: ${argumentFixes.finish.result}`);
    return new Error(fix?`${kind} ${field}: ${fix}`:`${kind} ${field}`);
  };
  if(!args||typeof args!=='object'||Array.isArray(args)) throw new Error('invalid arguments');
  const s=definition.inputSchema;
  for(const field of Object.keys(args)) if(!Object.hasOwn(s.properties,field)) throw new Error(`unknown field ${field}`);
  for(const field of s.required) if(!Object.hasOwn(args,field)) throw refuse('missing',field);
  // The schema no longer requires summary, but one must exist by now: repairArguments could not derive it when the result is blank.
  if(name==='finish'&&(args.summary===undefined||typeof args.summary==='string'&&!args.summary.trim())) throw refuse('missing','summary');
  for(const [field,value] of Object.entries(args)) {
    const rule=s.properties[field];
    if(rule.type==='string'&&value===''&&argumentFixes[name]?.[field]) throw refuse('invalid',field);
    if(rule.type==='string'&&(typeof value!=='string'||Buffer.byteLength(value)> (rule.maxLength||256*1024))) throw refuse('invalid',field);
    if(rule.type==='integer'&&(!Number.isInteger(value)||(rule.minimum!==undefined&&value<rule.minimum)||(rule.maximum!==undefined&&value>rule.maximum))) throw refuse('invalid',field);
    if(rule.type==='boolean'&&typeof value!=='boolean') throw refuse('invalid',field);
    if(rule.type==='object'&&(!value||typeof value!=='object'||Array.isArray(value))) throw refuse('invalid',field);
    if(rule.type==='array'&&(!Array.isArray(value)||value.length>rule.maxItems||value.some(x=>typeof x!=='string'))) throw refuse('invalid',field);
    if(rule.enum&&!rule.enum.includes(value)||rule.pattern&&!new RegExp(rule.pattern).test(value)) throw refuse('invalid',field);
  }
}
// A waiter is only a live HTTP response. Its actual attention event remains in
// `notifications` until that response completes, so a disconnect falls back to
// the existing durable T3 delivery path.
const waiters=new Map();
function artifactIdsFor(requestId, report) {
  const ids=new Set(store.db.prepare("SELECT id FROM artifacts WHERE request_id=? AND sealed=1 ORDER BY id").all(requestId).map(row=>row.id));
  const evidence=report?.workspace_evidence;
  if(evidence?.patch_artifact?.artifact_id) ids.add(evidence.patch_artifact.artifact_id);
  for(const artifact of evidence?.artifacts??[]) if(artifact?.id) ids.add(artifact.id);
  for(const check of evidence?.checks??[]) if(check?.output_artifact_id) ids.add(check.output_artifact_id);
  return [...ids];
}
function waitSummary(requestId, attention=null) {
  const row=store.get(requestId);
  const body=attention?.body?JSON.parse(attention.body):null, note=body?.note??null;
  // A usage-break notice: the request stays queued; the owner may do it elsewhere or wait again.
  if(body?.break_id) return {status:'worker_break',report_summary:null,blocker_text:null,notice:maskText(note),request_ids:body.request_ids,artifact_ids:[]};
  const status=row.status==='finished'?'finished':row.status==='cancelled'?'cancelled':/^\s*QUESTION:/im.test(note??'')?'question':'blocker';
  const failure=store.failureFields(requestId);
  return {status,report_summary:maskText(row.report?.summary??null),blocker_text:maskText(note),artifact_ids:artifactIdsFor(requestId,row.report),...(status==='cancelled'&&row.cancelled_reason?{cancelled_reason:row.cancelled_reason}:{}),failure_type:failure.failure_type,failure_type_source:failure.failure_type_source,...(failure.failure_type==='expired'?{expired:true}:{})};
}
function notifyAttachedWaiter(requestId) {
  const waiter=waiters.get(requestId);
  if(!waiter) return false;
  const attention=store.claimWaiterDelivery(requestId,waiter.cursor);
  if(!attention) return false;
  waiters.delete(requestId);
  clearTimeout(waiter.timer);
  let settled=false;
  const release=()=>{
    if(settled) return;
    settled=true;
    store.releaseWaiterDelivery(attention.id);
    runDrain();
  };
  waiter.res.once('close',release);
  waiter.res.socket?.once('close',release);
  waiter.res.once('finish',()=>{
    if(settled) return;
    settled=true;
    store.settleWaiterDelivery(attention.id,waiter.consume);
  });
  const respond=()=>{ if(!settled) { store.recordFetched(requestId);json(waiter.res,200,waitSummary(requestId,attention)); } };
  const responseDelay=Number(readEnv('DALAN_WAIT_RESPONSE_DELAY_MS')||0);
  if(Number.isInteger(responseDelay)&&responseDelay>0&&responseDelay<=10000) setTimeout(respond,responseDelay);
  else respond();
  return true;
}
// Cancel queued assignments whose preparation expired (Store.sweepExpired) and answer an attached owner waiter as /cancel does.
// This timer is independent of delivery so pause and slow destinations cannot hold expiry work.
function sweepExpired() {
  const ids=store.sweepExpired();
  if(ids.length) log({kind:'assignments_expired',count:ids.length,request_ids:ids.slice(0,20)});
  if(ids.requeued?.length) log({kind:'assignments_expired_requeued',count:ids.requeued.length,request_ids:ids.requeued.slice(0,20)});
  for(const requestId of ids) { const waiter=waiters.get(requestId); if(waiter) { waiters.delete(requestId); clearTimeout(waiter.timer); json(waiter.res,200,waitSummary(requestId)); } }
  return ids;
}
// Cancel queued assignments the worker skipped for DALAN_SKIP_EXPIRE_HOURS (Store.sweepSkipped), so the sender sees the reason.
function sweepSkipped() {
  const ids=store.sweepSkipped();
  if(ids.length) log({kind:'skip_expired',count:ids.length,request_ids:ids.slice(0,20)});
  for(const requestId of ids) { const waiter=waiters.get(requestId); if(waiter) { waiters.delete(requestId); clearTimeout(waiter.timer); json(waiter.res,200,waitSummary(requestId)); } }
  return ids;
}
// Abandon claims whose lease ran out (Store.sweepStaleLeases): the row is requeued and its lane is free.
function sweepStaleLeases() {
  const ids=store.sweepStaleLeases();
  if(ids.length) log({kind:'claims_lease_expired',count:ids.length,request_ids:ids.slice(0,20)});
  return ids;
}
const destinations=createDestinations({store,ackLedger,notify:notifyAttachedWaiter,log,crashAt,exit:code=>process.exit(code)});
async function attachWaiter(req,res,requestId,timeoutMs,consume=true) {
  const immediate=store.get(requestId);
  if(['finished','cancelled'].includes(immediate.status)) { store.recordFetched(requestId);if(consume) store.recordConsumed(requestId,'wait'); return json(res,200,waitSummary(requestId)); }
  if(waiters.has(requestId)) return json(res,409,{error:'waiter already attached'});
  const queueBlocker=queuedRepositoryBlocker(immediate);
  if(queueBlocker) return json(res,200,{status:'blocker',report_summary:null,blocker_text:queueBlocker.message,artifact_ids:[],queue_blocker:queueBlocker});
  // `none` has no fallback delivery channel, so a newly attached waiter must
  // also observe attention recorded before it attached.
  const destination=await destinations.for(immediate.delivery_mode);
  const waiter={res,timer:null,consume,cursor:immediate.delivery_mode==='none'||destination.quietReason(immediate)?0:store.deliveryCursor(requestId)};
  const detach=()=>{
    if(waiters.get(requestId)!==waiter) return;
    waiters.delete(requestId);
    clearTimeout(waiter.timer);
  };
  req.once('aborted',detach);
  res.once('close',detach);
  waiter.timer=setTimeout(()=>{
    if(waiters.get(requestId)!==waiter) return;
    waiters.delete(requestId);
    let blocker=null;
    try { blocker=queuedRepositoryBlocker(store.get(requestId)); } catch { /* the request may have expired while waiting */ }
    json(res,200,blocker?{status:'blocker',report_summary:null,blocker_text:blocker.message,artifact_ids:[],queue_blocker:blocker}:{status:'timeout',report_summary:null,blocker_text:null,artifact_ids:[]});
  },timeoutMs);
  waiter.timer.unref();
  waiters.set(requestId,waiter);
  notifyAttachedWaiter(requestId);
}
// Result guidance only; tool descriptions stay fixed.
const listGuidance='Claim every listed assignment you can start now, up to free_lanes, in this turn. Do not claim one and stop. Never exceed free_lanes.';
const claimMoreGuidance='If free_lanes > 0 and work is queued, claim more now.';
// A finishing lane takes the next queued item itself; an error on any claim means the list changed, so list again.
const finishNextGuidance=next=>`Claim ${next[0].request_id} yourself before you end this run, then keep claiming up to free lanes. After any claim error such as assignment_expired, call list_pending and claim from that list.`;
// A loader failure carries host paths or quotes the file. Every caller of this policy gets the Store's fixed error instead.
function repoPolicyFor(assignment) {
  try { return currentRepoPolicy(); }
  catch(error) { throw store.destinationConfigurationError(assignment?.request_id??null,error); }
}
// An exact retry of a live grant is not a new grant. A repository edit after the grant must not strand its holder,
// the same rule that lets a live grant finish after revocation. The Store still checks the holder's connection
// and approved connection set, and refuses anything that is not that exact retry.
function holdsLiveGrant(worker,requestId,claimant,subject,acquisitionId) {
  const held=store.db.prepare("SELECT * FROM claims WHERE request_id=? AND state='active'").get(requestId);
  return held?.worker===worker&&store.isExactClaimRetry(held,claimant,subject,acquisitionId??null);
}
function queuedRepositoryBlocker(row) {
  if(row.status!=='queued') return null;
  const repo=row.assignment?.inputs?.find(input=>input?.github_repo!==undefined)?.github_repo;
  if(!repo) return null;
  const worker=row.target_worker??'dot';
  try {
    if(repoPolicyFor(row.assignment).allowsRepo(worker,repo)) return null;
  } catch {
    return {code:'repository_policy_unavailable',message:'Repository access policy is unavailable. Check the bridge worker configuration.'};
  }
  return {code:'repository_policy_denied',message:`Repository ${repo} is not allowed for worker "${worker}". Grant it with dalan worker allow ${worker} ${repo}, or cancel the job.`};
}
function assertRepoAllowed(worker,assignment) {
  const inputs=assignment?.inputs;
  if(!Array.isArray(inputs)||!inputs.some(input=>input?.github_repo!==undefined)) return;
  const policy=repoPolicyFor(assignment);
  if(inputs.length!==1) throw new Error('one repository input per job');
  if(typeof inputs[0]?.github_repo!=='string'||!policy.allowsRepo(worker,inputs[0].github_repo)) {
    const repo=typeof inputs[0]?.github_repo==='string'?inputs[0].github_repo:'(invalid repository)';
    throw new Error(`repository ${repo} is not allowed for worker "${worker}"; update it with dalan worker allow ${worker} OWNER/REPO, or choose another worker${!fs.existsSync(workersFile)?'; no workers.json: see docs/operations.md#legacy-repository-policy-migration':''}`);
  }
}
// Record the call on the claim it names (one UPDATE); a thrown error or a structured {error} result is kept as the last tool error.
async function tool(name,a,principal,notifyMeta) {
  if(name==='claim'&&typeof a?.request_id==='string'&&store.hasAssignment(a.request_id)&&store.mayAct(principal.worker,a.request_id)&&
    !holdsLiveGrant(principal.worker,a.request_id,a.claimant,principal.subject,a.acquisition_id)) {
    assertRepoAllowed(principal.worker,store.get(a.request_id).assignment);
  }
  let error=null;
  try {
    const result=await dispatchTool(name,a,principal,notifyMeta);
    if(typeof result?.error==='string') error=redactNote(result.error);
    return result;
  } catch(e) { error=redactNote(String(e?.message??e)); if(e.destination&&typeof a?.request_id==='string')notifyAttachedWaiter(a.request_id); throw e; }
  finally {
    const rid=a?.request_id;
    if(typeof rid==='string'&&rid!==absentId&&toolNames.has(name)&&!t3Tools.has(name)&&!notifyTools.has(name)) {
      try { store.recordToolActivity(rid,principal.subject,principal.worker,name,{workspace:disabled.has(name),error,connectionId:principal.builtin?(principal.connection_id??''):null}); } catch { /* activity is diagnostic; never fail the call */ }
    }
  }
}
async function dispatchTool(name,a,principal,notifyMeta) {
  const t3Audit=(t3Tools.has(name)||notifyTools.has(name))?await loadT3Audit():null;
  if(t3Audit) t3Audit.admitT3Audit(store.db,principal.worker,principal.subject);
  store.recordWorkerCall(principal.subject,toolNames.has(name)?name:'unknown',principal.worker);
  sweepExpired();
  if(t3Tools.has(name)||notifyTools.has(name)) {
    // Denials carry only verified identity, tool and a fixed reason. Never prepare
    // an argument-bearing audit until capability, scope and schema all pass.
    let denial='worker_capability_denied',notificationKey;
    try {
      if(!hasCapability(workers,principal.worker,'t3')) throw new Error(denial);
      denial='insufficient_scope';
      if(oauth) needScope(principal,scopeFor(name));
      denial='invalid_arguments';
      validate(name,a);
      if(notifyTools.has(name)) notificationKey=notifyKey(notifyMeta);
    } catch(error) {
      t3Audit.appendT3Audit(store.db,t3Audit.prepareT3Audit(name,{},principal.worker),principal.subject,`denied: ${denial}`);
      throw error;
    }
    const audit=t3Audit.prepareT3Audit(name,a,principal.worker);
    t3Audit.appendT3Audit(store.db,audit,principal.subject,'started');
    try {
      if((name==='t3_thread_list'||name==='t3_thread_read')&&t3ReadToolsOff()) {
        t3Audit.appendT3Audit(store.db,audit,principal.subject,'blocked: t3_read_tools=off');
        log({kind:'t3_read_tool_blocked',tool:name,subject:principal.subject,call_id:audit.call_id});
        return T3_READ_TOOLS_OFF;
      }
      const result=notifyTools.has(name) ? await notifyLedger.send(principal.worker,str(a.text,'text',1000),notificationKey,idempotencyKey=>publishAlert('Dalan message',a.text,log,{requirePublisher:true,idempotencyKey})) : await (await import('./t3-control.mjs')).runT3Tool(name,a);
      t3Audit.appendT3Audit(store.db,audit,principal.subject,'success',result);
      if(result && typeof result==='object' && Object.hasOwn(result,'_audit_ids')) { const {_audit_ids,...publicResult}=result; return publicResult; }
      return result;
    } catch(error) {
      t3Audit.appendT3Audit(store.db,audit,principal.subject,`error: ${redactSinkText(error.message).slice(0,300)}`);
      throw error;
    }
  }
  const worker=principal.worker;
  if(a&&typeof a==='object') {
    if(typeof a.request_id==='string'&&!store.mayAct(worker,a.request_id)) a={...a,request_id:absentId};
    if(typeof a.message_id==='string'&&!store.mayAct(worker,a.message_id)) a={...a,message_id:absentId};
  }
  const repaired=repairArguments(name,a);
  a=repaired.args;
  validate(name,a);
  if(oauth) needScope(principal,scopeFor(name));
  if(disabled.has(name)&&!workspaceEnabled) throw new Error('capability_not_enabled');
  if(a.request_id===absentId&&disabled.has(name)) throw new Error('assignment not found');
  const subject=principal.subject,connectionId=principal.builtin?(principal.connection_id??''):null;
  const strictJob=typeof a.request_id==='string'&&store.isProtocolJob(a.request_id);
  if(strictJob&&catalogProfile!=='protocol-v0') throw new Error('protocol jobs require DALAN_CATALOG_PROFILE=protocol-v0');
  if(strictJob)store.assertProtocolAvailable(a.request_id);
  // Strict commands validate authority, replay and revision in their transaction.
  // The legacy implicit touch would mutate activity before a rejected CAS.
  if(!strictJob&&typeof a.request_id==='string'&&typeof a.claim_id==='string'&&store.hasAssignment(a.request_id)) store.touchClaim(a.request_id,a.claim_id,subject,worker,connectionId);
  // Workspace tools (every one, reads included) refuse any caller but the live holding connection. Native jobs skip the implicit
  // touch above, so this is their only check; legacy jobs get a second, post-await check. It runs synchronously right before
  // the tool body, after the tool's last await, so no revoke can land between the check and the write.
  const workspaceFence=()=>{ if(typeof a.claim_id==='string'&&typeof a.request_id==='string')store.assertWorkerConnection(a.request_id,a.claim_id,subject,worker,connectionId); };
  const commandContext=(operation,args)=>{
    if(!strictJob) return undefined;
    if(typeof a.command_key!=='string'||!a.command_key.length||a.command_key.length>512) throw new Error('command_key required for protocol job');
    if(!Number.isSafeInteger(a.expected_revision)||a.expected_revision<0) throw new Error('expected_revision required for protocol job');
    return {key:a.command_key,revision:a.expected_revision,operation,args,...(a.epoch===undefined?{}:{epoch:a.epoch})};
  };
  switch(name) {
    case 'list_tools': return toolRegistry.listTools(worker);
    case 'call_tool_read': case 'call_tool_write': {
      // The registry owns policy: grants, class match, argument validation, rate limits and audit.
      try { return (await toolRegistry.callTool({worker,tool:a.tool,class:name==='call_tool_read'?'read':'write',args:a.arguments,schema_hash:a.schema_hash,idempotency_key:a.idempotency_key})).result; }
      catch(e) { if(e instanceof RegistryError) throw new Error(e.message.startsWith(e.code)?e.message:`${e.code}: ${e.message}`); throw e; }
    }
    case 'list_pending': {
      const {free_lanes}=store.laneState(subject,worker,redeliveryLimits.laneCapacity,claimCapacity);
      const assignments=store.listPending(worker);
      store.recordListed(assignments,free_lanes,worker);
      log({kind:'list_pending_result',subject,free_lanes,total:assignments.length,request_ids:assignments.slice(0,20).map(x=>x.request_id)});
      const guidance=workers.workers.get(worker)?.guidance==='resume'?`${listGuidance} ${resumeNudge(store.resumeIdleMs()||undefined)}`:listGuidance;
      // Say outright whether a claim would be accepted now: a worker that once saw a pause refusal must not keep listing without claiming.
      const claims_accepted=!store.paused();
      const next=claims_accepted?store.nextQueued(free_lanes,null,worker):{};
      const claimsNote=claims_accepted?'':'Claims are paused (temporary): do not claim now; call list_pending again later and claim once claims_accepted is true.';
      return {assignments,attention:store.attention(subject,worker),free_lanes,claims_accepted,...(claims_accepted?next:{next_action:claimsNote}),guidance};
    }
    case 'claim': {
      const requestId=id(a.request_id),claimant=str(a.claimant,'claimant',128),ctx=commandContext('claim',{claimant,acquisition_id:a.acquisition_id??null,lease_ms:a.lease_ms??null}),row=store.get(requestId),held=row.claim?.state==='active'?row.claim:null,retry=holdsLiveGrant(worker,requestId,claimant,subject,a.acquisition_id);
      if(!retry)assertRepoAllowed(worker,row.assignment);
      store.refuseExpired(requestId);
      // Retry a successful claim without a new remote dependency, and skip it for a live rival claim that the Store will refuse.
      // A fresh claim, a claim after abandon and an expired-lease takeover are each a new admission. The Store
      // still validates claimant, subject, lease, cancellation and capacity atomically.
      const admission=!store.paused()&&(row.status==='queued'||row.status==='claimed'&&held&&!(held.claimant===claimant&&held.subject===subject)&&store.leaseExpired(held));
      const preflight=admission?await preflightPR(row.assignment):null;
      if(!retry)assertRepoAllowed(worker,row.assignment);
      const prior=store.db.prepare('SELECT * FROM claims WHERE request_id=?').get(requestId);
      if(prior&&store.leaseExpired(prior)&&(!strictJob||store.protocolRevision(requestId)===ctx.revision)) await workspace?.quiesce(requestId);
      // Store revalidates after the await: a concurrent claimant may have won.
      // Built-in mode only: re-check inside the claim transaction that the
      // claimant's own connection is still live. The token was verified before
      // the awaited preflight/quiesce above, so a revoke in between must not
      // admit the claim. External-OAuth principals pass null and are unchanged.
      const claimed=store.claim(requestId,claimant,subject,claimCapacity,preflight,worker,a.acquisition_id,a.lease_ms,ctx,principal.builtin?(principal.connection_id??''):null);
      const grant=store.db.prepare('SELECT * FROM claims WHERE request_id=?').get(requestId);
      const {free_lanes,queued}=store.laneState(subject,worker,redeliveryLimits.laneCapacity,claimCapacity);
      return withAvailableChecks({...claimed,lease_expires_at:claimed.lease_expires_at??store.leaseExpiresAt(grant),queued_after_claim:queued,free_lanes,...store.nextQueued(free_lanes,requestId,worker),guidance:`${claimed.guidance} ${claimMoreGuidance}`},true,worker,subject);
    }
    case 'renew_claim': {
      if(!strictJob) throw new Error('renew_claim requires a protocol job');
      return store.renewClaim(id(a.request_id),id(a.claim_id,'claim_id'),a.lease_ms,commandContext('renew',{leaseMs:a.lease_ms}),subject,worker,connectionId);
    }
    case 'get': { const requestId=id(a.request_id); if(!store.hasAssignment(requestId)) return {kind:'message',message:store.getMessage(requestId,worker)}; store.markNotesSeenByHolder(requestId,subject,worker,connectionId); return {...publicWorkerGet(withAvailableChecks(store.get(requestId),true,worker,subject)),guidance:store.guidanceFor(worker)}; }
    case 'ack_message': {const message=store.ackMessage(id(a.message_id,'message_id'),worker);log({kind:'message_acknowledged',message_id:message.message_id});return {kind:'message',message};}
    case 'progress': {
      const requestId=id(a.request_id),note=str(a.note,'note',4096),receipt=store.progress(requestId,id(a.claim_id,'claim_id'),note,subject,a.blocker===true,worker,null,commandContext('progress',{note,blocker:a.blocker===true}),connectionId);
      notifyAttachedWaiter(requestId);
      return {...receipt,...repaired.marks};
    }
    case 'ask_question': {
      const requestId=id(a.request_id),question=str(a.question_id,'question_id',128),text=str(a.text,'text',4096),receipt=store.askQuestion(requestId,id(a.claim_id,'claim_id'),question,text,subject,worker,commandContext('ask_question',{question,text}),connectionId);
      notifyAttachedWaiter(requestId);
      return receipt;
    }
    case 'consume_answer': return store.consumeAnswer(id(a.request_id),id(a.claim_id,'claim_id'),str(a.question_id,'question_id',128),subject,worker,commandContext('consume',{question_id:a.question_id}),connectionId);
    case 'finish':
      { const requestId=id(a.request_id),claimId=id(a.claim_id,'claim_id');
        store.assertFinishClaim(requestId,claimId,subject,worker);
        // A replaced or revoked connection learns connection_not_live before any question or artifact error. Read-only; expired and foreign claims return early.
        workspaceFence();
        const existing=store.db.prepare('SELECT 1 FROM reports WHERE request_id=?').get(requestId);
        let captureEvidence=null;
        if(!existing) {
          store.assertQuestionsResolved(requestId,claimId,a.outcome);
          if(a.artifact_ids?.length) { if(!workspaceEnabled) throw new Error('capability_not_enabled'); store.assertSealedArtifacts(requestId,claimId,a.artifact_ids); }
          const request=store.get(requestId);
          if(workspaceEnabled) await workspace.makeRoom(requestId);
          // Recheck after the last await. The evidence capture below runs inside the finish transaction, after finishOnce's own
          // connection check, so a patch artifact is never committed for a holder that lost the connection.
          workspaceFence();
          if(workspaceEnabled&&request.status==='claimed'&&(request.assignment.execution_scope==='implementation'||request.assignment.output_paths?.length))
            captureEvidence=onRollback=>workspace.snapshotInTransaction(requestId,claimId,subject,worker,onRollback);
          if(request.status==='claimed'&&request.assignment.execution_scope==='read-only') {
            const archiveWorkspace=workspace??new Workspace(store,false),snapshot=captureEvidence;
            captureEvidence=onRollback=>{
              const base=snapshot?snapshot(onRollback):null;
              const archive=captureOwnerReportArtifact(store,archiveWorkspace,{requestId,claimId,outcome:a.outcome,summary:a.summary,result:a.result,onRollback});
              return archive?{...(base??{}),owner_report_artifact:archive}:base;
            };
          }
        }
        const receipt=store.finish(requestId,claimId,a.outcome,str(a.summary,'summary',4096),str(a.result,'result',256*1024),subject,null,worker,commandContext('finish',{artifact_ids:a.artifact_ids??[]}),captureEvidence,connectionId);
        if(crashAt('after_report_persistence',a.request_id)) process.exit(73);
        notifyAttachedWaiter(requestId);
        if(repaired.marks.summary_derived||repaired.marks.summary_truncated) log({kind:'finish_summary_repaired',request_id:requestId,...repaired.marks});
        const marked={...receipt,...repaired.marks};
        return receipt.next_queued?.length&&!store.paused()?{...marked,guidance:finishNextGuidance(receipt.next_queued)}:marked; }
    case 'list_files': await workspace.makeRoom(id(a.request_id));workspaceFence();return workspace.list(id(a.request_id),id(a.claim_id,'claim_id'),subject,a.path,a.limit??200,worker,a.cursor);
    case 'read_file': await workspace.makeRoom(id(a.request_id));workspaceFence();return workspace.read(id(a.request_id),id(a.claim_id,'claim_id'),subject,a.path,a.start_line??1,a.max_lines??200,worker);
    case 'apply_patch': await workspace.makeRoom(id(a.request_id));workspaceFence();return workspace.apply(id(a.request_id),id(a.claim_id,'claim_id'),subject,a.patch,worker);
    case 'run_check': await workspace.makeRoom(id(a.request_id));workspaceFence();return workspace.check(id(a.request_id),id(a.claim_id,'claim_id'),subject,a.check_id,worker);
    case 'artifact_chunk': return strictJob?protocolArtifactChunk(store,workspace,{requestId:id(a.request_id),claimId:id(a.claim_id,'claim_id'),subject,worker,artifactId:a.artifact_id,offset:a.offset,base64:a.data_base64,final:a.final,expected:a.sha256,expectedSize:a.size,connectionId},commandContext(a.final?'seal':'upload',{})):workspace.chunk(id(a.request_id),id(a.claim_id,'claim_id'),subject,a.artifact_id,a.offset,a.data_base64,a.final,a.sha256,worker);
    case 'workspace_result': workspaceFence();return workspace.result(id(a.request_id),id(a.claim_id,'claim_id'),subject,worker);
  }
}
function subId(url,subject,worker) { const identity=worker==='dot'?subject:`${subject}\0${worker}`;return 'sub_' + createHash('sha256').update(`${identity}\0${url}\0assignment.available\0{}`).digest('hex').slice(0, 32); }
function validEventParams(p) { return p.name === 'assignment.available' && JSON.stringify(p.arguments ?? {}) === '{}' && p.delivery?.mode === 'webhook'; }
async function subscribe(p,principal) {
  if (!validEventParams(p)) throw new Error('invalid subscription');
  const url = str(p.delivery.url, 'url', 2048), signingSecret=p.delivery.secret;
  if (!validSecret(signingSecret)) throw new Error('invalid signing secret');
  const sub=subId(url,principal.subject,principal.worker),challenge=randomBytes(24).toString('base64url');
  try {
    const response=await sendWebhook(url,signingSecret,`msg_verification_${randomUUID()}`,sub,JSON.stringify({type:'verification',challenge}));
    const received=JSON.parse(response.body).challenge;
    const left=Buffer.from(challenge),right=Buffer.from(received||'');
    if(response.status<200||response.status>=300||left.length!==right.length||!timingSafeEqual(left,right)) throw new Error('challenge_failed');
  } catch(error) {
    log({kind:'verification_failed',subscription_id:sub,reason:error.message});
    const e=new Error('CallbackEndpointError'); e.code=-32015; e.data={reason:error.message==='challenge_failed'?'challenge_failed':error.message==='timeout'?'timeout':'callback_error'}; throw e;
  }
  const ttl=Math.min(Number.isFinite(p.ttlMs)?Math.max(60000,p.ttlMs):7*86400000,7*86400000),expires=new Date(Date.now()+ttl).toISOString();
  const connection=principal.builtin
    ? {issuer:principal.issuer,connection_id:principal.connection_id,builtin:true,connection:principal.connection}
    : {issuer:principal.issuer,subject:principal.subject,client_id:principal.client_id,connection_id:principal.connection_id,local:principal.local};
  store.subscribe(sub,url,signingSecret,expires,principal.subject,principal.worker,connection);
  return {id:sub,refreshBefore:expires,cursor:null,truncated:p.cursor!=null};
}
// Errors written by Dalan reach the client redacted; a crash returns only what failed and an error id, and the
// redacted detail goes to the request log.
function publicErrorText(error,what) {
  if(!isCrash(error)) return redactSinkText(error.message);
  const errorId=randomUUID().slice(0,8);
  log({kind:'request_error',what,error_id:errorId,detail:safeDiagnostic(error?.stack??error,4000)});
  return `Error executing ${what} (error id ${errorId}; details are in the request log)`;
}
async function dispatch(message,principal) {
  const p=message.params??{};
  switch(message.method) {
    case 'server/discover': return {ttlMs:0,cacheScope:'private',supportedVersions:['2026-07-28'],capabilities:{tools:{},events:{}},_meta:{'io.modelcontextprotocol/serverInfo':serverInfo}};
    case 'initialize': return {protocolVersion:['2025-11-25','2025-06-18','2025-03-26','2024-11-05'].includes(p.protocolVersion)?p.protocolVersion:'2025-11-25',capabilities:{tools:{},events:{}},serverInfo};
    case 'ping': return {};
    case 'tools/list': return {ttlMs:0,cacheScope:'private',tools:tools.filter(t=>!(t3Tools.has(t.name)||notifyTools.has(t.name))||hasCapability(workers,principal.worker,'t3'))};
    case 'tools/call': { try { return {content:[{type:'text',text:JSON.stringify(redactOutput(await tool(p.name,p.arguments??{},principal,notifyTools.has(p.name)?p._meta:undefined)))}],isError:false}; } catch(e) { const error={content:[{type:'text',text:publicErrorText(e,`tool ${toolNames.has(p.name)?p.name:'unknown'}`)}],isError:true};if(oauth&&e.message==='insufficient_scope')error._meta={'mcp/www_authenticate':[[challenge(oauth,scopeFor(p.name)),'error="insufficient_scope"','error_description="Required scope is missing"'].join(', ')]};return error; } }
    case 'events/list': return {events:[event]};
    case 'events/subscribe': if(oauth)needScope(principal,'dalan.read');return subscribe(p,principal);
    case 'events/unsubscribe': { if(oauth)needScope(principal,'dalan.read');if(!validEventParams(p)) throw new Error('invalid subscription'); store.unsubscribe(subId(p.delivery.url,principal.subject,principal.worker)); return {}; }
    default: throw Object.assign(new Error('method not found'),{code:-32601});
  }
}
const publicServer=(as?createBuiltinHttpServer:http.createServer)(async(req,res)=>{
  const outcome=req.url===publicPath?beginMcpOutcome(req,res,log,toolNames,!!oauth):null;
  try {
    if(loopback && !loopbackRequestAllowed(req, `http://127.0.0.1:${port}`)) { log({kind:'mcp_inbound',status:403,route:'loopback'}); res.writeHead(403); res.end(); return; }
    // Built-in mode serves only its configured host, which also blocks DNS rebinding of the loopback listener.
    if(as&&!as.hostOk(req)) { log({kind:'mcp_inbound',status:421,route:'host'}); res.writeHead(421); res.end(); return; }
    if(!as && req.url==='/.well-known/oauth-protected-resource' && oauthMetadata && req.method==='GET') return json(res,200,protectedResource(oauthMetadata));
    // RFC 9728 / MCP auth: clients first try metadata suffixed with the MCP path, whose resource is the exact MCP URL.
    if(req.url===`/.well-known/oauth-protected-resource${publicPath}` && oauthMetadata && req.method==='GET') { if(as)res.setHeader('Cache-Control','no-store'); return json(res,200,protectedResource(oauthMetadata,new URL(publicPath,oauthMetadata.OAUTH_AUDIENCE).href)); }
    if(signal&&signal.handle(req,res)) return;
    if(as&&await as.handle(req,res)) return;
    if(req.url!==publicPath) { log({kind:'mcp_inbound',status:404,route:'other',http_method:req.method,path_shape:pathShape(req.url),auth_header_present:(req.headers.authorization??'').startsWith('Bearer ')}); res.writeHead(404); res.end(); return; }
    let principal={local:true,subject:'local-principal',scopes:new Set(ADVERTISED_SCOPES)};
    if(oauth) { try { principal=as?await as.verifyBearer(req.headers.authorization,outcome.state):await verifyBearer(req.headers.authorization,oauth,outcome.state); } catch { res.writeHead(401,{'WWW-Authenticate':challenge(oauth)});res.end();return; } }
    try { principal.worker=resolveWorker(workers,principal); } catch(error) {
      outcome.state.auth_reason=error.code??'unknown_connection';
      log({kind:'connection_denied',reason:error.code??'unknown_connection',client_id:principal.client_id??null});
      res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({error:error.code??'unknown_connection'}));return;
    }
    outcome.state.phase='body';
    const body=await readBody(req,outcome.state);
    if(req.method!=='POST') { res.writeHead(405,{allow:'POST'}); res.end(); return; }
    outcome.state.phase='parse';
    let rpc; try { rpc=JSON.parse(body); } catch { return json(res,400,rpcError(null,-32700,'Parse error')); }
    if(!rpc||typeof rpc!=='object'||Array.isArray(rpc)||rpc.jsonrpc!=='2.0'||typeof rpc.method!=='string') return json(res,400,rpcError(rpc?.id??null,-32600,'Invalid Request'));
    outcome.identify(rpc);
    // Metadata only: bodies can carry webhook secrets and worker results.
    log({kind:'mcp_inbound',call_id:outcome.state.call_id,rpc_method:outcome.state.rpc_method,tool:outcome.state.tool});
    if(!Object.hasOwn(rpc,'id')) { res.writeHead(202); res.end(); return; }
    outcome.state.phase='dispatch';
    try { json(res,200,{jsonrpc:'2.0',id:rpc.id,result:{resultType:'complete',...await dispatch(rpc,principal)}}); }
    catch(e) { json(res,200,rpcError(rpc.id,e.code||-32602,publicErrorText(e,'request'),e.data)); }
    // Response-byte accounting for the throttle and the break ledger; the response is already written, so a failure only logs.
    if(outcome.state.tool) try { store.recordResponseBytes(principal.subject,outcome.state.tool,outcome.state.response_bytes,principal.worker); } catch(e) { log({kind:'response_bytes_error',call_id:outcome.state.call_id,reason:e.message}); }
  } catch(e) { const errorType=e.message==='body too large'?'body_too_large':req.aborted?'request_aborted':'request_error';if(outcome)outcome.state.error_type=errorType;log({kind:'inbound_error',call_id:outcome?.state.call_id,error_type:errorType}); if(!res.headersSent&&!res.destroyed) json(res,400,rpcError(null,-32700,publicErrorText(e,'request'))); }
});
const adminServer=http.createServer(async(req,res)=>{
  // A refused submit is logged with its reason so the owner can distinguish rejected requests from stored assignments.
  const requestStartedAt=Date.now();
  let rejected=null, dryRequested=false;
  try {
    const raw=req.method==='POST'?await readBody(req):'',body=raw?JSON.parse(raw):{},url=new URL(req.url,'http://localhost');
    if(url.pathname.startsWith('/protocol/service/')) {
      if(!protocolServices||req.method!=='POST')return json(res,404,{error:'not found'});
      return json(res,200,await protocolServices.invoke(url.pathname.slice('/protocol/service/'.length),req.headers['x-protocol-service-capability'],body));
    }
    dryRequested=url.pathname==='/submit-preview';
    log({kind:'admin_call',route:url.pathname,method:req.method});
    if(url.pathname==='/submit'&&(url.searchParams.get('dry_run')==='1'||body.dry_run===true)) throw new Error('dry run requires POST /submit-preview; /submit always submits');
    if(url.pathname==='/submit'||url.pathname==='/submit-preview') {
      // Set before any check below, so every refusal carries typed reasons, answers a dry run with a verdict and is logged.
      // Cohort labels can contain private values; logs need equality, not their contents.
      const labelDigest=value=>typeof value==='string'&&value.trim()?createHash('sha256').update(value.trim()).digest('hex'):null;
      rejected={request_id:typeof body.assignment?.request_id==='string'?body.assignment.request_id.slice(0,128):null,task_kind:body.meta?.task_kind??null,source:body.meta?.source??null,objective_key_sha256:labelDigest(body.meta?.objective_key),revision_sha256:labelDigest(body.meta?.revision)};
      if(body.assignment?.request_id===absentId) throw new Error('invalid assignment');
      const commandKey=body.command_key===undefined?null:body.command_key;
      const supersedes=body.supersedes===undefined?null:body.supersedes;
      const destinationRevision=body.destination_revision??null;
      if(body.destination_revision!==undefined&&(typeof destinationRevision!=='string'||!/^sha256:[a-f0-9]{64}$/.test(destinationRevision)))throw new Error('invalid destination_revision');
      if(body.command_key!==undefined&&(typeof commandKey!=='string'||commandKey.length<1||commandKey.length>128)) throw new Error('invalid command_key: use a nonempty string of at most 128 characters');
      const retry=typeof body.assignment?.request_id==='string'&&store.hasAssignment(body.assignment.request_id);
      const delivery=parseDelivery(body.delivery===undefined?'none':body.delivery), destination=await destinations.for(delivery), owner=str(body.owner_token,'owner_token',128);
      // Profile mode: T3 delivery needs t3code on this host. Refuse before anything is stored, with the recovery in the message.
      if(delivery.mode==='t3'&&!legacyProfile&&!(await (await import('./t3.mjs')).t3Available())) throw new Error('delivery t3:... needs T3 Code, but t3code was not found on PATH on the bridge host; submit without --deliver/--thread (quiet delivery) or install T3 Code');
      if(!body.assignment||typeof body.assignment!=='object'||Array.isArray(body.assignment)) throw new Error('invalid assignment: must be a JSON object');
      if(typeof body.assignment.request_id!=='string'||!/^[-\w]{8,128}$/.test(body.assignment.request_id)) throw new Error('invalid assignment: request_id is required and must be 8-128 letters, digits, _ or -');
      if(!Array.isArray(body.assignment.inputs)) throw new Error('invalid assignment: inputs must be an array (use [] when the assignment has no repository input)');
      if(Object.hasOwn(body.assignment,'protocol')&&(!retry||store.isProtocolJob(body.assignment.request_id))) {
        if(catalogProfile!=='protocol-v0')throw new Error('protocol jobs require DALAN_CATALOG_PROFILE=protocol-v0');
        validateProtocol(body.assignment.protocol);
      }
      let payload=renderAssignment(body.assignment);
      if(!payload||payload.schema_version!==1||!payload.brief||!Array.isArray(payload.inputs)||typeof payload.expected_output!=='string'||typeof payload.execution_scope!=='string') {
        const wrong=payload?[payload.schema_version!==1&&'schema_version (must be 1)',!payload.brief&&'brief',!Array.isArray(payload.inputs)&&'inputs (an array)',typeof payload.expected_output!=='string'&&'expected_output (a string)',typeof payload.execution_scope!=='string'&&'execution_scope (a string)'].filter(Boolean):[];
        throw new Error(`invalid assignment: needs schema_version 1, brief, inputs, expected_output and execution_scope${wrong.length?`; missing or wrong: ${wrong.join(', ')}`:''}`);
      }
      // Profile mode never falls back to the legacy default worker: retries retain their stored target and policy check.
      const existingRequest=retry?store.get(payload.request_id):null,storedTarget=existingRequest?.target_worker;
      const target=retry?(body.worker===undefined?storedTarget:submitTarget(workers,body.worker)):submitTarget(workers,body.worker);
      if(!retry) assertTarget(workers,target??'dot');
      if(existingRequest) {
        assertRepoAllowed(storedTarget,existingRequest.assignment);
      }
      assertRepoAllowed(storedTarget??target??'dot',payload);
      if(body.max_queued!==undefined&&(!Number.isSafeInteger(body.max_queued)||body.max_queued<1)) throw new Error('invalid max_queued');
      if(body.review!==undefined&&typeof body.review!=='boolean') throw new Error('invalid review');
      if(body.background!==undefined&&body.background!==true) throw new Error('invalid background');
      if(body.allow_main!==undefined&&typeof body.allow_main!=='boolean') throw new Error('invalid allow_main');
      if(body.exclude_sensitive!==undefined&&typeof body.exclude_sensitive!=='boolean') throw new Error('invalid exclude_sensitive');
      // Execution capability (design section 3). Omitted: the profile default, which is host for the legacy profile. A retry that omits it is not judged.
      const explicitExecution=body.execution===undefined?null:parseExecution(body.execution);
      const requiredCapabilities=parseRequiredCapabilities(body.required_capabilities);
      const jobExecution=explicitExecution??workers.defaultExecution;
      if(body.queue_anyway!==undefined&&typeof body.queue_anyway!=='boolean') throw new Error('invalid queue_anyway');
      if(body.refuse_defer!==undefined&&typeof body.refuse_defer!=='boolean') throw new Error('invalid refuse_defer');
      if(body.defer_queued!==undefined&&(!Number.isSafeInteger(body.defer_queued)||body.defer_queued<1)) throw new Error('invalid defer_queued');
      const dryRun=url.pathname==='/submit-preview';
      if(body.dry_run!==undefined&&typeof body.dry_run!=='boolean') throw new Error('invalid dry_run');
      if(body.assignment&&Object.hasOwn(body.assignment,'scope_excluded')) throw new Error('assignment declares scope_excluded; only the bridge records what it dropped from a scope');
      const declaredSource=body.meta?.source??'agent';
      for(const [value,label] of [[body,'submit request'],[body.meta,'meta'],[body.assignment,'assignment']]) assertNoDeclaredConsumer(value,label,declaredSource);
      const meta=normalizeMeta(body.meta);
      // A retry of an older row is not judged again; only a new submission has to prove the source it claims.
      if(!store.hasAssignment(payload.request_id)) {const refused=unprovenSource({request_id:payload.request_id,payload,meta},body.background===true?'background':'normal'); if(refused) throw new Error(refused);}
      {const input=payload.inputs[0];if(!store.hasAssignment(payload.request_id)&&payload.execution_scope==='implementation'&&body.review!==true&&input?.head_sha&&input.head_sha!==input.base_sha) throw new Error('head_sha_unsupported: implementation scope checks out base_sha; pin base_sha to the revision to work on, or use --review or read-only scope for head_sha');}
      if(body.allow_main===true) adminOperator(req);
      destination.admit(delivery,{allowMain:body.allow_main===true});
      if(body.sensitive_scope_override!==undefined&&(typeof body.sensitive_scope_override!=='string'||!body.sensitive_scope_override)) throw new Error('invalid sensitive scope override');
      // A retry validates nothing and sends the original assignment, so the identity of a request is the assignment as submitted,
      // even when validation changed the stored brief (scope narrowing, the appended allow-list).
      const submitted=payload;
      const isNew=!store.hasAssignment(payload.request_id);
      // Reject immutable retry conflicts using the persisted binding before any external destination inspection.
      // A matching retry still validates the current destination below; this does not accept stale environment evidence.
      store.checkRetry(submitted,delivery,existingRequest?.environment_id,owner,body.review===true,body.background===true?'background':'normal',meta,submitted,target,explicitExecution,requiredCapabilities,commandKey,supersedes,destinationRevision);
      let order=null;
      if(isNew) {
        order=await compileWorkOrder({assignment:payload,review:body.review===true,priority:body.background===true?'background':'normal',jobExecution,requiredCapabilities,meta,maxQueued:body.max_queued??null,deferQueued:body.defer_queued??null,
          excludeSensitive:body.exclude_sensitive===true,sensitiveScopeOverride:body.sensitive_scope_override??null,target:target??'dot'},{
          render:renderAssignment,
          admitExecution:(p,r)=>{
            if(r.requiredCapabilities&&r.jobExecution!=='host') throw new Error(`invalid required_capabilities: only execution=host jobs can require bridge capabilities (this job has execution=${r.jobExecution})`);
            // No usable executor, or a required capability the backend does not declare verified: never degraded to a run without it.
            if(r.jobExecution==='host'&&(p.execution_scope==='implementation'||r.requiredCapabilities)) admitHostExecution(r.requiredCapabilities);
          },
          validate:(p,{warnings})=>validateSubmissionAsync(p,{sensitiveScopeOverride:body.sensitive_scope_override??null,warnings,excludeSensitive:body.exclude_sensitive===true,review:body.review===true,worker:storedTarget??target??'dot'}),
          admitReadiness:p=>{
            if(p.execution_scope!=='implementation') return null;
            const readiness=admitImplementation(p,{execution:jobExecution,worker:storedTarget??target??'dot'});
            if(!dryRun) log({kind:'check_readiness',request_id:p.request_id,...readiness});
            return readiness;
          },
          preflight:p=>preflightPR(p),
          // Advisory only, like Store.submit: a supersede target leaves the queued count unchanged. Store.submit rechecks it in its transaction.
          state:r=>({paused:store.paused(),pause_reason:store.db.prepare('SELECT reason FROM operator_state WHERE id=1').get().reason,worker_break:(r.target==='dot'?store.holdingBreak():null),queued:store.db.prepare("SELECT count(*) n FROM assignments WHERE status='queued' AND target_worker=? AND request_id IS NOT ? AND (valid_until IS NULL OR valid_until>?)").get(r.target,supersedes?.target_id??null,new Date(store.nowMs()).toISOString()).n}),
          kind:(r,p)=>r.meta?.task_kind??(r.review?'review':p.execution_scope??'unknown'),
          defaultValidity:(kind,r)=>store.defaultValidUntil(r.target,kind),
          retryAfterSeconds:r=>{const w=store.queueWaitsMs(r.target,r.meta?.task_kind??(r.review?'review':'unknown'));return w.length?Math.min(3600,Math.max(60,Math.round(w[Math.floor(w.length/2)]/1000))):300;},
          deferQueued:envDeferQueued});
        // A refusal keeps the message the old path threw; the typed reasons ride along on it. A dry run reports every verdict as a 200.
        if(!dryRun&&(order.verdict==='reject'||order.verdict==='clarify'||order.blocking)) throw Object.assign(order.refusal,{verdict:order.verdict,reasons:order.reasons,bytes:order.bytes});
        payload=order.payload;
      }
      const {environmentId}=(dryRun&&order&&order.verdict!=='admissible')?{}:await destination.validate(delivery);
      // An awaited repository/destination lookup may outlive a host policy edit.
      assertRepoAllowed(storedTarget??target??'dot',existingRequest?.assignment??payload);
      if(dryRun) store.checkRetry(submitted,delivery,environmentId,owner,body.review===true,body.background===true?'background':'normal',meta,submitted,target,explicitExecution,requiredCapabilities,commandKey,supersedes,destinationRevision);
      const disclosure=isNew?store.destinationSnapshot(target??'dot',jobExecution,payload):existingRequest.destination_approval?.snapshot??null;
      if(dryRun) {
        log({kind:'submit_dry_run',request_id:submitted.request_id,task_kind:meta.task_kind??null,source:meta.source??null,verdict:order?.verdict??'admissible',reason_codes:(order?.reasons??[]).map(r=>r.code),attempt_latency_ms:Date.now()-requestStartedAt});
        return json(res,200,{dry_run:true,request_id:submitted.request_id,stored:false,...(disclosure?{destination_disclosure:disclosure}:{}),...(order??{verdict:'admissible',reasons:[],duplicate:true}),...(order?.warnings?.length?{submission_warnings:order.warnings}:{})});
      }
      // Defer refuses only for a requester that opts in; both the CLI and HTTP API queue by default.
      if(order?.verdict==='defer'&&body.refuse_defer===true&&body.queue_anyway!==true) {
        log({kind:'submit_deferred',...rejected,reason_codes:order.reasons.map(r=>r.code),attempt_latency_ms:Date.now()-requestStartedAt});
        return json(res,409,{error:`deferred: ${order.reasons.map(r=>r.message).join('; ')}`,verdict:'defer',reasons:order.reasons,bytes:order.bytes,retry_after_seconds:order.retry_after_seconds});
      }
      const submissionWarnings=order?.warnings??[];
      const readiness=order?.check_readiness??null;
      const preflight=order?.preflight??null;
      const defaultValidity=order?.defaultValidity??null;
      const result=store.submit(payload,delivery,environmentId,owner,body.review===true,preflight,body.background===true?'background':'normal',meta,(()=>{const r=renderAssignment(submitted);return payload.brief!==r.brief||JSON.stringify(payload.scope_paths)!==JSON.stringify(r.scope_paths);})()?submitted:payload,body.max_queued??null,target,explicitExecution,workers.defaultExecution,requiredCapabilities,defaultValidity?.valid_until??null,commandKey,supersedes,destinationRevision);
      // Only a committed first replacement wakes the TARGET's already-attached waiter.
      if(supersedes&&!result.duplicate) {
        const targetId=supersedes.target_id,waiter=waiters.get(targetId);
        if(waiter) { waiters.delete(targetId); clearTimeout(waiter.timer); json(waiter.res,200,waitSummary(targetId)); }
      }
      log({kind:'submit_admitted',...rejected,duplicate:result.duplicate,attempt_latency_ms:Date.now()-requestStartedAt,bytes:order?.bytes??null});
      // A retry validates nothing, so the narrowing it reports comes from the stored assignment.
      const stored=result.duplicate?JSON.parse(store.db.prepare('SELECT payload FROM assignments WHERE request_id=?').get(payload.request_id).payload):payload;
      if(stored.scope_excluded?.length&&!result.duplicate) log({kind:'scope_excluded',request_id:payload.request_id,excluded:stored.scope_excluded});
      return json(res,200,{...result,execution:store.db.prepare('SELECT execution FROM assignments WHERE request_id=?').get(payload.request_id).execution,...(stored.scope_excluded?.length?{scope_excluded:stored.scope_excluded,scope_paths:stored.scope_paths}:{}),...(readiness?{check_readiness:readiness}:{}),...(submissionWarnings.length?{submission_warnings:submissionWarnings}:{})});
    }
    if(url.pathname==='/admission'&&req.method==='GET') { const row=store.db.prepare('SELECT cancelled_reason FROM assignments WHERE request_id=?').get(id(url.searchParams.get('id'))); return json(res,200,{exists:!!row,...(row?.cancelled_reason==='expired'?{cancelled_reason:'expired'}:{})}); }
    if(url.pathname==='/get') {
      const requestId=id(url.searchParams.get('id'));
      if(!store.hasAssignment(requestId)) return json(res,200,{kind:'message',message:store.getMessage(requestId)});
      adminOwner(req,requestId);
      store.assertProtocolAvailable(requestId);
      store.recordFetched(requestId);
      // Read before recording consumption: the response then matches a peek read, which records no consumption.
      const got=maskedForOwner(withAvailableChecks(store.get(requestId)));
      if(url.searchParams.get('peek')!=='1') store.recordConsumed(requestId,'get');
      if(protocolServices&&store.isProtocolJob(requestId))got.protocol_stop=protocolServices.observation(requestId);
      if(!workspaceEnabled||got.assignment?.execution_scope!=='implementation'||got.available_checks_error==='repository_policy_denied') return json(res,200,got);
      try { return json(res,200,{...got,check_metadata:workspace.checkMetadataFor(got.assignment,got.target_worker)}); }
      catch(error) { return json(res,200,{...got,check_metadata:null,check_metadata_error:publicErrorText(error,'check metadata')}); }
    }
    if(url.pathname==='/artifact') { const artifactId=id(url.searchParams.get('id'),'artifact_id');const row=store.db.prepare('SELECT request_id FROM artifacts WHERE id=? AND sealed=1').get(artifactId);if(!row) throw new Error('artifact not found');adminOwner(req,row.request_id);const bytes=(workspace||new Workspace(store,false)).artifact(artifactId,row.request_id);res.writeHead(200,{'content-type':'application/octet-stream','content-length':bytes.bytes.length,'x-artifact-sha256':bytes.row.sha256});res.end(bytes.bytes);return; }
    if(['/protocol/wait','/protocol/inbox','/protocol/ack'].includes(url.pathname)&&req.method==='POST') {
      if(catalogProfile!=='protocol-v0') throw new Error('protocol owner routes require DALAN_CATALOG_PROFILE=protocol-v0');
      const requestId=id(body.id),owner=req.headers['x-owner-capability'];
      const waiters=createProtocolOwnerWaiters(store);
      if(url.pathname==='/protocol/wait') return json(res,200,waiters.register(requestId,owner,{
        key:body.command_key,revision:body.expected_revision,waiter:body.waiter,predicate:body.predicate,afterSeq:body.after_seq,expiresAt:body.expires_at,
      }));
      if(url.pathname==='/protocol/inbox') return json(res,200,waiters.inbox(requestId,owner,body.waiter));
      return json(res,200,waiters.ack(requestId,owner,body.waiter,body.delivery));
    }
    if(url.pathname==='/wait'&&req.method==='GET') {
      const requestId=id(url.searchParams.get('id')); adminOwner(req,requestId);
      const seconds=Number(url.searchParams.get('timeout')??300);
      if(!Number.isInteger(seconds)||seconds<1||seconds>3600) throw new Error('timeout must be an integer from 1 to 3600 seconds');
      return attachWaiter(req,res,requestId,seconds*1000,url.searchParams.get('peek')!=='1');
    }
    // `dalan inbox --mark-read`: record the owner read (the same marker as /get) for each owned request, returning no results.
    if(url.pathname==='/owner-mark-read'&&req.method==='POST') {
      if(!Array.isArray(body.items)||body.items.length>500) throw new Error('items must be an array of at most 500');
      const results=body.items.map(item=>{
        const requestId=id(item?.id);
        try { store.owner(requestId,item.capability); } catch { return {request_id:requestId,error:'not_owned'}; }
        return {request_id:requestId,marked:store.markInboxRead(requestId,'inbox-mark-read')};
      });
      return json(res,200,{results,marked:results.filter(r=>r.marked).length});
    }
    // Batch owner read for `dalan wait --drained`: status and blocker notes for each owned request plus whether a refill
    // would be held. Unlike /get it records no 'consumed' event, so a polling waiter does not fake owner reads.
    if(url.pathname==='/owner-states'&&req.method==='POST') {
      if(!Array.isArray(body.items)||body.items.length>500) throw new Error('items must be an array of at most 500');
      const states=body.items.map(item=>{
        const requestId=id(item?.id);
        try { store.owner(requestId,item.capability); } catch { return {request_id:requestId,error:'not_owned'}; }
        const row=store.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(requestId);
        const blockers=store.db.prepare('SELECT note FROM progress WHERE request_id=? ORDER BY id').all(requestId).map(p=>p.note).filter(note=>/^\s*(?:BLOCKED:|QUESTION:)/im.test(note));
        return {request_id:requestId,status:row.status,blocker_count:blockers.length,last_blocker:blockers.at(-1)??null,inbox:store.ownerInbox(requestId)};
      });
      // Only evidence holds refill: a pause or an owner-confirmed break. throttled stays false for older readers.
      const paused=store.paused(), dotBreak=!!store.holdingBreak();
      const held=paused?'paused':dotBreak?'worker_break':null;
      return json(res,200,{states,refill:{held,paused,worker_break:dotBreak,throttled:false}});
    }
    if(url.pathname==='/tools'&&req.method==='GET') { adminOperator(req); return json(res,200,{tools:toolRegistry.list()}); }
    if(url.pathname.startsWith('/tools/')&&req.method==='POST') {
      adminOperator(req);
      try {
        const action=url.pathname.slice(7);
        if(action==='add') return json(res,200,toolRegistry.register(body.spec));
        if(action==='remove') return json(res,200,toolRegistry.remove(body.name));
        if(action==='grant') { toolRegistry.grant(body.name,body.worker); return json(res,200,{name:body.name,worker:body.worker,granted:true}); }
        if(action==='revoke') { toolRegistry.revoke(body.name,body.worker); return json(res,200,{name:body.name,worker:body.worker,granted:false}); }
      } catch(error) { if(error instanceof RegistryError) throw new Error(`${error.code}: ${error.message}`); throw error; }
    }
    if(url.pathname==='/status') return json(res,200,{last_registry_change:toolRegistry.lastChange(),...store.status({limits:redeliveryLimits,capacity:claimCapacity,backgroundMaxInFlight}),max_claimed_outer_assignments:claimCapacity,worker_lane_capacity:redeliveryLimits.laneCapacity,background_max_in_flight:backgroundMaxInFlight,owner_waiter_count:waiters.size});
    if(url.pathname==='/metrics'&&req.method==='GET') return json(res,200,lifecycleMetrics(store,{since:url.searchParams.get('since'),laneCapacity:redeliveryLimits.laneCapacity}));
    if(['/accept','/reject'].includes(url.pathname)&&req.method==='POST') {
      const requestId=id(body.id); adminOwner(req,requestId);
      const note=body.note===undefined||body.note===null?null:str(body.note,'note',4096);
      return json(res,200,store.verdict(requestId,url.pathname==='/accept',note));
    }
    if(url.pathname==='/decide'&&req.method==='POST') {
      const requestId=id(body.id); adminOwner(req,requestId);
      if(body.decision==='stale') throw new Error('stale is recorded by the sweep only');
      const via=['cli','apply','adapter'].includes(body.via)?body.via:'cli';
      return json(res,200,store.decide(requestId,String(body.decision),{note:body.note===undefined||body.note===null?null:str(body.note,'note',4096),via}));
    }
    if(url.pathname==='/lifecycle'&&req.method==='POST') {
      adminOperator(req);
      if(body.type!=='integrated') throw new Error('only type integrated is accepted');
      return json(res,200,store.integrated(id(body.id),body.reason===undefined||body.reason===null?null:str(body.reason,'reason',512)));
    }
    if(url.pathname==='/note'&&req.method==='POST') { const requestId=id(body.id); adminOwner(req,requestId); return json(res,200,store.note(requestId,body.text)); }
    if(url.pathname==='/answer'&&req.method==='POST') { const requestId=id(body.id); adminOwner(req,requestId);return json(res,200,store.answerQuestion(requestId,str(body.question_id,'question_id',128),str(body.text,'text',4096),{key:body.command_key,revision:body.expected_revision},req.headers['x-owner-capability'])); }
    if(url.pathname==='/questions'&&req.method==='GET') { const requestId=id(url.searchParams.get('id'));adminOwner(req,requestId);return json(res,200,{request_id:requestId,questions:store.questions(requestId)}); }
    if(url.pathname==='/tell'&&req.method==='POST') return json(res,200,store.tell(str(body.text,'text',4096),body.worker===undefined&&workers.workers.has('dot')?'dot':submitTarget(workers,body.worker)??assertTarget(workers,'dot')));
    if(url.pathname==='/untell'&&req.method==='POST') return json(res,200,store.untell(id(body.message_id,'message_id'),body.worker===undefined?null:assertTarget(workers,body.worker)));
    if(url.pathname.startsWith('/connect/')) {
      adminOperator(req);
      if(!as) throw new Error('built-in authorization server is not enabled (DALAN_AUTH_MODE=builtin)');
      const ops=as.ops;
      if(url.pathname==='/connect/add-client'&&req.method==='POST') return json(res,200,ops.addClient({redirectUri:body.redirect_uri,...(body.name!==undefined?{name:body.name}:{})}));
      if(url.pathname==='/connect/clients'&&req.method==='GET') return json(res,200,ops.clients());
      if(url.pathname==='/connect/remove-client'&&req.method==='POST') return json(res,200,ops.removeClient({clientId:body.client_id}));
      if(url.pathname==='/connect/start'&&req.method==='POST') return json(res,200,ops.start({worker:body.worker,...(body.minutes!==undefined?{minutes:body.minutes}:{})}));
      if(url.pathname==='/connect/reset'&&req.method==='POST') return json(res,200,ops.reset());
      if(url.pathname==='/connect/stop'&&req.method==='POST') return json(res,200,ops.stop());
      if(url.pathname==='/connect/pending'&&req.method==='GET') return json(res,200,ops.pending());
      if(url.pathname==='/connect/approve'&&req.method==='POST') return json(res,200,await ops.approve({code:body.code,worker:body.worker,replace:body.replace===true?true:body.replace===undefined?false:body.replace,confirm_redirect:body.confirm_redirect}));
      if(url.pathname==='/connect/list'&&req.method==='GET') return json(res,200,ops.list());
      if(url.pathname==='/connect/revoke'&&req.method==='POST') return json(res,200,ops.revoke({worker:body.worker}));
      if(url.pathname==='/connect/signal-token'&&req.method==='POST') return json(res,200,signal.tokenUrl({worker:body.worker,rotate:body.rotate===true}));
      if(url.pathname==='/connect/allow-callback'&&req.method==='POST') return json(res,200,ops.allowCallback({pattern:body.pattern}));
      return json(res,404,{error:'not found'});
    }
    if(url.pathname==='/audit') { adminOperator(req); return json(res,200,{entries:(await loadT3Audit()).listT3Audit(store.db,url.searchParams.get('since'))}); }
    if(url.pathname==='/notify-pending'&&req.method==='GET') {
      adminOperator(req);
      return json(res,200,{notifications:notifyLedger.pending()});
    }
    if(url.pathname==='/notify-reconcile'&&req.method==='POST') {
      adminOperator(req);
      const result=notifyLedger.reconcile({key_sha256:body.key_sha256,outcome:body.outcome,evidence:body.evidence});
      log({kind:'notification_reconciled',key_sha256:result.key_sha256,outcome:result.outcome});
      return json(res,200,result);
    }
    if(url.pathname==='/backfill-objectives'&&req.method==='POST') {
      adminOperator(req);
      if(body.dry_run!==undefined&&typeof body.dry_run!=='boolean') throw new Error('invalid dry_run');
      return json(res,200,store.backfillObjectives(body.tuples,{dryRun:body.dry_run===true}));
    }
    if(url.pathname==='/claims'&&req.method==='GET') { adminOperator(req); return json(res,200,{lease_ms:store.limits.leaseMs,claims:store.claims()}); }
    if(url.pathname==='/abandon'&&req.method==='POST') {
      adminOperator(req);
      const requestId=id(body.id),result=store.abandon(requestId,{actor:'operator',reason:body.reason===undefined||body.reason===null?'operator_abandon':str(body.reason,'reason',512)});
      log({kind:'claim_abandoned',request_id:requestId,epoch:result.abandoned.epoch,actor:'operator'});
      runDrain();
      return json(res,200,result);
    }
    if(url.pathname==='/cancel') {
      const requestId=id(body.id); adminOwner(req,requestId);
      const result=store.cancel(requestId,body.reason===undefined||body.reason===null?null:str(body.reason,'reason',64),{key:body.command_key,revision:body.expected_revision},req.headers['x-owner-capability']); const waiter=waiters.get(requestId); if(waiter) { waiters.delete(requestId); clearTimeout(waiter.timer); json(waiter.res,200,waitSummary(requestId)); } return json(res,200,result);
    }
    if(url.pathname==='/cancel-if-queued'&&req.method==='POST') {
      const requestId=id(body.id); adminOwner(req,requestId);
      const result=store.cancelIfQueued(requestId);
      if(result.cancelled) { const waiter=waiters.get(requestId); if(waiter) { waiters.delete(requestId); clearTimeout(waiter.timer); json(waiter.res,200,waitSummary(requestId)); } }
      return json(res,200,result);
    }
    if(url.pathname==='/break'&&req.method==='POST') {
      adminOperator(req);
      if(body.clear===true) { const cleared=store.clearBreak(); sweepExpired(); return json(res,200,cleared); }
      if(body.since!==undefined&&body.since!==null&&(typeof body.since!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(body.since)||!Number.isFinite(Date.parse(body.since)))) throw new Error('since must be an RFC 3339 time with offset');
      const result=store.setBreak(str(body.reason,'reason',512),body.since?new Date(body.since).toISOString():null);
      log({kind:'worker_break_set',source:'owner',since:result.since});
      return json(res,200,result);
    }
    if(url.pathname==='/break-usage-backfill'&&req.method==='POST') { adminOperator(req); return json(res,200,store.mergeBreakUsage(body.id,body.since,body.windows)); }
    if(url.pathname==='/learned'&&req.method==='GET') { adminOperator(req); return json(res,200,{learned:store.learnedLimits(),over_estimate:store.overEstimate(redeliveryLimits)}); }
    if(url.pathname==='/learned'&&req.method==='POST') {
      adminOperator(req); if(body.clear!==true) throw new Error('learned accepts only {clear:true}');
      const result=store.clearLearnedLimits(); log({kind:'learned_limits_cleared',source:'owner',removed:result.removed}); return json(res,200,result);
    }
    if(url.pathname==='/breaks'&&req.method==='GET') { adminOperator(req); return json(res,200,{worker_break:store.breakState(),breaks:store.breaks()}); }
    if(url.pathname==='/verify-stops'&&req.method==='POST') {
      adminOperator(req);
      const requestId=body.id===undefined?undefined:id(body.id);
      return json(res,200,{request_id:requestId??null,stops:workspace?workspace.reconcileHostStops(requestId):[]});
    }
    if(['/pause','/resume','/reconcile'].includes(url.pathname)) {
      adminOperator(req);
      if(url.pathname==='/pause') return json(res,200,store.setPause(str(body.reason,'reason',512)));
      if(url.pathname==='/resume') return json(res,200,store.setPause(null));
      const requestId=id(body.id),adopt=body.adopt===true;
      if(adopt) store.adopt(requestId,str(body.owner_token,'owner_token',128));
      return json(res,200,{request_id:requestId,adopted:adopt,reconciliation:await reconcileRequest(requestId),assignment:(row=>row&&withoutT3(row))(store.get(requestId))});
    }
    json(res,404,{error:'not found'});
  } catch(e) {
    const infrastructure=e.code==='DOT_BRIDGE_INFRASTRUCTURE'||e.code==='ERR_SQLITE_ERROR'||['EIO','ENOSPC','EMFILE','ENFILE','EROFS','ENOENT','EACCES','EPERM'].includes(e.code);
    // Every refusal of a submit carries typed reasons and a verdict, whichever check threw (the compiler or an earlier request check).
    const reasons=!infrastructure&&rejected?(e.reasons??reasonsFromError(e).map(({verdict,retry,blocking,...r})=>r)):null;
    const verdict=reasons?(e.verdict??strongest(reasonsFromError(e))):null;
    // A dry run answers every verdict with a 200 and stores nothing, including a refusal raised before the compiler ran.
    if(dryRequested&&reasons) { log({kind:'submit_dry_run',...rejected,verdict,reason_codes:reasons.map(r=>r.code),attempt_latency_ms:Date.now()-requestStartedAt}); return json(res,200,{dry_run:true,stored:false,request_id:rejected?.request_id??null,verdict,reasons,bytes:e.bytes??null,warnings:[]}); }
    if(rejected) log({kind:'submit_rejected',...rejected,status:infrastructure?503:400,reason:e.message.slice(0,300),...(reasons?{verdict,reason_codes:reasons.map(r=>r.code)}:{}),bytes:e.bytes??null,attempt_latency_ms:Date.now()-requestStartedAt,...(e.suggested_scope_paths?{suggested_scope_count:e.suggested_scope_paths.length}:{})});
    if(infrastructure&&!rejected) log({kind:'admin_infrastructure_error',route:String(req.url).split('?')[0],code:e.code??null,reason:e.message.slice(0,300)});
    const shown=publicErrorText(e,'admin request');
    json(res,infrastructure?503:400,{error:infrastructure?'admin service unavailable':shown,...(e.destination?{destination:e.destination}:{}),...(infrastructure?{code:e.code??null,reason:shown.slice(0,300)}:{}),...(!infrastructure&&e.suggested_scope_paths?{suggested_scope_paths:e.suggested_scope_paths}:{}),...(reasons?{verdict,reasons,...(e.bytes?{bytes:e.bytes}:{})}:{})});
  }
});

let reconciliationFlight=null;
async function withReconcileLock(work) {
  while(reconciliationFlight) await reconciliationFlight.catch(()=>{});
  const flight=Promise.resolve().then(work); reconciliationFlight=flight;
  try { return await flight; } finally { if(reconciliationFlight===flight) reconciliationFlight=null; }
}
const reconciliationFence=(item,row)=>({attemptId:item.attempt_id,attemptStartedAt:item.attempt_started_at,body:item.body,argv:item.argv,threadId:row?.thread_id??null,environmentId:row?.environment_id??null,targetWorker:row?.target_worker??null,assignmentStatus:row?.status??null,deliveryMode:row?.delivery_mode??null,reportSnapshot:JSON.stringify(row?.report?{outcome:row.report.outcome,summary:row.report.summary,result:row.report.result}:null)});
async function reconcileRequest(requestId) {
  return withReconcileLock(async()=>{
    const item=store.uncertainOne(requestId); if(!item) return [];
    const now=store.nowMs();
    if(!Number.isFinite(now)||!Number.isInteger(now)||!Number.isFinite(new Date(now).getTime()))
      return [{id:item.id,state:'deferred',reason:'clock is invalid; reconciliation remains conservative'}];
    if(item.last_reconciled_at) {
      const last=Date.parse(item.last_reconciled_at);
      if(!Number.isFinite(last)||!Number.isFinite(now)||!Number.isFinite(new Date(now).getTime())||now<last+60000)
        return [{id:item.id,state:'deferred',reason:'minimum observation interval is 60 seconds; clock or prior observation is invalid'}];
    }
    const row=store.get(item.request_id),destination=await destinations.for(row.delivery_mode);
    const outcome=await destination.reconcile(item,row);
    store.reconciled(item.id,outcome.state==='confirmed'?'delivered':'uncertain',outcome.reason||'marker found',reconciliationFence(item,row));
    return [{id:item.id,state:outcome.state,reason:outcome.reason||null}];
  });
}
async function reconcileTick() {
  return withReconcileLock(async()=>{
    const unknown=[];
    // These probes read only the local ACK ledger; no transcript/network lookup.
    // Check positive evidence for every candidate before applying its age policy.
    for(const item of store.uncertainBatch()) {
      const row=item.request_id?store.get(item.request_id):null;
      let outcome={state:'ambiguous',reason:'bounded positive observation unsupported'};
      if(item.kind==='event') {
        const sub=store.db.prepare('SELECT * FROM subscriptions WHERE id=?').get(item.subscription_id);
        if(sub&&store.subscriptionActive(sub)&&store.mayAct(sub.worker,item.request_id??item.message_id)) {
          const binding=`webhook\0${sub.id}\0${sub.url}\0${sub.worker}\0${sub.principal}\0${readEnv('DALAN_ENVIRONMENT_ID')??os.hostname()}`;
          const key=ackLedger.key(item.id,item.body,binding);
          if(ackLedger.has(key)) outcome={state:'confirmed',reason:'recovered from durable webhook acceptance acknowledgment'};
          else outcome={state:'ambiguous',reason:'no durable webhook acceptance acknowledgment'};
        } else outcome={state:'ambiguous',reason:'target webhook subscription is no longer active or authorized'};
      } else {
        const destination=row&&await destinations.for(row.delivery_mode);
        if(typeof destination?.reconcilePositiveAck==='function') outcome=await destination.reconcilePositiveAck(item,row);
      }
      const changed=store.reconciled(item.id,outcome.state==='confirmed'?'delivered':'uncertain',outcome.reason||'positive acknowledgment found',reconciliationFence(item,row));
      if(changed&&outcome.state!=='confirmed') unknown.push(item.id);
    }
    for(const item of store.releaseAgedUncertain(unknown)) log({kind:'uncertain_delivery_terminal',...item,policy:'uncertain_delivery_age_limit'});
  });
}
let delivering=false;
async function drain() {
  if(delivering||store.paused()) return; delivering=true;
  try {
    store.reannounceQueued(redeliveryLimits);
    for(const item of store.due()) {
      if(store.paused()) break;
      const row=item.kind==='event'?null:store.get(item.request_id);
      let destination=null;
      if(row) {
        try { destination=await destinations.for(row.delivery_mode); }
        catch(error) {
          const reason=`destination unavailable: ${String(error?.message??error).slice(0,300)}`;
          if(error?.code==='INVALID_DELIVERY_MODE') {
            if(store.quarantineDelivery(item.id,reason)) log({kind:'delivery_quarantined',event_id:item.id,request_id:item.request_id,reason});
          } else if(store.retryDelivery(item.id,reason)) log({kind:'delivery_retry_scheduled',event_id:item.id,request_id:item.request_id,reason,retry_in_ms:1000});
          continue;
        }
      }
      if(row) {
        const reason=destination.quietReason(row);
        if(reason) { store.quietDelivery(item.id,reason); notifyAttachedWaiter(item.request_id); continue; }
      }
      const argv=row?destination.argv(item,row):null;
      const started=store.startAttempt(item.id,argv); if(!started) continue;
      if(crashAt('after_attempt_commit',item.request_id)) process.exit(71);
      let state='failed',reason='';
      // The adapter settles every failure it can classify. Anything it rethrows (a failed log write inside its
      // own catch) must escape drain and leave the row 'sending' for startup recovery, as before the refactor.
      let positiveAckObserved=false,ackDurablyRecorded=false;
      if(row) ({state,reason}=await destination.send(item,{started,argv}));
      else try {
        {
          const sub=store.db.prepare('SELECT * FROM subscriptions WHERE id=?').get(item.subscription_id);
          if(!store.subscriptionActive(sub)) {
            if(sub) store.retireUnusableSubscription(sub);
            state='suppressed'; reason='subscription inactive';
          }
          else if(!store.mayAct(sub.worker,item.request_id??item.message_id)) { state='suppressed'; reason='worker cannot see event'; }
          else {
            const binding=`webhook\0${sub.id}\0${sub.url}\0${sub.worker}\0${sub.principal}\0${readEnv('DALAN_ENVIRONMENT_ID')??os.hostname()}`;
            const ack=ackLedger.key(item.id,item.body,binding);
            // An earlier ACK is not a new callback and must not clear callback failures.
            if(ackLedger.has(ack)) { ackDurablyRecorded=true; state='delivered'; reason='recovered from durable webhook acceptance acknowledgment'; }
            else {
              const response=await sendWebhook(sub.url,store.subscriptionSecret(sub),item.id,sub.id,item.body);
              if(response.status>=200&&response.status<300) { positiveAckObserved=true; ackLedger.record(ack); ackDurablyRecorded=true; }
              store.eventResult(sub.id,response.status);
              state=response.status>=200&&response.status<300?'delivered':response.status===410||response.status===413?'suppressed':'failed';
              reason=state==='delivered'?'':`HTTP ${response.status}`;
              if(item.message_id) log({kind:'message_event',message_id:item.message_id,event_id:item.id,state,http_status:response.status});
            }
          }
        }
      } catch(e) { reason=e.message; state=ackDurablyRecorded?'delivered':positiveAckObserved?'uncertain':'failed'; log({kind:'delivery_error',event_id:item.id,reason}); }
      store.finishAttempt(item.id,started.attempt_id,state,reason);

    }
  } finally { delivering=false; }
}
function maintain() {
  try {
    sweepExpired();
    sweepSkipped();
    sweepStaleLeases();
    store.retireUnknownSubscriptions();
  } catch(error) { log({kind:'maintenance_error',reason:error.message}); }
}
const runDrain=createDrainRunner(drain,log);
store.recoverSends();
try { fs.unlinkSync(socket); } catch(e) { if(e.code!=='ENOENT') throw e; }
const adminListening=new Promise(resolve=>adminServer.listen(socket,()=>{fs.chmodSync(socket,0o600);console.log(`admin socket ${socket}`);resolve();}));
// Built-in mode sits behind a tunnel on this computer: only loopback may reach the listener.
const bindHost=readEnv('DALAN_BIND_HOST')||(as||loopbackOnly||loopback?'127.0.0.1':'0.0.0.0');
const publicListening=new Promise(resolve=>publicServer.listen(port,bindHost,()=>{console.log(`MCP listening on ${bindHost}:${publicServer.address().port}`);resolve();}));
// Cleanup removes worktrees and dependency caches; it starts only after both servers listen, and
// cleanupExpired is async and single-flight, so neither startup nor the hourly tick blocks requests.
if(workspace) {
  const cleanup=()=>workspace.cleanupExpired({log}).then(s=>{if(s.artifacts_removed||s.workspaces_removed||s.errors)log({kind:'workspace_cleanup',...s});},error=>log({kind:'artifact_cleanup_error',request_id:error.request_id,reason:error.message}));
  Promise.all([adminListening,publicListening]).then(()=>{setTimeout(cleanup,1000).unref();setInterval(cleanup,3600000).unref();});
}
setInterval(()=>{if(t3PostHandler.hasHeld())t3PostHandler.flushDue().catch(()=>{});},60000).unref();
setInterval(maintain,500).unref(); maintain();
setInterval(runDrain,500).unref(); runDrain();
reconcileTick().catch(e=>log({kind:'reconciliation_error',reason:e.message}));
setInterval(()=>reconcileTick().catch(e=>log({kind:'reconciliation_error',reason:e.message})),60000).unref();
const retain=()=>{try{const r=retainLifecycle(store);if(r.rolled_up)log({kind:'lifecycle_rollup',...r});}catch(error){log({kind:'lifecycle_rollup_error',reason:error.message});}};
retain(); setInterval(retain,3600000).unref();
const staleDays=(d=>Number.isFinite(d)&&d>0?d:7)(Number(readEnv('DALAN_DECISION_STALE_DAYS')));
const sweepStale=()=>{try{const ids=store.sweepStaleDecisions(staleDays);if(ids.length)log({kind:'decisions_stale',count:ids.length,request_ids:ids.slice(0,20)});}catch(error){log({kind:'decisions_stale_error',reason:error.message});}};
sweepStale(); setInterval(sweepStale,3600000).unref();
setInterval(()=>checkAlerts(store,log).catch(e=>log({kind:'alert_error',reason:e.message})),60000).unref();

}

let directEntry=false;
if(process.argv[1]) {
  try { directEntry=import.meta.url===pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch {}
}
// An error that carries a fix is the operator's to correct: print it as one plain message, not a stack trace.
if(directEntry) await main().catch(error=>{
  if(!Array.isArray(error?.fix)) throw error;
  console.error(`dalan: ${error.message}`); for(const line of error.fix) console.error(`dalan: fix: ${line}`);
  process.exitCode=1;
});
