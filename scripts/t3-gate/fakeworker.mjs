#!/usr/bin/env node
// Fake worker for the real-T3 gate: node fakeworker.mjs <bridge-home> <port> claim|finish|do <request_id> [result text]
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
const [home, port, cmd, rid, ...rest] = process.argv.slice(2);
const secret = fs.readFileSync(`${home}/.config/dot-bridge/env`, 'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
const rpc = async (name, args) => { const r = await fetch(`http://127.0.0.1:${port}/${secret}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }) }); return JSON.parse((await r.json()).result.content[0].text); };
const claim = await rpc('claim', { request_id: rid, claimant: 'fake-worker' });
if (cmd === 'claim') { console.log(JSON.stringify(claim)); process.exit(0); }
console.log(JSON.stringify(await rpc('finish', { request_id: rid, claim_id: claim.claim_id, outcome: 'completed', summary: 'done', result: rest.join(' ') || 'RESULT' })));
