#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { DotBridgeAdapter } from './conformance/adapter-dot-bridge.mjs';

const root=fs.mkdtempSync(path.join(process.env.DOT_BRIDGE_TEST_TMP??os.tmpdir(),'qp-'));
const file=path.join(root,'state.db');let now=100000;
const store=new Store(file,{now:()=>now,limits:{leaseMs:1000}});
const adapter=new DotBridgeAdapter();adapter.dbFile=file;
const job=id=>{
  store.submit({schema_version:1,request_id:id,brief:'mixed question projection',inputs:[],expected_output:'answer',execution_scope:'read-only'},{mode:'none'},null,'owner');
  return store.claim(id,'worker','subject',100);
};
const identified=(id,grant)=>{
  store.askQuestion(id,grant.claim_id,'Q','identified question','subject');
  store.answerQuestion(id,'Q','identified answer');
  store.consumeAnswer(id,grant.claim_id,'Q','subject');
};
try {
  const later=job('later');identified('later',later);
  assert.equal(adapter.deriveState('later'),'running','consumed identified question alone must not remain waiting');
  now++;store.progress('later',later.claim_id,'QUESTION: Which second option?','subject');
  assert.equal(adapter.deriveState('later'),'awaiting_input','later native legacy waiting must survive identified consumption');
  now++;store.note('later','legacy answer');
  assert.equal(adapter.deriveState('later'),'running');

  const earlier=job('earlier');store.progress('earlier',earlier.claim_id,'QUESTION: legacy first','subject');
  now++;identified('earlier',earlier);
  assert.equal(adapter.deriveState('earlier'),'awaiting_input','identified consumption cannot answer an independent legacy question');
  now++;store.note('earlier','legacy answer');
  assert.equal(adapter.deriveState('earlier'),'running');
  console.log('PASS identified-only consumption, both legacy question orders and ordinary owner-note resolution project native facts');
} finally {store.db.close();fs.rmSync(root,{recursive:true,force:true});}
