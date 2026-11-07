#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import {generateKeyPairSync,sign} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {authConfig,createBearerVerifier,verifyBearer} from '../src/auth.mjs';

const keyPair=kid=>{
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  return {privateKey,jwk:{...publicKey.export({format:'jwk'}),kid,alg:'RS256',use:'sig'}};
};
const original=keyPair('original'),rotated=keyPair('rotated');
let clock=Date.now(),requests=0,keys=[original.jwk],mode='ok',delay=0;
const server=http.createServer(async(req,res)=>{
  requests++;
  if(delay) await new Promise(resolve=>setTimeout(resolve,delay));
  if(res.destroyed) return;
  if(mode==='hang') return;
  if(mode==='body-hang') {res.writeHead(200,{'content-type':'application/json'});res.write('{');return;}
  if(mode==='error') {res.writeHead(503);res.end();return;}
  res.setHeader('content-type','application/json');
  res.end(mode==='invalid'?'{}':mode==='malformed'?'{':JSON.stringify({keys}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const config={OAUTH_ISSUER:'https://issuer.example',OAUTH_AUDIENCE:'https://bridge.example',OAUTH_ALLOWED_SUBJECTS:'allowed',OAUTH_JWKS_URI:`http://127.0.0.1:${server.address().port}/jwks`};
const token=(pair=original,claims={},meta={})=>{
  const header=Buffer.from(JSON.stringify({alg:'RS256',kid:pair.jwk.kid,...meta})).toString('base64url');
  const body=Buffer.from(JSON.stringify({iss:config.OAUTH_ISSUER,aud:config.OAUTH_AUDIENCE,exp:Math.floor(clock/1000)+3600,sub:'allowed',scope:'dot-bridge.read',...claims})).toString('base64url');
  const input=header+'.'+body;
  return 'Bearer '+input+'.'+sign('RSA-SHA256',Buffer.from(input),pair.privateKey).toString('base64url');
};
const freshVerifier=options=>createBearerVerifier({now:()=>clock,...options});
const traceKeys=['auth_outcome','auth_reason','auth_duration_ms','jwks_outcome','jwks_duration_ms','jwks_http_status'];
const checkTrace=trace=>{
  assert(Object.keys(trace).every(key=>traceKeys.includes(key)));
  assert(['success','failure'].includes(trace.auth_outcome));
  assert(Number.isFinite(trace.auth_duration_ms)&&trace.auth_duration_ms>=0);
  if(trace.jwks_duration_ms!==null) assert(Number.isFinite(trace.jwks_duration_ms)&&trace.jwks_duration_ms>=0);
  assert(!JSON.stringify(trace).includes('allowed'));
  assert(!JSON.stringify(trace).includes('example'));
};
const reject=async(verifier,value,reason,outcome)=>{
  const trace={};
  await assert.rejects(verifier(value,config,trace));
  checkTrace(trace);
  assert.equal(trace.auth_reason,reason);
  if(outcome) assert.equal(trace.jwks_outcome,outcome);
  return trace;
};
try {
  const verify=freshVerifier();
  delay=50;
  const traces=Array.from({length:20},()=>({}));
  await Promise.all(traces.map(trace=>verify(token(),config,trace)));
  assert.equal(requests,1,'concurrent cache fills share one HTTP request');
  assert.equal(traces.filter(trace=>trace.jwks_outcome==='coalesced').length,19);
  traces.forEach(checkTrace);
  delay=0;
  const reusedTrace=traces[0];
  assert.equal((await verify(token(),config,reusedTrace)).subject,'allowed');
  assert.equal(requests,1);
  assert.equal(reusedTrace.jwks_outcome,'cache_hit');
  assert.equal(reusedTrace.jwks_http_status,null);

  keys=[original.jwk,rotated.jwk];
  await verify(token(rotated),config);
  assert.equal(requests,2,'new kid refreshes a warm cache immediately');
  mode='error';
  await verify(token(original),config);
  assert.equal(requests,2,'known fresh keys survive endpoint outage without fetch');
  const before=requests;
  for(let i=0;i<20;i++) await reject(verify,token(original,{}, {kid:`unknown-${i}`}), 'signing_key_unavailable','refresh_throttled');
  assert.equal(requests,before,'varied unknown kids cannot bypass URI cooldown');
  clock+=30001;
  const failed=await reject(verify,token(original,{}, {kid:'missing'}),'jwks_unavailable','http_error');
  assert.equal(failed.jwks_http_status,503);
  await verify(token(original),config);
  await reject(verify,token(original,{}, {kid:'other-missing'}),'signing_key_unavailable','refresh_throttled');
  clock+=300000;
  await reject(verify,token(original),'jwks_unavailable','http_error');
  assert.equal(requests,before+2,'expired cache fetches and fails closed');

  mode='ok';keys=[original.jwk];
  await verify(token(),config);
  assert.equal(requests,before+3,'failed expired refresh can recover on a later request');
  const validation=freshVerifier();
  await validation(token(),config);
  for(const [claims,why] of [[{iss:'wrong'},'wrong_issuer'],[{aud:'wrong'},'wrong_audience'],[{exp:1},'expired'],[{exp:'9999999999'},'malformed_claims'],[{nbf:Math.floor(clock/1000)+60},'not_yet_valid'],[{sub:'other'},'unknown_subject'],[{sub:undefined},'unknown_subject']]) {
    await reject(validation,token(original,claims),why,'cache_hit');
  }
  await reject(validation,token(original,{scope:'unrelated'}),'invalid_scope','cache_hit');
  // The allowed-subject list is exact match only. No entry is a wildcard, so none admits a subject it does not name.
  for(const list of ['*','.*',',',' ','allowed2','allowed-*']) {
    await assert.rejects(validation(token(original,{sub:'allowed'}),{...config,OAUTH_ALLOWED_SUBJECTS:list}),`list ${JSON.stringify(list)} must not admit "allowed"`);
    await assert.rejects(validation(token(original,{sub:'anyone'}),{...config,OAUTH_ALLOWED_SUBJECTS:list}),`list ${JSON.stringify(list)} must not admit "anyone"`);
  }
  await assert.rejects(validation(token(original,{sub:''}),{...config,OAUTH_ALLOWED_SUBJECTS:','}),'an empty subject is never admitted');
  // An absent or empty list refuses to start; it never means everyone.
  {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'auth-subjects-'));
    try {
      const base='OAUTH_ISSUER=https://issuer.example\nOAUTH_AUDIENCE=https://bridge.example\nOAUTH_JWKS_URI=https://issuer.example/jwks\n';
      for(const tail of ['','OAUTH_ALLOWED_SUBJECTS=\n']) {
        const file=path.join(dir,'oauth.env');fs.writeFileSync(file,base+tail,{mode:0o600});
        assert.throws(()=>authConfig(file,false),/OAUTH_ALLOWED_SUBJECTS missing/);
      }
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  }
  await reject(validation,token(rotated,{}, {kid:'original'}),'invalid_signature','cache_hit');
  await reject(validation,token(original,{}, {alg:'none'}),'unsupported_signature');
  await reject(validation,'Bearer nonsense','invalid_token');
  await reject(validation,undefined,'missing_bearer');
  await reject(validation,'Bearer bnVsbA.bnVsbA.a','invalid_token');
  await validation(token(original,{aud:['other',config.OAUTH_AUDIENCE],scope:'t3.write'}),config);

  const initialMiss=freshVerifier();
  await reject(initialMiss,token(original,{}, {kid:'absent'}),'signing_key_unavailable','fetched');
  const afterInitialMiss=requests;
  await reject(initialMiss,token(original,{}, {kid:'absent'}),'signing_key_unavailable','refresh_throttled');
  assert.equal(requests,afterInitialMiss);
  clock+=30001;keys=[original.jwk,rotated.jwk];
  await initialMiss(token(rotated),config);
  assert.equal(requests,afterInitialMiss+1,'rotation works after cooldown');

  for(const invalidMode of ['invalid','malformed']) {
    mode=invalidMode;
    await reject(freshVerifier(),token(),'jwks_unavailable','invalid_response');
  }
  for(const stalledMode of ['hang','body-hang']) {
    mode=stalledMode;
    const start=performance.now();
    await reject(freshVerifier({timeoutMs:100}),token(),'jwks_unavailable','timeout');
    assert(performance.now()-start<1000,'fetch and response body deadlines are bounded');
  }
  mode='hang';
  const productionStart=performance.now();
  await reject(verifyBearer,token(),'jwks_unavailable','timeout');
  assert(performance.now()-productionStart>=2800&&performance.now()-productionStart<4500,'production timeout stays at three seconds');
  mode='ok';
  const separate=freshVerifier();
  const otherConfig={...config,OAUTH_JWKS_URI:config.OAUTH_JWKS_URI+'-other'};
  const beforeSeparate=requests;
  await separate(token(),config);await separate(token(),otherConfig);
  assert.equal(requests,beforeSeparate+2,'cache entries are per URI');
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
  await reject(freshVerifier(),token(),'jwks_unavailable','fetch_error');
  console.log('PASS JWKS reuse/coalescing, rotation/cooldown, outage/expiry, strict JWT validation, secret-free traces and bounded fetch/body timeout');
} finally {
  server.closeAllConnections();
  if(server.listening) await new Promise(resolve=>server.close(resolve));
}
