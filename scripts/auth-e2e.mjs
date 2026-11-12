#!/usr/bin/env node
import { fetchForPublicHost } from '../src/test-support/public-host-fetch.mjs';
const fetch=fetchForPublicHost('dot-bridge.example.test');
import { reservedPort } from '../src/test-support/port.mjs';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';import {spawn} from 'node:child_process';import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-bridge-auth-')),port=await reservedPort(),jwksPort=await reservedPort(),issuer=`http://127.0.0.1:${jwksPort}/realms/fake`,audience='https://dot-bridge.example.test';const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});const jwk={...publicKey.export({format:'jwk'}),kid:'test',alg:'RS256',use:'sig'};
const metadata=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({keys:[jwk]}));});await new Promise(r=>metadata.listen(jwksPort,'127.0.0.1',r));const config=path.join(home,'.config/dot-bridge');fs.mkdirSync(config,{recursive:true});fs.writeFileSync(path.join(config,'oauth.env'),`OAUTH_ISSUER=${issuer}\nOAUTH_AUDIENCE=${audience}\nOAUTH_JWKS_URI=http://127.0.0.1:${jwksPort}/jwks\nOAUTH_ALLOWED_SUBJECTS=fixture-subject\n`,{mode:0o600});fs.writeFileSync(path.join(config,'env'),'BRIDGE_PATH_SECRET='+ 'a'.repeat(64)+'\n',{mode:0o600});fs.mkdirSync(path.join(home,'.config/dalan'),{recursive:true,mode:0o700});const env={...process.env,HOME:home, DALAN_LEGACY_PROFILE: '1',DOT_BRIDGE_PORT:String(port),DOT_BRIDGE_AUTH_MODE:'oauth',DOT_BRIDGE_TEST_OAUTH:'1',DOT_BRIDGE_ENABLE_WORKSPACE:'1'};const child=spawn(process.execPath,['src/server.mjs'],{cwd:path.resolve(new URL('..',import.meta.url).pathname),env,stdio:['ignore','pipe','pipe']});let ready=false;child.stdout.on('data',b=>{if(String(b).includes('MCP listening'))ready=true;});child.stderr.on('data',b=>process.stderr.write(b));
const token=(overrides={})=>{const head=Buffer.from(JSON.stringify({alg:'RS256',kid:'test'})).toString('base64url'),claims=Buffer.from(JSON.stringify({iss:issuer,aud:audience,exp:Math.floor(Date.now()/1000)+300,sub:'fixture-subject',scope:'dot-bridge.read dot-bridge.work',...overrides})).toString('base64url'),input=head+'.'+claims;return input+'.'+sign('RSA-SHA256',Buffer.from(input),privateKey).toString('base64url');};
const assert=(v,m)=>{if(!v)throw new Error(m);};const rpc=async(t,method,params={})=>{const secret=fs.readFileSync(path.join(config,'env'),'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];return fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json',...(t?{authorization:'Bearer '+t}:{})},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method,params})});};
// The insecure development flags are loopback-only, and neither waives the TLS proxy requirement.
{
const startup=(extraEnv)=>new Promise(resolve=>{
  const h=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-bridge-flag-'));
  const env2={...process.env,HOME:h, DALAN_LEGACY_PROFILE: '1',NODE_ENV:'test',DOT_BRIDGE_PORT:'0',...extraEnv};
  const c=spawn(process.execPath,['src/server.mjs'],{cwd:path.resolve(new URL('..',import.meta.url).pathname),env:env2,stdio:['ignore','pipe','pipe']});
  let out='',err='';
  const timer=setTimeout(()=>{try{c.kill('SIGKILL');}catch{}},15000);
  c.stdout.on('data',b=>{out+=b;if(out.includes('MCP listening'))c.kill('SIGTERM');});
  c.stderr.on('data',b=>{err+=b;});
  c.once('exit',code=>{clearTimeout(timer);fs.rmSync(h,{recursive:true,force:true});resolve({code,out,err});});
});
for(const flag of ['DOT_BRIDGE_ALLOW_INSECURE_PUBLIC','DOT_BRIDGE_DEV_ALLOW_UNAUTHENTICATED']) {
  const name=flag.replace('DOT_BRIDGE_','DALAN_');
  for(const host of ['0.0.0.0',undefined,'']) {
    const refused=await startup({[flag]:'1',...(host===undefined?{}:{DOT_BRIDGE_BIND_HOST:host})});
    assert(refused.code!==0&&!refused.out.includes('MCP listening')&&refused.err.includes(name)&&refused.err.includes('loopback'),`${name} on bind host ${JSON.stringify(host)} was not refused: ${refused.err}`);
  }
  console.log(`PASS ${name} refused on a non-loopback or default bind`);
  for(const host of ['127.0.0.1','localhost']) {
    const started=await startup({[flag]:'1',DOT_BRIDGE_BIND_HOST:host});
    assert(started.out.includes('MCP listening'),`${name} on ${host} did not start: ${started.err}`);
  }
  console.log(`PASS ${name} still starts on loopback`);
  const proxy=await startup({[flag]:'1',DOT_BRIDGE_AUTH_MODE:'oauth',DOT_BRIDGE_BIND_HOST:'0.0.0.0'});
  assert(proxy.code!==0&&proxy.err.includes('neither flag bypasses the TLS reverse proxy'),`${name} bypassed the proxy requirement: ${proxy.err}`);
  console.log(`PASS ${name} does not bypass the TLS reverse proxy requirement`);
}
}
try{for(let i=0;i<100&&!ready;i++)await new Promise(r=>setTimeout(r,50));assert(ready,'server startup');assert(fs.readFileSync(path.join(config,'env'),'utf8')==='BRIDGE_PATH_SECRET='+ 'a'.repeat(64)+'\n','resource path changed');assert(fs.readdirSync(path.join(home,'.config/dalan')).length===0,'empty sibling was initialized');const naked=await rpc(null,'tools/list');assert(naked.status===401&&naked.headers.get('www-authenticate').includes('resource_metadata'),'401 challenge');for(const bad of [token({iss:'wrong'}),token({aud:'wrong'}),token({exp:1}),token({sub:'other'}),token().slice(0,-2)+'ab'])assert((await rpc(bad,'tools/list')).status===401,'bad JWT accepted');const read=await rpc(token({scope:'dot-bridge.read'}),'tools/list'),tools=(await read.json()).result.tools;assert(tools.every(t=>t.securitySchemes?.[0].type==='oauth2'),'tool schemes');const work=await rpc(token({scope:'dot-bridge.read'}),'tools/call',{name:'claim',arguments:{request_id:'req_missing',claimant:'dot'}});const denied=(await work.json()).result;assert(denied.content[0].text==='insufficient_scope'&&denied._meta['mcp/www_authenticate'][0].includes('insufficient_scope'),'scope bypass');const meta=await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`);assert((await meta.json()).resource===audience,'resource metadata');console.log('PASS OAuth JWKS signature/iss/aud/exp/subject, 401, scope and tool schemes');}finally{child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));await new Promise(r=>metadata.close(r));fs.rmSync(home,{recursive:true,force:true});}
