import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { redactNote } from './alerts.mjs';

const responses = new WeakMap();

// The caller's class, never its text: a User-Agent can hold anything, including a credential, so only a name from this fixed
// list is logged ("other" for the rest, null when absent). That is enough to tell an Anthropic or OpenAI caller from a generic one.
const UA_CLASSES = [['Claude-User', /^claude-user/i], ['ClaudeBot', /^claudebot/i], ['anthropic-ai', /^anthropic-ai/i], ['ChatGPT-User', /^chatgpt-user/i], ['OAI-SearchBot', /^oai-searchbot/i],
  ['node', /^node(?![A-Za-z0-9._-])/i], ['undici', /^undici/i], ['curl', /^curl/i], ['python', /^python/i], ['Mozilla', /^mozilla/i]];
export const uaToken = req => {
  const ua = String(req.headers?.['user-agent'] ?? '');
  return ua === '' ? null : (UA_CLASSES.find(([, pattern]) => pattern.test(ua))?.[0] ?? 'other');
};
const methods = new Set(['server/discover', 'initialize', 'ping', 'tools/list', 'tools/call', 'events/list', 'events/subscribe', 'events/unsubscribe', 'notifications/initialized', 'notifications/cancelled']);

// Log only declared protocol names and numeric outcomes. RPC IDs, arguments,
// headers, URLs and exception messages can all contain credentials. The one
// exception is tool_error_message: a failed tool call's bridge-generated error
// text, redacted (redactNote) and cut to 300 characters, so an incident can be
// read from the log without inference.
export function beginMcpOutcome(req, res, log, toolNames, authRequired) {
  const started = performance.now();
  const state = {
    call_id: randomUUID(), started_at: new Date().toISOString(),
    http_method: ['POST', 'GET', 'DELETE', 'PUT', 'PATCH', 'HEAD', 'OPTIONS'].includes(req.method) ? req.method : 'other',
    rpc_method: null, tool: null, request_id: null, phase: authRequired ? 'auth' : 'body', auth_outcome: authRequired ? 'pending' : 'disabled',
    auth_reason: null, auth_duration_ms: null, jwks_outcome: 'not_attempted',
    jwks_duration_ms: null, jwks_http_status: null,
    rpc_error_code: null, tool_error: null, tool_error_message: null, response_bytes: 0,
    response_kind: 'empty', error_type: null,
  };
  responses.set(res, state);
  log({ kind: 'mcp_received', call_id: state.call_id, http_method: state.http_method, ua: uaToken(req) });
  let recorded = false;
  const complete = completion => {
    if (recorded) return;
    recorded = true;
    if (req.aborted && state.error_type === null) state.error_type = 'request_aborted';
    log({ kind: 'mcp_outcome', jwks_outcome: 'not_attempted', jwks_duration_ms: null, jwks_http_status: null,
      ...state, http_status: res.headersSent ? res.statusCode : null,
      completion, duration_ms: Math.round((performance.now() - started) * 1000) / 1000 });
  };
  res.once('finish', () => complete('finished'));
  res.once('close', () => complete('closed'));
  return {
    state,
    identify(rpc) {
      state.rpc_method = methods.has(rpc.method) ? rpc.method : 'unknown';
      if (rpc.method === 'tools/call') {
        state.tool = toolNames.has(rpc.params?.name) ? rpc.params.name : 'unknown';
        // Only an ID-shaped request_id is logged (the same shape the bridge accepts); never the rest of the arguments.
        const requestId = rpc.params?.arguments?.request_id;
        if (state.tool !== 'unknown' && typeof requestId === 'string' && /^[-\w]{8,128}$/.test(requestId)) state.request_id = requestId;
      }
    },
  };
}

export function recordMcpResponse(res, value, bytes) {
  const state = responses.get(res);
  if (!state) return;
  state.response_bytes = bytes;
  state.phase = 'responding';
  state.rpc_error_code = Number.isInteger(value?.error?.code) ? value.error.code : null;
  state.tool_error = typeof value?.result?.isError === 'boolean' ? value.result.isError : null;
  const text = value?.result?.content?.[0]?.text;
  state.tool_error_message = state.tool_error === true && typeof text === 'string' ? redactNote(text).slice(0, 300) : null;
  state.response_kind = value?.jsonrpc === '2.0' ? (value.error ? 'rpc_error' : 'rpc_result') : 'other_json';
}

// The shape of a path that matched no route. Only names of public routes survive; every other segment, including the
// secret MCP path and any token a client put in a wrong URL, becomes its length. Enough to tell a client that probes a
// well-known URL from one that holds a stale connector URL.
const PUBLIC_SEGMENTS = new Set(['mcp', '.well-known', 'oauth-protected-resource', 'oauth-authorization-server', 'openid-configuration', 'authorize', 'token', 'register', 'revoke', 'callback', 'favicon.ico', 'robots.txt']);
export function pathShape(url) {
  const segments = String(url ?? '').split(/[?#]/)[0].split('/').slice(1, 7);
  return '/' + segments.map(segment => PUBLIC_SEGMENTS.has(segment) ? segment : `<${Math.min(segment.length, 999)} chars>`).join('/');
}
