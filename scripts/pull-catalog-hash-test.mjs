import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DotBridgeAdapter} from './conformance/adapter-dot-bridge.mjs';
import {fetchForPublicHost} from '../src/test-support/public-host-fetch.mjs';
const fetch=fetchForPublicHost('dot-bridge.example.test');

// Pin the serialized advertised tools, including field order, descriptions and annotations.
// Modern T3 catalogs use the 90-second wait bound; non-T3 and frozen legacy hashes stay unchanged.
const hashes={
  'stable/t3-0':'6bcc72c368bba25f527267e870c3c1efba46e39cfb5a1b4cda54ab260252ce86',
  'stable/t3-1':'460b0f36d8d9554a9f933e2629b996d8a051514848ef8a9b370674ba936e244e',
  'questions-v1/t3-0':'85a2cef06394b35249156ccc1bf8c3b07e24e03cf821c3a5115daf681c792a22',
  'questions-v1/t3-1':'cd9704984318b60ff845a5b38d553191125faf707aca6f4695b4c0c96c45bae5',
  'protocol-v0/t3-0':'a7dff975bf96b3cb6fb0436ae3c597db5543e6cb4cca5b9874f551f2e88f0b12',
  'protocol-v0/t3-1':'285a609615b623870c525616456a52c28ab698c7cf1679c1fa3be28dcf680fd8',
  'legacy-v46/t3-0':'0cbbaf9ab90346d0e06fb1413f62f8e834cd6d61010a48b52d3c6e2b2d8d3cbc',
  'legacy-v46/t3-1':'0cbbaf9ab90346d0e06fb1413f62f8e834cd6d61010a48b52d3c6e2b2d8d3cbc',
};
for(const profile of ['stable','questions-v1','protocol-v0','legacy-v46'])for(const t3 of ['0','1']) {
  const adapter=new DotBridgeAdapter({serverEnv:{DOT_BRIDGE_CATALOG_PROFILE:profile,DOT_BRIDGE_ENABLE_T3_TOOLS:t3}});
  try {
    await adapter.init();await adapter.reset();
    const response=await fetch(`http://127.0.0.1:${adapter.port}/${adapter.secret}/mcp`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${adapter.token('W1')}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})});
    const reply=await response.json();assert.ok(!reply.error,JSON.stringify(reply.error));
    const hash=createHash('sha256').update(JSON.stringify(reply.result.tools)).digest('hex'),key=`${profile}/t3-${t3}`;
    assert.equal(hash,hashes[key],`advertised catalog changed: ${key}`);
  } finally {await adapter.close();}
}
console.log('PASS advertised tools/list SHA256 pinned for every catalog profile with T3 off/on');
