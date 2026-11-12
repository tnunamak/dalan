import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {sign,randomUUID} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {parseWorkers} from '../src/workers.mjs';
import {routingPolicy} from '../src/pull-queue.mjs';
import {fixtureEnv} from '../src/test-support/fixture-env.mjs';
import {DotBridgeAdapter} from './conformance/adapter-dot-bridge.mjs';

const root=fs.mkdtempSync(path.join(os.homedir(),'.tmp','pull-queue-'));
const profile=parseWorkers({workers:{alpha:{repos:['acme/repo']},beta:{repos:['acme/repo']},stranger:{repos:[]}},default_execution:'worker'},{builtin:true});
const assignment=id=>({schema_version:1,request_id:id,brief:'Inspect the supplied text.',inputs:[],expected_output:'One report.',execution_scope:'read-only',valid_until:new Date(Date.now()+3600000).toISOString()});
const policy={version:1,allowed_workers:['alpha','beta'],fan_out:1};
const options={delivery:{mode:'none'},environmentId:'',execution:'worker',review:false,priority:'normal',meta:null};
const owner=randomUUID();
let store;
const put=(id,extra={},opts=options)=>{const payload={...assignment(id),...extra};return store.pullQueue.submit(payload,payload,opts,routingPolicy(policy,payload),{},owner);};
const admit=(worker,payload)=>{for(const input of payload.inputs)if(input.github_repo&&!profile.allowsRepo(worker,input.github_repo))throw new Error('repository denied');};
const acquire=(id,worker='alpha',extra={})=>store.pullQueue.acquire(id,{worker,subject:worker,connectionId:null,claimant:worker,acquisitionId:'acq_'+worker,capacity:50,preflight:null,admit,...extra});
const count=()=>store.db.prepare('SELECT count(*) n FROM assignments').get().n;
try {
  store=new Store(path.join(root,'store.db'),{workers:profile,capacity:50,destinationProfile:()=>profile});
  for(const failure of ['removed','revoked']) {
    const live={alpha:[randomUUID()],beta:[randomUUID()]};
    const connections={alpha:live.alpha[0],beta:live.beta[0]},owner=randomUUID();
    const profile=parseWorkers({workers:{alpha:{},beta:{}},default_execution:'worker'},{builtin:true,builtinConnectionIds:worker=>live[worker]??[]});
    let now=Date.now();
    const store=new Store(path.join(root,'manual-'+failure+'.db'),{workers:profile,destinationProfile:()=>profile,connectionIsLive:id=>Object.values(live).flat().includes(id),now:()=>now});
    const admit=worker=>{if(!profile.workers.has(worker)||!live[worker]?.length)throw new Error('worker unavailable');};
    const options={delivery:{mode:'none'},environmentId:'',execution:'worker',review:false,priority:'normal',meta:null};
    const create=(id,allowed)=>{
      const payload={schema_version:1,request_id:id,brief:'Read supplied text.',inputs:[],execution_scope:'read-only',expected_output:'One report.'};
      const routing=routingPolicy({version:1,allowed_workers:allowed,deadline_at:new Date(now+3600000).toISOString()},payload);
      return store.pullQueue.submit(payload,payload,options,routing,{},owner);
    };
    const acquire=(id,worker)=>store.pullQueue.acquire(id,{worker,subject:worker,connectionId:connections[worker],claimant:worker,acquisitionId:randomUUID(),capacity:10,leaseMs:1000,admit});
    try {
      const original='req_'+randomUUID(),replacement='req_'+randomUUID();create(original,['alpha','beta']);
      const first=acquire(original,'alpha');
      if(failure==='removed')profile.workers.delete('alpha');
      live.alpha=[];now+=1001;
      assert.ok(store.sweepStaleLeases().includes(original));
      store.owner(original,owner);store.cancel(original,'Owner replaces unavailable worker');
      assert.throws(()=>store.progress(original,first.claim_id,'Late progress','alpha',false,'alpha',null,null,connections.alpha),/invalid claim/);
      assert.throws(()=>store.finish(original,first.claim_id,'completed','Late','Late','alpha',null,'alpha',null,null,connections.alpha),/invalid claim/);
      create(replacement,['beta']);store.owner(replacement,owner);
      assert.ok(store.pullQueue.list('beta',admit).items.some(item=>item.request_id===replacement));
      const second=acquire(replacement,'beta');
      store.finish(replacement,second.claim_id,'completed','Read supplied text','Read supplied text','beta',null,'beta',null,null,connections.beta);
      assert.equal(store.get(original).status,'cancelled');assert.equal(store.get(original).report,null);
      assert.equal(store.get(replacement).status,'finished');
      store.decide(replacement,'accepted');assert.equal(store.ownerInbox(replacement).decision,'accepted');
      assert.equal(store.db.prepare('SELECT count(*) n FROM reports').get().n,1);
      console.log(`PASS ${failure} holder: owner cancels old order; fresh beta order completes once; old grant denied`);
    } finally {store.db.close();}
  }
  put('req_pull_basic');assert.equal(count(),0);
  assert.equal(store.pullQueue.list('stranger',admit).items.length,0);
  assert.throws(()=>store.pullQueue.get('req_pull_basic','stranger',admit),/assignment not found/);
  assert.throws(()=>acquire('req_pull_basic','stranger'),/assignment not found/);
  store.owner('req_pull_basic',owner);assert.throws(()=>store.owner('req_pull_basic','wrong'),/invalid owner/);
  assert.equal(store.get('req_pull_basic').status,'queued');
  const grant=acquire('req_pull_basic');assert.ok(grant.claim_id);assert.equal(grant.child_request_id,'req_pull_basic');
  assert.equal(store.get('req_pull_basic').target_worker,'alpha');assert.equal(store.get('req_pull_basic').work_order_id,grant.work_order_id);
  assert.equal(acquire('req_pull_basic').claim_id,grant.claim_id);
  assert.throws(()=>acquire('req_pull_basic','alpha',{claimant:'changed'}),/conflict/);
  assert.throws(()=>acquire('req_pull_basic','alpha',{leaseMs:5}),/conflict/);
  assert.throws(()=>acquire('req_pull_basic','beta'),/already acquired/);
  store.owner('req_pull_basic',owner);
  store.finish('req_pull_basic',grant.claim_id,'completed','Inspected.','Inspected.','alpha',null,'alpha');
  assert.throws(()=>acquire('req_pull_basic'),/invalid claim|finished|active|lease/);
  assert.equal(store.get('req_pull_basic').report.summary,'Inspected.');
  store.decide('req_pull_basic','accepted');
  assert.equal(store.ownerInbox('req_pull_basic').decision,'accepted');
  assert.equal(store.get('req_pull_basic').work_order_id,grant.work_order_id);
  assert.throws(()=>store.submit(assignment('req_pull_basic'),{mode:'none'},'',owner),/reserved/);
  put('req_pull_rollback');const before=count(),original=store.claimInTransaction;
  store.claimInTransaction=()=>{throw new Error('injected after child insertion');};
  assert.throws(()=>acquire('req_pull_rollback'),/injected/);store.claimInTransaction=original;
  assert.equal(count(),before);assert.equal(store.pullQueue.row('req_pull_rollback').state,'queued');
  assert.throws(()=>acquire('req_pull_rollback','alpha',{capacity:0}),/capacity_full/);assert.equal(count(),before);
  const originalUpdate=store.db.prepare.bind(store.db);
  store.db.prepare=sql=>sql.startsWith('UPDATE policy_work_orders SET state=')?{run(){throw new Error('injected before slot receipt');}}:originalUpdate(sql);
  assert.throws(()=>acquire('req_pull_rollback'),/injected/);store.db.prepare=originalUpdate;
  assert.equal(count(),before);assert.equal(store.db.prepare('SELECT count(*) n FROM claims WHERE request_id=?').get('req_pull_rollback').n,0);
  // Kill a real writer with uncommitted child/claim/parent changes. Reopening
  // SQLite must recover the entire transaction, including its winner binding.
  const crashFile=path.join(root,'crash.mjs');
  fs.writeFileSync(crashFile,`import {Store} from ${JSON.stringify(new URL('../src/store.mjs',import.meta.url).href)};import {parseWorkers} from ${JSON.stringify(new URL('../src/workers.mjs',import.meta.url).href)};const mode=process.argv[2],id=process.argv[3],profile=parseWorkers({workers:{alpha:{},beta:{}}},{builtin:true}),s=new Store(${JSON.stringify(path.join(root,'store.db'))},{workers:profile,destinationProfile:()=>profile});const kill=()=>process.kill(process.pid,'SIGKILL');if(mode==='child'){const submit=s.submitInTransaction.bind(s);s.submitInTransaction=(...args)=>{submit(...args);kill();};}if(mode==='parent'){const prepare=s.db.prepare.bind(s.db);s.db.prepare=sql=>{const stmt=prepare(sql);return sql.startsWith("UPDATE policy_work_orders SET state='acquired'")?{run(...args){stmt.run(...args);kill();}}:stmt;};}s.pullQueue.acquire(id,{worker:'alpha',subject:'alpha',connectionId:null,claimant:'alpha',acquisitionId:'acq_alpha',capacity:50,preflight:null,admit:()=>{}});if(mode==='committed')kill();`);
  for(const mode of ['child','parent','committed']) {
    const id='req_pull_crash_'+mode;put(id);
    const child=spawnSync(process.execPath,[crashFile,mode,id],{timeout:10000});assert.equal(child.signal,'SIGKILL',child.stderr?.toString());
    store.db.close();store=new Store(path.join(root,'store.db'),{workers:profile,capacity:50,destinationProfile:()=>profile});
    const row=store.pullQueue.row(id);
    if(mode==='committed') {
      const receipt=JSON.parse(row.receipt),retry=acquire(id);
      assert.equal(retry.duplicate,true);assert.equal(retry.claim_id,receipt.claim_id);
      assert.equal(retry.child_request_id,receipt.child_request_id);
    } else {
      assert.equal(row.state,'queued');assert.equal(row.child_request_id,null);
      assert.equal(store.hasAssignment(id),false);
      assert.equal(store.db.prepare('SELECT count(*) n FROM claims WHERE request_id=?').get(id).n,0);
      assert.ok(acquire(id,'beta').claim_id);
    }
    assert.equal(store.db.prepare('SELECT count(*) n FROM assignments WHERE request_id=?').get(id).n,1);
  }
  put('req_pull_cancel');store.cancel('req_pull_cancel','owner stopped');assert.throws(()=>acquire('req_pull_cancel'),/cancelled/);
  put('req_pull_repo',{inputs:[{github_repo:'acme/repo',base_sha:'a'.repeat(40)}]});
  profile.workers.get('alpha').repos=[];
  assert.ok(!store.pullQueue.list('alpha',admit).items.some(item=>item.request_id==='req_pull_repo'));
  assert.throws(()=>store.pullQueue.get('req_pull_repo','alpha',admit),/not found/);
  assert.throws(()=>acquire('req_pull_repo'),/repository denied/);profile.workers.get('alpha').repos=['acme/repo'];
  for(let i=0;i<105;i++)put(`req_pull_page_${String(i).padStart(3,'0')}`,{}, {...options,priority:i===0?'background':'normal'});
  let page=store.pullQueue.list('alpha',admit),all=[...page.items];assert.equal(page.items.length,50);assert.ok(page.next_page_request_id);
  assert.throws(()=>store.pullQueue.list('beta',admit,page.next_page_request_id),/not found/);
  assert.throws(()=>store.pullQueue.list('alpha',admit,page.next_page_request_id.slice(0,-3)+'bad'),/not found/);
  put('req_pull_late_page');
  while(page.next_page_request_id){page=store.pullQueue.list('alpha',admit,page.next_page_request_id);all.push(...page.items);}
  assert.equal(new Set(all.map(item=>item.request_id)).size,all.length);assert.ok(!all.some(item=>item.request_id==='req_pull_late_page'));
  assert.equal(all.at(-1).priority,'background');
  // True contention: independent Node processes and SQLite connections start on
  // one signal file, and both acquire the same durable work order.
  put('req_pull_race');
  const signal=path.join(root,'go'),workerFile=path.join(root,'racer.mjs');
  fs.writeFileSync(workerFile,`import fs from 'node:fs';import {Store} from ${JSON.stringify(new URL('../src/store.mjs',import.meta.url).href)};import {parseWorkers} from ${JSON.stringify(new URL('../src/workers.mjs',import.meta.url).href)};const worker=process.argv[2],profile=parseWorkers({workers:{alpha:{},beta:{}}},{builtin:true}),s=new Store(${JSON.stringify(path.join(root,'store.db'))},{workers:profile,destinationProfile:()=>profile});while(!fs.existsSync(${JSON.stringify(signal)}))await new Promise(r=>setTimeout(r,5));try{const g=s.pullQueue.acquire('req_pull_race',{worker,subject:worker,connectionId:null,claimant:worker,acquisitionId:'race_'+worker,capacity:50,preflight:null,admit:()=>{}});console.log(JSON.stringify({won:true,claim_id:g.claim_id}));}catch(e){console.log(JSON.stringify({won:false,error:e.message}));}finally{s.db.close();}`);
  const race=worker=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[workerFile,worker]);let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',code=>{try{assert.equal(code,0,err);resolve(JSON.parse(out));}catch(e){reject(e);}});});
  const p1=race('alpha'),p2=race('beta');fs.writeFileSync(signal,'go');const results=await Promise.all([p1,p2]);assert.equal(results.filter(r=>r.won).length,1);assert.match(results.find(r=>!r.won).error,/already acquired/);
  assert.equal(store.db.prepare('SELECT count(*) n FROM claims WHERE request_id=?').get('req_pull_race').n,1);
  console.log('PASS policy queue transaction rollback, true two-process contention, immutable child, replay fencing, owner lifecycle, visibility, grants, priority and pagination');
} finally {store?.db.close();fs.rmSync(root,{recursive:true,force:true});}

const adapter=new DotBridgeAdapter({serverEnv:{DOT_BRIDGE_CATALOG_PROFILE:'stable'}});
try {
  await adapter.init();await adapter.reset();await adapter.killServer();
  const workers={workers:Object.fromEntries(['W1','W2','W3'].map((subject,i)=>[['alpha','beta','stranger'][i],{connections:[{issuer:`http://127.0.0.1:${adapter.jwksPort}/realms/fake`,subject,client_id:'pull-test'}],repos:[]}]))};
  const workerFile=path.join(adapter.home,'.config/dot-bridge/workers.json');fs.writeFileSync(workerFile,JSON.stringify(workers),{mode:0o600});
  adapter.token=subject=>{const head=Buffer.from(JSON.stringify({alg:'RS256',kid:'conf',typ:'JWT'})).toString('base64url'),body=Buffer.from(JSON.stringify({iss:`http://127.0.0.1:${adapter.jwksPort}/realms/fake`,aud:'https://dot-bridge.example.test',exp:Math.floor(Date.now()/1000)+3600,sub:subject,azp:'pull-test',scope:'dot-bridge.read dot-bridge.work'})).toString('base64url'),input=`${head}.${body}`;return `${input}.${sign('RSA-SHA256',Buffer.from(input),adapter.privateKey).toString('base64url')}`;};
  await adapter.startServer();
  const payload=assignment('req_pull_http'),body={assignment:payload,routing:policy,owner_token:owner,delivery:'none',execution:'worker'};
  let r=await adapter.admin('POST','/submit',body);assert.ok(r.value,r.error);assert.ok(r.value.work_order_id);
  assert.equal((await adapter.admin('POST','/submit',body)).value.duplicate,true);
  assert.equal((await adapter.admin('GET','/get?id='+payload.request_id,undefined,owner)).value.status,'queued');
  assert.equal((await adapter.mcp('W3','list_pending',{})).value.policy_work.items.length,0);
  assert.match((await adapter.mcp('W3','get',{request_id:payload.request_id})).error,/not found/);
  assert.equal((await adapter.mcp('W1','list_pending',{})).value.policy_work.items[0].request_id,payload.request_id);
  assert.equal((await adapter.mcp('W1','get',{request_id:payload.request_id})).value.assignment.brief,payload.brief);
  const rivals=await Promise.all(['W1','W2'].map(worker=>adapter.mcp(worker,'claim',{request_id:payload.request_id,claimant:worker,acquisition_id:'http_'+worker})));
  assert.equal(rivals.filter(r=>r.value).length,1,JSON.stringify(rivals));
  const index=rivals.findIndex(r=>r.value),subject=['W1','W2'][index],grant=rivals[index].value;
  r=await adapter.mcp(subject,'progress',{request_id:grant.request_id,claim_id:grant.claim_id,note:'Inspected supplied text.'});assert.ok(r.value,r.error);
  r=await adapter.mcp(subject,'finish',{request_id:grant.request_id,claim_id:grant.claim_id,outcome:'completed',summary:'Inspected.',result:'Inspected.'});assert.ok(r.value,r.error);
  const got=(await adapter.admin('GET','/get?id='+payload.request_id,undefined,owner)).value;assert.equal(got.report.summary,'Inspected.');
  r=await adapter.admin('POST','/decide',{id:payload.request_id,decision:'accepted'},owner);assert.ok(r.value,r.error);
  // Legacy jobs still route to exactly one named worker.
  const legacy=assignment('req_pull_legacy');r=await adapter.admin('POST','/submit',{assignment:legacy,worker:'alpha',owner_token:owner,delivery:'none',execution:'worker'});assert.ok(r.value,r.error);
  assert.ok(!(await adapter.mcp('W2','list_pending',{})).value.assignments.some(item=>item.request_id===legacy.request_id));
  assert.match((await adapter.mcp('W2','claim',{request_id:legacy.request_id,claimant:'rival'})).error,/not found/);
  assert.ok((await adapter.mcp('W1','claim',{request_id:legacy.request_id,claimant:'legacy'})).value);
  const recoveryPayload=assignment('req_pull_http_recovery');r=await adapter.admin('POST','/submit',{...body,assignment:recoveryPayload});assert.ok(r.value,r.error);
  const firstEpoch=(await adapter.mcp('W1','claim',{request_id:recoveryPayload.request_id,claimant:'first-run',acquisition_id:'initial-recovery',lease_ms:1000})).value;assert.ok(firstEpoch);
  await adapter.control({op:'advance',to:2001});
  const secondEpoch=await adapter.mcp('W1','claim',{request_id:recoveryPayload.request_id,claimant:'second-run',acquisition_id:'new-recovery',lease_ms:1000});assert.ok(secondEpoch.value,secondEpoch.error);assert.equal(secondEpoch.value.epoch,2);assert.notEqual(secondEpoch.value.claim_id,firstEpoch.claim_id);
  assert.equal(adapter.q1('SELECT child_request_id FROM policy_work_orders WHERE request_id=?',recoveryPayload.request_id).child_request_id,recoveryPayload.request_id);
  const deadlinePayload={...assignment('req_pull_wait_deadline'),valid_until:new Date(adapter.baseMs+10000).toISOString()};
  r=await adapter.admin('POST','/submit',{...body,assignment:deadlinePayload});assert.ok(r.value,r.error);
  const deadlineWait=adapter.admin('GET','/wait?id='+deadlinePayload.request_id+'&timeout=3',undefined,owner);
  for(let i=0;i<100;i++) {
    if((await adapter.admin('GET','/status')).value.owner_waiter_count===1)break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal((await adapter.admin('GET','/status')).value.owner_waiter_count,1);
  await adapter.control({op:'advance',to:10001});await adapter.tick();
  let wakeDeadline;
  const expiredWait=await Promise.race([deadlineWait,new Promise((_,reject)=>{
    wakeDeadline=setTimeout(()=>reject(new Error('expiry sweep did not wake the owner before wait timeout')),1000);
  })]).finally(()=>clearTimeout(wakeDeadline));
  assert.equal(expiredWait.value.status,'cancelled');assert.equal(expiredWait.value.cancelled_reason,'expired');
  assert.equal(adapter.q1('SELECT state FROM policy_work_orders WHERE request_id=?',deadlinePayload.request_id).state,'cancelled');
  const timeoutPayload={...assignment('req_pull_wait_boundary'),valid_until:new Date(adapter.baseMs+11000).toISOString()};
  r=await adapter.admin('POST','/submit',{...body,assignment:timeoutPayload});assert.ok(r.value,r.error);
  const boundaryWait=adapter.admin('GET','/wait?id='+timeoutPayload.request_id+'&timeout=1',undefined,owner);
  for(let i=0;i<100;i++) {
    if((await adapter.admin('GET','/status')).value.owner_waiter_count===1)break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal((await adapter.admin('GET','/status')).value.owner_waiter_count,1);
  await adapter.control({op:'advance',to:11001});
  assert.equal((await boundaryWait).value.status,'cancelled');
  // The adapter captures maintenance timers; without tick(), the parent remains
  // unswept. Only the real wait timeout can return its projected terminal state.
  assert.equal(adapter.q1('SELECT state FROM policy_work_orders WHERE request_id=?',timeoutPayload.request_id).state,'queued');
  // Exercise the owner CLI against the real private socket, including the
  // durable receipt used before and after materialization.
  const cli=(...args)=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['bin/dalan.mjs',...args],{env:fixtureEnv(adapter.home)});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));});
  const cliPayload=assignment('req_pull_cli'),jobFile=path.join(adapter.home,'job.json');fs.writeFileSync(jobFile,JSON.stringify(cliPayload));
  let output=await cli('submit','--file',jobFile,'--eligible','alpha,beta','--execution','worker','--json');assert.equal(output.code,0,output.stderr);assert.ok(JSON.parse(output.stdout).work_order_id);
  output=await cli('get',cliPayload.request_id,'--json');assert.equal(output.code,0,output.stderr);assert.equal(JSON.parse(output.stdout).status,'queued');
  output=await cli('inbox','--all','--json');assert.equal(output.code,0,output.stderr);
  output=await cli('wait',cliPayload.request_id,'--timeout','1','--json');assert.equal(output.code,124,output.stderr);
  let states=await adapter.admin('POST','/owner-states',{items:[{id:cliPayload.request_id,capability:JSON.parse(fs.readFileSync(path.join(adapter.home,'.local/share/dot-bridge/receipts', (await import('node:crypto')).createHash('sha256').update(cliPayload.request_id).digest('hex')+'.json'),'utf8')).token}]});assert.ok(states.value,states.error);assert.equal(states.value.states[0].status,'queued');
  output=await cli('cancel',cliPayload.request_id,'--json');assert.equal(output.code,0,output.stderr);
  output=await cli('wait',cliPayload.request_id,'--timeout','1','--json');assert.equal(output.code,4,output.stderr);
  output=await cli('inbox','--mark-read',cliPayload.request_id,'--json');assert.equal(output.code,0,output.stderr);
  const declaration={provider:'Fixture provider',operator:'Fixture owner',data_categories:['assignment'],retention:'one day',training:'none',terms:'v1'};
  workers.workers.alpha.destination=declaration;workers.workers.beta.destination=declaration;fs.writeFileSync(workerFile,JSON.stringify(workers),{mode:0o600});
  const approvedPayload={...assignment('req_policy_file_cli')};delete approvedPayload.valid_until;
  const approvedPolicy={version:1,allowed_workers:['alpha','beta'],deadline_at:new Date(Date.now()+3600000).toISOString()};
  const preview=await adapter.admin('POST','/submit-preview',{assignment:approvedPayload,routing:approvedPolicy,owner_token:owner,delivery:'none',execution:'worker'});assert.ok(preview.value,preview.error);assert.equal(preview.value.stored,false);
  const revisions=Object.fromEntries(Object.entries(preview.value.destination_disclosures).map(([worker,snapshot])=>[worker,snapshot.revision]));
  fs.writeFileSync(jobFile,JSON.stringify(approvedPayload));const policyFile=path.join(adapter.home,'policy.json');fs.writeFileSync(policyFile,JSON.stringify({routing:approvedPolicy,destination_revisions:revisions}));
  output=await cli('submit','--file',jobFile,'--policy',policyFile,'--execution','worker','--dry-run','--json');assert.equal(output.code,0,output.stderr);
  output=await cli('submit','--file',jobFile,'--policy',policyFile,'--execution','worker','--json');assert.equal(output.code,0,output.stderr);
  workers.workers.beta.destination={...declaration,provider:'Changed provider'};fs.writeFileSync(workerFile,JSON.stringify(workers),{mode:0o600});
  assert.ok(!(await adapter.mcp('W2','list_pending',{})).value.policy_work.items.some(item=>item.request_id===approvedPayload.request_id));
  assert.match((await adapter.mcp('W2','claim',{request_id:approvedPayload.request_id,claimant:'beta',acquisition_id:'drift'})).error,/not found/);
  assert.ok((await adapter.mcp('W1','claim',{request_id:approvedPayload.request_id,claimant:'alpha',acquisition_id:'approved'})).value);
  output=await cli('cancel',approvedPayload.request_id,'--json');assert.equal(output.code,0,output.stderr);
  r=await adapter.admin('POST','/submit',{...body,assignment:{...assignment('req_bad_policy_schema'),schema_version:2}});assert.match(r.error,/invalid assignment/);
  r=await adapter.admin('POST','/submit',{...body,assignment:{...assignment('req_bad_policy_scope'),execution_scope:'implementation'}});assert.match(r.error,/read-only/);
  r=await adapter.admin('POST','/submit',{...body,assignment:assignment('req_bad_policy_host'),execution:'host'});assert.match(r.error,/none or worker/);
  const deniedPayload={...assignment('req_denied_policy_repo'),inputs:[{github_repo:'acme/denied',base_sha:'a'.repeat(40)}],scope_paths:['README.md']};fs.writeFileSync(jobFile,JSON.stringify(deniedPayload));
  output=await cli('submit','--file',jobFile,'--eligible','alpha,beta','--execution','worker','--json');assert.equal(output.code,1);assert.match(output.stderr,/not allowed/);
  console.log('PASS CLI eligible and policy-file submissions, preview/exact candidate approvals, drift refusal, owner get/wait/inbox/cancel and repo denial');
  console.log('PASS HTTP existing list/get/claim/progress/finish, owner report/decision, pool race and unchanged single-target routing');
} finally {await adapter.close();}
