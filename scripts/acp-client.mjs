// Raw ndjson ACP client for tests: spawns bin/dot-acp-agent.mjs and sends T3's hybrid initialize payload.
// A stdout line that is not a JSON-RPC frame fails the test: the adapter must keep stdout for protocol frames only.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { resolve } from 'node:path';

const agentPath = resolve(new URL('../bin/dot-acp-agent.mjs', import.meta.url).pathname);

export function startAdapter(env, cwd = process.cwd()) {
  const child = spawn(process.execPath, [agentPath], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env }, cwd });
  const pending = new Map(), updates = [], errors = [];
  let id = 0, stderr = '';
  child.stderr.on('data', b => { stderr += b; });
  // A dead adapter answers every open request with an error instead of leaving the test waiting forever.
  const exited = new Promise(r => child.once('exit', (code, signal) => {
    for (const [i, res] of pending) res({ jsonrpc: '2.0', id: i, error: { code: 'adapter_exited', message: `adapter exited (${code ?? signal}): ${stderr.slice(-400)}` } });
    pending.clear(); r({ code, signal });
  }));
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let m;
    try { m = JSON.parse(line); } catch { errors.push(`non-JSON stdout line: ${line.slice(0, 120)}`); return; }
    if (m.jsonrpc !== '2.0') errors.push(`non-protocol frame: ${line.slice(0, 120)}`);
    if (m.id !== undefined && (m.result !== undefined || m.error)) { pending.get(m.id)?.(m); pending.delete(m.id); }
    else if (m.method === 'session/update') updates.push(m.params.update);
  });
  const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const api = {
    child, updates, errors, exited, send, notify, stderr: () => stderr,
    async init() {
      const r = await send('initialize', { protocolVersion: 2, info: { name: 't3-code', version: '0' }, capabilities: { elicitation: { form: {} } }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 't3-code', version: '0' } });
      return r.result;
    },
    async newSession(cwd) { return (await send('session/new', { cwd, mcpServers: [] })).result; },
    loadSession: (sessionId, cwd) => send('session/load', { sessionId, cwd, mcpServers: [] }),
    prompt: (sessionId, text) => send('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }),
    promptBlocks: (sessionId, prompt) => send('session/prompt', { sessionId, prompt }),
    cancel: sessionId => notify('session/cancel', { sessionId }),
    rawText: type => updates.filter(u => u.sessionUpdate === type).map(u => u.content.text).join(''),
    // The result's closing 'decide:' line is asserted once (acp-e2e); every other check reads the text without it.
    text: type => updates.filter(u => u.sessionUpdate === type).map(u => u.content.text).join('').replace(/\n\ndecide: (?:dalan|dot-worker) decide \S+ accepted\|applied\|useful_no_change\|useful_negative\|not_useful/g, ''),
    kill: signal => child.kill(signal),
  };
  return api;
}
