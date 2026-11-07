// Trusted systemd main process. Configuration travels over a bounded pipe;
// optional private receipts record positive launch/stop identity, never TTL-based release.
import fs from 'node:fs';
import {writeHostStart,validateReceiptIdentity} from './host-budget-receipts.mjs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import readline from 'node:readline';
const lines=readline.createInterface({input:process.stdin});
let child=null;
let monitor=null;
lines.on('line',line=>{
  if(child){child.stdin.write(line+'\n');return;}
  const config=JSON.parse(line);
  const relative=fs.readFileSync('/proc/self/cgroup','utf8').split('\n').find(l=>l.startsWith('0::'))?.slice(3);
  if(!relative||relative.includes('..')) throw new Error('unified cgroup required');
  const cgroup='/sys/fs/cgroup'+relative;
  const limit=name=>fs.readFileSync(cgroup+'/'+name,'utf8').trim();
  const cpuMax=limit('cpu.max').split(/\s+/);
  const cpuBounded=cpuMax.length===2&&cpuMax.every(value=>/^[1-9]\d*$/.test(value)&&Number.isSafeInteger(Number(value)))&&Number(cpuMax[0])<=Number(cpuMax[1]);
  if(limit('memory.max')!==String(config.budgets.memory_bytes)||limit('memory.swap.max')!=='0'||limit('pids.max')!==String(config.budgets.processes)||!cpuBounded) throw new Error('required cgroup limits unavailable');
  // Keep kernel-enforced whole-group OOM kills even though systemd must not
  // turn them into the desktop's misleading system-wide shortage notice.
  fs.writeFileSync(cgroup+'/memory.oom.group','1');
  if(limit('memory.oom.group')!=='1') throw new Error('whole-group OOM kill unavailable');
  let guestLine=line,childEnv=process.env;
  if(config.receipts!==undefined) {
    const {checkRunId,receiptDir}=config.receipts??{};
    validateReceiptIdentity(checkRunId,process.env.INVOCATION_ID);
    // The ledger stays outside the copied workspace and every read-only guest
    // mount. maskPaths contains workspace-relative files, never host directories.
    // The ID is supplied by systemd, but existence is proved by this durable
    // trusted write after cgroup limits are checked and before any guest launch.
    writeHostStart({receiptDir,checkRunId,invocationId:process.env.INVOCATION_ID,bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),cgroup:relative});
    const {receipts,...guestConfig}=config;
    guestLine=JSON.stringify(guestConfig);
    const {INVOCATION_ID,...environment}=process.env;
    childEnv=environment;
  }
  process.stdout.write(JSON.stringify({event:'pid',pid:process.pid})+'\n');
  child=spawn('/usr/bin/python3',[fileURLToPath(new URL('./host-budget-storage.py',import.meta.url)),guestLine,cgroup],{stdio:['pipe','inherit','inherit'],env:childEnv});
  // This observer stays outside the guest and also covers archive preparation,
  // when the namespace supervisor may be blocked reading/extracting input.
  monitor=setInterval(()=>{
    const cpu=Number(limit('cpu.stat').match(/^usage_usec (\d+)/m)?.[1])/1000;
    if(cpu>=config.budgets.cpu_ms){
      process.stdout.write(JSON.stringify({event:'result',result:{error:'budget exceeded: cpu',exit:{code:125},phases:[],usage:{cpu_ms:cpu}}})+'\n');
      process.exit(125);
    }
  },10);
  child.stdin.on('error',()=>{});
  child.once('error',()=>process.exit(125));
  child.once('exit',code=>{clearInterval(monitor);process.exit(code??125);});
});
lines.on('close',()=>{if(child)child.kill('SIGKILL');else process.exit(125);});
