import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {checkAlerts} from '../src/alerts.mjs';

const dir=mkdtempSync(join(os.homedir(),'.tmp','protocol-retention-break-'));
let now=1800000000000;
const store=new Store(join(dir,'store.sqlite'),{now:()=>now});
const oldAlerts=process.env.DALAN_ALERTS_FILE;
try {
  process.env.DALAN_ALERTS_FILE=join(dir,'no-alert-config');
  const id='expired_protocol_break_alert';
  const payload={schema_version:1,request_id:id,brief:'expired protocol work',inputs:[],scope_paths:[],execution_scope:'analysis',expected_output:'proof',
    protocol:{profile:'job-v0',source:'source',scope:'scope',policy:'policy',destination:'owner',retain_until_ms:now+100}};
  store.submit(payload,{mode:'none'},null,'owner',false,null,'normal',null,payload,null,'dot','worker');
  now+=100;
  const breakState=store.setBreak('long usage break',new Date(now-31*60_000).toISOString());
  store.observeBreakAlert(breakState.id,new Date(now-31*60_000).toISOString());
  const logs=[];
  await checkAlerts(store,event=>logs.push(event));
  assert.equal(logs.some(event=>event.message?.startsWith('dot_break:')),false,
    'an expired-only protocol queue does not trigger the break alert');
  assert.equal(store.status().counts.some(row=>row.status==='queued'),false,'expired work is absent from queue totals');
} finally {
  if(oldAlerts===undefined)delete process.env.DALAN_ALERTS_FILE;else process.env.DALAN_ALERTS_FILE=oldAlerts;
  store.db.close();rmSync(dir,{recursive:true,force:true});
}
console.log('PASS expired protocol work is absent from totals and does not trigger a break alert');
