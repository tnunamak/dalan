#!/usr/bin/env node
// Static public clients must use the same owner pairing, approval and revocation path as DCR clients.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fetchFresh as fetch } from '../src/test-support/fetch.mjs';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const tempRoot = process.env.DOT_BRIDGE_TEST_TMP ?? path.join(os.homedir(), '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const root = fs.mkdtempSync(path.join(tempRoot, 'dbas-static-'));
const localJourney = process.env.DALAN_TEST_LOOPBACK_JOURNEY === '1';
const callbackHost = process.env.DALAN_TEST_LOOPBACK_HOST || '127.0.0.1';
const CALLBACK = localJourney ? `http://${callbackHost}:41999/oauth/callback` : 'https://vendor.example/oauth/callback';
const CALLBACK_PATTERN = localJourney ? `http://${callbackHost}/oauth/callback` : CALLBACK;
const failures = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function check(id, name, fn) {
  try { await fn(); console.log(`PASS ${id} ${name}`); }
  catch (error) {
    failures.push(id);
    console.log(`FAIL ${id} ${name}: ${error.message}`);
    console.error(error.stack, { code: error.code, cause: error.cause });
    console.error('bridge state:', { exitCode: bridge.exitCode, signal: bridge.child?.signalCode, stderr: bridge.stderr });
  }
}

const freePort = () => new Promise(resolve => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

class Jar {
  constructor() { this.map = new Map(); }
  take(response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';'), split = pair.indexOf('='), key = pair.slice(0, split), value = pair.slice(split + 1);
      if (value === '') this.map.delete(key); else this.map.set(key, value);
    }
  }
  get header() { return [...this.map].map(([key, value]) => `${key}=${value}`).join('; '); }
}

async function hit(url, jar) {
  const response = await fetch(url, { redirect: 'manual', ...(jar?.header ? { headers: { cookie: jar.header } } : {}) });
  jar?.take(response);
  return response;
}

class Bridge {
  constructor() {
    this.codeRoot = process.env.DALAN_TEST_UPGRADE_FROM || repo;
    this.home = path.join(root, 'bridge-home');
    this.config = path.join(this.home, '.config/dot-bridge');
  }
  get env() {
    if(localJourney) return { ...process.env, HOME:this.home, NODE_ENV:'production',
      DALAN_PORT:String(this.port), DALAN_AUTH_MODE:'builtin', DALAN_LOOPBACK:'1', DALAN_ALLOW_PRIVATE_WEBHOOKS:'1',
      DALAN_TEST_OAUTH:undefined, DOT_BRIDGE_TEST_OAUTH:undefined, DOT_BRIDGE_PORT:undefined, DOT_BRIDGE_AUTH_MODE:undefined };
    return { ...process.env, HOME: this.home, DOT_BRIDGE_PORT: String(this.port), DOT_BRIDGE_AUTH_MODE: 'builtin',
      DOT_BRIDGE_TEST_OAUTH:'1', DOT_BRIDGE_ALLOW_PRIVATE_WEBHOOKS:'1', NODE_ENV:'test' };
  }
  async init() {
    this.port = await freePort();
    this.pub = `http://127.0.0.1:${this.port}`;
    fs.mkdirSync(this.config, { recursive: true });
    fs.writeFileSync(path.join(this.config, 'workers.json'), JSON.stringify({ workers: { lark: {} } }), { mode: 0o600 });
    const result = this.cli(['as-init', '--public-url', this.pub]);
    assert.equal(result.code, 0, 'as-init failed');
    return this;
  }
  async start() {
    this.stderr = '';
    this.exitCode = undefined;
    const child = spawn(process.execPath, ['src/server.mjs'], { cwd: this.codeRoot, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    let ready = false;
    child.stdout.on('data', chunk => { if(localJourney) assert.doesNotMatch(String(chunk), /MCP listening on 0\.0\.0\.0/); if (/MCP listening on (?:127\.0\.0\.1|0\.0\.0\.0):\d+/.test(String(chunk))) ready = true; });
    child.stderr.on('data', chunk => { this.stderr += String(chunk); });
    child.once('exit', code => { this.exitCode = code; });
    for (let i = 0; i < 300 && !ready && this.exitCode === undefined; i++) await sleep(50);
    if (!ready) throw new Error(`bridge did not start: exit=${this.exitCode} signal=${child.signalCode}; ${this.stderr}`);
    this.secret = fs.readFileSync(path.join(this.config, 'env'), 'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
    this.resource = `${this.pub}/${this.secret}/mcp`;
    const protectedResponse = await fetch(`${this.pub}/.well-known/oauth-protected-resource/${this.secret}/mcp`);
    assert.equal(protectedResponse.status, 200, 'protected-resource discovery failed');
    const protectedMetadata = await protectedResponse.json();
    assert.equal(protectedMetadata.resource, this.resource);
    const issuer = new URL(protectedMetadata.authorization_servers[0]);
    const discoveryResponse = await fetch(new URL(`/.well-known/oauth-authorization-server${issuer.pathname}`, issuer.origin));
    assert.equal(discoveryResponse.status, 200, 'authorization-server discovery failed');
    this.oauth = await discoveryResponse.json();
    this.oauthBase = new URL(this.oauth.authorization_endpoint).pathname.replace(/\/auth$/, '');
    for (const endpoint of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'jwks_uri']) {
      assert.ok(this.oauth[endpoint].startsWith(`${issuer.href}/`), `${endpoint} escaped the discovered issuer`);
    }
    return true;
  }
  async stop() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
  }
  cli(args, input) {
    const result = spawnSync(process.execPath, ['bin/dot-worker.mjs', ...args], { cwd: this.codeRoot, env: this.env, encoding: 'utf8', input });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, json: () => JSON.parse(result.stdout) };
  }
  sql(query, ...args) {
    const db = new DatabaseSync(path.join(this.config, 'as.sqlite'));
    db.exec('PRAGMA busy_timeout=5000');
    try { return /^\s*select/i.test(query) ? db.prepare(query).all(...args) : db.prepare(query).run(...args); }
    finally { db.close(); }
  }
  bridgeDb(query, ...args) {
    const db = new DatabaseSync(path.join(this.home, '.local/share/dot-bridge/bridge.db'));
    db.exec('PRAGMA busy_timeout=5000');
    try { return /^\s*select/i.test(query) ? db.prepare(query).all(...args) : db.prepare(query).run(...args); }
    finally { db.close(); }
  }
  async rpc(bearer, method, params = {}) {
    const response = await fetch(this.resource, { method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  async startWindow(worker) {
    const result = this.cli(['connect', 'start', '--worker', worker, '--json']);
    assert.equal(result.code, 0, 'could not open pairing window');
  }
  approve(code, worker) {
    const pairing = this.cli(['connect', 'pending', '--json']).json().pending.find(item => item.code === code);
    return this.cli(['connect', 'approve', code, '--worker', worker, ...(pairing?.native ? ['--confirm-redirect', pairing.redirect_uri] : []), '--json']);
  }
  clients() { return this.cli(['connect', 'clients', '--json']).json().clients; }
  registerDcr(name) {
    return fetch(this.oauth.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [CALLBACK], client_name: name, token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  }
}

class Vendor {
  constructor(bridge, clientId) { this.bridge = bridge; this.clientId = clientId; this.redirect = localJourney ? `http://${callbackHost}:42777/oauth/callback` : CALLBACK; }
  authUrl(verifier) {
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const params = new URLSearchParams({ client_id: this.clientId, response_type: 'code', redirect_uri: this.redirect,
      scope: 'dot-bridge.read dot-bridge.work', state: randomBytes(6).toString('hex'), code_challenge: challenge,
      code_challenge_method: 'S256', resource: this.bridge.resource });
    return `${this.bridge.oauth.authorization_endpoint}?${params}`;
  }
  async begin() {
    const verifier = randomBytes(32).toString('base64url'), jar = new Jar();
    const response = await hit(this.authUrl(verifier), jar), location = response.headers.get('location');
    assert.equal(response.status, 303, 'authorization did not enter an interaction');
    assert.ok(location?.startsWith(`${this.bridge.oauthBase}/interaction/`), 'authorization did not open the pairing page under the discovered issuer');
    const pageResponse = await hit(new URL(location, this.bridge.pub), jar), page = await pageResponse.text();
    const pairingCode = page.match(/class="code">([A-Z0-9-]+)</)?.[1];
    assert.ok(pairingCode, 'interaction page did not show a pairing code');
    return { verifier, jar, location, pairingCode };
  }
  async finish(flow) {
    const done = await hit(new URL(flow.location, this.bridge.pub), flow.jar);
    if (done.status !== 303) return { stage: 'interaction', status: done.status };
    const resume = await hit(new URL(done.headers.get('location'), this.bridge.pub), flow.jar);
    const location = resume.headers.get('location');
    if (resume.status !== 303 || !location?.startsWith(this.redirect)) return { stage: 'resume', status: resume.status };
    return { stage: 'callback', code: new URL(location).searchParams.get('code') };
  }
  async token(fields) {
    const response = await fetch(this.bridge.oauth.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, ...fields }) });
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  exchange(code, verifier) {
    return this.token({ grant_type: 'authorization_code', code, redirect_uri: this.redirect, code_verifier: verifier, resource: this.bridge.resource });
  }
  refresh(refreshToken) { return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken }); }
}

async function eventReceiver(secret) {
  const events = [], signatures = [];
  const server = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    const expected = 'v1,' + createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${request.headers['webhook-id']}.${request.headers['webhook-timestamp']}.${body}`).digest('base64');
    signatures.push(request.headers['webhook-signature'] === expected);
    if (message.type === 'verification') return response.end(JSON.stringify({ challenge: message.challenge }));
    events.push(message.data?.request_id ?? null);
    response.end('ok');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, events, signatures, setSecret(value) { secret = value; }, url: `http://127.0.0.1:${server.address().port}/events`, close: () => new Promise(resolve => server.close(resolve)) };
}

function configSnapshot(dir) {
  return JSON.stringify(fs.readdirSync(dir).sort().map(name => {
    const file = path.join(dir, name);
    return [name, fs.statSync(file).isFile() ? hash(fs.readFileSync(file)) : 'directory'];
  }));
}

const bridge = await new Bridge().init();
let receiver;
let clientId, dcrId, spareStaticId, staleDcrId, vendor, connected, subscriptionId;

try {
  assert.equal(await bridge.start(), true, 'bridge did not start');
  const allowed = bridge.cli(['connect', 'allow-callback', CALLBACK_PATTERN, '--json']);
  assert.equal(allowed.code, 0, 'could not allow the test callback');

  if(localJourney) await check('native-negative', 'native redirects and S256 PKCE remain bound at authorization and token exchange', async () => {
    let probeId;
    try {
      await bridge.startWindow('lark');
      // A canonical loopback path is a valid native registration without any owner list; only an invalid redirect is refused here. The wrong-path case is checked at authorize and at the token step below.
      for(const redirect of ['http://evil.invalid/oauth/callback']) {
        const response=await fetch(bridge.oauth.registration_endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({redirect_uris:[redirect],token_endpoint_auth_method:'none',application_type:'native',grant_types:['authorization_code'],response_types:['code']})});
        assert.equal(response.status,400,'native registration accepted a wrong callback host or path');
      }
      const added=bridge.cli(['connect','add-client','--redirect-uri',CALLBACK,'--name','Native refusal fixture','--json']);assert.equal(added.code,0,added.stderr);probeId=added.json().client_id;
      const client=new Vendor(bridge,probeId),verifier=randomBytes(32).toString('base64url');
      for(const [index,change] of [
        params=>{params.delete('code_challenge');params.delete('code_challenge_method');},
        params=>params.set('code_challenge_method','plain'),
        params=>params.set('redirect_uri',`http://${callbackHost}:49200/wrong-path`),
        params=>params.set('redirect_uri','http://evil.invalid/oauth/callback'),
      ].entries()) {
        const url=new URL(client.authUrl(verifier));change(url.searchParams);
        const response=await fetch(url,{redirect:'manual'});
        if(index<2&&response.status>=300&&response.status<400) {
          // OAuth may report an error to a validated callback, but must issue no code.
          const error=new URL(response.headers.get('location')),allowed=new URL(client.redirect);
          assert.equal(error.origin,allowed.origin);assert.equal(error.pathname,allowed.pathname);assert(error.searchParams.has('error'));assert(!error.searchParams.has('code'));
        } else {assert.equal(response.status,400,'native authorization accepted an invalid redirect or PKCE');assert.equal(response.headers.get('location'),null,'invalid redirect escaped to the client');}
      }
      const flow=await client.begin(),approved=bridge.approve(flow.pairingCode,'lark');assert.equal(approved.code,0,approved.stderr);
      const callback=await client.finish(flow);assert.equal(callback.stage,'callback');assert(callback.code);
      const wrongRedirect=new URL(client.redirect);wrongRedirect.port=String(Number(wrongRedirect.port)+1);
      const refused=await client.token({grant_type:'authorization_code',code:callback.code,code_verifier:flow.verifier,redirect_uri:wrongRedirect.href,resource:bridge.resource});
      assert.equal(refused.status,400,'token exchange accepted a redirect different from the authorized flow');assert.equal(refused.body?.access_token,undefined);
    } finally {
      if(probeId)assert.equal(bridge.cli(['connect','remove-client',probeId,'--json']).code,0);
      assert.equal(bridge.cli(['connect','reset','--json']).code,0);
      assert.equal(bridge.cli(['connect','stop','--json']).code,0);
    }
  });

  await check('1', 'owner-created public client completes pairing, approval, token and MCP initialize', async () => {
    const added = bridge.cli(['connect', 'add-client', '--redirect-uri', CALLBACK, '--name', 'Static test vendor']);
    assert.equal(added.code, 0, 'add-client failed');
    const clientIdLine = added.stdout.match(/client_id\s+"?([A-Za-z0-9_-]{8,128})"?/);
    assert.ok(clientIdLine, 'add-client did not print a client_id');
    assert.doesNotMatch(added.stdout, /client_secret|secret/i, 'add-client printed a secret');
    clientId = clientIdLine[1];
    assert.match(clientId, /^[A-Za-z0-9_-]{8,128}$/);
    const stored = bridge.sql("SELECT payload FROM oidc WHERE model='Client' AND id=?", clientId)[0].payload;
    assert.match(stored, /^v1\./, 'client metadata must be encrypted');
    const [, iv, tag, data] = stored.split('.');
    const cipher = createDecipheriv('aes-256-gcm', fs.readFileSync(path.join(bridge.config, 'as-storage.key')), Buffer.from(iv, 'base64url'));
    cipher.setAAD(Buffer.from(`oidc:Client:${clientId}`)); cipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const metadata = JSON.parse(Buffer.concat([cipher.update(Buffer.from(data, 'base64url')), cipher.final()]).toString('utf8'));
    assert.equal(metadata.token_endpoint_auth_method, 'none');
    assert.equal(metadata.client_secret, undefined);
    assert.deepEqual(metadata.grant_types, ['authorization_code', 'refresh_token']);
    assert.deepEqual(metadata.response_types, ['code']);
    assert.deepEqual(metadata.redirect_uris, [CALLBACK]);
    assert.equal(bridge.sql('SELECT count(*) n FROM connections WHERE client_id=?', clientId)[0].n, 0, 'creation granted authority');

    const jsonAdded = bridge.cli(['connect', 'add-client', '--redirect-uri', CALLBACK, '--name', 'JSON test vendor', '--json']);
    assert.equal(jsonAdded.code, 0, 'JSON add-client failed');
    const jsonClientId = jsonAdded.json().client_id;
    assert.ok(jsonClientId);
    assert.equal(Object.hasOwn(jsonAdded.json(), 'client_secret'), false);
    const jsonRemoved = bridge.cli(['connect', 'remove-client', jsonClientId, '--json']);
    assert.equal(jsonRemoved.code, 0, 'JSON remove-client failed');

    vendor = new Vendor(bridge, clientId);
    const closedRequest = await fetch(vendor.authUrl(randomBytes(32).toString('base64url')), { redirect: 'manual' });
    assert.equal(closedRequest.status, 403, 'static client started an interaction outside a pairing window');

    await bridge.startWindow('lark');
    const spare = bridge.cli(['connect', 'add-client', '--redirect-uri', CALLBACK, '--name', 'Reset and purge test', '--json']);
    assert.equal(spare.code, 0, 'could not create an unconnected static client for retention checks');
    spareStaticId = spare.json().client_id;
    const dcrIds = [];
    for (let i = 1; i <= 5; i++) {
      const registration = await bridge.registerDcr(`DCR test vendor ${i}`);
      assert.equal(registration.status, 201, `DCR registration ${i} did not fit beside static clients`);
      dcrIds.push((await registration.json()).client_id);
    }
    dcrId = dcrIds[0];
    const capped = await bridge.registerDcr('DCR over cap');
    assert.equal(capped.status, 429, 'per-window DCR cap did not refuse an excess client');
    assert.ok(bridge.clients().some(client => client.client_id === spareStaticId && client.type === 'static'), 'DCR cap removed an unconnected static client');

    const flow = await vendor.begin();
    const approved = bridge.approve(flow.pairingCode, 'lark');
    assert.equal(approved.code, 0, 'owner approval failed');
    const callback = await vendor.finish(flow);
    assert.equal(callback.stage, 'callback', 'approval did not complete the browser flow');
    assert.ok(callback.code, 'callback did not contain an authorization code');
    const tokens = await vendor.exchange(callback.code, flow.verifier);
    assert.equal(tokens.status, 200, 'public client did not receive a token');
    assert.ok(tokens.body?.access_token, 'token response had no access token');
    connected = { access: tokens.body.access_token, refresh: tokens.body.refresh_token };
    const initialized = await bridge.rpc(connected.access, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'static-client-test', version: '1' } });
    assert.equal(initialized.status, 200, 'MCP initialize failed');
    assert.equal(initialized.body?.result?.protocolVersion, '2025-03-26');

    const listed = bridge.clients();
    const listedStatic = listed.find(client => client.client_id === clientId), listedDcr = listed.find(client => client.client_id === dcrId);
    assert.equal(listedStatic?.type, 'static');
    assert.equal(listedStatic?.client_name_untrusted, true);
    assert.deepEqual(listedStatic?.redirect_uris, [CALLBACK]);
    assert.ok(Number.isFinite(Date.parse(listedStatic?.created_at)));
    assert.equal(listedDcr?.type, 'dcr');
    assert.equal(listedDcr?.client_name_untrusted, true);
    assert.deepEqual(listedDcr?.redirect_uris, [CALLBACK]);
    assert.ok(Number.isFinite(Date.parse(listedDcr?.created_at)));
    const humanList = bridge.cli(['connect', 'clients']);
    assert.equal(humanList.code, 0, 'human client list failed');
    assert.match(humanList.stdout, /client_name \[untrusted\]/);
  });

  if(localJourney) await check('local', 'Host and Origin refusals precede all routing; authentication remains mandatory', async () => {
    for(const token of [undefined,'invalid']) assert.equal((await bridge.rpc(token,'tools/list')).status,401);
    const before=bridge.clients(), beforeCalls=bridge.bridgeDb('SELECT coalesce(sum(count),0) n FROM worker_calls')[0].n;
    const attackBody=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'list_pending',arguments:{}}});
    for(const route of [new URL(bridge.resource).pathname, '/.well-known/oauth-protected-resource', bridge.oauthBase+'/auth', '/unknown']) {
      for(const method of ['GET','POST']) for(const headers of [
        {host:'evil.example'}, {host:`127.0.0.1:${bridge.port}.evil.example`}, {host:`localhost:${bridge.port}`},
        {host:`127.0.0.1:${bridge.port+1}`}, {host:`127.0.0.1.:${bridge.port}`}, {host:`[::1]:${bridge.port}`}, {origin:'https://evil.example'}, {origin:'null'},
        {origin:bridge.pub+'/'}, {origin:`http://127.0.0.1:${bridge.port+1}`}, {origin:bridge.pub+'.evil.example'}, {origin:bridge.pub+', https://evil.example'}, {origin:'https://127.0.0.1:'+bridge.port},
        {'x-forwarded-host':'evil.example'}, {forwarded:'host=evil.example'}]) {
        const response=await new Promise((resolve,reject)=>{
          const request=http.request(bridge.pub+route,{method,headers:{authorization:`Bearer ${connected.access}`,'content-type':'application/json','content-length':Buffer.byteLength(attackBody),...headers}},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body}));});
          request.on('error',reject);request.end(attackBody);
        });
        assert.equal(response.status,403,JSON.stringify({route,method,headers}));
        assert.equal(response.body,'');
      }
    }
    const refusals=fs.readFileSync(path.join(bridge.home,'.local/state/dot-bridge/requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(row=>row.kind==='mcp_inbound'&&row.route==='loopback');
    assert(refusals.length>0);assert(refusals.every(row=>row.status===403));
    assert.equal(bridge.bridgeDb('SELECT coalesce(sum(count),0) n FROM worker_calls')[0].n,beforeCalls,'refused authority reached tool dispatch');
    const positive=await fetch(bridge.resource,{method:'POST',headers:{authorization:`Bearer ${connected.access}`,origin:bridge.pub,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
    assert.equal(positive.status,200);assert.ok((await positive.json()).result.tools.length);
    assert.deepEqual(bridge.clients(),before);
  });

  await check('2', 'an invalid static redirect is refused without disk or runtime changes; an unseen valid one needs no owner list', async () => {
    const beforeDisk = configSnapshot(bridge.config), beforeClients = bridge.clients(), beforeConnections = bridge.cli(['connect', 'list', '--json']).json().connections;
    for (const redirect of ['http://not-allowed.example/callback', 'https://user:pw@not-allowed.example/callback', 'https://not-allowed.example/callback#frag', 'https://*.not-allowed.example/callback', 'http://127.0.0.2/callback', 'myapp://callback']) {
      const refused = bridge.cli(['connect', 'add-client', '--redirect-uri', redirect, '--name', 'Refused']);
      assert.notEqual(refused.code, 0, `add-client accepted ${redirect}`);
    }
    assert.equal(configSnapshot(bridge.config), beforeDisk, 'refused add changed AS files');
    assert.deepEqual(bridge.clients(), beforeClients, 'refused add changed the runtime client list');
    assert.deepEqual(bridge.cli(['connect', 'list', '--json']).json().connections, beforeConnections, 'refused add changed connections');
    // Without an owner opt-in a plain loopback or HTTPS redirect is valid. Registering it adds a client row and nothing else.
    const asJson = () => fs.readFileSync(path.join(bridge.config, 'as.json'), 'utf8'), beforeAsJson = asJson();
    const unseen = bridge.cli(['connect', 'add-client', '--redirect-uri', 'https://not-allowed.example/callback', '--name', 'Unseen', '--json']);
    assert.equal(unseen.code, 0, unseen.stderr + unseen.stdout);
    assert.equal(unseen.json().token_endpoint_auth_method, 'none');
    assert.deepEqual(unseen.json().redirect_uris, ['https://not-allowed.example/callback']);
    assert.equal(asJson(), beforeAsJson, 'a valid add must not rewrite as.json (no owner list)');
    assert.deepEqual(bridge.cli(['connect', 'list', '--json']).json().connections, beforeConnections, 'a client row is not a connection');
    assert.equal(bridge.cli(['connect', 'remove-client', unseen.json().client_id, '--json']).code, 0);
    assert.deepEqual(bridge.clients(), beforeClients);
  });

  await check('3', 'an unapproved static-client request cannot obtain a token', async () => {
    await bridge.startWindow('lark');
    const flow = await vendor.begin();
    const waiting = await vendor.finish(flow);
    assert.equal(waiting.stage, 'interaction', 'request completed without owner approval');
    const refused = await vendor.exchange('not-an-issued-code', flow.verifier);
    assert.equal(refused.status, 400, 'token endpoint accepted an unapproved request');
    assert.equal(Boolean(refused.body?.access_token), false, 'unapproved request returned an access token');
    assert.equal(bridge.sql('SELECT count(*) n FROM connections WHERE client_id=? AND revoked_at IS NULL', clientId)[0].n, 1);
  });

  await check('4', 'legacy-home keys, static client and approved token survive restart or upgrade', async () => {
    const stopped = bridge.cli(['connect', 'stop', '--json']);
    assert.equal(stopped.code, 0, 'could not close the previous pairing window');
    await bridge.startWindow('lark');
    const staleRegistration = await bridge.registerDcr('Stale DCR purge control');
    assert.equal(staleRegistration.status, 201, 'could not create a stale DCR purge control');
    staleDcrId = (await staleRegistration.json()).client_id;
    const staleAt = Date.now() - 25 * 60 * 60 * 1000;
    bridge.sql("UPDATE oidc SET created_at=? WHERE model='Client' AND id=?", staleAt, spareStaticId);
    bridge.sql("UPDATE oidc SET created_at=? WHERE model='Client' AND id=?", staleAt, staleDcrId);

    const persistentFiles=['env','operator.key','as-storage.key','as-jwks.json','as-cookie-keys.json'];
    const before=new Map(persistentFiles.map(name=>[name,hash(fs.readFileSync(path.join(bridge.config,name)))]));
    await bridge.stop();
    for(const area of ['.config','.local/share','.local/state','.tmp'])fs.mkdirSync(path.join(bridge.home,area,'dalan'),{recursive:true});
    bridge.codeRoot=repo;
    assert.equal(await bridge.start(), true, 'bridge did not restart');
    for(const [name,digest] of before)assert.equal(hash(fs.readFileSync(path.join(bridge.config,name))),digest,name+' changed during upgrade');
    for(const area of ['.config','.local/share','.local/state'])assert.deepEqual(fs.readdirSync(path.join(bridge.home,area,'dalan')),[],'upgrade wrote into the empty sibling root');
    assert.ok(bridge.clients().some(client => client.client_id === clientId && client.type === 'static'), 'static client did not persist');
    assert.ok(bridge.clients().some(client => client.client_id === spareStaticId && client.type === 'static'), 'stale-client purge removed an unconnected static client');
    assert.ok(!bridge.clients().some(client => client.client_id === staleDcrId), 'stale-client purge did not remove an old unapproved DCR client');

    const reset = bridge.cli(['connect', 'reset', '--json']);
    assert.equal(reset.code, 0, 'connect reset failed');
    assert.ok(bridge.clients().some(client => client.client_id === spareStaticId && client.type === 'static'), 'connect reset removed an unconnected static client');

    const resetWindow = bridge.cli(['connect', 'stop', '--json']);
    assert.equal(resetWindow.code, 0, 'could not reset the pairing window for the follow-up DCR');
    await bridge.startWindow('lark');
    const survivingRegistration = await bridge.registerDcr('DCR retained after static removal');
    assert.equal(survivingRegistration.status, 201, 'DCR admission did not recover after reset');
    dcrId = (await survivingRegistration.json()).client_id;

    const initialized = await bridge.rpc(connected.access, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'static-client-test', version: '1' } });
    assert.equal(initialized.status, 200, 'approved connection did not work after restart');
  });

  await check('5', 'removing a static client revokes its token, connection, grant and subscription', async () => {
    let signingSecret = `whsec_${randomBytes(32).toString('base64')}`;
    receiver = await eventReceiver(signingSecret);
    const subscribed = await bridge.rpc(connected.access, 'events/subscribe', { name: 'assignment.available', arguments: {},
      delivery: { mode: 'webhook', url: receiver.url, secret: signingSecret } });
    assert.equal(subscribed.status, 200, 'connection could not create an event subscription');
    subscriptionId = subscribed.body?.result?.id;
    assert.ok(subscriptionId, 'subscription response had no ID');
    // Nothing here claims a job, so each submit wake names the oldest queued job, not the new one.
    const queuedIds = [];
    const sendEvent = async () => {
      const id = `event_${randomUUID().replaceAll('-', '')}`;
      const body = { schema_version: 1, request_id: id, brief: 'subscription event', inputs: [], expected_output: 'result', execution_scope: 'read-only', scope_paths: [] };
      assert.equal(bridge.cli(['submit', '--worker', 'lark', '--execution', 'none', '--deliver', 'none', '--stdin', '--json'], JSON.stringify(body)).code, 0);
      queuedIds.push(id);
      const before = receiver.events.length;
      for (let n=0; n<100 && receiver.events.length === before; n++) await sleep(100);
      assert.equal(receiver.events.at(-1), queuedIds[0], 'signed event was not delivered, or did not name the oldest queued job');
      assert.ok(receiver.signatures.every(Boolean), 'webhook signature mismatch');
    };
    await bridge.stop(); assert.equal(await bridge.start(), true);
    await sendEvent();
    const renew = await bridge.rpc(connected.access, 'events/subscribe', { name: 'assignment.available', arguments: {}, delivery: { mode: 'webhook', url: receiver.url, secret: signingSecret } });
    assert.equal(renew.body?.result?.id, subscriptionId);
    for (let n=0; n<100 && bridge.bridgeDb("SELECT count(*) n FROM notifications WHERE subscription_id=? AND state IN ('pending','sending','failed')", subscriptionId)[0].n; n++) await sleep(100);
    assert.equal(bridge.bridgeDb("SELECT count(*) n FROM notifications WHERE subscription_id=? AND state IN ('pending','sending','failed')", subscriptionId)[0].n, 0);
    signingSecret = `whsec_${randomBytes(32).toString('base64')}`; receiver.setSecret(signingSecret);
    const rotated = await bridge.rpc(connected.access, 'events/subscribe', { name: 'assignment.available', arguments: {}, delivery: { mode: 'webhook', url: receiver.url, secret: signingSecret } });
    assert.equal(rotated.body?.result?.id, subscriptionId);
    await sendEvent();


    const grantId = bridge.sql('SELECT grant_id FROM connections WHERE client_id=? AND revoked_at IS NULL', clientId)[0].grant_id;
    const removed = bridge.cli(['connect', 'remove-client', clientId]);
    assert.equal(removed.code, 0, 'remove-client failed');
    assert.match(removed.stdout, /Removed static client/);
    assert.equal((await bridge.rpc(connected.access, 'tools/list')).status, 401, 'old access token still worked');
    const refresh = await vendor.refresh(connected.refresh);
    assert.ok(refresh.status >= 400 && refresh.status < 500, 'old refresh token still worked');
    assert.equal(bridge.sql("SELECT revoked_reason FROM connections WHERE client_id=? AND revoked_at IS NOT NULL", clientId)[0]?.revoked_reason, 'client_removed');
    assert.equal(bridge.sql("SELECT count(*) n FROM connections WHERE client_id=? AND revoked_at IS NULL", clientId)[0].n, 0);
    assert.equal(bridge.sql("SELECT count(*) n FROM oidc WHERE model='Grant' AND id=?", grantId)[0].n, 0);
    assert.equal(bridge.sql("SELECT count(*) n FROM oidc WHERE model='Client' AND id=?", clientId)[0].n, 0);
    assert.equal(bridge.bridgeDb('SELECT state FROM subscriptions WHERE id=?', subscriptionId)[0]?.state, 'revoked');
    assert.ok(bridge.clients().some(client => client.client_id === dcrId && client.type === 'dcr'), 'removing the static client removed a DCR client');
  });

  await check('6', 'public HTTP routes cannot create a static client, even with the owner key', async () => {
    const before = bridge.clients();
    const ownerKey = fs.readFileSync(path.join(bridge.config, 'operator.key'), 'utf8').trim();
    for (const route of ['/connect/add-client', `/${bridge.secret}/connect/add-client`]) {
      const response = await fetch(`${bridge.pub}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-operator-key': ownerKey },
        body: JSON.stringify({ redirect_uri: CALLBACK, name: 'Public route attempt' }) });
      assert.equal(response.status, 404, `public listener exposed ${route}`);
    }
    assert.deepEqual(bridge.clients(), before, 'public request created or changed a client');
  });

  await check('7', 'OAuth changes leave the worker tools catalog unchanged', async () => {
    const result = spawnSync(process.execPath, ['scripts/catalog-golden-test.mjs'], { cwd: repo, env: { ...process.env, DALAN_LOOPBACK: undefined }, encoding: 'utf8' });
    assert.equal(result.status, 0, 'catalog-golden-test failed');
  });
} finally {
  await bridge.stop();
  await receiver?.close();
  fs.rmSync(root, { recursive: true, force: true });
}

if (failures.length) process.exitCode = 1;
