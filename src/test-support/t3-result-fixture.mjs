import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, chmod, readFile } from 'node:fs/promises';
import path from 'node:path';

const version = 'fixture-2.0.0';
const token = ['private', 'fixture', 'session', 'token'].join('-');
const ticket = ['private', 'fixture', 'ticket'].join('-');

function serverFrame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length < 126) return Buffer.concat([Buffer.from([0x82, body.length]), body]);
  if (body.length < 65536) { const header = Buffer.alloc(4); header[0] = 0x82; header[1] = 126; header.writeUInt16BE(body.length, 2); return Buffer.concat([header, body]); }
  const header = Buffer.alloc(10); header[0] = 0x82; header[1] = 127; header.writeBigUInt64BE(BigInt(body.length), 2); return Buffer.concat([header, body]);
}

export async function startT3ResultFixture({ home, threadId, fakeCommand, messageFile = 'sends.jsonl', authorizeTicket = () => true }) {
  const runtimeDir = path.join(home, '.t3', 'userdata');
  const authCommand = path.join(home, '.t3', 'fixture-auth');
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await writeFile(authCommand, `#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a[0]==='--version'){console.log(${JSON.stringify(version)});process.exit(0)}if(a[0]==='auth'&&a[1]==='session'&&a[2]==='issue'){console.log(JSON.stringify({sessionId:'fixture-session',token:${JSON.stringify(token)}}));process.exit(0)}if(a[0]==='auth'&&a[1]==='session'&&a[2]==='revoke')process.exit(0);process.exit(2);\n`, { mode: 0o700 });
  await chmod(authCommand, 0o700);
  const seen = new Map();
  const sockets = new Set();
  let passedTeardown = false;
  // Installed only by an explicit successful-scenario teardown opt-in.
  const cleanupSocketError = error => { if(error.code !== 'ECONNRESET')throw error; };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/.well-known/t3/environment') return res.end(JSON.stringify({ orchestrationProtocolVersion: 2, serverVersion: version, environmentId: 'fake-environment' }));
    if (req.headers.authorization !== `Bearer ${token}` || req.headers['x-t3-orchestration-protocol'] !== '2') { res.writeHead(401).end(); return; }
    if (url.pathname === `/api/orchestration/threads/${encodeURIComponent(threadId)}` && req.method === 'GET') return res.end(JSON.stringify({ projection: { thread: { id: threadId }, runs: [] } }));
    if (url.pathname === '/api/auth/websocket-ticket' && req.method === 'POST') {
      if(!await authorizeTicket()) {res.writeHead(401).end();return;}
      return res.end(JSON.stringify({ ticket }));
    }
    res.writeHead(404).end();
  });
  server.on('upgrade', (req, socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    if(passedTeardown)socket.on('error',cleanupSocketError);
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/ws' || url.searchParams.get('wsTicket') !== ticket || url.searchParams.get('orchestrationProtocol') !== '2') return socket.destroy();
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    socket.on('data', async chunk => {
      buffer = Buffer.concat([buffer, chunk]); if (buffer.length < 2) return;
      const len = buffer[1] & 127, ext = len === 126 ? 2 : len === 127 ? 8 : 0, head = 2 + ext;
      if (buffer.length < head + 4) return;
      const size = len < 126 ? len : len === 126 ? buffer.readUInt16BE(2) : Number(buffer.readBigUInt64BE(2));
      if (buffer.length < head + 4 + size) return;
      socket.removeAllListeners('data');
      const mask = buffer.subarray(head, head + 4), payload = Buffer.from(buffer.subarray(head + 4, head + 4 + size));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      try {
        const rpc = JSON.parse(payload.toString()); const command = rpc.payload;
        if (rpc._tag !== 'Request' || rpc.tag !== 'orchestration.dispatchCommand' || command.type !== 'message.dispatch' || command.threadId !== threadId) throw Error('invalid dispatch RPC');
        let receipt = seen.get(command.commandId);
        if (!receipt) {
          const messages=path.join(home,messageFile);
          const before=await readFile(messages,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
          const child = spawn(process.execPath, [fakeCommand,'threads', 'send', '--thread', threadId, '--stdin', '--if-busy', 'steer'], { env: {...process.env,HOME:home}, stdio: ['pipe', 'ignore', 'pipe'] });
          child.stdin.end(command.text);
          const outcome = await new Promise(resolve => { let stderr = ''; child.stderr.on('data', b => stderr += b); child.on('close', code => resolve({ code, stderr })); });
          // A nonzero CLI exit may follow an accepted send. Close after acceptance so the transport reports ambiguity.
          const after=await readFile(messages,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
          if(after!==before) {receipt={sequence:seen.size+1};seen.set(command.commandId,receipt);}
          if (outcome.code !== 0) { socket.destroy(); return; }
          if(!receipt) throw Error('fake receiver returned success without recording the message');
        }
        socket.write(serverFrame({ _tag: 'Exit', requestId: rpc.id, exit: { _tag: 'Success', value: receipt } }));
      } catch { socket.destroy(); }
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await writeFile(path.join(runtimeDir, 'server-runtime.json'), JSON.stringify({ version: 1, origin, serverVersion: version }), { mode: 0o600 });
  return {
    env: { T3CODE_HOME: path.join(home, '.t3'), DOT_BRIDGE_T3_COMMAND: authCommand },
    beginPassedTeardown: () => {
      if(passedTeardown)return;
      passedTeardown=true;
      for(const socket of sockets)socket.on('error',cleanupSocketError);
    },
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}
