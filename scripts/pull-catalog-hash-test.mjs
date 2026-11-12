import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DotBridgeAdapter} from './conformance/adapter-dot-bridge.mjs';

// These hashes are taken from origin/main before policy pull was added. Hash the
// serialized advertised tools, including field order, descriptions and annotations.
const hashes={
  'stable/t3-0':'6bcc72c368bba25f527267e870c3c1efba46e39cfb5a1b4cda54ab260252ce86',
  'stable/t3-1':'d084b52048d283365f364852b470f9e1195b021f9f503dc9d6e0ccb85fe1330f',
  'questions-v1/t3-0':'21739919c2ab320873720b679bfa47d436a69a09e3f2147c9988a7d7e408fc95',
  'questions-v1/t3-1':'0e46e50aa97061c4b2d95d31a0e5e6b4e7827e40a6fc1015fc0e7e921d99a8f6',
  'protocol-v0/t3-0':'1669578b4538a82f57ffc3fdca66d543ba02073cf127f1d1d78d6b82a9e48965',
  'protocol-v0/t3-1':'13e7303bf6344fb673770a1e535b97e1f7d220f35b72b6a039317db906f9f57c',
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
