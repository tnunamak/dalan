import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {Store} from '../src/store.mjs';
import {createToolRegistry} from '../src/tool-registry.mjs';
import {DotBridgeAdapter} from './conformance/adapter-dot-bridge.mjs';

const adapter=new DotBridgeAdapter();
try {
  await adapter.init();await adapter.reset();
  const store=new Store(adapter.dbFile);
  const threads=['00000000-0000-4000-8000-000000000001'];
  try {
    const registry=createToolRegistry({store});
    registry.initializeT3Grants(['t3_thread_read','t3_thread_wait','t3_thread_send'],['dot']);
    registry.grant('t3_thread_read','dot',{threads});
    registry.grant('t3_thread_wait','dot',{threads:[]});
    registry.grant('t3_thread_send','dot',null);
  } finally {store.db.close();}
  const cli=spawnSync(process.execPath,['bin/dot-worker.mjs','grants','--json'],{env:{...process.env,HOME:adapter.home},encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);
  const grants=JSON.parse(cli.stdout).grants.filter(row=>row.enforcer==='tool_registry');
  const row=tool=>grants.find(grant=>grant.tool===tool&&grant.worker==='dot');
  assert.deepEqual(row('t3_thread_read')?.scope,{threads});
  assert.deepEqual(row('t3_thread_wait')?.scope,{threads:[]});
  assert.equal(row('t3_thread_send')?.scope,null);
  for(const tool of ['t3_thread_read','t3_thread_wait','t3_thread_send']) assert.equal(row(tool).expires_at,null,'registry enrollment has no deadline; active access still uses scope and the live job');
  console.log('PASS grants inventory preserves scoped, empty and job-derived C3 thread restrictions');
} finally {await adapter.close();}
