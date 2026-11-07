import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const scratch=path.join(os.homedir(),'.tmp');
fs.mkdirSync(scratch,{recursive:true});
const root=fs.mkdtempSync(path.join(scratch,'cpu-readback-'));
const preload=path.join(root,'cgroup-control.mjs');
try {
  fs.writeFileSync(preload,`import fs from 'node:fs';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const read=fs.readFileSync;
const write=fs.writeFileSync;
let oomGroup='0';
fs.readFileSync=(file,...args)=>{
  if(file==='/proc/self/cgroup')return '0::/cpu-readback-control\\n';
  if(file==='/sys/fs/cgroup/cpu-readback-control/memory.max')return '201326592';
  if(file==='/sys/fs/cgroup/cpu-readback-control/memory.swap.max')return '0';
  if(file==='/sys/fs/cgroup/cpu-readback-control/pids.max')return '32';
  if(file==='/sys/fs/cgroup/cpu-readback-control/cpu.max')return process.env.CPU_READBACK_CONTROL;
  if(file==='/sys/fs/cgroup/cpu-readback-control/memory.oom.group')return oomGroup;
  return read(file,...args);
};
fs.writeFileSync=(file,value,...args)=>{
  if(file==='/sys/fs/cgroup/cpu-readback-control/memory.oom.group'){oomGroup=String(value);return;}
  return write(file,value,...args);
};
cp.spawn=(command)=>{
  if(command!=='/usr/bin/python3')throw new Error('unexpected controlled launch');
  console.log('CONTROLLED_STORAGE_STAGE_LAUNCHED');process.exit(0);
};
syncBuiltinESMExports();\n`);
  const service=new URL('../src/host-budget-service.mjs',import.meta.url).pathname;
  for(const value of ['20000 10000','max 10000','0 10000','10000 0','-1 10000','10000 -1','10000','10000 10000 extra','Infinity 10000','1.5 10000','9007199254740993 9007199254740994']) {
    const result=spawnSync(process.execPath,['--import',preload,service],{
      env:{...process.env,CPU_READBACK_CONTROL:value},encoding:'utf8',timeout:5000,
      input:JSON.stringify({budgets:{memory_bytes:201326592,processes:32,cpu_ms:1000}})+'\n',
    });
    assert.ifError(result.error);
    assert.notEqual(result.status,0,`unsafe CPU readback accepted: ${value}`);
    assert.match(result.stderr,/required cgroup limits unavailable/,value);
    assert.doesNotMatch(result.stdout,/CONTROLLED_STORAGE_STAGE_LAUNCHED/,value);
  }
  for(const value of ['10000 10000','5000 10000','20000 20000']) {
    const result=spawnSync(process.execPath,['--import',preload,service],{
      env:{...process.env,CPU_READBACK_CONTROL:value},encoding:'utf8',timeout:5000,
      input:JSON.stringify({budgets:{memory_bytes:201326592,processes:32,cpu_ms:1000}})+'\n',
    });
    assert.ifError(result.error);
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/CONTROLLED_STORAGE_STAGE_LAUNCHED/,value);
  }
  console.log('PASS CPU readback blocks malformed and excessive bandwidth before storage launch; equal or stricter ratios proceed');
} finally {fs.rmSync(root,{recursive:true,force:true});}
