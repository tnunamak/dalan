#!/usr/bin/env node
// The server repairs a missing or long finish summary and a long progress note (finish-keeps-result-test.mjs), but an MCP
// client that validates arguments against the advertised tools/list schema never reaches that repair. The advertised
// schemas must therefore accept those calls. legacy-v46 is a frozen catalog and is covered by catalog-legacy-v46-test.mjs.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import Ajv from 'ajv';
import { fixtureEnv } from '../src/test-support/fixture-env.mjs';

const repo = resolve(import.meta.dirname, '..');
const children = new Set(), homes = [];
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(r => child.once('exit', r));
  const kill = setTimeout(() => child.kill('SIGKILL'), 2000);
  child.kill('SIGTERM');
  try { await exited; } finally { clearTimeout(kill); }
}
async function advertised(profile) {
  const home = await mkdtemp(join(tmpdir(), `dalan-schema-${profile}-`));
  homes.push(home);
  await mkdir(join(home, '.config', 'dot-bridge'), { recursive: true });
  const env = { ...fixtureEnv(home), HOME: home, DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1', DOT_BRIDGE_PORT: '0', DOT_BRIDGE_CATALOG_PROFILE: profile };
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let port, output = '';
  child.stdout.setEncoding('utf8').on('data', c => { output += c; const m = output.match(/MCP listening on 127\.0\.0\.1:(\d+)/); if (m) port = Number(m[1]); });
  child.stderr.resume();
  for (let i = 0; i < 280 && !port; i++) await new Promise(r => setTimeout(r, 25));
  assert(port, `${profile}: service did not start`);
  const secret = (await readFile(join(home, '.config', 'dot-bridge', 'env'), 'utf8')).match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  const reply = await (await fetch(`http://127.0.0.1:${port}/${secret}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })).json();
  await stop(child);
  return Object.fromEntries(reply.result.tools.filter(t => ['finish', 'progress'].includes(t.name)).map(t => [t.name, t]));
}
async function main() {
  const ajv = new Ajv({ strict: false });
  const base = { request_id: 'req_00000000', claim_id: 'claim_00000000' };
  for (const profile of ['stable', 'questions-v1', 'protocol-v0']) {
    const tools = await advertised(profile);
    const finish = ajv.compile(tools.finish.inputSchema), progress = ajv.compile(tools.progress.inputSchema);
    const accepts = (validate, args, label) => assert(validate(args), `${profile}: ${label} rejected by the advertised schema: ${JSON.stringify(validate.errors)}`);
    accepts(finish, { ...base, outcome: 'completed', result: 'done' }, 'finish without summary');
    accepts(finish, { ...base, outcome: 'completed', summary: 'x'.repeat(5000), result: 'done' }, 'finish with a 5000-character summary');
    accepts(progress, { ...base, note: 'n'.repeat(5000) }, 'progress with a 5000-character note');
    // Everything else stays required: a call without a result or an outcome is still invalid.
    assert(!finish({ ...base, outcome: 'completed' }), `${profile}: finish without result must stay invalid`);
    assert(!finish({ ...base, result: 'done' }), `${profile}: finish without outcome must stay invalid`);
    assert(!progress({ ...base }), `${profile}: progress without note must stay invalid`);
    console.log(`PASS ${profile}: advertised finish and progress schemas accept what the server repairs`);
  }
}
try { await main(); }
catch (error) { console.error(`FAIL ${error.message}`); process.exitCode = 1; }
finally { await Promise.all([...children].map(stop)); await Promise.all(homes.map(h => rm(h, { recursive: true, force: true }))); }
