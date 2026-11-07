#!/usr/bin/env node
// sendWebhook must settle within a total deadline even when the receiver keeps the response open by trickling
// bytes (V02). The 10 s socket-inactivity timeout never fires for a receiver that sends one byte every 2 s, so
// one such subscriber used to hold the serialized delivery drain and starve every other subscriber.
import http from 'node:http';
import dns from 'node:dns/promises';
process.env.DOT_BRIDGE_ALLOW_PRIVATE_WEBHOOKS='1';
const {sendWebhook}=await import('../src/webhooks.mjs');
const assert=(x,m)=>{if(!x)throw new Error(m);};
const secret='whsec_'+Buffer.alloc(32,7).toString('base64');
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const sockets=new Set(),track=server=>{server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});return server;};
const trickle=track(http.createServer((req,res)=>{req.resume();res.writeHead(200,{'content-type':'text/plain'});const t=setInterval(()=>res.write('x'),100);res.on('close',()=>clearInterval(t));}));
const idempotencyKeys=[];
const normal=track(http.createServer((req,res)=>{idempotencyKeys.push(req.headers['idempotency-key']);req.resume();res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');}));
const aborted=track(http.createServer((req,res)=>{req.resume();res.writeHead(200,{'content-length':'100'});res.write('abc');setTimeout(()=>res.destroy(),30);}));
try {
 const trickleUrl=`http://127.0.0.1:${await listen(trickle)}/hook`,normalUrl=`http://127.0.0.1:${await listen(normal)}/hook`;
 const started=Date.now();
 const outcome=await Promise.race([
  sendWebhook(trickleUrl,secret,'msg_1','sub_1','{}',{deadlineMs:700}).then(r=>({settled:'resolved',r}),e=>({settled:'rejected',e})),
  new Promise(resolve=>setTimeout(()=>resolve({settled:'never'}),4000).unref()),
 ]);
 assert(outcome.settled==='rejected',`trickling receiver: expected rejection at the deadline, got ${outcome.settled}`);
 assert(outcome.e.message==='timeout',`trickling receiver: expected timeout, got ${outcome.e.message}`);
 assert(Date.now()-started<3000,'trickling receiver: rejected too late');
 const ok=await sendWebhook(normalUrl,secret,'msg_2','sub_2','{}',{deadlineMs:700});
 assert(ok.status===200&&ok.body==='{"ok":true}','normal receiver must still resolve with status and body');
 const retry=await sendWebhook(normalUrl,secret,'msg_2','sub_2','{}',{deadlineMs:700});
 assert(retry.status===200&&idempotencyKeys[0]==='msg_2'&&idempotencyKeys[1]===idempotencyKeys[0],
   'receiver acceptance followed by a lost ACK must reuse the event id as its idempotency key');
 const abortedUrl=`http://127.0.0.1:${await listen(aborted)}/hook`;
 const interrupted=await Promise.race([
  sendWebhook(abortedUrl,secret,'msg_3','sub_3','{}',{deadlineMs:700}).then(()=>({settled:'resolved'}),e=>({settled:'rejected',e})),
  new Promise(resolve=>setTimeout(()=>resolve({settled:'never'}),3000).unref()),
 ]);
 assert(interrupted.settled==='rejected',`aborted response: expected rejection at the deadline, got ${interrupted.settled}`);
 assert(interrupted.e.message==='timeout','aborted response must settle even after the request is destroyed');
 const lookup=dns.lookup;
 try {
  dns.lookup=()=>new Promise(()=>{});
  const stalled=await Promise.race([
   sendWebhook('http://stalled.invalid/hook',secret,'msg_4','sub_4','{}',{deadlineMs:100}).then(()=>({settled:'resolved'}),e=>({settled:'rejected',e})),
   new Promise(resolve=>setTimeout(()=>resolve({settled:'never'}),1000).unref()),
  ]);
  assert(stalled.settled==='rejected'&&stalled.e.message==='timeout','stalled DNS lookup must reach the deadline');
 } finally {dns.lookup=lookup;}
 console.log('PASS sendWebhook enforces a total deadline');
} finally { for(const s of sockets) s.destroy(); trickle.close(); normal.close(); aborted.close(); }
