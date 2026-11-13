// Focused tests for the display-only client conveniences (0.7 row C1).
// No network. The helper is presentation only: it must never decide who gets a grant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import * as convenience from '../src/client-convenience.mjs';

const read = (rel) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'));
const schema = read('../src/client-conveniences.schema.json');
const data = read('../src/client-conveniences.json');
const ICON = 'data:image/svg+xml;base64,PHN2Zy8+';

function entry(over = {}) {
  return {
    id: 'example',
    name: 'Example client',
    icon: ICON,
    verifiedRedirectOrigins: ['https://client.example'],
    deepLink: null,
    setupHints: ['Open connectors, paste the MCP endpoint, and sign in.'],
    evidence: { sourceUrl: 'https://client.example/docs/mcp', checkedAt: '2026-11-12', runtimeTested: false },
    ...over,
  };
}
const catalog = (...clients) => ({ schemaVersion: 1, clients });
const linkOf = (over = {}) => ({
  template: 'cursor://app.example/install?name={name}&config={config}',
  encoding: 'base64-json',
  sourceUrl: 'https://client.example/docs/links',
  checkedAt: '2026-11-12',
  ...over,
});

const ajv = new Ajv({ allErrors: true, strict: true });
const schemaOk = ajv.compile(schema);
const helperOk = (c) => convenience.validateCatalog(c).ok;
// Both validators (JSON Schema via ajv and the runtime helper) must agree on every case.
function assertRejected(c, why) {
  assert.equal(schemaOk(c), false, `schema accepted: ${why}`);
  assert.equal(helperOk(c), false, `helper accepted: ${why}`);
}
function assertAccepted(c, why) {
  assert.equal(schemaOk(c), true, `schema rejected: ${why} ${JSON.stringify(schemaOk.errors)}`);
  assert.equal(helperOk(c), true, `helper rejected: ${why}`);
}

test('shipped data validates against schema and helper', () => {
  assertAccepted(data, 'bundled data');
  assert.equal(data.schemaVersion, 1);
  const ids = data.clients.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
});

test('schema sets additionalProperties false on every object', () => {
  const bad = [];
  (function walk(node, path) {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}/${i}`));
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object' && node.additionalProperties !== false) bad.push(path);
    for (const [k, v] of Object.entries(node)) walk(v, `${path}/${k}`);
  })(schema, '#');
  assert.deepEqual(bad, []);
});

test('baseline entry is accepted', () => assertAccepted(catalog(entry()), 'baseline'));

test('schema rejects unknown fields at every level', () => {
  assertRejected({ ...catalog(entry()), extra: 1 }, 'root extra');
  assertRejected(catalog(entry({ extra: 1 })), 'client extra');
  assertRejected(catalog(entry({ evidence: { ...entry().evidence, extra: 1 } })), 'evidence extra');
  assertRejected(catalog(entry({ deepLink: { ...linkOf(), extra: 1 } })), 'deepLink extra');
  assertRejected({ schemaVersion: 2, clients: [entry()] }, 'schemaVersion 2');
});

test('schema rejects missing required fields', () => {
  for (const key of ['id', 'name', 'icon', 'verifiedRedirectOrigins', 'deepLink', 'setupHints', 'evidence']) {
    const e = entry();
    delete e[key];
    assertRejected(catalog(e), `missing ${key}`);
  }
  for (const key of ['sourceUrl', 'checkedAt', 'runtimeTested']) {
    const ev = { ...entry().evidence };
    delete ev[key];
    assertRejected(catalog(entry({ evidence: ev })), `evidence missing ${key}`);
  }
});

test('schema rejects remote icons, and accepts only inline data or a local path', () => {
  for (const icon of ['https://client.example/i.png', 'http://client.example/i.png', '//client.example/i.png', 'javascript:alert(1)', 'data:text/html;base64,PGI+', 'data:image/svg+xml;base64,', '']) {
    assertRejected(catalog(entry({ icon })), `icon ${icon}`);
  }
  assertAccepted(catalog(entry({ icon: 'data:image/png;base64,iVBORw0KGgo=' })), 'inline png');
  assertAccepted(catalog(entry({ icon: 'icons/example.svg' })), 'local path');
  assertRejected(catalog(entry({ icon: '../../etc/passwd' })), 'path traversal');
});

test('schema rejects every non-exact redirect origin', () => {
  const bad = [
    'http://client.example',            // http
    'https://*.client.example',         // wildcard host
    'https://client.example/*',         // wildcard path
    'https://client.example/callback',  // path
    'https://client.example/',          // trailing slash is a path
    'https://user:pw@client.example',   // credentials
    'https://client.example#frag',      // fragment
    'https://client.example?x=1',       // query
    '^https://client\\.example$',       // regex
    'https://(a|b).example',            // regex group
    'https://client.example:0',         // invalid port
    'https://CLIENT.example',           // not normalized
    'client.example',                   // no scheme
    'https://localhost',                // loopback gets generic identity
    'https://127.0.0.1',
    'https://[::1]',
    '',
  ];
  for (const origin of bad) assertRejected(catalog(entry({ verifiedRedirectOrigins: [origin] })), `origin ${origin}`);
  assertAccepted(catalog(entry({ verifiedRedirectOrigins: ['https://client.example:8443'] })), 'explicit port');
  assertAccepted(catalog(entry({ verifiedRedirectOrigins: [] })), 'no verified web origin');
  assertRejected(catalog(entry({ verifiedRedirectOrigins: ['https://a.example', 'https://a.example'] })), 'duplicate origin');
});

test('catalog rejects one origin claimed by two clients', () => {
  const a = entry({ id: 'a' });
  const b = entry({ id: 'b', name: 'B' });
  assert.equal(helperOk(catalog(a, b)), false);
});

test('schema allows only {endpoint} {name} {config} in link templates', () => {
  assertAccepted(catalog(entry({ deepLink: linkOf() })), 'name+config');
  assertAccepted(catalog(entry({ deepLink: linkOf({ template: 'app:mcp/install?{config}', encoding: 'url-component' }) })), 'config only');
  assertAccepted(catalog(entry({ deepLink: linkOf({ template: 'app://x?u={endpoint}' }) })), 'endpoint');
  for (const template of [
    'app://x?token={token}',
    'app://x?{secret}',
    'app://x?a={ENDPOINT}',
    'app://x?a={endpoint',
    'app://x?a={{endpoint}}',
    'app://x?a=${endpoint}',
    'app://x?a={}',
    'app://x?a={endpoint.length}',
    'https://client.example/x?u={endpoint}',   // web link would put the endpoint in a request
    'http://client.example/x?u={endpoint}',
    'javascript:alert({endpoint})',
    'data:text/html,{endpoint}',
    'app://x?a=1',                             // no placeholder at all
    '{endpoint}',                              // no scheme
    '',
  ]) assertRejected(catalog(entry({ deepLink: linkOf({ template }) })), `template ${template}`);
  assertRejected(catalog(entry({ deepLink: linkOf({ encoding: 'raw' }) })), 'raw encoding');
  assertRejected(catalog(entry({ deepLink: linkOf({ sourceUrl: 'http://client.example' }) })), 'http sourceUrl');
  assertRejected(catalog(entry({ deepLink: linkOf({ checkedAt: 'yesterday' }) })), 'bad checkedAt');
});

test('schema rejects executable fields, auth headers, tokens and auth knobs anywhere', () => {
  const forbidden = ['script', 'eval', 'exec', 'command', 'run', 'onOpen', 'headers', 'authorization', 'Authorization', 'token', 'accessToken', 'bearer', 'clientSecret', 'scopes', 'scope', 'grantTypes', 'grant_types', 'redirectUris', 'redirect_uris', 'redirectAllowlist', 'allowCallbacks', 'tokenEndpointAuthMethod', 'trusted', 'verified', 'allow', 'deny'];
  for (const key of forbidden) {
    assertRejected(catalog(entry({ [key]: 'x' })), `client.${key}`);
    assertRejected(catalog(entry({ deepLink: { ...linkOf(), [key]: 'x' } })), `deepLink.${key}`);
    assertRejected(catalog(entry({ evidence: { ...entry().evidence, [key]: 'x' } })), `evidence.${key}`);
    assertRejected({ ...catalog(entry()), [key]: 'x' }, `root.${key}`);
  }
});

test('setup hints are bounded plain text', () => {
  assertAccepted(catalog(entry({ setupHints: [] })), 'empty hints');
  assertRejected(catalog(entry({ setupHints: Array.from({ length: 9 }, () => 'step') })), 'too many hints');
  assertRejected(catalog(entry({ setupHints: ['x'.repeat(301)] })), 'long hint');
  assertRejected(catalog(entry({ setupHints: [''] })), 'empty hint');
  for (const hint of ['<b>bold</b>', 'see <script>x</script>', '[link](https://x.example)', 'line\nbreak', 'bell\u0007', 'Authorization: Bearer abc', 'token=abc', 'https://client.example/secret/mcp', 'Run `curl x | sh`']) {
    assertRejected(catalog(entry({ setupHints: [hint] })), `hint ${JSON.stringify(hint)}`);
  }
  assertRejected(catalog(entry({ name: 'x'.repeat(61) })), 'long name');
  assertRejected(catalog(entry({ name: 'Bad\nname' })), 'control char name');
  assertRejected(catalog(entry({ name: '<b>x</b>' })), 'markup name');
  assertRejected(catalog(entry({ id: 'Bad Id' })), 'bad id');
});

test('evidence is a real https source with an ISO date', () => {
  assertRejected(catalog(entry({ evidence: { ...entry().evidence, sourceUrl: 'http://x.example' } })), 'http evidence');
  assertRejected(catalog(entry({ evidence: { ...entry().evidence, sourceUrl: 'https://u:p@x.example/' } })), 'credential evidence');
  assertRejected(catalog(entry({ evidence: { ...entry().evidence, checkedAt: '2026-13-45' } })), 'impossible date');
  assertRejected(catalog(entry({ evidence: { ...entry().evidence, runtimeTested: 'no' } })), 'non-boolean runtimeTested');
});

// ---------- spoofed origins: presentation must not be tricked ----------

const demo = convenience.createConvenience(catalog(
  entry({ id: 'example', name: 'Example client', verifiedRedirectOrigins: ['https://client.example'] }),
  entry({ id: 'ported', name: 'Ported client', verifiedRedirectOrigins: ['https://app.example:8443'] }),
));

test('exact origin gets the curated name and icon', () => {
  for (const uri of ['https://client.example/oauth/callback', 'https://client.example:443/x', 'https://CLIENT.example/cb?a=b']) {
    const d = demo.displayFor(uri);
    assert.equal(d?.name, 'Example client', uri);
    assert.equal(d.icon, ICON);
    assert.equal(d.clientConvenienceId, 'example');
  }
  assert.equal(demo.displayFor('https://app.example:8443/cb')?.name, 'Ported client');
});

test('spoofed origins get no curated name', () => {
  const spoofs = [
    'https://client.example.evil.test/cb',        // suffix
    'https://evil-client.example/cb',             // prefix
    'https://sub.client.example/cb',              // subdomain
    'https://client.example@evil.test/cb',        // userinfo trick
    'https://evil.test/https://client.example/cb',
    'https://evil.test/cb?next=https://client.example',
    'https://evil.test/cb#https://client.example',
    'https://xn--clent-9xa.example/cb',           // punycode lookalike (clïent)
    'https://xn--client-3ya.example/cb',
    'https://clíent.example/cb',                  // unicode lookalike
    'https://сlient.example/cb',                  // Cyrillic с
    'https://client.example:8443/cb',             // different port
    'https://client.example:444/cb',
    'https://app.example/cb',                     // default port where only :8443 verified
    'http://client.example/cb',                   // http
    'http://client.example:443/cb',
    'ftp://client.example/cb',
    'custom://client.example/cb',
    'javascript://client.example/%0aalert(1)',
    'http://localhost:8787/cb',                   // loopback is always generic
    'http://127.0.0.1:8787/cb',
    'client.example/cb',
    '//client.example/cb',
    '',
    undefined,
    null,
    42,
    {},
    ['https://client.example/cb'],
  ];
  for (const uri of spoofs) assert.equal(demo.displayFor(uri), null, String(uri));
});

test('lookalike data entries cannot be built either', () => {
  assert.equal(helperOk(catalog(entry({ verifiedRedirectOrigins: ['https://xn--clent-9xa.example'] }))), true, 'punycode ASCII origin is a legal exact origin');
  assert.equal(helperOk(catalog(entry({ verifiedRedirectOrigins: ['https://clíent.example'] }))), false, 'non-ASCII host rejected');
});

// ---------- display-only: data changes never change authorization ----------

test('helper exports no allow/deny/gate function and imports no auth code', () => {
  const names = Object.keys(convenience).sort();
  assert.deepEqual(names, ['bundledCatalog', 'createConvenience', 'deepLinkFor', 'displayFor', 'hintsFor', 'listClients', 'validateCatalog']);
  for (const n of names) {
    assert.doesNotMatch(n, /allow|deny|trust|verif|authori[sz]|gate|polic|approv|grant|permit|check/i, n);
    assert.doesNotMatch(n, /^(is|has|can|should)[A-Z]/, n);
  }
  const src = readFileSync(fileURLToPath(new URL('../src/client-convenience.mjs', import.meta.url)), 'utf8');
  const imports = [...src.matchAll(/^\s*import[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.deepEqual(imports.filter((i) => !i.startsWith('node:')), [], 'only node: builtins');
  assert.doesNotMatch(src, /\bfetch\b|XMLHttpRequest|node:(http|https|net|dgram|child_process)|\beval\b|new Function|process\.env/, 'no network, eval or env access');
  const out = demo.displayFor('https://client.example/cb');
  assert.deepEqual(Object.keys(out).sort(), ['clientConvenienceId', 'icon', 'name']);
  for (const v of Object.values(out)) assert.equal(typeof v, 'string', 'display values are plain strings, never functions');
  for (const v of Object.values(demo)) assert.equal(typeof v, 'function');
  assert.deepEqual(Object.keys(demo).sort(), ['deepLinkFor', 'displayFor', 'hintsFor', 'listClients']);
});

test('adding or deleting a data entry changes only display output', () => {
  const uris = ['https://client.example/cb', 'https://other.example/cb', 'http://localhost:9/cb', 'https://evil.test/cb', 'not a uri'];
  const none = convenience.createConvenience(catalog());
  const withOne = convenience.createConvenience(catalog(entry()));
  const withTwo = convenience.createConvenience(catalog(entry(), entry({ id: 'other', name: 'Other', verifiedRedirectOrigins: ['https://other.example'] })));
  const shapeOf = (c) => uris.map((u) => { const d = c.displayFor(u); return d === null ? null : Object.keys(d).sort().join(','); });
  // Entry presence changes only the display value; null vs {name,icon,id} is the entire observable difference.
  assert.deepEqual(uris.map((u) => none.displayFor(u)), uris.map(() => null));
  assert.deepEqual(shapeOf(withOne), ['clientConvenienceId,icon,name', null, null, null, null]);
  assert.deepEqual(shapeOf(withTwo), ['clientConvenienceId,icon,name', 'clientConvenienceId,icon,name', null, null, null]);
  // The helper is deterministic and holds no mutable state: repeated calls and call order do not matter.
  assert.deepEqual(withTwo.displayFor(uris[0]), withTwo.displayFor(uris[0]));
  // Returned objects are copies: mutating one cannot poison later lookups.
  const d = withOne.displayFor(uris[0]);
  d.name = 'Hacked';
  assert.equal(withOne.displayFor(uris[0]).name, 'Example client');
});

test('catalog data is frozen after load', () => {
  const c = convenience.createConvenience(catalog(entry()));
  assert.equal(Object.isFrozen(convenience.bundledCatalog), true);
  assert.throws(() => { 'use strict'; convenience.bundledCatalog.clients.push({}); }, TypeError);
  assert.equal(c.listClients().length, 1);
});

test('createConvenience refuses an invalid catalog', () => {
  assert.throws(() => convenience.createConvenience(catalog(entry({ verifiedRedirectOrigins: ['https://*.client.example'] }))), /invalid client conveniences/);
  assert.throws(() => convenience.createConvenience({}), /invalid client conveniences/);
  assert.throws(() => convenience.createConvenience(null), /invalid client conveniences/);
});

// ---------- deep links ----------

const ENDPOINT = 'https://host.example/s3cr3t-path/mcp';

test('deep link: base64-json and url-component encoders', () => {
  const c = convenience.createConvenience(catalog(
    entry({ id: 'b64', verifiedRedirectOrigins: ['https://b64.example'], deepLink: linkOf() }),
    entry({ id: 'urlc', name: 'Url Client', verifiedRedirectOrigins: ['https://urlc.example'], deepLink: linkOf({ template: 'app:mcp/install?{config}', encoding: 'url-component' }) }),
    entry({ id: 'plain', verifiedRedirectOrigins: ['https://plain.example'] }),
  ));
  const b64 = c.deepLinkFor('b64', { endpoint: ENDPOINT, name: 'my worker' });
  assert.equal(b64.requiresExplicitOpen, true);
  const u = new URL(b64.url.replace('cursor://', 'http://'));
  assert.equal(u.searchParams.get('name'), 'my worker');
  assert.deepEqual(JSON.parse(Buffer.from(u.searchParams.get('config'), 'base64').toString('utf8')), { url: ENDPOINT });
  const urlc = c.deepLinkFor('urlc', { endpoint: ENDPOINT, name: 'my worker' });
  assert.equal(urlc.requiresExplicitOpen, true);
  assert.match(urlc.url, /^app:mcp\/install\?%7B/);
  assert.deepEqual(JSON.parse(decodeURIComponent(urlc.url.slice('app:mcp/install?'.length))), { name: 'my worker', type: 'http', url: ENDPOINT });
  assert.equal(c.deepLinkFor('plain', { endpoint: ENDPOINT, name: 'w' }), null, 'deepLink null stays null');
  assert.equal(c.deepLinkFor('missing', { endpoint: ENDPOINT, name: 'w' }), null);
});

test('deep link: endpoint is validated, injection-proof and never logged', () => {
  const c = convenience.createConvenience(catalog(entry({ id: 'b64', deepLink: linkOf({ template: 'app://x?name={name}&u={endpoint}&c={config}' }) })));
  for (const endpoint of ['http://host.example/mcp', 'https://u:p@host.example/mcp', 'https://host.example/mcp#f', 'javascript:alert(1)', 'not a url', '', 42, null, undefined, 'https://host.example/mcp\n&x=1']) {
    assert.equal(c.deepLinkFor('b64', { endpoint, name: 'w' }), null, String(endpoint));
  }
  const hostile = c.deepLinkFor('b64', { endpoint: ENDPOINT, name: 'a&config=evil#x\n' });
  assert.ok(hostile, 'name is encoded, not rejected');
  assert.equal(new URL(hostile.url.replace('app://', 'http://')).searchParams.get('name'), 'a&config=evil#x\n');
  assert.equal(new URL(hostile.url.replace('app://', 'http://')).searchParams.get('u'), ENDPOINT);
  // No output channel: the helper must not write the link anywhere.
  const logged = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  for (const k of Object.keys(orig)) console[k] = (...a) => logged.push(a.join(' '));
  try {
    c.deepLinkFor('b64', { endpoint: ENDPOINT, name: 'w' });
    c.deepLinkFor('b64', { endpoint: 'http://bad', name: 'w' });
    c.displayFor('https://client.example/cb');
  } finally { Object.assign(console, orig); }
  assert.deepEqual(logged, []);
  const stdoutWrites = [];
  const ow = process.stdout.write; const ew = process.stderr.write;
  process.stdout.write = (...a) => { stdoutWrites.push(a[0]); return true; };
  process.stderr.write = (...a) => { stdoutWrites.push(a[0]); return true; };
  try { c.deepLinkFor('b64', { endpoint: ENDPOINT, name: 'w' }); } finally { process.stdout.write = ow; process.stderr.write = ew; }
  assert.deepEqual(stdoutWrites, []);
  // An error from a bad call must not embed the endpoint either.
  try { convenience.createConvenience(catalog(entry({ deepLink: linkOf({ template: `app://x?${ENDPOINT}` }) }))); } catch (e) { assert.doesNotMatch(String(e.message), /s3cr3t/); }
});

test('hints and listing carry no endpoint and no deep link target', () => {
  const c = convenience.createConvenience(catalog(entry({ deepLink: linkOf() })));
  assert.deepEqual(c.hintsFor('example'), ['Open connectors, paste the MCP endpoint, and sign in.']);
  assert.deepEqual(c.hintsFor('missing'), []);
  const list = c.listClients();
  assert.deepEqual(Object.keys(list[0]).sort(), ['hasDeepLink', 'icon', 'id', 'name', 'setupHints']);
  assert.equal(list[0].hasDeepLink, true);
});

// ---------- bundled data: every link needs a vendor source; unverified stays null ----------

test('bundled data: links only with vendor source and date, no remote icons, curated hints', () => {
  for (const c of data.clients) {
    assert.match(c.icon, /^data:image\//, `${c.id} icon inline`);
    assert.match(c.evidence.sourceUrl, /^https:\/\//);
    if (c.deepLink) {
      assert.match(c.deepLink.sourceUrl, /^https:\/\//, `${c.id} link source`);
      assert.match(c.deepLink.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
    }
  }
  const byId = Object.fromEntries(data.clients.map((c) => [c.id, c]));
  for (const id of ['chatgpt', 'claude', 'muse']) {
    assert.ok(byId[id], `${id} present`);
    assert.equal(byId[id].deepLink, null, `${id}: no documented install link, so null`);
  }
  assert.deepEqual(byId.chatgpt.verifiedRedirectOrigins, ['https://chatgpt.com']);
  assert.deepEqual(byId.claude.verifiedRedirectOrigins, ['https://claude.ai']);
});

test('bundled helper resolves real origins and not lookalikes', () => {
  assert.equal(convenience.displayFor('https://chatgpt.com/connector_platform_oauth_redirect')?.name, 'ChatGPT');
  assert.equal(convenience.displayFor('https://claude.ai/api/mcp/auth_callback')?.name, 'Claude');
  assert.equal(convenience.displayFor('https://chatgpt.com.evil.test/connector_platform_oauth_redirect'), null);
  assert.equal(convenience.displayFor('https://claude.ai:8443/api/mcp/auth_callback'), null);
  assert.equal(convenience.displayFor('http://claude.ai/api/mcp/auth_callback'), null);
  assert.equal(convenience.displayFor('http://127.0.0.1:5555/callback'), null);
});

test('the approval view shows a curated label only for an exact validated origin, and the label never changes the facts', async () => {
  const { describeClient, approvalFacts } = await import('../src/client-approval.mjs');
  const view = redirectUri => describeClient({ name: 'Claude', clientId: 'c', redirectUri, worker: 'w', issuer: 'i', resource: 'r', scopes: ['a'], code: '1' });
  const known = view('https://claude.ai/api/mcp/auth_callback');
  assert.equal(known.known_client, 'Claude');
  assert.ok(approvalFacts(known).some(([label]) => label.startsWith('Known client')));
  for (const uri of ['https://claude.ai.evil.test/api/mcp/auth_callback', 'https://selfcheck.example/oauth/callback', 'http://127.0.0.1:5555/cb']) {
    const other = view(uri);
    assert.equal(other.known_client, null, uri);
    assert.ok(!approvalFacts(other).some(([label]) => label.startsWith('Known client')), uri);
  }
});
