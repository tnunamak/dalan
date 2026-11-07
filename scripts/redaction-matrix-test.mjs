// One table: every output sink against every form a secret can take. Rows are sinks, columns are forms. Each cell
// must mask; the normal-text corpus must pass every sink unchanged. A cell that cannot apply is listed in NOT_APPLICABLE
// with the reason; there are no silent gaps.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {registerSecret,redactLogEntry} from '../src/redaction.mjs';
import {createLineMasker} from '../src/diagnostic.mjs';
import {callTool} from '../src/mcp-stdio.mjs';
import {validateSubmissionAsync} from '../src/submission-policy.mjs';

// Synthetic values only.
const CANARY='matrixCanaryValue_7f3K9q2LmX';
registerSecret(CANARY);
const OPAQUE='synthOpaqueBearerBody9q8w7e6r';
const GH='ghp_'+'M'.repeat(36);
const KEY=generateKeyPairSync('rsa',{modulusLength:1024}).privateKey.export({type:'pkcs1',format:'pem'});
const KEY_BODY=KEY.trim().split('\n').slice(1,-1);

// Each secret: the text to place, and the needles that must not appear in any output.
const SECRETS={
  canary:{text:CANARY,needles:[CANARY,CANARY.slice(14)],registered:true},
  ghp:{text:GH,needles:[GH.slice(0,14)]},
  bearer:{text:`Bearer ${OPAQUE}`,needles:[OPAQUE]},
  pem:{text:KEY,needles:KEY_BODY},
  // The same key body without its header and footer lines.
  pem_body:{text:KEY_BODY.join('\n'),needles:KEY_BODY},
};
const pct=text=>[...Buffer.from(text)].map(b=>'%'+b.toString(16).padStart(2,'0')).join('');
// Each form turns a secret into a value: a string, or a structured value for structured sinks. `parts` is a split.
const FORMS={
  raw:s=>({text:s.text}),
  percent:s=>({text:pct(s.text),needles:[pct(s.text).slice(0,24)]}),
  base64:s=>({text:Buffer.from(s.text).toString('base64'),needles:[Buffer.from(s.text).toString('base64').slice(0,20)]}),
  json_escaped:s=>({text:JSON.stringify(s.text).slice(1,-1)}),
  object_key:s=>({value:{[s.text]:1}}),
  safe_field:s=>({value:{status:s.text}}),
  split:s=>{const at=Math.ceil(s.text.length/2);return {parts:[s.text.slice(0,at),s.text.slice(at)],value:{status:s.text.slice(0,at),detail:s.text.slice(at)},needles:[s.text.slice(at)]};},
};

// Cells that cannot apply, with the reason. Key: `${sink}/${secret}/${form}` with * as a wildcard.
const NOT_APPLICABLE={
  '*/ghp/percent':'encoded variants exist only for registered values; an unregistered token is matched in plain form (survey: no decode pass)',
  '*/ghp/base64':'as above: base64 forms are derived only for registered values',
  '*/bearer/percent':'as above: an unregistered Bearer credential is matched in plain form only',
  '*/bearer/base64':'as above',
  '*/pem/percent':'key material is matched by armor and body format; encoded unregistered key material is out of scope',
  '*/pem/base64':'as above',
  '*/pem/object_key':'a multi-line key as a property name is not a realistic shape; property names get the same text policy as values',
  '*/pem_body/percent':'as for pem','*/pem_body/base64':'as for pem','*/pem_body/object_key':'as for pem',
  'http/pem_body/raw':'as for pem','http/pem_body/json_escaped':'as for pem','footer/pem_body/raw':'as for pem','footer/pem_body/json_escaped':'as for pem',
  '*/bearer/split':'for structured sinks the split is covered by the safe-field row ({status:"Bearer",detail}); here the halves cut the opaque body',
  'http/*/object_key':'the HTTP error reply carries text only; structured values pass redactOutput, covered by the stdio row',
  'http/*/safe_field':'as above',
  'http/*/split':'as above',
  'http/pem/raw':'a tool argument name cannot carry a multi-line key through the schema check; the crash and stdio rows cover key text',
  'http/pem/json_escaped':'as above',
  'crash/*/object_key':'a crash reply never carries input text: the generic message is fixed',
  'crash/*/safe_field':'as above',
  'crash/*/split':'as above',
  'worker/*/object_key':'intake renders the brief text; keys are covered by the stdio and log rows',
  'worker/*/safe_field':'as above',
  'worker/*/split':'as above',
  'worker/bearer/raw':'a Bearer label is medium precision: intake warns and output masks it (survey: refuse only strong formats and known values)',
  'worker/bearer/json_escaped':'as above',
  'footer/*/object_key':'the footer holds one request id string',
  'footer/*/safe_field':'as above',
  'footer/*/split':'as above',
  'footer/pem/raw':'a request id cannot hold a multi-line key',
  'footer/pem/json_escaped':'as above',
};
const notApplicable=(sink,secret,form)=>[`${sink}/${secret}/${form}`,`*/${secret}/${form}`,`${sink}/*/${form}`].map(k=>NOT_APPLICABLE[k]).find(Boolean);

// Fake admin socket for the stdio MCP server: answers every request with the current body.
let adminBody='{}';
const home=fs.mkdtempSync(path.join(os.homedir(),'.tmp/redaction-matrix-'));
const sockDir=path.join(home,'.local/share/dalan');fs.mkdirSync(sockDir,{recursive:true});
const admin=http.createServer((req,res)=>{req.resume();res.writeHead(200,{'content-type':'application/json'});res.end(adminBody);});
const stdio=async body=>{adminBody=JSON.stringify(body);const prev=process.env.HOME;process.env.HOME=home;try{return JSON.stringify(await callTool('dalan_status',{}));}finally{process.env.HOME=prev;}};

// The HTTP server, started once.
let server,port,pathSecret;
async function startServer() {
  const dir=path.join(home,'bridge');fs.mkdirSync(path.join(dir,'.config/dot-bridge'),{recursive:true});
  port=await (await import('../src/test-support/port.mjs')).reservedPort();
  server=spawn(process.execPath,['src/server.mjs'],{cwd:path.join(import.meta.dirname,'..'),stdio:['ignore','pipe','pipe'],
    env:{...process.env,HOME:dir,DALAN_LEGACY_PROFILE:'1',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_PORT:String(port),NODE_ENV:'test',DOT_BRIDGE_T3_DRY_RUN:'1',
      // The server registers credential-named environment values at startup, as the bridge does for its own.
      MATRIX_CANARY_TOKEN:CANARY}});
  let out='';server.stdout.on('data',c=>{out+=c;});server.stderr.on('data',()=>{});
  for(let i=0;i<200&&!out.includes('MCP listening');i++)await new Promise(r=>setTimeout(r,50));
  assert(out.includes('MCP listening'),'server did not start');
  pathSecret=fs.readFileSync(path.join(dir,'.config/dot-bridge/env'),'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
}
const httpReply=async name=>{
  const res=await fetch(`http://127.0.0.1:${port}/${pathSecret}/mcp`,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'list_pending',arguments:{[name]:1}}})});
  return JSON.stringify(await res.json());
};
const relay=chunks=>{let out='';const masker=createLineMasker(text=>{out+=text;});for(const c of chunks)masker(c);masker('',true);return out;};
const asText=cell=>cell.text??JSON.stringify(cell.value);

// Sinks. Each takes a cell and returns everything the sink emitted for it.
const SINKS={
  http:async cell=>httpReply(cell.text),
  stdio:async cell=>stdio({detail:cell.value??cell.text}),
  log:async cell=>JSON.stringify(redactLogEntry(cell.value??{detail:cell.text})),
  child_output:async cell=>{
    const text=`${asText(cell)}\n`;
    if(cell.parts) return relay(cell.parts);
    // Every chunk cut of the line, for streaming.
    let all='';for(let i=0;i<=text.length;i+=Math.max(1,Math.floor(text.length/40))) all+=relay([text.slice(0,i),text.slice(i)]);
    return all;
  },
  worker:async cell=>{
    const assignment={schema_version:1,request_id:'req-matrix-0001',brief:`deploy with ${cell.text}`,inputs:[{revision:'abc'}],expected_output:'one result',execution_scope:'implementation'};
    try {await validateSubmissionAsync(assignment,{worker:'dot'});return 'admitted';}
    catch(error) {return /hard sensitive content exclusion/.test(error.message)?'[refused]':`admitted: ${error.message}`;}
  },
  crash:async cell=>{
    const written=[];const write=process.stderr.write;
    process.stderr.write=chunk=>{written.push(String(chunk));return true;};
    let reply;
    try {reply=await callTool('dalan_status',new Proxy({},{ownKeys(){throw new Error(`boom ${cell.text}`);}}));}
    finally {process.stderr.write=write;}
    assert.match(reply.content[0].text,/^Error executing tool dalan_status \(error id [0-9a-f]{8}/,'crash reply must be the generic contract');
    return JSON.stringify(reply)+written.join('');
  },
  footer:async cell=>stdio({request_id:cell.text,report:'x'.repeat(40000)}),
};

test('redaction matrix: every sink masks every applicable form',async() => {
  await new Promise(r=>admin.listen(path.join(sockDir,'admin.sock'),r));
  await startServer();
  const cells=[],gaps=[];
  try {
    for(const [sink,run] of Object.entries(SINKS)) for(const [secretName,secret] of Object.entries(SECRETS)) for(const [formName,form] of Object.entries(FORMS)) {
      const reason=notApplicable(sink,secretName,formName);
      if(reason) {gaps.push(`${sink}/${secretName}/${formName}: ${reason}`);continue;}
      const cell=form(secret),needles=[...secret.needles,...(cell.needles??[])];
      const out=await run(cell);
      if(sink==='worker') assert.equal(out,'[refused]',`${sink}/${secretName}/${formName}: intake admitted the secret (${out})`);
      for(const needle of needles) assert(!out.includes(needle),`${sink}/${secretName}/${formName} leaks ${needle.slice(0,24)}: ${out.slice(0,300)}`);
      cells.push(`${sink}/${secretName}/${formName}`);
    }
  } finally {
    server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));
    await new Promise(r=>admin.close(r));
  }
  console.log(`matrix: ${cells.length} cells checked, ${gaps.length} not applicable`);
  assert(cells.length>=80,`too few cells: ${cells.length}`);
});

// The normal corpus: text that looks near a secret but is not one. Every sink returns it unchanged.
const NORMAL=['0123456789abcdef0123456789abcdef01234567','550e8400-e29b-41d4-a716-446655440000','token_count: 42','max_tokens: 4096',
  'password123 is weak','author: Ada','Authorization is required','https://github.com/acme/widgets.git','code=200','IntegrityHashBase64Like0123456789abcdefXYZ'];
// Not applicable here: the crash reply is generic by design, so input text never appears in it. The worker row is
// checked as admission: no normal text is refused as sensitive.

test('redaction matrix: normal text passes every sink unchanged',async() => {
  await new Promise(r=>admin.listen(path.join(sockDir,'admin.sock'),r));
  await startServer();
  try {
    for(const text of NORMAL) {
      assert((await httpReply(text)).includes(text),`http changes ${text}`);
      assert((await stdio({detail:text})).includes(JSON.stringify(text).slice(1,-1)),`stdio changes ${text}`);
      assert.equal(redactLogEntry({detail:text}).detail,text,`log changes ${text}`);
      assert.equal(relay([text.slice(0,5),text.slice(5)+'\n']),text+'\n',`child output changes ${text}`);
      assert.notEqual(await SINKS.worker({text}),'[refused]',`intake refuses ${text}`);
    }
    const footer=await stdio({request_id:'req-normal-0001',report:'x'.repeat(40000)});
    assert(footer.includes('dalan get req-normal-0001'),'footer changes a normal request id');
  } finally {
    server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));
    await new Promise(r=>admin.close(r));
    fs.rmSync(home,{recursive:true,force:true});
  }
});
