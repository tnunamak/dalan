import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {changedColumns,fullSnapshot} from '../src/test-support/full-snapshot.mjs';

test('changedColumns compares exact SQLite values and preserves key order',()=>{
  for(const value of [Infinity,NaN]) assert.deepEqual(changedColumns({v:null},{v:value}),['v']);
  assert.deepEqual(changedColumns({v:Buffer.from('a')},{v:Buffer.from('b')}),['v']);
  assert.deepEqual(changedColumns({v:new Uint8Array([1])},{v:new Uint8Array([2])}),['v']);
  assert.deepEqual(changedColumns({v:1n},{v:1n}),[]);
  assert.deepEqual(changedColumns({v:1},{v:1n}),['v']);
  assert.deepEqual(changedColumns({v:NaN},{v:NaN}),[]);
  assert.deepEqual(changedColumns({v:Infinity},{v:Infinity}),[]);
  assert.deepEqual(changedColumns({v:Buffer.from('a')},{v:Buffer.from('a')}),[]);
  assert.deepEqual(changedColumns({v:null,n:2,s:'same'},{v:null,n:2,s:'same'}),[]);
  assert.deepEqual(changedColumns({z:1,a:2},{a:3,z:4,new:5}),['z','a','new']);
});

function memory(t) {
  const db=new DatabaseSync(':memory:');
  t.after(()=>db.close());
  return db;
}

test('WITHOUT ROWID with request_id as sole primary key is snapshotable',t=>{
  const db=memory(t);
  db.exec('CREATE TABLE w(request_id TEXT PRIMARY KEY, v BLOB) WITHOUT ROWID');
  const insert=db.prepare('INSERT INTO w VALUES(?,?)');
  insert.run('r2',Buffer.from('other'));
  insert.run('r1',Buffer.from('a'));
  const rows=fullSnapshot(db,'r1').w;
  assert.equal(rows.length,1);
  assert.equal(rows[0].request_id,'r1');
  assert.deepEqual(Buffer.from(rows[0].v),Buffer.from('a'));
});

test('WITHOUT ROWID scopes two rows and orders composite primary keys',t=>{
  const db=memory(t);
  // A sole request_id primary key cannot hold two r1 rows. Use a composite key.
  db.exec('CREATE TABLE w(request_id TEXT, seq INTEGER, v BLOB, PRIMARY KEY(request_id,seq)) WITHOUT ROWID');
  const insert=db.prepare('INSERT INTO w VALUES(?,?,?)');
  insert.run('r1',20,Buffer.from('b'));
  insert.run('r2',0,Buffer.from('other'));
  insert.run('r1',10,Buffer.from('a'));
  const rows=fullSnapshot(db,'r1').w;
  assert.deepEqual(rows.map(row=>[row.request_id,row.seq,Buffer.from(row.v).toString()]),
    [['r1',10,'a'],['r1',20,'b']]);
});

test('compared WITHOUT ROWID tables use pk order rather than column order',t=>{
  const db=memory(t);
  db.exec('CREATE TABLE messages(a INTEGER,b INTEGER,PRIMARY KEY(b,a)) WITHOUT ROWID');
  db.exec('INSERT INTO messages VALUES(1,2),(9,1),(3,1)');
  assert.deepEqual(fullSnapshot(db,'r1').messages.map(row=>[row.a,row.b]),[[3,1],[9,1],[1,2]]);
});

test('ordinary scoped tables retain rowid order',t=>{
  const db=memory(t);
  db.exec("CREATE TABLE w(request_id TEXT,v INTEGER); INSERT INTO w VALUES('r1',20),('r1',10),('r2',0)");
  assert.deepEqual(fullSnapshot(db,'r1').w.map(row=>row.v),[20,10]);
});

test('unlisted unscoped tables still fail closed',t=>{
  const db=memory(t);
  db.exec('CREATE TABLE unknown(v BLOB)');
  assert.throws(()=>fullSnapshot(db,'r1'),/full snapshot cannot scope table unknown/);
});
