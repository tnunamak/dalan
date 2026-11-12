import { fetchForPublicHost } from '../src/test-support/public-host-fetch.mjs';
const fetch=fetchForPublicHost('dot-bridge.example.test');
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign, randomUUID, createHash } from 'node:crypto';
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
  else data={...data,threads:[]};
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
  child = spawn(process.execPath, ['src/server.mjs'], {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']});
  let ready = false;
  child.stdout.on('data', chunk => {if (String(chunk).includes('MCP listening')) ready = true;});
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  for (let i=0; i<100 && !ready; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert(ready, 'server did not start');
  const secret = fs.readFileSync(path.join(configDir, 'env'), 'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  const allowed = await call('dot-bridge.read', secret, 't3_thread_list', {});
  assert.equal(allowed.isError, false);
  assert.deepEqual(JSON.parse(allowed.content[0].text), {threads:[],total:0,shown:0,truncated:false,projects:[],hint:'narrow with projectId or cwd; full paging after a catalog update'}, 'compact empty list');
  const read = JSON.parse((await call('dot-bridge.read', secret, 't3_thread_read', {threadId: 'thread-1', turns: 1})).content[0].text);
  assert(read.thread.id === 'thread-1' && read.argv.includes('http://127.0.0.1:3773'));
  const wait = JSON.parse((await call('dot-bridge.read', secret, 't3_thread_wait', {threadId: 'thread-1', timeoutMs: 1000})).content[0].text);
  assert(wait.wait.outcome === 'completed');
  const created = JSON.parse((await call('dot-bridge.work', secret, 't3_thread_create', {projectId: 'project-1', prompt: 'create prompt', provider: 'claudeAgent', model: 'claude-haiku-4-5', permission: 'full-access'})).content[0].text);
  assert(created.thread.id === 'thread-created' && created.stdin === 'create prompt' && created.argv.includes('/repo/project-1'));
  const sent = JSON.parse((await call('dot-bridge.work', secret, 't3_thread_send', {threadId: 'thread-1', message: 'send message', mode: 'queue', wakeSettled: true})).content[0].text);
  assert(sent.message.messageId === 'message-1' && sent.stdin === 'send message' && sent.argv.includes('--wake-settled'));
  const set = JSON.parse((await call('dot-bridge.work', secret, 't3_thread_set', {threadId: 'thread-1', model: 'claude-haiku-4-5'})).content[0].text);
  assert(set.changed === true);
  const denied = await call('dot-bridge.read', secret, 't3_thread_send', {threadId: 'thread-1', message: 'hello'});
  assert.equal(denied.content[0].text, 'insufficient_scope');
  assert(denied._meta['mcp/www_authenticate'][0].includes('scope="dot-bridge.work"'), 'external issuer: the insufficient_scope challenge keeps the legacy name');
  const failure = await call('dot-bridge.work', secret, 't3_thread_send', {threadId: 'fail-thread', message: 'failed text'});
  assert.equal(failure.isError, true);
  const db = new DatabaseSync(path.join(home, '.local/share/dot-bridge/bridge.db'));
  const rows = db.prepare('SELECT tool,subject,result_status,text_preview,text_sha256 FROM t3_audit ORDER BY id').all();
  assert.deepEqual(rows.slice(-5).map(row => row.result_status.slice(0, 6)), ['starte','succes','denied','starte','error:']);
  const denial = db.prepare("SELECT * FROM t3_audit WHERE result_status LIKE 'denied:%'").get();
  assert.equal(denial.args_summary, '{}'); assert.equal(denial.text_preview, null);
  assert(rows.every(row => row.subject === 'fixture-subject'));
  assert.equal(rows.at(-1).text_preview, null);
  assert.equal(rows.at(-1).text_sha256, createHash('sha256').update('failed text').digest('hex'), 'failure row carries the digest of the exact text');
  for (const tool of ['t3_thread_list','t3_thread_read','t3_thread_wait','t3_thread_create','t3_thread_send','t3_thread_set']) {
    assert(rows.some(row => row.tool === tool && row.result_status === 'success'), `${tool} success not audited`);
  }
  db.close();
  console.log('PASS T3 read/write scopes, pinned origin and audit of success, denial and failure');
} finally {
  if (child) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  await new Promise(resolve => jwks.close(resolve));
  fs.rmSync(home, {recursive: true, force: true});
}
