import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { createToolRegistry } from '../src/tool-registry.mjs';

const home=fs.mkdtempSync(path.join(os.homedir(),'.tmp/c3-migration-'));
const file=path.join(home,'bridge.db');
let store;
const snapshot=db=>({
  version:db.prepare('PRAGMA user_version').get().user_version,
  schema:db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all(),
  tables:Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all().map(row=>({...row})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))])),
});
try {
  store=new Store(file);
  const registry=createToolRegistry({store,handlers:{echo:{run:async()=>null}}});
  registry.register({name:'migration_fixture',description:'existing grant',class:'read',inputSchema:{type:'object',properties:{},additionalProperties:false},handler:{kind:'echo'}});
  registry.grant('migration_fixture','dot');
  store.submit({schema_version:1,request_id:'req_migration',brief:'retained payload',inputs:[],expected_output:'result',execution_scope:'read-only'},{mode:'none'},null,'owner');
  // Rewind only C3's scope addition, retaining unrelated later schema fields.
  // The current Store must restore scope without changing any other data or schema.
  store.db.exec('ALTER TABLE tool_grants DROP COLUMN scope; PRAGMA user_version=68;');
  assert(store.db.prepare("SELECT 1 FROM pragma_table_info('assignments') WHERE name='parent_generation'").get());
  assert(store.db.prepare("SELECT 1 FROM pragma_table_info('job_questions') WHERE name='purpose'").get());
  const before=snapshot(store.db);
  store.db.close();
  store=new Store(file);
  const after=snapshot(store.db);
  assert.equal(after.version,72,'schema 68 must advance through the current migrations to 72');
  const grant=after.tables.tool_grants[0];
  assert.equal(grant.scope,null);
  assert.deepEqual(after.tables.tool_grants.map(({scope,...row})=>row),before.tables.tool_grants);
  const withoutGrants=({tool_grants,...tables})=>tables;
  assert.deepEqual(withoutGrants(after.tables),withoutGrants(before.tables),'migration changed unrelated data');
  assert.deepEqual(after.schema.filter(s=>s.name!=='tool_grants'),before.schema.filter(s=>s.name!=='tool_grants'),'migration changed unrelated schema');
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  store.db.close();
  store=new Store(file);
  assert.deepEqual(snapshot(store.db),after,'reopening schema 72 must change nothing');
  console.log(`MIGRATION: 68 -> ${after.version}; scope added; ${after.tables.tool_grants.length} existing grant preserved; reopen 72 unchanged`);
} finally {store?.db.close();fs.rmSync(home,{recursive:true,force:true});}
