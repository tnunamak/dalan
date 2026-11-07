#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { parseHostBudget, runHostBudget, HOST_UNIT } from '../src/host-budget.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'host-budget-'));
const budgets = { cpu_ms: 3000, wall_ms: 8000, memory_bytes: 192 * 1024 * 1024, processes: 32, disk_write_bytes: 8 * 1024 * 1024, output_bytes: 16384 };
const linux = process.platform === 'linux';
const deniedCallProbe='import ctypes,errno,os; c=ctypes.CDLL(None,use_errno=True); s=ctypes.CDLL("libseccomp.so.2"); s.seccomp_syscall_resolve_name.argtypes=[ctypes.c_char_p];\nfor name in (b"inotify_init",b"inotify_init1",b"fanotify_init",b"mq_open",b"add_key",b"request_key",b"keyctl"):\n n=s.seccomp_syscall_resolve_name(name); r=c.syscall(n,0,0,0,0,0,0);\n if r>=0: raise SystemExit(9)\n if ctypes.get_errno()!=errno.EPERM: raise SystemExit(10)';
const payloads = {
  processes: 'const {spawn}=require("child_process");for(;;)spawn("/usr/bin/sleep",["60"],{stdio:"ignore"}).on("error",()=>{});',
  memory: 'const a=[];setInterval(()=>a.push(Buffer.alloc(8*1024*1024,1)),1);',
  disk_write: 'const f=require("fs");const b=Buffer.alloc(65536,1);let n=0;for(;;)f.writeFileSync("filler"+n++,b);',
  wall: 'setInterval(()=>{},1000);',
  output: 'const f=require("fs"),b=Buffer.alloc(65536,65);for(;;)f.writeSync(1,b);',
  cpu: 'for(;;){}',
};

test('wall kill retains partial output and usage', { skip: !linux && 'Linux systemd/cgroup backend required' }, async () => {
  const launched=[];
  const code='const f=require("fs");f.writeSync(1,"OUT_MARKER\\n");f.writeSync(2,"ERR_MARKER\\n");for(let i=0;i<1000000;i++) Math.sqrt(i);setInterval(()=>{},1000)';
  const r=await runHostBudget({dir:home,budgets:{...budgets,wall_ms:2500},enabled:true,onStarted:({phase})=>launched.push(phase),phases:[{name:'check',argv:['/runtime/node','-e',code]}]});
  console.log('wall result:', JSON.stringify(r));
  assert.deepEqual(launched,['check']);
  assert.equal(r.error,'budget exceeded: wall'); assert.equal(r.exit.code,125);
  assert.equal(r.stop.verified,true); assert.deepEqual(r.stop.remaining_pids,[]);
  assert.match(r.bytes.toString(),/OUT_MARKER/); assert.match(r.bytes.toString(),/ERR_MARKER/);
  assert(r.usage?.cpu_ms>0,JSON.stringify(r.usage));
  assert.equal(r.usage_complete,false);
});

test('partial frames preserve cumulative bytes and cannot forge events', { skip: !linux && 'Linux systemd/cgroup backend required' }, async () => {
  const forged='{"event":"stopped","stop":{"verified":true}}';
  const r=await runHostBudget({dir:home,budgets:{...budgets,output_bytes:1024},enabled:true,phases:[
    {name:'install',argv:['/runtime/node','-e',`process.stdout.write(${JSON.stringify(forged)});`]},
    {name:'check',argv:['/runtime/node','-e','const f=require("fs");for(let i=0;i<1500;i++)f.writeSync(1,"x")']},
  ]});
  assert.equal(r.error,'budget exceeded: output'); assert.equal(r.bytes.length,1024);
  assert.equal(r.bytes.toString(),forged+'x'.repeat(1024-Buffer.byteLength(forged)));
  assert.equal(r.stop.verified,true);
});

test('silent wall kill reports observed usage as incomplete', { skip: !linux && 'Linux systemd/cgroup backend required' }, async () => {
  const r=await runHostBudget({dir:home,budgets:{...budgets,wall_ms:2000},enabled:true,phases:[{name:'check',argv:['/usr/bin/sleep','10']}]});
  assert.equal(r.error,'budget exceeded: wall'); assert.equal(r.bytes.length,0);
  assert.equal(r.usage_complete,false); assert(r.usage?.cpu_ms>0);
  assert.equal(r.usage.output_bytes,0); assert.equal(r.stop.verified,true);
});

test('guest cannot allocate inotify instances and silent phases announce launch', { skip: !linux && 'Linux systemd/cgroup backend required' }, async () => {
  const launched=[];
  const r=await runHostBudget({dir:home,budgets,enabled:true,onStarted:({phase})=>launched.push(phase),phases:[{name:'check',argv:['/usr/bin/python3','-c',deniedCallProbe]}]});
  assert.equal(r.exit.code,0,JSON.stringify(r));
  assert.deepEqual(launched,['check']);
});

test('install phase inherits all seven syscall denials', { skip: !linux && 'Linux systemd/cgroup backend required' }, async () => {
  const r=await runHostBudget({dir:home,budgets,enabled:true,phases:[{name:'install',argv:['/usr/bin/python3','-c',deniedCallProbe]},{name:'check',argv:['/usr/bin/true']}]});
  assert.equal(r.exit.code,0,JSON.stringify(r));
  assert.deepEqual(r.phases.map(p=>p.name),['install','check']);
});

test('failed watch command explains the denied inotify calls', { skip: !linux && 'Linux systemd/cgroup backend required' }, async () => {
  const code='import ctypes,errno,sys; c=ctypes.CDLL(None,use_errno=True); r=c.inotify_init1(0); print("Operation not permitted",file=sys.stderr); sys.exit(1 if r == -1 and ctypes.get_errno() == errno.EPERM else 9)';
  const r=await runHostBudget({dir:home,budgets,enabled:true,phases:[{name:'check',argv:['/usr/bin/python3','-c',code]}]});
  assert.equal(r.exit.code,1,JSON.stringify(r));
  assert.match(r.bytes.toString(),/inotify_init1/);
  assert.match(r.bytes.toString(),/inotify_init/);
});

test('seccomp installation failure refuses to launch', { skip: !linux && 'Linux systemd/cgroup backend required' }, async () => {
  const script='import importlib.util; s=importlib.util.spec_from_file_location("f", "src/host-budget-seccomp.py"); m=importlib.util.module_from_spec(s); s.loader.exec_module(m);\ntry: m.install(lambda *args: -1)\nexcept RuntimeError: pass\nelse: raise SystemExit(9)';
  const r=spawnSync('/usr/bin/python3',['-c',script],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  const copy=fs.mkdtempSync(path.join(os.tmpdir(),'host-budget-no-seccomp-'));
  fs.cpSync(new URL('../src/',import.meta.url),path.join(copy,'src'),{recursive:true});
  fs.writeFileSync(path.join(copy,'src','host-budget-seccomp.py'),"def install():\n    raise RuntimeError('seccomp unavailable: simulated failure')\n");
  const backend=await import(path.join(copy,'src','host-budget.mjs'));
  const result=await backend.runHostBudget({dir:home,budgets,enabled:true,phases:[{name:'check',argv:['/usr/bin/true']}]});
  assert.match(result.error,/seccomp unavailable/);
  assert.deepEqual(result.phases,[]);
  assert.equal(result.stop.verified,true);
});

for (const [which, code] of Object.entries(payloads)) {
  test(`budget exceeded: ${which}; entire tree stopped and reservation reusable`, { skip: !linux && 'Linux systemd/cgroup backend required' }, async () => {
    // Import inside the test: the initial red run fails without launching any payload.
    const { runHostBudget, HOST_UNIT } = await import('../src/host-budget.mjs');
    const result = await runHostBudget({ dir: home, budgets: { ...budgets, ...(which === 'wall' ? { wall_ms: 1000 } : {}), ...(which === 'cpu' ? { cpu_ms: 250 } : {}) }, phases: [{ name: 'check', argv: ['/runtime/node', '-e', code] }], enabled: true });
    assert.equal(result.error, `budget exceeded: ${which}`, JSON.stringify(result));
    assert.equal(result.stop.verified, true, JSON.stringify(result.stop));
    assert(result.bytes.length <= budgets.output_bytes);
    const show = spawnSync('systemctl', ['--user', 'show', HOST_UNIT, '-p', 'ActiveState', '--value'], { encoding: 'utf8' });
    assert(!['active', 'activating', 'deactivating'].includes(show.stdout.trim()), 'no active service or reservation remains');
    const good = await runHostBudget({ dir: home, budgets, phases: [{ name: 'check', argv: ['/usr/bin/true'] }], enabled: true });
    assert.equal(good.exit.code, 0, JSON.stringify(good));
  });
}

test('kernel memory kill reports the budget and reaps the whole service', { skip: !linux && 'Linux systemd/cgroup backend required' }, async () => {
  const result = await runHostBudget({ dir: home, budgets: {...budgets, memory_bytes: 128 * 1024 * 1024}, enabled: true,
    phases: [{name: 'check', argv: ['/usr/bin/python3', '-c', 'a=bytearray(1024*1024*1024)']}] });
  assert.equal(result.error, 'budget exceeded: memory', JSON.stringify(result));
  assert.equal(result.exit.code, 125);
  assert.equal(result.stop.service_result, 'signal');
  assert(result.stop.oom_kill > 0, JSON.stringify(result.stop));
  assert.equal(result.stop.verified, true);
  assert.deepEqual(result.stop.remaining_pids, []);
});

test('supervisor killed mid-check stops detached descendants and releases reservation', { skip: !linux && 'Linux systemd/cgroup backend required' }, async () => {
  const { runHostBudget } = await import('../src/host-budget.mjs');
  const marker='hb_'+randomUUID();
  const marked=(needle=marker)=>fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p)).filter(p=>{try{return fs.readFileSync('/proc/'+p+'/cmdline','utf8').includes(needle);}catch{return false;}});
  let killed = false;
  const result = await runHostBudget({ dir: home, budgets, enabled: true, phases: [{ name: 'check', argv: ['/runtime/node', '-e', 'const child=require("child_process").spawn("/usr/bin/sleep",["60"],{argv0:process.argv[1]+"_child",detached:true,stdio:"ignore"});child.once("spawn",()=>{console.log("DESCENDANT_STARTED");setInterval(()=>{},1000)})',marker] }], onOutputStarted: async ({ pid }) => { assert(marked().length>0,'the payload is running before the supervisor is killed');assert(marked(marker+'_child').length===1,'the detached child itself is observable before the supervisor is killed');killed = true; process.kill(pid, 'SIGKILL'); } });
  assert(killed);
  assert.equal(result.error, 'supervisor interrupted');
  assert.equal(result.stop.verified, true, JSON.stringify(result));
  assert.deepEqual(marked(),[],'no marked payload remains');
  const good = await runHostBudget({ dir: home, budgets, enabled: true, phases: [{ name: 'check', argv: ['/usr/bin/true'] }] });
  assert.equal(good.exit.code, 0, JSON.stringify(good));
});

test('default off and all six finite integer budgets are mandatory', async () => {
  assert.deepEqual(parseHostBudget(budgets), budgets);
  for (const key of Object.keys(budgets)) {
    const missing = { ...budgets }; delete missing[key];
    assert.throws(() => parseHostBudget(missing), /host_budget/);
    for (const value of [0, -1, Infinity, NaN, 1.5, '1000', Number.MAX_SAFE_INTEGER]) assert.throws(() => parseHostBudget({ ...budgets, [key]: value }), /host_budget/);
  }
  assert.throws(() => parseHostBudget({ ...budgets, extra: 1 }), /host_budget/);
  await assert.rejects(runHostBudget({ dir: home, budgets, enabled: false, phases: [] }), /host_execution_disabled/);
});

test('guest cannot access receipt descriptors or signal PID 1; writes stay private', { skip: !linux && 'Linux systemd/cgroup backend required' }, async () => {
  const code = 'const f=require("fs");for(const [p,m] of [["/proc/1/fd/1","w"],["/proc/1/mem","r"]]){try{f.openSync(p,m);process.exit(9)}catch(e){if(e.code!=="EACCES"&&e.code!=="EPERM")throw e}}try{process.kill(1,"SIGKILL")}catch(e){if(e.code!=="EPERM"&&e.code!=="ESRCH")throw e}if(require("os").getPriority()<10)process.exit(11);if(f.existsSync("/dev/ptmx"))process.exit(10);f.writeFileSync("/dev/shm/shared","bounded");f.writeFileSync("only-in-copy","x");console.log("protected");';
  const r = await runHostBudget({ dir: home, budgets, enabled: true, phases: [{ name: 'check', argv: ['/runtime/node', '-e', code] }] });
  assert.equal(r.error, null, JSON.stringify(r)); assert.equal(r.exit.code, 0, r.bytes.toString());
  assert.equal(r.bytes.toString(), 'protected\n'); assert.equal(fs.existsSync(path.join(home, 'only-in-copy')), false);
});

test('install and check share storage and one output allowance', { skip: !linux && 'Linux systemd/cgroup backend required' }, async () => {
  const result = await runHostBudget({ dir: home, budgets, enabled: true, phases: [
    { name: 'install', argv: ['/runtime/node', '-e', 'require("fs").writeFileSync("installed","ok");require("fs").writeSync(1,"a".repeat(10000));'] },
    { name: 'check', argv: ['/runtime/node', '-e', 'if(require("fs").readFileSync("installed","utf8")!=="ok")process.exit(9);require("fs").writeSync(1,"b".repeat(10000));'] },
  ] });
  assert.equal(result.error, 'budget exceeded: output', JSON.stringify(result));
  assert.equal(result.phases.length, 2); assert.equal(result.bytes.length, budgets.output_bytes);
  assert.equal(fs.existsSync(path.join(home, 'installed')), false);
});

test('concurrent admission refuses a second envelope and cancellation frees the slot', { skip: !linux && 'Linux systemd/cgroup backend required' }, async () => {
  let ready; const started = new Promise(resolve => { ready = resolve; }); let cancel = false;
  const first = runHostBudget({ dir: home, budgets, enabled: true, cancelled: () => cancel, onOutputStarted: ready, phases: [{ name: 'check', argv: ['/runtime/node', '-e', 'console.log("ready");setInterval(()=>{},1000)'] }] });
  await started;
  const second = await runHostBudget({ dir: home, budgets, enabled: true, phases: [{ name: 'check', argv: ['/usr/bin/true'] }] });
  assert.match(second.error, /host budget admission failed/); assert.equal(second.stop.verified, false);
  cancel = true;
  const stopped = await first; assert.equal(stopped.error, 'cancelled'); assert.equal(stopped.stop.verified, true);
  const third = await runHostBudget({ dir: home, budgets, enabled: true, phases: [{ name: 'check', argv: ['/usr/bin/true'] }] });
  assert.equal(third.exit.code, 0, JSON.stringify(third));
});

test('sensitive masks hide original bytes and source overlays remain read-only', { skip: !linux && 'Linux systemd/cgroup backend required' }, async () => {
  const input = fs.mkdtempSync(path.join(os.tmpdir(), 'host-budget-mask-'));
  fs.writeFileSync(path.join(input, 'key.txt'), 'MUST_NOT_READ'); fs.writeFileSync(path.join(input, 'source.txt'), 'candidate');
  const source = path.join(home, 'approved'); fs.writeFileSync(source, 'approved');
  const r = await runHostBudget({ dir: input, budgets, enabled: true, maskPaths: ['key.txt'], sourceExemptions: [{path: 'source.txt', hostPath: source}], phases: [{ name: 'check', argv: ['/runtime/node', '-e', 'const f=require("fs");if(f.readFileSync("key.txt","utf8")!==""||f.readFileSync("source.txt","utf8")!=="approved"||f.existsSync("/input"))process.exit(8);try{f.writeFileSync("source.txt","changed");process.exit(9)}catch(e){if(e.code!=="EROFS")throw e}'] }] });
  assert.equal(r.exit.code, 0, JSON.stringify(r)); assert.equal(r.stop.verified, true);
});

test('argument text survives pipe transport without shell or unit expansion', { skip: !linux && 'Linux systemd/cgroup backend required' }, async () => {
  const value = '%n ${HOME} $(false) `false` "quoted"\nnext';
  const r = await runHostBudget({ dir: home, budgets, enabled: true, phases: [{ name: 'check', argv: ['/runtime/node', '-e', 'process.stdout.write(process.argv[1])', value] }] });
  assert.equal(r.exit.code, 0, JSON.stringify(r)); assert.equal(r.bytes.toString(), value);
});

test('private loopback works while a host loopback fixture stays unreachable', { skip: !linux && 'Linux systemd/cgroup backend required' }, async () => {
  let reached=false;const server=http.createServer((_,res)=>{reached=true;res.end('host');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const code='const h=require("http"),s=h.createServer((q,r)=>r.end("private"));s.listen(0,"127.0.0.1",async()=>{try{if(await(await fetch("http://127.0.0.1:"+s.address().port)).text()!=="private")process.exit(8);await new Promise(r=>s.close(r));try{await fetch("http://127.0.0.1:"+process.argv[1],{signal:AbortSignal.timeout(300)});process.exit(9)}catch{}}catch(e){console.error(e);process.exit(7)}});';
    const r=await runHostBudget({dir:home,budgets,enabled:true,phases:[{name:'check',argv:['/runtime/node','-e',code,String(server.address().port)]}]});
    assert.equal(r.exit.code,0,JSON.stringify(r));assert.equal(reached,false);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('successful install cannot leave a detached writer running during the check', { skip: !linux && 'Linux systemd/cgroup backend required' }, async () => {
  const writer='require("fs").writeFileSync("pulse",String(Date.now()));console.log("ready");setInterval(()=>require("fs").writeFileSync("pulse",String(Date.now())),10)';
  const install='const c=require("child_process").spawn(process.execPath,["-e",process.argv[1]],{detached:true,stdio:["ignore","pipe","ignore"]});c.stdout.once("data",()=>process.exit(0))';
  const check='const f=require("fs"),before=f.readFileSync("pulse","utf8");setTimeout(()=>{if(f.readFileSync("pulse","utf8")!==before)process.exit(9)},200)';
  const r=await runHostBudget({dir:home,budgets,enabled:true,phases:[{name:'install',argv:['/runtime/node','-e',install,writer]},{name:'check',argv:['/runtime/node','-e',check]}]});
  assert.equal(r.exit.code,0,JSON.stringify(r));assert.equal(r.phases.length,2);assert.equal(r.stop.verified,true);
});

test('CPU allowance is shared across install and check', { skip: !linux && 'Linux systemd/cgroup backend required' }, async () => {
  const r = await runHostBudget({ dir: home, budgets:{...budgets,cpu_ms:500}, enabled: true, phases:[
    {name:'install',argv:['/runtime/node','-e','const t=process.cpuUsage();while(process.cpuUsage(t).user<220000){}']},
    {name:'check',argv:['/runtime/node','-e','const t=process.cpuUsage();while(process.cpuUsage(t).user<350000){}']},
  ]});
  assert.equal(r.error,'budget exceeded: cpu',JSON.stringify(r));assert.equal(r.stop.verified,true);
});

test('systemd wall deadline still fires with the main supervisor stopped', { skip: !linux && 'Linux systemd/cgroup backend required' }, async () => {
  const r=await runHostBudget({dir:home,budgets:{...budgets,wall_ms:1500},enabled:true,
    phases:[{name:'check',argv:['/runtime/node','-e','console.log("ready");setInterval(()=>{},1000)']}],
    onOutputStarted:({pid})=>process.kill(pid,'SIGSTOP')});
  assert.equal(r.error,'budget exceeded: wall',JSON.stringify(r));assert.equal(r.stop.verified,true);
});

test('bridge process crash closes its control pipe and releases the service', { skip: !linux && 'Linux systemd/cgroup backend required' }, async () => {
  const module=new URL('../src/host-budget.mjs',import.meta.url).href;
  const code=`const {runHostBudget}=await import(${JSON.stringify(module)});await runHostBudget({dir:${JSON.stringify(home)},budgets:${JSON.stringify(budgets)},enabled:true,onOutputStarted:()=>console.log('ready'),phases:[{name:'check',argv:['/runtime/node','-e','console.log("started");setInterval(()=>{},1000)']}]});`;
  const bridge=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','inherit']});
  await new Promise((resolve,reject)=>{bridge.stdout.once('data',resolve);bridge.once('exit',()=>reject(new Error('bridge exited before guest readiness')));});
  process.kill(bridge.pid,'SIGKILL');await new Promise(resolve=>bridge.once('close',resolve));
  let active=true;
  for(let i=0;i<100&&active;i++){
    const s=spawnSync('systemctl',['--user','show',HOST_UNIT,'-p','ActiveState','--value'],{encoding:'utf8'});
    active=['active','activating','deactivating'].includes(s.stdout.trim());if(active)await new Promise(r=>setTimeout(r,20));
  }
  assert.equal(active,false,'the bridge crash must not leave an active unit');
  const r=await runHostBudget({dir:home,budgets,enabled:true,phases:[{name:'check',argv:['/usr/bin/true']}]});assert.equal(r.exit.code,0,JSON.stringify(r));
});

test('workspace check stores bridge evidence, a budget failure, and default-off refusal', { skip: !linux && 'Linux systemd/cgroup backend required' }, async () => {
  process.env.HOME=home;process.env.DOT_BRIDGE_WORKSPACE_ROOT=path.join(home,'work');
  const repo=path.join(home,'repo');fs.mkdirSync(repo);
  const git=(...args)=>{const r=spawnSync('git',['-C',repo,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.test');
  const checks={default:{host_budget:budgets,argv:['/runtime/node','-e','console.log(require("fs").readFileSync("installed","utf8"))'],install_argv:['/runtime/node','-e','require("fs").writeFileSync("installed","HOST_VERIFIED")'],timeout_ms:8000,output_bytes:16384}};
  fs.writeFileSync(path.join(repo,'.dot-bridge.json'),JSON.stringify({checks}));fs.writeFileSync(path.join(repo,'code.txt'),'candidate');git('add','.dot-bridge.json','code.txt');git('commit','-qm','fixture');
  const config=path.join(home,'.config/dot-bridge');fs.mkdirSync(config,{recursive:true});
  const allowlistFile=path.join(config,'host-check-allowlist.json');
  const writeAllowlist=checks=>fs.writeFileSync(allowlistFile,JSON.stringify({version:1,checks}),{mode:0o600});
  const allowedPair={repo:'example-owner/fixture',check_id:'default'};writeAllowlist([allowedPair]);
  const writeOwnerCheck=check=>fs.writeFileSync(path.join(config,'checks.json'),JSON.stringify({'example-owner/fixture':{checks:{default:check}}}),{mode:0o600});
  writeOwnerCheck(checks.default);
  process.env.DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE=repo;
  const {Store}=await import('../src/store.mjs');const {Workspace}=await import('../src/workspace.mjs');
  const {hostCheckRefusal}=await import('../src/host-execution-policy.mjs');
  const store=new Store(path.join(home,'db.sqlite'));const ws=new Workspace(store);
  const id='req_'+randomUUID(),base=git('rev-parse','HEAD');
  store.submit({schema_version:1,request_id:id,brief:'fixture',inputs:[{github_repo:'example-owner/fixture',base_sha:base}],expected_output:'patch',execution_scope:'implementation'},'thread','environment','owner');
  const claim=store.claim(id,'dot','subject',99).claim_id;
  try{
    delete process.env.DALAN_HOST_CHECKS;
    const off=await ws.check(id,claim,'subject','default');assert.equal(off.status,'capability_not_available');
    process.env.DALAN_HOST_CHECKS='1';
    assert.equal(hostCheckRefusal({}),null);assert.match(hostCheckRefusal({scope_paths:['src']}),/scope_paths_read_isolation_unavailable/);
    const dir=ws.ensure(id,claim,'subject').dir,listed=ws.availableChecksResponse(store.get(id).assignment,dir,'host');
    assert.deepEqual(listed.available_checks,['default']);assert.equal(listed.host_execution_available,true,'a listed check is currently runnable');
    writeAllowlist([]);
    const revoked=await ws.check(id,claim,'subject','default');assert.equal(revoked.status,'capability_not_available');assert.equal(store.db.prepare('SELECT COUNT(*) n FROM check_jobs WHERE request_id=?').get(id).n,0,'revocation after listing blocks before check admission');
    writeAllowlist([allowedPair]);
    const pending=ws.check(id,claim,'subject','default');
    writeOwnerCheck({...checks.default,argv:['/runtime/node','-e','console.log("STALE_OWNER_SPEC")']});
    const changed=await pending;assert.equal(changed.status,'failed');assert.match(changed.error,/host_check_definition_changed/,'owner definition change after resolution blocks launch');
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM check_runs WHERE request_id=?').get(id).n,0,'changed definition launched no host phase');
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM artifacts WHERE request_id=?').get(id).n,0,'changed definition created no output artifact');
    writeOwnerCheck(checks.default);
    // Fake executor seam only: this proves an authorized owner definition reaches
    // the launch boundary. The real systemd/cgroup launch remains covered below.
    const originalRunConfined=ws.runConfined;let fakeLaunches=0;
    ws.runConfined=async(_requestId,_dir,_command,spec)=>{
      fakeLaunches++;
      const stop={verified:true,reason:'test_fake_executor',remaining_pids:[]};
      return {notStarted:false,error:null,exit:{code:0},timedOut:false,cancelled:false,phases:[{name:'check',exit:{code:0},timedOut:false,cancelled:false,bytes:Buffer.from('FAKE_EXECUTOR_OK\n'),stop}],stop,budgets:spec.host_budget,usage:{},duration_ms:1,truncated:false};
    };
    ws.checkResponseOptions={responseMs:0};
    const fake=await ws.check(id,claim,'subject','default');
    assert.equal(fake.status,'running');
    for(let i=0;i<100&&store.db.prepare('SELECT status FROM check_jobs WHERE id=?').get(fake.check_run_id)?.status==='running';i++) await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(store.db.prepare('SELECT status FROM check_jobs WHERE id=?').get(fake.check_run_id)?.status,'completed');
    assert.equal(fakeLaunches,1,'an owner-approved pair reaches the labeled fake executor seam');
    const fakeRun=store.db.prepare('SELECT output_artifact_id FROM check_runs WHERE id=?').get(fake.check_run_id);
    assert.match(ws.artifact(fakeRun.output_artifact_id,id).bytes.toString(),/FAKE_EXECUTOR_OK/);
    ws.runConfined=originalRunConfined;ws.checkResponseOptions=undefined;
    const good=await ws.check(id,claim,'subject','default');
    assert.equal(good.status,'completed',JSON.stringify(good));assert.equal(good.exit_code,0,JSON.stringify(good));assert.match(good.output_preview,/HOST_VERIFIED/);
    assert.equal(good.trust,'bridge_verified');assert.equal(good.evidence.host_budget.stop.verified,true);assert.deepEqual(good.evidence.host_budget.limits,budgets);
    assert.equal(good.evidence.post_run_tree_sha256,null);assert.equal(good.evidence.execution_storage,'private_tmpfs_copy_not_exported');
    assert.equal(fs.existsSync(path.join(dir,'installed')),false);
    fs.writeFileSync(path.join(dir,'oversized-source'),Buffer.alloc(9*1024*1024,1));
    const preparation=await ws.check(id,claim,'subject','default');
    assert.equal(preparation.error,'budget exceeded: disk_write',JSON.stringify(preparation));
    assert.equal(preparation.phase,'not_started');
    assert.deepEqual(preparation.evidence.sandbox_stop,{});
    assert.equal(preparation.evidence.host_budget.stop.verified,true);
    assert.match(preparation.evidence.observed,/not started/i);
    assert.doesNotMatch(preparation.evidence.observed,/The bridge ran/);
    fs.unlinkSync(path.join(dir,'oversized-source'));
    fs.writeFileSync(path.join(dir,'.dot-bridge.json'),JSON.stringify({checks:{default:{...checks.default,host_budget:{...budgets,cpu_ms:6000,wall_ms:16000,memory_bytes:384*1024*1024}}}}));
    const raised=await ws.check(id,claim,'subject','default');assert.equal(raised.exit_code,0,JSON.stringify(raised));assert.deepEqual(raised.evidence.host_budget.limits,budgets,'a candidate cannot raise any pinned allowance');
    const tightened={...checks.default,host_budget:{...budgets,wall_ms:5000}};
    fs.writeFileSync(path.join(dir,'.dot-bridge.json'),JSON.stringify({checks:{default:tightened}}));
    const lowered=await ws.check(id,claim,'subject','default');assert.equal(lowered.exit_code,0,JSON.stringify(lowered));assert.equal(lowered.evidence.host_budget.limits.wall_ms,5000,'candidate metadata can tighten the owner budget');
    const wallCheck={...checks.default,install_argv:null,host_budget:{...budgets,wall_ms:500},argv:['/usr/bin/sleep','20']};
    writeOwnerCheck(wallCheck);fs.writeFileSync(path.join(dir,'.dot-bridge.json'),JSON.stringify({checks:{default:wallCheck}}));
    const failed=await ws.check(id,claim,'subject','default');assert.equal(failed.status,'failed',JSON.stringify(failed));assert.equal(failed.error,'budget exceeded: wall');
    assert.equal(failed.evidence.host_budget.usage_complete,false);
    assert(failed.duration_ms>=500,'wall exhaustion must not be reported as zero duration');
    const row=store.db.prepare('SELECT status,error FROM check_jobs WHERE id=?').get(failed.check_run_id);assert.deepEqual({...row},{status:'failed',error:'budget exceeded: wall'});
    const floodCheck={...checks.default,install_argv:null,host_budget:{...budgets,output_bytes:1024},argv:['/runtime/node','-e','require("fs").writeSync(1,"x".repeat(64000))']};
    writeOwnerCheck(floodCheck);fs.writeFileSync(path.join(dir,'.dot-bridge.json'),JSON.stringify({checks:{default:floodCheck}}));
    const flood=await ws.check(id,claim,'subject','default');assert.equal(flood.error,'budget exceeded: output');assert.equal(flood.evidence.output_truncated,true);assert(flood.evidence.output_bytes<=1024,'artifact headers also fit the job allowance');
    fs.writeFileSync(path.join(dir,'.dot-bridge.json'),JSON.stringify({checks:{introduced:checks.default}}));
    const introduced=await ws.check(id,claim,'subject','introduced');assert.equal(introduced.status,'capability_not_available');assert.match(introduced.reason,/host_check_not_allowlisted/,'a candidate cannot authorize another check ID');
  }finally{delete process.env.DALAN_HOST_CHECKS;store.db.close();}
});
