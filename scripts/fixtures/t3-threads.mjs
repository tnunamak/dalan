// Synthetic `t3code --json threads list` data for exercising compact output with large inputs.
const uuid=n=>{const h=(n*2654435761>>>0).toString(16).padStart(8,'0');return `${h}-${h.slice(0,4)}-4${h.slice(1,4)}-8${h.slice(4,7)}-${h}${h.slice(0,4)}`;};
const word=n=>['review','fix','dot','bridge','lane','check','sync','plan','audit','deploy','trace','docs'][n%12];
export function syntheticThreadList(count=512,{projects=8}={}) {
  const projectList=Array.from({length:projects},(_,i)=>({id:uuid(9000+i),title:`project-${word(i)}-${i}`,workspaceRoot:`/home/user/code/project-${i}`,
    repositoryIdentity:{canonicalKey:`github.com/example-org/example-repo-${i}`,locator:{source:'git-remote',remoteName:'origin',remoteUrl:`git@github.com:example-org/example-repo-${i}.git`},rootPath:`/home/user/code/project-${i}`},
    defaultModelSelection:{instanceId:'claudeAgent',model:'claude-opus-4-1'},defaultThreadEnvMode:'local',autoPull:false,faviconPath:null,projectIcon:null,scripts:[],createdAt:'2000-01-01T00:00:00.000Z',updatedAt:'2000-01-02T00:00:00.000Z'}));
  const base=Date.parse('2000-01-03T12:00:00.000Z');
  const threads=Array.from({length:count},(_,i)=>{
    const long=i%10<7, segment=`%3A${word(i)}${'x'.repeat(i%9)}`;
    const id=long?`thread:delegate:parentThread:${uuid(i)}-${word(i+1)}${segment.repeat(8+i%10)}%253A${uuid(i+1)}`.slice(0,208+(i%5)*30):`mcp:${uuid(i)}`;
    const at=new Date(base-i*97000-(i%7)*3600000).toISOString();
    return {createdBy:'agent',creationSource:'delegate',id,projectId:projectList[i%projects].id,title:`${word(i)} ${word(i+3)} thread ${i} `.padEnd(20+(i*7)%53,'t'),
      providerInstanceId:'claudeAgent',modelSelection:{instanceId:'claudeAgent',model:'claude-opus-4-1'},runtimeMode:'full-access',interactionMode:'default',
      branch:i%4===0?`feature/${word(i)}-${i}`:null,worktreePath:i%11===0?`/home/user/.t3/worktrees/project-${i%projects}/${word(i)}-${i}-worktree`:null,
      linkedPullRequest:null,pullRequests:i%9===0?[{number:i,url:`https://github.com/org/project/pull/${i}`,state:'open'}]:[],
      lineage:{parentThreadId:uuid(i+7),relationshipToParent:'delegate',rootThreadId:uuid(i+11)},forkedFrom:{type:'node',nodeId:`node:${uuid(i)}:${uuid(i+2)}`.slice(0,62)},
      activeProviderThreadId:i%5===0?`provider-thread-${uuid(i)}-${uuid(i+3)}`:null,latestRunId:`run:${uuid(i)}`,latestRunRequestedAt:at,latestRunStartedAt:at,latestRunCompletedAt:at,
      activeRunId:i%17===0?`run:${uuid(i)}`:null,activityRunStartedAt:i%17===0?at:null,activityRunStatus:i%17===0?'running':null,status:'active',lastError:null,lastErrorClass:null,
      usageLimitResetAt:null,pendingRuntimeRequest:i%23===0?{id:`req:${uuid(i)}`,kind:'approval',createdAt:at}:null,latestVisibleMessage:null,latestUserMessageAt:at,
      latestUserAuthoredMessageAt:null,hasActionableProposedPlan:false,pendingBackgroundTasks:[],providerInstanceHistory:[],goal:null,itemCount:40+i%300,visibleItemCount:30+i%200,
      createdAt:'2000-01-02T00:00:00.000Z',updatedAt:at,archivedAt:null,settledOverride:null,settledAt:null,unsettledAt:i%3===0?at:null,snoozedUntil:null,snoozedAt:null,
      limitRecovery:{requestId:`limit-recovery:${uuid(i)}:${uuid(i+1)}:${uuid(i+2)}`.padEnd(120,'0'),runId:`run:${uuid(i)}:${uuid(i+5)}`.slice(0,59),resetAt:at,autoResume:true,snooze:false},
      pinnedAt:i%6===0?at:null,autoSettleDisabledAt:null,pinOrderKey:'a',lastVisitedAt:null,titleRegeneration:null,deletedAt:null,runStatus:['idle','completed','running','interrupted','cancelled'][i%5],
      branchPullRequest:null,activeOrderKey:'a',historyOrigin:null};
  });
  return {runtime:{origin:'http://127.0.0.1:3773',environmentId:uuid(1)},auth:{source:'server'},snapshotSequence:1,filter:{status:'active',projectId:null,workspaceRoot:null},projects:projectList,threads};
}
