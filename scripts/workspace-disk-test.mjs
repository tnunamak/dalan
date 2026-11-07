#!/usr/bin/env node
import './require-host-checks.mjs';
// Workspace disk growth: per-repo npm content store, fetch-based eviction, disk-pressure guard, mirror eviction.
// Uses a throwaway workspace root on a disk-backed path, real git mirrors and worktrees, the real sandbox for the sharing
// checks, and the real server for the /get?peek=1 journey. Free space is injected, never the host's.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';import {spawn,spawnSync} from 'node:child_process';import {randomUUID,createHash} from 'node:crypto';
const assert=(v,m)=>{if(!v)throw new Error(m);};
const scratch=path.join(os.homedir(),'.tmp');fs.mkdirSync(scratch,{recursive:true});
const home=fs.mkdtempSync(path.join(scratch,'dalan-bridge-wsdisk-')),root=path.join(home,'work'),config=path.join(home,'.config/dot-bridge'),data=path.join(home,'.local/share/dot-bridge');
process.env.HOME=home;process.env.DOT_BRIDGE_WORKSPACE_ROOT=root;
const {Store}=await import('../src/store.mjs'),{Workspace}=await import('../src/workspace.mjs'),{mirrorPath}=await import('../src/projects.mjs'),{parseWorkers}=await import('../src/workers.mjs');
const run=(cmd,args,cwd)=>{const r=spawnSync(cmd,args,{cwd,encoding:'utf8'});if(r.status!==0)throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);return r.stdout.trim();};
const HOUR=3600000,GIB=2**30,sleep=ms=>new Promise(r=>setTimeout(r,ms));
let service;
try {
  fs.mkdirSync(config,{recursive:true});fs.mkdirSync(data,{recursive:true});
  const repos={};
  for(const [name,envName] of [['fixture','FIXTURE'],['other','OTHER'],['stale','STALE']]) {
    const dir=path.join(home,`repo-${name}`);fs.mkdirSync(dir);run('git',['init','-q'],dir);run('git',['config','user.email','t@example.com'],dir);run('git',['config','user.name','T'],dir);
    fs.writeFileSync(path.join(dir,'a.txt'),'a\n');run('git',['add','.'],dir);run('git',['commit','-qm','base'],dir);
    repos[name]={full:`example-owner/${name}`,base:run('git',['rev-parse','HEAD'],dir)};process.env[`DALAN_GITHUB_URL_EXAMPLE_OWNER_${envName}`]=dir;
  }
  const workers=parseWorkers({workers:{dot:{capabilities:[]},lark:{capabilities:[]}},default_execution:'host'},{builtin:true});
  const store=new Store(path.join(data,'bridge.db'),{workers}),db=store.db;
  let free=100*GIB;process.env.DOT_BRIDGE_MIN_FREE_BYTES=String(30*GIB);
  const ws=new Workspace(store,true,{freeBytes:async()=>free});
  const caches=path.join(root,'caches'),shared=path.join(caches,'shared/npm'),exists=p=>fs.existsSync(p);
  const claims={};
  // An assignment with a checked-out workspace. Terminal ones finish at `ageMs` ago.
  const targets={};
  async function make(repo,{terminal=null,ageMs=0,targetWorker='dot'}={}) {
    const id=`req_${randomUUID()}`;
    const payload={schema_version:1,request_id:id,brief:'disk',inputs:[{github_repo:repos[repo].full,base_sha:repos[repo].base}],expected_output:'patch',execution_scope:'implementation'};
    store.submit(payload,'thread','env','owner',false,null,'normal',null,payload,null,targetWorker);
    targets[id]=targetWorker;claims[id]=store.claim(id,'dot','subject',99,null,targetWorker).claim_id;ws.ensure(id,claims[id],'subject',false,targetWorker);
    if(terminal) {
      const at=new Date(Date.now()-ageMs).toISOString();
      if(terminal==='finished') { db.prepare("UPDATE assignments SET status='finished' WHERE request_id=?").run(id);db.prepare("INSERT INTO reports(request_id,claim_id,outcome,summary,result,receipt_id,created_at) VALUES(?,?,'completed','s','r',?,?)").run(id,claims[id],`rcpt_${randomUUID()}`,at); }
      else db.prepare("UPDATE assignments SET status='cancelled',cancelled_at=? WHERE request_id=?").run(at,id);
    }
    fs.mkdirSync(path.join(caches,id,'npm'),{recursive:true});fs.writeFileSync(path.join(caches,id,'npm/private'),'x');
    return id;
  }
  const alive=id=>exists(path.join(root,'worktrees',id))||!!db.prepare('SELECT 1 FROM workspaces WHERE request_id=?').get(id);
  const gone=id=>!exists(path.join(root,'worktrees',id))&&!db.prepare('SELECT 1 FROM workspaces WHERE request_id=?').get(id)&&!exists(path.join(caches,id));

  // 1. The writable npm content store is shared only by the same worker and exact repository identity.
  {
    const [a1,a2,a3,b1]=[await make('fixture'),await make('fixture',{targetWorker:'lark'}),await make('fixture'),await make('other')];
    for(const id of [a1,a2,a3,b1]) {
      const w=path.join(root,'worktrees',id);
      const peerGuard=id===a2?`if(fs.existsSync('/cache/npm/_cacache/mark-${a1}'))process.exit(41);`:id===a3?`if(!fs.existsSync('/cache/npm/_cacache/mark-${a1}'))process.exit(43);`:'';
      const code=`const fs=require('node:fs');${peerGuard}fs.mkdirSync('/cache/npm/_cacache',{recursive:true});fs.writeFileSync('/cache/npm/_cacache/mark-${id}','1');fs.mkdirSync('/cache/npm/_npx',{recursive:true});fs.writeFileSync('/cache/npm/_npx/npx-${id}','1');fs.writeFileSync('/cache/xdg-${id}','1')`;
      fs.writeFileSync(path.join(w,'.dot-bridge.json'),JSON.stringify({checks:{default:{install_argv:['/runtime/node','-e',code],argv:['/runtime/node','-e','0'],timeout_ms:10000,output_bytes:4096}}}));
      // The shared content store is writable in the install phase only (the check phase mounts it read-only).
      const r=await ws.check(id,claims[id],'subject','default',targets[id]);assert(r.exit_code===0,`worker cache check failed for ${id}: exit=${r.exit_code}`);
    }
    const key=(worker,repo)=>`w-${createHash('sha256').update(worker).digest('hex')}-r-${createHash('sha256').update(repo).digest('hex')}`;
    const dotFixture=path.join(shared,key('dot',repos.fixture.full)),larkFixture=path.join(shared,key('lark',repos.fixture.full)),dotOther=path.join(shared,key('dot',repos.other.full));
    assert(exists(path.join(dotFixture,`mark-${a1}`))&&exists(path.join(dotFixture,`mark-${a3}`)),'same-worker checks may reuse the repository content store');
    assert(exists(path.join(larkFixture,`mark-${a2}`))&&!exists(path.join(larkFixture,`mark-${a1}`)),'another worker cannot read the first worker\'s cache bytes');
    assert(exists(path.join(dotOther,`mark-${b1}`))&&!exists(path.join(dotOther,`mark-${a1}`))&&!exists(path.join(dotFixture,`mark-${b1}`)),'different repository identities use different stores');
    for(const id of [a1,a2,a3,b1]) {
      assert(exists(path.join(caches,id,'npm/_npx',`npx-${id}`)),'_npx must be private');
      assert(!fs.readdirSync(path.join(caches,id,'npm/_npx')).some(f=>f!==`npx-${id}`),'_npx holds another assignment\'s files');
      assert(!exists(path.join(caches,id,'xdg-'+(id===a1?a2:id===a2?a1:id===a3?b1:a3))),'private XDG cache crossed assignments');
    }
    console.log('PASS npm cache bytes stay within a worker and exact repository; same-worker reuse remains');

    // Pressure cleanup preserves the active worker/repository cache and removes idle worker/repository stores.
    for(const id of [a1,a2,a3,b1]) db.prepare("UPDATE assignments SET status='cancelled',cancelled_at=? WHERE request_id=?").run(new Date().toISOString(),id);
    free=10*GIB;ws.activeChecks.add(a1);const s=await ws.sweepExpired(()=>{});ws.activeChecks.delete(a1);
    assert(exists(dotFixture)&&!exists(larkFixture)&&!exists(dotOther),'pressure cleanup keeps the active cache and drops idle worker/repo caches');
    assert(s.pressure&&s.shared_caches_removed===2,`pressure summary ${JSON.stringify(s)}`);
    free=100*GIB;
    for(const id of [a1,a2,a3,b1]) db.prepare("UPDATE assignments SET status='claimed',cancelled_at=NULL WHERE request_id=?").run(id);
    await ws.sweepExpired(()=>{});
    console.log('PASS pressure drops idle worker caches and spares an active check');
    for(const id of [a1,a2,a3,b1]) db.prepare("UPDATE assignments SET status='cancelled',cancelled_at=? WHERE request_id=?").run(new Date(Date.now()-7*HOUR).toISOString(),id);
    await ws.sweepExpired(()=>{});assert([a1,a2,a3,b1].every(gone),'retention eviction after 6 h');
  }

  // These distinct repository strings collided under slash-to-double-underscore encoding.
  {
    process.env.DOT_BRIDGE_GITHUB_URL_A__B_C=path.join(home,'repo-fixture');
    process.env.DOT_BRIDGE_GITHUB_URL_A_B__C=path.join(home,'repo-fixture');
    async function makeInput(full) {
      const id=`req_${randomUUID()}`,payload={schema_version:1,request_id:id,brief:'cache key collision',inputs:[{github_repo:full,base_sha:repos.fixture.base}],expected_output:'patch',execution_scope:'implementation'};
      store.submit(payload,'thread','env','owner',false,null,'normal',null,payload,null,'dot');targets[id]='dot';claims[id]=store.claim(id,'dot','subject',99,null,'dot').claim_id;ws.ensure(id,claims[id],'subject',false,'dot');return id;
    }
    const [collisionA,collisionB]=[await makeInput('a__b/c'),await makeInput('a/b__c')];
    const collisionAPath=path.join(root,'worktrees',collisionA),collisionBPath=path.join(root,'worktrees',collisionB);
    for(const [id,dir,peer] of [[collisionA,collisionAPath,null],[collisionB,collisionBPath,collisionA]]) {
      const guard=peer?`if(fs.existsSync('/cache/npm/_cacache/collision-marker'))process.exit(42);`:'';
      const code=`const fs=require('node:fs');${guard}fs.mkdirSync('/cache/npm/_cacache',{recursive:true});fs.writeFileSync('/cache/npm/_cacache/collision-marker','1')`;
      fs.writeFileSync(path.join(dir,'.dot-bridge.json'),JSON.stringify({checks:{default:{install_argv:['/runtime/node','-e',code],argv:['/runtime/node','-e','0'],timeout_ms:10000,output_bytes:4096}}}));
      const r=await ws.check(id,claims[id],'subject','default','dot');assert(r.exit_code===0,`repository key collision check failed for ${id}: exit=${r.exit_code}`);
    }
    const cacheFor=repo=>path.join(shared,`w-${createHash('sha256').update('dot').digest('hex')}-r-${createHash('sha256').update(repo).digest('hex')}`);
    assert(exists(path.join(cacheFor('a__b/c'),'collision-marker'))&&exists(path.join(cacheFor('a/b__c'),'collision-marker'))&&cacheFor('a__b/c')!==cacheFor('a/b__c'),'exact repository strings have distinct mounted cache sources');
    console.log('PASS exact repository identities have collision-free cache isolation');
  }

  // 2. Fetch-based eviction at the store level: peek counts for eviction but is not a 'consumed' event.
  {
    const fetched=await make('fixture',{terminal:'finished',ageMs:HOUR}),plain=await make('fixture',{terminal:'finished',ageMs:HOUR}),live=await make('fixture');
    store.recordFetched(live);
    assert(db.prepare('SELECT fetched_at FROM workspaces WHERE request_id=?').get(live).fetched_at===null,'a live row must not be marked fetched');
    store.recordFetched(fetched);
    assert(db.prepare("SELECT 1 FROM lifecycle_events WHERE request_id=? AND type='consumed'").get(fetched)===undefined,'a fetch must not record consumed');
    const s=await ws.sweepExpired(()=>{});
    assert(gone(fetched),'a fetched terminal row must be evicted with its private cache');
    assert(alive(plain),'a non-fetched terminal row must survive until retention');
    assert(!exists(path.join(caches,plain)),'a terminal row keeps its private cache: the cache serves only checks of a claimed assignment');
    assert(alive(live)&&exists(path.join(caches,live)),'live row or its cache evicted');
    assert(s.workspaces_removed===1,`removed ${s.workspaces_removed}`);
    // Orphan caches: no assignment row, or a terminal row whose workspace is already gone, go; a claimed one stays.
    const orphan=path.join(caches,'req_orphan_without_row');fs.mkdirSync(orphan,{recursive:true});fs.writeFileSync(path.join(orphan,'x'),'x');
    fs.mkdirSync(path.join(caches,'check-metadata-inuse'),{recursive:true});
    const s2=await ws.sweepExpired(()=>{});
    assert(!exists(orphan)&&exists(path.join(caches,live))&&exists(path.join(caches,'check-metadata-inuse'))&&exists(path.join(caches,'shared')),'orphan cache sweep');
    assert(s2.caches_removed>=1,`orphan caches counted: ${s2.caches_removed}`);
    fs.rmSync(path.join(caches,'check-metadata-inuse'),{recursive:true});
    console.log('PASS fetch (peek) evicts early; unfetched rows wait for retention without their cache; orphan caches go; consumed untouched');
    // Retention still applies to the unfetched row.
    db.prepare('UPDATE reports SET created_at=? WHERE request_id=?').run(new Date(Date.now()-7*HOUR).toISOString(),plain);
    await ws.sweepExpired(()=>{});assert(gone(plain),'retention (6 h) must evict an unfetched row');
    db.prepare("UPDATE assignments SET status='cancelled',cancelled_at=? WHERE request_id=?").run(new Date().toISOString(),live);store.recordFetched(live);await ws.sweepExpired(()=>{});assert(gone(live),'a fetched cancelled row must be evicted');
  }

  // 3. Pressure guard: oldest first, only until above the floor, active untouched, and a check before a new workspace.
  {
    const old=await make('fixture',{terminal:'finished',ageMs:5*HOUR}),mid=await make('other',{terminal:'cancelled',ageMs:3*HOUR}),young=await make('fixture',{terminal:'finished',ageMs:HOUR}),active=await make('fixture');
    // Floor is 30 GiB. Start at 10 GiB; each removed workspace frees 15 GiB (counted from rows left), so two removals clear the floor.
    ws.freeBytes=async()=>{const left=db.prepare("SELECT COUNT(*) n FROM workspaces WHERE request_id IN (?,?,?)").get(old,mid,young).n;return 10*GIB+(3-left)*15*GIB;};
    await ws.sweepExpired(()=>{});
    assert(gone(old)&&gone(mid),'oldest terminal workspaces must go first under pressure');
    assert(alive(young),'eviction must stop once free space is above the floor');
    assert(alive(active),'active workspace evicted');
    console.log('PASS pressure evicts oldest first until above the floor, never an active workspace');
    // makeRoom: a new workspace triggers the pressure sweep without waiting for the hourly tick.
    const fresh=`req_${randomUUID()}`;
    ws.freeBytes=async()=>db.prepare("SELECT 1 FROM workspaces WHERE request_id=?").get(young)?10*GIB:60*GIB;
    await ws.makeRoom(fresh);
    assert(gone(young),'makeRoom under pressure must evict before a new workspace is prepared');
    const before=db.prepare('SELECT COUNT(*) n FROM workspaces').get().n;await ws.makeRoom(fresh);assert(db.prepare('SELECT COUNT(*) n FROM workspaces').get().n===before,'makeRoom with room must change nothing');
    ws.freeBytes=async()=>free;free=100*GIB;
    db.prepare("UPDATE assignments SET status='cancelled',cancelled_at=? WHERE request_id=?").run(new Date(Date.now()-7*HOUR).toISOString(),active);await ws.sweepExpired(()=>{});assert(gone(active),'cleanup for next section');
    console.log('PASS the pressure check also runs before a new workspace');
  }

  // 4. Mirrors: evicted after 7 idle days, or under pressure when no active assignment uses them. Never when in use.
  {
    const mirrorOf=n=>mirrorPath(repos[n].full,{worker:'dot'}),marker=n=>path.join(mirrorOf(n),'dot-last-used');
    for(const n of ['fixture','other','stale']) if(!exists(mirrorOf(n))) { await make(n,{terminal:'cancelled',ageMs:7*HOUR});await ws.sweepExpired(()=>{}); }
    for(const n of ['fixture','other','stale']) assert(exists(mirrorOf(n)),`mirror ${n} missing`);
    // Markers start the clock; nothing is idle yet.
    await ws.sweepExpired(()=>{});
    for(const n of ['fixture','other','stale']) assert(exists(marker(n)),`no last-use marker for ${n}`);
    const past=(n,days)=>{const t=new Date(Date.now()-days*86400000);fs.utimesSync(marker(n),t,t);};
    const live=await make('fixture');             // fixture mirror is used by a live workspace
    past('fixture',30);past('other',8);past('stale',2);
    const s=await ws.sweepExpired(()=>{});
    assert(exists(mirrorOf('fixture')),'a mirror used by an active assignment was evicted');
    assert(!exists(mirrorOf('other')),'a mirror idle for 7+ days must be evicted');
    assert(exists(mirrorOf('stale')),'a mirror idle for 2 days must stay without pressure');
    assert(s.mirrors_removed===1,`mirrors_removed ${s.mirrors_removed}`);
    free=10*GIB;past('stale',3);
    await ws.sweepExpired(()=>{});
    assert(!exists(mirrorOf('stale')),'under pressure an unused mirror goes');
    assert(exists(mirrorOf('fixture')),'under pressure an in-use mirror went');
    assert(!fs.readdirSync(path.dirname(mirrorOf('fixture'))).some(f=>f.includes('.evicting-')),'tombstone left behind');
    free=100*GIB;
    // A used mirror refreshes its clock.
    past('fixture',30);ws.read(live,claims[live],'subject','a.txt');
    assert(Date.now()-fs.statSync(marker('fixture')).mtimeMs<60000,'use must refresh the mirror clock');
    console.log('PASS mirrors evicted after 7 idle days or under pressure, never while in use');
    db.prepare("UPDATE assignments SET status='cancelled',cancelled_at=? WHERE request_id=?").run(new Date(Date.now()-7*HOUR).toISOString(),live);await ws.sweepExpired(()=>{});
  }

  // 5. Real server: GET /get?peek=1 on a finished row makes its workspace evictable without recording 'consumed'.
  {
    const id=await make('fixture',{terminal:'finished',ageMs:HOUR}),other=await make('fixture',{terminal:'finished',ageMs:HOUR});
    db.close();
    fs.writeFileSync(path.join(config,'oauth.env'),'OAUTH_ISSUER=http://127.0.0.1:9/realm\nOAUTH_AUDIENCE=https://dot-bridge.example.test\nOAUTH_JWKS_URI=http://127.0.0.1:9/jwks\nOAUTH_ALLOWED_SUBJECTS=dot\n',{mode:0o600});
    const env={...process.env,HOME:home,DOT_BRIDGE_PORT:'0',DOT_BRIDGE_AUTH_MODE:'oauth',DOT_BRIDGE_TEST_OAUTH:'1',DOT_BRIDGE_ENABLE_WORKSPACE:'1',DOT_BRIDGE_T3_DRY_RUN:'1',DOT_BRIDGE_WORKSPACE_ROOT:root,DOT_BRIDGE_MIN_FREE_BYTES:'0'};
    service=spawn(process.execPath,['src/server.mjs'],{cwd:path.resolve(new URL('..',import.meta.url).pathname),env,stdio:['ignore','ignore','pipe']});
    let stderr='';service.stderr.on('data',b=>{stderr+=b;});
    const socket=path.join(data,'admin.sock');
    const get=(p)=>new Promise((resolve,reject)=>{const req=http.request({socketPath:socket,path:p,agent:false,headers:{'x-owner-capability':'owner'}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:b}));});req.on('error',reject);req.end();});
    let r;for(let i=0;i<200;i++){try{r=await get(`/get?id=${id}&peek=1`);break;}catch(e){assert(service.exitCode===null,`server exited: ${stderr}`);await sleep(50);}}
    assert(r?.status===200,`peek get ${r?.status} ${r?.body}`);
    const reader=new (await import('node:sqlite')).DatabaseSync(path.join(data,'bridge.db'));reader.exec('PRAGMA busy_timeout=5000');
    for(let i=0;i<200&&reader.prepare('SELECT 1 FROM workspaces WHERE request_id=?').get(id);i++) await sleep(50);
    assert(!reader.prepare('SELECT 1 FROM workspaces WHERE request_id=?').get(id)&&!exists(path.join(root,'worktrees',id))&&!exists(path.join(caches,id)),'peek read did not cause eviction by the live sweep');
    assert(reader.prepare("SELECT COUNT(*) n FROM lifecycle_events WHERE request_id=? AND type='consumed'").get(id).n===0,'peek read recorded consumed');
    assert(reader.prepare('SELECT 1 FROM workspaces WHERE request_id=?').get(other)&&exists(path.join(root,'worktrees',other)),'an unread row was evicted');
    reader.close();
    console.log('PASS live server: /get?peek=1 makes a finished workspace evictable, records no consumed');
  }
} finally {
  if(service&&service.exitCode===null){service.kill('SIGTERM');await new Promise(r=>service.once('exit',r));}
  spawnSync('chmod',['-R','u+w',home]);fs.rmSync(home,{recursive:true,force:true});
}
