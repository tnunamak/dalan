#!/usr/bin/env node
import fs from 'node:fs';

const positional = process.argv.slice(2);
if (!positional.length && !process.stdin.isTTY) {
  const fromStdin = fs.readFileSync(0, 'utf8').trim();
  if (fromStdin) positional.push(fromStdin);
}
if (positional.length < 1 || positional.length > 2 || !positional.at(-1) || positional.includes('--help')) {
  console.error('usage: node scripts/live-trial/check-public.mjs RESOURCE_URL');
  console.error('   or: node scripts/live-trial/check-public.mjs BASE_URL RESOURCE_URL');
  console.error('   or: node scripts/live-trial/check-public.mjs < RESOURCE_URL_FILE');
  process.exit(2);
}

function resourceUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('invalid resource URL'); }
  const loopbackHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !loopbackHttp) || url.username || url.password || url.search || url.hash
    || !/^\/[a-f0-9]{64}\/mcp$/.test(url.pathname)) throw new Error('resource URL must be HTTPS or loopback HTTP and include the private resource path');
  return url;
}

let resource;
try { resource = resourceUrl(positional.at(-1)); }
catch (error) {
  console.error(`FAIL resource URL (${error.message})`);
  process.exit(2);
}
let base = resource.origin;
if (positional.length === 2) {
  let suppliedBase;
  try { suppliedBase = new URL(positional[0]); } catch {
    console.error('FAIL base URL (invalid public base URL)');
    process.exit(2);
  }
  if (!['https:', 'http:'].includes(suppliedBase.protocol) || suppliedBase.username || suppliedBase.password
    || suppliedBase.search || suppliedBase.hash || suppliedBase.pathname !== '/' || suppliedBase.origin !== resource.origin) {
    console.error('FAIL base URL (base URL must be the resource URL origin)');
    process.exit(2);
  }
  base = suppliedBase.origin;
}
const output = [];
function report(name, passed, detail = '') {
  output.push(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

async function get(url) {
  return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
}

try {
  let protectedMetadata = null;
  let authorizationMetadata = null;
  let discoveryOk = false;
  try {
    const protectedPath = `/.well-known/oauth-protected-resource${resource.pathname}`;
    const protectedResponse = await get(new URL(protectedPath, base));
    if (protectedResponse.status === 200) {
      protectedMetadata = await protectedResponse.json();
      const issuer = new URL(protectedMetadata.authorization_servers?.[0]);
      const expectedIssuerPath = resource.pathname.replace(/\/mcp$/, '/oauth');
      if (issuer.origin !== base || issuer.pathname !== expectedIssuerPath || issuer.username || issuer.password
        || issuer.search || issuer.hash) throw new Error('issuer is outside the resource namespace');
      const issuerPrefix = issuer.pathname.replace(/\/$/, '');
      const authorizationPath = `/.well-known/oauth-authorization-server${issuerPrefix}`;
      const authorizationResponse = await get(new URL(authorizationPath, issuer.origin));
      if (authorizationResponse.status === 200) {
        authorizationMetadata = await authorizationResponse.json();
        discoveryOk = protectedMetadata.resource === resource.href
          && authorizationMetadata.issuer === issuer.href
          && ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'jwks_uri'].every(name => {
            const endpoint = new URL(authorizationMetadata[name]);
            return endpoint.origin === issuer.origin && endpoint.pathname.startsWith(`${issuerPrefix}/`)
              && !endpoint.username && !endpoint.password;
          });
      }
    }
  } catch { /* report status without echoing URLs or response data */ }
  report('suffixed discovery', discoveryOk, discoveryOk ? 'protected resource 200, authorization server 200' : 'discovery failed');

  const unsuffixedPaths = [
    '/.well-known/oauth-protected-resource',
    '/.well-known/openid-configuration',
    '/.well-known/openid-configuration/oauth',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-authorization-server/oauth',
    '/oauth/.well-known/openid-configuration',
    '/oauth/auth',
    '/oauth/reg',
    '/oauth/token',
    '/oauth/jwks',
    '/',
    '/mcp',
  ];
  const unsuffixedStatuses = [];
  for (const pathname of unsuffixedPaths) {
    try { unsuffixedStatuses.push((await get(new URL(pathname, base))).status); }
    catch { unsuffixedStatuses.push(0); }
  }
  const unsuffixedOk = unsuffixedStatuses.every(status => status === 404);
  report('unsuffixed and root routes', unsuffixedOk, unsuffixedOk ? 'all 404' : 'expected all 404');

  let mcpStatus = 0;
  let mcpChallengeOk = false;
  try {
    const expectedChallenge = new URL(`/.well-known/oauth-protected-resource${resource.pathname}`, base).href;
    const response = await fetch(resource, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'public-check', method: 'tools/list', params: {} }),
    });
    mcpStatus = response.status;
    mcpChallengeOk = response.status === 401
      && (response.headers.get('www-authenticate') ?? '').includes(expectedChallenge);
  } catch { /* report without echoing the secret-bearing resource URL */ }
  report('MCP without token', mcpStatus === 401 && mcpChallengeOk, `HTTP ${mcpStatus || 'unreachable'}`);

  let adminStatus = 0;
  try { adminStatus = (await get(new URL('/admin', base))).status; } catch { /* report below */ }
  report('admin route', adminStatus === 404, `HTTP ${adminStatus || 'unreachable'}`);
} catch {
  report('resource URL', false, 'invalid input');
}

for (const line of output) console.log(line);
if (output.some(line => line.startsWith('FAIL '))) process.exitCode = 1;
