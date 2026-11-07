#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { gitEnv } from '../src/git-env.mjs';
import { randomBytes, createHash } from 'node:crypto';

const evidence = process.env.MIRROR_FETCH_EVIDENCE;
const live = pid => {
  if (process.platform === 'linux') {
    try { return !/\) [ZX] /.test(fs.readFileSync('/proc/' + pid + '/stat', 'utf8')); } catch { return false; }
  }
  try { return !/^Z/.test(execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {encoding: 'utf8'}).trim()); } catch { return false; }
};
const scratch = process.env.TMPDIR || path.join(os.homedir(), '.tmp');
fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
const home = fs.mkdtempSync(path.join(scratch, 'mirror-fetch-'));
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
fs.chmodSync(home, 0o700);
const git = (...args) => execFileSync(realGit, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
// Prerequisite failure must precede mutex/receipt/attempt creation.
const prerequisiteMirror = path.join(home, 'missing-python.git');
const prereq = spawnSync(process.execPath, [new URL('../src/mirror-fetch.mjs', import.meta.url).pathname, '--fetch'], {
  input: JSON.stringify({mirror: prerequisiteMirror, url:'file:///unused', timeoutMs:400}),
  env: {...process.env, PATH:home}, encoding:'utf8',
});
assert.equal(prereq.status, 1);
assert.match(prereq.stderr, /Install Python 3.*bridge service PATH/);
for (const suffix of ['', '.fetch-mutex', '.fetch-owner.json', '.fetch-lock', '.fetch-writers']) assert(!fs.existsSync(prerequisiteMirror+suffix));
console.log('PASS missing Python diagnostic before disposable state');
const packs = dir => fs.readdirSync(path.join(dir, 'objects/pack')).filter(n => n.startsWith('tmp_pack_'));
try {
  const src = path.join(home, 'src');
  git('init', '-q', '-b', 'main', src);
  git('-C', src, 'config', 'user.email', 'test@example.invalid');
  git('-C', src, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(src, 'large'), randomBytes(2 * 1024 * 1024));
  git('-C', src, 'add', '.'); git('-C', src, 'commit', '-qm', 'base');
  const a = git('-C', src, 'rev-parse', 'HEAD');
  const pack = execFileSync(realGit, ['-C', src, 'pack-objects', '--all', '--stdout'], { maxBuffer: 8 * 1024 * 1024 });
  fs.writeFileSync(path.join(home, 'input.pack'), pack);
  const proof = path.join(home, 'descriptor.git');
  git('init', '-q', '--bare', proof);
  // Eliminate the wrapper, guardian, Node and anchor as possible lock holders:
  // actual Git alone must retain BOTH the high descriptor and stderr barrier.
  console.log(execFileSync('python3', ['-c', `
import fcntl,os,subprocess,sys,time,json
repo,pack,git=sys.argv[1:]
paths=[repo+'.main',repo+'.writers']
fds=[os.open(p,os.O_CREAT|os.O_RDWR,0o600) for p in paths]
for fd in fds: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
p=subprocess.Popen([git,'-C',repo,'index-pack','--stdin'],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=fds[1],pass_fds=tuple(fds))
try:
 data=open(pack,'rb').read(); p.stdin.write(data[:-40]); p.stdin.flush()
 deadline=time.monotonic()+5
 while not any(n.startswith('tmp_pack_') for n in os.listdir(repo+'/objects/pack')):
  assert time.monotonic()<deadline; time.sleep(.01)
 for fd in fds: os.close(fd)
 for file in paths:
  fd=os.open(file,os.O_RDWR)
  try:
   try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
   except BlockingIOError: pass
   else: raise AssertionError('actual Git dropped inherited ownership: '+file)
  finally: os.close(fd)
 print('PASS sole actual Git descriptor propagation '+json.dumps({'pid':p.pid,'paths':paths}),flush=True)
 p.stdin.close(); assert p.wait(timeout=5)!=0
 for file in paths:
  fd=os.open(file,os.O_RDWR); fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB); os.close(fd)
finally:
 if p.poll() is None: p.kill(); p.wait()
`, proof, path.join(home,'input.pack'), realGit], {encoding:'utf8'}).trim());
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  // Fault injector: real index-pack receives an incomplete real local pack and
  // is killed only after its own tmp_pack exists. No test writes a tmp_pack.
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn, spawnSync} from 'node:child_process';
const args=process.argv.slice(2);
// The fault wrapper must preserve the same inherited regular descriptors as
// trusted Git; Node's default spawn stdio would silently close those descriptors.
const fds=[];
for(const entry of fs.readdirSync('/dev/fd')) {
 const fd=Number(entry); if(fd<3)continue;
 try { if(fs.fstatSync(fd).isFile())fds.push(fd); } catch {}
}
const inherited=Array.from({length:Math.max(2,...fds)-2},(_,i)=>fds.includes(i+3)?i+3:'ignore');

if (args.includes('update-ref') && process.env.FETCH_FAULT?.startsWith('publish-')) {
 if(process.env.FETCH_FAULT==='publish-after') {
  const r=spawnSync(${JSON.stringify(realGit)},args,{stdio:['inherit','inherit','inherit',...inherited]}); if(r.status!==0)process.exit(r.status??1);
 }
 fs.writeFileSync(${JSON.stringify(path.join(home, 'publication'))},process.env.FETCH_FAULT);
 setInterval(()=>{},1000);
 await new Promise(()=>{});
} else
if (!args.includes('fetch') || !process.env.FETCH_FAULT || process.env.FETCH_FAULT.startsWith('publish-')) {
 const r=spawnSync(${JSON.stringify(realGit)},args,{stdio:['inherit','inherit','inherit',...inherited]});process.exit(r.status??1);
}
const dir=args[args.indexOf('-C')+1];
// A live parent anchor must reserve the group while this fetch exits. A
// detached Git leader reaped before a later kill would permit PGID reuse.
const group=Number(spawnSync('ps',['-o','pgid=','-p',String(process.pid)],{encoding:'utf8'}).stdout.trim());
if(group!==process.ppid){console.error('fetch group is not reserved by its live parent anchor');process.exit(9);}
process.kill(group,0);
fs.appendFileSync(${JSON.stringify(path.join(home, 'invocations.jsonl'))},JSON.stringify({args,fault:process.env.FETCH_FAULT,gc:spawnSync(${JSON.stringify(realGit)},['-C',dir,'config','--get','gc.auto'],{encoding:'utf8'}).stdout.trim(),maintenance:spawnSync(${JSON.stringify(realGit)},['-C',dir,'config','--get','maintenance.auto'],{encoding:'utf8'}).stdout.trim()})+'\\n');

const before=new Set(fs.readdirSync(path.join(dir,'objects/pack')));
const child=spawn(${JSON.stringify(realGit)},['-C',dir,'index-pack','--stdin'],{stdio:['pipe','ignore','inherit',...inherited]});
child.stdin.on('error',()=>{});
const data=fs.readFileSync(${JSON.stringify(path.join(home, 'input.pack'))});
child.stdin.write(data.subarray(0,data.length-40));
const timer=setInterval(()=>{
 const files=fs.readdirSync(path.join(dir,'objects/pack')).filter(n=>n.startsWith('tmp_pack_')&&!before.has(n));
 if(!files.length)return;
 clearInterval(timer);
 fs.appendFileSync(${JSON.stringify(path.join(home, 'causal.jsonl'))},JSON.stringify({pid:child.pid,dir,files,mode:process.env.FETCH_FAULT})+'\\n');
 if(process.env.FETCH_FAULT==='combined') {
  // Model a transport that closes naturally after interruption. This timer is
  // owned by the transport, independent of Node and its guardian.
  setTimeout(()=>child.stdin.end(),2000);
  child.once('close',()=>process.exit(7)); return;
 }
 if(process.env.FETCH_FAULT==='timeout'||process.env.FETCH_FAULT==='corrupt-timeout'&&args.includes('--refetch'))return;
 child.kill('SIGKILL');child.once('close',()=>{console.error(process.env.FETCH_FAULT.startsWith('corrupt')&&!args.includes('--refetch')?'missing blob object':'injected interrupted index-pack');process.exit(7);});
},2);
`, { mode: 0o700 });
  const hostConfigs = [path.join(os.homedir(), '.gitconfig'), path.join(os.homedir(), '.config/git/config')];
  const beforeHostConfig = hostConfigs.map(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  process.env.DOT_BRIDGE_WORKSPACE_ROOT = path.join(home, 'ws');
  process.env.DOT_BRIDGE_GITHUB_URL_OWNER_REPO = 'file://' + src;
  const { prepareGithubRepo, mirrorPath } = await import('../src/projects.mjs');
  const input = { github_repo: 'owner/repo', base_sha: a };
  const expectedMirror = mirrorPath('owner/repo', { worker: 'test' });
  git('init', '-q', '--bare', expectedMirror); git('-C', expectedMirror, 'config', 'fetch.unpackLimit', '1');
  const mirror = prepareGithubRepo(input, { worker: 'test' });
  const consumer = path.join(home, 'consumer');
  git('clone', '-q', '--reference', mirror, 'file://' + src, consumer);
  const originalConfig = fs.readFileSync(path.join(mirror, 'config'), 'utf8');
  const originalPacks = fs.readdirSync(path.join(mirror, 'objects/pack'));
  assert(originalPacks.some(n => n.endsWith('.pack')), 'fixture must preserve real finalized packs');
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const packedHashes = originalPacks.map(name => digest(fs.readFileSync(path.join(mirror, 'objects/pack', name))));
  console.log('RETAINED', JSON.stringify({originalPacks,packedHashes,blobSHA256:digest(fs.readFileSync(path.join(src,'large')))}));
  const assertRetained = () => {
    assert(!fs.existsSync(mirror + '.fetch-lock'), 'settled attempt was not cleaned');
    assert.deepEqual(originalPacks.map(name => digest(fs.readFileSync(path.join(mirror, 'objects/pack', name)))), packedHashes);
    assert.deepEqual(execFileSync(realGit, ['-C', consumer, 'show', a + ':large'], { maxBuffer: 8 * 1024 * 1024 }), fs.readFileSync(path.join(src, 'large')));
  };
  const other = path.join(mirror, 'objects/pack/tmp_pack_unrelated');
  fs.writeFileSync(other, 'unrelated active output');
  process.env.PATH = bin + ':' + process.env.PATH;
  process.env.FETCH_FAULT = 'exit';
  for (let i = 0; i < 3; i++) {
    assert.throws(() => prepareGithubRepo(input, { worker: 'test' }), /injected interrupted index-pack/);
    console.log('CAUSAL', fs.readFileSync(path.join(home, 'causal.jsonl'), 'utf8'));
    assert.deepEqual(packs(mirror), ['tmp_pack_unrelated'], 'failed fetch leaked newly created Git tmp_pack');
    assertRetained();
  }
  delete process.env.FETCH_FAULT;
  prepareGithubRepo(input, { worker: 'test' });
  fs.writeFileSync(path.join(src, 'next'), 'incremental'); git('-C', src, 'add', '.'); git('-C', src, 'commit', '-qm', 'next');
  const b = git('-C', src, 'rev-parse', 'HEAD');
  prepareGithubRepo({ ...input, base_sha: b }, { worker: 'test' });
  assert.deepEqual(execFileSync(realGit, ['-C', consumer, 'show', a + ':large'], { maxBuffer: 8 * 1024 * 1024 }), fs.readFileSync(path.join(src, 'large')));
  assert.equal(git('-C', mirror, 'show', b + ':next'), 'incremental');
  assert.equal(fs.readFileSync(path.join(mirror, 'config'), 'utf8'), originalConfig);
  for (const file of originalPacks) assert(fs.existsSync(path.join(mirror, 'objects/pack', file)));
  git('-C',mirror,'fsck','--full');
  console.log('PASS repeated nonzero fetch, unrelated pack, pinned consumer, retry, noop, incremental, config preservation');
  // Short deadline exercises the same fetch helper used by prepareGithubRepo.
  const { fetchMirror } = await import('../src/mirror-fetch.mjs');
  process.env.FETCH_FAULT = 'timeout';
  for (let i = 0; i < 2; i++) {
    assert.throws(() => fetchMirror(mirror, 'file://' + src, process.env, 400), /timed out/);
    assert.deepEqual(packs(mirror), ['tmp_pack_unrelated']);
    assertRetained();
  }
  process.env.FETCH_FAULT = 'corrupt';
  // Both injected failures share one deadline, including setup and settlement.
  // This positive retry case needs headroom; timeout cases stay at 400ms.
  assert.throws(() => fetchMirror(mirror, 'file://' + src, process.env, 5000), /interrupted index-pack/);
  assertRetained();
  process.env.FETCH_FAULT = 'corrupt-timeout';
  assert.throws(() => fetchMirror(mirror, 'file://' + src, process.env, 400), /timed out/);
  assert.deepEqual(packs(mirror), ['tmp_pack_unrelated']);
  assertRetained();
  const invocations = fs.readFileSync(path.join(home, 'invocations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert(invocations.some(call => call.args.includes('--refetch')));
  assert(invocations.filter(call => call.fault === 'timeout').every(call => !call.args.includes('--refetch')), 'timeout must not trigger full refetch');
  for (const call of invocations) {
    assert.equal(call.gc, '0'); assert.equal(call.maintenance, 'false');
    assert(call.args.includes('--no-auto-maintenance'));
    assert(call.args.includes('gc.auto=0')); assert(call.args.includes('maintenance.auto=false'));
  }
  // A real competing supervisor holds the lock while its index-pack is blocked.
  process.env.FETCH_FAULT = 'timeout';
  const competitor = spawn(process.execPath, [new URL('../src/mirror-fetch.mjs', import.meta.url).pathname, '--fetch'], { env: gitEnv(), stdio: ['pipe', 'ignore', 'pipe'] });
  const competed = new Promise(resolve => competitor.once('close', resolve));
  competitor.stdin.end(JSON.stringify({ mirror, url: 'file://' + src, timeoutMs: 1500 }));
  const deadline = performance.now() + 5000;
  while (!fs.existsSync(mirror + '.fetch-lock/repo.git/objects/pack')) {
    assert(performance.now() < deadline, 'competitor did not acquire lock'); await delay(10);
  }
  assert.throws(() => prepareGithubRepo(input, { worker: 'test' }), /already in progress/);
  assert.equal(await competed, 1);
  assertRetained();
  const causes = fs.readFileSync(path.join(home, 'causal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  for (const cause of causes) {
    assert(!fs.existsSync(cause.dir), 'attempt directory retained despite settled child');
    assert(!live(cause.pid), 'index-pack can still write after cleanup');
  }
  delete process.env.FETCH_FAULT;
  // Kill the actual lock-owning Node supervisor while real index-pack writes.
  process.env.FETCH_FAULT = 'timeout';
  const crashed = spawn(process.execPath, [new URL('../src/mirror-fetch.mjs', import.meta.url).pathname, '--fetch'], { env: gitEnv(), stdio: ['pipe', 'ignore', 'pipe'] });
  const crashedExit = new Promise(resolve => crashed.once('close', resolve));
  crashed.stdin.end(JSON.stringify({ mirror, url: 'file://' + src, timeoutMs: 10000 }));
  const count = causes.length;
  const crashDeadline = performance.now() + 5000;
  let writer;
  while (!writer) {
    const lines = fs.readFileSync(path.join(home, 'causal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    writer = lines[count];
    assert(performance.now() < crashDeadline, 'crash fixture never started writing');
    if (!writer) await delay(10);
  }
  const owner = JSON.parse(fs.readFileSync(mirror + '.fetch-lock/owner.json', 'utf8'));
  const guardian = owner.guardian;
  try {
    process.kill(guardian, 'SIGSTOP');
    process.kill(owner.pid, 'SIGKILL');
    assert.throws(() => prepareGithubRepo(input, { worker: 'test' }), /already in progress/);
    assert(fs.existsSync(writer.dir), 'live orphan attempt deleted');
    // The independent anchor may already have settled the writer on either OS.
    process.kill(guardian, 'SIGCONT');
    delete process.env.FETCH_FAULT;
    // The guardian must settle the orphan without any test-assisted kill or
    // lock deletion. Baseline aa7 fails recovery even after child settlement.
    await crashedExit;
    prepareGithubRepo(input, { worker: 'test' });
    assert(!live(writer.pid), 'cleanup raced a live index-pack');
    assertRetained();
    assert(!fs.existsSync(writer.dir), 'crashed attempt retained after automatic recovery');
    console.log('PASS killed supervisor with live index-pack recovers without removing lock');
  } finally {
    try { process.kill(guardian, 'SIGCONT'); } catch {}
    crashed.kill('SIGKILL');
  }
  // Killing the guardian alone must not release Node's inherited ownership.
  process.env.FETCH_FAULT = 'timeout';
  const guardianCrash = spawn(process.execPath, [new URL('../src/mirror-fetch.mjs', import.meta.url).pathname, '--fetch'], { env: gitEnv(), stdio: ['pipe', 'ignore', 'pipe'] });
  const guardianExit = new Promise(resolve => guardianCrash.once('close', resolve));
  const priorCount = fs.readFileSync(path.join(home, 'causal.jsonl'), 'utf8').trim().split('\n').length;
  guardianCrash.stdin.end(JSON.stringify({ mirror, url: 'file://' + src, timeoutMs: 1500 }));
  const guardianDeadline = performance.now() + 5000;
  while (fs.readFileSync(path.join(home, 'causal.jsonl'), 'utf8').trim().split('\n').length === priorCount) {
    assert(performance.now() < guardianDeadline); await delay(10);
  }
  const guardianPid = JSON.parse(fs.readFileSync(mirror + '.fetch-lock/owner.json')).guardian;
  process.kill(guardianPid, 'SIGKILL');
  assert.throws(() => prepareGithubRepo(input, { worker: 'test' }), /already in progress/);
  await guardianExit;
  delete process.env.FETCH_FAULT;
  prepareGithubRepo(input, { worker: 'test' });
  assertRetained();
  console.log('PASS guardian crash retains inherited ownership until Node settles Git');
  // Exercise both death orders and near-simultaneous death. The transport
  // eventually closes its own stream; no test signal settles the actual writer.
  for (const order of ['guardian-first', 'node-first', 'near-simultaneous']) {
    process.env.FETCH_FAULT = 'combined';
    const combined = spawn(process.execPath, [new URL('../src/mirror-fetch.mjs', import.meta.url).pathname, '--fetch'], { env: gitEnv(), stdio: ['pipe','ignore','pipe'] });
    const combinedExit = new Promise(resolve => combined.once('close', resolve));
    const prior = fs.readFileSync(path.join(home, 'causal.jsonl'), 'utf8').trim().split('\n').length;
    combined.stdin.end(JSON.stringify({mirror,url:'file://'+src,timeoutMs:10000}));
    let survivor;
    const deadline = performance.now()+5000;
    while(!survivor) {
      survivor=fs.readFileSync(path.join(home,'causal.jsonl'),'utf8').trim().split('\n').map(JSON.parse)[prior];
      assert(performance.now()<deadline); if(!survivor)await delay(10);
    }
    const owner=JSON.parse(fs.readFileSync(mirror+'.fetch-lock/owner.json'));
    // ps locates only fixture-owned processes for fault injection, never cleanup.
    const parentOf = pid => Number(execFileSync('ps',['-o','ppid=','-p',String(pid)],{encoding:'utf8'}).trim());
    const transport=parentOf(survivor.pid);
    const anchor=parentOf(transport);
    process.kill(transport,'SIGSTOP');
    if(anchor)process.kill(anchor,'SIGSTOP');
    process.kill(owner.guardian,'SIGSTOP');
    try {
      const deaths=order==='node-first'?[owner.pid,owner.guardian]:[owner.guardian,owner.pid];
      process.kill(deaths[0],'SIGKILL');
      if(order!=='near-simultaneous')await delay(30);
      process.kill(deaths[1],'SIGKILL');
      assert(live(survivor.pid),'actual Git writer did not survive injected deaths');
      assert.throws(()=>prepareGithubRepo(input,{worker:'test'}),/already in progress/);
      assert(fs.existsSync(survivor.dir),'cleanup raced live writer');
      console.log('PASS combined-death exclusion',JSON.stringify({order,survivor,transport,anchor,owner}));
    } finally {
      if(live(transport))process.kill(transport,'SIGCONT');
      if(anchor&&live(anchor))process.kill(anchor,'SIGCONT');
      try {process.kill(owner.guardian,'SIGCONT');} catch {}
    }
    await combinedExit;
    delete process.env.FETCH_FAULT;
    const recoverUntil=performance.now()+5000;
    while([survivor.pid,transport,...(anchor?[anchor]:[])].some(live)) {
      assert(performance.now()<recoverUntil,'production lifecycle/transport EOF failed to settle'); await delay(10);
    }
    prepareGithubRepo(input,{worker:'test'}); assertRetained();
    console.log('PASS combined-death recovery without writer kill or lock edits',order);
  }
  // Kill at both publication boundaries of the legacy full-ref API. Admission
  // now fetches immutable pins and intentionally leaves these branch refs alone.
  fetchMirror(mirror, 'file://' + src, process.env, 10000);
  for (const phase of ['publish-before', 'publish-after']) {
    fs.writeFileSync(path.join(src, 'boundary'), phase);
    git('-C', src, 'add', '.'); git('-C', src, 'commit', '-qm', phase);
    const previous = git('-C', mirror, 'rev-parse', 'refs/heads/main');
    const next = git('-C', src, 'rev-parse', 'HEAD');
    process.env.FETCH_FAULT = phase;
    const run = spawn(process.execPath, [new URL('../src/mirror-fetch.mjs', import.meta.url).pathname, '--fetch'], { env: gitEnv(), stdio: ['pipe', 'ignore', 'pipe'] });
    const exited = new Promise(resolve => run.once('close', resolve));
    run.stdin.end(JSON.stringify({ mirror, url: 'file://' + src, timeoutMs: 10000 }));
    const until = performance.now() + 5000;
    while (!fs.existsSync(path.join(home, 'publication'))) {
      assert(performance.now() < until, 'publication boundary not reached'); await delay(10);
    }
    try {
      assert.equal(git('-C', mirror, 'show', next + ':boundary'), phase, 'objects must precede refs');
      assert.equal(git('-C', mirror, 'rev-parse', 'refs/heads/main'), phase === 'publish-before' ? previous : next);
      process.kill(JSON.parse(fs.readFileSync(mirror + '.fetch-lock/owner.json')).pid, 'SIGKILL');
      await exited;
      delete process.env.FETCH_FAULT;
      fetchMirror(mirror, 'file://' + src, process.env, 10000);
      assertRetained();
      assert.equal(git('-C', mirror, 'rev-parse', 'refs/heads/main'), next);
    } finally { run.kill('SIGKILL'); fs.unlinkSync(path.join(home, 'publication')); }
  }
  // Receipt corruption must neither delete private data nor touch mirror packs.
  const receiptPath = mirror + '.fetch-owner.json';
  const receipt = fs.readFileSync(receiptPath);
  const mutexInode = fs.statSync(mirror + '.fetch-mutex').ino;
  for (const contents of [null, Buffer.from('corrupt')]) {
    fs.mkdirSync(mirror + '.fetch-lock');
    fs.writeFileSync(mirror + '.fetch-lock/sentinel', 'preserve');
    if (contents) fs.writeFileSync(receiptPath, contents); else fs.unlinkSync(receiptPath);
    assert.throws(() => prepareGithubRepo(input, { worker: 'test' }), /receipt missing or corrupt/);
    assert.equal(fs.readFileSync(mirror + '.fetch-lock/sentinel', 'utf8'), 'preserve');
    fs.writeFileSync(receiptPath, receipt);
    // Simulated restart: no owner process exists; stale PID/boot data has no authority.
    fs.writeFileSync(mirror + '.fetch-lock/owner.json', JSON.stringify({ pid: process.pid, boot: 'old-boot' }));
    prepareGithubRepo(input, { worker: 'test' });
    assertRetained();
    assert.equal(fs.statSync(mirror + '.fetch-mutex').ino, mutexInode, 'lock inode replaced');
  }
  fs.unlinkSync(receiptPath);
  fs.writeFileSync(receiptPath + '.new', 'interrupted publication');
  prepareGithubRepo(input, { worker: 'test' });
  assertRetained();
  assert(!fs.existsSync(receiptPath + '.new'));
  console.log('PASS publication crash boundaries, receipt fail-safe, restart/PID independence, stable lock inode');
  assert.equal(fs.readFileSync(other, 'utf8'), 'unrelated active output');
  assert.deepEqual(hostConfigs.map(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null), beforeHostConfig);
  console.log('PASS corruption fallback failure, GC policy, timeout child settlement and fail-closed mirror contention');
} finally {
  if (evidence && fs.existsSync(path.join(home, 'causal.jsonl'))) fs.copyFileSync(path.join(home, 'causal.jsonl'), path.join(evidence, process.env.EVIDENCE_LABEL + '-causal.jsonl'));
  fs.rmSync(home, { recursive: true, force: true });
}
