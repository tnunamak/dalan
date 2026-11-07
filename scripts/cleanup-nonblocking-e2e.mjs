#!/usr/bin/env node
// Workspace cleanup must not stall the server. Seeds a large expired cleanup (real worktrees from a
// local bare mirror, read-only dependency caches with thousands of files, hundreds of expired
// artifacts), starts the real server, and polls the admin socket /status while the cleanup runs.
// Proves listen-first (the first /status sees nothing removed yet) and overlap (polls answer while
// rows are mid-removal), with a latency bound on every poll.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';import {spawn,spawnSync} from 'node:child_process';import {randomUUID} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
import { readLines } from '../src/request-log.mjs';
const assert=(v,m)=>{if(!v)throw new Error(m);};
// A disk-backed directory is used because /tmp may be tmpfs and 120k cache files do not belong in RAM.
const scratch=path.join(os.homedir(),'.tmp');fs.mkdirSync(scratch,{recursive:true});
const home=fs.mkdtempSync(path.join(scratch,'dalan-bridge-cleanup-')),root=path.join(home,'work'),repo=path.join(home,'repo'),config=path.join(home,'.config/dot-bridge'),data=path.join(home,'.local/share/dot-bridge');
process.env.DOT_BRIDGE_WORKSPACE_ROOT=root;
const {mirrorPath}=await import('../src/projects.mjs'),{Store}=await import('../src/store.mjs');
const smoke=process.env.DOT_BRIDGE_TEST_CLEANUP_PROFILE==='smoke';
const WORKSPACES=smoke?2:40,CACHE_DIRS=smoke?2:30,FILES_PER_DIR=smoke?3:100,ARTIFACTS=smoke?4:400;
console.log(JSON.stringify({profile:smoke?'smoke':'stress',cache_files:(WORKSPACES+2)*CACHE_DIRS*FILES_PER_DIR}));
// The cleanup yields at most every ~50 ms. Keep /status responsive while a large cleanup is in progress:
// the 95th percentile must stay under 250 ms and the worst poll under 1 s.
const P95_STATUS_MS=250,MAX_STATUS_MS=1000;
function run(cmd,args,cwd){const r=spawnSync(cmd,args,{cwd,encoding:'utf8'});if(r.status!==0)throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);return r.stdout.trim();}
let service;
try {
  fs.mkdirSync(repo,{recursive:true});fs.mkdirSync(config,{recursive:true});fs.mkdirSync(data,{recursive:true});
  run('git',['init','-q'],repo);run('git',['config','user.email','test@example.com'],repo);run('git',['config','user.name','Test'],repo);
  for(let i=0;i<200;i++) fs.writeFileSync(path.join(repo,`file${i}.txt`),`line ${i}\n`);
  run('git',['add','.'],repo);run('git',['commit','-qm','base'],repo);const base=run('git',['rev-parse','HEAD'],repo);
  const mirror=mirrorPath('example-owner/fixture');fs.mkdirSync(path.dirname(mirror),{recursive:true});run('git',['clone','-q','--bare',repo,mirror]);
  for(const dir of ['worktrees','artifacts','caches']) fs.mkdirSync(path.join(root,dir),{recursive:true,mode:0o700});
  const store=new Store(path.join(data,'bridge.db')),db=store.db,old=new Date(Date.now()-7*3600000).toISOString(),recent=new Date(Date.now()-3600000).toISOString(),now=new Date().toISOString();
  const seed=(status,terminalAt)=>{
    const id=`req_${randomUUID()}`,claim=`claim_${randomUUID()}`,dir=path.join(root,'worktrees',id);
    store.submit({schema_version:1,request_id:id,brief:'cleanup seed',inputs:[{github_repo:'example-owner/fixture',base_sha:base}],expected_output:'patch',execution_scope:'implementation'},'thread','env','owner');
    if(status==='cancelled') db.prepare("UPDATE assignments SET status='cancelled',cancelled_at=? WHERE request_id=?").run(terminalAt,id);
    if(status==='finished') { db.prepare("UPDATE assignments SET status='finished' WHERE request_id=?").run(id);db.prepare("INSERT INTO reports(request_id,claim_id,outcome,summary,result,receipt_id,created_at) VALUES(?,?,'completed','s','r',?,?)").run(id,claim,`rcpt_${randomUUID()}`,terminalAt); }
    if(status==='claimed') db.prepare("UPDATE assignments SET status='claimed' WHERE request_id=?").run(id);
    run('git',['-C',mirror,'worktree','add','-q','--detach',dir,base]);
    db.prepare('INSERT INTO workspaces(request_id,claim_id,base_sha,path,created_at) VALUES(?,?,?,?,?)').run(id,claim,base,dir,old);
    return id;
  };
  const expired=Array.from({length:WORKSPACES},(_,i)=>seed(i%2?'cancelled':'finished',old));
  const keepRecent=seed('cancelled',recent),keepActive=seed('claimed',null);
  // Go/uv module caches are read-only trees; removal needs chmod first.
  for(const id of [...expired,keepRecent,keepActive]) for(let d=0;d<CACHE_DIRS;d++) {
    const dir=path.join(root,'caches',id,'mod',`pkg${d}`);fs.mkdirSync(dir,{recursive:true});
    for(let f=0;f<FILES_PER_DIR;f++) fs.writeFileSync(path.join(dir,`f${f}.go`),'package x\n');
    fs.chmodSync(dir,0o555);
  }
  const addArtifact=(retention)=>{const id=`art_${randomUUID()}`,file=path.join(root,'artifacts',id);fs.writeFileSync(file,'x');db.prepare("INSERT INTO artifacts(id,request_id,claim_id,kind,path,size,sha256,sealed,created_at,retention_until) VALUES(?,?,'c','check-output',?,1,NULL,1,?,?)").run(id,expired[0],file,old,retention);return file;};
  const expiredArtifacts=Array.from({length:ARTIFACTS},()=>addArtifact(old)),keptArtifact=addArtifact(new Date(Date.now()+86400000).toISOString());
  db.close();
  fs.writeFileSync(path.join(config,'oauth.env'),'OAUTH_ISSUER=http://127.0.0.1:9/realm\nOAUTH_AUDIENCE=https://dot-bridge.example.test\nOAUTH_JWKS_URI=http://127.0.0.1:9/jwks\nOAUTH_ALLOWED_SUBJECTS=dot\n',{mode:0o600});

  const reader=new DatabaseSync(path.join(data,'bridge.db'));reader.exec('PRAGMA busy_timeout=5000');
  const expiredLeft=()=>reader.prepare(`SELECT COUNT(*) n FROM workspaces WHERE request_id IN (${expired.map(()=>'?').join(',')})`).get(...expired).n;
  const socket=path.join(data,'admin.sock');
  const status=()=>new Promise((resolve,reject)=>{const started=performance.now();const req=http.request({socketPath:socket,path:'/status',agent:false,timeout:10000},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>res.statusCode===200?resolve(performance.now()-started):reject(new Error(`/status ${res.statusCode} ${body}`)));});req.on('timeout',()=>req.destroy(new Error('/status timed out')));req.on('error',reject);req.end();});
  const env={...process.env,HOME:home,DOT_BRIDGE_PORT:'0',DOT_BRIDGE_AUTH_MODE:'oauth',DOT_BRIDGE_TEST_OAUTH:'1',DOT_BRIDGE_ENABLE_WORKSPACE:'1',DOT_BRIDGE_T3_DRY_RUN:'1',DOT_BRIDGE_WORKSPACE_ROOT:root,DOT_BRIDGE_MIN_FREE_BYTES:'0'};
  // Pressure eviction (below DOT_BRIDGE_MIN_FREE_BYTES) would also remove the recent row this test keeps; the host's free space must not matter.
  const spawnedAt=performance.now();
  service=spawn(process.execPath,['src/server.mjs'],{cwd:path.resolve(new URL('..',import.meta.url).pathname),env,stdio:['ignore','ignore','pipe']});
  let stderr='';service.stderr.on('data',b=>{stderr+=b;});

  // Before listen the socket is absent or refuses; those attempts are not latency samples.
  let firstAnswerMs;
  while(firstAnswerMs===undefined) {
    assert(service.exitCode===null,`server exited: ${stderr}`);
    assert(performance.now()-spawnedAt<60000,'admin socket never answered /status');
    try{await status();firstAnswerMs=performance.now()-spawnedAt;}catch(e){if(!['ENOENT','ECONNREFUSED'].includes(e.code))throw e;await new Promise(r=>setTimeout(r,10));}
  }
  const leftAtFirstAnswer=expiredLeft();
  assert(leftAtFirstAnswer===WORKSPACES,`listen-first: /status first answered after cleanup removed ${WORKSPACES-leftAtFirstAnswer}/${WORKSPACES} workspaces (${Math.round(firstAnswerMs)} ms after spawn)`);

  const latencies=[],during=[];let left=WORKSPACES;const pollStart=performance.now();
  while(left>0) {
    assert(performance.now()-pollStart<180000,`cleanup did not finish; ${left} expired workspaces left`);
    const ms=await status();latencies.push(ms);
    left=expiredLeft();if(left>0&&left<WORKSPACES) during.push(ms);
    await new Promise(r=>setTimeout(r,20));
  }
  const max=Math.max(...latencies),maxDuring=during.length?Math.max(...during):NaN;
  console.log(`first /status ${Math.round(firstAnswerMs)} ms after spawn; ${latencies.length} polls, ${during.length} while workspaces were mid-removal; /status max ${max.toFixed(1)} ms (mid-removal max ${maxDuring.toFixed(1)} ms)`);
  // Overlap, not sequencing: /status answered while some, but not all, expired workspaces were gone.
  if(!smoke) assert(during.length>=10,`only ${during.length} /status polls overlapped the cleanup`);
  const p95=[...latencies].sort((a,b)=>a-b)[Math.floor(latencies.length*0.95)];
  if(!smoke) assert(p95<P95_STATUS_MS,`/status p95 latency ${p95.toFixed(1)} ms during cleanup exceeds ${P95_STATUS_MS} ms`);
  if(!smoke) assert(max<MAX_STATUS_MS,`/status max latency ${max.toFixed(1)} ms during cleanup exceeds ${MAX_STATUS_MS} ms`);

  // The summary is logged after the last row; wait for it, then check the end state.
  const logFile=path.join(home,'.local/state/dot-bridge/requests.jsonl');let summary;
  for(let i=0;i<200&&!summary;i++){summary=[...readLines(logFile,{missingOk:true})].filter(Boolean).map(JSON.parse).find(x=>x.kind==='workspace_cleanup');if(!summary)await new Promise(r=>setTimeout(r,50));}
  assert(summary&&summary.workspaces_removed===WORKSPACES&&summary.artifacts_removed===ARTIFACTS&&summary.errors===0,`cleanup summary ${JSON.stringify(summary)}`);
  for(const id of expired) assert(!fs.existsSync(path.join(root,'worktrees',id))&&!fs.existsSync(path.join(root,'caches',id)),`expired workspace ${id} left on disk`);
  assert(!run('git',['-C',mirror,'worktree','list','--porcelain'],home).split('\n').some(line=>expired.some(id=>line.endsWith(id))),'mirror still lists removed worktrees');
  assert(expiredArtifacts.every(file=>!fs.existsSync(file))&&reader.prepare('SELECT COUNT(*) n FROM artifacts').get().n===1&&fs.existsSync(keptArtifact),'artifact retention');
  for(const id of [keepRecent,keepActive]) assert(fs.existsSync(path.join(root,'worktrees',id))&&reader.prepare('SELECT 1 FROM workspaces WHERE request_id=?').get(id),`ineligible workspace ${id} removed`);
  // A terminal job's cache goes at once (it serves only a claimed job's checks); its worktree waits out the retention.
  assert(!fs.existsSync(path.join(root,'caches',keepRecent))&&fs.existsSync(path.join(root,'caches',keepActive)),'cache of a recent terminal job kept, or of an active job removed');
  reader.close();
  console.log(smoke?'PASS cleanup smoke: listen-first, retention and removal (not a latency gate)':'PASS cleanup runs after listen and never stalls the admin socket');
} finally {
  if(service&&service.exitCode===null){service.kill('SIGTERM');await new Promise(r=>service.once('exit',r));}
  spawnSync('chmod',['-R','u+w',home]);fs.rmSync(home,{recursive:true,force:true});
}
