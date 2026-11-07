import assert from 'node:assert/strict';
import {DotBridgeAdapter} from './conformance/adapter-dot-bridge.mjs';

const adapter=new DotBridgeAdapter();
const command=(op,key,body,rest={})=>({v:0,op,job:'J',key,body,...rest});
async function invoke(principal,input) {
  const response=await adapter.invoke(principal,input);
  assert.equal(response.status,'OK');assert.equal(response.reply.ok,true,JSON.stringify(response.reply));
  return response;
}
try {
  await adapter.init();await adapter.reset();
  await invoke('owner',command('submit','s',{source:'git:BASE',scope:'read:fixture',policy:'P0',destination:'owner-inbox',retainUntil:1000}));
  const claim=command('claim','c',{leaseMs:100},{revision:1});
  const first=(await invoke('W1',claim)).reply.value;
  await adapter.control({op:'advance',to:20});
  const renew=command('renew','r',{leaseMs:100},{revision:2,epoch:1,claim:first.claim});
  const renewed=(await invoke('W1',renew)).reply.value;
  assert.deepEqual(renewed,{revision:3,leaseUntil:120});
  await invoke('W1',command('progress','p',{note:'working'},{revision:3,epoch:1,claim:first.claim}));
  await adapter.control({op:'advance',to:50});
  const retry=await invoke('W1',renew);
  assert.deepEqual(retry.reply.value,renewed);assert.deepEqual(retry.events,[]);
  const retryClaim=await invoke('W1',claim);
  assert.deepEqual(retryClaim.reply.value,first);assert.deepEqual(retryClaim.events,[]);
  await adapter.control({op:'restart'});
  assert.deepEqual((await invoke('W1',renew)).reply.value,renewed);
  await invoke('W1',command('upload','a',{artifact:'A',bytesBase64:Buffer.from('first').toString('base64')},{revision:4,epoch:1,claim:first.claim}));
  await invoke('W1',command('upload','b',{artifact:'B',bytesBase64:Buffer.from('second').toString('base64')},{revision:5,epoch:1,claim:first.claim}));
  // The server restarted at about 50; a claim idle since before the restart is held for its own lease (100) after the start.
  await adapter.control({op:'advance',to:151});
  await invoke('service',command('expire','expire',{},{}));
  const successor=(await invoke('W2',command('claim','next',{leaseMs:100},{revision:7}))).reply.value;
  const snapshot=async()=>(await invoke('owner',command('get','get',{}))).reply.value.snapshot;
  const retired=(await snapshot()).artifacts;
  assert.equal(Object.keys(retired).length,2);assert(Object.keys(retired).every(id=>id.startsWith('native-retired:')));
  assert(Object.values(retired).every(artifact=>artifact.epoch===1&&!artifact.sealed));
  assert.equal(new Set(Object.values(retired).map(artifact=>artifact.sha256)).size,1,'unsealed native metadata retains its unset digest');
  await adapter.control({op:'restart'});assert.deepEqual((await snapshot()).artifacts,retired);
  await invoke('W2',command('upload','new-a',{artifact:'A',bytesBase64:Buffer.from('new').toString('base64')},{revision:8,epoch:2,claim:successor.claim}));
  const inventory=(await snapshot()).artifacts;assert.equal(Object.keys(inventory).length,3);
  assert.equal(inventory.A.epoch,2);for(const [id,artifact] of Object.entries(retired))assert.deepEqual(inventory[id],artifact);
  // Alias normalization is bijective even for accepted colon-bearing names.
  const aliases=[adapter.deliveryAlias('alias-job','A','one'),adapter.deliveryAlias('alias-job','A','two'),adapter.deliveryAlias('alias-job','A:2','three')];
  assert.equal(new Set(aliases).size,3);
  assert.equal(adapter.deliveryAlias('other-job','A','four'),'D:A');
  assert.equal(adapter.maps.deliveryRev.get(JSON.stringify(['alias-job',aliases[0]])),'one');
  assert.equal(adapter.maps.deliveryRev.get(JSON.stringify(['other-job','D:A'])),'four');
  console.log('PASS real HTTP receipt replay after later mutations/restart and bijective delivery aliases');
} finally {await adapter.close();}
