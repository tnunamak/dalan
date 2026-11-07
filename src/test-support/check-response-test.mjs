import assert from 'node:assert/strict';
import { checkResponse, CHECK_RESPONSE_MS } from '../check-response.mjs';
function clock() {
  let now=0, next=0;
  const jobs=new Map();
  return {
    schedule(fn, ms) { const id=++next; jobs.set(id,{at:now+ms,fn}); return id; },
    cancel(id) { jobs.delete(id); },
    advance(ms) { now+=ms; for(const [id,job] of [...jobs]) if(job.at<=now) {jobs.delete(id);job.fn();} },
    get pending() { return jobs.size; },
  };
}
assert.equal(CHECK_RESPONSE_MS,20000);
{
  const c=clock(), done={status:'completed'};
  assert.equal(await checkResponse(Promise.resolve(done),{status:'running'},c),done);
  assert.equal(c.pending,0);
}
{
  const c=clock(), error=new Error('failed');
  await assert.rejects(checkResponse(Promise.reject(error),{},c),e=>e===error);
  assert.equal(c.pending,0);
}
{
  const c=clock(), running={check_run_id:'same',status:'running'};
  let finish, settled=false;
  const work=new Promise(resolve=>{finish=resolve;});
  const response=checkResponse(work,running,c);
  response.then(()=>{settled=true;});
  c.advance(19999); await Promise.resolve(); await Promise.resolve();
  assert.equal(settled,false);
  c.advance(1); assert.equal(await response,running); assert.equal(c.pending,0);
  finish({status:'completed'}); assert.deepEqual(await work,{status:'completed'});
}
{
  const c=clock(), running={status:'running'};
  const response=checkResponse(new Promise(()=>{}),running,{...c,responseMs:25});
  c.advance(24); assert.equal(c.pending,1);
  c.advance(1); assert.equal(await response,running); assert.equal(c.pending,0);
}
for(const responseMs of [-1,NaN,Infinity]) {
  const c=clock();
  await assert.rejects(checkResponse(Promise.resolve(),{}, {...c,responseMs}),TypeError);
  assert.equal(c.pending,0);
}
console.log('PASS check response virtual deadline, completion, failure and timer disposal');
