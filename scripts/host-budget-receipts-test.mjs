#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareHostReceipts,writeHostStart,writeHostStop,readVerifiedHostStop,validateReceiptIdentity} from '../src/host-budget-receipts.mjs';

const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'host-receipt-test-'));
fs.chmodSync(temp,0o700);
const receiptDir=path.join(temp,'receipts'),checkRunId='check_fixture_1',invocationId='a'.repeat(32);
const options={...prepareHostReceipts({receiptDir,checkRunId}),invocationId};
const read=()=>readVerifiedHostStop(options);
const file=kind=>path.join(receiptDir,fs.readdirSync(receiptDir).find(name=>name.endsWith('.'+kind+'.json')));
try {
  assert.equal(prepareHostReceipts({}),null);
  assert.throws(()=>prepareHostReceipts({checkRunId}));
  assert.throws(()=>prepareHostReceipts({receiptDir}));
  for(const id of ['../escape','x/y','','a'.repeat(129)])assert.throws(()=>prepareHostReceipts({receiptDir,checkRunId:id}));
  for(const id of [undefined,'','not-systemd','../escape'])assert.throws(()=>validateReceiptIdentity(checkRunId,id));
  assert.equal(read(),null);
  assert.throws(()=>writeHostStop({...options,verified:true,remaining_pids:[]}));
  writeHostStart(options);
  assert.equal(read(),null);
  const startFile=file('start'),original=fs.readFileSync(startFile);
  assert.throws(()=>writeHostStart(options));
  assert.deepEqual(fs.readFileSync(startFile),original,'collision must not overwrite or delete existing receipt');
  writeHostStop({...options,verified:true,remaining_pids:[]});
  const stop=read();assert.equal(stop.checkRunId,checkRunId);assert.equal(stop.invocationId,invocationId);
  assert.equal(readVerifiedHostStop({...options,checkRunId:'check_other'}),null);
  assert.equal(readVerifiedHostStop({...options,invocationId:'b'.repeat(32)}),null);
  const stopFile=file('stop'),validStop=fs.readFileSync(stopFile);
  for(const patch of [{checkRunId:'check_other'},{invocationId:'b'.repeat(32)},{verified:false},{remaining_pids:[123]},{remaining_pids:null}]) {
    fs.writeFileSync(stopFile,JSON.stringify({...stop,...patch}));
    assert.equal(read(),null);
  }
  fs.writeFileSync(stopFile,validStop);
  fs.writeFileSync(startFile,'{broken');assert.equal(read(),null);
  fs.writeFileSync(startFile,'x'.repeat(4097));assert.equal(read(),null);
  fs.writeFileSync(startFile,original);
  fs.chmodSync(startFile,0o644);assert.equal(read(),null);fs.chmodSync(startFile,0o600);
  fs.chmodSync(stopFile,0o644);assert.equal(read(),null);fs.chmodSync(stopFile,0o600);
  const untouched=path.join(temp,'untouched');fs.writeFileSync(untouched,original,{mode:0o600});
  fs.unlinkSync(startFile);fs.symlinkSync(untouched,startFile);
  assert.equal(read(),null);assert.throws(()=>writeHostStart(options));
  assert.deepEqual(fs.readFileSync(untouched),original);assert.ok(fs.lstatSync(startFile).isSymbolicLink());
  fs.unlinkSync(startFile);fs.writeFileSync(startFile,original,{mode:0o600});
  fs.chmodSync(receiptDir,0o755);assert.equal(read(),null);fs.chmodSync(receiptDir,0o700);
  assert.equal(read().verified,true);
  const alias=path.join(temp,'alias');fs.symlinkSync(receiptDir,alias);
  assert.throws(()=>prepareHostReceipts({receiptDir:alias,checkRunId}));
  assert.equal(readVerifiedHostStop({...options,receiptDir:alias}),null);
  fs.unlinkSync(stopFile);assert.equal(read(),null);
  assert.ok(fs.readdirSync(receiptDir).every(name=>/^[a-f0-9]{64}\.start\.json$/.test(name)));
  console.log('PASS host receipt identity, positive stop, fail-closed reads and no-overwrite publication');
} finally {fs.rmSync(temp,{recursive:true,force:true});}
