// `dalan connect approve CODE` with no matching attempt names the likely causes and the fix.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectCommand } from '../src/connect-cli.mjs';

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
