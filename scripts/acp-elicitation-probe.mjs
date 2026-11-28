#!/usr/bin/env node
// P5: the real T3 runtime projects facade elicitation into a pending user_input.
// Requires t3 and t3code on PATH (or T3_PROBE_BIN and T3_PROBE_CLI).
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { realpath, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { fixture, waitFor } from './acp-probe-fixture.mjs';
const t3 = process.env.T3_PROBE_BIN || 't3';
const cli = process.env.T3_PROBE_CLI || execFileSync('which', ['t3code'], { encoding: 'utf8' }).trim();
const { T3Api } = await import(pathToFileURL(join(dirname(await realpath(cli)), 'api.js')));
await fixture(async f => {
  const t3Home = join(f.home, 't3'); await mkdir(t3Home);
  const env = { ...process.env, ...f.env, T3CODE_HOME: t3Home, T3CODE_OTEL_SDK_DISABLED: '1' };
  // Resolve a free port before spawning; the server must bind loopback only.
  const listener = net.createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port; await new Promise(r => listener.close(r));
  const server = spawn(t3, ['serve', '--base-dir', t3Home, '--host', '127.0.0.1', '--port', String(port), '--no-browser'], { cwd: f.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false, startError = null;
  server.once('error', e => { startError = e; });
  const exited = new Promise(r => { server.once('exit', r); server.once('error', r); });
  // Never forward server output: it contains scratch pairing credentials.
  const onData = b => { if (String(b).includes('server is ready')) ready = true; };
  server.stdout.on('data', onData); server.stderr.on('data', onData);
  try {
    await waitFor(() => { if (startError) throw new Error(`scratch T3 did not start: ${startError.message}`); if (server.exitCode !== null) throw new Error(`scratch T3 exited (${server.exitCode}) before it was ready`); return ready; }, 'scratch T3 startup', 60000);
    const auth = JSON.parse(execFileSync(t3, ['auth', 'session', 'issue', '--json', '--ttl', '1h', '--label', 'probe', '--subject', 'probe', '--base-dir', t3Home], { env, encoding: 'utf8' }));
    const api = new T3Api({ origin: `http://127.0.0.1:${port}` }, auth.token);
    const config = await api.rpc('server.getConfig', {});
    const providers = Object.fromEntries(config.providers.map(p => [p.instanceId, { driver: p.driver, enabled: false }]));
    const wrapper = join(f.home, 'facade.mjs');
    await writeFile(wrapper, `Object.assign(process.env, ${JSON.stringify(f.env)});\nawait import(${JSON.stringify(new URL('../bin/dot-acp-agent.mjs', import.meta.url).href)});\n`);
    providers.probe = { driver: 'acpRegistry', enabled: true, displayName: 'Probe', config: { source: 'local', commandPath: process.execPath, commandArgs: [wrapper], customModels: ['dot'] } };
    await api.rpc('server.updateSettings', { patch: { providerInstances: providers, enableProviderUpdateChecks: false, enableAgentBrowserAccess: false, automaticGitFetchInterval: 0 } });
    const projectId = randomUUID(), threadId = randomUUID(), rid = 'probe_elicitation';
    await api.mutateProject({ type: 'project.create', commandId: randomUUID(), projectId, title: 'Probe', workspaceRoot: f.cwd, createWorkspaceRootIfMissing: false });
    let answer;
    f.hook(async ({ url, body, res, json }) => {
      if (url.pathname === '/questions') { json(res, { questions: answer ? [] : [{ question_id: 'format', text: 'Which format?', purpose: 'clarification' }] }); return true; }
      if (url.pathname === '/answer') { answer = body; json(res, { answered: true }); return true; }
      if (url.pathname === '/wait' && !answer) { f.rows.get(rid).status = 'claimed'; json(res, { status: 'question' }); return true; }
      return false;
    });
    await api.launchThread({ commandId: randomUUID(), threadId, projectId, title: 'Elicitation probe', generateTitle: false, modelSelection: { instanceId: 'probe', model: 'dot', options: [] }, runtimeMode: 'full-access', interactionMode: 'default', workspaceStrategy: { type: 'root' }, initialMessage: { messageId: randomUUID(), text: `[dot-decision:${rid}]\nAnswer the worker question`, attachments: [] } });
    let projection, request;
    await waitFor(async () => {
      projection = (await api.threadDetail(threadId)).projection;
      assert.ok(!projection.runs.some(r => r.status === 'failed'), 'scratch provider run failed');
      request = projection.runtimeRequests.find(r => r.kind === 'user_input' && r.status === 'pending');
      // The timeline item can be projected a moment after the pending request.
      return request && projection.turnItems.some(i => i.type === 'user_input_request' && i.requestId === request.id);
    }, 'pending user_input in the timeline', 30000);
    const run = projection.runs.find(r => r.id === request.runId) ?? projection.runs.at(-1);
    assert.ok(!['completed', 'failed', 'cancelled'].includes(run.status), 'question holds the run');
    const item = projection.turnItems.find(i => i.type === 'user_input_request' && i.requestId === request.id);
    assert.ok(item, 'question is visible in the T3 timeline');
    assert.equal(item.questions.length, 1);
    await api.dispatchCommand({ type: 'runtime-request.respond', commandId: randomUUID(), threadId, requestId: request.id, answers: { [item.questions[0].id]: 'JSON' } });
    await waitFor(() => answer, 'answer reaches fake worker');
    assert.equal(answer.text, 'JSON'); assert.equal(answer.question_id, 'format');
    projection = (await api.threadDetail(threadId)).projection;
    assert.ok(!['completed', 'failed', 'cancelled'].includes(projection.runs.find(r => r.id === run.id).status), 'same child turn held after answer');
    f.finish(rid, 'ELICITATION RESULT');
    await waitFor(async () => {
      projection = (await api.threadDetail(threadId)).projection;
      return projection.runs.find(r => r.id === run.id)?.status === 'completed';
    }, 'held turn completes after result');
    assert.equal(f.calls.filter(c => c.route === '/submit').length, 1);
    assert.equal(f.calls.filter(c => c.route === '/answer').length, 1);
    assert.equal(projection.messages.filter(m => m.role === 'assistant' && m.text.includes('ELICITATION RESULT')).length, 1, 'one final result in T3');
    assert.equal(projection.runs.length, 1, 'one child turn throughout question and answer');
    console.log(`PASS P5 T3 ${config.environment.serverVersion}: pending user_input; answer=JSON; same child held until result`);
  } finally {
    server.kill('SIGTERM');
    const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
    await exited; clearTimeout(timer);
  }
});
