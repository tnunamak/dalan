#!/usr/bin/env node
import { preWorkerFixture } from '../src/test-support/pre-worker-fixture.mjs';
// Objective identity at store level: v22 migration, meta storage beside the payload, validation, retry conflict rules,
// rework/duplicate/coverage metrics from the columns, and the verified-only, idempotent backfill.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { lifecycleMetrics, explainMetrics, kindSql } from '../src/lifecycle.mjs';
import { summarizeRejections } from '../src/rejections.mjs';
import { legacyFixLoopName } from '../src/legacy-names.mjs';
import { openWithLegacyFixSchema } from '../src/test-support/legacy-fix-schema.mjs';
import { normalizeMeta, verifyObjective, deriveObjectives, drainerRequestId, fixLoopRequestId, fixLoopObjective } from '../src/objectives.mjs';

const MIN=60000, HOUR=60*MIN, dir=mkdtempSync(join(tmpdir(),'dalan-bridge-objectives-'));
let now=Date.parse('2026-10-08T00:00:00.000Z');
const storeOptions=()=>({now:()=>now,random:()=>0.5,capacity:2,limits:{intervalMs:10*MIN,maxCount:3,silenceMs:20*MIN,leaseMs:HOUR}});
// Most blocks cover databases created before the rename, which store the earlier spelling; openFresh covers a new database.
const open=name=>openWithLegacyFixSchema(join(dir,`${name}.db`),storeOptions());
const openFresh=name=>new Store(join(dir,`${name}.db`),storeOptions());
const payload=(id,extra={})=>({schema_version:1,request_id:id,brief:`objective ${id}`,inputs:[],expected_output:'one result',execution_scope:'read-only',...extra});
const row=(s,id)=>({...s.db.prepare('SELECT objective_key,revision,task_kind,source,payload_hash FROM assignments WHERE request_id=?').get(id)});
const pass=message=>console.log(`PASS ${message}`);
const sha=c=>c.repeat(40);

try {
  // ---- migration: a v21 database gains nullable columns; existing rows and claims keep working
  {
    let s=open('migrate');
    s.submit(payload('req_old_1'),{mode:'none'},null,'owner');
    const claim=s.claim('req_old_1','dot','subject_a',6);
    preWorkerFixture(s);
    s.db.exec('DROP INDEX assignments_objective'); for(const c of ['objective_key','revision','task_kind','source']) s.db.exec(`ALTER TABLE assignments DROP COLUMN ${c}`);
    s.db.exec('PRAGMA user_version=21'); s.db.close();
    s=open('migrate');
    assert.equal(s.db.prepare('PRAGMA user_version').get().user_version,66);
    assert.deepEqual(Object.fromEntries(Object.entries(row(s,'req_old_1')).filter(([k])=>k!=='payload_hash')),{objective_key:null,revision:null,task_kind:null,source:null});
    s.progress('req_old_1',claim.claim_id,'still mine','subject_a');
    assert.equal(s.claims()[0].claim_id,claim.claim_id);
    s.db.close(); s=open('migrate'); assert.equal(s.db.prepare('PRAGMA user_version').get().user_version,66,'reopen re-ran the migration'); s.db.close();
  }
  pass('v22 migration adds nullable objective columns; existing rows stay null and existing claim_ids stay valid');

  // ---- fix-loop source: the earlier spelling is accepted as input and stays the stored value, so stored rows and retries do not change
  {
    const s=open('fixloop'), fixMeta={objective_key:'fix-loop:o/r#bug-1',revision:sha('a'),task_kind:'fix-loop'};
    assert.equal(normalizeMeta({source:legacyFixLoopName}).source,'fix-loop','the earlier spelling normalizes to the neutral name');
    assert.equal(normalizeMeta({source:'fix-loop'}).source,'fix-loop');
    s.submit(payload('req_fix_new'),{mode:'none'},null,'owner',false,null,'normal',{...fixMeta,source:'fix-loop'});
    s.submit(payload('req_fix_old'),{mode:'none'},null,'owner',false,null,'normal',{...fixMeta,source:legacyFixLoopName});
    for(const id of ['req_fix_new','req_fix_old']) assert.equal(row(s,id).source,legacyFixLoopName,'stored value is unchanged, so existing databases need no migration');
    // A retry in either spelling is the same submission, for rows written with either spelling.
    for(const [id,spelling] of [['req_fix_new',legacyFixLoopName],['req_fix_old','fix-loop']])
      assert.equal(s.submit(payload(id),{mode:'none'},null,'owner',false,null,'normal',{...fixMeta,source:spelling}).duplicate,true,`retry of ${id} as ${spelling}`);
    assert.throws(()=>s.submit(payload('req_fix_old'),{mode:'none'},null,'owner',false,null,'normal',{...fixMeta,source:'agent'}),/request_id conflict/);
    // Metrics read the stored value back under the neutral name.
    assert.deepEqual(Object.keys(lifecycleMetrics(s,{since:new Date(now-HOUR).toISOString()}).objective_coverage.by_source),['fix-loop']);
    s.db.close();
  }
  pass('fix-loop source: earlier spelling accepted, stored value unchanged, retries match across spellings, metrics use the neutral name');

  // ---- a database created after the rename stores the neutral spelling and its schema never names the earlier one
  {
    const s=openFresh('fixloop-fresh'), fixMeta={objective_key:'fix-loop:o/r#bug-1',revision:sha('a'),task_kind:'fix-loop'};
    s.submit(payload('req_fix_new'),{mode:'none'},null,'owner',false,null,'normal',{...fixMeta,source:'fix-loop'});
    s.submit(payload('req_fix_old'),{mode:'none'},null,'owner',false,null,'normal',{...fixMeta,source:legacyFixLoopName});
    for(const id of ['req_fix_new','req_fix_old']) assert.deepEqual(row(s,id),{...row(s,id),objective_key:fixMeta.objective_key,task_kind:'fix-loop',source:'fix-loop'},'stored with the neutral spelling');
    for(const [id,spelling] of [['req_fix_new',legacyFixLoopName],['req_fix_old','fix-loop']])
      assert.equal(s.submit(payload(id),{mode:'none'},null,'owner',false,null,'normal',{...fixMeta,source:spelling}).duplicate,true,`retry of ${id} as ${spelling}`);
    assert.equal(s.db.prepare("SELECT count(*) n FROM sqlite_master WHERE sql LIKE '%dot-fix%'").get().n,0,'schema text is free of the earlier spelling');
    s.db.close();
  }
  pass('fix-loop source: a new database stores and checks only the neutral spelling');

  // ---- rows stored under the earlier spelling of the key and kind: retries, backfill and metrics treat both spellings as one
  {
    const s=open('oldspelling'), old=legacyFixLoopName, cand={id:'bug-9',repo:'o/r'};
    const id=fixLoopRequestId(cand), oldMeta={objective_key:`${old}:o/r#bug-9`,revision:sha('a'),task_kind:old,source:old}, newMeta={objective_key:fixLoopObjective(cand),revision:sha('a'),task_kind:'fix-loop',source:'fix-loop'};
    const fixPayload=(rid)=>payload(rid,{inputs:[{github_repo:'o/r',base_sha:sha('a')}]});
    s.submit(fixPayload(id),{mode:'none'},null,'owner',false,null,'normal',oldMeta);
    assert.deepEqual(Object.values(row(s,id)).slice(0,4),[oldMeta.objective_key,sha('a'),old,old],'the old row is stored as written');
    const retry=m=>s.submit(fixPayload(id),{mode:'none'},null,'owner',false,null,'normal',m);
    assert.equal(retry(newMeta).duplicate,true,'retry in the new spelling of a row stored in the old one');
    assert.equal(retry({...newMeta,objective_key:oldMeta.objective_key}).duplicate,true,'new kind with old key');
    assert.equal(retry({...newMeta,task_kind:old}).duplicate,true,'new key with old kind');
    assert.throws(()=>retry({...newMeta,objective_key:'fix-loop:o/r#bug-other'}),/request_id conflict/,'a different candidate still conflicts');
    assert.throws(()=>retry({...newMeta,task_kind:'review'}),/request_id conflict/,'a different kind still conflicts');
    assert.deepEqual(Object.values(row(s,id)).slice(0,4),[oldMeta.objective_key,sha('a'),old,old],'a retry does not rewrite the stored row');
    // The same row, read back through backfill with the new spelling: already set, not a conflict.
    const filled=s.backfillObjectives([{request_id:id,...newMeta}]);
    assert.deepEqual([filled.updated,filled.already_set,filled.conflict],[0,1,0],'backfill of an old-spelling row');
    // One candidate across the boundary is one objective; the kind is one kind.
    const id2=fixLoopRequestId(cand,1); s.submit(fixPayload(id2),{mode:'none'},null,'owner',false,null,'normal',{...newMeta,revision:sha('b')});
    const m=lifecycleMetrics(s,{since:new Date(now-HOUR).toISOString()});
    assert.equal(m.rework.value,1,'a new revision of an old-spelling objective is rework');
    assert.deepEqual(m.rework.by_source,{'fix-loop':1});
    const kinds=s.db.prepare(`SELECT DISTINCT ${kindSql} k FROM assignments a`).all().map(x=>x.k);
    assert.deepEqual(kinds,['fix-loop/normal'],'one kind for both spellings');
    const rej=summarizeRejections([old,'fix-loop'].map(k=>JSON.stringify({kind:'submit_rejected',at:new Date(now).toISOString(),reason:'bad',task_kind:k})));
    assert.deepEqual(rej.by_kind,{'fix-loop':2},'rejections count both spellings as one kind');
    s.db.close();
  }
  pass('old-spelling key and kind: retries match, backfill reports already_set, rework and kinds count both spellings as one');

  // ---- storage, validation, retry conflict rules
  {
    const s=open('submit');
    const meta={objective_key:'audit:o/r:src:errors:0',revision:sha('a'),task_kind:'audit-review',source:'drainer'};
    s.submit(payload('req_meta_1'),{mode:'none'},null,'owner',false,null,'normal',meta);
    s.submit(payload('req_meta_2'),{mode:'none'},null,'owner');
    const r1=row(s,'req_meta_1'), r2=row(s,'req_meta_2');
    assert.deepEqual([r1.objective_key,r1.revision,r1.task_kind,r1.source],Object.values(meta));
    assert.equal(JSON.parse(s.db.prepare('SELECT payload FROM assignments WHERE request_id=?').get('req_meta_1').payload).objective_key,undefined,'meta leaked into the payload');
    assert.deepEqual([r2.objective_key,r2.source],[null,null],'store invents no source');
    // Same payload with and without meta hashes the same: meta is outside the payload hash.
    s.submit(payload('req_meta_3'),{mode:'none'},null,'owner',false,null,'normal',{source:'agent'});
    const plain=open('plain'); plain.submit(payload('req_meta_3'),{mode:'none'},null,'owner');
    assert.equal(row(s,'req_meta_3').payload_hash,row(plain,'req_meta_3').payload_hash); plain.db.close();
    for(const [bad,msg] of [[{source:'producer'},/invalid meta.source/],[{source:'robot'},/invalid meta.source/],[{objective_key:'x'.repeat(513)},/invalid meta.objective_key/],[{revision:7},/invalid meta.revision/],[{task_kind:''},/invalid meta.task_kind/],[{extra:'x'},/invalid meta/],[['drainer'],/invalid meta/],['drainer',/invalid meta/]])
      assert.throws(()=>s.submit(payload('req_bad_1'),{mode:'none'},null,'owner',false,null,'normal',bad),msg,JSON.stringify(bad));
    assert.equal(s.hasAssignment('req_bad_1'),false);
    assert.doesNotThrow(()=>normalizeMeta({objective_key:'é'.repeat(256)}),'512 bytes is the limit, not 512 characters'); assert.throws(()=>normalizeMeta({objective_key:'é'.repeat(257)}),/invalid meta.objective_key/);
    // Retries: same meta is a duplicate; a different value on a field both sides carry is a conflict; absent fields never conflict.
    const retry=m=>s.submit(payload('req_meta_1'),{mode:'none'},null,'owner',false,null,'normal',m);
    assert.equal(retry(meta).duplicate,true);
    assert.equal(retry(null).duplicate,true,'retry without meta');
    assert.equal(retry({source:'drainer'}).duplicate,true,'retry with a subset');
    assert.throws(()=>retry({...meta,revision:sha('b')}),/request_id conflict/);
    assert.throws(()=>retry({...meta,source:'agent'}),/request_id conflict/);
    // A legacy row (null meta) accepts a retry with meta and is not rewritten by it.
    assert.equal(s.submit(payload('req_meta_2'),{mode:'none'},null,'owner',false,null,'normal',meta).duplicate,true);
    assert.equal(row(s,'req_meta_2').objective_key,null,'a retry rewrote legacy meta');
    s.db.close();
  }
  pass('meta is stored beside the payload, validated (strings <=512 bytes, source enum), and conflicts only where both sides carry a field');

  // ---- metrics from the columns: rework, duplicates, coverage, per source, unknown reasons
  {
    const T0=Date.parse('2026-10-08T00:00:00.000Z'); now=T0+10*HOUR;
    const s=open('metrics');
    const add=(id,offset,meta,extra={})=>s.db.prepare("INSERT INTO assignments(request_id,payload,payload_hash,thread_id,environment_id,status,created_at,owner_hash,review,delivery,priority,objective_key,revision,task_kind,source) VALUES(?,?,'h','','','queued',?,'o',0,'none','normal',?,?,?,?)")
      .run(id,JSON.stringify(payload(id,extra)),new Date(T0+offset).toISOString(),meta?.[0]??null,meta?.[1]??null,meta?.[2]??null,meta?.[3]??null);
    add('req_x_0',-HOUR,['pr-review:o/r#1','r1','review','drainer']);          // before the window: history only
    add('req_x_1',HOUR,['pr-review:o/r#1','r2','review','drainer']);           // rework (r1 earlier)
    add('req_x_2',2*HOUR,['pr-review:o/r#1','r2','review','drainer']);         // rework (r1) and duplicate (r2)
    add('req_x_3',3*HOUR,[`${legacyFixLoopName}:o/r#c1`,'s1',legacyFixLoopName,legacyFixLoopName]);        // first of its key
    add('req_x_4',4*HOUR,[`${legacyFixLoopName}:o/r#c1`,'s1',legacyFixLoopName,legacyFixLoopName]);        // duplicate
    add('req_x_5',5*HOUR,[null,null,null,'agent']);                            // agent without a key
    add('req_x_6',6*HOUR,null,{objective_key:'hand:k',revision:'v1'});        // legacy payload fields still count
    add('req_x_7',7*HOUR,null,{objective_key:'hand:k',revision:'v2'});        // rework via payload fields
    add('req_x_8',7*HOUR,['only-key',null,null,'agent']);                      // a key without a revision is not keyed
    const m=lifecycleMetrics(s,{since:new Date(T0).toISOString()});
    assert.deepEqual(m.rework,{value:3,unit:'count',n:6,by_source:{drainer:2,unknown:1}});
    assert.deepEqual(m.duplicates,{value:2,unit:'count',n:6,by_source:{drainer:1,'fix-loop':1}});
    assert.deepEqual(m.objective_coverage,{value:0.75,unit:'ratio',keyed:6,total:8,by_source:{drainer:{keyed:2,total:2},'fix-loop':{keyed:2,total:2},agent:{keyed:0,total:2},unknown:{keyed:2,total:2}}});
    assert.match(explainMetrics(m),/rework=3 duplicates=2 objective_coverage=6\/8$/);
    // A window whose assignments carry no key: unknown with the reason and the count, never zero.
    const late=lifecycleMetrics(s,{since:new Date(T0+5*HOUR-1).toISOString()});
    assert.equal(late.rework.value,3-2,'window start excludes earlier rows from counting but keeps them as history');
    now=T0+20*HOUR; add('req_y_1',19*HOUR,[null,null,null,'agent']);
    const bare=lifecycleMetrics(s,{since:new Date(T0+18*HOUR).toISOString()});
    assert.equal(bare.rework.value,null); assert.match(bare.rework.unknown_reason,/none of the 1 assignments submitted in the window has an objective_key/);
    assert.equal(bare.duplicates.value,null); assert.deepEqual(bare.objective_coverage,{value:0,unit:'ratio',keyed:0,total:1,by_source:{agent:{keyed:0,total:1}}});
    assert.match(explainMetrics(bare),/rework=unknown duplicates=unknown objective_coverage=0\/1$/);
    s.db.close();
  }
  pass('metrics: rework, duplicates and coverage from columns with payload fallback, per source, earlier rows as history, unknown with reason');

  // ---- backfill: derive from fixture receipts, manifests and the fix ledger; verified only; idempotent
  {
    const s=open('backfill');
    const repo='o/r', fix={id:'bug-7',repo}, prPayload=id=>payload(id,{inputs:[{github_repo:repo,base_sha:sha('0'),head_sha:sha('1'),pr_number:12}]});
    const pr=drainerRequestId(repo,`pr-review:${repo}#12`,sha('1'),'review');
    const audit=drainerRequestId(repo,`audit:${repo}:src:errors:2`,sha('2'),'audit-review');
    const oldAudit=drainerRequestId(repo,`audit:${repo}:lib`,sha('3'),'audit');
    const fromManifest=drainerRequestId(repo,'custom:objective',sha('4'),'review');
    const consumedUnknown=drainerRequestId(repo,'gone:objective',sha('5'),'review');
    const dotfix=fixLoopRequestId(fix,1), agent='req_agent_plain';
    const payloads={
      [pr]:prPayload(pr),
      [audit]:payload(audit,{brief:'Audit error handling, failure paths and resource cleanup; findings only. Review only the explicit scope_paths allow-list (part 3 of 4 of this module\'s allowed files).',inputs:[{github_repo:repo,base_sha:sha('2')}],scope_paths:['src/a.mjs','src/b.mjs']}),
      [oldAudit]:payload(oldAudit,{inputs:[{github_repo:repo,base_sha:sha('3')}],scope_paths:['lib/x.js']}),
      [fromManifest]:payload(fromManifest,{inputs:[{github_repo:repo,base_sha:sha('4')}]}),
      [consumedUnknown]:payload(consumedUnknown,{inputs:[{github_repo:repo,base_sha:sha('5')}]}),
      [dotfix]:payload(dotfix,{inputs:[{github_repo:repo,base_sha:sha('6')}]}),
      [agent]:payload(agent,{inputs:[{github_repo:repo,base_sha:sha('7')}]}),
    };
    // Inserted as the rows exist today (a PR payload would need a live preflight through submit).
    for(const p of Object.values(payloads)) s.db.prepare("INSERT INTO assignments(request_id,payload,payload_hash,thread_id,environment_id,status,created_at,owner_hash,review,delivery,priority) VALUES(?,?,'h','','','finished',?,'o',0,'none','background')").run(p.request_id,JSON.stringify(p),new Date(now).toISOString());
    const receipts=[...Object.values(payloads).map(p=>({request_id:p.request_id,body:JSON.stringify(p)})),{request_id:'req_adopted_1',body:''},{request_id:'req_broken_1',body:'{'}];
    const manifests=[{schema_version:1,policy_version:1,objective_key:'custom:objective',revision:sha('4'),task_kind:'review',assignment:{inputs:[{github_repo:repo,base_sha:sha('4')}]}},{policy_version:2,objective_key:'x',revision:'y',task_kind:'z',assignment:{}},null];
    const ledger=[{id:'bug-7',repo,stage:'assigned',request_id:dotfix,base_sha:sha('6')},{id:'bug-8',repo,stage:'assigned',request_id:'dotfix-bug-8-deadbeef',base_sha:sha('6')},{id:'bug-9',repo,stage:'assigned',request_id:'local-only',base_sha:sha('6')}];
    const derived=deriveObjectives({receipts,manifests,ledger});
    assert.deepEqual(derived.counts,{receipts:7,verified:{manifest:1,ledger:1,payload:3},unverified:2});
    const tuple=id=>derived.tuples.find(t=>t.request_id===id);
    assert.deepEqual(tuple(pr),{request_id:pr,objective_key:`pr-review:${repo}#12`,revision:sha('1'),task_kind:'review',source:'drainer'});
    assert.deepEqual(tuple(audit),{request_id:audit,objective_key:`audit:${repo}:src:errors:2`,revision:sha('2'),task_kind:'audit-review',source:'drainer'});
    assert.deepEqual(tuple(oldAudit),{request_id:oldAudit,objective_key:`audit:${repo}:lib`,revision:sha('3'),task_kind:'audit',source:'drainer'});
    assert.deepEqual(tuple(dotfix),{request_id:dotfix,objective_key:fixLoopObjective(fix),revision:sha('6'),task_kind:'fix-loop',source:'fix-loop'});
    assert.equal(tuple(consumedUnknown),undefined,'a row whose tuple has no source of truth must stay unknown');
    assert.equal(tuple(agent),undefined);
    // The server side verifies every tuple again against its stored payload: forged or mismatched tuples are rejected.
    const forged=[{request_id:agent,objective_key:'invented',revision:sha('7'),task_kind:'review',source:'drainer'},{request_id:pr,objective_key:`pr-review:${repo}#13`,revision:sha('1'),task_kind:'review',source:'drainer'},
      {request_id:dotfix,objective_key:fixLoopObjective(fix),revision:sha('9'),task_kind:legacyFixLoopName,source:legacyFixLoopName},{request_id:agent,objective_key:'k',revision:'r',task_kind:'t',source:'agent'},{request_id:'req_missing_1',objective_key:'k',revision:'r',task_kind:'t',source:'drainer'},
      {request_id:pr,objective_key:`pr-review:${repo}#12`,revision:sha('1'),source:'drainer'}];
    const dry=s.backfillObjectives([...derived.tuples,...forged],{dryRun:true});
    assert.deepEqual({...dry,rejected_examples:dry.rejected_examples.map(x=>x.reason)},{dry_run:true,received:11,updated:5,already_set:0,conflict:0,not_found:1,rejected:5,by_source:{drainer:4,'fix-loop':1},without_objective:2,total:7,
      rejected_examples:['request_id does not match the drainer identity of this tuple','request_id does not match the drainer identity of this tuple','revision or repo differs from the pinned input','source agent cannot be verified','incomplete tuple']});
    assert.equal(s.db.prepare('SELECT count(*) n FROM assignments WHERE objective_key IS NOT NULL').get().n,0,'dry run wrote');
    const real=s.backfillObjectives([...derived.tuples,...forged]);
    assert.deepEqual([real.updated,real.rejected,real.without_objective,real.by_source],[5,5,2,{drainer:4,'fix-loop':1}]);
    assert.deepEqual(Object.values(row(s,dotfix)).slice(0,4),[fixLoopObjective(fix),sha('6'),'fix-loop',legacyFixLoopName]);
    assert.deepEqual(Object.values(row(s,agent)).slice(0,4),[null,null,null,null]);
    const again=s.backfillObjectives(derived.tuples);
    assert.deepEqual([again.updated,again.already_set,again.conflict,again.without_objective],[0,5,0,2],'backfill is not idempotent');
    // A row submitted live with its own meta is never overwritten, even by a verified tuple.
    const live=drainerRequestId(repo,'live:objective',sha('8'),'review');
    s.submit(payload(live,{inputs:[{github_repo:repo,base_sha:sha('8')}]}),{mode:'none'},null,'owner',false,null,'normal',{source:'agent'});
    const kept=s.backfillObjectives([{request_id:live,objective_key:'live:objective',revision:sha('8'),task_kind:'review',source:'drainer'}]);
    assert.deepEqual([kept.updated,kept.conflict,row(s,live).source],[0,1,'agent']);
    assert.throws(()=>s.backfillObjectives('nope'),/tuples must be an array/);
    assert.equal(verifyObjective({request_id:pr,payload:prPayload(pr)},{objective_key:`pr-review:${repo}#12`,revision:sha('1'),task_kind:'review',source:'drainer'}),null);
    s.db.close();
  }
  pass('backfill derives tuples from receipts, manifests and the fix ledger, keeps only hash/identity-verified ones, leaves the rest null, and is idempotent');
  console.log('PASS objectives test');
} catch(error) { console.error('FAIL',error); process.exitCode=1; }
finally { rmSync(dir,{recursive:true,force:true}); }
