import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseCallbackPattern, matchesCallback, parseAsConfig } from '../src/as-files.mjs';
import { assertPublicRouteAuth, isLoopbackBindHost } from '../src/auth.mjs';
import { loopbackRequestAllowed } from '../src/loopback.mjs';

test('native callbacks require exact paths and loopback hosts; ports may vary independently of server mode', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    const uri = `http://${host}/callback`;
    const patterns = [parseCallbackPattern(uri)];
    assert(matchesCallback(patterns, `http://${host}:43219/callback`));
    for (const bad of [`http://${host}:43219/other`, `http://${host}:43219/callback?x=1`, `http://${host}:43219/callback#x`, 'http://evil.example/callback']) assert(!matchesCallback(patterns, bad), bad);
  }
  assert.throws(()=>parseCallbackPattern('http://127.0.0.1:41999/callback',{loopback:true}),/omit the port/);
  for (const uri of ['http://0.0.0.0/callback', 'http://198.51.100.1/callback', 'http://127.0.0.1.evil.example/callback', 'http://user@localhost/callback', 'http://localhost/*', 'http://localhost/a/../callback']) assert.throws(() => parseCallbackPattern(uri, { loopback: true }));
  const config = {version:1, public_url:'http://127.0.0.1:8787',callbacks:['http://localhost/callback']};
  assert.throws(() => parseAsConfig(config));
  assert.equal(parseAsConfig(config,{loopback:true}).patterns[0].loopback,true);
  for (const host of ['0.0.0.0','[::]','localhost','198.51.100.1']) assert.throws(() => parseAsConfig({...config,public_url:`http://${host}:8787`},{loopback:true}));
});

test('duplicate and malformed authorities cannot bypass the local request gate', () => {
  const origin='http://127.0.0.1:8787';
  const req=(rawHeaders,headers)=>({rawHeaders,headers});
  assert(loopbackRequestAllowed(req(['Host','127.0.0.1:8787'],{host:'127.0.0.1:8787'}),origin));
  for (const raw of [[],['Host','127.0.0.1:8787','Host','evil.example'],['Host','127.0.0.1:8787','Origin',origin,'Origin',origin]]) assert(!loopbackRequestAllowed(req(raw,{host:'127.0.0.1:8787',origin}),origin));
});

test('production startup refuses unauthenticated loopback and unsafe non-loopback HTTP', () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-loopback-refuse-'));
  try {
    for(const settings of [
      {DALAN_LOOPBACK:'1'},
      {DALAN_LOOPBACK:'1',DALAN_ALLOW_INSECURE_PUBLIC:'1'},
      {DALAN_LOOPBACK:'1',DALAN_DEV_ALLOW_UNAUTHENTICATED:'1'},
      {DALAN_LOOPBACK:'1',DALAN_DEV_ALLOW_UNAUTHENTICATED:'1',NODE_ENV:'test'},
      {DALAN_LOOPBACK:'1',DALAN_AUTH_MODE:'builtin',DALAN_BIND_HOST:'0.0.0.0'},
      {DALAN_LOOPBACK:'1',DALAN_AUTH_MODE:'builtin',DALAN_BIND_HOST:'::'},
      {DALAN_LOOPBACK:'1',DALAN_AUTH_MODE:'builtin',DALAN_BIND_HOST:'',DOT_BRIDGE_BIND_HOST:'127.0.0.1'},
      {DALAN_LOOPBACK:'1',DALAN_AUTH_MODE:'builtin',DALAN_BIND_HOST:'198.51.100.1'},
      {DALAN_AUTH_MODE:'oauth',DALAN_BIND_HOST:'198.51.100.1'},
      {DALAN_AUTH_MODE:'oauth'},
      {DALAN_AUTH_MODE:'oauth',DALAN_ALLOW_INSECURE_PUBLIC:'1'}]) {
      const result=spawnSync(process.execPath,['src/server.mjs'],{env:{HOME:home,PATH:process.env.PATH,NODE_ENV:'production',...settings},encoding:'utf8',timeout:5000});
      assert.notEqual(result.status,0);assert.equal(result.error,undefined);
      assert.match(result.stderr,/requires DALAN_AUTH_MODE=builtin|requires DALAN_BIND_HOST=127.0.0.1|non-loopback HTTP requires a TLS reverse proxy/);
    }
    const internal=spawnSync(process.execPath,['--input-type=module','-e',"import {main} from './src/server.mjs';await main({loopbackOnly:true});"],{env:{HOME:home,PATH:process.env.PATH,DALAN_BIND_HOST:'0.0.0.0'},encoding:'utf8',timeout:5000});
    assert.notEqual(internal.status,0);assert.match(internal.stderr,/requires DALAN_BIND_HOST=127.0.0.1/);
    assert.deepEqual(fs.readdirSync(home),[]);
  } finally {fs.rmSync(home,{recursive:true,force:true});}
});

test('authentication-off startup needs an explicit non-production development flag',()=>{
  assert.throws(()=>assertPublicRouteAuth(null,{}),/without OAuth/);
  assert.throws(()=>assertPublicRouteAuth(null,{DALAN_DEV_ALLOW_UNAUTHENTICATED:'1'}),/loopback/);
  for(const flag of ['DALAN_DEV_ALLOW_UNAUTHENTICATED','DALAN_ALLOW_INSECURE_PUBLIC','DOT_BRIDGE_ALLOW_INSECURE_PUBLIC']) {
    for(const bindHost of ['127.0.0.1','::1','localhost','LOCALHOST']) assert.doesNotThrow(()=>assertPublicRouteAuth(null,{[flag]:'1'},{bindHost}));
    for(const bindHost of ['127.0.0.1','::1','localhost']) assert.throws(()=>assertPublicRouteAuth(null,{[flag]:'1',DALAN_TRUST_PROXY:'1'},{bindHost}),/DALAN_TRUST_PROXY/);
    for(const bindHost of [undefined,'','0.0.0.0','::','[::1]','198.51.100.1']) assert.throws(()=>assertPublicRouteAuth(null,{[flag]:'1'},{bindHost}),/loopback/);
    assert.throws(()=>assertPublicRouteAuth(null,{[flag]:'1',NODE_ENV:'production'},{bindHost:'127.0.0.1'}),/without OAuth/);
  }
  assert.throws(()=>assertPublicRouteAuth(null,{},{bindHost:'127.0.0.1'}),/without OAuth/);
  assert.doesNotThrow(()=>assertPublicRouteAuth({}, {}, {bindHost:'0.0.0.0'}));
  for(const host of ['127.0.0.1','::1','localhost']) assert.equal(isLoopbackBindHost(host),true);
  for(const host of [undefined,null,'','0.0.0.0','::','[::1]','127.0.0.2',42]) assert.equal(isLoopbackBindHost(host),false);
  for(const flag of ['DALAN_DEV_ALLOW_UNAUTHENTICATED','DALAN_ALLOW_INSECURE_PUBLIC']) assert.throws(()=>assertPublicRouteAuth(null,{[flag]:'1',NODE_ENV:'production'}),/without OAuth/);
});
