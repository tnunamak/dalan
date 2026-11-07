import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const MAX_BYTES=4096;
const own=stat=>stat.uid===process.getuid();
const syncDir=dir=>{const fd=fs.openSync(dir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
function checkId(checkRunId) {
  if(typeof checkRunId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(checkRunId)) throw new Error('invalid host receipt checkRunId');
}
export function validateReceiptIdentity(checkRunId,invocationId) {
  checkId(checkRunId);
  if(typeof invocationId!=='string'||!/^[a-f0-9]{32}$/.test(invocationId)) throw new Error('invalid host receipt invocation');
}
function root(dir,create=false) {
  if(typeof dir!=='string'||!path.isAbsolute(dir)||path.resolve(dir)!==dir||/[\x00-\x1f\x7f$]/.test(dir)) throw new Error('invalid host receipt directory');
  const parent=path.dirname(dir);
  if(parent===dir||fs.realpathSync(parent)!==parent) throw new Error('host receipt parent must be canonical');
  if(create&&!fs.existsSync(dir)){fs.mkdirSync(dir,{mode:0o700});syncDir(parent);}
  const stat=fs.lstatSync(dir);
  if(!stat.isDirectory()||!own(stat)||(stat.mode&0o777)!==0o700||fs.realpathSync(dir)!==dir) throw new Error('host receipt directory must be private and owned');
  return dir;
}
export function prepareHostReceipts({checkRunId,receiptDir}={}) {
  if(checkRunId===undefined&&receiptDir===undefined) return null;
  if(checkRunId===undefined||receiptDir===undefined) throw new Error('host receipts require checkRunId and receiptDir');
  checkId(checkRunId);
  return {checkRunId,receiptDir:root(receiptDir,true)};
}
function fileFor(dir,checkRunId,invocationId,kind) {
  validateReceiptIdentity(checkRunId,invocationId);
  // A check launches one envelope. Its immutable start record is also the
  // durable check -> invocation lookup, published before any guest can run.
  const key=createHash('sha256').update(JSON.stringify(kind==='start'?[checkRunId]:[checkRunId,invocationId])).digest('hex');
  return path.join(dir,key+'.'+kind+'.json');
}
const unlinkTemp=file=>{try{fs.unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}};
function recoverPrivateAliases(dir,fd) {
  let stat=fs.fstatSync(fd);
  if(stat.nlink===1) return true;
  const aliases=[];
  for(const name of fs.readdirSync(dir)) {
    if(!/^\.receipt-[a-f0-9-]{36}\.tmp$/.test(name)) continue;
    const file=path.join(dir,name);let alias;
    try{alias=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    if(alias.isFile()&&own(alias)&&(alias.mode&0o777)===0o600&&alias.dev===stat.dev&&alias.ino===stat.ino) aliases.push(file);
  }
  stat=fs.fstatSync(fd);
  if(stat.nlink===1) return true; // A concurrent publisher finished its unlink.
  if(stat.nlink!==aliases.length+1) return false; // An unexplained external alias stays refused.
  for(const file of aliases) unlinkTemp(file);
  syncDir(dir);
  return fs.fstatSync(fd).nlink===1;
}
function readRecord(dir,checkRunId,invocationId,kind) {
  // Start lookup needs only the bridge-generated check ID after a crash.
  const file=fileFor(root(dir),checkRunId,invocationId??'0'.repeat(32),kind);
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try {
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||!own(stat)||(stat.mode&0o777)!==0o600||stat.nlink<1||stat.size<2||stat.size>MAX_BYTES) return null;
    const bytes=Buffer.alloc(MAX_BYTES+1);
    let total=0,n;
    while(total<bytes.length&&(n=fs.readSync(fd,bytes,total,bytes.length-total,null))>0)total+=n;
    if(total>MAX_BYTES) return null;
    const record=JSON.parse(bytes.subarray(0,total).toString('utf8'));
    if(record?.version!==1||record.kind!==kind||record.checkRunId!==checkRunId||(invocationId!==undefined&&record.invocationId!==invocationId)) return null;
    validateReceiptIdentity(checkRunId,record.invocationId);
    if(!recoverPrivateAliases(dir,fd)) return null;
    return record;
  } finally {fs.closeSync(fd);}
}
function publish(dir,checkRunId,invocationId,kind,fields={}) {
  root(dir);validateReceiptIdentity(checkRunId,invocationId);
  const record={version:1,kind,checkRunId,invocationId,...fields};
  const bytes=Buffer.from(JSON.stringify(record)+'\n');
  if(bytes.length>MAX_BYTES) throw new Error('host receipt too large');
  const dest=fileFor(dir,checkRunId,invocationId,kind),temp=path.join(dir,'.receipt-'+randomUUID()+'.tmp');
  let fd,created=false;
  try {
    fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);created=true;
    fs.fchmodSync(fd,0o600);
    let written=0;while(written<bytes.length)written+=fs.writeSync(fd,bytes,written,bytes.length-written);
    fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    // link is atomic and refuses an existing destination; rename would overwrite.
    fs.linkSync(temp,dest);syncDir(dir);
    unlinkTemp(temp);created=false;syncDir(dir);
    return record;
  } finally {if(fd!==undefined)fs.closeSync(fd);if(created)unlinkTemp(temp);}
}
const BOOT_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const validBootId=value=>typeof value==='string'&&BOOT_ID.test(value);
const validCgroup=value=>typeof value==='string'&&/^\/[\x21-\x7e]*$/.test(value)&&!value.split('/').includes('..');
// The boot id and cgroup path let a later scan prove the unit's processes are gone after the unit itself is collected.
export function writeHostStart({receiptDir,checkRunId,invocationId,bootId,cgroup}) {
  if(invocationId==='0'.repeat(32)) throw new Error('null systemd invocation');
  const fields={};
  if(bootId!==undefined){if(!validBootId(bootId))throw new Error('invalid boot id');fields.boot_id=bootId;}
  if(cgroup!==undefined){if(!validCgroup(cgroup))throw new Error('invalid cgroup path');fields.cgroup=cgroup;}
  return publish(receiptDir,checkRunId,invocationId,'start',fields);
}
export function readHostStart({receiptDir,checkRunId}) {
  try {checkId(checkRunId);return readRecord(receiptDir,checkRunId,undefined,'start');} catch {return null;}
}
export const REVERIFY_BASES=Object.freeze(['boot_changed','cgroup_empty']);
// Separate from the stop receipt, which is link-once and keeps the original verdict. Written only after a fresh proof.
export function writeHostReverify({receiptDir,checkRunId,invocationId,basis,bootId,currentBootId}) {
  if(!REVERIFY_BASES.includes(basis)||!validBootId(bootId)||!validBootId(currentBootId)) throw new Error('invalid host re-verification evidence');
  const start=readRecord(receiptDir,checkRunId,invocationId,'start');
  if(!start||start.notStarted) throw new Error('matching host start receipt required');
  return publish(receiptDir,checkRunId,invocationId,'reverify',{verified:true,remaining_pids:[],basis,boot_id:bootId,current_boot_id:currentBootId,verified_at:new Date().toISOString()});
}
export function writeHostStop({receiptDir,checkRunId,invocationId,verified,remaining_pids}) {
  if(typeof verified!=='boolean'||!Array.isArray(remaining_pids)||remaining_pids.some(pid=>!Number.isSafeInteger(pid)||pid<=0)) throw new Error('invalid host stop evidence');
  const start=readRecord(receiptDir,checkRunId,invocationId,'start');
  if(!start||start.notStarted) throw new Error('matching host start receipt required');
  return publish(receiptDir,checkRunId,invocationId,'stop',{verified,remaining_pids});
}
export function readVerifiedHostStop({receiptDir,checkRunId,invocationId}) {
  try {
    checkId(checkRunId);
    const start=readRecord(receiptDir,checkRunId,invocationId,'start');
    if(!start) return null;
    if(start.notStarted===true) return start.invocationId==='0'.repeat(32)?{...start,verified:true,remaining_pids:[]}:null;
    let stop=null;
    try {stop=readRecord(receiptDir,checkRunId,start.invocationId,'stop');} catch {}
    if(stop&&stop.verified===true&&Array.isArray(stop.remaining_pids)&&stop.remaining_pids.length===0) return stop;
    // A failed or missing stop verdict is released only by separate fresh evidence.
    const again=readRecord(receiptDir,checkRunId,start.invocationId,'reverify');
    return again&&again.verified===true&&REVERIFY_BASES.includes(again.basis)&&Array.isArray(again.remaining_pids)&&again.remaining_pids.length===0?{...again,reverified:true}:null;
  } catch {return null;}
}

// Every host path the guest can see must be disjoint from the trusted ledger.
// The workspace is copied; rejecting overlap also keeps receipts out of that copy.
export function assertHostReceiptIsolation(receiptDir,exposedPaths) {
  const inside=(a,b)=>a===b||a.startsWith(b+path.sep);
  for(const exposed of exposedPaths) {
    if(!fs.existsSync(exposed)) continue;
    const actual=fs.realpathSync(exposed);
    if(inside(receiptDir,actual)||inside(actual,receiptDir)) throw new Error('host receipt directory overlaps a guest source or runtime path');
  }
}

// Race the trusted service for the same immutable admission slot. If this wins,
// a late service cannot publish its start and must exit before guest launch.
// Only callers which durably enrolled this check in the receipt protocol may seal.
export function sealHostNotStarted({receiptDir,checkRunId}) {
  try {
    prepareHostReceipts({receiptDir,checkRunId});
    publish(receiptDir,checkRunId,'0'.repeat(32),'start',{notStarted:true});
  } catch {}
  return readVerifiedHostStop({receiptDir,checkRunId});
}
