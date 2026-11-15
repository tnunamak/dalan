#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {sign} from 'node:crypto';
import {DotBridgeAdapter} from './conformance/adapter-dot-bridge.mjs';
import {parseWorkers} from '../src/workers.mjs';

const adapter=new DotBridgeAdapter();
// Profile connections pin a client as well as a subject; sign the fixture tokens with that same client.
const originalToken=adapter.token.bind(adapter);
adapter.token=subject=>{
  const [header,payload]=originalToken(subject).split('.');
  const claims={...JSON.parse(Buffer.from(payload,'base64url').toString()),azp:'fixture'};
  const input=header+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url');
  return input+'.'+sign('RSA-SHA256',Buffer.from(input),adapter.privateKey).toString('base64url');
};
try {
  await adapter.init();await adapter.reset();await adapter.killServer();
  const connection=subject=>[{issuer:`http://127.0.0.1:${adapter.jwksPort}/realms/fake`,subject,client_id:'fixture'}];
  const profile={workers:{qualified:{adapter:'protocol-v0',connections:connection('W1')},plain:{connections:connection('W2')},unqualified:{adapter:'mcp',connections:connection('W3')}}};
  fs.writeFileSync(path.join(adapter.home,'.config/dot-bridge/workers.json'),JSON.stringify(profile),{mode:0o600});
  await adapter.startServer({DALAN_LEGACY_PROFILE:'0'});
  for(const execution of ['none','worker'])for(const worker of ['qualified','plain','unqualified']) {
    const id=`qualification_${execution}_${worker}`;
    const body={assignment:{schema_version:1,request_id:id,brief:'Answer the fixture question',inputs:[],expected_output:'answer',execution_scope:'read-only'},delivery:'none',owner_token:'qualification-owner',worker,execution,required_capabilities:['identified_questions']};
    const result=await adapter.admin('POST','/submit',body);
    const rows=adapter.q('SELECT request_id,required_capabilities FROM assignments WHERE request_id=?',id);
    if(worker==='qualified') {
      assert(result.value,JSON.stringify(result));assert.equal(rows.length,1);
      assert.deepEqual(JSON.parse(rows[0].required_capabilities),['identified_questions']);
      assert((await adapter.admin('POST','/submit',body)).value,'identical retry');
      assert.equal(adapter.q('SELECT count(*) n FROM assignments WHERE request_id=?',id)[0].n,1,'retry stores one assignment');
      const grant=(await adapter.mcp('W1','claim',{request_id:id,claimant:'qualified-fixture',acquisition_id:'first',lease_ms:100})).value;
      assert(grant,'the declared worker authenticates and claims its qualified job');
      const args={request_id:id,claim_id:grant.claim_id};
      assert((await adapter.mcp('W1','ask_question',{...args,question_id:'Q',text:'Which answer?'})).value);
      assert((await adapter.admin('POST','/answer',{id,question_id:'Q',text:'Answer A'},'qualification-owner')).value);
      assert.equal((await adapter.mcp('W1','consume_answer',{...args,question_id:'Q'})).value?.answer,'Answer A');
      assert((await adapter.mcp('W1','finish',{...args,outcome:'completed',summary:'answered',result:'Answer A'})).value);
      assert.equal(adapter.q('SELECT status FROM assignments WHERE request_id=?',id)[0].status,'finished');
    } else {
      assert.match(result.error,/capability_not_available: identified_questions/);
      assert.equal(rows.length,0,'refusal must precede assignment INSERT');
      for(const table of ['claims','owner_submit_commands','lifecycle_events','notifications'])assert.equal(adapter.q(`SELECT count(*) n FROM ${table} WHERE request_id=?`,id)[0].n,0,table);
    }
  }
  const refused=await adapter.admin('POST','/submit',{assignment:{schema_version:1,request_id:'qualification_all_required',brief:'All capabilities must hold',inputs:[],expected_output:'answer',execution_scope:'read-only'},delivery:'none',owner_token:'qualification-owner',worker:'qualified',execution:'worker',required_capabilities:['identified_questions','private_loopback']});
  assert.match(refused.error,/capability_not_available: private_loopback/);
  assert.equal(adapter.q('SELECT count(*) n FROM assignments WHERE request_id=?','qualification_all_required')[0].n,0);
  await adapter.killServer();await adapter.startServer({DALAN_LEGACY_PROFILE:'0',DOT_BRIDGE_CATALOG_PROFILE:'stable'});
  const wrongCatalog=await adapter.admin('POST','/submit',{assignment:{schema_version:1,request_id:'qualification_wrong_catalog',brief:'Question fixture',inputs:[],expected_output:'answer',execution_scope:'read-only'},delivery:'none',owner_token:'qualification-owner',worker:'qualified',execution:'worker',required_capabilities:['identified_questions']});
  assert.match(wrongCatalog.error,/capability_not_available: identified_questions/);
  assert.equal(adapter.q('SELECT count(*) n FROM assignments WHERE request_id=?','qualification_wrong_catalog')[0].n,0);
  for(const value of ['',' ',null,{},[],1,'Protocol-v0','../protocol-v0','unknown','toString'])assert.throws(()=>parseWorkers({workers:{w:{adapter:value}}},{builtin:true}),/adapter/);
  assert.throws(()=>parseWorkers({workers:{w:{route:'protocol-v0'}}},{builtin:true}),/expected object/);
  console.log('adapter-qualification-test: PASS (real submit, verified/unqualified/absent adapters, no refusal rows, retry, authenticated question/answer/finish)');
} finally {await adapter.close();}
