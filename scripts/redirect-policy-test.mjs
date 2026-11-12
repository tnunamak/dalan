#!/usr/bin/env node
// Unit tests for the pure redirect-URI policy. The policy looks only at the URI's own properties: no client name, brand or list.
import assert from 'node:assert/strict';
import test from 'node:test';
import { matchRegisteredRedirect, redirectOrigin, validateRedirectUri } from '../src/redirect-policy.mjs';

const ok = uri => { const r = validateRedirectUri(uri); assert.equal(r.ok, true, `${uri}: ${r.reason}`); return r; };
const bad = uri => { const r = validateRedirectUri(uri); assert.equal(r.ok, false, `${String(uri)} must be refused`); assert.equal(typeof r.reason, 'string'); };

test('accepts a structurally valid HTTPS redirect, fixed query kept, display data supplied', () => {
  const r = ok('https://client.example/oauth/cb?tenant=acme&x=1');
  assert.equal(r.kind, 'https');
  assert.equal(r.origin, 'https://client.example');
  assert.equal(r.host, 'client.example');
  assert.equal(r.uri, 'https://client.example/oauth/cb?tenant=acme&x=1');
  ok('https://client.example:8443/cb');
  ok('https://a.b.c.example/');
  ok('https://xn--bcher-kva.example/cb');
  assert.equal(validateRedirectUri('https://xn--bcher-kva.example/cb').punycode, true);
});

test('accepts native loopback on 127.0.0.1, [::1] and exact localhost, with or without a port', () => {
  for (const uri of ['http://127.0.0.1/cb', 'http://127.0.0.1:51234/cb', 'http://[::1]:5000/callback', 'http://[::1]/callback', 'http://localhost:3000/cb', 'http://localhost/cb']) assert.equal(ok(uri).kind, 'loopback', uri);
  assert.equal(ok('http://127.0.0.1:51234/cb').origin, 'http://127.0.0.1');
  assert.equal(ok('http://[::1]:5000/cb').origin, 'http://[::1]');
});

test('refuses everything that is not a plain HTTPS or loopback redirect', () => {
  for (const uri of [
    'https://user@client.example/cb', 'https://user:pw@client.example/cb', 'https://client.example/cb#frag', 'https://client.example/cb#',
    'https://*.example/cb', 'https://client.example/*', 'https://client.example/%2e%2e/cb'.replace('/%2e%2e', '/..'),
    'https://client.example./cb', 'https://CLIENT.example/cb', 'https://client.example:443/cb', 'https://client.example\\@evil.test/cb', 'https://client.example/cb\\x',
    'https://localhost/cb', 'https://127.0.0.1/cb', 'https://[::1]/cb', 'https://10.0.0.1/cb', 'https://2130706433/cb', 'https://0x7f000001/cb', 'https://client/cb', 'https://foo.localhost/cb',
    'https://bücher.example/cb', 'https://client.example/cb with space', 'https://client.example/\u0000', 'https://client.example/‮', 'https://client.example/\n',
    'http://client.example/cb', 'http://127.0.0.1.evil.test/cb', 'http://localhost./cb', 'http://localhost.evil.test/cb', 'http://127.1/cb', 'http://127.0.0.2/cb', 'http://0.0.0.0/cb', 'http://2130706433/cb', 'http://0x7f000001/cb', 'http://[::ffff:127.0.0.1]/cb', 'http://[0:0:0:0:0:0:0:1]/cb',
    'http://127.0.0.1/cb?a=1', 'http://127.0.0.1:0/cb', 'http://127.0.0.1:65536/cb', 'http://127.0.0.1:080/cb', 'http://127.0.0.1/cb#x', 'http://u@127.0.0.1/cb', 'http://127.0.0.1/a/../cb', 'http://127.0.0.1/%2e/cb', 'http://127.0.0.1',
    'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'ftp://client.example/cb', 'com.example.app:/cb', 'myapp://cb', '//client.example/cb', '/cb', '', ' https://client.example/cb', 'https://client.example/cb ',
    `https://client.example/${'a'.repeat(512)}`, null, undefined, 42, {}, ['https://client.example/cb'],
  ]) bad(uri);
});

test('length boundary: 512 characters pass, 513 do not', () => {
  const base = 'https://client.example/';
  ok(base + 'a'.repeat(512 - base.length));
  bad(base + 'a'.repeat(513 - base.length));
});

test('redirectOrigin groups by origin only and never merges lookalike hosts', () => {
  assert.equal(redirectOrigin('https://client.example/a?x=1'), 'https://client.example');
  assert.equal(redirectOrigin('https://client.example:8443/a'), 'https://client.example:8443');
  assert.notEqual(redirectOrigin('https://client.example/a'), redirectOrigin('https://client.example.evil.test/a'));
  assert.equal(redirectOrigin('nonsense'), null);
});

test('registered match: exact string, or loopback with only the port different', () => {
  const reg = ['https://client.example/cb?tenant=acme'];
  assert.equal(matchRegisteredRedirect(reg, 'https://client.example/cb?tenant=acme'), true);
  for (const other of ['https://client.example/cb', 'https://client.example/cb?tenant=other', 'https://client.example/cb?tenant=acme&x=1', 'https://client.example/cb/', 'https://client.example:444/cb?tenant=acme', 'https://client.example/other?tenant=acme']) assert.equal(matchRegisteredRedirect(reg, other), false, other);
  const loop = ['http://127.0.0.1:51234/cb'];
  assert.equal(matchRegisteredRedirect(loop, 'http://127.0.0.1:61000/cb'), true);
  assert.equal(matchRegisteredRedirect(loop, 'http://127.0.0.1/cb'), true);
  for (const other of ['http://127.0.0.1:61000/other', 'http://localhost:51234/cb', 'http://[::1]:51234/cb', 'http://127.0.0.1:61000/cb?x=1', 'https://127.0.0.1:61000/cb']) assert.equal(matchRegisteredRedirect(loop, other), false, other);
  assert.equal(matchRegisteredRedirect([], 'https://client.example/cb'), false);
  assert.equal(matchRegisteredRedirect(undefined, 'https://client.example/cb'), false);
});

test('a client name or brand never enters the decision: the function takes a URI only', () => {
  assert.equal(validateRedirectUri.length, 1);
  assert.equal(matchRegisteredRedirect.length, 2);
  // The same attacker URI gets the same answer whatever it looks like: a "claude.ai" lookalike is just another HTTPS host.
  assert.equal(ok('https://claude.ai.evil.example/api/mcp/auth_callback').origin, 'https://claude.ai.evil.example');
});

test('client-approval: a hostile name is sanitized and labelled; the record binds origin, URI and connection', async () => {
  const { approvalFacts, approvalRecord, describeClient } = await import('../src/client-approval.mjs');
  const view = describeClient({ name: '\u001b[31mClaude\u001b[0m‮ <b>approved</b>\n', clientId: 'cid', redirectUri: 'https://xn--bcher-kva.example/cb?t=1', worker: 'lark', issuer: 'https://h.example/<secret>/oauth', resource: 'https://h.example/<secret>/mcp', scopes: ['dalan.read'], code: 'ABCD-EFGH' });
  assert.equal(view.client_name_untrusted, true);
  assert.ok(!/[\u0000-\u001f\u007f‮]/.test(JSON.stringify(view).replace(/\\u[0-9a-f]{4}/g, '')), 'no control or bidi characters');
  assert.equal(view.redirect_host, 'xn--bcher-kva.example'); assert.equal(view.redirect_punycode, true); assert.equal(view.redirect_origin, 'https://xn--bcher-kva.example');
  assert.ok(approvalFacts(view).some(([label, value]) => /not verified/.test(label) && !/\u001b/.test(value)));
  const record = approvalRecord({ worker: 'lark', issuer: view.issuer, resource: view.resource, clientId: 'cid', redirectUri: 'https://c.example/cb', scopes: ['dalan.read'], approvedAt: 0, connectionId: 'c1' });
  assert.deepEqual(Object.keys(record).sort(), ['approvedAt', 'clientId', 'connectionId', 'issuer', 'ownerId', 'redirectOrigin', 'redirectUri', 'resource', 'scopes', 'worker']);
  assert.equal(record.redirectOrigin, 'https://c.example');
});
