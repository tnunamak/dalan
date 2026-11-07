import { callT3, listArgs, readArgs, createArgs, threadSendArgs, waitArgs } from './t3.mjs';

const seconds = ms => Math.max(1, Math.min(115, Math.ceil((ms ?? 120000) / 1000)));

function setArgs(a) {
  const args=['threads','set','--thread',a.threadId];
  for (const [flag,value] of [
    ['--provider',a.provider],
    ['--model',a.model],
    ['--thinking-effort',a.thinkingEffort],
    ['--permission',a.permission],
    ['--interaction-mode',a.interactionMode],
    ['--speed-mode',a.speedMode]
  ]) if(value) args.push(flag,String(value));
  for (const option of a.options ?? []) args.push('--option', String(option));
  return args;
}

function idsFrom(value) {
  const thread=value?.thread, project=value?.project, message=value?.message;
  const addUnique=(array,item)=>{ if(item&&!array.includes(item)) array.push(item); };
  const ids={threadIds:[],projectIds:[],runIds:[],messageIds:[]};
  addUnique(ids.threadIds,thread?.id);
  addUnique(ids.projectIds,project?.id ?? thread?.projectId);
  addUnique(ids.messageIds,message?.messageId);
  addUnique(ids.runIds,thread?.activeRun?.runId ?? thread?.latestRun?.runId);
  for (const item of value?.threads ?? []) {
    addUnique(ids.threadIds,item.id);
    addUnique(ids.projectIds,item.projectId);
    addUnique(ids.runIds,item.activeRun?.runId ?? item.latestRun?.runId);
  }
  for (const item of value?.projects ?? []) addUnique(ids.projectIds,item.id);
  for (const item of thread?.turns ?? []) {
    addUnique(ids.runIds,item.runId);
    addUnique(ids.messageIds,item.finalMessageId);
  }
  return Object.fromEntries(Object.entries(ids).filter(([,items])=>items.length));
}

function withIds(data) { return {...data, _audit_ids: idsFrom(data)}; }

// `t3code threads list` can return large records. The worker polls it, so the list returns the newest threads (updatedAt desc)
// in a compact shape: at most `limit` entries and at most `budget` bytes of serialized thread entries, plus total and
// per-project counts.
export const THREAD_LIST_LIMIT=50, THREAD_LIST_BUDGET=16000;
const PROJECT_LIMIT=20, TITLE_MAX=120, SHORT_MAX=80;
const clip=(text,max)=>typeof text==='string'&&text.length>max?text.slice(0,max-1)+'\u2026':text??null;
const short=text=>typeof text==='string'&&text&&text.length<=SHORT_MAX?text:undefined;
const compactThread=t=>({id:t.id,title:clip(t.title,TITLE_MAX),projectId:t.projectId??null,status:t.status??null,runStatus:t.runStatus??null,
  ...(t.activityRunStatus!=null?{activityRunStatus:t.activityRunStatus}:{}),updatedAt:t.updatedAt??null,latestUserMessageAt:t.latestUserMessageAt??null,
  pendingRuntimeRequest:t.pendingRuntimeRequest!=null&&t.pendingRuntimeRequest!==false,branch:short(t.branch),worktreePath:short(t.worktreePath)});
export function compactThreadList(data,{limit=THREAD_LIST_LIMIT,budget=THREAD_LIST_BUDGET}={}) {
  const threads=(Array.isArray(data?.threads)?data.threads:[]).toSorted((a,b)=>String(b.updatedAt??'').localeCompare(String(a.updatedAt??''))||String(a.id).localeCompare(String(b.id)));
  const shown=[];
  for(let i=0,used=0;i<threads.length&&shown.length<limit;i++) {
    const entry=compactThread(threads[i]), bytes=Buffer.byteLength(JSON.stringify(entry))+1;
    if(shown.length&&used+bytes>budget) break;
    shown.push(entry); used+=bytes;
  }
  const titles=new Map((Array.isArray(data?.projects)?data.projects:[]).map(p=>[p.id,p.title]));
  const counts=new Map();
  for(const t of threads) counts.set(t.projectId??null,(counts.get(t.projectId??null)??0)+1);
  const projects=[...counts].sort((a,b)=>b[1]-a[1]||String(a[0]).localeCompare(String(b[0]))).slice(0,PROJECT_LIMIT).map(([id,count])=>({id,title:clip(titles.get(id),TITLE_MAX),count}));
  return {threads:shown,total:threads.length,shown:shown.length,truncated:threads.length>shown.length,projects,...(counts.size>projects.length?{projects_total:counts.size}:{}),
    hint:'narrow with projectId or cwd; full paging after a catalog update'};
}

async function cwdForProject(a) {
  if (!a.projectId) return a.cwd;
  const data = await callT3(['projects','list']);
  const project = data.projects?.find(item => item.id === a.projectId);
  if (!project) throw new Error('project not found');
  if (a.cwd && a.cwd !== project.workspaceRoot) throw new Error('projectId and cwd disagree');
  return project.workspaceRoot;
}

export async function runT3Tool(name, a) {
  switch(name) {
    case 't3_thread_list':
      return withIds(compactThreadList(await callT3(listArgs({cwd:a.cwd,project:a.projectId,status:a.status,workspace_mode:a.workspaceMode}))));
    case 't3_thread_read':
      return withIds(await callT3(readArgs({thread:a.threadId,detail:a.detail??'messages',turns:a.turns??20,first_turn:a.firstTurn,max_chars:a.maxChars??12000})));
    case 't3_thread_create':
      return withIds(await callT3(createArgs({cwd:await cwdForProject(a),workspace_mode:a.workspaceMode,project_policy:a.projectPolicy,open:a.open,provider:a.provider,model:a.model,speed_mode:a.speedMode,thinking_effort:a.thinkingEffort,env_mode:a.environmentMode,permission:a.permission,interaction_mode:a.interactionMode,options:a.options,wait:false,detail:'answers',max_chars:4000}),a.prompt));
    case 't3_thread_send':
      return withIds(await callT3(threadSendArgs({thread:a.threadId,if_busy:a.mode??'queue',provider:a.provider,model:a.model,speed_mode:a.speedMode,thinking_effort:a.thinkingEffort,permission:a.permission,interaction_mode:a.interactionMode,options:a.options,wake_settled:a.wakeSettled,wait:false,detail:'answers',max_chars:4000}),a.message));
    case 't3_thread_wait': {
      const timeout=seconds(a.timeoutMs);
      try {
        return withIds(await callT3(waitArgs({thread:a.threadId,timeout,detail:a.detail??'answers',max_chars:a.maxChars??12000}),'',{timeoutMs:timeout*1000}));
      } catch(error) {
        if(error.t3ErrorCode!=='THREAD_WAIT_TIMEOUT' && !error.message.startsWith('t3code timeout after ')) throw error;
        const partial=await callT3(readArgs({thread:a.threadId,detail:a.detail??'answers',turns:1,max_chars:a.maxChars??12000}),'',{timeoutMs:5000});
        return withIds({still_running:true,timeout_seconds:timeout,partial,error:error.message});
      }
    }
    case 't3_thread_set':
      return withIds(await callT3(setArgs(a)));
    default:
      throw new Error('unknown t3 tool');
  }
}
