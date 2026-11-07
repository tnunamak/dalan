import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {readHostStart,writeHostReverify,readVerifiedHostStop,validBootId} from './host-budget-receipts.mjs';
import {readCgroupProcesses} from './host-cgroup.mjs';
import {HOST_UNIT} from './host-budget.mjs';

const currentBootId=()=>fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
// Only "inactive" or "failed" shows the unit is gone. Any other answer, error or timeout counts as still active.
function hostUnitInactive() {
  const r=spawnSync('/usr/bin/systemctl',['--user','is-active',HOST_UNIT],{encoding:'utf8',timeout:5000});
  return !r.error&&['inactive','failed'].includes((r.stdout??'').trim());
}
// A missing cgroup directory means no process remains. Any other read error propagates and keeps the stop unverified.
function scanCgroup(dir) {
  try {fs.lstatSync(dir);} catch(error) {if(error.code==='ENOENT') return [];throw error;}
  return readCgroupProcesses(dir);
}

// A stop that was recorded unverified, or never recorded, is permanent unless fresh evidence shows nothing of the unit can run.
// Accepted proof, and nothing else:
//   (a) the boot id now differs from the one in the start receipt: a reboot ended every process;
//   (b) the same boot, the unit is no longer active, and a fresh scan of the recorded cgroup finds no process in its whole tree.
// A missing or unreadable boot id, any read error or any surviving process leaves the stop unverified.
// The original stop receipt is never changed; the proof goes into a separate link-once record.
export function reverifyHostStop({receiptDir,checkRunId},{bootId=currentBootId,unitInactive=hostUnitInactive,scan=scanCgroup}={}) {
  try {
    const existing=readVerifiedHostStop({receiptDir,checkRunId});
    if(existing) return existing;
    const start=readHostStart({receiptDir,checkRunId});
    if(!start||start.notStarted||!validBootId(start.boot_id)) return null;
    const now=bootId();
    if(!validBootId(now)) return null;
    let basis;
    if(now!==start.boot_id) basis='boot_changed';
    else if(typeof start.cgroup==='string'&&unitInactive()===true) {
      const remaining=scan('/sys/fs/cgroup'+start.cgroup);
      if(Array.isArray(remaining)&&remaining.length===0) basis='cgroup_empty';
    }
    if(!basis) return null;
    try {writeHostReverify({receiptDir,checkRunId,invocationId:start.invocationId,basis,bootId:start.boot_id,currentBootId:now});}
    catch(error) {if(error?.code!=='EEXIST') return null;}
    return readVerifiedHostStop({receiptDir,checkRunId});
  } catch {return null;}
}
