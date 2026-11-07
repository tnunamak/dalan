#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeadmanFromEnv } from '../src/deadman.mjs';

const directory=await mkdtemp(join(tmpdir(),'deadman-transport-'));
const token='local-test-token-'.padEnd(40,'x'),minute=60000;
const servers=new Set(),monitors=new Set(),fillers=[];
let listener;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function listen(server,port=0) { servers.add(server);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});return server.address().port; }
async function closeServer(server) { if(!servers.delete(server))return;server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve)); }
function monitor(name,url,clock={wall:1800000000000,elapsed:0}) {
  const m=createDeadmanFromEnv({DOT_DEADMAN_TOKEN:token,DOT_DEADMAN_DB:join(directory,name+'.sqlite'),DOT_DEADMAN_NTFY_URL:url});
  m.now=()=>clock.wall;m.elapsedNow=()=>clock.elapsed;m.logicalAtStart=clock.wall;m.elapsedAtStart=clock.elapsed;
  m.db.prepare('UPDATE monitor SET started_at=?,logical_now=?,wall_at=?').run(clock.wall,clock.wall,clock.wall);
  monitors.add(m);
  return {m,clock,advance:ms=>{clock.wall+=ms;clock.elapsed+=ms;}};
}
async function closeMonitor(m) { if(monitors.delete(m))await m.close(); }
async function miss(fixture) { fixture.advance(5*minute+1);const started=Date.now();await fixture.m.tick();return Date.now()-started; }
const episode=fixture=>fixture.m.status().episodes[0];
function expect(fixture,state,reason) { assert.equal(episode(fixture).initial_state,state);if(reason)assert.match(episode(fixture).last_error,reason); }
async function stopListener() {
  if(!listener)return;
  const child=listener;listener=null;
  if(child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));process.kill(child.pid,'SIGCONT');child.kill('SIGTERM');await exited;}
}
try {
  for(const badToken of ['private-publisher-token\r','private-publisher-token\n','private-publisher-token\0','private-publisher-token\t']){
    const file=join(directory,'bad-token.sqlite');
    assert.throws(()=>createDeadmanFromEnv({DOT_DEADMAN_TOKEN:token,DOT_DEADMAN_DB:file,DOT_DEADMAN_NTFY_URL:'http://127.0.0.1:1/topic',DOT_DEADMAN_NTFY_TOKEN:badToken}),error=>error.message==='invalid dead-man publisher authorization token'&&!error.message.includes('private-publisher-token'),'bad publisher token was not rejected safely at startup');
    await assert.rejects(stat(file),{code:'ENOENT'},'bad publisher configuration created monitor state');
  }
  assert.throws(()=>createDeadmanFromEnv({DOT_DEADMAN_TOKEN:token,DOT_DEADMAN_DB:join(directory,'userinfo.sqlite'),DOT_DEADMAN_NTFY_URL:'https://private-user:private-password@localhost/topic'}),error=>error.message==='dead-man publisher URL must not contain credentials'&&!error.message.includes('private-password'),'publisher URL credentials were not rejected safely');
  const reservation=net.createServer(),closedPort=await listen(reservation);await closeServer(reservation);
  const refused=monitor('refused',`http://127.0.0.1:${closedPort}/topic`);await miss(refused);expect(refused,'pending',/publisher_connect_econnrefused/);
  refused.advance(minute);await refused.m.tick();expect(refused,'pending',/publisher_connect_econnrefused/);await closeMonitor(refused.m);

  let status=429,calls=0;
  const publisher=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    calls++;assert.equal(req.method,'POST');assert.equal(req.url,'/proxy/topic');assert.match(req.headers.title,/Dalan/);assert.match(body,/heartbeat/);
    res.writeHead(status,status===307?{Location:'/redirect-target'}:{}).end();
  });
  const publisherPort=await listen(publisher),url=`http://127.0.0.1:${publisherPort}/proxy/topic`;
  const rejected=monitor('429',url);await miss(rejected);expect(rejected,'pending',/publisher_http_429/);assert.equal(calls,1);
  rejected.advance(minute);await rejected.m.tick();assert.equal(calls,2,'confirmed rejection was not retried');expect(rejected,'pending');await closeMonitor(rejected.m);

  status=307;calls=0;let redirected=monitor('307',url);await miss(redirected);expect(redirected,'configuration_error',/publisher_redirect_http_307/);
  const redirectEpisode=episode(redirected).id;redirected.advance(3*60*minute);await redirected.m.tick();assert.equal(calls,1,'redirect followed or retried without restart');await closeMonitor(redirected.m);
  status=200;redirected=monitor('307',url,redirected.clock);await redirected.m.tick();expect(redirected,'sent');assert.equal(episode(redirected).id,redirectEpisode,'restart replaced configuration-error episode');assert.equal(calls,2,'corrected publisher did not retry on restart');await closeMonitor(redirected.m);

  calls=0;const accepted=monitor('200',url);await miss(accepted);expect(accepted,'sent');assert.equal(calls,1);
  accepted.advance(120*minute-1);await accepted.m.tick();assert.equal(calls,1,'reminder sent early');accepted.advance(1);await accepted.m.tick();assert.equal(calls,2);assert.equal(episode(accepted).reminder_state,'sent');
  accepted.advance(120*minute);await accepted.m.tick();assert.equal(calls,2,'duplicate confirmed reminder');
  for(let i=0;i<=15;i++){if(i)accepted.advance(minute);assert.equal((await accepted.m.heartbeat(token,{healthy:true})).status,202);}
  assert.equal(accepted.m.status().active_episode_id,null,'15-minute recovery did not clear');assert.equal(calls,2,'recovery sent extra notice');await closeMonitor(accepted.m);

  status=503;calls=0;const ambiguous=monitor('503',url);await miss(ambiguous);expect(ambiguous,'uncertain');ambiguous.advance(3*60*minute);await ambiguous.m.tick();assert.equal(calls,1,'5xx outcome retried');await closeMonitor(ambiguous.m);await closeServer(publisher);

  let received=0;const noReply=http.createServer(async(req)=>{for await(const chunk of req)void chunk;received++;});
  const noReplyPort=await listen(noReply),hungResponse=monitor('no-reply',`http://127.0.0.1:${noReplyPort}/topic`);
  const responseTime=await miss(hungResponse);expect(hungResponse,'uncertain');assert.equal(received,1,'fixture never received the request');assert(responseTime>=4500&&responseTime<8000,'response deadline did not bound publication');
  hungResponse.advance(3*60*minute);await hungResponse.m.tick();assert.equal(received,1,'accepted request with lost response was resent');await closeMonitor(hungResponse.m);await closeServer(noReply);

  const plaintext=http.createServer((req,res)=>res.end('plaintext'));
  const plaintextPort=await listen(plaintext),tlsFailure=monitor('tls-mismatch',`https://127.0.0.1:${plaintextPort}/topic`);
  await miss(tlsFailure);expect(tlsFailure,'configuration_error',/publisher_tls_(eproto|err_ssl_)/);
  const tlsEpisode=episode(tlsFailure).id;tlsFailure.advance(3*60*minute);await tlsFailure.m.tick();expect(tlsFailure,'configuration_error');await closeMonitor(tlsFailure.m);
  const corrected=monitor('tls-mismatch',`http://127.0.0.1:${plaintextPort}/topic`,tlsFailure.clock);await corrected.m.tick();expect(corrected,'sent');assert.equal(episode(corrected).id,tlsEpisode);await closeMonitor(corrected.m);await closeServer(plaintext);

  let droppedConnections=0;
  const earlyClose=net.createServer(socket=>{droppedConnections++;socket.destroy();});
  const earlyClosePort=await listen(earlyClose),dropped=monitor('tls-early-close',`https://127.0.0.1:${earlyClosePort}/topic`);
  await miss(dropped);expect(dropped,'pending',/publisher_connect_before_transport_ready/);assert.equal(droppedConnections,1);
  dropped.advance(minute);await dropped.m.tick();expect(dropped,'pending');assert.equal(droppedConnections,2,'TLS peer closing before handshake was not retried');
  await closeMonitor(dropped.m);await closeServer(earlyClose);

  // Stop a tiny-backlog loopback listener and fill its accept queue. Further
  // connects cannot complete, so this tests the real transport deadline phase.
  listener=spawn(process.execPath,['-e',"require('net').createServer().listen({port:0,host:'127.0.0.1',backlog:1},function(){console.log(this.address().port)})"],{stdio:['ignore','pipe','pipe']});
  const hungPort=Number(await new Promise((resolve,reject)=>{listener.once('error',reject);listener.stdout.once('data',chunk=>resolve(String(chunk).trim()));}));assert(hungPort>0);
  process.kill(listener.pid,'SIGSTOP');
  for(let i=0;i<12;i++){const socket=net.connect(hungPort,'127.0.0.1');socket.on('error',()=>{});fillers.push(socket);}
  await sleep(500);assert(fillers.some(socket=>socket.connecting),'fixture did not saturate accept queue');
  const hungConnect=monitor('connect-hang',`http://127.0.0.1:${hungPort}/topic`);const connectTime=await miss(hungConnect);expect(hungConnect,'pending',/publisher_connect_timeout/);assert(connectTime>=4500&&connectTime<8000,'connect deadline did not bound publication');
  fillers.splice(0).forEach(socket=>socket.destroy());await stopListener();
  let recoveredCalls=0;const recoveredPublisher=http.createServer((req,res)=>{recoveredCalls++;res.end();});await listen(recoveredPublisher,hungPort);
  hungConnect.advance(minute);await hungConnect.m.tick();expect(hungConnect,'sent');assert.equal(recoveredCalls,1,'pre-connect timeout could not recover');assert.equal(hungConnect.m.status().episodes.length,1);
  await closeMonitor(hungConnect.m);await closeServer(recoveredPublisher);
  console.log('PASS real publisher refused/429/307/200/503, connected timeout, TLS configuration recovery, early TLS close retry, startup credential rejection, pre-connect timeout retry, one reminder, and 15-minute clear');
} finally {
  fillers.forEach(socket=>socket.destroy());await stopListener();
  for(const m of [...monitors])await closeMonitor(m);
  for(const server of [...servers])await closeServer(server);
  await rm(directory,{recursive:true,force:true});
}
