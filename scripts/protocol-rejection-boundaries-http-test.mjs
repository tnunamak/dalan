import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {sign} from 'node:crypto';
import {DotBridgeAdapter} from './conformance/adapter-dot-bridge.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'protocol-rejection-')),repo=path.join(root,'repo');
fs.mkdirSync(repo);
const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim();
git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
fs.writeFileSync(path.join(repo,'hello.txt'),'before\n');git('add','.');git('commit','-qm','base');
const base=git('rev-parse','HEAD');
const adapter=new DotBridgeAdapter({serverEnv:{DALAN_WORKERS_FILE:path.join(root,'workers.json'),DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE:repo,DOT_BRIDGE_MIN_FREE_BYTES:'0',DALAN_HOST_CHECKS:'off'}});
const ok=r=>{assert.equal(r.error,undefined,JSON.stringify(r));return r.value;};
const refused=(r,pattern)=>assert.match(r.error??'',pattern,JSON.stringify(r));
const result=JSON.stringify({source:'source',policy:'policy'});
try {
  await adapter.init();
  const originalToken=adapter.token.bind(adapter);
  adapter.token=subject=>{
    const [header,payload]=originalToken(subject).split('.');
    const claims=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(payload,'base64url')),azp:'fixture-client'})).toString('base64url');
    const input=header+'.'+claims;return input+'.'+sign('RSA-SHA256',Buffer.from(input),adapter.privateKey).toString('base64url');
  };
  fs.writeFileSync(path.join(root,'workers.json'),JSON.stringify({workers:{dot:{connections:[{issuer:`http://127.0.0.1:${adapter.jwksPort}/realms/fake`,subject:'W1',client_id:'fixture-client'}],repos:['example-owner/fixture']}}}),{mode:0o600});
  await adapter.reset();
  async function submit(name,{implementation=false,retention=100000}={}) {
    const id=adapter.requestId(name),token=adapter.ownerToken(name);
    const assignment={schema_version:1,request_id:id,brief:'Offline rejection boundaries',
      inputs:implementation?[{github_repo:'example-owner/fixture',base_sha:base}]:[],
      execution_scope:implementation?'implementation':'read-only',scope_paths:implementation?['.']:[],expected_output:'evidence',
      protocol:{profile:'job-v0',source:'source',scope:'scope',policy:'policy',destination:'owner',retain_until_ms:adapter.baseMs+retention}};
    ok(await adapter.admin('POST','/submit',{assignment,delivery:'none',execution:'worker',owner_token:token,command_key:'submit'}));
    return {id,token};
  }
  const {id,token}=await submit('snapshot-rejection',{implementation:true});
  const grant=ok(await adapter.mcp('W1','claim',{request_id:id,claimant:'W1',lease_ms:60000,command_key:'claim',expected_revision:1}));
  ok(await adapter.mcp('W1','apply_patch',{request_id:id,claim_id:grant.claim_id,patch:'diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-before\n+after\n'}));
  const files=()=>fs.readdirSync(path.join(adapter.home,'work','artifacts')).sort();
  const state=()=>JSON.stringify({files:files(),artifacts:adapter.q('SELECT * FROM artifacts WHERE request_id=? ORDER BY id',id),
    reports:adapter.q('SELECT * FROM reports WHERE request_id=?',id),facts:adapter.q('SELECT * FROM protocol_events WHERE request_id=? ORDER BY seq',id),
    revision:adapter.q1('SELECT revision FROM claim_command_revisions WHERE job=?',id).revision});
  const before=state(),finish={request_id:id,claim_id:grant.claim_id,epoch:grant.epoch,outcome:'completed',summary:'Done',result,command_key:'finish',expected_revision:2};
  for(let i=0;i<2;i++) {
    refused(await adapter.mcp('W1','finish',{...finish,expected_revision:0}),/revision_conflict/);
    assert.equal(state(),before,'rejected CAS must publish no patch rows or files');
  }
  refused(await adapter.mcp('W1','finish',{...finish,result:JSON.stringify({source:'wrong',policy:'policy'})}),/binding_mismatch/);
  assert.equal(state(),before);
  const db=new DatabaseSync(adapter.dbFile);
  db.exec('PRAGMA busy_timeout=5000');
  try {
    db.exec(`CREATE TRIGGER reject_snapshot_report BEFORE INSERT ON reports WHEN NEW.request_id='${id}' BEGIN SELECT RAISE(ABORT,'injected report failure'); END`);
    // A database failure is a crash: the worker gets the tool name and an error id, not the database text.
    refused(await adapter.mcp('W1','finish',finish),/^Error executing tool finish \(error id [0-9a-f]{8}/);
    assert.equal(state(),before,'rollback after snapshot must remove its new file and SQL row');
    db.exec('DROP TRIGGER reject_snapshot_report');
  } finally {db.close();}
  const receipt=ok(await adapter.mcp('W1','finish',finish));
  const patch=adapter.q1("SELECT * FROM artifacts WHERE request_id=? AND kind='patch'",id);
  assert.ok(fs.readFileSync(patch.path,'utf8').includes('+after'));
  const after=state();assert.deepEqual(ok(await adapter.mcp('W1','finish',finish)),receipt);assert.equal(state(),after);

  const waiting=await submit('conditional-cancel');
  ok(await adapter.admin('POST','/protocol/wait',{id:waiting.id,waiter:'terminal',predicate:'terminal',after_seq:0,expires_at:adapter.baseMs+10000,command_key:'wait',expected_revision:1},waiting.token));
  refused(await adapter.admin('POST','/cancel-if-queued',{id:waiting.id},waiting.token),/protocol jobs require keyed/);
  assert.equal(adapter.q1('SELECT status FROM assignments WHERE request_id=?',waiting.id).status,'queued');
  assert.equal(adapter.q1('SELECT revision FROM claim_command_revisions WHERE job=?',waiting.id).revision,2);
  ok(await adapter.admin('POST','/cancel',{id:waiting.id,command_key:'cancel',expected_revision:2},waiting.token));
  const deliveries=ok(await adapter.admin('POST','/protocol/inbox',{id:waiting.id,waiter:'terminal'},waiting.token)).deliveries;
  assert.equal(deliveries.length,1);assert.equal(adapter.q1('SELECT event_type FROM protocol_events WHERE request_id=? ORDER BY seq DESC',waiting.id).event_type,'cancelled');

  const retained=await submit('retention-owner',{retention:1000});
  await adapter.control({op:'advance',to:1001});
  refused(await adapter.admin('GET',`/get?id=${retained.id}&peek=1`,undefined,retained.token),/TOMBSTONE/);
  refused(await adapter.admin('POST','/note',{id:retained.id,text:'must not land'},retained.token),/TOMBSTONE/);
  refused(await adapter.admin('POST','/cancel-if-queued',{id:retained.id},retained.token),/TOMBSTONE/);
  assert.equal(adapter.q1('SELECT count(*) n FROM owner_notes WHERE request_id=?',retained.id).n,0);
  assert.equal(adapter.q1('SELECT status FROM assignments WHERE request_id=?',retained.id).status,'queued');
  // Batch owner APIs must not reveal or mutate expired jobs after a restart either.
  await adapter.control({op:'advance',to:100001});
  await adapter.control({op:'restart'});
  const audit=()=>JSON.stringify({assignment:adapter.q('SELECT * FROM assignments ORDER BY request_id'),
    decisions:adapter.q('SELECT * FROM decisions ORDER BY id'),lifecycle:adapter.q('SELECT * FROM lifecycle_events ORDER BY id'),
    notifications:adapter.q('SELECT * FROM notifications ORDER BY id')});
  const auditBefore=audit();
  const states=ok(await adapter.admin('POST','/owner-states',{items:[{id,capability:token},{id:retained.id,capability:retained.token}]}));
  assert(states.states.every(state=>state.error==='not_owned'&&!Object.hasOwn(state,'inbox')));
  const marked=ok(await adapter.admin('POST','/owner-mark-read',{items:[{id,capability:token}]}));
  assert.equal(marked.marked,0);assert.equal(marked.results[0].error,'not_owned');
  refused(await adapter.admin('POST','/decide',{id,decision:'accepted'},token),/TOMBSTONE/);
  assert.equal(audit(),auditBefore,'expired owner reads/decisions leave retained audit and delivery state unchanged');

  console.log('PASS real HTTP rejected finish/CAS/rollback, keyed cancellation waiter and owner retention fences');
} finally {await adapter.close();fs.rmSync(root,{recursive:true,force:true});}
