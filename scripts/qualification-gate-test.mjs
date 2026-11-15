#!/usr/bin/env node
// Qualification declarations must match fresh passing observations, not just evidence file names.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {CAPABILITY_NAMES,ADAPTER_CAPABILITY_NAMES,ADAPTER_QUALIFICATIONS} from '../src/execution.mjs';

const root=new URL('..',import.meta.url);
const ajv=new Ajv({allErrors:true});addFormats(ajv);
const validate=ajv.compile(JSON.parse(fs.readFileSync(new URL('contracts/adapter-qualification.schema.json',root),'utf8')));
const names=[...CAPABILITY_NAMES,...ADAPTER_CAPABILITY_NAMES].sort();
function gate(record,observations) {
  assert(validate(record),JSON.stringify(validate.errors));
  assert.deepEqual(record.capabilities.map(c=>c.name).sort(),names,'capability vocabulary must be exact and unique');
  for(const capability of record.capabilities) {
    if(capability.declared==='unknown') {
      assert.equal(capability.observed,'not_tested','unknown capabilities must not imply an observation');
      continue;
    }
    assert.equal(capability.observed,'passed',`${record.adapter_id}/${capability.name}: no passing observation`);
    const measured=observations.find(o=>o.adapter===record.adapter_id&&o.name===capability.name);
    assert(measured,`${record.adapter_id}/${capability.name}: no passing observation`);
    assert.equal(measured.status,0,'probe suite must pass');
    assert.equal(measured.declared,capability.declared,'declaration differs from observation');
    assert(capability.evidence_refs?.includes(measured.script),'capability evidence must bind the probe');
    assert(record.qualification.run_refs.includes(measured.script),'qualification must bind the probe');
    assert.equal(record.qualification.state,'passed_for_declared_scope');
  }
  // No native session or activation is qualified by a protocol fixture.
  assert.equal(record.continuity,'unknown');assert.equal(record.activation,'unknown');
}
const records=Object.keys(ADAPTER_QUALIFICATIONS).map(id=>{
  const record=JSON.parse(fs.readFileSync(new URL(`qualification/${id}.json`,root),'utf8'));
  assert.equal(record.adapter_id,id);
  const runtime=ADAPTER_QUALIFICATIONS[id].capabilities;
  assert(Object.keys(runtime).every(name=>names.includes(name)),'runtime vocabulary');
  for(const capability of record.capabilities) {
    const state=capability.declared==='yes'&&capability.observed==='passed'?'verified':capability.declared==='no'&&capability.observed==='passed'?'unsupported':'unknown';
    assert.equal(runtime[capability.name]??'unknown',state,'runtime declaration differs from committed qualification');
  }
  return record;
});
assert.deepEqual(fs.readdirSync(new URL('qualification/',root)).filter(f=>f.endsWith('.json')).sort(),records.map(r=>r.adapter_id+'.json').sort(),'every committed adapter must be registered');
const protocol=records.find(r=>r.adapter_id==='protocol-v0');
const observation={adapter:'protocol-v0',name:'identified_questions',declared:'yes',status:0,script:'scripts/question-lifecycle-http-e2e.mjs'};
gate(protocol,[observation]);
assert.throws(()=>gate(protocol,[]),/no passing observation/);
assert.throws(()=>gate(protocol,[{...observation,status:1}]),/probe suite must pass/);
assert.throws(()=>gate(protocol,[{...observation,declared:'no'}]),/declaration differs/);
assert.throws(()=>gate(protocol,[{...observation,adapter:'mcp'}]),/no passing observation/);
const duplicate=structuredClone(protocol);duplicate.capabilities.push(duplicate.capabilities[0]);
assert.throws(()=>gate(duplicate,[observation]),/exact and unique/);
for(const change of [{observed:'failed'},{observed:'not_tested'},{evidence_refs:[]}]) {
  const changed=structuredClone(protocol);Object.assign(changed.capabilities.find(c=>c.name==='identified_questions'),change);
  assert.throws(()=>gate(changed,[observation]),/no passing observation|evidence must bind/);
}
const unsupported=structuredClone(protocol);unsupported.capabilities.find(c=>c.name==='identified_questions').declared='no';
assert.throws(()=>gate(unsupported,[]),/no passing observation/,'negative declarations also require observations');
const result=spawnSync(process.execPath,[observation.script],{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
assert.equal(result.status,0,`${observation.script} failed:\n${result.stdout}\n${result.stderr}`);
for(const record of records)gate(record,[{...observation,status:result.status}]);
console.log('qualification-gate-test: PASS (schema, exact vocabulary, fresh real-Store question observation, missing/failed/mismatched evidence rejected)');
