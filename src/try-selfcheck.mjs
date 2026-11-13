// Proves a live `dalan try` public address works as a real OAuth client sees it, step by step, without claude.ai:
// discovery, dynamic registration with an ordinary HTTPS callback, PKCE authorize, the owner's approval in the trial
// terminal, the token exchange, then an authenticated MCP initialize, tools/list and one read-only tool call.
// One line per step. No token, authorization code, pairing code, secret path or URL is ever written to the output.
import { createHash, randomBytes } from 'node:crypto';
import { safeDiagnostic } from './diagnostic.mjs';
import { authorizationServerMetadataUrl, onOrigin, TRIAL_ORIGIN_RULE } from './try-exposure.mjs';
import { mcpResponseText } from './mcp-sse.mjs';

const MCP_PROTOCOL = '2025-11-25';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The check registers a throwaway generic client. Its redirect is an ordinary HTTPS URL: the bridge accepts any plain one.
export const SELFCHECK_REDIRECT = 'https://selfcheck.example/oauth/callback';

export async function runSelfCheck({ url, redirect = SELFCHECK_REDIRECT, fetchImpl = fetch, say = () => {}, approveWaitMs = 300_000, requestMs = 30_000, signal, approve, discoveryOnly = false } = {}) {
  // `approve({ code })` lets the caller approve the pairing the page just showed (the owner's side); without it a human approves.
  // `discoveryOnly` stops after the steps that need no approval: no registration, no RESULT line.
  let mcp;
  try { mcp = new URL(url); } catch { mcp = null; }
  if (!mcp || !['https:', 'http:'].includes(mcp.protocol)) { // the message is fixed: the supplied text may be a credential
    say('FAIL input: the trial URL is not a valid web address');
    say('RESULT FAIL');
    return { ok: false, results: [{ name: 'input', status: 'FAIL', detail: 'the trial URL is not a valid web address' }] };
  }
  const callback = redirect;
  const results = [];
  let failed = false;
  const step = async (name, fn) => {
    if (failed) { results.push({ name, status: 'SKIP' }); say(`SKIP ${name}`); return undefined; }
    try {
      const note = await fn();
      results.push({ name, status: 'PASS' }); say(`PASS ${name}${note ? ` (${scrub(note)})` : ''}`);
    } catch (error) {
      const detail = scrub(safeDiagnostic(error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'cancelled or timed out' : error?.message, 200));
      failed = true; results.push({ name, status: 'FAIL', detail });
      say(`FAIL ${name}: ${detail}`);
    }
    return undefined;
  };
  // The secret path is part of the MCP URL; keep it, the origin-relative credentials and the full URL out of every line.
  const secretPath = mcp.pathname.split('/')[1] ?? '';
  const scrub = text => String(text).split(url).join('[url]').split(secretPath).join('[secret]');
  // Every request has its own deadline, so a server that never finishes its answer cannot outlast the check.
  const get = (u, init = {}) => fetchImpl(u, { redirect: 'manual', ...init, signal: signal ? AbortSignal.any([AbortSignal.timeout(requestMs), signal]) : AbortSignal.timeout(requestMs), headers: { connection: 'close', ...(init.headers ?? {}) } });
  const json = async (res, label) => { try { return JSON.parse(await res.text()); } catch { throw new Error(`${label} is not JSON`); } };
  const ctx = {};

  await step('challenge: an unauthenticated MCP request is answered with an OAuth challenge', async () => {
    const res = await get(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
    if (res.status !== 401) throw new Error(`HTTP ${res.status}, not 401`);
    const header = res.headers.get('www-authenticate') ?? '';
    if (!/^Bearer/i.test(header)) throw new Error('no Bearer challenge');
    ctx.metadataUrl = /resource_metadata="([^"]+)"/.exec(header)?.[1];
    if (!ctx.metadataUrl) throw new Error('the challenge names no resource_metadata');
  });
  await step('discovery: protected-resource metadata names this resource and an authorization server', async () => {
    const res = await get(ctx.metadataUrl);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const doc = await json(res, 'resource metadata');
    if (doc.resource !== url) throw new Error('the resource is not the MCP URL');
    if (!Array.isArray(doc.authorization_servers) || doc.authorization_servers.length === 0) throw new Error('no authorization server');
    ctx.issuer = String(doc.authorization_servers[0]);
    if (!onOrigin(mcp.origin, ctx.issuer)) throw new Error(`the issuer is on another origin (${TRIAL_ORIGIN_RULE})`);
  });
  await step('metadata: the issuer matches exactly and every endpoint is on the public origin', async () => {
    const res = await get(authorizationServerMetadataUrl(ctx.issuer));
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const meta = await json(res, 'authorization-server metadata');
    if (meta.issuer !== ctx.issuer) throw new Error('the issuer in the metadata differs from the issuer in discovery');
    for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) if (typeof meta[key] !== 'string' || !onOrigin(mcp.origin, meta[key])) throw new Error(`${key} is missing or off this origin (${TRIAL_ORIGIN_RULE})`);
    if (!meta.code_challenge_methods_supported?.includes('S256')) throw new Error('S256 is not supported');
    ctx.meta = meta;
  });
  if (discoveryOnly) return { ok: !failed, results };
  await step(`registration: an ordinary HTTPS callback is accepted as a public client`, async () => {
    const res = await get(ctx.meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [callback], client_name: 'dalan self-check', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
    if (res.status !== 201) throw new Error(`HTTP ${res.status}`);
    const doc = await json(res, 'registration');
    if (doc.token_endpoint_auth_method !== 'none') throw new Error(`token_endpoint_auth_method is ${safeDiagnostic(doc.token_endpoint_auth_method, 40)}, not none`);
    if (Object.hasOwn(doc, 'client_secret')) throw new Error('a client secret was issued to a public client');
    ctx.clientId = doc.client_id;
  });
  const cookies = new Map();
  const send = async (u, init) => {
    const cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await get(u, { ...init, headers: { ...(cookie ? { cookie } : {}) } });
    for (const line of res.headers.getSetCookie?.() ?? []) { const [pair] = line.split(';'), i = pair.indexOf('='); if (pair.slice(i + 1) === '') cookies.delete(pair.slice(0, i)); else cookies.set(pair.slice(0, i), pair.slice(i + 1)); }
    return res;
  };
  const here = location => new URL(location, mcp.origin).href;
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(6).toString('hex');
  await step('authorize: a PKCE request reaches the pairing page', async () => {
    const authorize = new URL(ctx.meta.authorization_endpoint);
    for (const [k, v] of Object.entries({ client_id: ctx.clientId, response_type: 'code', redirect_uri: callback, scope: 'dalan.read dalan.work', state, resource: url, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) authorize.searchParams.set(k, v);
    const first = await send(authorize.href);
    ctx.interaction = first.headers.get('location');
    if (first.status !== 303 || !ctx.interaction) throw new Error(`HTTP ${first.status}`);
    const page = await (await send(here(ctx.interaction))).text();
    ctx.pairingCode = /class="code">([A-Z0-9-]+)</.exec(page)?.[1];
    if (!ctx.pairingCode) throw new Error('the pairing page shows no code');
  });
  if (!failed && !approve) say(`WAIT approve the connection in the trial terminal (y); waiting up to ${Math.round(approveWaitMs / 1000)} s`);
  await step(approve ? 'approval: the owner approved the pairing' : 'approval: the owner approved in the trial terminal', async () => {
    if (approve) await approve({ code: ctx.pairingCode });
    const deadline = Date.now() + approveWaitMs;
    for (;;) {
      const done = await send(here(ctx.interaction));
      if (done.status === 303) { ctx.resume = done.headers.get('location'); return; }
      if (Date.now() > deadline) throw new Error('not approved in time');
      signal?.throwIfAborted();
      await sleep(500);
    }
  });
  await step('callback: the redirect carries this request\'s state and a code, and the issuer if it names one', async () => {
    const resume = await send(here(ctx.resume));
    const back = new URL(resume.headers.get('location') ?? '', mcp.origin);
    if (back.searchParams.get('state') !== state) throw new Error('the state does not match');
    ctx.code = back.searchParams.get('code');
    if (!ctx.code) throw new Error('no authorization code');
    const iss = back.searchParams.get('iss');
    if (iss !== null && iss !== ctx.issuer) throw new Error('the iss parameter differs from the issuer');
    if (resume.status !== 302 && resume.status !== 303) throw new Error(`the redirect status is HTTP ${resume.status}`);
    if (`${back.origin}${back.pathname}` !== callback) throw new Error('the redirect is not to the registered callback');
  });
  await step('token: the code is exchanged for a bearer token bound to this resource', async () => {
    const res = await get(ctx.meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: ctx.clientId, grant_type: 'authorization_code', code: ctx.code, redirect_uri: callback, code_verifier: verifier, resource: url }) });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const doc = await json(res, 'token response');
    if (typeof doc.access_token !== 'string' || doc.access_token === '') throw new Error('no access_token');
    if (!/^bearer$/i.test(doc.token_type ?? '')) throw new Error(`token_type is ${safeDiagnostic(doc.token_type, 20)}`);
    ctx.token = doc.access_token;
    let audience = 'opaque token';
    const parts = ctx.token.split('.');
    if (parts.length === 3) {
      try { const aud = JSON.parse(Buffer.from(parts[1], 'base64url').toString()).aud; if (![aud].flat().includes(url)) throw new Error('x'); audience = 'audience is this resource'; }
      catch { throw new Error('the token\'s audience is not this resource'); }
    }
    return `${audience}; scope ${safeDiagnostic(doc.scope, 80)}; expires_in ${Number.isInteger(doc.expires_in) ? doc.expires_in : 'unset'}`;
  });
  let session = {};
  const rpc = async (body, expect = 200) => {
    const res = await get(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${ctx.token}`, ...session } });
    const text = await res.text();
    if (res.status !== expect) throw new Error(`HTTP ${res.status}`);
    if (expect === 202) return null;
    try { return { res, message: JSON.parse(mcpResponseText(text) ?? 'null') }; } catch { throw new Error('the reply is not JSON'); }
  };
  await step('mcp auth: a bearer token that was not issued here is refused', async () => {
    const res = await get(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${randomBytes(24).toString('base64url')}` }, body: '{"jsonrpc":"2.0","id":9,"method":"ping"}' });
    if (res.status !== 401) throw new Error(`HTTP ${res.status}, not 401`);
  });
  await step('mcp initialize: the bearer token is accepted', async () => {
    const { res, message } = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'dalan-self-check', version: '1' } } });
    if (typeof message.result?.protocolVersion !== 'string') throw new Error('no protocol version in the reply');
    session = { 'mcp-protocol-version': message.result.protocolVersion, ...(res.headers.get('mcp-session-id') ? { 'mcp-session-id': res.headers.get('mcp-session-id') } : {}) };
    await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, 202);
    return `protocol ${safeDiagnostic(message.result.protocolVersion, 20)}`;
  });
  await step('mcp tools/list: the worker tools are listed', async () => {
    const { message } = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const names = (message.result?.tools ?? []).map(t => t.name);
    if (!names.includes('list_pending')) throw new Error('list_pending is not listed');
    return `${names.length} tools`;
  });
  await step('mcp tools/call: list_pending (read-only) returns', async () => {
    const { message } = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_pending', arguments: {} } });
    if (message.result?.isError || !message.result?.content?.length) throw new Error('the tool call failed');
  });
  const ok = !failed;
  say(ok ? 'RESULT PASS' : 'RESULT FAIL');
  return { ok, results };
}
