import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// The CLI entry point has side effects on load; evaluate only its transport
// and long-poll helpers with a local fake request object and no socket/service.
const source=readFileSync(new URL('../bin/dot-worker.mjs',import.meta.url),'utf8');
function fakeSocket() {
  const req=new EventEmitter();
  let respond, timer;
  req.end=()=>{};
  req.destroy=error=>req.emit('error',error);
  req.setTimeout=(ms,expire)=>{timer={ms,expire};};
  const requestSource=source.slice(source.indexOf('\nfunction request('),source.indexOf('\nfunction download('));
  const waitSource=source.slice(source.indexOf('\nasync function waitForAssignment('),source.indexOf('\n// Records which request owns each artifact'));
  const downloadSource=source.slice(source.indexOf('\nfunction download('),source.indexOf('\nconst artifactIdPattern='));
  let writes=0;
  const helpers=runInNewContext(requestSource+waitSource+downloadSource+'\n({request,waitForAssignment,download})',{
    socket:'/tmp/synthetic-admin.sock',
    http:{request:(_options,response)=>{respond=response;return req;}},
    adminSocketPathError:()=>null, bridgeNotRunning:error=>error,
    receipt:()=>({token:'fixture-only'}), Buffer,
    artifactIdPattern:/^art_[-\w]{8,128}$/, fs:{writeFileSync(){writes+=1;}},
  });
  return {...helpers, writes:()=>writes, timer:()=>timer, reply(body,{status=200,raw=false}={}) {
    const res=new EventEmitter();
    res.statusCode=status;
    respond(res);
    if(!raw||body)res.emit('data',raw?body:JSON.stringify(body));
    res.emit('end');
  }};
}

test('ordinary admin requests time out on a stalled fake socket by default',async()=>{
  const fake=fakeSocket();
  const pending=fake.request('/status');
  assert.equal(fake.timer()?.ms,30000);
  fake.timer().expire();
  await assert.rejects(pending,{code:'ETIMEDOUT',kind:'transport'});
});

test('assignment wait opts out of the default timeout and resolves only on response',async()=>{
  const fake=fakeSocket();
  const pending=fake.waitForAssignment('fixture',null);
  let received=false;
  pending.then(()=>{received=true;});
  await Promise.resolve();
  assert.equal(fake.timer(),undefined);
  assert.equal(received,false);
  fake.reply({status:'finished'});
  assert.equal((await pending).status,'finished');
});

test('download with an empty or non-JSON 502 rejects without output',async()=>{
  for(const body of ['', 'synthetic upstream detail']){
    const fake=fakeSocket();
    const pending=fake.download('art_fixture_123','unused',{});
    const rejected=assert.rejects(pending,/HTTP 502/);
    assert.doesNotThrow(()=>fake.reply(body,{status:502,raw:true}));
    await rejected;
    assert.equal(fake.writes(),0);
  }
});

test('explicit positive admin timeout is preserved',async()=>{
  const fake=fakeSocket();
  const pending=fake.request('/status','GET',null,{},15);
  assert.equal(fake.timer()?.ms,15);
  fake.timer().expire();
  await assert.rejects(pending,{code:'ETIMEDOUT',kind:'transport'});
});
