#!/usr/bin/env node
// Stand-in parent provider for the real-T3 gate: an ACP agent with no model that drives T3's orchestrator MCP tools
// (the stdio `t3 acp-mcp-bridge` T3 passes in session/new) so a real T3 server runs a real delegate_task to the worker.
// Prompts: `DELEGATE <clientRequestId> <task>` calls delegate_task(mode async) at the worker;
//          `WAIT <clientRequestId> <task>` calls it with mode wait;
//          `CANCEL <taskId>` calls task_cancel;
//          any prompt naming a taskId (T3's completion wake) calls task_status for it.
import { Readable, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import * as acp from '@agentclientprotocol/sdk';

const LOG = process.env.GATE_LOG;
const note = (kind, data) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), kind, ...data }) + '\n'); };
const sessions = new Map();

function mcp(server) {
  const child = spawn(server.command, server.args ?? [], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...Object.fromEntries((server.env ?? []).map(e => [e.name, e.value])) } });
  const pending = new Map(); let id = 0;
  readline.createInterface({ input: child.stdout }).on('line', l => { try { const m = JSON.parse(l); if (m.id !== undefined) { pending.get(m.id)?.(m); pending.delete(m.id); } } catch {} });
  const rpc = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
  return { child, rpc, async init() { await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-parent', version: '0' } }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); },
    async call(name, args) { const r = await rpc('tools/call', { name, arguments: args }); note('mcp_call', { name, args, result: r.result ?? r.error }); return r; } };
}
const bridgeOf = async s => { if (!s.mcp) { const server = s.mcpServers.find(m => m.command); s.mcp = mcp(server); await s.mcp.init(); } return s.mcp; };
const textOfResult = r => (r.result?.content ?? []).map(c => c.text).join('\n') || JSON.stringify(r.error);

const agent = acp.agent({ name: 'fake-parent', version: '0' })
  .onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentInfo: { name: 'fake-parent', version: '0' }, agentCapabilities: { loadSession: true }, authMethods: [] }))
  .onRequest(acp.methods.agent.session.new, ({ params }) => { const id = crypto.randomUUID(); sessions.set(id, { mcpServers: params.mcpServers }); return { sessionId: id, configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'parent', options: [{ value: 'parent', name: 'Parent' }] }] }; })
  .onRequest(acp.methods.agent.session.load, ({ params }) => { sessions.set(params.sessionId, { mcpServers: params.mcpServers }); return {}; })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const s = sessions.get(params.sessionId);
    const text = params.prompt.filter(b => b.type === 'text').map(b => b.text).join('\n');
    note('prompt', { text });
    const say = t => client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } } });
    const open = text.indexOf('<user_request>'), user = (open < 0 ? text.replace(/\n?<(?:runtime_info|pull_request_linking)>[\s\S]*$/, '') : text.slice(open + 14, text.lastIndexOf('</user_request>'))).trim();
    const cancel = /^CANCEL (node:\S+)$/.exec(user);
    const m = /^(DELEGATE|WAIT) (\S+) ([\s\S]+)$/.exec(user);
    const b = await bridgeOf(s);
    if (cancel) {
      const r = await b.call('task_cancel', { taskId: cancel[1], reason: 'gate' });
      await say(`task_cancel -> ${textOfResult(r).slice(0, 500)}`);
    } else if (m) {
      const r = await b.call('delegate_task', { task: m[3], mode: m[1] === 'WAIT' ? 'wait' : 'async', clientRequestId: m[2], target: { providerInstanceId: 'dot', driverKind: 'acpRegistry', model: 'dot' } });
      await say(`delegate_task -> ${textOfResult(r).slice(0, 1500)}`);
    } else {
      const ids = [...new Set([...text.matchAll(/taskId\s+(node:\S+)/g)].map(x => x[1]))];
      if (!ids.length) { await say('nothing to do'); return { stopReason: 'end_turn' }; }
      for (const id of ids) { const r = await b.call('task_status', { taskId: id }); await say(`task_status ${id} -> ${textOfResult(r).slice(0, 1500)}`); }
    }
    return { stopReason: 'end_turn' };
  });
process.stdin.on('end', () => process.exit(0));
agent.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
