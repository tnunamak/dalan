#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callT3 } from '../src/t3.mjs';

const dir=await mkdtemp(join(tmpdir(),'t3-process-bound-'));
const bin=join(dir,'fake-t3'),marker=join(dir,'descendant-survived'),pidfile=join(dir,'descendant.pid');
const names=['NODE_ENV','DOT_BRIDGE_T3CODE_BIN','T3_TEST_MARKER','T3_TEST_PIDFILE'];
const previous=new Map(names.map(name=>[name,process.env[name]]));
const timeoutMs=5000;
async function descendant(pid) {
  try {
    const state=await readFile(`/proc/${pid}/stat`,'utf8');
    const fields=state.slice(state.lastIndexOf(')')+2).split(' ');
    return {state:fields[0],group:Number(fields[2]),parent:Number(fields[1])};
  } catch(error) { if(error.code==='ENOENT') return null; throw error; }
}
async function assertStopped(pid,label) {
  assert.ok(Number.isSafeInteger(pid)&&pid>1,`${label} fixture must identify an actual descendant PID`);
  const process=await descendant(pid);
  assert.ok(!process||['Z','X'].includes(process.state),`${label} descendant is no longer executing`);
}
try {
  const spawnDescendant=process.platform==='linux'
    ? `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',"const fs=require('node:fs'),s=fs.readFileSync('/proc/'+process.pid+'/stat','utf8'),f=s.slice(s.lastIndexOf(')')+2).split(' ');fs.writeFileSync(process.env.T3_TEST_PIDFILE,JSON.stringify({pid:process.pid,parent:process.ppid,group:Number(f[2])}));process.send('ready');setTimeout(()=>fs.writeFileSync(process.env.T3_TEST_MARKER,'alive'),10000)"],{stdio:['ignore','ignore','ignore','ipc']});const ready=new Promise(resolve=>child.once('message',resolve));`
    : `const ready=Promise.resolve();`;
  await writeFile(bin,`#!${process.execPath}\n${spawnDescendant}\nsetInterval(()=>{},1000);\n`,{mode:0o700});
  await chmod(bin,0o700);
  process.env.NODE_ENV='test'; process.env.DOT_BRIDGE_T3CODE_BIN=bin; process.env.T3_TEST_MARKER=marker;process.env.T3_TEST_PIDFILE=pidfile;
  if(process.platform!=='win32') {
    await writeFile(bin,`#!${process.execPath}\nprocess.kill(process.pid,'SIGTERM');\n`,{mode:0o700});
    await assert.rejects(callT3(['threads','inspect'],'',{timeoutMs}),error=>
      error.exitCode===null&&error.signal==='SIGTERM'&&/signal SIGTERM/.test(error.message),
    'a signaled CLI failure must retain its signal rather than only exit null');
    await writeFile(bin,`#!${process.execPath}\n${spawnDescendant}\nsetInterval(()=>{},1000);\n`,{mode:0o700});
  }
  const started=Date.now();
  await assert.rejects(callT3(['threads','read'],'',{timeoutMs,maxOutputBytes:1024}),/timeout after 5000ms/);
  assert.ok(Date.now()-started<timeoutMs+5000,'timed-out process group must settle promptly');
  if(process.platform==='linux') { const child=JSON.parse(await readFile(pidfile,'utf8'));assert.equal(child.group,child.parent,'timeout fixture descendant stayed in the owned process group');await assertStopped(child.pid,'timeout'); }
  await new Promise(resolve=>setTimeout(resolve,800));
  assert.equal(await readFile(marker,'utf8').then(()=>true,()=>false),false,'timed-out descendant was killed before releasing the probe lock');
  await rm(pidfile,{force:true});await rm(marker,{force:true});
  await writeFile(bin,`#!${process.execPath}\n${spawnDescendant}\nready.then(()=>process.stdout.write('0123456789'));\nsetInterval(()=>{},1000);\n`,{mode:0o700});
  const outputStarted=Date.now();
  await assert.rejects(callT3(['threads','read'],'',{timeoutMs,maxOutputBytes:4}),/output exceeded 4 bytes/);
  assert.ok(Date.now()-outputStarted<timeoutMs,'output overflow kills and settles the process group promptly');
  if(process.platform==='linux') { const child=JSON.parse(await readFile(pidfile,'utf8'));assert.equal(child.group,child.parent,'overflow fixture descendant stayed in the owned process group');await assertStopped(child.pid,'output overflow'); }
  await rm(pidfile,{force:true});await rm(marker,{force:true});
  await writeFile(bin,`#!${process.execPath}\n${spawnDescendant}\nready.then(()=>{process.stdout.write(JSON.stringify({ok:true,data:{}}));process.exit(0)});\n`,{mode:0o700});
  await callT3(['threads','read'],'',{timeoutMs,maxOutputBytes:1024});
  if(process.platform==='linux') {
    const child=JSON.parse(await readFile(pidfile,'utf8'));
    assert.equal(child.group,child.parent,'success fixture descendant stayed in the owned process group');
    await assertStopped(child.pid,'successful leader exit');
  }
  await new Promise(resolve=>setTimeout(resolve,800));
  assert.equal(await readFile(marker,'utf8').then(()=>true,()=>false),false,'successful leader cannot leave a same-group delayed callback running');
  console.log('PASS success, timeout and output overflow settle owned process-group descendants before return');
} finally {
  if(process.platform==='linux') {
    const child=await readFile(pidfile,'utf8').then(JSON.parse,error=>{if(error.code==='ENOENT')return null;throw error;});
    if(child&&Number.isSafeInteger(child.group)&&child.group>1) {
      try { process.kill(-child.group,'SIGKILL'); } catch(error) { if(error.code!=='ESRCH')throw error; }
    }
  }
  for(const [name,value] of previous) if(value===undefined) delete process.env[name]; else process.env[name]=value;
  await rm(dir,{recursive:true,force:true});
}
