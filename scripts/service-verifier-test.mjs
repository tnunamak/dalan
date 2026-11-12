import assert from 'node:assert/strict';
import { createServiceVerifier } from '../src/service-verifier.mjs';

const nonce = 'a'.repeat(64);
const verifier = createServiceVerifier();
function request(overrides = {}, handler = verifier) {
  const req = { method: 'GET', url: '/.well-known/gozar/service?nonce=' + nonce,
    rawHeaders: ['Host', 'Service.Example:443'], socket: { localPort: 8040 }, ...overrides };
  const headers = {};
  let status, body, writes = 0;
  const handled = handler(req, {
    setHeader(k, v) { headers[k] = v; writes++; },
    writeHead(code, h) { status = code; Object.assign(headers, h); writes++; },
    end(value) { body = value; writes++; },
  });
  return { handled, headers, status, body: body && JSON.parse(body), writes };
}
const first = request();
assert.equal(first.handled, true);
assert.equal(first.status, 200);
assert.equal(first.headers['Cache-Control'], 'no-store');
assert.equal(first.headers['Content-Type'], 'application/json');
assert.deepEqual(Object.keys(first.body).sort(), ['authority', 'instanceId', 'localPort', 'nonce', 'proof', 'schemaVersion']);
assert.equal(first.body.schemaVersion, 2);
assert.equal(first.body.nonce, nonce);
assert.equal(first.body.authority, 'service.example');
assert.equal(first.body.localPort, 8040);
assert.match(first.body.instanceId, /^[0-9a-f-]{36}$/);
assert.match(first.body.proof, /^[0-9a-f]{64}$/);
assert.deepEqual(request().body, first.body);
assert.deepEqual(request({ rawHeaders: ['hOsT', 'service.example'] }).body, first.body);
assert.notEqual(request({ socket: { localPort: 8041 } }).body.proof, first.body.proof);
assert.notEqual(request({ rawHeaders: ['Host', 'other.example'] }).body.proof, first.body.proof);
assert.notEqual(request({ rawHeaders: ['Host', 'service.example:8443'] }).body.proof, first.body.proof);
assert.notEqual(request({ url: '/.well-known/gozar/service?nonce=' + 'b'.repeat(64) }).body.proof, first.body.proof);
const fresh = request({}, createServiceVerifier()).body;
assert.notEqual(fresh.instanceId, first.body.instanceId);
assert.notEqual(fresh.proof, first.body.proof);
for (const [host, authority] of [
  ['[2001:DB8:0:0::1]:443', '[2001:db8::1]'], ['127.0.0.1:65535', '127.0.0.1:65535'],
  ['localhost:1', 'localhost:1'], ['a-b.example:00443', 'a-b.example'],
  ['Service.Example.:443', 'service.example.'],
]) assert.equal(request({ rawHeaders: ['Host', host] }).body.authority, authority);
function refuses(overrides) {
  const result = request(overrides);
  assert.equal(result.handled, false, JSON.stringify(overrides));
  assert.equal(result.writes, 0, 'refusal must not touch response');
}
for (const host of [null, 12, '', 'a b', 'a\tb', 'a\nb', 'a/b', 'a\\b', 'a@b',
  'a?b', 'a#b', 'a%b', 'a,b', '-a.test', 'a-.test', 'a..test',
  'a'.repeat(64) + '.test', Array(5).fill('a'.repeat(63)).join('.'),
  '[not-v6]', '[127.0.0.1]', '[::1', '::1', 'a:0', 'a:65536', 'a:-1', 'a:x',
  'a:', '999.1.1.1', '127.1', '2130706433', '0x7f000001', '0177.0.0.1']) {
  refuses({ rawHeaders: ['Host', host] });
}
for (const rawHeaders of [undefined, [], ['Host'], ['Host', 'a', 'HOST', 'a'],
  ['X-Forwarded-Host', 'service.example'], ['Forwarded', 'host=service.example']]) refuses({ rawHeaders });
for (const localPort of [undefined, null, '8040', 0, -1, 65536, 1.5, NaN, Infinity]) refuses({ socket: { localPort } });
refuses({ socket: undefined });
refuses({ rawHeaders: [], headers: { host: 'service.example', 'x-forwarded-host': 'service.example' } });
refuses({ socket: {}, rawHeaders: ['Host', 'service.example', 'X-Forwarded-Port', '8040'] });
assert.deepEqual(request({ rawHeaders: ['Host', 'service.example', 'X-Forwarded-Host', 'evil.example',
  'X-Forwarded-Port', '9999', 'Forwarded', 'host=evil.example:9999'], headers: { host: 'evil.example' } }).body, first.body);
for (const method of ['POST', 'HEAD', 'get', undefined]) refuses({ method });
for (const url of [undefined, '/', '/.well-known/gozar/service', '/.well-known/gozar/service/',
  '/.well-known/gozar/service?nonce=' + 'A'.repeat(64),
  '/.well-known/gozar/service?nonce=' + 'a'.repeat(63),
  '/.well-known/gozar/service?nonce=' + nonce + '&nonce=' + nonce,
  '/.well-known/gozar/service?nonce=' + nonce + '&x=1',
  '/.well-known/gozar/service?nonce=' + nonce + '#fragment',
  'https://service.example/.well-known/gozar/service?nonce=' + nonce]) refuses({ url });
console.log('service-verifier v2 mock-request boundaries: PASS');
