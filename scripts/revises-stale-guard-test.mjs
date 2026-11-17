#!/usr/bin/env node
// C1: the `revises` link and the stale guard, on a real Store (a SQLite file in a temp directory; a restart is a closed Store
// and a new one on the same file). Step 0 (does meta carry context and revision?), then both commit orders, an open question,
// a restart between, and the one assumption the design rests on: the stale check runs in the same transaction as the accept.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { lifecycleMetrics } from '../src/lifecycle.mjs';
import { normalizeMeta } from '../src/objectives.mjs';

const self=fileURLToPath(import.meta.url);
const assignment=id=>({schema_version:1,request_id:id,brief:'revise fixture',inputs:[],expected_output:'one result',execution_scope:'read-only'});
const meta=(revision,key='ctx:feature-x')=>({objective_key:key,revision,task_kind:'fix',source:'agent'});
// Store.submit arguments: 8 meta, 16 command key, 17 supersedes, 22 revises (21 is the relationship).
const submit=(s,id,owner,{m=null,revises=null,supersedes=null,key=null}={})=>s.submit(assignment(id),{mode:'none'},null,owner,false,null,'normal',m,assignment(id),null,undefined,null,'none',null,null,key,supersedes,null,null,null,null,revises);
const revises=(priorId,priorOwner)=>({prior_id:priorId,prior_token:priorOwner});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const pass=message=>console.log(`PASS ${message}`);

if(process.argv[2]==='--decide-child') {
  // Runs Store.decide on the same file while the parent holds the write lock. Prints the outcome as one JSON line.
  const [file,id,ready]=process.argv.slice(3);
  const s=new Store(file);
  try {
    fs.writeFileSync(ready,'ready');
    while(!fs.existsSync(`${ready}.go`)) await sleep(10);
    try { console.log(JSON.stringify({decided:s.decide(id,'accepted')})); }
    catch(error) { console.log(JSON.stringify({error:error.message,code:error.code??null,stale:error.stale??null})); }
  } finally { s.db.close(); }
} else {
  const root=fs.mkdtempSync(path.join(process.env.DOT_BRIDGE_TEST_TMP??os.tmpdir(),'rv-'));
  const file=path.join(root,'bridge.db');
  let s=new Store(file);
  const restart=()=>{ s.db.close(); s=new Store(file); };
  // Every durable row that belongs to one request, in insertion order: what "byte-identical" compares.
  const rowsOf=id=>JSON.stringify(s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().flatMap(({name})=>{
    const columns=s.db.prepare(`SELECT name FROM pragma_table_info('${name}')`).all().map(c=>c.name);
    if(!columns.includes('request_id')||name==='job_revisions') return [];
    return [[name,s.db.prepare(`SELECT * FROM ${name} WHERE request_id=? ORDER BY rowid`).all(id)]];
  }));
  const claim=id=>s.claim(id,'W1','local-principal',100);
  const decisions=id=>s.db.prepare('SELECT decision,actor,via,note FROM decisions WHERE request_id=? ORDER BY id').all(id).map(r=>({...r}));
  const accepted=id=>s.db.prepare("SELECT count(*) n FROM lifecycle_events WHERE request_id=? AND type='accepted'").get(id).n;
  const links=()=>s.db.prepare('SELECT request_id,prior_id,input_revision FROM job_revisions ORDER BY rowid').all().map(r=>({...r}));
  const stale=(fn,why)=>assert.throws(fn,error=>error.code==='STALE_REVISION'&&/revised by/.test(error.message)&&!!error.stale?.revised_by,why);
  try {
    // ---- Step 0: meta carries context and revision, with no conflict. A correction is a new revision of the same objective.
    submit(s,'s0_first_aaaa','o',{m:meta('rev1')}); submit(s,'s0_second_bbb','o',{m:meta('rev2')});
    let metrics=lifecycleMetrics(s,{});
    assert.deepEqual([metrics.rework.value,metrics.duplicates.value,metrics.objective_coverage.keyed],[1,0,2],'same objective_key, new revision = rework, not a duplicate');
    submit(s,'s0_third_ccc','o',{m:meta('rev1')});
    metrics=lifecycleMetrics(s,{});
    assert.equal(metrics.duplicates.value,1,'the same revision again is a duplicate: a correction must carry a new revision');
    assert.doesNotThrow(()=>normalizeMeta({objective_key:'k'.repeat(512),revision:'r'.repeat(512)}));
    assert.throws(()=>normalizeMeta({objective_key:'k'.repeat(513),revision:'r'}),/invalid meta.objective_key/);
    assert.equal(s.db.prepare("SELECT count(*) n FROM pragma_index_list('assignments') WHERE \"unique\"=1 AND origin='c'").get().n,0,'no unique index on the objective tuple');
    assert.equal(s.db.prepare('SELECT count(*) n FROM job_revisions').get().n,0,'plain submits write no link');
    pass('step 0: meta.objective_key is the context and meta.revision the input revision; metrics read a correction as rework; no column is needed');

    // ---- Refusals write nothing.
    submit(s,'prior_refuse_01','o1',{m:meta('r1','ctx:refuse')});
    const count=()=>s.db.prepare('SELECT count(*) n FROM assignments').get().n;
    const before=count();
    for(const [why,id,opts,message] of [
      ['wrong prior token','succ_refuse_01',{m:meta('r2','ctx:refuse'),revises:revises('prior_refuse_01','wrong')},/invalid owner capability/],
      ['unknown prior','succ_refuse_02',{m:meta('r2','ctx:refuse'),revises:revises('prior_missing_1','o1')},/revises_prior_not_found/],
      ['own id','succ_refuse_03',{m:meta('r2','ctx:refuse'),revises:revises('succ_refuse_03','o1')},/revises_cycle/],
      ['same revision','succ_refuse_04',{m:meta('r1','ctx:refuse'),revises:revises('prior_refuse_01','o1')},/revises_same_revision/],
      ['bad shape','succ_refuse_05',{m:meta('r2','ctx:refuse'),revises:{prior_id:'prior_refuse_01'}},/invalid revises/],
      ['extra key','succ_refuse_06',{m:meta('r2','ctx:refuse'),revises:{...revises('prior_refuse_01','o1'),extra:1}},/invalid revises/],
      ['with supersedes','succ_refuse_07',{m:meta('r2','ctx:refuse'),revises:revises('prior_refuse_01','o1'),supersedes:{target_id:'prior_refuse_01',target_token:'o1'}},/revises_and_supersedes/],
    ]) { assert.throws(()=>submit(s,id,'o2',opts),message,why); assert.equal(count(),before,`${why} stored a row`); assert.deepEqual(links(),[],`${why} stored a link`); }
    assert.equal(s.get('prior_refuse_01').revised_by,null);
    pass('a refused revises stores no assignment and no link (wrong token, unknown prior, cycle, same revision, bad shape, with supersedes)');

    // ---- (a) The correction commits first, then the old job finishes.
    submit(s,'job_a_old_0001','oa',{m:meta('r1','ctx:a')});
    const oldGrant=claim('job_a_old_0001');
    const revision=submit(s,'job_a_new_0001','na',{m:meta('r2','ctx:a'),revises:revises('job_a_old_0001','oa')});
    assert.equal(revision.status,'queued');
    assert.equal(s.get('job_a_old_0001').status,'claimed','a revision does not cancel the job it revises');
    assert.equal(s.get('job_a_old_0001').cancelled_at,null);
    assert.deepEqual(links(),[{request_id:'job_a_new_0001',prior_id:'job_a_old_0001',input_revision:'r2'}]);
    const notes=s.get('job_a_old_0001').owner_notes;
    assert.equal(notes.length,1,'one owner note tells the running worker');
    assert.match(notes[0].text,/superseded by job_a_new_0001/);
    assert.match(notes[0].text,/cannot be accepted or applied/);
    assert.deepEqual(s.get('job_a_new_0001').revises,{request_id:'job_a_old_0001',input_revision:'r2',at:s.get('job_a_new_0001').revises.at});
    assert.equal(s.get('job_a_old_0001').revised_by.request_id,'job_a_new_0001');
    restart();                                                                  // (d) a restart between the correction and the finish
    assert.equal(s.get('job_a_old_0001').revised_by.request_id,'job_a_new_0001','the link survives a restart');
    assert.equal(s.get('job_a_old_0001').owner_notes.length,1);
    const finished=s.finish('job_a_old_0001',oldGrant.claim_id,'completed','old summary','old result');
    assert.equal(finished.duplicate,false); assert.equal(finished.result_authority,true);
    assert.equal(s.get('job_a_old_0001').status,'finished');
    assert.equal(s.get('job_a_old_0001').report.summary,'old summary','the report is stored');
    const finishedRows=rowsOf('job_a_old_0001');
    stale(()=>s.decide('job_a_old_0001','accepted'));
    stale(()=>s.decide('job_a_old_0001','applied',{via:'apply'}));
    assert.equal(accepted('job_a_old_0001'),0,'no accepted event');
    assert.deepEqual(decisions('job_a_old_0001'),[{decision:'stale',actor:'system',via:'revises',note:'revised by job_a_new_0001'}],'one stale decision, written by the refusal, committed');
    assert.equal(s.latestDecision('job_a_old_0001').decision,'stale');
    const staleRows=rowsOf('job_a_old_0001');
    stale(()=>s.verdict('job_a_old_0001',true));
    assert.equal(rowsOf('job_a_old_0001'),staleRows,'a repeated refusal changes nothing');
    assert.notEqual(finishedRows,staleRows);
    assert.equal(s.decide('job_a_old_0001','not_useful').decision,'not_useful','the owner can still reject a stale result');
    // The successor is ordinary work and is accepted normally.
    const newGrant=claim('job_a_new_0001');
    s.finish('job_a_new_0001',newGrant.claim_id,'completed','new summary','new result');
    assert.equal(s.decide('job_a_new_0001','accepted').decision,'accepted');
    pass('(a) correction first: the old report is stored, accept and apply are refused, stale is recorded once, the successor is accepted');

    // ---- (b) The finish commits first, then the correction. Terminal rows stay byte-identical; the successor is new work.
    submit(s,'job_b_old_0001','ob',{m:meta('r1','ctx:b')});
    const bGrant=claim('job_b_old_0001');
    s.finish('job_b_old_0001',bGrant.claim_id,'completed','b summary','b result');
    const terminal=rowsOf('job_b_old_0001');
    const bRevision=submit(s,'job_b_new_0001','nb',{m:meta('r2','ctx:b'),revises:revises('job_b_old_0001','ob')});
    assert.equal(rowsOf('job_b_old_0001'),terminal,'the finished job\'s rows are byte-identical after the correction');
    assert.equal(s.get('job_b_old_0001').owner_notes.length,0,'a finished job gets no note');
    assert.equal(bRevision.status,'queued'); assert.equal(s.get('job_b_new_0001').status,'queued');
    assert.ok(claim('job_b_new_0001').claim_id,'the successor is claimable new work');
    stale(()=>s.decide('job_b_old_0001','accepted'));
    pass('(b) finish first: the finished job is byte-identical after the correction; the successor is new work; the old result can no longer be accepted');

    // ---- (b2) An accepted result stays accepted. A later apply is refused and writes no row.
    submit(s,'job_b2_old_001','ob2',{m:meta('r1','ctx:b2')});
    const b2Grant=claim('job_b2_old_001');
    s.finish('job_b2_old_001',b2Grant.claim_id,'completed','s','r');
    s.decide('job_b2_old_001','accepted');
    submit(s,'job_b2_new_001','nb2',{m:meta('r2','ctx:b2'),revises:revises('job_b2_old_001','ob2')});
    const decided=rowsOf('job_b2_old_001');
    stale(()=>s.decide('job_b2_old_001','accepted'),'accepting again after the correction is refused, not a duplicate no-op');
    stale(()=>s.decide('job_b2_old_001','applied'));
    assert.equal(rowsOf('job_b2_old_001'),decided,'no row is written over an earlier decision');
    assert.equal(s.latestDecision('job_b2_old_001').decision,'accepted');
    // The same holds for apply: applied, then a correction, then applied again.
    submit(s,'job_b3_old_001','ob3',{m:meta('r1','ctx:b3')});
    const b3Grant=claim('job_b3_old_001');
    s.finish('job_b3_old_001',b3Grant.claim_id,'completed','s','r');
    s.decide('job_b3_old_001','applied');
    submit(s,'job_b3_new_001','nb3',{m:meta('r2','ctx:b3'),revises:revises('job_b3_old_001','ob3')});
    const applied=rowsOf('job_b3_old_001');
    stale(()=>s.decide('job_b3_old_001','applied'),'applying again after the correction is refused, not a duplicate no-op');
    assert.equal(rowsOf('job_b3_old_001'),applied,'the earlier applied decision is preserved and no row is added');
    assert.equal(s.latestDecision('job_b3_old_001').decision,'applied');
    pass('(b2) an accepted or applied result stays so; deciding it again after the correction is refused with no new row');

    // ---- (c) An open question survives a correction, and a restart.
    submit(s,'job_c_old_0001','oc',{m:meta('r1','ctx:c')});
    const cGrant=claim('job_c_old_0001');
    s.askQuestion('job_c_old_0001',cGrant.claim_id,'Q1','which file?');
    const asked=JSON.stringify(s.questions('job_c_old_0001'));
    submit(s,'job_c_new_0001','nc',{m:meta('r2','ctx:c'),revises:revises('job_c_old_0001','oc')});
    assert.equal(JSON.stringify(s.questions('job_c_old_0001')),asked,'the open question row is unchanged by the correction');
    restart();
    assert.equal(JSON.stringify(s.questions('job_c_old_0001')),asked,'and by a restart');
    assert.throws(()=>s.finish('job_c_old_0001',cGrant.claim_id,'completed','s','r'),error=>error.code==='QUESTION_OPEN');
    s.answerQuestion('job_c_old_0001','Q1','src/a.mjs');
    s.consumeAnswer('job_c_old_0001',cGrant.claim_id,'Q1');
    s.finish('job_c_old_0001',cGrant.claim_id,'completed','s','r');
    stale(()=>s.decide('job_c_old_0001','accepted'));
    pass('(c)/(d) an open question survives a correction and a restart, is answered and consumed, and the finished result is then stale');

    // ---- A cancelled correction does not make the old result stale.
    submit(s,'job_x_old_0001','ox',{m:meta('r1','ctx:x')});
    const xGrant=claim('job_x_old_0001');
    submit(s,'job_x_new_0001','nx',{m:meta('r2','ctx:x'),revises:revises('job_x_old_0001','ox')});
    s.cancel('job_x_new_0001','withdrawn');
    s.finish('job_x_old_0001',xGrant.claim_id,'completed','s','r');
    assert.equal(s.decide('job_x_old_0001','accepted').decision,'accepted','a withdrawn correction supersedes nothing');
    pass('a cancelled correction does not make the old result stale');

    // ---- Retries: the same revises is a retry; a different or missing one conflicts.
    submit(s,'job_r_old_0001','or',{m:meta('r1','ctx:r')}); submit(s,'job_r_alt_0001','oalt',{m:meta('r1','ctx:r2')});
    const first=submit(s,'job_r_new_0001','nr',{m:meta('r2','ctx:r'),revises:revises('job_r_old_0001','or')});
    const linksBefore=links(); const notesBefore=s.get('job_r_old_0001').owner_notes.length;
    assert.equal(submit(s,'job_r_new_0001','nr',{m:meta('r2','ctx:r'),revises:revises('job_r_old_0001','or')}).duplicate,true);
    assert.deepEqual(links(),linksBefore,'a retry adds no link'); assert.equal(s.get('job_r_old_0001').owner_notes.length,notesBefore,'a retry adds no note');
    assert.throws(()=>submit(s,'job_r_new_0001','nr',{m:meta('r2','ctx:r'),revises:revises('job_r_alt_0001','oalt')}),/request_id conflict/);
    assert.throws(()=>submit(s,'job_r_new_0001','nr',{m:meta('r2','ctx:r')}),/request_id conflict/);
    assert.throws(()=>submit(s,'job_r_new_0001','nr',{m:meta('r2','ctx:r'),revises:revises('job_r_old_0001','wrong')}),/invalid owner capability/);
    assert.equal(first.duplicate,false);
    // With a command key the same rule holds, and the receipt replays.
    submit(s,'job_k_old_0001','ok',{m:meta('r1','ctx:k')});
    const keyed=submit(s,'job_k_new_0001','nk',{m:meta('r2','ctx:k'),revises:revises('job_k_old_0001','ok'),key:'key-1'});
    assert.deepEqual(submit(s,'job_k_new_0001','nk',{m:meta('r2','ctx:k'),revises:revises('job_k_old_0001','ok'),key:'key-1'}),{...keyed,duplicate:true});
    assert.throws(()=>submit(s,'job_k_new_0001','nk',{m:meta('r2','ctx:k'),revises:revises('job_r_old_0001','or'),key:'key-1'}),/KEY_CONFLICT/);
    pass('retries: the same revises replays; another or a missing one conflicts; a command key replays the receipt');

    // ---- The assumption the design rests on: the stale check shares the accept's transaction.
    // The parent holds the write lock and commits the correction inside it. A decide that started meanwhile must wait for the
    // lock and then see the correction. If the check ran outside the transaction, the child would read "no newer revision",
    // block, and accept after the commit.
    submit(s,'job_l_old_0001','ol',{m:meta('r1','ctx:l')});
    const lGrant=claim('job_l_old_0001');
    s.finish('job_l_old_0001',lGrant.claim_id,'completed','s','r');
    const ready=path.join(root,'child-ready');
    // The child opens its own Store first (opening one takes the lock), then waits for the go file.
    const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning',self,'--decide-child',file,'job_l_old_0001',ready],{stdio:['ignore','pipe','inherit']});
    let out=''; child.stdout.on('data',b=>out+=b);
    const closed=new Promise(resolve=>child.on('close',resolve));
    for(let i=0;i<400&&!fs.existsSync(ready);i++) await sleep(25);
    assert.ok(fs.existsSync(ready),'the child opened its Store');
    s.db.exec('BEGIN IMMEDIATE');
    try {
      s.submitInTransaction(assignment('job_l_new_0001'),{mode:'none'},null,'nl',false,null,'normal',meta('r2','ctx:l'),assignment('job_l_new_0001'),null,undefined,null,'none',null,null,null,null,null,null,null,null,revises('job_l_old_0001','ol'));
      fs.writeFileSync(`${ready}.go`,'go');
      await sleep(400);                                                          // the child is now waiting on the write lock
      assert.equal(out,'','the decide waits for the lock instead of reading around it');
      s.db.exec('COMMIT');
      await closed;
      const result=JSON.parse(out);
      assert.equal(result.code,'STALE_REVISION',`the decide that waited saw the correction: ${out}`);
      assert.equal(result.stale.revised_by,'job_l_new_0001');
    } catch(error) { if(s.db.isTransaction) s.db.exec('ROLLBACK'); throw error; }
    assert.deepEqual(decisions('job_l_old_0001').map(d=>d.decision),['stale']);
    pass('the stale check and the accept share one transaction: a decide that waited on the correction\'s commit was refused');

    // ---- (e) Two-phase apply: reserve, write, confirm. The stale fence is at the reservation; a correction after it is new work.
    const applying=id=>s.get(id).apply;
    // A correction before the reservation: refused, stale recorded, nothing reserved.
    submit(s,'job_p1_old_0001','op1',{m:meta('r1','ctx:p1')}); s.finish('job_p1_old_0001',claim('job_p1_old_0001').claim_id,'completed','s','r');
    submit(s,'job_p1_new_0001','np1',{m:meta('r2','ctx:p1'),revises:revises('job_p1_old_0001','op1')});
    stale(()=>s.reserveApply('job_p1_old_0001'));
    assert.equal(applying('job_p1_old_0001'),null,'a refused reservation reserves nothing');
    assert.deepEqual(decisions('job_p1_old_0001').map(d=>d.decision),['stale']);
    // A correction after the reservation: the holder's confirm still records applied, once; the effect event follows the confirm only.
    submit(s,'job_p2_old_0001','op2',{m:meta('r1','ctx:p2')}); s.finish('job_p2_old_0001',claim('job_p2_old_0001').claim_id,'completed','s','r');
    const reserved=s.reserveApply('job_p2_old_0001');
    assert.deepEqual([reserved.state,reserved.resumed,typeof reserved.attempt],['applying',false,'string']);
    assert.deepEqual([decisions('job_p2_old_0001'),accepted('job_p2_old_0001')],[[],0],'a reservation records no decision and no accepted event: the effect has not happened');
    assert.equal(applying('job_p2_old_0001').state,'applying'); assert.equal(applying('job_p2_old_0001').uncertain,true);
    assert.equal(JSON.stringify(applying('job_p2_old_0001')).includes(reserved.attempt),false,'the attempt token is not shown in get');
    submit(s,'job_p2_new_0001','np2',{m:meta('r2','ctx:p2'),revises:revises('job_p2_old_0001','op2')});
    restart();
    assert.equal(applying('job_p2_old_0001').state,'applying','the reservation survives a restart');
    // Every attempt calls reserve. A takeover of an open reservation is a stale check too: after a correction it is refused, and
    // it neither records stale nor disturbs the holder.
    stale(()=>s.reserveApply('job_p2_old_0001'));
    assert.deepEqual(decisions('job_p2_old_0001'),[],'a refused takeover of an open reservation records nothing');
    assert.throws(()=>s.confirmApply('job_p2_old_0001'),/attempt/,'a confirm needs the attempt token');
    assert.throws(()=>s.confirmApply('job_p2_old_0001',{attempt:'not-the-token'}),/superseded|not the current attempt/);
    const confirmed=s.confirmApply('job_p2_old_0001',{attempt:reserved.attempt});
    assert.equal(confirmed.decision,'applied','the holder reserved before the correction, so its confirm is new-work-safe');
    assert.deepEqual(decisions('job_p2_old_0001').map(d=>[d.decision,d.actor,d.via]),[['applied','owner','apply']]);
    assert.equal(accepted('job_p2_old_0001'),1,'the confirm writes the accepted event once');
    assert.equal(applying('job_p2_old_0001').state,'applied');
    assert.equal(s.confirmApply('job_p2_old_0001',{attempt:reserved.attempt}).duplicate,true,'a repeated confirm by the same attempt is a no-op');
    assert.equal(accepted('job_p2_old_0001'),1);
    // A release (the write failed): no decision, no accepted event, reserve again works with a new token.
    submit(s,'job_p3_old_0001','op3',{m:meta('r1','ctx:p3')}); s.finish('job_p3_old_0001',claim('job_p3_old_0001').claim_id,'completed','s','r');
    const p3=s.reserveApply('job_p3_old_0001');
    assert.throws(()=>s.releaseApply('job_p3_old_0001',{attempt:'other',reason:'x'}),/superseded|not the current attempt/,'a release needs the current token');
    const released=s.releaseApply('job_p3_old_0001',{attempt:p3.attempt,reason:'write failed: disk full'});
    assert.equal(released.state,'released');
    assert.deepEqual([decisions('job_p3_old_0001'),accepted('job_p3_old_0001')],[[],0],'a failed apply leaves the job not applied');
    assert.deepEqual([applying('job_p3_old_0001').state,applying('job_p3_old_0001').reason],['released','write failed: disk full']);
    assert.throws(()=>s.confirmApply('job_p3_old_0001',{attempt:p3.attempt}),/no open apply reservation/);
    const p3b=s.reserveApply('job_p3_old_0001');
    assert.equal(p3b.resumed,false,'a released job can be reserved again'); assert.notEqual(p3b.attempt,p3.attempt);
    assert.throws(()=>s.confirmApply('job_p1_new_0001',{attempt:'x'}),/(assignment not found|only a finished|no open apply reservation)/);
    // Takeover: a second attempt on an open reservation (no correction) gets a new token; the first token is superseded.
    const p3c=s.reserveApply('job_p3_old_0001');
    assert.deepEqual([p3c.resumed,p3c.attempt===p3b.attempt],[true,false],'a takeover mints a new token');
    assert.throws(()=>s.confirmApply('job_p3_old_0001',{attempt:p3b.attempt}),/superseded|not the current attempt/,'the superseded attempt cannot confirm');
    assert.throws(()=>s.releaseApply('job_p3_old_0001',{attempt:p3b.attempt,reason:'late'}),/superseded|not the current attempt/,'nor release');
    assert.equal(applying('job_p3_old_0001').state,'applying','the superseded attempt changed nothing');
    // The interleaving: A holds an open reservation and pauses; B takes over and fails (release); a correction lands; A resumes
    // and must reserve again, which the stale check refuses, so A never writes. A's old token cannot confirm either.
    submit(s,'job_i_old_0001','oi',{m:meta('r1','ctx:i')}); s.finish('job_i_old_0001',claim('job_i_old_0001').claim_id,'completed','s','r');
    const crashed=s.reserveApply('job_i_old_0001');
    const aSawOpen=applying('job_i_old_0001'); assert.equal(aSawOpen.state,'applying');
    const b=s.reserveApply('job_i_old_0001'); s.releaseApply('job_i_old_0001',{attempt:b.attempt,reason:'B failed'});
    submit(s,'job_i_new_0001','ni',{m:meta('r2','ctx:i'),revises:revises('job_i_old_0001','oi')});
    stale(()=>s.reserveApply('job_i_old_0001'));
    assert.throws(()=>s.confirmApply('job_i_old_0001',{attempt:crashed.attempt}),/no open apply reservation/,'A\'s stale token cannot confirm a released reservation');
    assert.deepEqual(decisions('job_i_old_0001').map(d=>d.decision),['stale'],'the job was never applied');
    // The owner can give up an uncertain reservation on purpose (no token needed), and a stalled attempt is then fenced.
    submit(s,'job_f_old_0001','of',{m:meta('r1','ctx:f')}); s.finish('job_f_old_0001',claim('job_f_old_0001').claim_id,'completed','s','r');
    const f=s.reserveApply('job_f_old_0001');
    assert.equal(s.releaseApply('job_f_old_0001',{force:true,reason:'released by the owner'}).state,'released');
    assert.throws(()=>s.confirmApply('job_f_old_0001',{attempt:f.attempt}),/no open apply reservation/);
    assert.equal(applying('job_f_old_0001').reason,'released by the owner');
    // Resume without a write: the tree already holds the patch, so the reserve may take over an open reservation even after a
    // correction, because the effect already happened and the confirm only records it. It never applies to a job with no open one.
    submit(s,'job_g_old_0001','og',{m:meta('r1','ctx:g')}); s.finish('job_g_old_0001',claim('job_g_old_0001').claim_id,'completed','s','r');
    const g=s.reserveApply('job_g_old_0001');
    submit(s,'job_g_new_0001','ng',{m:meta('r2','ctx:g'),revises:revises('job_g_old_0001','og')});
    stale(()=>s.reserveApply('job_g_old_0001'));
    const g2=s.reserveApply('job_g_old_0001',{present:true});
    assert.deepEqual([g2.resumed,g2.attempt===g.attempt],[true,false]);
    assert.equal(s.confirmApply('job_g_old_0001',{attempt:g2.attempt}).decision,'applied');
    submit(s,'job_h_old_0001','oh',{m:meta('r1','ctx:h')}); s.finish('job_h_old_0001',claim('job_h_old_0001').claim_id,'completed','s','r');
    submit(s,'job_h_new_0001','nh',{m:meta('r2','ctx:h'),revises:revises('job_h_old_0001','oh')});
    stale(()=>s.reserveApply('job_h_old_0001',{present:true}));
    // A job already applied is not reserved again; a reservation needs a finished job.
    assert.equal(s.reserveApply('job_p2_old_0001').state,'applied');
    submit(s,'job_p4_old_0001','op4',{m:meta('r1','ctx:p4')});
    assert.throws(()=>s.reserveApply('job_p4_old_0001'),/only a finished assignment/);
    pass('(e) apply is two-phase: the fence is at the reserve, a correction after it is new work, a release leaves the job unapplied, a reservation survives a restart');

    // ---- The link is durable and only a link: the schema.
    assert.deepEqual(s.db.prepare("SELECT name FROM pragma_table_info('job_revisions') ORDER BY cid").all().map(c=>c.name),['request_id','prior_id','input_revision','at']);
    assert.equal(s.db.prepare('PRAGMA user_version').get().user_version>=71,true);
    assert.equal(s.db.prepare('PRAGMA foreign_key_check').all().length,0);
    pass('job_revisions has the planned columns and its foreign keys hold');
  } finally { try { s.db.close(); } catch {} fs.rmSync(root,{recursive:true,force:true}); }
}
