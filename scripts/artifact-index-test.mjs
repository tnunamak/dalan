#!/usr/bin/env node
// get/wait index artifact ids from bridge responses. A hostile or malformed id must never throw or write outside artifact-index.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'ai-')), root=path.join(home,'.local/share/dot-bridge'), receipts=path.join(root,'receipts');
const requestId='req_artifactindex01', good='art_goodartifact01', bad=['../../escape','a/b','art_short'];
fs.mkdirSync(receipts,{recursive:true,mode:0o700});
fs.writeFileSync(path.join(receipts,createHash('sha256').update(requestId).digest('hex')+'.json'),JSON.stringify({request_id:requestId,token:'t'.repeat(32),body:'x',delivery:'none'})+'\n');
const result={status:'finished',artifacts:[{id:bad[0]},{id:good}],artifact_ids:[bad[1]],checks:[{output_artifact_id:bad[2]}],
  report:{workspace_evidence:{patch_artifact:{artifact_id:'../patch'},artifacts:[{id:'x/../../y'}],checks:[{output_artifact_id:'a\\b'}]}}};
const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(result));});
await new Promise(r=>server.listen(path.join(root,'admin.sock'),r));
const escapes=[path.join(home,'.local/escape'),path.join(home,'.local/patch'),path.join(home,'.local/share/y')];
for(const e of escapes) fs.writeFileSync(e,'precious\n');

function run(...argv) {
  return new Promise(resolve=>{
    const child=spawn(process.execPath,[new URL('../bin/dot-worker.mjs',import.meta.url).pathname,...argv],{env:{...process.env,HOME:home},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr=''; child.stdout.on('data',b=>stdout+=b); child.stderr.on('data',b=>stderr+=b);
    child.on('close',code=>resolve({code,stdout,stderr}));
  });
}
try {
  for(const argv of [['get',requestId,'--json'],['wait',requestId,'--json']]) {
    const r=await run(...argv), label=argv[0];
    assert.equal(r.code,0,`${label} exit code (stderr: ${r.stderr})`);
    assert.ok(r.stdout.includes(good),`${label} still prints the result`);
    assert.equal(fs.readFileSync(path.join(root,'artifact-index',good),'utf8'),requestId+'\n',`${label} indexes the valid id`);
    for(const e of escapes) assert.equal(fs.readFileSync(e,'utf8'),'precious\n',`${label} left ${e} untouched`);
    assert.equal(fs.existsSync(path.join(root,'artifact-index','a')),false,`${label} made no subdirectory`);
    assert.deepEqual(fs.readdirSync(path.join(root,'artifact-index')),[good],`${label} index holds only the valid id`);
    const warnings=r.stderr.split('\n').filter(l=>l.startsWith('dalan: skipped invalid artifact id in response: '));
    assert.equal(warnings.length,6,`${label} warns once per invalid id, got: ${r.stderr}`);
    assert.ok(warnings.includes('dalan: skipped invalid artifact id in response: "../../escape"'));
  }
  console.log('artifact-index-test ok');
} finally { server.close(); fs.rmSync(home,{recursive:true,force:true}); }
