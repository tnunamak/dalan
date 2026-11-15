#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { DotBridgeAdapter } from './conformance/adapter-dot-bridge.mjs';

const a=new DotBridgeAdapter();
const payload=id=>({schema_version:1,request_id:id,brief:'relationship lifetime',inputs:[],expected_output:'answer',execution_scope:'read-only'});
const cli=(...args)=>{const p=spawnSync(process.execPath,['bin/dot-worker.mjs',...args,'--json'],{env:{...process.env,HOME:a.home},encoding:'utf8'});assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);};
async function submit(id,cap,relationship_id){return a.admin('POST','/submit',{assignment:payload(id),delivery:'none',owner_token:cap,...(relationship_id?{relationship_id}:{})});}
try {
  await a.init();await a.reset();
  const db=new DatabaseSync(a.dbFile);
  db.prepare("INSERT INTO relationships(relationship_id,my_roles,counterpart_ref,pattern,continuity,onward,created_at) VALUES(?,?,?,?,?,?,?)").run('rel_fixture','["requester"]','dot','outbound_only','unknown','none',new Date().toISOString());
  db.prepare("INSERT INTO registered_tools(name,description,input_schema,class,handler,schema_hash,created_at) VALUES('fixture','fixture','{}','read','fixture','hash',?)").run(new Date().toISOString());
  db.prepare("INSERT INTO tool_grants(tool,worker,granted_at) VALUES('fixture','dot',?)").run(new Date().toISOString());
  db.close();
  const running=a.requestId('rel_running'), cap=a.ownerToken('rel_running');
  assert((await submit(running,cap)).value);
  const claim=(await a.mcp('W1','claim',{request_id:running,claimant:'W1',acquisition_id:'first',lease_ms:60000})).value;assert(claim);
  assert((await a.mcp('W1','ask_question',{request_id:running,claim_id:claim.claim_id,question_id:'Q',text:'Continue?'})).value);
  const completed=a.requestId('rel_completed'), cap2=a.ownerToken('rel_completed');assert((await submit(completed,cap2)).value);
  const claim2=(await a.mcp('W1','claim',{request_id:completed,claimant:'W1',acquisition_id:'second',lease_ms:60000})).value;assert(claim2);
  assert((await a.mcp('W1','finish',{request_id:completed,claim_id:claim2.claim_id,outcome:'completed',summary:'done',result:'preserved'})).value);
  cli('relationships','end','rel_fixture');
  const receipts=()=>JSON.stringify(['assignments','job_questions','reports'].map(t=>a.q(`SELECT * FROM ${t} WHERE request_id IN (?,?) ORDER BY rowid`,running,completed)));
  const before=receipts();
  assert.match((await submit(a.requestId('rel_after'),a.ownerToken('rel_after'))).error,/relationship_ended/);
  assert.match((await submit(a.requestId('rel_explicit'),a.ownerToken('rel_explicit'),'rel_fixture')).error,/relationship_ended/);
  const preview=await a.admin('POST','/submit-preview',{assignment:payload(a.requestId('rel_preview')),delivery:'none',owner_token:a.ownerToken('rel_preview')});
  assert.notEqual(preview.value?.verdict,'admissible');assert.match(JSON.stringify(preview),/relationship_ended/);
  assert.equal((await submit(running,cap)).value.duplicate,true);
  assert.equal(receipts(),before);
  await a.control({op:'restart'});
  assert.match((await submit(a.requestId('rel_restart'),a.ownerToken('rel_restart'))).error,/relationship_ended/);
  assert.equal(receipts(),before);
  assert(cli('relationships','list').relationships.some(r=>r.relationship_id==='rel_fixture'&&r.ended_at));
  const grants=cli('grants');assert(grants.relationships.some(r=>r.relationship_id==='rel_fixture'&&r.ended_at));
  assert(grants.grants.some(g=>g.enforcer==='claim_lease'&&g.request_id===running&&g.expires_at));
  assert(grants.grants.some(g=>g.enforcer==='tool_registry'&&g.tool==='fixture'&&g.expires_at===null));
  assert(grants.grants.some(g=>g.enforcer==='owner_capability'&&g.request_id===running&&g.relationship_id==='rel_fixture'));
  assert((await a.admin('POST','/answer',{id:running,question_id:'Q',text:'yes'},cap)).value);
  assert.equal((await a.mcp('W1','consume_answer',{request_id:running,claim_id:claim.claim_id,question_id:'Q'})).value.answer,'yes');
  assert((await a.mcp('W1','finish',{request_id:running,claim_id:claim.claim_id,outcome:'completed',summary:'done',result:'after end'})).value);
  fs.writeFileSync(path.join(a.home,'.config/dot-bridge/workers.json'),JSON.stringify({workers:{dot:{connections:[{issuer:'fixture',subject:'W1',client_id:'fixture'}],repos:[]},other:{connections:[{issuer:'fixture',subject:'W2',client_id:'fixture'}],repos:[]}}}),{mode:0o600});
  cli('worker','allow','dot','example/repo');
  assert.equal(a.q('SELECT count(*) AS n FROM relationships WHERE counterpart_ref=?','dot')[0].n,1);
  assert(a.q('SELECT ended_at FROM relationships WHERE relationship_id=?','rel_fixture')[0].ended_at);
  cli('worker','allow','other','example/repo');
  const other=a.q('SELECT * FROM relationships WHERE counterpart_ref=?','other')[0];
  assert.equal(other.pattern,'outbound_only');assert.equal(other.ended_at,null);
  cli('relationships','end',other.relationship_id);
  await a.control({op:'restart'});
  assert(a.q('SELECT ended_at FROM relationships WHERE relationship_id=?',other.relationship_id)[0].ended_at);
  console.log('PASS relationship end fences new work while jobs, questions and results survive restart',before);
} finally {await a.close();}
