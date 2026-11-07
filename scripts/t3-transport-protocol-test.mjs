#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';

const temp = await mkdtemp(path.join(os.tmpdir(), 't3-transport-protocol-'));
const home = path.join(temp, 'home');
const callsPath = path.join(temp, 'auth-calls.jsonl');
const authPath = path.join(temp, 'fake-t3');
let server;
const sockets = new Set();
const requests = [];
const records = new Map();
let dispatchCount = 0;
let ticketCount = 0;
let refusedPath = null;
let refusedStatus = 401;
const expectedToken = ['fixture', 'session', 'token'].join('-');
const ticket = 'fixture-ticket';

try {
  await mkdir(path.join(home, 'userdata'), { recursive: true });
  await writeFile(path.join(home, 'userdata', 'server-runtime.json'), JSON.stringify({ version: 1, origin: 'http://127.0.0.1:0', serverVersion: 'fixture-2.0.0' }));
  // The port is filled after listen, before the adapter reads this runtime record.
  await writeFile(authPath, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');\nif (args[0] === '--version') { process.stdout.write('t3 fixture-2.0.0\\n'); process.exit(0); }\nif (args[0] === 'auth' && args[1] === 'session' && args[2] === 'issue') { process.stdout.write(JSON.stringify({sessionId:'fixture-session',token:${JSON.stringify(expectedToken)}})); process.exit(0); }\nif (args[0] === 'auth' && args[1] === 'session' && args[2] === 'revoke') process.exit(0);\nprocess.exit(2);\n`);
  await chmod(authPath, 0o755);

  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, pathname: url.pathname, search: url.search, authorization: req.headers.authorization, protocol: req.headers['x-t3-orchestration-protocol'] });
    if (url.pathname === '/.well-known/t3/environment') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ orchestrationProtocolVersion: 2, serverVersion: 'fixture-2.0.0', environmentId: 'fixture-env' }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${expectedToken}` || req.headers['x-t3-orchestration-protocol'] !== '2') {
      res.writeHead(401).end(); return;
    }
    if(url.pathname===refusedPath) {res.writeHead(refusedStatus).end();return;}
    if (url.pathname === '/api/orchestration/threads/thread-fixture') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ projection: { thread: { id: 'thread-fixture' }, runs: [] } }));
      return;
    }
    if (url.pathname === '/api/auth/websocket-ticket') {
      if (req.method !== 'POST') { res.writeHead(405).end('POST required'); return; }
      ticketCount++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ticket })); return;
    }
    res.writeHead(404).end();
  });
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const url = new URL(req.url, 'http://127.0.0.1');
    assert.equal(url.pathname, '/ws');
    assert.equal(url.searchParams.get('wsTicket'), ticket);
    assert.equal(url.searchParams.get('orchestrationProtocol'), '2');
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 2) return;
      const len = buffer[1] & 0x7f;
      const headerLength = len === 126 ? 4 : len === 127 ? 10 : 2;
      if (buffer.length < headerLength + 4) return;
      const size = len < 126 ? len : len === 126 ? buffer.readUInt16BE(2) : Number(buffer.readBigUInt64BE(2));
      if (buffer.length < headerLength + 4 + size) return;
      const mask = buffer.subarray(headerLength, headerLength + 4);
      const payload = Buffer.from(buffer.subarray(headerLength + 4, headerLength + 4 + size));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      socket.removeAllListeners('data'); // this fixture serves one RPC per connection
      const rpc = JSON.parse(payload.toString('utf8'));
      assert.deepEqual(rpc, { _tag: 'Request', id: '1', tag: 'orchestration.dispatchCommand', payload: rpc.payload, headers: [] });
      assert.equal(rpc.payload.type, 'message.dispatch');
      assert.equal(rpc.payload.threadId, 'thread-fixture');
      assert.equal(rpc.payload.text, 'job result');
      assert.equal(rpc.payload.createdBy, 'user');
      assert.equal(rpc.payload.creationSource, 'web');
      assert.deepEqual(rpc.payload.attachments, []);
      requests.push({ websocket: true, rpc });
      dispatchCount++;
      const prior = records.get(rpc.payload.commandId);
      const receipt = prior ?? { sequence: 700 + dispatchCount };
      records.set(rpc.payload.commandId, receipt);
      if (dispatchCount === 1) { socket.destroy(); return; }
      // T3 sends binary JSON frames. A client that leaves binaryType at "blob" cannot decode with TextDecoder.
      const body = Buffer.from(JSON.stringify({ _tag: 'Exit', requestId: '1', exit: { _tag: 'Success', value: receipt } }));
      const frame = Buffer.concat([Buffer.from([0x82, body.length]), body]);
      socket.write(frame);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  await writeFile(path.join(home, 'userdata', 'server-runtime.json'), JSON.stringify({ version: 1, origin, serverVersion: 'fixture-2.0.0' }));
  process.env.T3CODE_HOME = home;
  process.env.DOT_BRIDGE_T3_COMMAND = authPath;
  const { dispatchT3Result, resultDeliveryIds } = await import('../src/t3-transport.mjs');
  const { preAcceptAuthRejection } = await import('../src/t3.mjs');
  const ids = resultDeliveryIds('job-fixture', 'effect-fixture');
  await assert.rejects(dispatchT3Result('thread-fixture', 'fixture-env', 'job-fixture', 'effect-fixture', 'job result'),error=>{
    assert.equal(preAcceptAuthRejection(error),false,'lost dispatch reply must remain ambiguous');return true;
  });
  const firstTicketRequest = requests.find(x => x.pathname === '/api/auth/websocket-ticket');
  assert.equal(firstTicketRequest?.method, 'POST', 'T3 requires POST /api/auth/websocket-ticket');
  const result = await dispatchT3Result('thread-fixture', 'fixture-env', 'job-fixture', 'effect-fixture', 'job result');
  assert.deepEqual(result, { sequence: 701 });
  assert.equal(dispatchCount, 2);
  assert.equal(ticketCount, 2);
  assert.equal(records.size, 1);
  assert.equal(requests.filter(x => x.websocket).length, 2);
  for (const { rpc } of requests.filter(x => x.websocket)) {
    assert.equal(rpc.payload.commandId, ids.commandId);
    assert.equal(rpc.payload.messageId, ids.messageId);
  }
  const ticketRequests = requests.filter(x => x.pathname === '/api/auth/websocket-ticket');
  assert.equal(ticketRequests.length, 2);
  assert(ticketRequests.every(x => x.method === 'POST' && x.authorization === `Bearer ${expectedToken}` && x.protocol === '2'));
  const threadRequests = requests.filter(x => x.pathname === '/api/orchestration/threads/thread-fixture');
  assert.equal(threadRequests.length, 2);
  assert(threadRequests.every(x => x.method === 'GET' && x.authorization === `Bearer ${expectedToken}` && x.protocol === '2'));
  const authCalls = (await readFile(callsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(authCalls.filter(args => args[0] === '--version').length, 2);
  assert.equal(authCalls.filter(args => args[0] === 'auth' && args[2] === 'issue').length, 2);
  assert.equal(authCalls.filter(args => args[0] === 'auth' && args[2] === 'revoke').length, 2);
  for(refusedPath of ['/api/orchestration/threads/thread-fixture','/api/auth/websocket-ticket']) {
    await assert.rejects(dispatchT3Result('thread-fixture','fixture-env','job-fixture','effect-fixture','job result'),error=>{
      assert.equal(preAcceptAuthRejection(error),true,'definite HTTP401 before dispatch is safe for bounded auth retry');return true;
    });
    assert.equal(dispatchCount,2,'auth rejection must precede dispatch');assert.equal(records.size,1);
  }
  refusedStatus=500;
  await assert.rejects(dispatchT3Result('thread-fixture','fixture-env','job-fixture','effect-fixture','job result'),error=>{
    assert.equal(preAcceptAuthRejection(error),false,'server errors are not definite auth rejection');return true;
  });
  assert.equal(dispatchCount,2);assert.equal(records.size,1);
  const finalAuthCalls=(await readFile(callsPath,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(finalAuthCalls.filter(args=>args[0]==='auth'&&args[2]==='issue').length,5);
  assert.equal(finalAuthCalls.filter(args=>args[0]==='auth'&&args[2]==='revoke').length,5,'pre-dispatch refusals still revoke each temporary session');
  console.log('transport protocol regression passed');
} finally {
  for (const socket of sockets) socket.destroy();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
