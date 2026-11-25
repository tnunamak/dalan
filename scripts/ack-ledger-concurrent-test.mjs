import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AckLedger } from '../src/ack-ledger.mjs';

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ack-ledger-concurrent-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return path.join(dir,'ack.db');
}

function withStaleMissing(t,file,construct) {
  const existsSync=fs.existsSync;
  let stale=true;
  const mock=t.mock.method(fs,'existsSync',function(candidate) {
    if(candidate===file&&stale) { stale=false; return false; }
    return existsSync(candidate);
  });
  try {
    const result=construct();
    assert.equal(stale,false,'constructor must exercise stale existence check');
    return result;
  } finally { mock.mock.restore(); }
}

test('a losing exclusive creator opens the ledger and preserves both acknowledgments',t=>{
  const file=fixture(t);
  let first,second,reopened;
  try {
    first=new AckLedger(file);
    second=withStaleMissing(t,file,()=>new AckLedger(file));
    const a=first.key('synthetic-a','body-a','binding-a');
    const b=second.key('synthetic-b','body-b','binding-b');
    first.record(a,'2026-01-01T00:00:00.000Z');
    second.record(b,'2026-01-01T00:00:01.000Z');
    first.close(); first=null;
    second.close(); second=null;
    reopened=new AckLedger(file);
    assert.equal(reopened.has(a),true);
    assert.equal(reopened.has(b),true);
    assert.equal(fs.statSync(file).mode&0o777,0o600);
  } finally {
    reopened?.close();
    second?.close();
    first?.close();
  }
});

test('existing and competing mode-0644 files remain forbidden',t=>{
  const file=fixture(t);
  fs.writeFileSync(file,'');
  fs.chmodSync(file,0o644);
  const expected=/acknowledgment ledger must be mode 0600/;
  assert.throws(()=>new AckLedger(file),expected);
  assert.throws(()=>withStaleMissing(t,file,()=>new AckLedger(file)),expected);
  assert.equal(fs.statSync(file).mode&0o777,0o644);
});

test('exclusive creation errors other than EEXIST are rethrown unchanged',t=>{
  const file=fixture(t);
  const openSync=fs.openSync;
  const failure=Object.assign(new Error('synthetic access failure'),{code:'EACCES'});
  const mock=t.mock.method(fs,'openSync',function(candidate,flags,...rest) {
    if(candidate===file&&flags==='wx') throw failure;
    return openSync(candidate,flags,...rest);
  });
  try { assert.throws(()=>new AckLedger(file),error=>error===failure); }
  finally { mock.mock.restore(); }
});
