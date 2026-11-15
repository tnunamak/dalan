import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { createToolRegistry } from '../src/tool-registry.mjs';

const home=fs.mkdtempSync(path.join(os.homedir(),'.tmp/relationship-migration-'));
const file=path.join(home,'bridge.db');
let store;
const snapshot=db=>({
  version:db.prepare('PRAGMA user_version').get().user_version,
  schema:db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all(),
  tables:Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all().map(row=>({...row})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))])),
});
const withoutNewAssignmentColumn=rows=>rows.map(({relationship_id,...row})=>row);
try {
  store=new Store(file);
  const registry=createToolRegistry({store});
  const scope={threads:['00000000-0000-4000-8000-000000000069']};
  registry.initializeT3Grants(['t3_thread_read'],['worker_fixture']);
  registry.grant('t3_thread_read','worker_fixture',scope);
  store.submit({schema_version:1,request_id:'req_migration',brief:'retained payload',inputs:[],expected_output:'result',execution_scope:'read-only'},{mode:'none'},null,'owner');

  // Schema 69 includes C3 grant scopes. C2 only adds this nullable assignment reference
  // and the relationships table, so removing those two additions reconstructs its predecessor.
  store.db.exec('ALTER TABLE assignments DROP COLUMN relationship_id; DROP TABLE relationships; PRAGMA user_version=69;');
  const predecessor=snapshot(store.db);
  const assignmentColumns=store.db.prepare("PRAGMA table_info('assignments')").all();
  assert.equal(predecessor.version,69);
  const grantBefore=predecessor.tables.tool_grants.find(row=>row.tool==='t3_thread_read'&&row.worker==='worker_fixture');
  assert.ok(grantBefore?.scope,'schema 69 fixture must retain the non-null C3 grant scope');
  assert.deepEqual(JSON.parse(grantBefore.scope),scope);
  store.db.close();store=null;

  store=new Store(file);
  const upgraded=snapshot(store.db);
  assert.equal(upgraded.version,70,'schema 69 must advance to 70 in one open');
  assert.deepEqual(upgraded.tables.relationships,[],'new relationships table must be empty');
  assert.ok(upgraded.schema.find(row=>row.type==='table'&&row.name==='relationships'));
  assert.ok(store.db.prepare("SELECT 1 FROM pragma_table_info('assignments') WHERE name='relationship_id'").get());
  const upgradedColumns=store.db.prepare("PRAGMA table_info('assignments')").all();
  assert.deepEqual(upgradedColumns.filter(row=>row.name!=='relationship_id'),assignmentColumns,'existing assignment columns changed');
  assert.equal(upgradedColumns.find(row=>row.name==='relationship_id').notnull,0,'relationship reference must be nullable');
  const foreignKey=store.db.prepare("PRAGMA foreign_key_list('assignments')").all().find(row=>row.from==='relationship_id');
  assert.equal(foreignKey?.table,'relationships');
  assert.equal(foreignKey?.to,'relationship_id');
  assert.equal(upgraded.tables.assignments[0].relationship_id,null,'existing assignment reference must remain NULL');
  assert.deepEqual(upgraded.tables.tool_grants.find(row=>row.tool==='t3_thread_read'&&row.worker==='worker_fixture'),grantBefore,'C3 grant scope changed during migration');
  const unrelatedSchema=rows=>rows.filter(row=>!((row.type==='table'&&['assignments','relationships'].includes(row.name))||row.tbl_name==='relationships'));
  assert.deepEqual(unrelatedSchema(upgraded.schema),unrelatedSchema(predecessor.schema),'migration changed unrelated schema');
  assert.deepEqual(Object.keys(upgraded.tables).filter(name=>name!=='relationships').sort(),Object.keys(predecessor.tables).sort(),'migration changed unrelated table set');
  for(const [name,rows] of Object.entries(predecessor.tables)) {
    assert.deepEqual(name==='assignments'?withoutNewAssignmentColumn(upgraded.tables[name]):upgraded.tables[name],rows,`migration changed existing ${name} data`);
  }
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[],'foreign key check failed');
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');

  store.db.close();store=null;
  store=new Store(file);
  assert.deepEqual(snapshot(store.db),upgraded,'reopening schema 70 must change nothing');
  console.log('MIGRATION: 69 -> 70; 1 C3-scoped grant preserved; reopen 70 unchanged');
} finally {store?.db.close();fs.rmSync(home,{recursive:true,force:true});}
