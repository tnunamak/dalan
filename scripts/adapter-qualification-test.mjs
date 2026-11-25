#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {sign} from 'node:crypto';
import {DotBridgeAdapter} from './conformance/adapter-dot-bridge.mjs';
import {parseWorkers} from '../src/workers.mjs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

// Validate the actual shipped schema, not a parallel hand-written predicate.
function testQualificationSchema() {
  const readJSON = relative => JSON.parse(fs.readFileSync(new URL(relative, import.meta.url), 'utf8'));
  const ajv = new Ajv2020({allErrors:true});
  addFormats(ajv);
  const validate = ajv.compile(readJSON('../contracts/adapter-qualification.schema.json'));
  for (const name of ['protocol-v0', 'mcp']) {
    assert.equal(validate(readJSON('../qualification/' + name + '.json')), true,
      name + ': ' + JSON.stringify(validate.errors));
  }
  const fixture = {
    schema_version:1,
    record_kind:'draft_internal_qualification_record_not_wire_protocol',
    adapter_id:'synthetic',
    observed_on:'2026-11-15',
    pins:{dalan_commit:'fixture-commit', requester_ref:'fixture-requester',
      worker_host_ref:'fixture-worker', protocol:'fixture-protocol',
      sdk:null, catalog_fingerprint:'fixture-catalog'},
    roles:['worker'], continuity:'unknown', activation:'unknown',
    capabilities:[{name:'synthetic-capability', declared:'yes', observed:'passed', required:true}],
    qualification:{state:'passed_for_declared_scope', evidence_level:'deterministic_component', run_refs:['fixture-run']},
    limits:['Synthetic schema fixture only; not qualification evidence.'],
  };
  const check = (label, mutate, expected) => {
    const record = structuredClone(fixture);
    mutate(record);
    assert.equal(validate(record), expected, label + ': ' + JSON.stringify(validate.errors));
  };
  check('valid synthetic passed record', () => {}, true);
  for (const pin of ['dalan_commit', 'requester_ref', 'worker_host_ref', 'protocol']) {
    for (const value of [null, '']) {
      check(pin + ' rejects ' + JSON.stringify(value), r => { r.pins[pin] = value; }, false);
    }
    check(pin + ' must be present', r => { delete r.pins[pin]; }, false);
  }
  check('unknown pin rejected', r => { r.pins.extra = 'fixture'; }, false);
  for (const value of [null, '']) {
    check('passed requires catalog fingerprint', r => { r.pins.catalog_fingerprint = value; }, false);
  }
  check('sdk string accepted', r => { r.pins.sdk = 'fixture-sdk'; }, true);
  check('sdk number rejected', r => { r.pins.sdk = 1; }, false);
  for (const observed of ['failed', 'not_tested', 'blocked', 'inconclusive']) {
    check('required capability must pass: ' + observed, r => { r.capabilities[0].observed = observed; }, false);
    check('optional capability need not pass: ' + observed, r => {
      r.capabilities[0].required = false; r.capabilities[0].observed = observed;
    }, true);
  }
  check('passed requires at least one run reference', r => { r.qualification.run_refs = []; }, false);
  check('not-run may lack evidence', r => {
    r.qualification.state = 'not_run'; r.qualification.run_refs = [];
    r.pins.catalog_fingerprint = null; r.capabilities[0].observed = 'not_tested';
  }, true);
  for (const date of ['2026-1-15', '2026-11-5', '2026/11/15', '2026-02-30']) {
    check('invalid observed_on: ' + date, r => { r.observed_on = date; }, false);
  }
}
testQualificationSchema();

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
