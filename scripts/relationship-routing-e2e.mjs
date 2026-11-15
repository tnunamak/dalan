#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {sign,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {DotBridgeAdapter} from './conformance/adapter-dot-bridge.mjs';
import {routingPolicy} from '../src/pull-queue.mjs';
import {normalizeMeta} from '../src/objectives.mjs';
import {renderAssignment} from '../src/submission-policy.mjs';
const a=new DotBridgeAdapter({serverEnv:{DOT_BRIDGE_CATALOG_PROFILE:'stable'}});
try {
  await a.init();await a.reset();await a.killServer();
  const workers={workers:Object.fromEntries(['W1','W2'].map((subject,i)=>[['alpha','beta'][i],{connections:[{issuer:`http://127.0.0.1:${a.jwksPort}/realms/fake`,subject,client_id:'pull-test'}],repos:[]}]))};
  fs.writeFileSync(path.join(a.home,'.config/dot-bridge/workers.json'),JSON.stringify(workers),{mode:0o600});
  a.token=subject=>{const head=Buffer.from(JSON.stringify({alg:'RS256',kid:'conf',typ:'JWT'})).toString('base64url'),body=Buffer.from(JSON.stringify({iss:`http://127.0.0.1:${a.jwksPort}/realms/fake`,aud:'https://dot-bridge.example.test',exp:Math.floor(Date.now()/1000)+3600,sub:subject,azp:'pull-test',scope:'dot-bridge.read dot-bridge.work'})).toString('base64url'),input=`${head}.${body}`;return `${input}.${sign('RSA-SHA256',Buffer.from(input),a.privateKey).toString('base64url')}`;};
  await a.startServer();
  const body=id=>({assignment:{schema_version:1,request_id:id,brief:'routed relationship',inputs:[],expected_output:'answer',execution_scope:'read-only'},routing:{version:1,allowed_workers:['alpha','beta'],deadline_at:new Date(a.baseMs+3600000).toISOString()},owner_token:'owner-token-fixture',delivery:'none',execution:'worker'});
  const initial=body('req_routed_before');assert((await a.admin('POST','/submit',initial)).value);
  // Persist the exact pre-migration intent shape, which contains no relationships map.
  const legacy=body('req_routed_legacy'),identity=renderAssignment(legacy.assignment),routing=routingPolicy(legacy.routing,identity);
  const options={delivery:{mode:'none',threadId:null},environmentId:'',execution:'worker',review:false,priority:'normal',meta:normalizeMeta(undefined)};
  const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
  const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const db=new DatabaseSync(a.dbFile);
  db.prepare('INSERT INTO policy_work_orders(work_order_id,request_id,intent_digest,owner_hash,payload,options,routing,approvals,created_at,priority) VALUES(?,?,?,?,?,?,?,?,?,?)').run('work_legacy',identity.request_id,digest(canonical({identity,options,routing,approvals:{}})),createHash('sha256').update(legacy.owner_token).digest('hex'),JSON.stringify(identity),JSON.stringify(options),JSON.stringify(routing),'{}',new Date(a.baseMs).toISOString(),'normal');db.close();
  const rel=a.q("SELECT relationship_id FROM relationships WHERE counterpart_ref='alpha'")[0].relationship_id;
  assert.equal(JSON.parse(a.q('SELECT options FROM policy_work_orders WHERE request_id=?',initial.assignment.request_id)[0].options).relationships.alpha,rel);
  const p=spawnSync(process.execPath,['bin/dot-worker.mjs','relationships','end',rel,'--json'],{env:{...process.env,HOME:a.home},encoding:'utf8'});assert.equal(p.status,0,p.stderr);
  await a.control({op:'restart'});
  assert.equal((await a.admin('POST','/submit',initial)).value.duplicate,true);
  assert.equal((await a.admin('POST','/submit',legacy)).value.duplicate,true);
  const denied=body('req_routed_after');assert.match((await a.admin('POST','/submit',denied)).error,/relationship_ended/);
  assert.equal(a.q('SELECT count(*) n FROM policy_work_orders WHERE request_id=?',denied.assignment.request_id)[0].n,0);
  const preview=await a.admin('POST','/submit-preview',{...denied,assignment:{...denied.assignment,request_id:'req_routed_preview'}});assert.notEqual(preview.value?.verdict,'admissible');
  assert.match((await a.admin('POST','/submit',{...body('req_routed_explicit'),relationship_id:rel})).error,/routing/);
  const claim=await a.mcp('W1','claim',{request_id:initial.assignment.request_id,claimant:'W1',acquisition_id:'after-end'});assert(claim.value,JSON.stringify(claim));
  assert.equal(a.q('SELECT relationship_id FROM assignments WHERE request_id=?',initial.assignment.request_id)[0].relationship_id,rel);
  const legacyClaim=await a.mcp('W1','claim',{request_id:legacy.assignment.request_id,claimant:'W1',acquisition_id:'legacy-after-end'});assert(legacyClaim.value,JSON.stringify(legacyClaim));
  assert.equal(a.q('SELECT relationship_id FROM assignments WHERE request_id=?',legacy.assignment.request_id)[0].relationship_id,null);
  console.log('PASS routed work admission fenced and pre-end work acquired after end');
} finally {await a.close();}
