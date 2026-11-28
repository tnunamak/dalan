// Scratch-only fake bridge for probes of the unmodified facade process.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startAdapter } from './acp-client.mjs';
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function waitFor(test, label, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await test()) return; await sleep(10); }
  throw new Error(`timed out: ${label}`);
}
export async function fixture(test) {
  const base = join(homedir(), '.tmp'); await mkdir(base, { recursive: true });
  const home = await mkdtemp(join(base, 'acp-probe-'));
  const socket = join(home, 'admin.sock'), stateDir = join(home, 'state'), cwd = join(home, 'plain');
  const rows = new Map(), calls = [], adapters = [], sockets = new Set();
  let hook = async () => false;
  const json = (res, value, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let bytes = ''; for await (const b of req) bytes += b;
      const body = bytes ? JSON.parse(bytes) : {}, rid = url.searchParams.get('id') ?? body.id ?? body.assignment?.request_id;
      calls.push({ route: url.pathname, rid, body });
      if (await hook({ req, res, url, body, rid, json })) return;
      const row = rows.get(rid);
      if (url.pathname === '/get') return row ? json(res, row) : json(res, { error: 'assignment not found' }, 400);
      if (url.pathname === '/status') return json(res, { counts: [], throttle: {} });
      if (url.pathname === '/submit-preview') return json(res, { verdict: 'admissible', reasons: [] });
      if (url.pathname === '/submit') { assert.ok(!row, 'duplicate submit'); rows.set(rid, { request_id: rid, assignment: body.assignment, status: 'queued' }); return json(res, { status: 'queued' }); }
      if (url.pathname === '/owner-states') return json(res, { states: body.items.map(i => ({ status: rows.get(i.id)?.status })) });
      if (url.pathname === '/progress') return json(res, { progress: [] });
      if (url.pathname === '/wait') { await sleep(20); return json(res, { status: row?.status === 'finished' ? 'finished' : 'timeout' }); }
      json(res, { error: 'unknown route' }, 400);
    } catch (e) { if (!res.destroyed) json(res, { error: e.message }, 500); }
  });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  const clean = Object.fromEntries(Object.keys(process.env).filter(k => /^(DOT_|DALAN_|T3|XDG_)/.test(k)).map(k => [k, '']));
  const env = { ...clean, HOME: home, T3CODE_HOME: join(home, 't3'), XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'), DOT_ACP_SOCKET: socket, DOT_ACP_SECRET_FILE: join(home, 'secret'), DOT_ACP_STATE_DIR: stateDir, DOT_ACP_HEARTBEAT_MS: '50' };
  try {
    await mkdir(cwd); await new Promise(r => server.listen(socket, r));
    const adapter = async (extra = {}) => { const a = startAdapter({ ...env, ...extra }, cwd); adapters.push(a); assert.ok(await a.init()); return a; };
    const state = async id => { try { return JSON.parse(await readFile(join(stateDir, `${id}.json`), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
    await test({ home, cwd, env, rows, calls, adapter, state, hook: fn => { hook = fn; }, finish(rid, result) { Object.assign(rows.get(rid), { status: 'finished', report: { outcome: 'completed', result } }); } });
  } finally {
    for (const a of adapters) a.kill('SIGKILL');
    await Promise.all(adapters.map(a => a.exited));
    for (const s of sockets) s.destroy();
    await new Promise(r => server.close(r));
    await rm(home, { recursive: true, force: true });
  }
}
