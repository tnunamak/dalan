import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const repo=path.resolve(new URL('..',import.meta.url).pathname);
const scratch=()=>fs.mkdtempSync(path.join(os.tmpdir(),'dalan-drain-test-'));

for(const phase of ['pause','claims']) test(`upgrade drain bounds a hanging ${phase} command and explains recovery`,()=>{
  const root=scratch(),bin=path.join(root,'bin');fs.mkdirSync(bin,{recursive:true});
  try {
    fs.writeFileSync(path.join(bin,'dot-worker.mjs'),`const args=process.argv.slice(2); if(args[0]==='${phase}') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000); else if(args[0]==='claims') process.stdout.write(JSON.stringify({claims:[]})); else process.stdout.write(JSON.stringify({ok:true}));\n`);
    const result=spawnSync(process.execPath,[path.join(repo,'scripts/upgrade-drain.mjs')],{cwd:root,env:{...process.env,PATH:process.env.PATH,DALAN_UPGRADE_DRAIN_TIMEOUT_MS:'1000'},encoding:'utf8',timeout:5000});
    assert.notEqual(result.status,0,'a hanging old command must time out');
    assert.match(result.stderr,/Upgrade drain timed out during (pause|claims)/);
    assert.match(result.stderr,/dalan resume/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('upgrade drain times out on a claim that stays active and names the resume step',()=>{
  const root=scratch(),bin=path.join(root,'bin');fs.mkdirSync(bin,{recursive:true});
  try {
    fs.writeFileSync(path.join(bin,'dot-worker.mjs'),`const args=process.argv.slice(2); if(args[0]==='claims') process.stdout.write(JSON.stringify({claims:[{request_id:'req_active',lease_expires_at:new Date(Date.now()+3600000).toISOString()}]})); else process.stdout.write(JSON.stringify({ok:true}));\n`);
    const result=spawnSync(process.execPath,[path.join(repo,'scripts/upgrade-drain.mjs')],{cwd:root,env:{...process.env,DALAN_UPGRADE_DRAIN_TIMEOUT_MS:'1000'},encoding:'utf8',timeout:5000});
    assert.notEqual(result.status,0,'an active claim must not let the drain report success');
    assert.match(result.stdout,/Waiting for req_active/);
    assert.match(result.stderr,/Upgrade drain timed out (during claims\.|while claims were still active)/);
    assert.match(result.stderr,/dalan resume/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('upgrade drain treats an invalid lease date as open and names the claim',()=>{
  const root=scratch(),bin=path.join(root,'bin');fs.mkdirSync(bin,{recursive:true});
  try {
    fs.writeFileSync(path.join(bin,'dot-worker.mjs'),`const args=process.argv.slice(2); if(args[0]==='claims') process.stdout.write(JSON.stringify({claims:[{request_id:'req_bad_date',lease_expires_at:'not-a-date'}]})); else process.stdout.write(JSON.stringify({ok:true}));\n`);
    const result=spawnSync(process.execPath,[path.join(repo,'scripts/upgrade-drain.mjs')],{cwd:root,env:{...process.env,DALAN_UPGRADE_DRAIN_TIMEOUT_MS:'1000'},encoding:'utf8',timeout:5000});
    assert.notEqual(result.status,0,'an invalid lease date must fail closed');
    assert.match(result.stdout,/Waiting for req_bad_date; lease expires not-a-date/);
    assert.match(result.stderr,/dalan resume/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('upgrade drain names the resume step when a command fails after the pause',()=>{
  const root=scratch(),bin=path.join(root,'bin');fs.mkdirSync(bin,{recursive:true});
  try {
    fs.writeFileSync(path.join(bin,'dot-worker.mjs'),`const args=process.argv.slice(2); if(args[0]==='claims') process.stdout.write('not json'); else process.stdout.write(JSON.stringify({ok:true}));\n`);
    const result=spawnSync(process.execPath,[path.join(repo,'scripts/upgrade-drain.mjs')],{cwd:root,env:{...process.env,DALAN_UPGRADE_DRAIN_TIMEOUT_MS:'5000'},encoding:'utf8',timeout:5000});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/dalan claims printed no JSON/);
    assert.match(result.stderr,/dalan resume/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

for(const phase of ['pause','claims']) test(`upgrade drain prints recovery after the ${phase} HTTP error`,()=>{
  const root=scratch(),bin=path.join(root,'bin');fs.mkdirSync(bin,{recursive:true});
  try {
    fs.writeFileSync(path.join(bin,'dot-worker.mjs'),`const args=process.argv.slice(2); if(args[0]==='${phase}') {process.stderr.write('HTTP 503');process.exit(1)} process.stdout.write(JSON.stringify({claims:[]}));\n`);
    const result=spawnSync(process.execPath,[path.join(repo,'scripts/upgrade-drain.mjs')],{cwd:root,env:{...process.env,DALAN_UPGRADE_DRAIN_TIMEOUT_MS:'5000'},encoding:'utf8',timeout:5000});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/resume/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

for(const phase of ['pause','claims']) test(`upgrade drain prints recovery after bad ${phase} JSON`,()=>{
  const root=scratch(),bin=path.join(root,'bin');fs.mkdirSync(bin,{recursive:true});
  try {
    fs.writeFileSync(path.join(bin,'dot-worker.mjs'),`const args=process.argv.slice(2); process.stdout.write(args[0]==='${phase}'?'not-json':JSON.stringify({claims:[]}));\n`);
    const result=spawnSync(process.execPath,[path.join(repo,'scripts/upgrade-drain.mjs')],{cwd:root,env:{...process.env,DALAN_UPGRADE_DRAIN_TIMEOUT_MS:'5000'},encoding:'utf8',timeout:5000});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/resume/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('upgrade drain prints the post-upgrade resume command on success',()=>{
  const root=scratch(),bin=path.join(root,'bin');fs.mkdirSync(bin,{recursive:true});
  try {
    fs.writeFileSync(path.join(bin,'dot-worker.mjs'),`process.stdout.write(JSON.stringify({claims:[]}));\n`);
    const result=spawnSync(process.execPath,[path.join(repo,'scripts/upgrade-drain.mjs')],{cwd:root,env:{...process.env,DALAN_UPGRADE_DRAIN_TIMEOUT_MS:'5000'},encoding:'utf8',timeout:5000});
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/start the new service.*run `?dalan resume/s);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('invalid drain timeout still prints the resume recovery hint',()=>{
  const root=scratch();
  try {
    const result=spawnSync(process.execPath,[path.join(repo,'scripts/upgrade-drain.mjs')],{cwd:root,env:{...process.env,DALAN_UPGRADE_DRAIN_TIMEOUT_MS:'invalid'},encoding:'utf8',timeout:5000});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/resume/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
