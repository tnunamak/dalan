#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DotBridgeAdapter } from './conformance/adapter-dot-bridge.mjs';

const adapter=new DotBridgeAdapter();
const payload=id=>({schema_version:1,request_id:id,brief:'question HTTP fixture',inputs:[],expected_output:'one answer',execution_scope:'read-only'});
const tool=(worker,name,id,grant,extra={})=>adapter.mcp(worker,name,{request_id:id,claim_id:grant.claim_id,...extra});
async function job(name) {
  const id=adapter.requestId(name),cap=adapter.ownerToken(name);
  const result=await adapter.admin('POST','/submit',{assignment:payload(id),delivery:'none',owner_token:cap});assert(result.value,JSON.stringify(result));
  const grant=(await adapter.mcp('W1','claim',{request_id:id,claimant:'W1',acquisition_id:'first',lease_ms:100})).value;assert(grant);
  return {id,cap,grant};
}
const noMutation=(id)=>JSON.stringify(['job_questions','reports','lifecycle_events','notifications'].map(table=>adapter.q(`SELECT * FROM ${table} WHERE request_id=? ORDER BY rowid`,id)));
try {
  await adapter.init(); await adapter.reset();
  const {id,cap,grant}=await job('question_http');
  let result=await tool('W1','ask_question',id,grant,{question_id:'Q',text:'Which option?'});assert(result.value);
  assert.equal(adapter.q('SELECT count(*) n FROM job_questions WHERE request_id=?',id)[0].n,1);
  result=await adapter.mcp('W1','get',{request_id:id});assert.equal(result.value.questions[0].question_id,'Q');assert(!('claim_id' in result.value.questions[0]));assert(!('subject' in result.value.questions[0]));
  const before=noMutation(id);
  result=await adapter.admin('POST','/answer',{id,question_id:'Q',text:'wrong capability'},'incorrect');assert.match(result.error,/invalid owner capability/);assert.equal(noMutation(id),before);
  result=await adapter.admin('POST','/answer',{id,question_id:'absent',text:'missing'},cap);assert.match(result.error,/NO_QUESTION/);assert.equal(noMutation(id),before);
  result=await adapter.admin('POST','/note',{id,text:'ordinary note'},cap);assert(result.value);
  result=await tool('W1','consume_answer',id,grant,{question_id:'Q'});assert.match(result.error,/NO_ANSWER/);
  result=await tool('W1','finish',id,grant,{outcome:'completed',summary:'premature',result:'no answer'});assert.match(result.error,/QUESTION_OPEN/);assert.equal(adapter.q('SELECT count(*) n FROM reports WHERE request_id=?',id)[0].n,0);
  result=await adapter.admin('POST','/answer',{id,question_id:'Q',text:'Option A'},cap);assert(result.value);
  const answered=noMutation(id);result=await adapter.admin('POST','/answer',{id,question_id:'Q',text:'Option B'},cap);assert.match(result.error,/ALREADY_ANSWERED/);assert.equal(noMutation(id),answered);
  result=await tool('W2','consume_answer',id,grant,{question_id:'Q'});assert.match(result.error,/invalid claim|claim_superseded/);assert.equal(noMutation(id),answered);
  await adapter.control({op:'restart'});
  result=await tool('W1','consume_answer',id,grant,{question_id:'Q'});assert.equal(result.value.answer,'Option A');
  result=await tool('W1','finish',id,grant,{outcome:'completed',summary:'done',result:'Option A'});assert(result.value);
  const finishedBefore=noMutation(id);result=await tool('W1','consume_answer',id,grant,{question_id:'Q'});assert.match(result.error,/TERMINAL/);assert.equal(noMutation(id),finishedBefore);
  console.log('PASS actual HTTP question/answer/consume, owner capability, note separation, finish guard, foreign subject and restart');

  const stale=await job('question_stale');await tool('W1','ask_question',stale.id,stale.grant,{question_id:'Q',text:'old question'});
  await adapter.control({op:'advance',to:100});
  const next=(await adapter.mcp('W2','claim',{request_id:stale.id,claimant:'W2',acquisition_id:'second',lease_ms:100})).value;assert.equal(next.epoch,2);
  const regrantBefore=noMutation(stale.id);result=await tool('W2','consume_answer',stale.id,next,{question_id:'Q'});assert.match(result.error,/STALE_EPOCH/);assert.equal(noMutation(stale.id),regrantBefore);
  const staleBefore=noMutation(stale.id);result=await adapter.admin('POST','/answer',{id:stale.id,question_id:'Q',text:'late'},stale.cap);assert.match(result.error,/STALE_EPOCH/);assert.equal(noMutation(stale.id),staleBefore);
  result=await tool('W1','consume_answer',stale.id,stale.grant,{question_id:'Q'});assert.match(result.error,/invalid claim|claim_superseded/);assert.equal(noMutation(stale.id),staleBefore);
  result=await tool('W2','ask_question',stale.id,next,{question_id:'CURRENT',text:'new question'});assert(result.value);
  await adapter.admin('POST','/answer',{id:stale.id,question_id:'CURRENT',text:'current answer'},stale.cap);
  result=await tool('W2','consume_answer',stale.id,next,{question_id:'CURRENT'});assert.equal(result.value.answer,'current answer');
  result=await tool('W2','finish',stale.id,next,{outcome:'completed',summary:'done',result:'current answer'});assert(result.value);
  console.log('PASS old-epoch HTTP answer/consume rejected without mutation; current epoch still finishes');

  const cancelled=await job('question_cancel');await tool('W1','ask_question',cancelled.id,cancelled.grant,{question_id:'Q',text:'before cancellation'});
  await adapter.admin('POST','/answer',{id:cancelled.id,question_id:'Q',text:'answer before cancellation'},cancelled.cap);
  await adapter.admin('POST','/cancel',{id:cancelled.id},cancelled.cap);const cancelBefore=noMutation(cancelled.id);
  result=await tool('W1','consume_answer',cancelled.id,cancelled.grant,{question_id:'Q'});assert.match(result.error,/TERMINAL/);assert.equal(noMutation(cancelled.id),cancelBefore);
  result=await adapter.admin('POST','/answer',{id:cancelled.id,question_id:'Q',text:'late'},cancelled.cap);assert.match(result.error,/TERMINAL/);assert.equal(noMutation(cancelled.id),cancelBefore);
  console.log('PASS cancelled HTTP job cannot receive or consume an answer');
  for(const outcome of ['blocked','failed']) {
    const open=await job('open_'+outcome);await tool('W1','ask_question',open.id,open.grant,{question_id:'Q',text:'missing input'});
    result=await tool('W1','finish',open.id,open.grant,{outcome,summary:'cannot proceed',result:'missing answer'});assert(result.value);
    const audit=(await adapter.admin('GET','/questions?id='+open.id,undefined,open.cap)).value.questions[0];
    assert.equal(audit.answer,null);assert.equal(audit.answered_at,null);assert.equal(audit.consumed_at,null);
    const before=noMutation(open.id);result=await tool('W1','consume_answer',open.id,open.grant,{question_id:'Q'});assert.match(result.error,/TERMINAL/);assert.equal(noMutation(open.id),before);
  }
  console.log('PASS HTTP blocked/failed finish retains open owner-visible audit question and denies consumption');

  const cliId='req_question_cli';const file=path.join(adapter.home,'assignment.json');fs.writeFileSync(file,JSON.stringify(payload(cliId)));
  const cli=args=>{const p=spawnSync(process.execPath,['bin/dot-worker.mjs',...args],{cwd:path.resolve(new URL('..',import.meta.url).pathname),env:{...process.env,HOME:adapter.home},encoding:'utf8',timeout:30000});assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);};
  cli(['submit','--file',file,'--deliver','none','--json']);
  const cliGrant=(await adapter.mcp('W1','claim',{request_id:cliId,claimant:'W1',lease_ms:100})).value;
  await tool('W1','ask_question',cliId,cliGrant,{question_id:'CLI',text:'Owner CLI?'});
  assert.equal(cli(['questions',cliId,'--json']).questions[0].question_id,'CLI');
  assert.equal(cli(['answer',cliId,'CLI','CLI answer','--json']).answered,true);
  assert.equal((await tool('W1','consume_answer',cliId,cliGrant,{question_id:'CLI'})).value.answer,'CLI answer');
  console.log('PASS actual owner CLI question listing and capability-bound answer');
} finally {await adapter.close();}
