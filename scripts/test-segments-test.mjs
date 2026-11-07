// Exercise the real runner in an isolated package, including child-process cleanup.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { killIfAlive } from '../src/test-support/process.mjs';

const scratch = path.join(os.homedir(), '.tmp');
await fs.mkdir(scratch, { recursive: true });
const root = await fs.mkdtemp(path.join(scratch, 'segment-runner-'));
const source = await fs.readFile(new URL('./test-segments.mjs', import.meta.url), 'utf8');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const node = quote(process.execPath);
const failures = [];

async function fixture(name, commands, extraEnv = {}) {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(dir, 'scripts/test-segments.mjs'), source);
  await fs.writeFile(path.join(dir, 'scripts/test-segments.json'), JSON.stringify(commands));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node scripts/test-segments.mjs' } }));
  const env = { ...process.env, ...extraEnv };
  delete env.npm_config_script_shell;
  const child = spawn(process.execPath, ['scripts/test-segments.mjs'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const ended = once(child, 'close').then(([code, signal]) => ({ code, signal, output }));
  return { dir, child, ended };
}

async function waitForFile(file) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    try { return await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(20);
  }
  throw new Error(`fixture did not become ready: ${file}`);
}

async function isRunning(pid) {
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  // Linux may retain an orphan's zombie until init reaps it; a zombie cannot execute.
  if (process.platform === 'linux') {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(error => { if (error.code === 'ENOENT'||error.code==='ESRCH') return null; throw error; });
    return stat !== null && stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  }
  return true;
}

async function check(name, fn) {
  try { await fn(); console.log(`PASS runner: ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL runner: ${name}: ${error.stack}`); }
}

try {
  if(process.platform==='linux') await check('process disappearance between existence and stat probes is stopped; permission failures remain errors',async()=>{
    const originalKill=process.kill,originalReadFile=fs.readFile;
    try {
      process.kill=(pid,signal)=>{assert.equal(pid,123);assert.equal(signal,0);};
      for(const code of ['ENOENT','ESRCH']) {
        fs.readFile=async file=>{assert.equal(file,'/proc/123/stat');throw Object.assign(new Error('synthetic proc read'),{code});};
        assert.equal(await isRunning(123),false,code);
      }
      fs.readFile=async()=>{throw Object.assign(new Error('synthetic denied proc read'),{code:'EACCES'});};
      await assert.rejects(isRunning(123),{code:'EACCES'});
    } finally {
      process.kill=originalKill;fs.readFile=originalReadFile;
    }
  });
  if(process.platform!=='linux')console.log('SKIP runner process-stat race: Linux /proc is required');
  await check('real entry point reports both failures and still executes later commands', async () => {
    const f = await fixture('exits', [`${node} -e 'process.exit(7)'`, `${node} -e 'console.log("LATER_RAN")'`, `${node} -e 'process.exit(9)'`]);
    const result = await f.ended;
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /LATER_RAN/);
    assert.match(result.output, /=== SEGMENT 1\/3: .* ===/);
    assert.match(result.output, /=== SEGMENT 1\/3: FAIL exit=7 ===/);
    assert.match(result.output, /=== SEGMENT 2\/3: PASS ===/);
    assert.match(result.output, /=== SEGMENT 3\/3: FAIL exit=9 ===/);
    assert.match(result.output, /3 total, 1 passed, 2 failed/);
    assert.match(result.output, /FAIL #1\/3 exit=7/);
    assert.match(result.output, /FAIL #3\/3 exit=9/);
  });

  await check('segment lines carry wall-clock seconds and the slowest list is ordered slowest first', async () => {
    const f = await fixture('timing', [`${node} -e 'setTimeout(()=>{},300)'`, `${node} -e 'setTimeout(()=>{},50)'`, `${node} -e 'setTimeout(()=>{},150)'`]);
    const result = await f.ended;
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /=== SEGMENT 1\/3: PASS === \d+\.\d+s/);
    assert.match(result.output, /=== SEGMENT 2\/3: PASS === \d+\.\d+s/);
    assert.match(result.output, /=== SEGMENT 3\/3: PASS === \d+\.\d+s/);
    assert.match(result.output, /SLOWEST SEGMENTS:/);
    const slowest = result.output.slice(result.output.indexOf('SLOWEST SEGMENTS:'));
    assert.ok(slowest.indexOf('#1/3') < slowest.indexOf('#3/3') && slowest.indexOf('#3/3') < slowest.indexOf('#2/3'), slowest);
  });

  await check('a segment spawn error is reported and does not skip the next command', async () => {
    const preload = path.join(root, 'spawn-error.cjs');
    await fs.writeFile(preload, `const cp=require('node:child_process'); const real=cp.spawn; cp.spawn=(file,args,options)=>args?.[1]==='INJECT_SPAWN_ERROR'?real('/nonexistent-segment-runner-shell',[],options):real(file,args,options); require('node:module').syncBuiltinESMExports();`);
    const f = await fixture('spawn-error', [`${node} -e 'console.log("FIRST_RAN")'`, 'INJECT_SPAWN_ERROR', `${node} -e 'console.log("AFTER_SPAWN_ERROR")'`], { NODE_OPTIONS: `--require=${preload}` });
    const result = await f.ended;
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /AFTER_SPAWN_ERROR/);
    assert.match(result.output, /3 total, 2 passed, 1 failed/);
    assert.match(result.output, /FAIL #2\/3.*ENOENT/);
  });

  await check('host journey exits are skips, never passes or failures', async () => {
    const hostJourney=spawnSync(process.execPath,[new URL('./require-host-checks.mjs',import.meta.url).pathname],{encoding:'utf8',env:{...process.env,HOME:root}});
    assert.equal(hostJourney.status,77,hostJourney.stderr);
    assert.match(hostJourney.stdout,/SKIP host executor journey/);
    const f = await fixture('skips', [`${node} -e 'process.exit(77)'`, `${node} -e 'console.log("STILL_RAN")'`, `${node} -e 'process.exit(8)'`]);
    const result=await f.ended;
    assert.equal(result.code,1,result.output);
    assert.match(result.output,/STILL_RAN/);
    assert.match(result.output,/3 total, 1 passed, 1 failed, 1 skipped/);
    assert.match(result.output,/SEGMENT 1\/3: SKIP/);
    assert.match(result.output,/SKIP #1\/3: /,'the final summary must name every skipped segment');
    assert(!result.output.includes('FAIL #1/3'));
    const allSkipped=await fixture('only-skips',[`${node} -e 'process.exit(77)'`]);
    const skipped=await allSkipped.ended;
    assert.equal(skipped.code,0,skipped.output);
    assert.match(skipped.output,/1 total, 0 passed, 0 failed, 1 skipped/);
  });

  await check('a segment that exits 0 after skipCheck is labelled PASS with its skipped checks, and the summary names each and counts a skipped group by its checks', async () => {
    const helper = quote(new URL('../src/test-support/skipped-check.mjs', import.meta.url).href);
    const skipper = `${node} --input-type=module -e ${quote(`import{skipCheck}from${helper};skipCheck('first check','fixtures absent');skipCheck('second group','fixtures absent',{count:22})`)}`;
    const f = await fixture('partial-skips', [skipper, `${node} -e 'console.log("PLAIN")'`, `${node} -e 'process.exit(77)'`]);
    const result = await f.ended;
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /^SKIP: first check — fixtures absent$/m);
    assert.match(result.output, /^SKIP: second group \(22 checks\) — fixtures absent$/m);
    assert.match(result.output, /=== SEGMENT 1\/3: PASS, 23 check\(s\) SKIPPED ===/);
    assert.match(result.output, /=== SEGMENT 2\/3: PASS ===/);
    assert.match(result.output, /=== SEGMENT 3\/3: SKIP ===/);
    assert.match(result.output, /3 total, 2 passed, 0 failed, 1 skipped, 23 checks skipped/);
    assert.match(result.output, /^SKIPPED CHECK #1\/3: first check — fixtures absent$/m);
    assert.match(result.output, /^SKIPPED CHECK #1\/3: second group \(22 checks\) — fixtures absent$/m);
    assert.match(result.output, /^SKIP #3\/3: /m);
  });

  if (process.platform !== 'win32') await check('SIGKILL acceptance does not release a still-running owned group', async () => {
    const dir=path.join(root,'deferred-kill');
    await fs.mkdir(dir,{recursive:true});
    const pidFile=path.join(dir,'pid'),ready=path.join(dir,'ready'),later=path.join(dir,'later');
    const parent=path.join(dir,'parent.mjs'),stubborn=path.join(dir,'stubborn.mjs'),preload=path.join(dir,'defer-kill.cjs');
    await fs.writeFile(stubborn,`import fs from 'node:fs';for(const s of ['SIGINT','SIGTERM','SIGHUP'])process.on(s,()=>{});fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
    await fs.writeFile(parent,`import fs from 'node:fs';import{spawn}from'node:child_process';for(const s of ['SIGINT','SIGTERM','SIGHUP'])process.on(s,()=>process.exit(0));spawn(process.execPath,[${JSON.stringify(stubborn)}],{stdio:'inherit'});fs.writeFileSync(${JSON.stringify(ready)},String(process.ppid));setInterval(()=>{},1000);`);
    // Only the copied runner accepts SIGKILL without delivering it. The controller
    // delivers the real signal after two live-group observations, never on a timer.
    await fs.writeFile(preload,`if(process.argv[1]?.endsWith('/scripts/test-segments.mjs')){const kill=process.kill.bind(process);let accepted=false,probes=0,denied=false;process.kill=(pid,signal)=>{if(pid<0&&signal==='SIGKILL'){accepted=true;return true;}if(process.platform==='darwin'&&pid<0&&signal===0&&accepted&&!denied){denied=true;process.stdout.write('CONTROL_DARWIN_EPERM\\n');throw Object.assign(new Error('controlled group probe'),{code:'EPERM'});}const result=kill(pid,signal);if(pid<0&&signal===0&&accepted&&++probes===2)process.stdout.write('CONTROL_GROUP_STILL_RUNNING\\n');return result;};}`);
    const command=`trap 'exit 0' INT TERM HUP; ${node} ${quote(parent)} & wait`;
    const f=await fixture('deferred-kill',[command,`${node} -e ${quote(`require('fs').writeFileSync(${JSON.stringify(later)},'bad')`)}`],{NODE_OPTIONS:`--require=${preload}`});
    let pid,group,timer,observed='';
    let onData;
    try {
      group=Number(await waitForFile(ready));pid=Number(await waitForFile(pidFile));
      const exited=once(f.child,'exit').then(([code])=>{throw new Error(`runner exited before actual group termination: ${code}`);});
      const probed=new Promise(resolve=>{onData=data=>{observed+=data;if(observed.includes('CONTROL_GROUP_STILL_RUNNING'))resolve();};f.child.stdout.on('data',onData);});
      const bounded=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('no bounded group observation')),20000);});
      f.child.kill('SIGHUP');
      await Promise.race([probed,exited,bounded]);
      assert.equal(await isRunning(pid),true,'the controller has not delivered the real SIGKILL');
      assert.equal(f.child.exitCode,null,'runner must retain ownership while the group is live');
      process.kill(-group,'SIGKILL');
      const result=await Promise.race([f.ended,bounded]);
      assert.equal(await isRunning(pid),false);
      assert.equal(result.code,128+os.constants.signals.SIGHUP,result.output);
      if(process.platform==='darwin')assert.match(result.output,/CONTROL_DARWIN_EPERM/,'a denied probe must not release a live group');
      assert.equal(await fs.stat(later).then(()=>true,()=>false),false);
    } finally {
      clearTimeout(timer);if(onData)f.child.stdout.off('data',onData);
      if(group)try{process.kill(-group,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
      if(pid&&await isRunning(pid))killIfAlive(pid,'SIGKILL');
      if(f.child.exitCode===null&&f.child.signalCode===null)f.child.kill('SIGKILL');
      await f.ended;
    }
  });

  if (process.platform === 'linux') for (const mode of ['late-negative', 'stalled']) {
    await check(`${mode} group probe cannot succeed past the settlement deadline`, async () => {
      const dir=path.join(root,`deadline-${mode}`);
      await fs.mkdir(dir,{recursive:true});
      const pidFile=path.join(dir,'pid'),ready=path.join(dir,'ready');
      const parent=path.join(dir,'parent.mjs'),stubborn=path.join(dir,'stubborn.mjs'),preload=path.join(dir,'probe.cjs');
      await fs.writeFile(stubborn,`import fs from 'node:fs';for(const s of ['SIGINT','SIGTERM','SIGHUP'])process.on(s,()=>{});fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
      await fs.writeFile(parent,`import fs from 'node:fs';import{spawn}from'node:child_process';for(const s of ['SIGINT','SIGTERM','SIGHUP'])process.on(s,()=>process.exit(0));spawn(process.execPath,[${JSON.stringify(stubborn)}],{stdio:'inherit'});fs.writeFileSync(${JSON.stringify(ready)},String(process.ppid));setInterval(()=>{},1000);`);
      // A late negative result advances a controlled monotonic clock. A stalled
      // result has no timer of its own: the runner must own its deadline timer.
      await fs.writeFile(preload,`if(process.argv[1]?.endsWith('/scripts/test-segments.mjs')){const fs=require('node:fs');const kill=process.kill.bind(process),read=fs.promises.readdir;let accepted=false,clock=0;Object.defineProperty(globalThis,'performance',{value:{now:()=>clock},configurable:true});process.kill=(pid,signal)=>{if(pid<0&&signal==='SIGKILL'){accepted=true;return true;}return kill(pid,signal);};fs.promises.readdir=(dir,...args)=>{if(dir==='/proc'&&accepted){process.stdout.write('CONTROL_PROBE_ENTERED\\n');if(${JSON.stringify(mode)}==='late-negative'){clock+=6000;return Promise.resolve([]);}return new Promise(()=>{});}return read(dir,...args);};require('node:module').syncBuiltinESMExports();}`);
      const f=await fixture(`deadline-${mode}`,[`trap 'exit 0' INT TERM HUP; ${node} ${quote(parent)} & wait`],{NODE_OPTIONS:`--require=${preload}`});
      let pid,group,timer;
      try {
        group=Number(await waitForFile(ready));pid=Number(await waitForFile(pidFile));
        const exited=once(f.child,'exit');
        f.child.kill('SIGHUP');
        const [code]=await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('probe timeout did not release the runner')),15000);})]);
        assert.equal(await isRunning(pid),true,'the negative probe is controlled, not actual group absence');
        process.kill(-group,'SIGKILL');
        const result=await f.ended;
        assert.match(result.output,/CONTROL_PROBE_ENTERED/,'the delayed probe must execute');
        assert.equal(code,1,result.output);
        assert.match(result.output,/segment process group did not stop before settlement deadline/);
      } finally {
        clearTimeout(timer);
        if(group)try{process.kill(-group,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
        if(pid&&await isRunning(pid))killIfAlive(pid,'SIGKILL');
        if(f.child.exitCode===null&&f.child.signalCode===null)f.child.kill('SIGKILL');
        await f.ended;
      }
    });
  }

  if(process.platform!=='linux')console.log('SKIP runner delayed /proc probes: Linux /proc is required');
  if (process.platform !== 'win32') for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    await check(`${signal} cleans descendants after their shell and parent exit, and starts no later segment`, async () => {
      const dir = path.join(root, `signal-${signal}`);
      await fs.mkdir(dir, { recursive: true });
      const pidFile = path.join(dir, 'grandchild.pid');
      const ready = path.join(dir, 'ready');
      const later = path.join(dir, 'later');
      const stubborn = path.join(dir, 'stubborn.mjs');
      const parent = path.join(dir, 'parent.mjs');
      await fs.writeFile(stubborn, `import fs from 'node:fs'; for(const s of ['SIGINT','SIGTERM','SIGHUP']) process.on(s,()=>{}); fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); setInterval(()=>{},1000);`);
      await fs.writeFile(parent, `import fs from 'node:fs'; import {spawn} from 'node:child_process'; for(const s of ['SIGINT','SIGTERM','SIGHUP']) process.on(s,()=>process.exit(0)); spawn(process.execPath,[${JSON.stringify(stubborn)}],{stdio:'inherit'}); fs.writeFileSync(${JSON.stringify(ready)},String(process.ppid)); setInterval(()=>{},1000);`);
      const command = `trap 'exit 0' INT TERM HUP; ${node} ${quote(parent)} & wait`;
      const f = await fixture(`signal-${signal}`, [command, `${node} -e ${quote(`require('fs').writeFileSync(${JSON.stringify(later)},'bad')`)}`]);
      let pid;
      let group;
      let timer;
      try {
        group = Number(await waitForFile(ready));
        pid = Number(await waitForFile(pidFile));
        f.child.kill(signal);
        const result = await Promise.race([f.ended, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('runner did not terminate')), 20000); })]);
        assert.equal(await isRunning(pid), false, 'runner exited with its TERM-ignoring grandchild still alive');
        assert.equal(result.code, 128 + os.constants.signals[signal], result.output);
        assert.equal(await fs.stat(later).then(() => true, () => false), false, 'next segment ran after interrupt');
      } finally {
        clearTimeout(timer);
        if (group) {
          try { process.kill(-group, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        // The group SIGKILL above may still be reaping pid: it can exit between isRunning and kill.
        if (pid && await isRunning(pid)) killIfAlive(pid, 'SIGKILL');
        if (f.child.exitCode === null && f.child.signalCode === null) f.child.kill('SIGKILL');
        await f.ended;
      }
    });
  }
} finally { await fs.rm(root, { recursive: true, force: true }); }

assert.equal(failures.length, 0, `${failures.length} runner fixture(s) failed: ${failures.join('; ')}`);
