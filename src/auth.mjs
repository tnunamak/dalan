import { defaultPath } from './paths.mjs';
import { readEnv } from './env.mjs';
import { ADVERTISED_SCOPES, advertisedScopeNames, canonicalScopes, legacyScopeNames, wireScope } from './scopes.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPublicKey, verify } from 'node:crypto';

const decode=s=>Buffer.from(s,'base64url');
export function authConfig(file=readEnv('DALAN_OAUTH_FILE')||defaultPath(os.homedir(),'.config/dot-bridge/oauth.env'), requireMode=true) {
  if(requireMode && readEnv('DALAN_AUTH_MODE')!=='oauth') return null;
  if(!requireMode && !fs.existsSync(file)) return null;
  if(!fs.existsSync(file)||(fs.statSync(file).mode&0o777)!==0o600) throw new Error('OAuth config missing or not mode 0600');
  const values=Object.fromEntries(fs.readFileSync(file,'utf8').split('\n').filter(x=>x.includes('=')).map(line=>{const n=line.indexOf('=');return [line.slice(0,n),line.slice(n+1)];}));
  for(const key of ['OAUTH_ISSUER','OAUTH_AUDIENCE','OAUTH_JWKS_URI','OAUTH_ALLOWED_SUBJECTS']) if(!values[key]) throw new Error(`OAuth ${key} missing`);
  // A misspelled value must not silently keep the legacy scope names the operator meant to leave.
  if(values.OAUTH_SCOPE_NAMES!==undefined&&!['legacy','neutral'].includes(values.OAUTH_SCOPE_NAMES)) throw new Error('OAuth OAUTH_SCOPE_NAMES must be legacy or neutral');
  const testHttp=process.env.NODE_ENV!=='production'&&readEnv('DALAN_TEST_OAUTH')==='1';
  if((!testHttp&&(new URL(values.OAUTH_ISSUER).protocol!=='https:'||new URL(values.OAUTH_JWKS_URI).protocol!=='https:'))||new URL(values.OAUTH_ISSUER).origin!==new URL(values.OAUTH_JWKS_URI).origin||new URL(values.OAUTH_AUDIENCE).protocol!=='https:') throw new Error('invalid OAuth origins');
  return values;
}
// Fail closed: the public MCP route may run unauthenticated only when a test or dev run opts in explicitly.
// The insecure development flags are loopback-only: a development env file copied onto a public host
// must not start an unauthenticated public route. options.bindHost is the effective listener host;
// an unknown host is treated as non-loopback.
export const LOOPBACK_BIND_HOSTS=['127.0.0.1','::1','localhost'];
export function isLoopbackBindHost(host) {
  return typeof host==='string' && LOOPBACK_BIND_HOSTS.includes(host.toLowerCase());
}
export function assertPublicRouteAuth(config,env=process.env,options={}) {
  if(config) return;
  const insecureFlags=['DALAN_DEV_ALLOW_UNAUTHENTICATED','DALAN_ALLOW_INSECURE_PUBLIC'].filter(name=>env.NODE_ENV!=='production'&&readEnv(name,env)==='1');
  if(insecureFlags.length) {
    // A same-host proxy or tunnel would make the unauthenticated loopback listener public.
    if(readEnv('DALAN_TRUST_PROXY',env)==='1') throw new Error(`refusing to start the public route unauthenticated with ${insecureFlags.join(' and ')} while DALAN_TRUST_PROXY=1: a reverse proxy or tunnel would expose it; unset the flag and use DALAN_AUTH_MODE=builtin or oauth`);
    if(isLoopbackBindHost(options.bindHost)) return;
    throw new Error(`refusing to start the public route unauthenticated with ${insecureFlags.join(' and ')} on a non-loopback bind: ${insecureFlags.join(' and ')} is allowed only when the bind host is loopback (DALAN_BIND_HOST=127.0.0.1, ::1 or localhost); unset the flag or bind to loopback`);
  }
  throw new Error('refusing to start the public route without OAuth: set DALAN_AUTH_MODE=builtin or oauth (DALAN_DEV_ALLOW_UNAUTHENTICATED=1 is for non-production fixtures only)');
}
export function protectedResource(config,resource=config.OAUTH_AUDIENCE) {return {resource,authorization_servers:[config.OAUTH_ISSUER],scopes_supported:advertisedScopeNames(config),bearer_methods_supported:['header']};}
export function challenge(config,scope) {
  const explicit=!config.builtin&&scope===undefined&&config.OAUTH_CHALLENGE_SCOPE!==undefined;
  const value=explicit?config.OAUTH_CHALLENGE_SCOPE:wireScope(scope??config.OAUTH_CHALLENGE_SCOPE??'dalan.read',legacyScopeNames(config));
  return `Bearer realm="dalan", resource_metadata="${config.OAUTH_RESOURCE_METADATA??new URL('/.well-known/oauth-protected-resource',config.OAUTH_AUDIENCE)}", scope="${value}"`;
}
// Each verifier owns process-local entries by URI. Unknown-key refreshes have a
// separate cooldown: a normal cache fill does not delay the first key rotation.
export function createBearerVerifier({fetch:fetchJwks=globalThis.fetch,now=Date.now,cacheTtlMs=300000,kidRefreshCooldownMs=30000,timeoutMs=3000}={}) {
  for(const value of [cacheTtlMs,kidRefreshCooldownMs,timeoutMs]) {
    if(!Number.isFinite(value)||value<=0) throw new Error('invalid verifier timing');
  }
  const entries=new Map();
  const elapsed=start=>Math.max(0,Math.round(performance.now()-start));
  const signingKey=(keys,kid)=>keys?.find(k=>k&&k.kid===kid&&k.kty==='RSA'&&k.use!=='enc');

  async function refresh(uri,entry) {
    if(entry.pending) return entry.pending;
    entry.pending=(async()=>{
      const signal=AbortSignal.timeout(timeoutMs);
      let status;
      try {
        const response=await fetchJwks(uri,{signal});
        status=response.status;
        if(!response.ok) return {outcome:'http_error',status};
        const jwks=await response.json();
        if(!jwks||!Array.isArray(jwks.keys)) return {outcome:'invalid_response',status};
        entry.keys=jwks.keys;
        entry.expiresAt=now()+cacheTtlMs;
        return {outcome:'fetched',status,keys:entry.keys};
      } catch(error) {
        return {outcome:signal.aborted?'timeout':error instanceof SyntaxError?'invalid_response':'fetch_error',status};
      }
    })();
    try {return await entry.pending;} finally {entry.pending=null;}
  }

  async function getKey(uri,kid,trace) {
    const start=performance.now();
    trace.jwks_outcome='pending';
    let entry=entries.get(uri);
    if(!entry) {
      entry={keys:null,expiresAt:0,pending:null,lastKidRefreshAt:-Infinity};
      entries.set(uri,entry);
    }
    try {
      const fresh=entry.keys&&now()<entry.expiresAt;
      const cached=fresh&&signingKey(entry.keys,kid);
      if(cached) {trace.jwks_outcome='cache_hit';return cached;}
      // Join a refresh already in flight before applying the miss cooldown.
      let outcome;
      if(entry.pending) {
        outcome=await entry.pending;
        trace.jwks_outcome=outcome.keys?'coalesced':outcome.outcome;
      } else {
        if(fresh) {
          if(now()-entry.lastKidRefreshAt<kidRefreshCooldownMs) {
            trace.jwks_outcome='refresh_throttled';
            throw new Error('signing key unavailable');
          }
          entry.lastKidRefreshAt=now();
        }
        outcome=await refresh(uri,entry);
        trace.jwks_outcome=outcome.outcome;
      }
      if(outcome.status!==undefined) trace.jwks_http_status=outcome.status;
      if(!outcome.keys) throw new Error('JWKS unavailable');
      const key=signingKey(outcome.keys,kid);
      if(!key) {
        entry.lastKidRefreshAt=now();
        throw new Error('signing key unavailable');
      }
      return key;
    } finally {trace.jwks_duration_ms=elapsed(start);}
  }

  return async function verifyBearer(header,config,trace={}) {
    const start=performance.now();
    // Preserve explicit in-progress fields if the connection closes during I/O.
    Object.assign(trace,{auth_outcome:'pending',auth_reason:null,auth_duration_ms:null,
      jwks_outcome:'not_attempted',jwks_duration_ms:null,jwks_http_status:null});
    let reason='invalid_token';
    try {
      reason='missing_bearer';
      if(typeof header!=='string'||!header.startsWith('Bearer ')) throw new Error('missing bearer token');
      reason='invalid_token';
      const parts=header.slice(7).split('.');
      if(parts.length!==3) throw new Error('invalid bearer token');
      let meta,claims;
      try {meta=JSON.parse(decode(parts[0]));claims=JSON.parse(decode(parts[1]));} catch {throw new Error('invalid bearer token');}
      if(!meta||!claims||typeof meta!=='object'||typeof claims!=='object') throw new Error('invalid bearer token');
      reason='unsupported_signature';
      if(meta.alg!=='RS256'||typeof meta.kid!=='string') throw new Error('unsupported bearer signature');
      let jwk;
      try {jwk=await getKey(config.OAUTH_JWKS_URI,meta.kid,trace);} catch(error) {
        reason=error.message==='signing key unavailable'?'signing_key_unavailable':'jwks_unavailable';
        throw error;
      }
      reason='invalid_signature';
      let valid;
      try {valid=verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),createPublicKey({key:jwk,format:'jwk'}),decode(parts[2]));} catch {throw new Error('invalid bearer signature');}
      if(!valid) throw new Error('invalid bearer signature');
      // One class per refusal, so a log line says why a client was turned away. Never the token or its claims.
      const seconds=Math.floor(now()/1000),aud=claims.aud;
      const refuse=why=>{reason=why;throw new Error('invalid bearer claims');};
      if(claims.iss!==config.OAUTH_ISSUER) refuse('wrong_issuer');
      if(!(aud===config.OAUTH_AUDIENCE||Array.isArray(aud)&&aud.includes(config.OAUTH_AUDIENCE))) refuse('wrong_audience');
      if(!Number.isInteger(claims.exp)) refuse('malformed_claims');
      if(claims.exp<=seconds) refuse('expired');
      if(claims.nbf>seconds) refuse('not_yet_valid');
      if(!claims.sub||!config.OAUTH_ALLOWED_SUBJECTS.split(',').includes(claims.sub)) refuse('unknown_subject');
      reason='invalid_scope';
      const scopes=canonicalScopes(String(claims.scope||'').split(' '));
      if(!ADVERTISED_SCOPES.some(scope=>scopes.has(scope))) throw new Error('invalid bearer scope');
      trace.auth_outcome='success';
      trace.auth_reason='verified';
      return {subject:claims.sub,scopes,issuer:claims.iss,client_id:claims.azp??claims.client_id,connection_id:claims.connection_id};
    } catch(error) {
      trace.auth_outcome='failure';
      trace.auth_reason=reason;
      throw error;
    } finally {trace.auth_duration_ms=elapsed(start);}
  };
}
export const verifyBearer=createBearerVerifier();
export function needScope(principal,scope) {if(!principal.scopes.has(scope)) throw new Error('insufficient_scope');}
