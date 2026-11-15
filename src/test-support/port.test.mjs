import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { portFromListeningBanner, reservedPort } from './port.mjs';

test('reads the kernel-assigned server port from the startup banner', () => {
  assert.equal(portFromListeningBanner('starting\nMCP listening on 127.0.0.1:43217\n'), 43217);
  assert.equal(portFromListeningBanner('MCP listening on 0.0.0.0:65535\n'), 65535);
});

test('does not treat an absent or invalid startup port as ready', () => {
  assert.equal(portFromListeningBanner('MCP listening soon'), null);
  assert.equal(portFromListeningBanner('MCP listening on 127.0.0.1:43'), null, 'waits for the complete line across stdout chunks');
  assert.equal(portFromListeningBanner('MCP listening on 127.0.0.1:0\n'), null);
  assert.equal(portFromListeningBanner('MCP listening on 127.0.0.1:65536\n'), null);
  assert.equal(portFromListeningBanner('MCP listening on ::1:43217\r\n'), 43217);
});

test('retries the launch callback after a real bind collision', async () => {
  const tried = [];
  const blockers = [], listeners = [];
  const listen = (server, port) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const close = server => new Promise(resolve => server.close(resolve));
  try {
    const started = await reservedPort({ attempts: 5, start: async port => {
      tried.push(port);
      if (tried.length < 3) {
        const blocker = net.createServer();
        await listen(blocker, port);
        blockers.push(blocker);
        const collision = net.createServer();
        try { await listen(collision, port); }
        catch (error) { await close(blocker); blockers.pop(); throw error; }
      }
      const listener = net.createServer();
      await listen(listener, port);
      listeners.push(listener);
      return listener;
    } });
    assert.equal(tried.length, 3);
    assert.equal(started.port, tried[2]);
    assert.equal(started.value.address().port, started.port);
  } finally {
    await Promise.all([...blockers, ...listeners].map(close));
  }
});

test('does not retry launch errors other than EADDRINUSE', async () => {
  let attempts = 0;
  await assert.rejects(reservedPort({ start: async () => {
    attempts++;
    throw Object.assign(new Error('startup failure'), { code: 'EACCES' });
  } }), error => error.code === 'EACCES');
  assert.equal(attempts, 1);
});
