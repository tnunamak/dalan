import { fetchForPublicHost } from '../src/test-support/public-host-fetch.mjs';
const fetch=fetchForPublicHost('dot-bridge.example.test');
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign, randomUUID, createHash } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { DatabaseSync } from 'node:sqlite';
import { reservedPort } from '../src/test-support/port.mjs';

const home = fs.mkdtempSync(path.join(os.homedir(), '.tmp/dalan-bridge-t3-scope-'));
const root = path.resolve(new URL('..', import.meta.url).pathname);
const jwks = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({keys: [jwk]})); });
const { privateKey, publicKey } = generateKeyPairSync('rsa', {modulusLength: 2048});
const jwk = {...publicKey.export({format: 'jwk'}), kid: 'test', alg: 'RS256', use: 'sig'};
const jwksPort = await reservedPort(), port = await reservedPort();
const issuer = `http://127.0.0.1:${jwksPort}/realms/fake`, audience = 'https://dot-bridge.example.test';
const configDir = path.join(home, '.config/dot-bridge');
fs.mkdirSync(configDir, {recursive: true});
fs.writeFileSync(path.join(configDir, 'oauth.env'), `OAUTH_ISSUER=${issuer}\nOAUTH_AUDIENCE=${audience}\nOAUTH_JWKS_URI=http://127.0.0.1:${jwksPort}/jwks\nOAUTH_ALLOWED_SUBJECTS=fixture-subject\n`, {mode: 0o600});
const stub = path.join(home, 't3code-stub');
fs.writeFileSync(stub, `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args.includes('fail-thread')) { console.error('stub failure'); process.exit(2); }
let body='';
process.stdin.on('data', chunk => body += chunk);
process.stdin.on('end', () => {
  let data={argv:args,stdin:body};
  if(args.includes('projects') && args.includes('list')) data={...data,projects:[{id:'project-1',workspaceRoot:'/repo/project-1',title:'Project 1'}]};
  else if(args.includes('create')) data={...data,project:{id:'project-1'},thread:{id:'thread-created',projectId:'project-1',latestRun:{runId:'run-created'}}};
  else if(args.includes('send')) data={...data,thread:{id:args[args.indexOf('--thread')+1],projectId:'project-1'},message:{messageId:'message-1'}};
  else if(args.includes('wait')) data={...data,thread:{id:args[args.indexOf('--thread')+1],projectId:'project-1',latestRun:{runId:'run-1'}},wait:{outcome:'completed'}};
  else if(args.includes('read')) data={...data,thread:{id:args[args.indexOf('--thread')+1],projectId:'project-1',turns:[]}};
  else if(args.includes('set')) data={...data,thread:{id:args[args.indexOf('--thread')+1],projectId:'project-1'},changed:true};
  else data={threads:['thread-1','thread-2','thread-3'].map(id=>({id,projectId:id,updatedAt:'2026-01-01'}))};
  if(args.includes('wait')) { require('fs').writeFileSync(process.env.HOME+'/waiting','1'); return setTimeout(()=>console.log(JSON.stringify({ok:true,data})),500); }
  require('fs').appendFileSync(process.env.HOME+'/effects',args.includes('send')?'send\\n':args.includes('set')?'set\\n':'');
  console.log(JSON.stringify({ok:true,data}));
});
`, {mode: 0o755});
const env = {...process.env,DALAN_ENABLE_T3_TOOLS:'1', HOME: home, DALAN_LEGACY_PROFILE: '1', NODE_ENV: 'test', DOT_BRIDGE_TEST_OAUTH: '1', DOT_BRIDGE_AUTH_MODE: 'oauth', DOT_BRIDGE_PORT: String(port), DOT_BRIDGE_T3CODE_BIN: stub};
let child;
function token(scope) {
  const head = Buffer.from(JSON.stringify({alg: 'RS256', kid: 'test'})).toString('base64url');
  const claims = Buffer.from(JSON.stringify({iss: issuer, aud: audience, exp: Math.floor(Date.now()/1000)+300, sub: 'fixture-subject', scope})).toString('base64url');
  const input = `${head}.${claims}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}
async function call(scope, secret, name, args) {
  const response = await fetch(`http://127.0.0.1:${port}/${secret}/mcp`, {method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${token(scope)}`}, body: JSON.stringify({jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: {name, arguments: args}})});
  assert.equal(response.status, 200);
  return (await response.json()).result;
}
try {
  await new Promise(resolve => jwks.listen(jwksPort, '127.0.0.1', resolve));
  const start=async()=>{
  child = spawn(process.execPath, ['src/server.mjs'], {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']});
  let ready = false;
  child.stdout.on('data', chunk => {if (String(chunk).includes('MCP listening')) ready = true;});
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  for (let i=0; i<100 && !ready; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert(ready, 'server did not start');
  };
  await start();
  const secret = fs.readFileSync(path.join(configDir, 'env'), 'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  const file=path.join(home,'.local/share/dot-bridge/bridge.db');
  const store=new Store(file);
  const payload={schema_version:1,request_id:'req_scoped',brief:'fixture',inputs:[],expected_output:'result',execution_scope:'read-only'};
  store.submit(payload,'thread-1',null,'owner');
  store.claim(payload.request_id,'fixture','fixture-subject',6,null,'dot');
  const other={...payload,request_id:'req_other_subject'};
  store.submit(other,'thread-2',null,'owner');
  store.claim(other.request_id,'fixture','other-subject',6,null,'dot');
  const unwrap=r=>{assert.equal(r.isError,false,r.content[0].text);return JSON.parse(r.content[0].text);};
  const denied=async(name,args)=>assert.equal((await call('dot-bridge.read dot-bridge.work',secret,name,args)).isError,true);
  const list=unwrap(await call('dot-bridge.read',secret,'t3_thread_list',{}));
  assert.deepEqual(list.threads.map(t=>t.id),['thread-1']);
  assert.equal(list.total,1);
  assert.deepEqual(list.projects.map(p=>p.id),['thread-1']);
  assert.equal(unwrap(await call('dot-bridge.read',secret,'t3_thread_read',{threadId:'thread-1'})).thread.id,'thread-1');
  unwrap(await call('dot-bridge.work',secret,'t3_thread_send',{threadId:'thread-1',message:'allowed'}));
  for(const threadId of ['thread-2','thread-3']) {
    await denied('t3_thread_read',{threadId});
    await denied('t3_thread_send',{threadId,message:'denied'});
    await denied('t3_thread_set',{threadId,model:'denied'});
  }
  await denied('t3_thread_create',{prompt:'no arbitrary new thread'});
  store.db.prepare('UPDATE tool_grants SET scope=? WHERE worker=? AND tool=?').run(JSON.stringify({threads:[]}),'dot','t3_thread_read');
  await denied('t3_thread_read',{threadId:'thread-1'});
  store.db.prepare("UPDATE tool_grants SET scope=NULL WHERE worker='dot' AND tool='t3_thread_read'").run();
  const waiting=call('dot-bridge.read',secret,'t3_thread_wait',{threadId:'thread-1',timeoutMs:2000});
  for(let i=0;i<100&&!fs.existsSync(path.join(home,'waiting'));i++)await new Promise(r=>setTimeout(r,20));
  assert(fs.existsSync(path.join(home,'waiting')),'wait entered stub');
  store.db.prepare("DELETE FROM tool_grants WHERE worker='dot' AND tool IN ('t3_thread_wait','t3_thread_send','t3_thread_set')").run();
  assert.equal((await waiting).isError,true,'revocation must reject the wait result');
  await denied('t3_thread_send',{threadId:'thread-1',message:'revoked'});
  await denied('t3_thread_set',{threadId:'thread-1',model:'revoked'});
  assert.equal(fs.readFileSync(path.join(home,'effects'),'utf8'),'send\n','only granted send reached CLI');
  child.kill('SIGTERM'); await new Promise(resolve=>child.once('exit',resolve));
  await start();
  await denied('t3_thread_send',{threadId:'thread-1',message:'still revoked after restart'});
  store.db.prepare("UPDATE claims SET lease_deadline_at='2000-01-01T00:00:00.000Z',lease_boot_id=NULL WHERE request_id='req_scoped'").run();
  await denied('t3_thread_read',{threadId:'thread-1'});
  assert.deepEqual(unwrap(await call('dot-bridge.read',secret,'t3_thread_list',{})).threads,[]);
  console.log('receipt',JSON.stringify(store.db.prepare('SELECT tool,result_status FROM t3_audit WHERE result_status=\'success\'').all()));
  store.db.close();
  console.log('PASS job-scoped T3: three threads, discovery, read/send/set/create denial, revoke during wait');
} finally {
  if (child && child.exitCode===null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  await new Promise(resolve => jwks.close(resolve));
  fs.rmSync(home, {recursive: true, force: true});
}
