import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {redactSinkText,redactLogEntry,redactOutput,registerSecret} from '../src/redaction.mjs';
import {safeDiagnostic} from '../src/diagnostic.mjs';
import {prepareOwnerReportArtifact,ownerReportArtifactBytes} from '../src/owner-report-artifact.mjs';
import {callTool,cliError} from '../src/mcp-stdio.mjs';
import {spawn,spawnSync} from 'node:child_process';
import http from 'node:http';
import {checkoutWorktreeWithoutFilters} from '../src/integrator.mjs';
import {prepareT3Audit,initT3Audit,appendT3Audit} from '../src/t3-audit.mjs';
import {publishAlert,checkAlerts} from '../src/alerts.mjs';


test('structured output preserves armor-like prose across object boundaries', () => {
  const dash = String.fromCharCode(45);
  for (const words of [['end', 'to', 'end'], ['back', 'end']]) {
    const status = 'neither proves ' + words.join(dash) + ' success.';
    const detail = 'Track durable private certificate storage and cryptographic material.';
    for (const entry of [{ detail: status + ' ' + detail }, { status, detail }]) {
      const out = redactOutput(entry);
      for (const [field, value] of Object.entries(entry)) assert.equal(out[field], value, field);
    }
  }
});
test('structured output masks complete and truncated armor across object boundaries', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const key = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const newline = String.fromCharCode(10);
  const lines = key.trim().split(newline);
  const banner = lines[0];
  assert(lines.length > 3, 'fixture must contain body lines and footer');
  for (const text of [key, banner, banner + newline + lines[1]]) {
    const split = text.indexOf(newline);
    const entries = [{ detail: text }];
    if (split !== -1) entries.push({ status: text.slice(0, split), detail: text.slice(split) });
    for (const entry of entries) {
      const out = JSON.stringify(redactOutput(entry));
      assert(out.includes('[redacted secret]'), 'armor must produce a mask');
      assert(!out.includes(banner), 'armor banner must not survive');
      for (const line of lines.slice(1, -1)) assert(!out.includes(line), 'key body must not survive');
    }
  }
  // A complete key does not poison unrelated neighbouring fields.
  const entry = { detail: key, status: 'ordinary readable diagnostic' };
  assert.equal((redactOutput(entry)).status, entry.status);
  // Nor should an isolated banner absorb a prose diagnostic.
  const prose = { status: banner, detail: 'ordinary readable diagnostic' };
  const cleanProse = redactOutput(prose);
  assert.equal(cleanProse.detail, prose.detail);
});
// Synthetic, obviously fake credential shapes.
const HEX='0123456789abcdef'.repeat(4);
const RESOURCE=`https://bridge.example.invalid/${HEX}/mcp`;
// HEX stands for the bridge path secret. The bridge registers it at startup, so every sink masks it by value; there is
// no generic hex or URL-path rule.
registerSecret(HEX);
const WHSEC='whsec_SYNTHETICwebhookSIGNINGvalue0000';
const OPAQUE='synthetic-opaque-bearer-value-zzz';
const OAUTH='synthetic-oauth-client-secret-qqq';
const GH='ghp_'+'S'.repeat(36);

test('T3 audit never persists opaque bearer OAuth webhook or resource credentials',() => {
  const db=new DatabaseSync(':memory:');initT3Audit(db);
  const text=`use ${HEX} at ${RESOURCE} with ${WHSEC}, Authorization: Bearer ${OPAQUE} and client_secret=${OAUTH}`;
  const entry=prepareT3Audit('t3_thread_send',{
    threadId:HEX,cwd:RESOURCE,detail:`Bearer ${OPAQUE}`,model:WHSEC,provider:OAUTH,message:text,
  });
  appendT3Audit(db,entry,'subject','started');
  appendT3Audit(db,entry,'subject','success',{threadId:'t'});
  const dump=JSON.stringify(db.prepare('SELECT * FROM t3_audit').all());
  for(const raw of [HEX,RESOURCE,WHSEC,OPAQUE,OAUTH]) {
    assert(!entry.text_preview?.includes(raw),`preview leaks ${raw.slice(0,8)}`);
    assert(!entry.args_summary.includes(raw),`args_summary leaks ${raw.slice(0,8)}`);
    assert(!dump.includes(raw),`database row leaks ${raw.slice(0,8)}`);
  }
  assert(entry.text_sha256,'digest kept');
});

test('alert publisher redacts title and body before transport',async() => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'redaction-alert-'));
  const file=path.join(dir,'alerts.env');
  fs.writeFileSync(file,'NTFY_URL=http://publisher.invalid/x\nNTFY_TOKEN=publisher-auth\n',{mode:0o600});
  const saved={file:process.env.DALAN_ALERTS_FILE,fetch:globalThis.fetch};
  process.env.DALAN_ALERTS_FILE=file;
  let sent,logged;
  globalThis.fetch=async(url,options)=>{sent=options;return {ok:true,status:200};};
  try {
    await publishAlert(`deploy ${GH}`,`path ${HEX} url ${RESOURCE} ${WHSEC} Bearer ${OPAQUE} client_secret=${OAUTH}`,e=>{logged=e;},{requirePublisher:true});
    const out=JSON.stringify({title:sent.headers.Title,body:sent.body,logged});
    for(const raw of [GH,HEX,RESOURCE,WHSEC,OPAQUE,OAUTH]) assert(!out.includes(raw),`leaks ${raw.slice(0,8)}`);
    assert.equal(sent.headers.Authorization,'Bearer publisher-auth');
    assert(sent.body.length>0);
  } finally {
    globalThis.fetch=saved.fetch;
    if(saved.file===undefined)delete process.env.DALAN_ALERTS_FILE;else process.env.DALAN_ALERTS_FILE=saved.file;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

async function capture(title,body,run) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'redaction-cap-'));
  const file=path.join(dir,'alerts.env');
  fs.writeFileSync(file,'NTFY_URL=http://publisher.invalid/x\n',{mode:0o600});
  const saved={file:process.env.DALAN_ALERTS_FILE,fetch:globalThis.fetch};
  process.env.DALAN_ALERTS_FILE=file;
  let sent;const logs=[];
  globalThis.fetch=async(url,options)=>{sent=options;return {ok:true,status:200};};
  try {await run(title,body,e=>logs.push(e));return JSON.stringify({title:sent?.headers.Title,body:sent?.body,logs});}
  finally {
    globalThis.fetch=saved.fetch;
    if(saved.file===undefined)delete process.env.DALAN_ALERTS_FILE;else process.env.DALAN_ALERTS_FILE=saved.file;
    fs.rmSync(dir,{recursive:true,force:true});
  }
}

test('credentials split across alert title and body are masked',async() => {
  const out1=await capture('Bearer',OPAQUE,(t,b,l)=>publishAlert(t,b,l,{requirePublisher:true}));
  assert(!out1.includes(OPAQUE),'opaque bearer split across fields leaks');
  const out2=await capture('whsec_','SUFFIXsplitwebhookvalue0000',(t,b,l)=>publishAlert(t,b,l,{requirePublisher:true}));
  assert(!out2.includes('SUFFIXsplitwebhookvalue0000'),'whsec suffix split across fields leaks');
});

test('leading or trailing whitespace around a split credential does not leak it',async() => {
  for(const [title,body] of [...[' ','\t','\n'].map(ws=>['Bearer',ws+OPAQUE]),['Bearer ',OPAQUE],['Bearer \n',' '+OPAQUE]]) {
    const out=await capture(title,body,(t,b,l)=>publishAlert(t,b,l,{requirePublisher:true}));
    assert(!out.includes(OPAQUE),`whitespace-separated split credential leaks: ${JSON.stringify([title,body])}`);
  }
});

test('the registered path secret in a URL and cookie attributes are masked',() => {
  assert.equal(redactSinkText(RESOURCE),'https://bridge.example.invalid/[redacted secret]/mcp');
  const unknown='https://bridge.example.invalid/synthetic-resource-path-value-ZZZ/mcp';
  assert.equal(redactSinkText(unknown),unknown,'an unregistered opaque path is not guessed at');
  assert(!redactLogEntry('cookie: sid=ok; other='+OPAQUE).includes(OPAQUE),'cookie attribute value leaks');
});

test('pending-delivery alert log is sanitised like emit',async() => {
  const logs=[];
  const store={
    pendingDeliveryAlerts:()=>[{request_id:HEX,notification_id:'n1',reason:'whsec_fixture9',logged_at:null}],
    deliveryAlertLogged(){},deliveryAlertPublished(){},
    pruneWorkerCalls(){},inferBreak(){},hasQueuedFor:()=>false,breakAlertsDue:()=>[],
    status:()=>{throw new Error('stop after pending alerts');},
  };
  await checkAlerts(store,e=>logs.push(e)).catch(()=>{});
  const out=JSON.stringify(logs);
  assert(logs.length,'pending alert logged');
  assert(!out.includes(HEX),'request id hex leaks via direct log');
  assert(!out.includes('whsec_fixture9'),'whsec leaks via direct log');
});

test('a credential crossing the truncation cutoff leaks no prefix',() => {
  const out=redactSinkText('x'.repeat(16370)+' '+HEX);
  assert(!out.includes(HEX.slice(0,13)),'hex prefix leaked at cutoff');
  const bearer=redactSinkText('x'.repeat(16372)+' Bearer '+OPAQUE);
  assert(!bearer.includes(OPAQUE.slice(0,4)),'bearer prefix leaked at cutoff');
});

test('T3 audit result ids are not persisted verbatim when secret-shaped',() => {
  const db=new DatabaseSync(':memory:');initT3Audit(db);
  const entry=prepareT3Audit('t3_thread_send',{message:'m'});
  appendT3Audit(db,entry,'subject','success',{threadId:HEX,projectId:WHSEC,runId:'run_ok-1'});
  appendT3Audit(db,entry,'subject','success',{_audit_ids:{threadIds:[HEX,'thread_a'],projectIds:[RESOURCE]}});
  const dump=JSON.stringify(db.prepare('SELECT t3_ids FROM t3_audit').all());
  for(const raw of [HEX,WHSEC,RESOURCE]) assert(!dump.includes(raw),`result id leaks ${raw.slice(0,8)}`);
  assert(dump.includes('run_ok-1')&&dump.includes('thread_a'),'ordinary ids stay readable');
});

const OP24='Zx9Qw3Lm7Rt2Vb5Nc8Hd4Kf6';

test('owner report artifacts mask opaque bearer, webhook and credential-field values',() => {
  const doc={format:'dalan-owner-report',version:1,summary:`called with Bearer ${OP24}`,result:`whsec_${OP24} api_key=${OP24}`,progress:[{sequence:1,at:'t',text:`password=${OP24}`}]};
  const bytes=ownerReportArtifactBytes(prepareOwnerReportArtifact(doc)).toString();
  assert(!bytes.includes(OP24),'owner report artifact leaks an opaque credential');
});

test('stdio MCP stderr never carries a raw secret from an error stack',async() => {
  const written=[];const write=process.stderr.write;
  process.stderr.write=chunk=>{written.push(String(chunk));return true;};
  try {
    const args=new Proxy({},{ownKeys(){throw new Error(`boom https://user:${OP24}@host.invalid/ api_key=${OP24}`);}});
    await callTool('dalan_status',args);
  } finally {process.stderr.write=write;}
  assert(written.length,'expected a stderr write');
  assert(!written.join('').includes(OP24),'stdio stderr leaks a secret');
});

test('tool error text returned to an MCP client masks credential fields',async() => {
  const dir=fs.mkdtempSync(path.join(os.homedir(),'.tmp/redaction-sinks-'));
  const port=await (await import('../src/test-support/port.mjs')).reservedPort();
  fs.mkdirSync(path.join(dir,'.config/dot-bridge'),{recursive:true});
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:path.join(import.meta.dirname,'..'),stdio:['ignore','pipe','pipe'],
    env:{...process.env,HOME:dir,DALAN_LEGACY_PROFILE:'1',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_PORT:String(port),NODE_ENV:'test',DOT_BRIDGE_T3_DRY_RUN:'1'}});
  let out='';child.stdout.on('data',c=>{out+=c;});child.stderr.on('data',()=>{});
  try {
    for(let i=0;i<200&&!out.includes('MCP listening');i++)await new Promise(r=>setTimeout(r,50));
    assert(out.includes('MCP listening'),'server did not start');
    const secret=fs.readFileSync(path.join(dir,'.config/dot-bridge/env'),'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
    const res=await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'list_pending',arguments:{[`api_key=${OP24}`]:1}}})});
    const text=JSON.stringify(await res.json());
    assert(text.includes('unknown field'),`unexpected response ${text}`);
    assert(!text.includes(OP24),'tool error text leaks a credential field value');
  } finally {
    child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('an HTTP tool crash returns the tool name and an error id; the detail goes to the request log',async() => {
  const dir=fs.mkdtempSync(path.join(os.homedir(),'.tmp/redaction-crash-'));
  const port=await (await import('../src/test-support/port.mjs')).reservedPort();
  fs.mkdirSync(path.join(dir,'.config/dot-bridge'),{recursive:true});
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:path.join(import.meta.dirname,'..'),stdio:['ignore','pipe','pipe'],
    env:{...process.env,HOME:dir,DALAN_LEGACY_PROFILE:'1',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_PORT:String(port),NODE_ENV:'test',DOT_BRIDGE_T3_DRY_RUN:'1'}});
  let out='';child.stdout.on('data',c=>{out+=c;});child.stderr.on('data',()=>{});
  // An unlabelled value no rule can recognise: only the crash rule keeps it from the client.
  const stored='zQ8vT3pL6nR1xK4wJ7mB2cY5';
  try {
    for(let i=0;i<200&&!out.includes('MCP listening');i++)await new Promise(r=>setTimeout(r,50));
    assert(out.includes('MCP listening'),'server did not start');
    const {Store}=await import('../src/store.mjs');
    const store=new Store(path.join(dir,'.local/share/dot-bridge/bridge.db'));
    store.submit({schema_version:1,request_id:'req-crash-0001',brief:'crash test',inputs:[{revision:'abc'}],expected_output:'one result',execution_scope:'read-only'},'t','e','owner');
    // A corrupt row makes JSON.parse throw a SyntaxError that quotes the stored text.
    store.db.prepare('UPDATE assignments SET payload=? WHERE request_id=?').run(stored,'req-crash-0001');
    store.db.close();
    const secret=fs.readFileSync(path.join(dir,'.config/dot-bridge/env'),'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
    const res=await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'list_pending',arguments:{}}})});
    const body=await res.json(),text=body.result?.content?.[0]?.text??'';
    assert.equal(body.result?.isError,true,JSON.stringify(body));
    const id=text.match(/^Error executing tool list_pending \(error id ([0-9a-f]{8})/)?.[1];
    assert(id,`crash text is not generic: ${text}`);
    assert(!JSON.stringify(body).includes(stored),'crash text leaks stored data to the client');
    const logFile=path.join(dir,'.local/state/dot-bridge/requests.jsonl');
    assert(fs.readFileSync(logFile,'utf8').includes(id),'the error id is not in the request log');
    // The admin socket reaches the same corrupt row; its error response passes the same boundary.
    const admin=await new Promise((resolve,reject)=>{
      const req=http.request({socketPath:path.join(dir,'.local/share/dot-bridge/admin.sock'),path:'/get?id=req-crash-0001',method:'GET',headers:{'x-owner-capability':'owner'}},res=>{
        let data='';res.on('data',c=>{data+=c;});res.on('end',()=>resolve(data));});
      req.on('error',reject);req.end();
    });
    assert(!admin.includes(stored.slice(0,10)),`admin error leaks stored data: ${admin}`);
    assert.match(admin,/error id [0-9a-f]{8}/,`admin crash is not generic: ${admin}`);
  } finally {
    child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('redactOutput masks credential-field values inside strings',() => {
  const out=JSON.stringify(redactOutput({result:`api_key=${OP24}`,nested:[`password: ${OP24}`]}));
  assert(!out.includes(OP24),'redactOutput leaks a credential field value');
});

test('safeDiagnostic masks clipped credential prefixes and short bare hex',() => {
  for(const frag of ['sk_live_abcdef','sk_test_abcdef','sk_abcdef','glpat-abcdef','npm_abcdef','xoxe-abcdef','whsec_abcdef','GOCSPX-abcdef','ya29.abcdef']) {
    assert(!safeDiagnostic(`err ${frag}`).includes(frag),`clipped fragment leaks: ${frag}`);
  }
  assert(!safeDiagnostic(`key ${HEX}`,20).includes(HEX.slice(0,8)),'a registered secret leaks a prefix at the clip');
  const sha='abcdef0123456789abcdef0123456789abcdef01';
  assert.equal(safeDiagnostic(`commit ${sha}`),`commit ${sha}`,'a git SHA is not a secret');
});

test('redactLogEntry masks secrets held in object keys',() => {
  const out=JSON.stringify(redactLogEntry({[GH]:'x',nested:{[GH]:'y'}}));
  assert(!out.includes(GH),'secret key leaks');
});

test('redactLogEntry masks credentials split across array elements and sibling fields',() => {
  const cases=[
    [{a:'Bearer',b:OP24},OP24],
    [['ghp_'+'A'.repeat(18),'A'.repeat(18)],'A'.repeat(18)],
    [{key:'password',value:'hunter2'},'hunter2'],
    [['password=','hunter2'],'hunter2'],
  ];
  for(const [entry,leak] of cases) assert(!JSON.stringify(redactLogEntry(entry)).includes(leak),`split credential leaks: ${JSON.stringify(entry)}`);
  const fine={kind:'x',status:200,route:'/health',note:'ok'};
  assert.deepEqual(redactLogEntry(fine),fine,'ordinary entries are unchanged');
});

test('T3 audit hashes opaque alphanumeric result ids but keeps ordinary ids',() => {
  const db=new DatabaseSync(':memory:');initT3Audit(db);
  const entry=prepareT3Audit('t3_thread_send',{message:'m'});
  const opaque='aB3dE5gH7jK9mN1pQ3sT5vW7yZ2bC4dE6fG8hJ0k';
  appendT3Audit(db,entry,'subject','success',{runId:opaque,threadId:'thread_ok-1'});
  const dump=JSON.stringify(db.prepare('SELECT t3_ids FROM t3_audit').all());
  assert(!dump.includes(opaque),'opaque id stored readable');
  assert(dump.includes('thread_ok-1'),'ordinary id stays readable');
});

// F1/F2: output and intake paths without a BEGIN line, and without recursion limits.
import {generateKeyPairSync} from 'node:crypto';
import {redactSecrets,hasSecretContent} from '../src/redaction.mjs';

function pemBodies() {
  const out=[];
  const rsa=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
  const ec=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'sec1',format:'pem'});
  for(const pem of [rsa,ec]) {
    const lines=pem.trim().split('\n');
    const bodyLines=lines.slice(1,-1);
    const noBegin=lines.slice(1).join('\n');
    out.push({bodyLines,noBegin,bodyOnly:bodyLines.join('\n'),tail:pem.trim().slice(-120)});
  }
  return out;
}

test('F1 BEGIN-less private key bodies are masked in output and refused at intake',() => {
  for(const {bodyLines,noBegin,bodyOnly,tail} of pemBodies()) {
    for(const sample of [noBegin,bodyOnly,tail]) {
      const masked=redactSecrets(sample).text;
      const outputText=JSON.stringify(redactOutput({detail:sample}));
      const tailLines=sample===tail?sample.split('\n').slice(1).filter(l=>!l.startsWith('-')):bodyLines;
      for(const line of tailLines) {
        assert.ok(!masked.includes(line),`redactSecrets leaked ${line}`);
        assert.ok(!outputText.includes(line),`redactOutput leaked ${line}`);
      }
    }
    assert.equal(hasSecretContent(noBegin),true);
  }
});

test('F1 long base64 and source lines pass through redactOutput unchanged',() => {
  const b64=Buffer.from(Array.from({length:3000},(_,i)=>(i*131+7)%256)).toString('base64').slice(0,4000);
  assert.equal(b64.length,4000);
  const source="export const handler = async (request, response) => { return response.send(await loadConfiguration(request.params.identifier)); };";
  assert.deepEqual(redactOutput({a:b64,b:source}),{a:b64,b:source});
});

test('F2 deeply nested values do not overflow the stack',() => {
  const deep=JSON.parse('['.repeat(5000)+']'.repeat(5000));
  assert.doesNotThrow(()=>redactOutput(deep));
  assert.equal(hasSecretContent(deep),true);
  const cyc={};cyc.self=cyc;
  assert.doesNotThrow(()=>redactOutput(cyc));
});

const OP24b='Zq7Lm2Xv9Rt4Ny8Wb3Hc5Kd6';

test('P1a redactOutput masks bare values under credential-named fields',() => {
  const out=redactOutput({access_token:OP24b,password:'hunter2',nested:{client_secret:OP24b,apiKey:OP24b},list:[{refresh_token:OP24b}]});
  const text=JSON.stringify(out);
  assert(!text.includes(OP24b),text);
  assert(!text.includes('hunter2'),text);
});

test('P1a normal tool result shapes pass redactOutput unchanged',() => {
  const shapes=[
    {claim_id:'clm_0123456789abcdef0123',request_id:'req-0123456789abcdef0123',status:'claimed',worker:'worker-a',count:3,idempotency_key:'idem-0123456789abcdef0123456789',schema_hash:'fedcba9876543210'.repeat(4),public_key:'MCowBQYDK2VwAyEA'+'A'.repeat(20),cache_key:'cache-0123456789abcdef0123456789'},
    {items:[{request_id:'req-1',kind:'review',subject:'s',tokens:12,input_tokens:5,session_count:2}],next_cursor:null},
    {tool:'call_tool_write',arguments:{idempotency_key:'idem-0123456789abcdef0123456789',name:'finish'},result:{ok:true}},
  ];
  for(const shape of shapes) assert.deepEqual(redactOutput(shape),shape);
});

test('P1b redactSinkText masks a credential split across JSON sibling fields',() => {
  const text=JSON.stringify({a:'Bearer',b:OP24b,ok:'fine'});
  const out=redactSinkText(text);
  assert(!out.includes(OP24b),out);
  assert.equal(redactSinkText('plain prose, nothing here'),'plain prose, nothing here');
});

test('P2a glued known-prefix tokens are masked, prose is not',() => {
  const glued='prefix'+'ghp_'+'A'.repeat(36);
  assert(!redactLogEntry({m:glued}).m.includes('ghp_'+'A'.repeat(10)));
  assert(!redactSinkText(glued).includes('A'.repeat(20)));
  assert.equal(hasSecretContent(glued),true);
  for(const prose of ['the sk-learn package and ask-me anything','task_force and desk-lamp','Ghost pull requests and oxbow lakes']) {
    assert.equal(hasSecretContent(prose),false,prose);
    assert.equal(redactSinkText(prose),prose);
  }
});

test('P2b cliError redacts raw child stderr',() => {
  const out=cliError({code:1,stdout:'',stderr:`boom api_key=${OP24b} ${'ghp_'+'B'.repeat(36)} https://x.invalid/${HEX}/mcp`},'get');
  assert(!out.message.includes(OP24b)&&!out.message.includes('B'.repeat(20))&&!out.message.includes(HEX),out.message);
  assert(out.message.includes('https://x.invalid/[redacted secret]/mcp'),out.message);
  assert(out.message.startsWith('get failed (exit 1)'));
});

test('P2d intake refuses strong formats and warns on credential fields and credential text',() => {
  // Labelled values are medium precision: intake warns and every output sink masks them.
  assert.equal(hasSecretContent({password:'hunter2'}),false);
  assert.equal(hasSecretContent({brief:'run it with password=hunter2'}),false);
  assert.equal(redaction.hasCredentialHints({password:'hunter2'}),true);
  assert.equal(redaction.hasCredentialHints({brief:'run it with password=hunter2'}),true);
  assert.equal(hasSecretContent({brief:'ghp_'+'C'.repeat(36)}),true);
  assert.equal(hasSecretContent({brief:'rotate the password policy and review token handling'}),false);
  assert.equal(hasSecretContent({scope_paths:['src/a.mjs'],brief:'Review the auth module',request_id:'req-0123456789abcdef'}),false);
});

test('dalan_submit result returned to an MCP client is redacted',async() => {
  const home=fs.mkdtempSync(path.join(os.homedir(),'.tmp/redaction-sub-'));
  const sockDir=path.join(home,'.local/share/dalan');fs.mkdirSync(sockDir,{recursive:true});
  const token='ghp_'+'Q'.repeat(36),cred='A1b2C3d4E5f6G7h8J9k0L1m2';
  const server=http.createServer((req,res) => {
    req.resume();
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({verdict:'admissible',message:`brief mentions ${token}`,note:`api_key=${cred}`}));
  });
  await new Promise(r=>server.listen(path.join(sockDir,'admin.sock'),r));
  const prevHome=process.env.HOME;process.env.HOME=home;
  try {
    const res=await callTool('dalan_submit',{dry_run:true,assignment:{request_id:'req-0123456789abcdef',brief:'x',scope_paths:['src/a.mjs']}});
    const text=JSON.stringify(res);
    assert(text.includes('admissible'),`fake admin verdict did not reach the tool: ${text}`);
    assert(!text.includes(token)&&!text.includes('Q'.repeat(20)),'dalan_submit result leaks a token');
    assert(!text.includes(cred),'dalan_submit result leaks a credential field value');
  } finally {
    process.env.HOME=prevHome;
    await new Promise(r=>server.close(r));
    fs.rmSync(home,{recursive:true,force:true});
  }
});

test('git failure text masks secret-shaped stderr but keeps ordinary stderr',() => {
  const repo=fs.mkdtempSync(path.join(os.homedir(),'.tmp/redaction-git-'));
  try {
    assert.equal(spawnSync('git',['init','-q',repo]).status,0);
    const secret='ghp_'+'Z'.repeat(36);
    const fail=ref => {try {checkoutWorktreeWithoutFilters(repo,ref,process.env);} catch(error) {return error.message;} return '';};
    const leaky=fail(secret);
    assert(leaky.startsWith('git checkout failed'),`expected a git failure, got: ${leaky}`);
    assert(!leaky.includes('Z'.repeat(20)),`git error leaks a token: ${leaky}`);
    assert(leaky.includes('[redacted secret]'),leaky);
    const plain=fail('no-such-ref');
    assert(plain.startsWith('git checkout failed')&&plain.includes('no-such-ref'),`ordinary stderr excerpt missing: ${plain}`);
  } finally {fs.rmSync(repo,{recursive:true,force:true});}
});

// One model for every sink: shared corpora of normal text (must pass unchanged and be admitted) and of secret inputs
// (must be masked by every sink and refused at intake). See the redaction model in src/redaction.mjs.
import * as redaction from '../src/redaction.mjs';
const OP=OP24b,KNOWN='Kn0wn-Synthetic-Env-Value-77';
const BASE64=Buffer.from(Array.from({length:3000},(_,i)=>(i*131+7)%256)).toString('base64').slice(0,4000);
const NORMAL_TEXT=[
  'Review error code: ENOENT','error code: 404','const encode = value => value;',
  'export const handler = async (request, response) => { return response.send(await loadConfiguration(request.params.identifier)); };',
  'rotate the password policy and review token handling','send the Bearer token in the Authorization header',
  'password: false','token=${GH_TOKEN}','api_key=<your api key>','password=""','tokens: 12',
  'cookie: <session cookie>','cookie: sid=${SID}','set-cookie: false',
  JSON.stringify({idempotency_key:'idem-0123456789abcdef0123456789',cache_key:'cache-0123456789abcdef0123456789',public_key:'MCowBQYDK2VwAyEA'+'A'.repeat(20)}),
];
const NORMAL_LONG=[BASE64,JSON.stringify({artifact:BASE64})];
const SECRET_TEXT=()=>[
  `Bearer ${OP}`,`api_key=${OP}`,`password: ${OP}`,JSON.stringify({access_token:OP}),`cookie: sid=ok; other=${OP}`,
  'prefix'+'ghp_'+'A'.repeat(36),`https://user:${OP}@host.invalid/`,`whsec_${OP}`,`value ${KNOWN} here`,
  JSON.stringify({a:'Bearer',b:OP}),JSON.stringify(['Bearer',OP]),JSON.stringify(['password=',OP]),
  ...pemBodies().map(p=>p.noBegin),
];
const MEDIUM=text=>/^(?:Bearer |api_key=|password: |\{"access_token"|cookie: )/.test(text);
const SECRET_STRUCTURED=()=>[{access_token:OP},{a:'Bearer',b:OP},['Bearer',OP],['password=',OP],{x:['Bearer',OP]}];
const leakOf=value=>{
  if(typeof value==='string'&&value.includes('BEGIN')===false&&/^[A-Za-z0-9+/=\n]{200,}$/.test(value)) return value.split('\n')[1];
  return /ghp_/.test(value)?'A'.repeat(20):value.includes(KNOWN)?KNOWN:OP;
};
const TEXT_SINKS={
  redactOutput:text=>redactOutput(text),
  redactSinkText:text=>redactSinkText(text),
  redactLogEntry:text=>redactLogEntry(text),
  safeDiagnostic:text=>safeDiagnostic(text,100000),
};

test('model: normal text passes every sink unchanged and is admitted',() => {
  const failures=[];
  const check=(ok,label)=>{if(!ok) failures.push(label);};
  for(const text of NORMAL_TEXT) {
    for(const [name,sink] of Object.entries(TEXT_SINKS)) check(sink(text)===text,`${name} changed ${text.slice(0,60)}`);
    check(hasSecretContent({brief:text})===false,`intake refused ${text.slice(0,60)}`);
  }
  for(const text of NORMAL_LONG) {
    // The request log also masks long mixed-case runs (a documented residual heuristic); every other sink keeps them.
    for(const [name,sink] of Object.entries(TEXT_SINKS)) if(name!=='redactLogEntry') check(sink(text)===text,`${name} changed a long base64 value ${text.slice(0,12)}`);
    check(hasSecretContent({brief:text})===false,'intake refused a long base64 value');
  }
  const ids={idempotency_key:'idem-0123456789abcdef0123456789',cache_key:'cache-0123456789abcdef0123456789',public_key:'MCowBQYDK2VwAyEA'+'A'.repeat(20)};
  check(JSON.stringify(redactOutput(ids))===JSON.stringify(ids),'redactOutput changed identifier fields');
  check(hasSecretContent(ids)===false,'intake refused identifier fields');
  check(hasSecretContent({password:'${PASSWORD}',token:'<token>',api_key:''})===false,'intake refused credential-named placeholders');
  assert.deepEqual(failures,[]);
});

test('model: secret inputs are masked by every sink and refused at intake',() => {
  registerSecret(KNOWN);
  const failures=[];
  for(const text of SECRET_TEXT()) {
    const leak=leakOf(text);
    for(const [name,sink] of Object.entries(TEXT_SINKS)) if(JSON.stringify(sink(text)).includes(leak)) failures.push(`${name} leaks ${text.slice(0,60)}`);
    // Intake refuses known values and strong formats; it warns on labelled (medium-precision) values. A credential
    // split across JSON siblings is a sink concern.
    if(text.startsWith('{"a"')||text.startsWith('["')) continue;
    if(MEDIUM(text)) {if(hasSecretContent({brief:text})||!redaction.hasCredentialHints({brief:text})) failures.push(`intake does not warn-only on ${text.slice(0,60)}`);}
    else if(!hasSecretContent({brief:text})) failures.push(`intake admits ${text.slice(0,60)}`);
  }
  for(const value of SECRET_STRUCTURED()) {
    for(const [name,sink] of [['redactOutput',redactOutput],['redactLogEntry',redactLogEntry],['redactSinkText',v=>redactSinkText(JSON.stringify(v))]]) {
      if(JSON.stringify(sink(value)).includes(OP)) failures.push(`${name} leaks ${JSON.stringify(value)}`);
    }
  }
  assert.deepEqual(failures,[]);
});

test('stdio MCP error results are redacted in content and structuredContent',async() => {
  const home=fs.mkdtempSync(path.join(os.homedir(),'.tmp/redaction-err-'));
  const sockDir=path.join(home,'.local/share/dalan');fs.mkdirSync(sockDir,{recursive:true});
  const server=http.createServer((req,res) => {
    req.resume();
    res.writeHead(400,{'content-type':'application/json'});
    res.end(JSON.stringify({error:`refresh failed {"access_token":"${OP}"}`,verdict:'reject',reasons:[{code:'x',access_token:OP}]}));
  });
  await new Promise(r=>server.listen(path.join(sockDir,'admin.sock'),r));
  const prevHome=process.env.HOME;process.env.HOME=home;
  try {
    const res=await callTool('dalan_status',{});
    assert.equal(res.isError,true,JSON.stringify(res));
    assert(JSON.stringify(res.structuredContent??{}).includes('reject'),`fake admin error did not reach the tool: ${JSON.stringify(res)}`);
    assert(!res.content[0].text.includes(OP),`content leaks: ${res.content[0].text}`);
    assert(!JSON.stringify(res.structuredContent).includes(OP),'structuredContent leaks');
  } finally {
    process.env.HOME=prevHome;
    await new Promise(r=>server.close(r));
    fs.rmSync(home,{recursive:true,force:true});
  }
  const bad=await callTool('dalan_status',{[`api_key=${OP}`]:1});
  assert(bad.isError&&bad.content[0].text.includes('unknown argument'),JSON.stringify(bad));
  assert(!JSON.stringify(bad).includes(OP),`unknown-argument error leaks: ${JSON.stringify(bad)}`);
  const thrown=await callTool('dalan_status',new Proxy({},{ownKeys(){throw new Error(`boom Bearer ${OP}`);}}));
  assert(!JSON.stringify(thrown).includes(OP),`exception message leaks: ${JSON.stringify(thrown)}`);
});

test('git failure text masks an opaque Bearer credential in stderr',() => {
  const repo=fs.mkdtempSync(path.join(os.homedir(),'.tmp/redaction-git-'));
  try {
    assert.equal(spawnSync('git',['init','-q',repo]).status,0);
    let message='';
    try {checkoutWorktreeWithoutFilters(repo,`Bearer ${OP}`,process.env);} catch(error) {message=error.message;}
    assert(message.startsWith('git checkout failed'),message);
    assert(!message.includes(OP),`git error leaks an opaque bearer: ${message}`);
  } finally {fs.rmSync(repo,{recursive:true,force:true});}
});

// Per-rule pairs (gitleaks Validate): each rule masks its mustMask inputs and leaves its mustPass inputs unchanged.
const RULES={
  'known value':{mustMask:[`v=${KNOWN}`],mustPass:['Kn0wn-Synthetic-Env-Value-76','known value']},
  'token family':{mustMask:['ghp_'+'D'.repeat(36),'x'+'glpat-'+'E'.repeat(20),'sk-'+'F'.repeat(30),`whsec_${OP}`],mustPass:['the sk-learn package','task_force and desk-lamp','whsec_ alone']},
  'URL userinfo':{mustMask:[`https://user:${OP}@host.invalid/x`],mustPass:['https://user:pass@localhost/x','https://host.invalid/path']},
  'Bearer and Basic':{mustMask:[`Bearer ${OP}`,`Basic ${Buffer.from('user:'+OP).toString('base64')}`],mustPass:['send the Bearer token','Basic auth is off']},
  'header':{mustMask:[`Authorization: Token ${OP}`,`cookie: a=b; c=${OP}`,`Set-Cookie: sid=${OP}; Path=/; HttpOnly`],mustPass:['cookie: <session cookie>','set-cookie: false','authorization: ${AUTH_HEADER}']},
  'label':{mustMask:[`api_key=${OP}`,`"client_secret": "${OP}"`,`accessToken: ${OP}`,`x-api-key=${OP}`,`?token=${OP}&x=1`],mustPass:['error code: ENOENT','const encode = value => value;','author: Alex','token_count: 12','password: false','api_key=<key>','idempotency_key: 3fa85f64-5717-4562-b3fc-2c963f66afa6']},
};
test('per-rule mustMask and mustPass pairs',() => {
  registerSecret(KNOWN);
  for(const [rule,{mustMask,mustPass}] of Object.entries(RULES)) {
    for(const text of mustMask) assert.notEqual(redaction.maskText(text),text,`${rule} misses ${text}`);
    for(const text of mustPass) assert.equal(redaction.maskText(text),text,`${rule} changes ${text}`);
  }
  for(const text of ['Unexpected error','none','true','550e8400-e29b-41d4-a716-446655440000','abcdef0123456789abcdef0123456789abcdef01']) assert.equal(redaction.maskText(text),text);
});

test('a registered secret is masked in every encoded form; a near miss passes',() => {
  const secret='Password123!x';
  registerSecret(secret);
  const forms=[secret,...[0,1,2].map(n=>Buffer.from('a'.repeat(n)+secret+'tail').toString('base64')),
    `Basic ${Buffer.from('user:'+secret).toString('base64')}`,encodeURIComponent(secret),JSON.stringify({p:secret}),
    `'${secret}'`,`https://user:${encodeURIComponent(secret)}@host.invalid/`,`Authorization: Bearer ${secret}`];
  for(const form of forms) {
    for(const [name,sink] of Object.entries(TEXT_SINKS)) {
      const out=JSON.stringify(sink(`x ${form} y`));
      assert(!out.includes(secret)&&!out.includes(encodeURIComponent(secret)),`${name} leaks ${form}`);
    }
  }
  const b64=Buffer.from(secret).toString('base64');
  for(const n of [0,1,2]) {
    const encoded=Buffer.from('a'.repeat(n)+secret+'tail').toString('base64');
    assert(redaction.maskText(encoded).includes('[redacted secret]'),`base64 at offset ${n} not masked: ${encoded}`);
  }
  assert(!redaction.maskText(b64).includes(b64));
  assert.equal(redaction.maskText('password123 is weak'),'password123 is weak','near miss passes');
  assert.equal(hasSecretContent({brief:`use ${secret}`}),true,'intake refuses a known value');
});

import {createLineMasker} from '../src/diagnostic.mjs';
test('child output split across chunks at every offset is masked as one',() => {
  const text=`start\nAuthorization: Bearer ${OP}\nghp_${'G'.repeat(36)} and ${KNOWN} end\nlast`;
  for(let cut=0;cut<=text.length;cut++) {
    let out='';
    const relay=createLineMasker(chunk=>{out+=chunk;});
    relay(text.slice(0,cut));relay(text.slice(cut));relay('',true);
    for(const leak of [OP,'G'.repeat(20),KNOWN]) assert(!out.includes(leak),`split at ${cut} leaks ${leak}`);
    assert(out.startsWith('start\n')&&out.endsWith('last\n'),`split at ${cut} lost text: ${out}`);
  }
});

test('canary round trip: no sink returns the canary; an unredacted sink is caught',async() => {
  const canary=`cny-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}X9`;
  registerSecret(canary);
  const encodings=[canary,Buffer.from(canary).toString('base64').slice(0,12),encodeURIComponent(canary)];
  const found=text=>encodings.some(form=>text.includes(form));
  assert.equal(hasSecretContent({brief:`deploy with ${canary}`}),true,'intake refuses the canary');
  let relayed='';const relay=createLineMasker(chunk=>{relayed+=chunk;});relay(`stdout ${canary}\nstderr ${canary}`);relay('',true);
  const thrown=await callTool('dalan_status',new Proxy({},{ownKeys(){throw new Error(`boom ${canary}`);}}));
  const outputs=[relayed,JSON.stringify(thrown),JSON.stringify(redactOutput({field:canary,list:['Bearer',canary]})),
    JSON.stringify(redactLogEntry({field:canary,list:[canary]})),redactSinkText(JSON.stringify({c:canary})),safeDiagnostic(canary)];
  for(const out of outputs) assert(!found(out),`canary reached a sink: ${out.slice(0,120)}`);
  // Negative control: the scan must catch a deliberately unredacted sink.
  assert(found(JSON.stringify({field:canary})),'the canary scan cannot see an unredacted sink');
});

test('sink coverage: every output path in the stdio MCP server, git and the relays calls the redactor',() => {
  const src=file=>fs.readFileSync(path.join(import.meta.dirname,'../src',file),'utf8');
  const mcp=src('mcp-stdio.mjs');
  const asResultBody=mcp.slice(mcp.indexOf('const asResult ='),mcp.indexOf('const handlers ='));
  assert.equal(mcp.match(/content: \[/g).length,asResultBody.match(/content: \[/g).length,'tool results are built only in asResult');
  assert.match(mcp,/content: \[\{ type: 'text', text: redactSinkText\(message\) \}\]/);
  assert.match(mcp,/const \{ text, structured \} = capped\(value\);/,'every tool value is redacted');
  assert.match(mcp,/error: \{ code, message: redactSinkText\(message\) \}/,'JSON-RPC errors are redacted');
  for(const write of mcp.match(/process\.stderr\.write\([^;]*\);/g)) assert.match(write,/safeDiagnostic\(/,write);
  for(const thrown of src('integrator.mjs').match(/throw new Error\(`git [^;]*;/g)) assert.match(thrown,/safeDiagnostic\(/,thrown);
  assert.match(src('try.mjs'),/createLineMasker\(text => fs\.appendFileSync\(logFile, text\)\)/);
  assert.match(src('owner-report-artifact.mjs'),/redactSinkText/);
  assert.match(src('request-log.mjs'),/redactLogEntry\(/);
  assert.match(src('alerts.mjs'),/sanitizeAlertFields\(rawTitle,rawMessage\)/);
});

test('a secret registered at runtime is refused at intake inside the submission worker thread',async() => {
  const {validateSubmissionAsync}=await import('../src/submission-policy.mjs');
  const held='runtime-held-operator-value-7Qk2';
  registerSecret(held);
  // Implementation scope runs admission in a worker thread; the worker starts with an empty registry of its own.
  const assignment={schema_version:1,request_id:'req-worker-0001',brief:`deploy with ${held}`,inputs:[{revision:'abc'}],expected_output:'one result',execution_scope:'implementation'};
  await assert.rejects(validateSubmissionAsync(assignment,{worker:'dot'}),/hard sensitive content exclusion/);
});

test('the line masker keeps armor state across chunks and lines',() => {
  const body=['MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7','synthKEYbodyLINEtwo0123456789abcdefABCDEFsynth'];
  for(const chunks of [
    ['-----BEGIN PRIVATE KEY-----\n',`${body[0]}\n`,`${body[1]}\n`,'-----END PRIVATE KEY-----\n'],
    ['-----BEGIN PRIVATE KEY-----\n'+body[0].slice(0,9),`${body[0].slice(9)}\n${body[1]}\n-----END PRI`,'VATE KEY-----\nafter\n'],
    ['-----BEGIN PRIVATE KEY-----\n',`${body[0]}\n`],
  ]) {
    let out='';const relay=createLineMasker(text=>{out+=text;});
    for(const chunk of chunks) relay(chunk);
    relay('',true);
    for(const line of body) if(chunks.join('').includes(line)) assert(!out.includes(line),`line masker leaks a key body line: ${out}`);
  }
  let plain='';const relay=createLineMasker(text=>{plain+=text;});relay('ready on port 8080\nall good\n');relay('',true);
  assert.equal(plain,'ready on port 8080\nall good\n');
});

test('a truncated stdio result does not repeat a registered value in the read-more command',async() => {
  const home=fs.mkdtempSync(path.join(os.homedir(),'.tmp/redaction-cap-'));
  const sockDir=path.join(home,'.local/share/dalan');fs.mkdirSync(sockDir,{recursive:true});
  const held='synthetic_path_held_123';
  registerSecret(held);
  const server=http.createServer((req,res) => {
    req.resume();
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({request_id:held,status:'completed',report:{summary:'x'.repeat(40000)}}));
  });
  await new Promise(r=>server.listen(path.join(sockDir,'admin.sock'),r));
  const prevHome=process.env.HOME;process.env.HOME=home;
  try {
    const res=await callTool('dalan_status',{});
    const text=JSON.stringify(res);
    assert(text.includes('truncated'),`result was not truncated: ${text.slice(0,200)}`);
    assert(!text.includes(held),'the truncation note repeats a registered value');
  } finally {
    process.env.HOME=prevHome;
    await new Promise(r=>server.close(r));
    fs.rmSync(home,{recursive:true,force:true});
  }
});

test('explicit credential values and explicit registration have no numeric exemption',async() => {
  const redaction=await import('../src/redaction.mjs');
  const out=JSON.stringify(redactOutput({password:'12345678',otp:'876543'}));
  assert(!out.includes('12345678')&&!out.includes('876543'),`numeric credential values pass: ${out}`);
  const real=JSON.stringify(redactOutput({password:12345678,otp:876543,nested:{token:246813}}));
  assert(!/12345678|876543|246813/.test(real),`numeric credential values pass: ${real}`);
  registerSecret('24681357');
  assert(!redaction.maskText('pin 24681357 set').includes('24681357'),'a registered numeric value is not masked');
  registerSecret('true');registerSecret('false');
  assert.equal(redaction.maskText('flag true or false'),'flag true or false','literal true/false must never be registered');
  assert.equal(redaction.maskText('max_tokens: 4096 for 120 seconds'),'max_tokens: 4096 for 120 seconds','numbers in prose stay readable');
});

test('alert notes keep commit hashes and long identifiers, and mask secrets',async() => {
  const {redactNote}=await import('../src/alerts.mjs');
  const sha='0123456789abcdef0123456789abcdef01234567';
  assert.equal(redactNote(`merged ${sha} into main`),`merged ${sha} into main`);
  assert.equal(redactNote('job req_AbCdEfGhIjKlMnOpQrStUvWx99 failed'),'job req_AbCdEfGhIjKlMnOpQrStUvWx99 failed');
  const masked=redactNote(`push ${GH} with Bearer ${OPAQUE} at ${RESOURCE}`);
  for(const secret of [GH,OPAQUE,HEX]) assert(!masked.includes(secret),`alert note leaks ${secret}: ${masked}`);
});

test('safe-named fields skip only name rules, never value or split checks',() => {
  const opaque='synthOpaqueValueZZ9q8w7e6r5t';
  const held='RegisteredSplitValue0123456789';registerSecret(held);
  for(const value of [{status:`Bearer ${opaque}`},{status:'Bearer',detail:opaque},{status:held.slice(0,15),detail:held.slice(15)}]) {
    for(const [sink,out] of [['output',JSON.stringify(redactOutput(value))],['log',JSON.stringify(redactLogEntry(value))],['json text',redactSinkText(JSON.stringify(value))]]) {
      assert(!out.includes(opaque)&&!out.includes(held.slice(15)),`${sink} leaks through a safe-named field: ${out}`);
    }
  }
  assert.deepEqual(redactOutput({status:'completed',kind:'assignment',request_id:'req-0123456789abcdef'}),{status:'completed',kind:'assignment',request_id:'req-0123456789abcdef'});
});

test('owner report fields are split-checked as one record',() => {
  const opaque='synthOpaqueValueZZ9q8w7e6r5t';
  const prepared=prepareOwnerReportArtifact({format:'dalan-owner-report',version:1,summary:'Bearer',result:opaque,progress:[{sequence:1,at:'2026-11-06T00:00:00Z',text:'started'}]});
  const text=ownerReportArtifactBytes(prepared).toString();
  assert(!text.includes(opaque),`owner report leaks a split credential: ${text}`);
});

test('object keys get the full text check in output and in the T3 audit',() => {
  const opaque='synthOpaqueValueZZ9q8w7e6r5t';
  assert(!JSON.stringify(redactOutput({[`Bearer ${opaque}`]:1})).includes(opaque),'output key leaks');
  const held='audit-key-registered-value-55';registerSecret(held);
  const db=new DatabaseSync(':memory:');initT3Audit(db);
  appendT3Audit(db,{call_id:'c1',tool:'t3_send',args_summary:'{}',text_sha256:null,text_preview:null,worker:'dot'},'subject','ok',{_audit_ids:{[held]:['thread-1'],threadIds:['thread-2']}});
  const row=JSON.stringify(db.prepare('SELECT t3_ids FROM t3_audit').get());
  assert(!row.includes(held),`audit key leaks: ${row}`);
  assert(row.includes('threadIds')&&row.includes('thread-2'),'plain audit keys stay readable');
});

test('a registered value encoded as %XX for every byte is masked',() => {
  const held='ABCDEF123456abcdef'.repeat(3)+'ABCDEF1234';registerSecret(held);
  for(const hex of [h=>h,h=>h.toUpperCase()]) {
    const encoded=[...Buffer.from(held)].map(b=>'%'+hex(b.toString(16).padStart(2,'0'))).join('');
    for(const out of [JSON.stringify(redactOutput({t:encoded})),JSON.stringify(redactLogEntry({t:encoded})),redactSinkText(encoded),safeDiagnostic(encoded,100000)]) assert(!out.includes(encoded.slice(0,24)),`percent-encoded value leaks: ${out.slice(0,80)}`);
  }
});

test('a BEGIN-less PEM body relayed at every chunk cut is masked',async() => {
  const {generateKeyPairSync}=await import('node:crypto');
  const key=generateKeyPairSync('rsa',{modulusLength:1024}).privateKey.export({type:'pkcs1',format:'pem'});
  const body=key.trim().split('\n').slice(1,-1);
  for(const text of [body.join('\n')+'\n',key]) {
    for(let i=0;i<=text.length;i+=7) {
      let out='';const relay=createLineMasker(chunk=>{out+=chunk;});
      relay(text.slice(0,i));relay(text.slice(i));relay('',true);
      for(const line of body) assert(!out.includes(line),`cut ${i} leaks ${line}`);
    }
  }
});

test('a single-line BEGIN-less body and a JSON-key body are masked at every chunk cut',async() => {
  const {generateKeyPairSync}=await import('node:crypto');
  const ed=generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'});
  const edBody=ed.trim().split('\n')[1];
  const edText=ed.replace(/^.*BEGIN.*\n/,'');
  const rsa=generateKeyPairSync('rsa',{modulusLength:1024}).privateKey.export({type:'pkcs1',format:'pem'});
  const rsaBody=rsa.trim().split('\n').slice(1,-1);
  const keyed=JSON.stringify({[rsaBody.join('\n')]:1})+'\n';
  for(const [text,lines] of [[edText,[edBody]],[keyed,rsaBody]]) {
    for(let i=0;i<=text.length;i++) {
      let out='';const relay=createLineMasker(chunk=>{out+=chunk;});
      relay(text.slice(0,i));relay(text.slice(i));relay('',true);
      for(const line of lines) assert(!out.includes(line),`cut ${i} leaks ${line}`);
    }
  }
  let plain='';const relay=createLineMasker(text=>{plain+=text;});
  relay(edBody+'\nnext line\n');relay('',true);
  assert.equal(plain,edBody+'\nnext line\n');
});

test('a secret registered after a submission worker starts is still refused',async() => {
  const {validateSubmissionAsync}=await import('../src/submission-policy.mjs');
  const late='late-registered-operator-value-9Xq';
  const assignment={schema_version:1,request_id:'req-worker-0002',brief:`deploy with ${late}`,inputs:[{revision:'abc'}],expected_output:'one result',execution_scope:'implementation'};
  const pending=validateSubmissionAsync(assignment,{worker:'dot'});
  registerSecret(late);
  await assert.rejects(pending,/hard sensitive content exclusion/);
});
