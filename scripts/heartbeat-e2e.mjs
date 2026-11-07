import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-heartbeat-e2e-'));
const root=path.join(home,'.local/share/dot-bridge'),config=path.join(home,'.config/dot-bridge');
fs.mkdirSync(root,{recursive:true});fs.mkdirSync(config,{recursive:true});
let pings=0,status={counts:[],paused:false,claimed_outer_count:0};
const bridge=http.createServer((req,res)=>res.end(JSON.stringify(status)));
const receiver=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req) raw+=chunk;
  assert.equal(req.url,'/heartbeat');assert.equal(req.headers.authorization,'Bearer '+ 't'.repeat(32));assert.deepEqual(JSON.parse(raw),{healthy:true});
  pings++;res.writeHead(202);res.end('{}');
});
await new Promise(resolve=>bridge.listen(path.join(root,'admin.sock'),resolve));
await new Promise(resolve=>receiver.listen(0,'127.0.0.1',resolve));
const envFile=path.join(config,'deadman.env'),health=path.join(root,'health.json'),drainer=path.join(root,'drainer-health.json');
const env={...process.env,HOME:home,DOT_DEADMAN_ENV:envFile,DOT_DEADMAN_URL:'',DOT_DEADMAN_TOKEN:'',DOT_BRIDGE_HEALTH_FILE:health};
// Empty environment fields must be removed so the private file supplies them.
delete env.DOT_DEADMAN_URL;delete env.DOT_DEADMAN_TOKEN;
delete env.DALAN_DRAINER_HEALTH_FILE;delete env.DOT_BRIDGE_DRAINER_HEALTH_FILE;
delete env.DALAN_HEALTH_FILE;
fs.writeFileSync(envFile,`DOT_DEADMAN_URL=http://127.0.0.1:${receiver.address().port}\nDOT_DEADMAN_TOKEN=${'t'.repeat(32)}\n`,{mode:0o600});
const write=value=>fs.writeFileSync(drainer,JSON.stringify({healthy:true,observed_at:new Date().toISOString(),...value}));
async function run(ok) {
  try {const result=await promisify(execFile)(process.execPath,['bin/dot-heartbeat.mjs'],{cwd:new URL('..',import.meta.url),env,timeout:15000});assert(ok,'heartbeat unexpectedly succeeded');assert.equal(result.stdout.trim(),'heartbeat accepted');}
  catch(error){if(ok)throw error;assert.equal(error.code,1,error.stderr);assert(!fs.existsSync(health),'failed check retained positive health');assert(!error.stderr.includes('t'.repeat(32)),'secret in error');}
}
try {
  await run(true);assert.equal(pings,1);assert.equal(JSON.parse(fs.readFileSync(health)).healthy,true);
  status.paused=true;write({observed_at:new Date(Date.now()-151000).toISOString()});await run(true);assert.equal(pings,2,'intentional pause is healthy; ping sent');
  fs.writeFileSync(envFile,`DOT_DEADMAN_URL='http://127.0.0.1:${receiver.address().port}'\r\nDOT_DEADMAN_TOKEN="${'t'.repeat(32)}"\r\n`);
  write();await run(true);assert.equal(pings,3,'quoted CRLF config did not load');
  const validUrl=`http://127.0.0.1:${receiver.address().port}`;
  for(const values of [
    {DOT_DEADMAN_TOKEN:'short'},
    {DOT_DEADMAN_TOKEN:'t'.repeat(32)+'\t'},
    {DOT_DEADMAN_URL:`http://private-user:private-password@127.0.0.1:${receiver.address().port}`},
    {DOT_DEADMAN_URL:'ftp://localhost/monitor'}
  ]) {
    Object.assign(env,{DOT_DEADMAN_URL:validUrl,DOT_DEADMAN_TOKEN:'t'.repeat(32)},values);
    write();await run(false);assert.equal(pings,3,'invalid configuration sent a heartbeat');
  }
  delete env.DOT_DEADMAN_URL;delete env.DOT_DEADMAN_TOKEN;
  write({observed_at:new Date(Date.now()-151000).toISOString()});await run(true);assert.equal(pings,4,'stale drainer file without a drainer variable suppressed ping');
  env.DOT_BRIDGE_DRAINER_HEALTH_FILE=drainer;await run(false);assert.equal(pings,4,'legacy drainer variable did not enable the gate');delete env.DOT_BRIDGE_DRAINER_HEALTH_FILE;
  env.DALAN_DRAINER_HEALTH_FILE=drainer;
  fs.rmSync(drainer);await run(false);assert.equal(pings,4,'missing opted-in evidence emitted a ping');
  write({observed_at:new Date(Date.now()+60000).toISOString()});await run(false);assert.equal(pings,4,'future opted-in evidence emitted a ping');
  write();await run(true);assert.equal(pings,5,'fresh opted-in evidence suppressed ping');
  write({healthy:false});await run(false);assert.equal(pings,5);
  write({observed_at:new Date(Date.now()-151000).toISOString()});await run(false);assert.equal(pings,5);
  write();status={};await run(false);assert.equal(pings,5);
  status={counts:[],paused:false,claimed_outer_count:0};fs.chmodSync(envFile,0o644);await run(false);assert.equal(pings,5);fs.chmodSync(envFile,0o600);
  await new Promise(resolve=>bridge.close(resolve));await run(false);assert.equal(pings,5,'missing bridge emitted external ping');
  console.log('PASS real heartbeat CLI: mandatory socket and optional drainer gate, private config, receiver acceptance, pause, and failures send no heartbeat');
} finally {bridge.close();await new Promise(resolve=>receiver.close(resolve));fs.rmSync(home,{recursive:true,force:true});}
