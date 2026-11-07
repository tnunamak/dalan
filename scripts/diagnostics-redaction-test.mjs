#!/usr/bin/env node
// Diagnostics choke point: child stderr and HTTP/MCP response bodies must never reach an Error message, a log, a
// printed line or an alert unredacted. Every secret below is synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(process.env.HOME ?? os.tmpdir(), '.tmp-diagnostics-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const failures = [];
const row = async (n, fn) => { try { await fn(); } catch (error) { failures.push(`row ${n}: ${String(error.message).split('\n')[0].slice(0, 160)}`); } };
// Each case runs on its own, so one failing sink never hides another.
const rows = async (n, cases) => { for (const [name, fn] of Object.entries(cases)) await row(`${n} ${name}`, fn); };
const GH = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const OPAQUE = 'opaquevalue' + 'Zq9Xw8Vu7Ts6';
const HEX = 'c0ffee'.repeat(10) + 'abcd';
assert.equal(HEX.length, 64);
// HEX stands for the bridge path secret. A process that holds it registers it, and every sink masks it by value;
// there is no generic hex rule.
(await import('../src/redaction.mjs')).registerSecret(HEX);
// Secrets first, then padding, then a token that starts `at` characters in, so a clip at that column cuts it in half.
const body = at => `Bearer ${OPAQUE} ${HEX} ` + 'x'.repeat(at - `Bearer ${OPAQUE} ${HEX} `.length - 1) + ' ' + GH + ' tail';
// Prefixes count as leaks: a parser or a clip can cut a secret short.
const leaks = text => [OPAQUE.slice(0, 8), HEX.slice(0, 8), GH.slice(0, 8)].filter(s => text.includes(s));
const assertClean = (label, text) => assert.deepEqual(leaks(String(text)), [], `${label} leaked ${JSON.stringify(leaks(String(text)))}: ${String(text).slice(0, 400)}`);

const fake = (name, source) => { const f = path.join(tmp, name); fs.writeFileSync(f, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 }); return f; };
const server = handler => new Promise(resolve => {
  const s = http.createServer(handler);
  s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise(d => s.close(d)) }));
});
const field = `password=${OPAQUE} {"access_token":"${OPAQUE}"} cookie: sid=${OPAQUE} authorization: ${OPAQUE}`;

// Row 1: the shared helpers.
await rows(1, {
  async clip() {
    const { redactLogEntry } = await import('../src/redaction.mjs');
    assertClean('redactLogEntry', redactLogEntry('y'.repeat(16384 - 13) + ' ' + GH + ' tail'));
    const { safeDiagnostic } = await import('../src/diagnostic.mjs');
    assertClean('safeDiagnostic', safeDiagnostic(body(290), 300));
    assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(safeDiagnostic('a\u0000b\u001b[31mc')));
  },
  async opaqueFields() {
    const { safeDiagnostic } = await import('../src/diagnostic.mjs');
    assertClean('safeDiagnostic opaque fields', safeDiagnostic(field, 2000));
    assertClean('safeDiagnostic JSON body', safeDiagnostic(JSON.stringify({ password: OPAQUE, access_token: OPAQUE, nested: { cookie: OPAQUE } }), 2000));
  },
  async quotedValueAtClipBoundary() {
    const { redactLogEntry } = await import('../src/redaction.mjs');
    // The quoted value spans the 16,384 clip; the closing quote is cut off, so masking after the clip would miss it.
    for (const pad of [0, 1, 2]) assertClean(`quoted boundary ${pad}`, redactLogEntry('y'.repeat(16384 - 11 - 10 + pad) + ` password="${OPAQUE} more words"`));
  },
  async parseJsonBodyNeverQuotesTheBody() {
    const { parseJsonBody } = await import('../src/diagnostic.mjs');
    for (const text of [GH + ' x', `glpat-${'a1b2c3d4e5'.repeat(2)} x`, `npm_${'a1b2c3d4e5'.repeat(3)} x`, `${HEX} x`, `${OPAQUE} x`]) {
      let message = '';
      try { parseJsonBody(text, 'body'); } catch (error) { message = error.message; }
      assert.match(message, /body is not valid JSON/);
      assert.ok(!message.includes(text.slice(0, 6)), `parse error quoted the body: ${message}`);
    }
  },
});

// Row 2: t3code stderr, ok:false and malformed output become the Error message and the delivery reason.
process.env.NODE_ENV = 'test';
const t3 = await import('../src/t3.mjs');
const withBin = (name, src) => { process.env.DALAN_T3CODE_BIN = fake(name, src); };
await rows(2, {
  async stderr() {
    withBin('t3-stderr', `process.stderr.write(${JSON.stringify(body(200))});process.exit(1);`);
    await assert.rejects(t3.callT3(['threads', 'list']), e => (assertClean('t3 stderr error', e.message), true));
  },
  async okFalse() {
    withBin('t3-okfalse', `process.stdout.write(JSON.stringify({ok:false,error:{code:'X',message:${JSON.stringify(body(200))}}}));`);
    await assert.rejects(t3.callT3(['threads', 'list']), e => (assertClean('t3 ok:false error', e.message), true));
  },
  async malformedSuccess() {
    withBin('t3-malformed', `process.stdout.write(${JSON.stringify(`${HEX} ${OPAQUE}`)});`);
    await assert.rejects(t3.callT3(['threads', 'list']), e => (assertClean('t3 malformed output', e.message), true));
  },
  async metadataLookup() {
    await assert.rejects(t3.inspectMetadata('thread-1', async () => { throw new Error(body(200)); }), e => (assertClean('inspectMetadata', e.message), /metadata lookup/.test(e.message)));
  },
  async deliveryReason() {
    withBin('t3-deliver', `const a=process.argv.slice(2).join(' ');if(a.includes('inspect')){process.stdout.write(JSON.stringify({ok:true,data:{thread:{id:'thread-1',status:'active'},runtime:{environmentId:'env-1'}}}));}else{process.stderr.write(${JSON.stringify(body(200))});process.exit(1);}`);
    const meta = await t3.deliverT3('thread-1', 'env-1', 'evt-1', 'hello');
    assert.equal(meta.state, 'ambiguous', JSON.stringify(meta).slice(0, 200));
    assertClean('deliverT3 reason', meta.reason);
  },
});

// Row 3: gh, dalan status/cancel/submit stderr reach Error messages; the run loop's log.jsonl and printed line.
const prh = await import('../src/pr-head-reviewer.mjs');
const cfg3 = { ...prh.DEFAULTS, bridge_db: ':memory:', t3_db: ':memory:', owners: ['o'], repos: ['o/r'], exclude_owners: [] };
const depsWith = runCommand => prh.realDeps(cfg3, runCommand);
const ok200 = json => `HTTP/2 200\r\netag: "e"\r\n\r\n${json}`;
await rows(3, {
  async ghFailure() {
    await assert.rejects(depsWith(async () => ({ code: 1, stdout: '', stderr: body(200) })).prDetails('o/r', 1), e => (assertClean('gh error', e.message), true));
  },
  async ghMalformedJson() {
    await assert.rejects(depsWith(async () => ({ code: 0, stdout: ok200(`${HEX} ${OPAQUE}`), stderr: '' })).prDetails('o/r', 1), e => (assertClean('gh malformed json', e.message), true));
  },
  async ghRateLimitMessage() {
    await assert.rejects(depsWith(async () => ({ code: 1, stdout: '', stderr: 'rate limit exceeded ' + body(200) })).prDetails('o/r', 1), e => (assert.ok(e instanceof prh.GitHubRateLimit), assertClean('rate limit message', e.message), true));
  },
  async rateLimitHeadersBeyondTheClip() {
    // Retry-After sits past the 2,000-character diagnostic clip; it must still set a 2 minute backoff, not the 1 hour default.
    const stdout = `HTTP/2 429\r\nx-padding: ${'x'.repeat(2500)}\r\nretry-after: 120\r\n\r\n{}`;
    const before = Date.now();
    await assert.rejects(depsWith(async () => ({ code: 1, stdout, stderr: '' })).prDetails('o/r', 1), e => {
      assert.ok(e instanceof prh.GitHubRateLimit);
      const wait = Date.parse(e.until) - before;
      assert.ok(wait >= 119_000 && wait < 600_000, `backoff was ${wait} ms`);
      return true;
    });
  },
  async statusFailure() {
    await assert.rejects(depsWith(async () => ({ code: 1, stdout: '', stderr: body(200) })).status(), e => (assertClean('status error', e.message), /^status:/.test(e.message)));
  },
  async statusMalformedJson() {
    await assert.rejects(depsWith(async () => ({ code: 0, stdout: `${HEX} ${OPAQUE}`, stderr: '' })).status(), e => (assertClean('status malformed json', e.message), true));
  },
  async cancelFailure() {
    await assert.rejects(depsWith(async () => ({ code: 1, stdout: '', stderr: body(200) })).cancel('req_1', 'pr_closed'), e => (assertClean('cancel error', e.message), /^cancel req_1/.test(e.message)));
  },
  async submitFailure() {
    const r = await depsWith(async () => ({ code: 1, stdout: '', stderr: body(200) })).submit({}, { delivery: 'none', objective: 'o', head: 'h' });
    assert.equal(r.ok, false);
    assertClean('submit error', r.error);
  },
  async submitOutError() {
    const r = await depsWith(async () => ({ code: 0, stdout: JSON.stringify({ error: body(200) }), stderr: '' })).submit({}, { delivery: 'none', objective: 'o', head: 'h' });
    assert.equal(r.ok, false);
    assertClean('submit out.error', r.error);
  },
  async logLine() {
    // `password=` is masked only by the log redactor; the message is not sanitized before it reaches log().
    const stateDir = path.join(tmp, 'prh-log'), printed = [];
    const deps = { now: () => Date.now(), status: async () => { throw new Error(`failed password=${OPAQUE} token ${GH}`); } };
    await prh.run({ cfg: cfg3, deps, stateDir, only: { repo: 'o/r', number: 1 }, print: line => printed.push(line) });
    assert.ok(printed.some(l => l.includes('"error"')), 'the run loop should log the error');
    assertClean('printed line', printed.join('\n'));
    assertClean('log.jsonl', fs.readFileSync(path.join(stateDir, 'log.jsonl'), 'utf8'));
  },
});

// Row 4: an MCP response becomes a thrown error that `dalan try` prints.
const { openSession } = await import('../src/demo-worker.mjs');
const { describeTryError } = await import('../src/try.mjs');
const mcp = (respond) => server(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const message = JSON.parse(raw);
  const [status, text, headers] = respond(message) ?? [200, JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25' } }), {}];
  res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(text);
});
const failsWith = async (respond, check) => {
  const s = await mcp(respond);
  try { const call = await openSession(s.url + '/mcp', 'token'); await call('tool', {}); assert.fail('openSession should fail'); }
  catch (error) { if (error.code === 'ERR_ASSERTION') throw error; check(error); }
  finally { await s.close(); }
};
await rows(4, {
  async httpStatus() { await failsWith(() => [500, body(185)], e => { assertClean('http 500', e.message); assert.match(e.message, /HTTP 500/); }); },
  async opaqueFieldsInStatusBody() { await failsWith(() => [500, field], e => assertClean('http 500 fields', e.message)); },
  async initializeWithoutProtocolVersion() {
    await failsWith(m => m.method === 'initialize' ? [200, JSON.stringify({ jsonrpc: '2.0', id: 1, result: { note: body(100) } })] : null,
      e => { assertClean('initialize', e.message); assert.match(e.message, /initialize returned no protocol version/); });
  },
  async initializeMalformedJson() { await failsWith(m => m.method === 'initialize' ? [200, `${HEX} ${OPAQUE}`] : null, e => assertClean('initialize json', e.message)); },
  async toolErrorResult() {
    await failsWith(m => m.method === 'tools/call' ? [200, JSON.stringify({ jsonrpc: '2.0', id: 2, result: { isError: true, content: [{ type: 'text', text: `${field} ${body(100)}` }] } })]
      : m.method === 'notifications/initialized' ? [202, ''] : null, e => { assertClean('tool error', e.message); assert.match(e.message, /^tool failed/); });
  },
  async toolMalformedResult() {
    await failsWith(m => m.method === 'tools/call' ? [200, JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: `${HEX} ${OPAQUE}` }] } })]
      : m.method === 'notifications/initialized' ? [202, ''] : null, e => assertClean('tool result json', e.message));
  },
  async printedTryError() {
    assertClean('dalan try output (child stderr)', await describeTryError(new Error(`dalan serve failed: ${body(400)} ${field}`), { started: false, shellCli: 'dalan' }));
  },
});

// Row 4b: `dalan try` child stderr at Error construction, and the saved server.log.
const { runTry } = await import('../src/try.mjs');
const { reservedPort } = await import('../src/test-support/port.mjs');
const preload = mode => { const f = path.join(tmp, `preload-${mode}.cjs`); fs.writeFileSync(f, `if (process.argv[1].endsWith(${JSON.stringify(mode)})) { const a = ${JSON.stringify(`password=${OPAQUE} Bearer ${OPAQUE} ${HEX} `)}; process.stderr.write(a + ${JSON.stringify(GH.slice(0, 12))}); setTimeout(() => { process.stderr.write(${JSON.stringify(GH.slice(12))} + '\\n'); if (${JSON.stringify(mode)} === 'dalan.mjs') process.exit(1); }, 60); }\n`); return f; };
await rows('4b', {
  async dalanChildStderrInError() {
    const home = path.join(tmp, 'try-a');
    await assert.rejects(runTry({ argv: ['--home', home], env: { PATH: process.env.PATH, NODE_OPTIONS: `--require ${preload('dalan.mjs')}` }, out: { write() {} }, input: new PassThrough(), pickPort: async () => reservedPort(), errorContext: {} }),
      e => (assertClean('runTry error', e.message), assert.match(e.message, /dalan init .* failed/), true));
  },
  async serverLogIsSanitized() {
    const home = path.join(tmp, 'try-b'), port = await reservedPort();
    const blocker = net.createServer(); await new Promise(r => blocker.listen(port, '127.0.0.1', r));
    try {
      await assert.rejects(runTry({ argv: ['--home', home, '--port', String(port)], env: { PATH: process.env.PATH, NODE_OPTIONS: `--require ${preload('server.mjs')}` }, out: { write() {} }, input: new PassThrough(), pickPort: async () => port, errorContext: {} }));
    } finally { blocker.close(); }
    const log = fs.readFileSync(path.join(home, 'server.log'), 'utf8');
    assert.ok(log.includes('[redacted secret]'), `the server output should be in the log: ${log.slice(0, 200)}`);
    assertClean('server.log', log);
  },
});

// Row 5: a malformed health response reaches stderr, ntfy and the saved failure state.
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('PASS diagnostics redaction');
