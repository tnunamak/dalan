import { readEnv } from './env.mjs';
import { parseJsonBody, safeDiagnostic } from './diagnostic.mjs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dispatchT3Result, T3PreDispatchAuthError } from './t3-transport.mjs';

export const sendArgs = (threadId,kind) => ['threads','send','--thread',threadId,'--stdin','--if-busy','steer'];
export const marker = id => `[dot-bridge event ${id}]`;
// A typed pre-dispatch HTTP401 or the legacy CLI's definite auth refusal is safe to retry.
export const preAcceptAuthRejection = error => error instanceof T3PreDispatchAuthError || /invalid session credential/i.test(error?.message ?? '');
export const authRetryMax = () => { const n=Number(readEnv('DALAN_T3_AUTH_RETRY_MAX')); return Number.isInteger(n)&&n>=1?n:8; };
export const t3Origin = 'http://127.0.0.1:3773';

export function textSummary(text) {
  if (typeof text !== 'string') return { sha256: null, first200: null };
  return { sha256: createHash('sha256').update(text).digest('hex'), first200: text.slice(0, 200) };
}

// The one place that decides which binary talks to T3 (test mode may point at a fake).
export const t3Bin = () => (process.env.NODE_ENV==='test'||readEnv('DALAN_T3_DRY_RUN')==='1')&&readEnv('DALAN_T3CODE_BIN')?readEnv('DALAN_T3CODE_BIN'):'t3code';
// Is T3 usable on this host: the binary resolves (an absolute path as-is, else a PATH search for an executable file). No spawn, no T3 call.
export function t3Available(bin=t3Bin(),pathVar=process.env.PATH??'') {
  const executable=file=>{ try { fs.accessSync(file,fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } };
  return bin.includes('/')?executable(bin):pathVar.split(path.delimiter).some(dir=>dir&&executable(path.join(dir,bin)));
}

export function callT3(args,input='',options={}) {
  if (options.resultDelivery) {
    const { threadId, environmentId, jobId, effectId } = options.resultDelivery;
    return dispatchT3Result(threadId,environmentId,jobId,effectId,input,options.resultDelivery.transportOptions);
  }
  const timeoutMs = options.timeoutMs ?? 15000;
  const maxOutputBytes = options.maxOutputBytes ?? 5 * 1024 * 1024;
  return new Promise((resolve,reject)=>{
    const bin=t3Bin();
    const child=spawn(bin,['--json','--origin',t3Origin,...args],{stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});
    const processGroupId=process.platform!=='win32'?child.pid:null;
    let output='',error='',spawnError=null,limitError=null;
    let outputBytes=0;
    let timedOut=false;
    const killTree=()=>{
      try { if(processGroupId) process.kill(-processGroupId,'SIGKILL'); else child.kill('SIGKILL'); }
      catch(error) { if(error.code!=='ESRCH') try{child.kill('SIGKILL');}catch{} }
    };
    const timer=setTimeout(()=>{timedOut=true;killTree();},timeoutMs);
    const capture=(which,b)=>{
      if(outputBytes+b.length>maxOutputBytes) { limitError=new Error(`t3code output exceeded ${maxOutputBytes} bytes`); killTree(); return; }
      outputBytes+=b.length;
      if(which==='stdout') output+=b; else error+=b;
    };
    child.stdout.on('data',b=>capture('stdout',b));
    child.stderr.on('data',b=>capture('stderr',b));
    child.on('error',error=>{spawnError=error;});
    child.stdin.on('error',()=>{});
    child.on('close',async (code,signal)=>{
      clearTimeout(timer);
      if(processGroupId) {
        try { process.kill(-processGroupId,'SIGKILL'); } catch(error) { if(error.code!=='ESRCH') return reject(error); }
        try { await settleProcessGroup(processGroupId); } catch(error) { return reject(error); }
      }
      if(timedOut)return reject(new Error(`t3code timeout after ${timeoutMs}ms`));
      if(limitError)return reject(limitError);
      if(spawnError)return reject(spawnError);
      if(code!==0) {
        let parsed;
        try { parsed=JSON.parse(output||error); } catch {}
        const outcome=signal?`signal ${signal}`:`exit ${code}`;
        const err=new Error(`t3code ${outcome}: ${safeDiagnostic(error||output,2000)}`);
        err.exitCode=code;
        if(signal) err.signal=signal;
        if(parsed?.error?.code) err.t3ErrorCode=parsed.error.code;
        return reject(err);
      }
      try {const parsed=parseJsonBody(output,'t3code output');if(!parsed.ok){const err=new Error(safeDiagnostic(parsed.error?.message||'t3code error',2000));if(parsed.error?.code)err.t3ErrorCode=parsed.error.code;throw err;}resolve(parsed.data);}
      catch(e){reject(e);}
    });
    child.stdin.end(input);
  });
}

async function settleProcessGroup(groupId) {
  // Linux /proc distinguishes non-running zombies from executing group members;
  // other POSIX systems conservatively wait for the group ID to disappear.
  const groupHasExecutingProcess=()=>{
    if(process.platform==='linux') {
      for(const entry of fs.readdirSync('/proc')) {
        if(!/^\d+$/.test(entry)) continue;
        try {
          const stat=fs.readFileSync(`/proc/${entry}/stat`,'utf8');
          const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
          if(Number(fields[2])===groupId&&!['Z','X'].includes(fields[0])) return true;
        } catch(error) { if(error.code!=='ENOENT'&&error.code!=='ESRCH') throw error; }
      }
      return false;
    }
    try { process.kill(-groupId,0); return true; }
    catch(error) { if(error.code==='ESRCH') return false; throw error; }
  };
  while(groupHasExecutingProcess()) await new Promise(resolve=>setTimeout(resolve,10));
}

function add(args, flag, value) { if (value !== undefined && value !== null && value !== '') args.push(flag, String(value)); }
function addBool(args, flag, value) { if (value === true) args.push(flag); }

export function listArgs({ cwd, project, status, workspace_mode } = {}) {
  const args = ['threads','list'];
  add(args,'--cwd',cwd);
  add(args,'--project',project);
  add(args,'--status',status);
  add(args,'--workspace-mode',workspace_mode);
  return args;
}

export function readArgs({ thread, detail, turns, max_chars, last_turn, first_turn } = {}) {
  const args = ['threads','read','--thread',thread];
  add(args,'--detail',detail);
  add(args,'--turns',turns);
  add(args,'--max-chars',max_chars);
  addBool(args,'--last-turn',last_turn);
  addBool(args,'--first-turn',first_turn);
  return args;
}

export function createArgs({ cwd, workspace_mode, project_policy, open, provider, model, speed_mode, thinking_effort, env_mode, permission, interaction_mode, options, wait, timeout, detail, max_chars } = {}) {
  const args = ['threads','create','--stdin','--open',open ?? 'none'];
  add(args,'--cwd',cwd);
  add(args,'--workspace-mode',workspace_mode);
  add(args,'--project-policy',project_policy);
  add(args,'--provider',provider);
  add(args,'--model',model);
  add(args,'--speed-mode',speed_mode);
  add(args,'--thinking-effort',thinking_effort);
  add(args,'--env-mode',env_mode);
  add(args,'--permission',permission);
  add(args,'--interaction-mode',interaction_mode);
  for (const option of options ?? []) add(args,'--option',option);
  addBool(args,'--wait',wait);
  add(args,'--timeout',timeout);
  add(args,'--detail',detail);
  add(args,'--max-chars',max_chars);
  return args;
}

export function threadSendArgs({ thread, if_busy, provider, model, speed_mode, thinking_effort, permission, interaction_mode, options, wake_settled, wait, timeout, detail, max_chars } = {}) {
  const args = ['threads','send','--thread',thread,'--stdin'];
  add(args,'--if-busy',if_busy);
  add(args,'--provider',provider);
  add(args,'--model',model);
  add(args,'--speed-mode',speed_mode);
  add(args,'--thinking-effort',thinking_effort);
  add(args,'--permission',permission);
  add(args,'--interaction-mode',interaction_mode);
  for (const option of options ?? []) add(args,'--option',option);
  addBool(args,'--wake-settled',wake_settled);
  addBool(args,'--wait',wait);
  add(args,'--timeout',timeout);
  add(args,'--detail',detail);
  add(args,'--max-chars',max_chars);
  return args;
}

export function waitArgs({ thread, timeout, detail, max_chars } = {}) {
  const args = ['threads','wait','--thread',thread];
  add(args,'--timeout',timeout);
  add(args,'--detail',detail);
  add(args,'--max-chars',max_chars);
  return args;
}

// Metadata requires a CLI supporting threads inspect. Never fall back to a
// transcript read: its truncation happens after fetching the whole history.
export async function inspectMetadata(threadId, invoke=callT3) {
  try { return await invoke(['threads','inspect','--thread',threadId]); }
  catch(error) { throw new Error('T3 metadata lookup requires supported threads inspect: '+safeDiagnostic(error.message,2000),{cause:error}); }
}
export async function inspectThread(threadId, environmentId) {
  const data=await inspectMetadata(threadId);
  if (!data?.thread || data.thread.id!==threadId || data.thread.deletedAt ||
      !environmentId || !data.runtime?.environmentId || data.runtime.environmentId!==environmentId) return {state:'unavailable'};
  return classifyThread(data.thread);
}
export function classifyThread(thread) {
  if(thread.deletedAt) return {state:'deleted'};
  if(thread.archivedAt) return {state:'archived'};
  if(['stopped','cancelled','canceled','failed'].includes(thread.latestRun?.status)) return {state:'stopped'};
  if(['stopped','settled','archived','deleted','cancelled','canceled'].includes(thread.status)) return {state:thread.status};
  if(thread.status==='active') return {state:'active'};
  return {state:'uncertain_lifecycle'};
}

// Only a positive marker confirms delivery; an absent marker always leaves the outcome unproved.
export async function reconcileMarker(threadId, environmentId, eventId) {
  if(!threadId||!environmentId||!eventId) return {state:'ambiguous',reason:'thread, environment or event binding unavailable'};
  const data=await callT3(['threads','read','--thread',threadId,'--detail','messages']);
  if (!data.thread || data.thread.id!==threadId || data.thread.deletedAt || !environmentId || data.runtime?.environmentId!==environmentId) return {state:'ambiguous',reason:'thread or environment changed'};
  const messages=data.thread.messages;
  if (!Array.isArray(messages)) return {state:'ambiguous',reason:'transcript messages unavailable'};
  if (messages.some(message=>message.role==='user' && !message.textTruncated && typeof message.text==='string' && message.text.includes(marker(eventId)))) return {state:'confirmed'};
  return {state:'ambiguous',reason:data.thread.view?.omittedTurns||messages.some(m=>m.textTruncated)?'transcript incomplete':'marker absent; send outcome unproved'};
}

export async function deliverT3(threadId, environmentId, eventId, message) {
  const target=await inspectThread(threadId,environmentId);
  if (target.state!=='active') return {state:'definite_failure',reason:`thread ${target.state}`};
  try { await callT3(sendArgs(threadId),message); return {state:'confirmed'}; }
  catch (error) { return {state:'ambiguous',reason:safeDiagnostic(error.message,2000)}; }
}
