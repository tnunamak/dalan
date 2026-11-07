// A minimal MCP worker for `dalan try`: the real OAuth path (discovery, dynamic registration, PKCE, pairing page,
// token) and the real job tools, with no vendor client. It proves that the bridge works end to end. It is not a
// claim that any particular client works.
import { createHash, randomBytes } from 'node:crypto';
import { parseJsonBody, safeDiagnostic } from './diagnostic.mjs';

// A loopback pattern without a port admits any port, so this URI matches the 'http://127.0.0.1/callback' pattern.
export const DEMO_REDIRECT = 'http://127.0.0.1:43111/callback';

// Each call opens a fresh connection: `dalan try` runs owner commands in child processes while these requests wait.
const get = (url, { headers = {}, ...init } = {}) => fetch(url, { redirect: 'manual', ...init, headers: { connection: 'close', ...headers } });
const json = async (url, label, signal) => {
  const res = await get(url, { signal });
  if (res.status !== 200) throw new Error(`${label} returned HTTP ${res.status}`);
  return parseJsonBody(await res.text(), label);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Start OAuth against the MCP URL. Resolves with the pairing code the owner must approve and a `complete()` that
// waits for that approval and returns an access token.
// `signal` aborts every request and the wait for approval.
export async function beginPairing(mcpUrl, { redirect = DEMO_REDIRECT, clientName = 'dalan demo worker', timeoutMs = 600_000, signal } = {}) {
  const resource = new URL(mcpUrl);
  const protectedResource = await json(new URL(`/.well-known/oauth-protected-resource${resource.pathname}`, resource.origin), 'resource metadata', signal);
  const issuer = new URL(protectedResource.authorization_servers?.[0]);
  const meta = await json(new URL(`/.well-known/oauth-authorization-server${issuer.pathname}`, issuer.origin), 'authorization-server metadata', signal);
  const registration = await get(meta.registration_endpoint, {
    signal, method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirect], client_name: clientName, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
  if (registration.status !== 201) {
    // Show what the server said. Only a refused callback is fixed by allowing it; a registration limit is not.
    const body = await registration.text();
    const said = (() => { try { return JSON.parse(body).error_description; } catch { return undefined; } })();
    const detail = typeof said === 'string' && said ? `: ${safeDiagnostic(said, 300)}` : '';
    throw new Error(registration.status === 429
      ? `client registration refused (HTTP 429)${detail || ': registration limit reached. Reuse the client this worker already registered; run dalan connect reset only if you cannot'}`
      : `client registration refused (HTTP ${registration.status})${detail}; allow the callback with: dalan connect allow-callback '${redirect.replace(/:\d+/, '')}'`);
  }
  const { client_id: clientId } = parseJsonBody(await registration.text(), 'client registration');

  const cookies = new Map();
  const send = async (url, init) => {
    const cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await get(url, { ...init, signal, headers: { ...(cookie ? { cookie } : {}) } });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';'), i = pair.indexOf('=');
      if (pair.slice(i + 1) === '') cookies.delete(pair.slice(0, i)); else cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res;
  };
  const here = location => new URL(location, issuer.origin).href;
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(6).toString('hex');
  const authorize = new URL(meta.authorization_endpoint);
  for (const [k, v] of Object.entries({
    client_id: clientId, response_type: 'code', redirect_uri: redirect, scope: 'dalan.read dalan.work', state, resource: resource.href,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  })) authorize.searchParams.set(k, v);
  const first = await send(authorize.href);
  const interaction = first.headers.get('location');
  if (first.status !== 303 || !interaction) throw new Error(`authorization request refused (HTTP ${first.status})`);
  const code = (await (await send(here(interaction))).text()).match(/class="code">([A-Z0-9-]+)</)?.[1];
  if (!code) throw new Error('the bridge showed no pairing code');

  async function complete() {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const done = await send(here(interaction));
      if (done.status === 303) {
        const resume = await send(here(done.headers.get('location')));
        const callback = new URL(resume.headers.get('location') ?? '', issuer.origin);
        if (callback.searchParams.get('state') !== state || !callback.searchParams.get('code')) throw new Error('pairing ended without an authorization code');
        const token = await get(meta.token_endpoint, {
          signal, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: clientId, grant_type: 'authorization_code', code: callback.searchParams.get('code'), redirect_uri: redirect, code_verifier: verifier, resource: resource.href }),
        });
        if (token.status !== 200) throw new Error(`token request refused (HTTP ${token.status})`);
        return parseJsonBody(await token.text(), 'token response').access_token;
      }
      if (Date.now() > deadline) throw new Error('pairing was not approved in time');
      signal?.throwIfAborted();
      await sleep(500);
    }
  }
  return { code, complete };
}

const MCP_PROTOCOL = '2025-11-25';

// An MCP session as a real client opens one: `initialize`, then `notifications/initialized`, then tool calls that carry
// the negotiated protocol version (and the session id, if the server issues one).
export async function openSession(mcpUrl, token, { signal } = {}) {
  let nextId = 0;
  let sessionHeaders = {};
  const post = async (message, { expect = 200 } = {}) => {
    const res = await get(mcpUrl, {
      signal, method: 'POST', body: JSON.stringify(message),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...sessionHeaders },
    });
    const text = await res.text();
    if (res.status !== expect) throw new Error(`${message.method} returned HTTP ${res.status}: ${safeDiagnostic(text, 200)}`);
    return { res, text };
  };
  const parse = text => {
    const data = text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find(l => l.startsWith('data:'))?.slice(5) : text;
    return parseJsonBody(data ?? 'null', 'MCP response');
  };

  const init = await post({ jsonrpc: '2.0', id: ++nextId, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'dalan-demo', version: '1' } } });
  const negotiated = parse(init.text)?.result?.protocolVersion;
  if (typeof negotiated !== 'string') throw new Error(`initialize returned no protocol version: ${safeDiagnostic(init.text, 200)}`);
  sessionHeaders = { 'mcp-protocol-version': negotiated, ...(init.res.headers.get('mcp-session-id') ? { 'mcp-session-id': init.res.headers.get('mcp-session-id') } : {}) };
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { expect: 202 });

  return async function call(name, args) {
    const { text } = await post({ jsonrpc: '2.0', id: ++nextId, method: 'tools/call', params: { name, arguments: args } }).catch(error => { throw new Error(`${name} failed: ${error.message}`); });
    const result = parse(text)?.result;
    const body = result?.content?.find(c => c.type === 'text')?.text;
    if (result?.isError || body === undefined) throw new Error(`${name} failed: ${safeDiagnostic(body ?? text, 200)}`);
    return parseJsonBody(body, `${name} result`);
  };
}

// The job lifecycle a worker follows: initialize, list, claim, report progress, finish.
export async function workJob(mcpUrl, token, requestId, { claimant = 'dalan-demo', report, signal }) {
  const call = await openSession(mcpUrl, token, { signal });
  const pending = await call('list_pending', {});
  if (!pending.assignments.some(a => a.request_id === requestId)) throw new Error(`job ${requestId} is not pending`);
  const { claim_id } = await call('claim', { request_id: requestId, claimant });
  await call('progress', { request_id: requestId, claim_id, note: 'writing the report' });
  return call('finish', { request_id: requestId, claim_id, outcome: 'completed', summary: report, result: report });
}

// A repository job: the same lifecycle, plus the workspace tools. The report names the README title and the pinned revision.
export async function workRepositoryJob(mcpUrl, token, requestId, { claimant = 'dalan-demo', sha, signal } = {}) {
  const call = await openSession(mcpUrl, token, { signal });
  const pending = await call('list_pending', {});
  if (!pending.assignments.some(a => a.request_id === requestId)) throw new Error(`job ${requestId} is not pending`);
  const { claim_id } = await call('claim', { request_id: requestId, claimant });
  const files = await call('list_files', { request_id: requestId, claim_id });
  if (!JSON.stringify(files).includes('README.md')) throw new Error('the workspace does not list README.md');
  const file = await call('read_file', { request_id: requestId, claim_id, path: 'README.md' });
  const text = typeof file.text === 'string' ? file.text : '';
  const title = /^#\s+(.+)$/m.exec(text)?.[1];
  if (!title) throw new Error('README.md has no title line');
  await call('progress', { request_id: requestId, claim_id, note: 'read README.md' });
  const report = `README title: ${title}. Pinned revision: ${sha}.`;
  await call('finish', { request_id: requestId, claim_id, outcome: 'completed', summary: report, result: report });
  return report;
}
