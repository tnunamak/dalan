#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DotBridgeAdapter } from './conformance/adapter-dot-bridge.mjs';

const questionNames=new Set(['ask_question','consume_answer']);
const encode=catalog=>JSON.stringify(catalog,null,1)+'\n';
const snapshot=async adapter=>{
  const call=async(method,params={})=>{
    const response=await fetch(`http://127.0.0.1:${adapter.port}/${adapter.secret}/mcp`,{
      method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${adapter.token('W1')}`},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(5000),
    });
    assert.equal(response.status,200);
    const reply=await response.json();assert(!reply.error,JSON.stringify(reply.error));return reply.result;
  };
  return {discover:await call('server/discover'),initialize:await call('initialize',{protocolVersion:'2025-11-25'}),tools:await call('tools/list'),events:await call('events/list')};
};
const adapters=[];
async function start(profile){
  const adapter=new DotBridgeAdapter({serverEnv:{DOT_BRIDGE_CATALOG_PROFILE:profile}});adapters.push(adapter);
  await adapter.init();await adapter.reset();return adapter;
}
try {
  // Undefined removes the adapter's test opt-in and exercises the service default.
  const stable=await start(undefined),stableCatalog=await snapshot(stable);
  assert(!stableCatalog.tools.tools.some(tool=>questionNames.has(tool.name)));
  const golden=JSON.parse(fs.readFileSync(new URL('./fixtures/catalog.golden.json',import.meta.url),'utf8'));
  // The OAuth fixture uses a 60-second configured lease maximum. All other fields
  // must match the frozen no-auth golden, including order and descriptions.
  for(const tool of golden.tools.tools){
    if(tool.name==='claim')tool.inputSchema.properties.lease_ms.maximum=60000;
    const read=['list_pending','get','list_files','read_file','workspace_result','list_tools','call_tool_read','t3_thread_list','t3_thread_read'].includes(tool.name);
    // External issuers advertise the legacy scope names, matching the protected-resource metadata and challenge.
    tool.securitySchemes=[{type:'oauth2',scopes:[read?'dot-bridge.read':'dot-bridge.work']}];
  }
  assert.equal(encode(stableCatalog),encode(golden),'default OAuth catalog diverged from stable profile');
  const before=JSON.stringify(stable.q('SELECT * FROM job_questions'));
  for(const name of questionNames){
    const response=await stable.mcp('W1',name,{request_id:'req_hidden_profile',claim_id:'hidden',question_id:'Q',...(name==='ask_question'?{text:'hidden'}:{})});
    assert.match(response.error,/unknown tool/);
  }
  assert.equal(JSON.stringify(stable.q('SELECT * FROM job_questions')),before);
  const explicit=await start('stable');assert.equal(encode(await snapshot(explicit)),encode(stableCatalog));
  const enabled=await start('questions-v1'),enabledCatalog=await snapshot(enabled);
  const strict=await start('protocol-v0'),strictCatalog=await snapshot(strict);
  assert(strictCatalog.tools.tools.some(tool=>tool.name==='renew_claim'));
  const priorProfile=structuredClone(strictCatalog);
  priorProfile.tools.tools=priorProfile.tools.tools.filter(tool=>tool.name!=='renew_claim');
  for(const tool of priorProfile.tools.tools) {
    for(const field of ['command_key','expected_revision','epoch']) delete tool.inputSchema.properties[field];
    if(tool.name==='artifact_chunk') delete tool.inputSchema.properties.size;
  }
  assert.equal(encode(priorProfile),encode(enabledCatalog),'protocol profile changed an existing definition beyond command fields');
  const hiddenRenew=await stable.mcp('W1','renew_claim',{request_id:'req_hidden_profile',claim_id:'hidden',lease_ms:100});
  assert.match(hiddenRenew.error,/unknown tool/);
  for(const adapter of [stable,enabled]) {
    const denied=await adapter.admin('POST','/submit',{
      assignment:{schema_version:1,request_id:'req_protocol_hidden',brief:'strict profile admission',inputs:[],expected_output:'none',execution_scope:'read-only',protocol:{profile:'job-v0',source:'git:base',scope:'read:fixture',policy:'P0',destination:'owner-inbox',retain_until_ms:Date.now()+60000}},
      delivery:'none',owner_token:'fixture-owner',
    });
    assert.match(denied.error,/protocol jobs require DALAN_CATALOG_PROFILE=protocol-v0/);
    assert.equal(adapter.q1('SELECT count(*) n FROM assignments WHERE request_id=?','req_protocol_hidden').n,0);
  }
  assert.deepEqual(enabledCatalog.tools.tools.filter(tool=>questionNames.has(tool.name)).map(tool=>tool.name),[...questionNames]);
  enabledCatalog.tools.tools=enabledCatalog.tools.tools.filter(tool=>!questionNames.has(tool.name));
  assert.equal(encode(enabledCatalog),encode(stableCatalog),'opt-in changed an existing definition');
  const id=enabled.requestId('profile_enabled'),owner=enabled.ownerToken('profile_enabled');
  let response=await enabled.admin('POST','/submit',{assignment:{schema_version:1,request_id:id,brief:'profile test',inputs:[],expected_output:'one answer',execution_scope:'read-only'},delivery:'none',owner_token:owner});assert(response.value);
  const grant=(await enabled.mcp('W1','claim',{request_id:id,claimant:'W1'})).value;assert(grant);
  response=await enabled.mcp('W1','ask_question',{request_id:id,claim_id:grant.claim_id,question_id:'Q',text:'Which?'});assert(response.value);
  response=await enabled.admin('POST','/answer',{id,question_id:'Q',text:'A'},owner);assert(response.value);
  response=await enabled.mcp('W1','consume_answer',{request_id:id,claim_id:grant.claim_id,question_id:'Q'});assert.equal(response.value.answer,'A');
  const invalid=new DotBridgeAdapter({serverEnv:{DOT_BRIDGE_CATALOG_PROFILE:'question-typo'}});adapters.push(invalid);await invalid.init();
  await assert.rejects(invalid.reset(),/DALAN_CATALOG_PROFILE must be stable, questions-v1 or protocol-v0/);
  assert.equal(fs.existsSync(invalid.home+'/.local/share/dot-bridge/bridge.db'),false,'invalid profile opened the Store');
  console.log('PASS stable and questions catalogs, protocol-only command fields and renew, strict admission gate, direct-call refusal, native question flow and invalid profile refusal');
} finally {for(const adapter of adapters.reverse())await adapter.close();}
