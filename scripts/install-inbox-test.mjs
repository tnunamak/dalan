#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { formatInbox, buildInbox } from '../src/inbox.mjs';
import { githubAuthRecovery } from '../src/projects.mjs';
// These tests replace the service manager with shims, so no bridge ever opens the admin socket that --start waits for.
process.env.DALAN_SETUP_SOCKET_WAIT_MS = '0';

const failures=[];
const check=(name,fn)=>{ try { fn(); console.log(`PASS ${name}`); } catch(error) { failures.push(`${name}: ${error.message}`); console.log(`FAIL ${name}`); } };
const readme=fs.readFileSync(new URL('../README.md',import.meta.url),'utf8');
const usage=fs.readFileSync(new URL('../docs/usage.md',import.meta.url),'utf8');
// The step-by-step setup moved out of the README newcomer path into this guide.
const manualSetup=fs.readFileSync(new URL('../docs/manual-setup.md',import.meta.url),'utf8');
const setup=fs.readFileSync(new URL('./worker-bridge-setup.mjs',import.meta.url),'utf8');
const projects=fs.readFileSync(new URL('../src/projects.mjs',import.meta.url),'utf8');
const server=fs.readFileSync(new URL('../src/server.mjs',import.meta.url),'utf8');
const manifest=JSON.parse(fs.readFileSync(new URL('./test-segments.json',import.meta.url),'utf8'));

check('public repository Quickstart clones over plain HTTPS',()=>assert.match(readme,/git clone https:\/\/github\.com\/tnunamak\/dalan\.git/));
check('manual setup helper follows configured bridge HOME',()=>assert.match(manualSetup,/HOME="\$DALAN_HOME"/));
check('pairing instructions include callback allow-list step',()=>assert.match(manualSetup,/connect allow-callback/));
check('fresh-shell inbox uses all-receipts scope',()=>assert.match(usage,/dalan inbox --all/));
check('ordered test manifest retains this suite after the original runner',()=>{
  const command='node scripts/install-inbox-test.mjs';
  const runner=manifest.indexOf('node scripts/test-segments.mjs --self-test');
  assert(runner>=0,'original runner self-test is missing');
  assert.equal(manifest.indexOf(command),runner+1);
  assert.equal(manifest.filter(entry=>entry===command).length,1);
});
check('setup prints helper and public-check retry command',()=>{
  assert.match(setup,/const dw = `dalan\(\) \{ HOME=/);
  assert.match(setup,/--retry-public-check/);
});
check('printed owner helper is defined once and commands invoke it',()=>{
  assert.equal((setup.match(/dalan\(\) \{/g)||[]).length,1);
  assert.match(setup,/dalan connect start --worker/);
});
check('retry conflicts are rejected before the remove branch',()=>{
  assert(setup.indexOf("args['--retry-public-check'] &&") < setup.indexOf('if (args[\'--remove\'])'));
});
check('retry validates exact generated service representation and saved key material',()=>{
  assert.match(setup,/compatibleText!==expected/);
  assert.match(setup,/as-jwks\.json/);
  assert.match(setup,/BRIDGE_PATH_SECRET/);
});
check('usage guide distinguishes a producer-free shell from a resumed producer',()=>{
  assert.match(usage,/fresh shell with no session/);
  assert.match(usage,/different.*(?:ID|label).*--producer|--producer.*--all/);
  assert.doesNotMatch(usage,/new ID.{0,100}(?:automatically lists all receipts|new session)/);
});
check('missing GitHub credentials have actionable recovery',()=>assert.match(projects,/gh auth login/));
check('GitHub auth failures map to a typed actionable error',()=>{
  const mapped=githubAuthRecovery(new Error("fatal: could not read Username for 'https://github.com': terminal prompts disabled"));
  assert.equal(mapped.code,'DOT_BRIDGE_INFRASTRUCTURE'); assert.match(mapped.message,/gh auth login/); assert.match(mapped.message,/GH_TOKEN/);
  assert.match(githubAuthRecovery(new Error('gh: not found; no OAuth token configured')).message,/GitHub authentication failed/);
  assert.equal(githubAuthRecovery(new Error('network reset')),null);
});
check('assignment errors name missing request_id and inputs',()=>{
  assert.match(server,/request_id is required/);
  assert.match(server,/inputs must be an array/);
});

async function asyncCheck(name,fn) { try { await fn(); console.log(`PASS ${name}`); } catch(error) { failures.push(`${name}: ${error.stack||error.message}`); console.log(`FAIL ${name}`); } }
await asyncCheck('--start refuses before writes when the manager is unavailable; offline setup skips the probe',async()=>{
  const {run}=await import('./worker-bridge-setup.mjs');
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'mp-'));
  try {
    const bin=path.join(root,'bin'),calls=path.join(root,'manager.log');fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin,'systemctl'),'#!/bin/sh\necho "$*" >> "$MANAGER_LOG"\nif [ "$2" = show-environment ]; then exit 1; fi\nexit 0\n',{mode:0o755});
    fs.writeFileSync(path.join(bin,'launchctl'),'#!/bin/sh\nexit 1\n',{mode:0o755});
    const env={...process.env,HOME:path.join(root,'owner'),XDG_CONFIG_HOME:path.join(root,'xdg'),PATH:`${bin}:${process.env.PATH}`,MANAGER_LOG:calls};
    assert.equal(spawnSync('sh',['-c','command -v launchctl'],{env,encoding:'utf8'}).stdout.trim(),path.join(bin,'launchctl'));
    const home=path.join(root,'unavailable-home');
    assert.throws(()=>run(['--worker','prefail','--public-url','https://prefail.example.test','--port','18791','--home',home,'--start'],{platform:'linux',env,log:()=>{}}),/systemd user manager is unavailable/);
    assert(!fs.existsSync(home),'manager refusal leaves home absent');
    assert(!fs.existsSync(path.join(root,'xdg/systemd/user')),'manager refusal leaves unit directory absent');
    assert.deepEqual(fs.readFileSync(calls,'utf8').trim().split('\n'),['--user show-environment'],'only the read-only manager probe ran');
    const before=fs.readFileSync(calls,'utf8');
    run(['--worker','offline','--public-url','https://offline.example.test','--port','18792','--home',path.join(root,'offline-home'),'--write-units-only'],{platform:'linux',env,log:()=>{}});
    assert.equal(fs.readFileSync(calls,'utf8'),before,'offline generation does not probe the manager');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
await asyncCheck('quoted owner helper executes in Bash and Zsh with spaces and quotes in paths',async()=>{
  const {shellQuote}=await import('./worker-bridge-setup.mjs');
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'os-'));
  try {
    const home=path.join(root,"bridge home'space"),node=path.join(root,"bin/node'shim"),script=path.join(root,"repo path/worker'script.mjs"),output=path.join(root,'args');
    fs.mkdirSync(path.dirname(node),{recursive:true});fs.mkdirSync(path.dirname(script),{recursive:true});
    fs.writeFileSync(node,`#!/bin/sh\nprintf '%s\\n' "$HOME" "$@" > '${output.replaceAll("'","'\\''")}'\n`,{mode:0o755});
    fs.writeFileSync(script,'');
    const definition=`dalan() { HOME=${shellQuote(home)} ${shellQuote(node)} ${shellQuote(script)} "$@"; }\ndalan connect pending`;
    for(const shell of ['bash','zsh']) {
      const result=spawnSync(shell,['-c',definition],{encoding:'utf8'});
      assert.equal(result.status,0,`${shell}: ${result.stderr}`);
      assert.deepEqual(fs.readFileSync(output,'utf8').trimEnd().split('\n'),[home,script,'connect','pending']);
    }
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
await asyncCheck('retry preserves owned home bytes and modes and rejects unsafe targets before checking',async()=>{
  const {run}=await import('./worker-bridge-setup.mjs');
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'ir-'));
  const home=path.join(root,'bridge-home'),xdg=path.join(root,'xdg'),ownerHome=path.join(root,'owner-home'),bin=path.join(root,'bin');
  fs.mkdirSync(ownerHome,{recursive:true});fs.mkdirSync(bin);
  const calls=path.join(root,'external.calls');
  for(const command of ['systemctl','tailscale','launchctl']) fs.writeFileSync(path.join(bin,command),`#!/bin/sh\nprintf '%s\\n' "${command} $*" >> '${calls}'\nif [ "$2" = show ]; then [ "$TEST_SHOW_FAIL" != 1 ] || exit 1; printf '%s\\n' "$TEST_DROPINS"; fi\n`,{mode:0o755});
  const env={...process.env,HOME:ownerHome,XDG_CONFIG_HOME:xdg,PATH:`${bin}:${process.env.PATH}`};
  assert.equal(spawnSync('sh',['-c','command -v launchctl'],{env,encoding:'utf8'}).stdout.trim(),path.join(bin,'launchctl'));
  const args=['--worker','lark','--public-url','https://retry.example.test','--port','18788','--home',home];
  const retry=['--retry-public-check',...args];
  const config=path.join(home,'.config/dalan'),unit=path.join(xdg,'systemd/user/dot-bridge-lark.service');
  const exposure=path.join(home,'dot-bridge-lark.exposure.json');
  const quiet={platform:'linux',env,log:()=>{}};
  let checks=0;
  const verifyPublic=async()=>{checks++;return true;};
  const tree=()=>{
    const entries={};
    const visit=p=>{if(p===calls)return;const st=fs.lstatSync(p),rel=path.relative(root,p)||'.';entries[rel]={mode:st.mode&0o777,uid:st.uid,type:st.isDirectory()?'dir':st.isFile()?'file':'other'};if(st.isDirectory())for(const name of fs.readdirSync(p).sort())visit(path.join(p,name));else if(st.isFile())entries[rel].bytes=fs.readFileSync(p);};
    visit(root);return entries;
  };
  const attempt=async(argv=retry)=>{checks=0;try{await run(argv,{...quiet,verifyPublic});return true;}catch{return false;}};
  try {
    await run(args,quiet);
    fs.writeFileSync(exposure,JSON.stringify({mode:'tailscale',worker:'lark',dns_name:'retry.example.test',public_url:'https://retry.example.test',public_port:443,local_port:18788}),{mode:0o600});
    const before=tree();
    assert.equal(await attempt(),true,'valid initialized retry succeeds');
    assert.equal(checks,1,'valid retry performs one public check');
    assert.deepEqual(tree(),before,'successful retry does not rewrite owned files or modes');

    const workers=path.join(config,'workers.json'),savedWorkers=fs.readFileSync(workers);
    fs.renameSync(workers,workers+'.saved');fs.symlinkSync(workers+'.saved',workers);
    assert.equal(await attempt(),false,'symlinked worker profile is refused');assert.equal(checks,0,'symlink refusal precedes public verification');
    fs.unlinkSync(workers);fs.renameSync(workers+'.saved',workers);

    const resource=path.join(home,'resource-url');
    fs.renameSync(resource,resource+'.saved');
    const fifo=spawnSync('mkfifo',[resource]);assert.equal(fifo.status,0,`mkfifo: ${fifo.stderr}`);
    assert.equal(await attempt(),false,'nonregular resource file is refused');assert.equal(checks,0);
    fs.unlinkSync(resource);fs.renameSync(resource+'.saved',resource);

    if(typeof process.getuid==='function'&&process.getuid()===0) {
      const issuer=path.join(config,'as.json'),issuerUid=fs.statSync(issuer).uid;
      fs.chownSync(issuer,65534,fs.statSync(issuer).gid);
      assert.equal(await attempt(),false,'foreign-owned issuer config is refused');assert.equal(checks,0);
      fs.chownSync(issuer,issuerUid,fs.statSync(issuer).gid);
    }

    const originalUnit=fs.readFileSync(unit,'utf8');
    fs.writeFileSync(unit,originalUnit.replace(`Environment=HOME=${home}`,`Environment=HOME=${home}-foreign`));
    assert.equal(await attempt(),false,'sibling-prefix service HOME is refused');assert.equal(checks,0);
    fs.writeFileSync(unit,originalUnit.replace('Environment=DOT_BRIDGE_PORT=18788','Environment=DOT_BRIDGE_PORT=18789')+'\n# previous port 18788\n');
    assert.equal(await attempt(),false,'commented old port does not satisfy the generated service');assert.equal(checks,0);
    fs.writeFileSync(unit,originalUnit);

    const dropdir=unit+'.d';fs.mkdirSync(dropdir);
    fs.writeFileSync(path.join(dropdir,'override.conf'),'[Service]\nEnvironment=HOME=/unrelated\nExecStart=\nExecStart=/usr/bin/false\n');
    assert.equal(await attempt(),false,'a drop-in can override the otherwise matching generated service');assert.equal(checks,0);
    fs.rmSync(dropdir,{recursive:true});
    env.TEST_DROPINS='/run/user/1000/systemd/user.control/fixture.service.d/override.conf';
    assert.equal(await attempt(),false,'effective global or transient drop-ins are refused');assert.equal(checks,0);delete env.TEST_DROPINS;
    env.TEST_SHOW_FAIL='1';assert.equal(await attempt(),false,'unknown effective service settings fail closed');assert.equal(checks,0);delete env.TEST_SHOW_FAIL;

    const envFile=path.join(config,'env'),savedEnv=fs.readFileSync(envFile,'utf8');
    fs.writeFileSync(envFile,`BRIDGE_PATH_SECRET=${'f'.repeat(64)}\n`);
    assert.equal(await attempt(),false,'resource URL must bind to saved path secret');assert.equal(checks,0);
    fs.writeFileSync(envFile,savedEnv);
    const key=path.join(config,'as-jwks.json');fs.renameSync(key,key+'.saved');
    assert.equal(await attempt(),false,'missing signing key is refused');assert.equal(checks,0);
    fs.renameSync(key+'.saved',key);

    assert.equal(await attempt([...retry,'--remove']),false,'retry plus remove is rejected');
    assert.equal(checks,0);assert(fs.existsSync(unit),'retry plus remove leaves service unit intact');
    assert(fs.existsSync(exposure),'retry plus remove leaves the exposure record intact');
    assert(fs.readFileSync(calls,'utf8').trim().split('\n').every(line=>line==='systemctl --user show dot-bridge-lark.service --property=DropInPaths --value'),'only read-only service inspection is permitted; no service mutation or network command');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

await asyncCheck('printed public retries retain no-repo-tools on both platform seams',async()=>{
  const {run}=await import('./worker-bridge-setup.mjs');
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'io-'));
  try {
    const bin=path.join(root,'bin');fs.mkdirSync(bin);
    for(const name of ['systemctl','tailscale','launchctl','plutil']) fs.writeFileSync(path.join(bin,name),'#!/bin/sh\nexit 0\n',{mode:0o755});
    for(const platform of ['linux','darwin']) {
      const home=path.join(root,platform),ownerHome=path.join(root,platform+'-owner');fs.mkdirSync(ownerHome);
      const env={...process.env,HOME:ownerHome,XDG_CONFIG_HOME:path.join(root,platform+'-xdg'),PATH:`${bin}:${process.env.PATH}`};
      let message='';
      try {await run(['--worker','plain','--home',home,'--port','18790','--expose','tailscale','--start','--no-repo-tools'],{platform,env,log:()=>{},preflight:()=>({dnsName:'plain.example.test',allowed:[443],occupied:new Map(),warnings:[]}),applyFunnel:()=>{},verifyPublic:async()=>false});} catch(error) {message=error.message;}
      const command=message.match(/Retry the check with: (.+?)\. To remove this install:/)?.[1];assert(command,message);
      const args=command.split(' ').slice(2);assert(args.includes('--no-repo-tools'),`${platform}: retry omitted the installed setting`);
      let probes=0;
      await run(args,{platform,env,log:()=>{},verifyPublic:async()=>{probes++;return true;}});
      assert.equal(probes,1,`${platform}: printed retry did not verify the matching target`);
    }
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

const unsafe='café 🐟\u001b]8;;https://evil.invalid\u0007click\u001b]8;;\u0007\u001b[31mred\u001b[0m\u009b2J\u0085line\rbreak\nsecond\u2028paragraph\u2029end\u0007';
const state={request_id:'req_12345678',status:'finished',inbox:{target_worker:'lark\u001b[2J',brief:unsafe,outcome:'completed',finished_at:'2026-10-27T00:00:00Z',consumed:false,delivered_t3:false}};
const data=buildInbox([state],'producer');
check('plain inbox escapes terminal controls in untrusted text',()=>{
  const plain=formatInbox(data);
  assert(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(plain),`raw control bytes remain: ${JSON.stringify(plain)}`);
  assert.match(plain,/\\u001b|\\x1b/);
  assert.match(plain,/line\\x0dbreak/);
  assert(plain.includes('café 🐟'),'printable Unicode remains readable');
});
check('inbox sanitization stays at display boundary',()=>assert.deepEqual(JSON.parse(JSON.stringify(data)),data));
check('line separators in display fields are escaped',()=>{
  const injected={...data,items:data.items.map(item=>({...item,title:'first\nsecond\u2028third\u2029fourth'}))};
  const plain=formatInbox(injected);
  assert(plain.includes('first\\x0asecond\\u2028third\\u2029fourth'));
});

if(failures.length) { console.error(`RED: ${failures.length} finding 6/9 checks fail on current source\n${failures.join('\n')}`); process.exitCode=1; }
else console.log('GREEN: finding 6/9 install and inbox checks passed');
