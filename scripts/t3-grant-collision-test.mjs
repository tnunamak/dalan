import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { createToolRegistry, schemaHash } from '../src/tool-registry.mjs';

const dir=fs.mkdtempSync(path.join(os.homedir(),'.tmp/t3-grant-collision-'));
const names=['t3_thread_list','t3_thread_read','t3_thread_wait','t3_thread_create','t3_thread_send','t3_thread_set'];
const schema={type:'object',properties:{},additionalProperties:false};
const unavailable=error=>error.code==='tool_unavailable';
try {
  const store=new Store(path.join(dir,'bridge.db'));
  const registry=createToolRegistry({store,handlers:{echo:{run:async()=>{throw new Error('ungranted handler ran');}}}});
  registry.register({name:'legacy_send',description:'ordinary old tool',inputSchema:schema,class:'read',handler:{kind:'echo'}});
  // A valid pre-C3 registration: these names used to be available to ordinary tools.
  const definition={name:'t3_thread_send',description:'ordinary old tool',input_schema:schema,class:'read',handler:{kind:'echo'}};
  store.db.prepare('UPDATE registered_tools SET name=?,schema_hash=? WHERE name=?').run(definition.name,schemaHash(definition),'legacy_send');
  const snapshot=()=>JSON.stringify(['registered_tools','tool_grants','tool_registry_meta','tool_registry_log'].map(table=>store.db.prepare(`SELECT * FROM ${table}`).all()));
  const before=snapshot();
  assert.throws(()=>registry.initializeT3Grants(names,['dot']),error=>error.code==='reserved_tool_conflict','old ordinary tool must never gain implicit grants');
  assert.equal(snapshot(),before,'collision refusal must be atomic and leave the ordinary tool untouched');
  assert.deepEqual(registry.listTools('dot').tools,[]);
  await assert.rejects(registry.callTool({worker:'dot',tool:'t3_thread_send',class:'read',args:{}}),unavailable);
  for(const name of names) assert.throws(()=>registry.register({name,description:'reserved',inputSchema:schema,class:'read',handler:{kind:'echo'}}),error=>error.code==='invalid_tool');
  registry.remove('t3_thread_send');
  registry.initializeT3Grants(names,['dot']);
  assert.deepEqual(registry.listTools('dot').tools,[],'internal authority records are never ordinary dispatch tools');
  registry.grant('t3_thread_send','dot',{threads:[]});
  registry.grant('t3_thread_send','dot');
  const scope=()=>store.db.prepare('SELECT scope FROM tool_grants WHERE tool=? AND worker=?').get('t3_thread_send','dot').scope;
  assert.deepEqual(JSON.parse(scope()),{threads:[]},'repeated grant without scope must preserve narrowing');
  registry.grant('t3_thread_send','dot',null);
  assert.equal(scope(),null,'explicit null restores the default job-derived scope');
  store.db.prepare('UPDATE registered_tools SET handler=? WHERE name=?').run(JSON.stringify({kind:'echo'}),'t3_thread_send');
  assert.throws(()=>registry.t3Threads('t3_thread_send',{worker:'dot',subject:'fixture'}),unavailable,'top-level authorization must require the internal handler kind');
  store.db.close();
  console.log('PASS T3 reserved-name upgrade collision: atomic refusal, no implicit grant, closed handler lookup');
} finally { fs.rmSync(dir,{recursive:true,force:true}); }
