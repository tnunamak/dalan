// `dalan connect approve CODE` with no matching attempt names the likely causes and the fix.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { connectCommand } from '../src/connect-cli.mjs';

test('committed connection gets a fresh callback budget without re-approval', async () => {
  const source = readFileSync(new URL('../src/connect-cli.mjs', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('async function completeLocalConnection('), source.indexOf('\nexport async function connectCommand('));
  const first = { aborted: false }, second = { aborted: false };
  let timers = 0, approvals = 0, callbacks = 0;
  const origin = 'https://bridge.example.invalid';
  const redirect = 'http://127.0.0.1:19000/callback';
  const interaction = new URL(origin + '/fixture/interaction/fixture001');
  const callback = new URL(redirect);
  const pending = { authorization_endpoint_fingerprint: 'fixture', window: { worker: 'local' },
    pending: [{ interaction_fingerprint: 'fixture', worker: 'local', native: true, redirect_uri: redirect, code: 'fixture' }] };
  const complete = runInNewContext(code + '\ncompleteLocalConnection', {
    URL, fingerprint: () => 'fixture', authorityEndpoint: () => 'fixture', isLocalRedirect: () => true,
    q: JSON.stringify,
    AbortSignal: { timeout: () => (++timers === 1 ? first : second) },
    interactionBrowser: (_issuer, initial) => async (url, phase = initial) => {
      if (phase.aborted) throw new Error('fixture deadline expired');
      return url.pathname === '/fixture/auth' ? { step: interaction } : url === interaction && approvals === 0 ? { status: 200 } : { step: callback };
    },
    nextUrl: reply => reply.step, sameLocalCallback: value => value === callback,
    sendLocalCallback: async (_url, phase) => { assert.equal(phase, second); callbacks += 1; },
  });
  const result = await complete(origin + '/fixture/auth?redirect_uri=' + encodeURIComponent(redirect), 'local', false,
    async route => {
      if (route === '/connect/pending') return pending;
      assert.equal(route, '/connect/approve'); approvals += 1; first.aborted = true;
      return { connection_id: 'fixture-committed' };
    }, () => ({}));
  assert.equal(result.connection_id, 'fixture-committed');
  assert.equal(timers, 2);
  assert.equal(approvals, 1);
  assert.equal(callbacks, 1);
});

test('a code that matches no pending pairing names expiry, a mistyped code and the fix', async () => {
  const request = async route => route === '/connect/pending' ? { window: { worker: 'local', expires_at: 'later' }, pending: [] } : assert.fail(`unexpected request ${route}`);
  const options = new Map([['--worker', 'local']]);
  await assert.rejects(connectCommand(['approve', 'ABCD-EFGH', '--worker', 'local'], { request, operator: () => 'key', option: name => options.get(name) ?? null, json: false }), error => {
    assert.match(error.message, /^No pending pairing matches this code\./);
    assert.match(error.message, /attempts last 10 minutes/);
    assert.match(error.message, /expired/);
    assert.match(error.message, /mistyped/);
    assert.match(error.message, /start the sign-in again in the client/i);
    assert.match(error.message, /dalan connect pending/);
    return true;
  });
});
