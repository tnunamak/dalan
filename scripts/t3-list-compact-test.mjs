#!/usr/bin/env node
// t3_thread_list compact contract: newest first, at most THREAD_LIST_LIMIT threads and THREAD_LIST_BUDGET bytes of
// entries, compact fields only, total/shown/truncated, per-project counts (capped), and a large synthetic
// response under 20 KB on the wire.
import assert from 'node:assert/strict';
import { compactThreadList, THREAD_LIST_LIMIT, THREAD_LIST_BUDGET } from '../src/t3-control.mjs';
import { syntheticThreadList } from './fixtures/t3-threads.mjs';

const wire=result=>Buffer.byteLength(JSON.stringify({jsonrpc:'2.0',id:'00000000-0000-4000-8000-000000000006',result:{content:[{type:'text',text:JSON.stringify(result)}],isError:false}}));
const fields=['id','title','projectId','status','runStatus','activityRunStatus','updatedAt','latestUserMessageAt','pendingRuntimeRequest','branch','worktreePath'];

assert.equal(THREAD_LIST_LIMIT,50);
const fixture=syntheticThreadList();
const fullBytes=wire(fixture), result=compactThreadList(fixture), bytes=wire(result);
assert(fullBytes>900000,`synthetic fixture too small: ${fullBytes}`);
assert(bytes<20000,`compact response ${bytes} bytes >= 20000`);
assert.equal(result.total,512);assert.equal(result.shown,result.threads.length);assert.equal(result.truncated,true);
assert(result.shown>=30&&result.shown<=THREAD_LIST_LIMIT,`shown ${result.shown}`);
assert(result.threads.reduce((n,t)=>n+Buffer.byteLength(JSON.stringify(t))+1,0)<=THREAD_LIST_BUDGET,'thread entries over the budget');
for(const t of result.threads) for(const key of Object.keys(t)) assert(fields.includes(key),`non-compact field ${key}`);
const sorted=fixture.threads.toSorted((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
assert.deepEqual(result.threads.map(t=>t.id),sorted.slice(0,result.shown).map(t=>t.id),'not the newest threads by updatedAt');
for(let i=1;i<result.threads.length;i++) assert(result.threads[i-1].updatedAt>=result.threads[i].updatedAt,'not sorted desc');
assert.equal(result.projects.reduce((n,p)=>n+p.count,0),512,'project counts cover every thread, not only shown ones');
assert(result.projects.every(p=>typeof p.title==='string'&&Object.keys(p).join()==='id,title,count'),'project shape');
assert.equal(result.hint,'narrow with projectId or cwd; full paging after a catalog update');
console.log(`PASS synthetic 512-thread list: ${fullBytes} bytes full -> ${bytes} bytes compact, ${result.shown} shown`);

// limit binds when entries are small; override for tests
const small={threads:Array.from({length:120},(_,i)=>({id:`t${String(i).padStart(3,'0')}`,title:'x',projectId:`p${i%3}`,status:'active',runStatus:'idle',updatedAt:new Date(Date.UTC(2000,0,1,0,i)).toISOString(),limitRecovery:{a:1},modelSelection:{b:2}})),projects:[{id:'p0',title:'zero'},{id:'p1',title:'one'}]};
const fifty=compactThreadList(small);
assert.deepEqual([fifty.total,fifty.shown,fifty.truncated],[120,50,true]);assert.equal(fifty.threads[0].id,'t119');assert.equal(fifty.threads[49].id,'t070');
assert.deepEqual(fifty.projects,[{id:'p0',title:'zero',count:40},{id:'p1',title:'one',count:40},{id:'p2',title:null,count:40}]);
const three=compactThreadList(small,{limit:3});assert.deepEqual(three.threads.map(t=>t.id),['t119','t118','t117']);
assert.deepEqual(compactThreadList({threads:small.threads.slice(0,2)}),{...compactThreadList({threads:small.threads.slice(0,2)}),total:2,shown:2,truncated:false});
assert.deepEqual(compactThreadList({}),{threads:[],total:0,shown:0,truncated:false,projects:[],hint:'narrow with projectId or cwd; full paging after a catalog update'});
// budget binds; the first entry is always shown
assert.equal(compactThreadList(small,{budget:1}).shown,1);
// field mapping: title clip, booleans, short branch/worktree only, activityRunStatus only when set
const [one]=compactThreadList({threads:[{id:'a',title:'y'.repeat(300),projectId:'p',status:'active',runStatus:'running',activityRunStatus:'running',updatedAt:'2000-01-01T00:00:00.000Z',latestUserMessageAt:'1999-12-31T00:00:00.000Z',pendingRuntimeRequest:{id:'r',kind:'approval'},branch:'feature/x',worktreePath:'/w/'+'z'.repeat(200)}]}).threads;
assert.equal(one.title.length,120);assert(one.title.endsWith('…'));
assert.deepEqual(JSON.parse(JSON.stringify(one)),{id:'a',title:one.title,projectId:'p',status:'active',runStatus:'running',activityRunStatus:'running',updatedAt:'2000-01-01T00:00:00.000Z',latestUserMessageAt:'1999-12-31T00:00:00.000Z',pendingRuntimeRequest:true,branch:'feature/x'});
const [two]=compactThreadList({threads:[{id:'b',pendingRuntimeRequest:null,activityRunStatus:null}]}).threads;
assert.equal(two.pendingRuntimeRequest,false);assert(!('activityRunStatus' in JSON.parse(JSON.stringify(two))));
// project list capped at 20 with projects_total
const many=compactThreadList({threads:Array.from({length:30},(_,i)=>({id:`m${i}`,projectId:`proj${i}`,updatedAt:'2000-01-01T00:00:00.000Z'}))});
assert.equal(many.projects.length,20);assert.equal(many.projects_total,30);
console.log('PASS compact list: limit 50 (overridable), byte budget, sort desc, field mapping, projects with counts capped at 20, total/shown/truncated');
