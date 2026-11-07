#!/usr/bin/env node
// scripts/worker-bridge-setup.mjs: unit content, modes, refusals, --start and the second-run refusal.
// Runs with a fake systemctl first on PATH and a throwaway XDG_CONFIG_HOME; it never touches real units or homes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { run } from './worker-bridge-setup.mjs';
import { githubAuthRecovery } from '../src/projects.mjs';
import { WORKER_INSTRUCTIONS } from '../src/worker-instructions.mjs';
// These tests replace the service manager with shims, so no bridge ever opens the admin socket that --start waits for.
process.env.DALAN_SETUP_SOCKET_WAIT_MS = '0';

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ps-'));
const bin = path.join(root, 'bin'), xdg = path.join(root, 'xdg'), calls = path.join(root, 'systemctl.log');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'launchctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$@" >> ${calls}\nif [ "$1 $2" = "--user show-environment" ]; then\n  echo "TOKEN=private-manager-value"\n  [ "$MANAGER_READY" != 0 ] || exit 1\n  [ "$SLOW_MANAGER" != 1 ] || sleep 1\nfi\nif [ "$1 $2" = "--user daemon-reload" ] && [ "$FAIL_RELOAD" = 1 ]; then exit 1; fi\nif [ "$1 $2" = "--user enable" ] && [ "$FAIL_ENABLE" = 1 ]; then exit 1; fi\nif [ "$1 $2" = "--user daemon-reload" ] && [ "$KILL_RELOAD" = 1 ]; then kill -KILL "$PPID"; fi\nif [ "$1 $2" = "--user show-environment" ] && [ "$KILL_MANAGER" = 1 ]; then kill -KILL "$PPID"; fi\n`, { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'loginctl'), '#!/bin/sh\necho "$*" >> "$LOGINCTL_LOG"\nprintf "%s\\n" "${LINGER_VALUE:-no}"\n', { mode: 0o755 });
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: xdg, HOME: path.join(root, 'userhome') };
assert.equal(spawnSync('sh', ['-c', 'command -v launchctl'], { env, encoding: 'utf8' }).stdout.trim(), path.join(bin, 'launchctl'), 'launchctl must resolve to the fixture');
env.LOGINCTL_LOG = path.join(root, 'loginctl.log');
const script = new URL('./worker-bridge-setup.mjs', import.meta.url).pathname;
// These assertions exercise systemd even on a macOS test host; launchd has its
// own shim-backed coverage below, including the native CLI on macOS.
const linuxScript = path.join(root, 'linux-setup.mjs');
fs.writeFileSync(linuxScript, `import {run} from ${JSON.stringify(new URL('./worker-bridge-setup.mjs',import.meta.url).href)};
try { await run(process.argv.slice(2),{platform:'linux'}); }
catch(error) { console.error('worker-bridge-setup: '+error.message); process.exit(1); }
`);
const setup = (...a) => spawnSync(process.execPath, [linuxScript, ...a], { env, encoding: 'utf8' });
const setupWith = (extraEnv, ...a) => spawnSync(process.execPath, [linuxScript, ...a], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
const base = home => ['--persistent', '--worker', 'lark', '--public-url', 'https://lark-bridge.example.test', '--port', '18788', '--home', home];
const mode = f => fs.statSync(f).mode & 0o777;
const unitDir = path.join(xdg, 'systemd/user');
const snapshotTree = dir => {
  const files={};
  const visit=(at,rel='')=>{ for(const entry of fs.readdirSync(at,{withFileTypes:true})) { const next=path.join(rel,entry.name),full=path.join(at,entry.name); if(entry.isDirectory()) visit(full,next); else files[next]={mode:mode(full),bytes:fs.readFileSync(full)}; } };
  visit(dir); return files;
};

try {
  // Foreign/malformed lock paths are never deleted to make installation proceed.
  const testLockRoot=path.join(root,'test-locks'),lockPath=path.join(testLockRoot,'install.lock');
  fs.mkdirSync(testLockRoot,{mode:0o700});
  fs.mkdirSync(lockPath,{mode:0o700});
  assert.throws(()=>run(['--worker','lockgap','--public-url','https://lockgap.example.test','--port','18792','--home',path.join(root,'lock-gap-home')],{platform:'linux',env,setupLockRoot:testLockRoot,log:()=>{}}),/not a private regular file/);
  assert.deepEqual(fs.readdirSync(lockPath),[],'foreign lock directory remains untouched');
  fs.rmSync(lockPath,{recursive:true});

  // SQLite's kernel mutex has no owner-publication gap and dies with its holder.
  fs.writeFileSync(lockPath,'',{mode:0o600,flag:'wx'});
  const readyFile=path.join(root,'lock-held');
  const held=spawn(process.execPath,['-e',`const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(lockPath)});db.exec('BEGIN EXCLUSIVE');fs.writeFileSync(${JSON.stringify(readyFile)},'held');setInterval(()=>{},1000);`],{stdio:['ignore','pipe','pipe']});
  const ended=new Promise(resolve=>held.once('close',(code,signal)=>resolve({code,signal})));
  let holderError='';held.stderr.on('data',data=>{holderError+=data;});
  try {
    const deadline=Date.now()+5000;
    while(!fs.existsSync(readyFile)&&held.exitCode===null&&held.signalCode===null&&Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
    assert(fs.existsSync(readyFile),`lock holder must acquire its mutex: ${holderError}`);
    const recoveryArgs=['--worker','lockrecover','--public-url','https://lockrecover.example.test','--port','18792','--home',path.join(root,'lock-recover-home'),'--write-units-only'];
    const recoveryEnv={...env,XDG_CONFIG_HOME:path.join(root,'lock-recover-config')};
    assert.throws(()=>run(recoveryArgs,{platform:'linux',env:recoveryEnv,setupLockRoot:testLockRoot,log(){}}),/another worker-bridge setup is running/);
    assert(!fs.existsSync(recoveryEnv.XDG_CONFIG_HOME),'contender writes no unit state');
    held.kill('SIGKILL');
    assert.equal((await ended).signal,'SIGKILL');
    assert.doesNotThrow(()=>run(recoveryArgs,{platform:'linux',env:recoveryEnv,setupLockRoot:testLockRoot,log(){}}),'next install acquires without removing the persistent lock file');
    assert(fs.existsSync(path.join(recoveryEnv.XDG_CONFIG_HOME,'systemd/user/dot-bridge-lockrecover.service')));
    assert(fs.statSync(lockPath).isFile(),'kernel mutex file remains available for future installs');
  } finally {
    if(held.exitCode===null&&held.signalCode===null) held.kill('SIGKILL');
    await ended;
  }

  // Refusals leave nothing behind.
  for (const [args, text] of [
    [['--worker', 'lark', '--public-url', 'http://lark.example.test', '--port', '18788', '--home', path.join(root, 'h1')], /https/],
    [['--worker', 'lark', '--public-url', 'https://lark.example.test/path', '--port', '18788', '--home', path.join(root, 'h1')], /only scheme/],
    [['--worker', 'lark', '--public-url', 'https://user@lark.example.test', '--port', '18788', '--home', path.join(root, 'h1')], /only scheme/],
    [['--worker', 'lark', '--public-url', 'https://lark.example.test?private=1', '--port', '18788', '--home', path.join(root, 'h1')], /only scheme/],
    [['--worker', 'lark', '--public-url', 'https://lark.example.test#private', '--port', '18788', '--home', path.join(root, 'h1')], /only scheme/],
    [['--worker', 'Bad Name', '--public-url', 'https://lark.example.test', '--port', '18788', '--home', path.join(root, 'h1')], /--worker/],
    [['--worker', 'lark', '--public-url', 'https://lark.example.test', '--port', '80', '--home', path.join(root, 'h1')], /--port/],
    [['--worker', 'lark', '--public-url', 'https://lark.example.test', '--port', '18788', '--home', path.join(root, 'has space')], /unit file/],
    [[...base(path.join(root, 'h1')), '--lan-forward', 'nope'], /--lan-forward/],
  ]) {
    const r = setup(...args);
    assert.notEqual(r.status, 0, args.join(' '));
    assert.match(r.stderr, text);
  }
  assert(!fs.existsSync(path.join(root, 'h1')), 'refusal wrote the requested home');
  assert(!fs.existsSync(unitDir), `refusal created the unit directory: ${unitDir}`);

  const occupied = path.join(root, 'occupied');
  fs.mkdirSync(occupied);
  fs.writeFileSync(path.join(occupied, 'x'), '');
  const refused = setup(...base(occupied));
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /already exists/);
  assert(!fs.existsSync(unitDir), 'non-empty home refusal wrote no units');

  // Happy path with a LAN forwarder, not started.
  const home = path.join(root, 'dbm');
  const ok = setup(...base(home), '--lan-forward', '198.51.100.180:18789');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(mode(home), 0o700);
  assert.equal(mode(path.join(home,'.config/dalan')),0o700,'copied authorization keys stay inside a private config directory');
  const workersFile = path.join(home, '.config/dalan/workers.json');
  assert.equal(mode(workersFile), 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(workersFile, 'utf8')), { workers: { lark: { repos: [] } }, default_execution: 'none' });
  assert(fs.existsSync(path.join(home, '.config/dalan/as.json')), 'init wrote as.json');
  const urlFile = path.join(home, 'resource-url');
  assert.equal(mode(urlFile), 0o600);
  const resourceUrl = fs.readFileSync(urlFile, 'utf8').trim();
  assert.match(resourceUrl, /^https:\/\/lark-bridge\.example\.test\/[a-f0-9]{64}\/mcp$/);
  const secret = resourceUrl.split('/')[3];
  assert(!ok.stdout.includes(secret) && !ok.stderr.includes(secret), 'output never shows the resource URL secret');
  assert(ok.stdout.includes(urlFile), 'output names the resource URL file');
  // The same worker guidance that `dalan try` writes sits next to the resource URL file, so one recipe path works for both.
  const guideFile = path.join(home, 'worker-instructions.md');
  assert.equal(mode(guideFile), 0o600);
  assert.equal(fs.readFileSync(guideFile, 'utf8'), WORKER_INSTRUCTIONS);
  assert(ok.stdout.includes('systemctl --user daemon-reload && systemctl --user enable --now dot-bridge-lark.service dot-bridge-lark-lan.socket'));
  assert(ok.stdout.includes('connect start --worker lark') && ok.stdout.includes('connect pending') && ok.stdout.includes('connect approve CODE --worker lark'));
  assert(ok.stdout.includes(`dalan() { HOME='${home}' `), 'generated helper uses selected bridge HOME');
  assert(!fs.existsSync(calls), 'systemctl not called without --start');

  const service = fs.readFileSync(path.join(unitDir, 'dot-bridge-lark.service'), 'utf8');
  const lines = service.split('\n');
  const execLine = lines.find(l => l.startsWith('ExecStart='));
  const unitNode = execLine.slice('ExecStart='.length).replace(/ src\/server\.mjs$/, '');
  assert(path.isAbsolute(unitNode) && fs.realpathSync(unitNode) === fs.realpathSync(process.execPath), 'absolute node path resolving to the running node');
  assert(path.isAbsolute(process.execPath));
  for (const want of [`Environment=HOME=${home}`, 'Environment=NODE_ENV=production', 'Environment=DALAN_AUTH_MODE=builtin', 'Environment=DALAN_ENABLE_WORKSPACE=1', 'Environment=DALAN_PORT=18788',
    `Environment=PATH=${[...new Set([path.dirname(unitNode), '/opt/homebrew/bin', '/home/linuxbrew/.linuxbrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])].join(':')}`, 'UnsetEnvironment=OPENAI_API_KEY ANTHROPIC_API_KEY', 'Restart=on-failure', 'WantedBy=default.target']) {
    assert(lines.includes(want), `service has ${want}`);
  }
  const callerHome = path.join(root, 'caller-home'), callerGhBin = path.join(root, 'caller-homebrew/bin');
  const serviceGhBin = path.join(root, 'opt/homebrew/bin');
  fs.mkdirSync(path.join(callerHome, '.config/gh'), { recursive: true }); fs.mkdirSync(callerGhBin, { recursive: true }); fs.mkdirSync(serviceGhBin, { recursive: true });
  fs.writeFileSync(path.join(callerHome, '.config/gh/token'), 'caller-fixture-token-must-not-leak');
  const callerGh = path.join(callerGhBin, 'gh');
  fs.writeFileSync(callerGh, '#!/bin/sh\nif [ "$1" = auth ] && [ "$2" = token ]; then /bin/cat "$HOME/.config/gh/token"; exit 0; fi\nexit 1\n', { mode: 0o755 });
  const callerAuth = spawnSync(callerGh, ['auth', 'token'], { env: { ...env, HOME: callerHome }, encoding: 'utf8' });
  assert.equal(callerAuth.status, 0, 'caller has a working GitHub CLI credential');
  const servicePath = lines.find(l => l.startsWith('Environment=PATH=')).slice('Environment=PATH='.length).split(':');
  assert(!servicePath.includes(callerGhBin), 'generated service PATH does not inherit a caller-only gh directory');
  assert.notEqual(home, callerHome, 'service HOME isolates caller GitHub credentials');
  assert(servicePath.includes('/opt/homebrew/bin'), 'service PATH includes the Homebrew gh location');
  fs.mkdirSync(path.join(home, '.config/gh'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, '.config/gh/token'), 'service-fixture-token');
  fs.copyFileSync(callerGh, path.join(serviceGhBin, 'gh')); fs.chmodSync(path.join(serviceGhBin, 'gh'), 0o755);
  const serviceAuth = spawnSync('gh', ['auth', 'token'], { env: { HOME: home, PATH: serviceGhBin }, encoding: 'utf8' });
  assert.equal(serviceAuth.status, 0, 'the documented service HOME plus its separate Homebrew-shaped gh path authenticates');
  assert.equal(serviceAuth.stdout.trim(), 'service-fixture-token', 'the service reads its own credential');
  assert(!serviceAuth.stdout.includes('caller-fixture-token-must-not-leak'), 'service authentication does not use the caller credential');
  const authFailure = githubAuthRecovery(new Error('gh: not found; no OAuth token configured fixture-token-must-not-leak'));
  assert.match(authFailure.message, /gh auth login/);
  assert(!authFailure.message.includes('fixture-token-must-not-leak'), 'authentication recovery does not echo credential-bearing errors');
  assert(lines.some(l => /^WorkingDirectory=\/.+/.test(l)), 'absolute working directory');
  assert(!service.includes(secret) && !/KEY=.+|TOKEN|SECRET/.test(service.replace('UnsetEnvironment=OPENAI_API_KEY ANTHROPIC_API_KEY', '')), 'no secrets in the unit');
  const exposureFile=path.join(home,'dot-bridge-lark.exposure.json');
  fs.writeFileSync(exposureFile,JSON.stringify({mode:'tailscale',worker:'lark',dns_name:'lark-bridge.example.test',public_url:'https://lark-bridge.example.test',public_port:443,local_port:18788}),{mode:0o600});
  const beforeRetry={home:snapshotTree(home),unit:fs.readFileSync(path.join(unitDir,'dot-bridge-lark.service'),'utf8')};
  const retryArgs=['--retry-public-check','--worker','lark','--public-url','https://lark-bridge.example.test','--port','18788','--home',home];
  let checkCalls=0;
  await run(retryArgs,{platform:'linux',env,verifyPublic:async ({url,dnsName})=>{checkCalls++;assert.equal(url,'https://lark-bridge.example.test');assert.equal(dnsName,'lark-bridge.example.test');return true;},resolve4:async()=>null,log:()=>{}});
  assert.equal(checkCalls,1,'matching retry checks its existing public origin');
  for(const [label,args] of [['worker',['--worker','other']],['port',['--port','18789']],['origin',['--public-url','https://other.example.test']],['home',['--home',path.join(root,'unrelated')]]]) {
    let called=false;
    assert.throws(()=>run([...retryArgs,...args],{platform:'linux',env,verifyPublic:async()=>{called=true;return true;},resolve4:async()=>null,log:()=>{}}),/--retry-public-check/);
    assert.equal(called,false,`${label} mismatch refuses before public request`);
  }
  assert.deepEqual({home:snapshotTree(home),unit:fs.readFileSync(path.join(unitDir,'dot-bridge-lark.service'),'utf8')},beforeRetry,'retry leaves credentials, profile and service unchanged');
  const socket = fs.readFileSync(path.join(unitDir, 'dot-bridge-lark-lan.socket'), 'utf8');
  assert(socket.includes('ListenStream=198.51.100.180:18789') && socket.includes('FreeBind=true'));
  const forward = fs.readFileSync(path.join(unitDir, 'dot-bridge-lark-lan.service'), 'utf8');
  assert(/ExecStart=\/\S*systemd-socket-proxyd 127\.0\.0\.1:18788/.test(forward));
  assert(forward.includes('Requires=dot-bridge-lark-lan.socket'));

  // Second run: the home is no longer empty.
  const second = setup(...base(home));
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /already exists/);

  // --write-units-only on a new home name collides with the existing unit files.
  const collide = setup(...base(path.join(root, 'other')), '--write-units-only');
  assert.notEqual(collide.status, 0);
  assert.match(collide.stderr, /already exists/);

  // Init uses a sibling staging HOME. Failure leaves neither a final home nor units.
  const initFailureHome = path.join(root, 'init-failure-home');
  let initHomeSeen;
  assert.throws(() => run(['--worker','initfail','--public-url','https://initfail.example.test','--port','18793','--home',initFailureHome], {
    platform:'linux',env,log:()=>{},initHome:({home:staging})=>{
      initHomeSeen=staging;
      fs.writeFileSync(path.join(staging,'partial-init'),'fixture partial state');
      return {status:7,stderr:'fixture init failure'};
    },
  }), /dalan init failed/);
  assert.notEqual(initHomeSeen,initFailureHome,'init receives a staging HOME, not the final path');
  assert(!fs.existsSync(initFailureHome),'failed init leaves no final home');
  assert(!fs.existsSync(path.join(unitDir,'dot-bridge-initfail.service')),'failed init leaves no unit');

  // A foreign empty destination can appear after preflight. Exclusive mkdir must preserve it.
  const appearedHome=path.join(root,'appeared-empty-home');
  let foreignHomeInode;
  assert.throws(()=>run(['--worker','appeared','--public-url','https://appeared.example.test','--port','18793','--home',appearedHome],{
    platform:'linux',env,log:()=>{},initHome:()=>{fs.mkdirSync(appearedHome,{mode:0o700});foreignHomeInode=fs.statSync(appearedHome).ino;return {status:0,stderr:''};},
  }),/appeared during setup; refusing to replace the existing path/);
  assert.equal(fs.statSync(appearedHome).ino,foreignHomeInode,'empty foreign destination inode is preserved');
  assert.deepEqual(fs.readdirSync(appearedHome),[],'empty foreign destination stays empty');
  assert(!fs.existsSync(path.join(appearedHome,'resource-url')),'setup did not publish into the foreign destination');

  // An existing symlink is rejected before its target can be changed.
  const foreignTarget=path.join(root,'foreign-target'),foreignLink=path.join(root,'foreign-link');
  fs.mkdirSync(foreignTarget);fs.writeFileSync(path.join(foreignTarget,'keep'),'foreign');fs.symlinkSync(foreignTarget,foreignLink);
  assert.throws(()=>run(['--worker','linked','--public-url','https://linked.example.test','--port','18794','--home',foreignLink],{platform:'linux',env,log:()=>{}}),/already exists/);
  assert.equal(fs.readFileSync(path.join(foreignTarget,'keep'),'utf8'),'foreign','foreign symlink target is untouched');
  const symlinkParent=path.join(root,'symlink-parent'),realParent=path.join(root,'real-parent');
  fs.mkdirSync(realParent);fs.symlinkSync(realParent,symlinkParent);
  assert.throws(()=>run(['--worker','parentlink','--public-url','https://parentlink.example.test','--port','18794','--home',path.join(symlinkParent,'home')],{platform:'linux',env,log:()=>{}}),/symbolic link/);
  assert.deepEqual(fs.readdirSync(realParent),[],'setup does not write through a foreign parent symlink');
  const foreignXdg=path.join(root,'foreign-xdg'),linkedXdg=path.join(root,'linked-xdg');
  fs.mkdirSync(foreignXdg);fs.symlinkSync(foreignXdg,linkedXdg);
  const linkedHome=path.join(root,'linked-unit-home');
  assert.throws(()=>run(['--worker','unitlink','--public-url','https://unitlink.example.test','--port','18794','--home',linkedHome],{
    platform:'linux',env:{...env,XDG_CONFIG_HOME:linkedXdg},log:()=>{},
  }),/symbolic link/);
  assert(!fs.existsSync(linkedHome),'unit-directory symlink refusal leaves the home absent');
  assert.deepEqual(fs.readdirSync(foreignXdg),[],'setup does not write through a foreign unit-directory symlink');

  // Explicit default HTTPS port normalizes to the same public origin.
  const defaultPortHome=path.join(root,'default-port-home');
  const defaultPort=setup('--worker','defaultport','--public-url','https://default-port.example.test:443','--port','18795','--home',defaultPortHome);
  assert.equal(defaultPort.status,0,defaultPort.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(defaultPortHome,'.config/dalan/as.json'),'utf8')).public_url,'https://default-port.example.test');

  // A competing writer that appears after preflight gets a friendly refusal; its bytes survive.
  const raceHome=path.join(root,'race-home'),raceUnit=path.join(unitDir,'dot-bridge-racer.service');
  assert.throws(()=>run(['--worker','racer','--public-url','https://racer.example.test','--port','18796','--home',raceHome],{
    platform:'linux',env,log:()=>{},initHome:()=>{fs.writeFileSync(raceUnit,'foreign unit');return {status:0,stderr:''};},
  }),error=>error.code==='SETUP_REFUSED'&&/already exists; refusing to overwrite the existing service unit/.test(error.message));
  assert.equal(fs.readFileSync(raceUnit,'utf8'),'foreign unit','exclusive-create race preserves the foreign unit');

  // Failed manager writes leave truthful recoverable state; owned removal purges it and permits a fresh install.
  for (const [worker, failure] of [['enablefail','FAIL_ENABLE'],['reloadfail','FAIL_RELOAD']]) {
    const failedHome=path.join(root,`${worker}-home`);
    const failed=setupWith({[failure]:'1'},'--worker',worker,'--public-url',`https://${worker}.example.test`,'--port','18797','--home',failedHome,'--start');
    assert.notEqual(failed.status,0,`${worker} should fail`);
    assert.match(failed.stderr,/Generated state is left in place/);
    assert.match(failed.stderr,new RegExp(`--remove --worker ${worker} --home .* --purge-home`));
    assert(fs.existsSync(failedHome)&&fs.existsSync(path.join(unitDir,`dot-bridge-${worker}.service`)),`${worker} retains owned state for recovery`);
    const removed=setup('--remove','--worker',worker,'--home',failedHome,'--purge-home');
    assert.equal(removed.status,0,removed.stderr);
    const retried=setup('--worker',worker,'--public-url',`https://${worker}.example.test`,'--port','18797','--home',failedHome);
    assert.equal(retried.status,0,retried.stderr,`${worker} can install after bounded owned recovery`);
  }

  // SIGKILL during daemon-reload releases the mutex; recovery removes only owned files before retry.
  const killedHome=path.join(root,'killed-home');
  const killed=setupWith({KILL_RELOAD:'1'},'--worker','killed','--public-url','https://killed.example.test','--port','18798','--home',killedHome,'--start');
  assert.equal(killed.signal,'SIGKILL','fake manager killed the installer at daemon-reload');
  assert(fs.existsSync(killedHome)&&fs.existsSync(path.join(unitDir,'dot-bridge-killed.service')),'crash boundary retains complete owned files');
  const recovered=setup('--remove','--worker','killed','--home',killedHome,'--purge-home');
  assert.equal(recovered.status,0,recovered.stderr,'kernel mutex does not strand owned recovery');
  const killedRetry=setup('--worker','killed','--public-url','https://killed.example.test','--port','18798','--home',killedHome);
  assert.equal(killedRetry.status,0,killedRetry.stderr,'reinstall after crash recovery succeeds');

  // SIGKILL during the read-only manager probe creates no install state and releases the mutex.
  const managerKilledHome=path.join(root,'manager-killed-home');
  const managerKilled=setupWith({KILL_MANAGER:'1'},'--worker','managerkill','--public-url','https://managerkill.example.test','--port','18801','--home',managerKilledHome,'--start');
  assert.equal(managerKilled.signal,'SIGKILL','fake manager killed setup before writes');
  assert(!fs.existsSync(managerKilledHome)&&!fs.existsSync(path.join(unitDir,'dot-bridge-managerkill.service')),'manager-probe crash wrote no install state');
  const afterStale=setup('--worker','afterstale','--public-url','https://afterstale.example.test','--port','18802','--home',path.join(root,'after-stale-home'));
  assert.equal(afterStale.status,0,afterStale.stderr,'preflight crash releases ownership for the next setup');

  // Two subprocess installers overlap at the first manager probe. The second refuses before it can inspect or write shared state.
  const overlapHome=path.join(root,'overlap-home');
  fs.writeFileSync(calls,'');
  let firstOut='',firstErr='';
  const first=spawn(process.execPath,[linuxScript,'--worker','overlap','--public-url','https://overlap.example.test','--port','18799','--home',overlapHome,'--start'],{
    env:{...env,SLOW_MANAGER:'1'},stdio:['ignore','pipe','pipe'],
  });
  first.stdout.setEncoding('utf8');first.stdout.on('data',chunk=>firstOut+=chunk);
  first.stderr.setEncoding('utf8');first.stderr.on('data',chunk=>firstErr+=chunk);
  const firstExit=new Promise(resolve=>first.once('close',(status,signal)=>resolve({status,signal})));
  await new Promise((resolve,reject)=>{
    const watcher=fs.watch(calls,()=>{watcher.close();resolve();});
    first.once('error',error=>{watcher.close();reject(error);});
  });
  const overlapping=setup('--worker','overlap2','--public-url','https://overlap2.example.test','--port','18800','--home',overlapHome,'--start');
  assert.notEqual(overlapping.status,0,'overlapping setup is rejected');
  assert.match(overlapping.stderr,/another worker-bridge setup is running/);
  const firstResult=await firstExit;
  assert.equal(firstResult.status,0,`${firstErr}\n${firstOut}`);
  assert(fs.existsSync(path.join(unitDir,'dot-bridge-overlap.service')),'first installer owns its unit');
  assert(!fs.existsSync(path.join(unitDir,'dot-bridge-overlap2.service')),'loser writes no second unit');

  // DALAN_SETUP_LOCK_DIR moves the lock, so a run that sets it neither uses nor waits on the default per-user lock.
  const envLockDir=path.join(root,'env-lock-dir');
  const envLockRun=setupWith({DALAN_SETUP_LOCK_DIR:envLockDir},'--worker','envlock','--public-url','https://envlock.example.test','--port','18805','--home',path.join(root,'envlock-home'),'--write-units-only');
  assert.equal(envLockRun.status,0,envLockRun.stderr);
  assert(fs.statSync(path.join(envLockDir,'install.lock')).isFile(),'lock file lives in the override directory');
  const relLock=setupWith({DALAN_SETUP_LOCK_DIR:'relative-dir'},'--worker','relock','--public-url','https://relock.example.test','--port','18806','--home',path.join(root,'relock-home'),'--write-units-only');
  assert.notEqual(relLock.status,0);
  assert.match(relLock.stderr,/DALAN_SETUP_LOCK_DIR must be an absolute path/);

  // TMPDIR must not split the per-user install lock.
  const alternateTmpA=path.join(root,'alternate-tmp-a'),alternateTmpB=path.join(root,'alternate-tmp-b');
  fs.mkdirSync(alternateTmpA);fs.mkdirSync(alternateTmpB);fs.writeFileSync(calls,'');
  const differentTmpHome=path.join(root,'different-tmp-home');
  const differentTmpFirst=spawn(process.execPath,[linuxScript,'--worker','differenttmp','--public-url','https://differenttmp.example.test','--port','18803','--home',differentTmpHome,'--start'],{
    env:{...env,SLOW_MANAGER:'1',TMPDIR:alternateTmpA},stdio:['ignore','pipe','pipe'],
  });
  let differentTmpOut='',differentTmpErr='';differentTmpFirst.stdout.setEncoding('utf8');differentTmpFirst.stdout.on('data',chunk=>differentTmpOut+=chunk);differentTmpFirst.stderr.setEncoding('utf8');differentTmpFirst.stderr.on('data',chunk=>differentTmpErr+=chunk);
  const differentTmpExit=new Promise(resolve=>differentTmpFirst.once('close',(status,signal)=>resolve({status,signal})));
  await new Promise((resolve,reject)=>{const watcher=fs.watch(calls,()=>{watcher.close();resolve();});differentTmpFirst.once('error',error=>{watcher.close();reject(error);});});
  const differentTmpSecond=setupWith({TMPDIR:alternateTmpB},'--worker','differenttmp2','--public-url','https://differenttmp2.example.test','--port','18804','--home',differentTmpHome,'--start');
  assert.notEqual(differentTmpSecond.status,0,'different TMPDIR setup is serialized');
  assert.match(differentTmpSecond.stderr,/another worker-bridge setup is running/);
  const differentTmpFirstResult=await differentTmpExit;
  assert.equal(differentTmpFirstResult.status,0,`${differentTmpErr}\n${differentTmpOut}`);
  assert(fs.existsSync(path.join(unitDir,'dot-bridge-differenttmp.service')),'first different-TMPDIR installer owns its unit');
  assert(!fs.existsSync(path.join(unitDir,'dot-bridge-differenttmp2.service')),'different-TMPDIR loser wrote no unit');

  // An unavailable user manager refuses --start before home or unit writes.
  const unavailableHome = path.join(root, 'manager-unavailable');
  const unavailable = setupWith({ MANAGER_READY: '0' }, '--worker', 'offline', '--public-url', 'https://offline.example.test', '--port', '18789', '--home', unavailableHome, '--start');
  assert.notEqual(unavailable.status, 0);
  assert.match(unavailable.stderr, /systemd user manager.*unavailable/i);
  assert(!unavailable.stdout.includes('private-manager-value') && !unavailable.stderr.includes('private-manager-value'), 'manager environment output is discarded');
  assert(!fs.existsSync(unavailableHome), 'unavailable manager left no private home');
  assert(!fs.existsSync(path.join(unavailableHome, '.config/dalan')), 'unavailable manager left no private config');
  assert(!fs.existsSync(path.join(unitDir, 'dot-bridge-offline.service')), 'unavailable manager left no unit');
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n').slice(-1), ['--user show-environment'], 'only the read-only manager probe ran');
  const unavailableExposureHome = path.join(root, 'le');
  let linuxFunnelApplied = false;
  assert.throws(() => run(['--worker', 'offline-exposure', '--port', '18789', '--home', unavailableExposureHome, '--expose', 'tailscale', '--start'], {
    platform: 'linux', env: { ...env, MANAGER_READY: '0' }, log() {},
    preflight: () => ({ dnsName: 'offline.example.test', allowed: [443], occupied: new Map(), warnings: [] }),
    applyFunnel() { linuxFunnelApplied = true; },
  }), /systemd user manager is unavailable/);
  assert(!fs.existsSync(unavailableExposureHome), 'unavailable manager left no exposure home');
  assert(!fs.existsSync(path.join(unitDir, 'dot-bridge-offline-exposure.service')), 'unavailable manager left no exposure unit');
  assert(!linuxFunnelApplied && !fs.existsSync(path.join(unavailableExposureHome, 'dot-bridge-offline-exposure.exposure.json')), 'unavailable manager did not change exposure');

  // --start runs the fake systemctl with the right arguments, nothing real.
  fs.writeFileSync(calls,'');
  const home2 = path.join(root, 'dbm2');
  const started = setup('--worker', 'echo', '--public-url', 'https://echo.example.test', '--port', '18790', '--home', home2, '--start');
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), ['--user show-environment', '--user daemon-reload', '--user enable --now dot-bridge-echo.service']);
  assert.match(started.stdout,/WARN user lingering is disabled/,'disabled lingering is a warning only');
  assert.match(started.stdout,/loginctl enable-linger/,'warning gives the supported command');
  assert.match(fs.readFileSync(env.LOGINCTL_LOG,'utf8'),/^show-user \d+ --property=Linger --value/m,'lingering probe is read-only');
  assert.doesNotMatch(fs.readFileSync(env.LOGINCTL_LOG,'utf8'),/enable-linger/,'setup never enables lingering');
  assert(!fs.existsSync(path.join(unitDir, 'dot-bridge-echo-lan.socket')), 'no forwarder unless asked');

  // --remove on Linux stops and deletes the echo units and purges its home; the fake systemctl records the calls.
  const removedEcho = setup('--remove', '--worker', 'echo', '--home', home2, '--purge-home');
  assert.equal(removedEcho.status, 0, removedEcho.stderr);
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n').slice(3), ['--user disable --now dot-bridge-echo.service', '--user daemon-reload']);
  assert(!fs.existsSync(path.join(unitDir, 'dot-bridge-echo.service')) && !fs.existsSync(home2), 'echo unit and home removed');

  // --write-units-only writes units only.
  const home3 = path.join(root, 'dbm3');
  const callsBeforeOffline = fs.readFileSync(calls, 'utf8');
  const unitsOnly = setup('--worker', 'quill', '--public-url', 'https://quill.example.test', '--port', '18791', '--home', home3, '--write-units-only');
  assert.equal(unitsOnly.status, 0, unitsOnly.stderr);
  assert.equal(fs.readFileSync(calls, 'utf8'), callsBeforeOffline, '--write-units-only does not probe the manager');
  assert(fs.existsSync(path.join(unitDir, 'dot-bridge-quill.service')) && !fs.existsSync(home3));

  // macOS (in-process, fake launchctl and plutil first on PATH, throwaway HOME). Nothing here touches a real LaunchAgents dir.
  const mhome = path.join(root, 'mac-user'), mbin = path.join(root, 'mbin');
  const mlog = path.join(root, 'launchctl.log'), plutilLog = path.join(root, 'plutil.log'), loaded = path.join(root, 'loaded');
  const uid = process.getuid();
  fs.mkdirSync(mbin);
  fs.writeFileSync(path.join(mbin, 'launchctl'), `#!/bin/sh\necho "$@" >> ${mlog}\ncase "$1" in\n  bootstrap) [ "$FAIL_BOOTSTRAP" != 1 ] || exit 1; touch ${loaded}; exit 0 ;;\n  bootout) if [ -f ${loaded} ]; then rm -f ${loaded}; exit 0; fi; exit 113 ;;\n  print)\n    echo "TOKEN=private-launchd-value"\n    if [ "$2" = "user/${uid}" ]; then [ "$MANAGER_READY" != 0 ]; exit $?; fi\n    if [ -f ${loaded} ]; then exit 0; fi; exit 113 ;;\nesac\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(mbin, 'plutil'), `#!/bin/sh\necho "plutil $@" >> ${plutilLog}\nfor a; do f=$a; done\ngrep -q '<plist version="1.0">' "$f"\n`, { mode: 0o755 });
  const menv = { ...process.env, PATH: `${mbin}:${process.env.PATH}`, HOME: mhome };
  const agents = path.join(mhome, 'Library/LaunchAgents');
  const plistOf = worker => path.join(agents, `org.dalan.dot-bridge-${worker}.plist`);
  const macRun = argv => { const out = []; run(argv, { platform: 'darwin', env: menv, log: s => out.push(s) }); return out.join('\n'); };
  const quiet = { platform: 'darwin', env: menv, log() {} };
  const macBase = (worker, home, port) => ['--worker', worker, '--public-url', `https://${worker}.example.test`, '--port', String(port), '--home', home];

  // An unavailable launchd user domain refuses --start before home, plist or exposure writes.
  const unavailableMacHome = path.join(root, 'gui-unavailable-home');
  const unavailableMacEnv = { ...menv, MANAGER_READY: '0' };
  let funnelApplied = false;
  assert.throws(() => run(['--worker', 'gui', '--port', '18792', '--home', unavailableMacHome, '--expose', 'tailscale', '--start'], {
    platform: 'darwin', env: unavailableMacEnv, log() {},
    preflight: () => ({ dnsName: 'gui.example.test', allowed: [443], occupied: new Map(), warnings: [] }),
    applyFunnel() { funnelApplied = true; },
  }), /launchd user domain is unavailable/);
  assert(!fs.existsSync(unavailableMacHome), 'unavailable user domain left no private home');
  assert(!fs.existsSync(plistOf('gui')), 'unavailable user domain left no plist');
  assert(!funnelApplied, 'unavailable user domain did not change exposure');
  assert.equal(fs.readFileSync(mlog, 'utf8').trim(), `print user/${uid}`, 'only the read-only launchd domain probe ran');
  fs.rmSync(mlog);

  // Refusals write nothing: --lan-forward is Linux only, and --start is refused on other platforms.
  const fern = path.join(root, 'fern-home');
  assert.throws(() => run([...macBase('fern', fern, 18793), '--lan-forward', '198.51.100.10:18794'], quiet), /Linux only/);
  assert.throws(() => run([...macBase('fern', fern, 18793), '--start'], { platform: 'win32', env: menv, log() {} }), /not supported on this platform/);
  assert(!fs.existsSync(fern) && !fs.existsSync(mhome) && !fs.existsSync(mlog), 'refusals wrote nothing');

  // A launchd bootstrap failure leaves owned files and offers a bounded recovery command.
  const bootfailHome=path.join(root,'bootfail-home'),bootfailPlist=plistOf('bootfail');
  let bootfailMessage='';
  assert.throws(()=>run([...macBase('bootfail',bootfailHome,18792),'--start'],{
    platform:'darwin',env:{...menv,FAIL_BOOTSTRAP:'1'},log:()=>{},
  }),error=>{bootfailMessage=error.message;return /launchctl bootstrap/.test(error.message);});
  assert(fs.existsSync(bootfailHome)&&fs.existsSync(bootfailPlist),'failed bootstrap keeps only the generated home and plist');
  assert.match(bootfailMessage,/--remove --worker bootfail --home .* --purge-home/);
  run(['--remove','--worker','bootfail','--home',bootfailHome,'--purge-home'],{platform:'darwin',env:menv,log:()=>{}});
  assert(!fs.existsSync(bootfailHome)&&!fs.existsSync(bootfailPlist),'bounded recovery removes the failed install');
  fs.rmSync(mlog,{force:true});

  // Plain run: plist content, plutil lint, and no launchctl call without --start.
  const msg = macRun(macBase('fern', fern, 18793));
  const plist = plistOf('fern');
  const operations=fs.readFileSync(new URL('../docs/operations.md',import.meta.url),'utf8');
  const documentedPlist=/`([^`]*NAME\.plist)`/.exec(operations)?.[1];
  assert(documentedPlist,'service access guide documents the generated launchd filename');
  const generatedPlist=msg.split('\n').find(line=>line.startsWith('Wrote ')&&line.endsWith('.plist'))?.slice('Wrote '.length);
  assert.equal(documentedPlist.replace('<home>',menv.HOME).replace('NAME','fern'),generatedPlist,'documented launchd path matches the generator output');
  assert.equal(fs.statSync(plist).mode & 0o777, 0o644);
  const text = fs.readFileSync(plist, 'utf8');
  const envSecret = /BRIDGE_PATH_SECRET=([a-f0-9]{64})/.exec(fs.readFileSync(path.join(fern, '.config/dalan/env'), 'utf8'))[1];
  const fernUrl = fs.readFileSync(path.join(fern, 'resource-url'), 'utf8').trim();
  assert(!text.includes(envSecret) && !text.includes(fernUrl), 'plist holds no secret or resource URL');
  const plistNode = text.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/)[1];
  assert(path.isAbsolute(plistNode) && fs.realpathSync(plistNode) === fs.realpathSync(process.execPath), 'plist uses an absolute node path resolving to the running node');
  assert(text.includes(`<string>${path.join(path.dirname(script), '..', 'src/server.mjs')}</string>`) || text.includes('/src/server.mjs</string>'), 'plist runs src/server.mjs');
  const envValue = key => new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text)?.[1];
  assert.equal(envValue('HOME'), fern);
  assert.equal(envValue('NODE_ENV'), 'production');
  assert.equal(envValue('DALAN_AUTH_MODE'), 'builtin');
  assert.equal(envValue('DALAN_ENABLE_WORKSPACE'), '1', 'repository and artifact tools are on by default');
  {
    const birch = path.join(root, 'birch-home');
    macRun([...macBase('birch', birch, 18795), '--no-repo-tools']);
    assert(!fs.readFileSync(plistOf('birch'), 'utf8').includes('DALAN_ENABLE_WORKSPACE'), '--no-repo-tools leaves the workspace off');
  }
  assert.equal(envValue('DALAN_PORT'), '18793');
  assert.equal(envValue('PATH'), [...new Set([path.dirname(plistNode), '/opt/homebrew/bin', '/home/linuxbrew/.linuxbrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])].join(':'));
  assert(/<key>RunAtLoad<\/key>\s*<true\/>/.test(text) && /<key>KeepAlive<\/key>\s*<true\/>/.test(text), 'RunAtLoad and KeepAlive');
  assert(/<key>LimitLoadToSessionType<\/key>\s*<array>\s*<string>Aqua<\/string>\s*<string>Background<\/string>\s*<\/array>/.test(text), 'the plist can load into the launchd user domain, which has no on-demand-only mode');
  assert.equal(new RegExp(`<key>StandardOutPath</key>\\s*<string>${fern}/logs/`).test(text), true);
  assert.equal(new RegExp(`<key>StandardErrorPath</key>\\s*<string>${fern}/logs/`).test(text), true);
  assert(fs.existsSync(path.join(fern, 'logs')), 'logs directory exists');
  assert(fs.readFileSync(plutilLog, 'utf8').includes('plutil -lint'), 'plist was linted');
  assert(!fs.existsSync(mlog), 'launchctl not called without --start');
  assert(msg.includes(`launchctl bootstrap user/${uid} ${plist}`) && msg.includes(`launchctl bootout user/${uid} ${plist}`), 'prints start and stop commands');
  assert(!msg.includes(envSecret) && !msg.includes(fernUrl), 'output holds no secret');

  // A macOS public-check timeout happens after the service exists. Its printed retry validates and reuses that service.
  const slowHome=path.join(root,'slow-home'),slowUrl='https://slow.tailnet.test:8443',slowArgs=['--worker','slow','--port','18796','--home',slowHome,'--expose','tailscale','--start'];
  const setupSeams={platform:'darwin',env:menv,log(){},preflight:()=>({dnsName:'slow.tailnet.test',allowed:[8443],occupied:new Map(),warnings:[]}),applyFunnel(){},resolve4:async()=>null};
  let publicFailure='';
  await assert.rejects(run(slowArgs,{...setupSeams,verifyPublic:async()=>false}),error=>{
    publicFailure=error.message;
    return new RegExp(`--retry-public-check --worker slow --public-url ${slowUrl.replaceAll('.','\\.')} --port 18796`).test(error.message);
  });
  assert.match(publicFailure,/left in place/);
  assert.match(publicFailure,/--remove --worker slow --home .* --purge-home/);
  const slowSecret=fs.readFileSync(path.join(slowHome,'resource-url'),'utf8').trim().split('/')[3];
  assert(!publicFailure.includes(slowSecret),'failure output never prints the private URL path secret');
  const slowFiles=snapshotTree(slowHome);
  let retried=0;
  await run(['--retry-public-check','--worker','slow','--public-url',slowUrl,'--port','18796','--home',slowHome],{...setupSeams,verifyPublic:async ({url,dnsName})=>{retried++;assert.equal(url,slowUrl);assert.equal(dnsName,'slow.tailnet.test');return true;}});
  assert.equal(retried,1);
  assert.deepEqual(snapshotTree(slowHome),slowFiles,'retry preserves Mac profile, resource URL and keys');
  const slowPlist=plistOf('slow'),originalSlowPlist=fs.readFileSync(slowPlist,'utf8');
  assert(/DALAN_PORT<\/key>\s*<string>18796<\/string>/.test(originalSlowPlist),'retry reused matching launchd service');
  const legacyPlist=originalSlowPlist.replace(/<key>DALAN_(AUTH_MODE|ENABLE_WORKSPACE|PORT)<\/key>/g,'<key>DOT_BRIDGE_$1</key>');
  fs.writeFileSync(slowPlist,legacyPlist);
  await run(['--retry-public-check','--worker','slow','--public-url',slowUrl,'--port','18796','--home',slowHome],{...setupSeams,verifyPublic:async()=>true});
  assert.equal(fs.readFileSync(slowPlist,'utf8'),legacyPlist,'retry accepts legacy environment aliases without rewriting the service');

  fs.writeFileSync(slowPlist,originalSlowPlist.replace('<string>18796</string>','<string>18797</string>')+'\n<!-- previous port 18796 -->\n');
  let badPlistVerified=false;
  assert.throws(()=>run(['--retry-public-check','--worker','slow','--public-url',slowUrl,'--port','18796','--home',slowHome],{...setupSeams,verifyPublic:async()=>{badPlistVerified=true;return true;}}),/does not exactly match/);
  assert.equal(badPlistVerified,false,'launchd port mismatch refuses before public verification');
  fs.writeFileSync(slowPlist,originalSlowPlist);

  // An existing plist is never overwritten: a second home for the same worker is refused and creates nothing.
  const other = path.join(root, 'fern-other');
  assert.throws(() => run(macBase('fern', other, 18793), quiet), /already exists/);
  assert(!fs.existsSync(other), 'refused second home left nothing');

  // --start bootstraps the agent with the fake launchctl.
  const reedHome = path.join(root, 'reed-home'), reedPlist = plistOf('reed');
  macRun([...macBase('reed', reedHome, 18794), '--start']);
  assert(fs.readFileSync(mlog, 'utf8').includes(`bootstrap user/${uid} ${reedPlist}`), 'bootstrap called');
  assert(fs.readFileSync(mlog, 'utf8').includes(`kickstart user/${uid}/`), 'an agent that was bootstrapped is also started');

  // --remove stops the agent (bootout), deletes the plist and keeps the home unless --purge-home is given.
  const removedReed = macRun(['--remove', '--worker', 'reed', '--home', reedHome]);
  assert(!fs.existsSync(reedPlist) && fs.existsSync(reedHome), 'plist gone, home kept');
  assert(fs.readFileSync(mlog, 'utf8').includes(`bootout user/${uid} ${reedPlist}`), 'bootout called');
  assert(removedReed.includes(`Removed ${reedPlist}`));
  macRun(['--remove', '--worker', 'reed', '--home', reedHome, '--purge-home']);
  assert(!fs.existsSync(reedHome), 'purge removed the home');
  assert(macRun(['--remove', '--worker', 'reed', '--home', reedHome]).includes('Nothing to remove'), 'second remove is a no-op');

  // Refusals on --remove touch nothing: a plist without the marker, and a purge target that is not a bridge home.
  const handPlist = plistOf('hand');
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(handPlist, '<plist version="1.0"><dict/></plist>\n');
  assert.throws(() => macRun(['--remove', '--worker', 'hand', '--home', path.join(root, 'hand-home')]), /not created by worker-bridge-setup/);
  assert(fs.existsSync(handPlist), 'unmarked plist kept');
  fs.rmSync(handPlist);
  const notHome = path.join(root, 'not-home');
  fs.mkdirSync(notHome);
  fs.writeFileSync(path.join(notHome, 'keep'), '');
  assert.throws(() => macRun(['--remove', '--worker', 'fern', '--home', notHome, '--purge-home']), /not a bridge home/);
  assert(fs.existsSync(path.join(notHome, 'keep')) && fs.existsSync(plist), 'refused purge stopped nothing');
  {
    // Install-only flags are ignored with one stderr line; the removal itself is unchanged (ghost is not installed, so nothing is removed; fern is left alone).
    const errs = [];
    const orig = console.error;
    console.error = m => errs.push(String(m));
    try { run(['--remove', '--worker', 'ghost', '--home', path.join(root, 'ghost-home'), '--port', '18793', '--start', '--expose', 'tailscale'], quiet); }
    finally { console.error = orig; }
    assert.deepEqual(errs, ['worker-bridge-setup: ignoring install-only flags with --remove: --port --start --expose']);
  }

  // Removing the never-started fern agent: bootout reports not loaded, the probe confirms it, the plist and home go.
  const removedFern = macRun(['--remove', '--worker', 'fern', '--home', fern, '--purge-home']);
  assert(!fs.existsSync(plist) && !fs.existsSync(fern), 'fern plist and home removed');
  assert(removedFern.includes('was not loaded') && removedFern.includes(`Removed bridge home ${fern}`));

  if (process.platform === 'darwin') {
    const cliHome = path.join(root, 'mac-cli-home'), cliPlist = plistOf('maccli');
    assert.equal(spawnSync('sh',['-c','command -v launchctl'],{env:menv,encoding:'utf8'}).stdout.trim(),path.join(mbin,'launchctl'));
    const started = spawnSync(process.execPath,[script,...macBase('maccli',cliHome,18796),'--start'],{env:menv,encoding:'utf8'});
    assert.equal(started.status,0,started.stderr);
    assert(fs.existsSync(cliPlist),'native CLI writes the launchd plist');
    assert(fs.readFileSync(mlog,'utf8').includes(`bootstrap user/${uid} ${cliPlist}`));
    const removed = spawnSync(process.execPath,[script,'--remove','--worker','maccli','--home',cliHome,'--purge-home'],{env:menv,encoding:'utf8'});
    assert.equal(removed.status,0,removed.stderr);
    assert(!fs.existsSync(cliPlist)&&!fs.existsSync(cliHome),'native CLI removes the owned launchd install');
    assert(fs.readFileSync(mlog,'utf8').includes(`bootout user/${uid} ${cliPlist}`));
    console.log('PASS native macOS CLI starts and removes through the launchctl shim');
  }
  console.log('PASS persistent worker bridge setup');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
