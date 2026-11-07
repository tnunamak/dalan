// `dalan mcp`: a local MCP server on stdio. It lets an agent on the bridge computer submit jobs, wait for them and read
// their results as tool calls. It is not the worker-facing endpoint in server.mjs. Each tool runs the matching `dalan`
// CLI command with --json, so owner receipts, admin-socket access, assignment checks and verdicts stay in one place.
// Trust is the CLI's: whoever can run `dalan` here (the admin socket) can use these tools.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import { redactOutput, redactSinkText } from './redaction.mjs';
import { safeDiagnostic } from './diagnostic.mjs';

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const RESULT_CAP_BYTES = 32 * 1024;
const WAIT_DEFAULT = 120, WAIT_MAX = 300;
const CLI = path.join(import.meta.dirname, '../bin/dalan.mjs');
const requestId = { type: 'string', pattern: '^[-\\w]{8,128}$', description: 'The request_id of a submitted job.' };

export const TOOLS = [
  { name: 'dalan_submit', title: 'Submit a job',
    description: 'Queue a bounded job for a Dalan worker (same checks as `dalan submit`). Returns the request_id and the bridge verdict. A clarify or reject verdict comes back as an error result with the reasons; fix the assignment and submit again. Resubmitting the same assignment is safe.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['assignment'], properties: {
      assignment: { type: 'object', description: 'The assignment: request_id (8-128 letters, digits, _ or -), brief, inputs (array; [] for none), expected_output, and the other fields `dalan submit` accepts.',
        required: ['request_id'], properties: { request_id: requestId, brief: { type: 'string' }, inputs: { type: 'array' } } },
      worker: { type: 'string', description: 'Name of the worker to queue for. Optional with a one-worker profile.' },
      execution: { type: 'string', enum: ['none', 'worker', 'host'], description: 'Execution capability for the job.' },
      dry_run: { type: 'boolean', description: 'Check the assignment and store nothing.' },
      queue_anyway: { type: 'boolean', description: 'Queue even when the bridge would defer or warn.' },
      refuse_defer: { type: 'boolean', description: 'Fail instead of deferring.' } } },
    annotations: { title: 'Submit a job', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'dalan_wait', title: 'Wait for a job',
    description: `Wait for a job to reach a stop (finished, blocker, question, cancelled, worker_break). Returns after at most timeout_seconds (default ${WAIT_DEFAULT}, maximum ${WAIT_MAX}) with the current state; status "timeout" means it is still running, so call again.`,
    inputSchema: { type: 'object', additionalProperties: false, required: ['request_id'], properties: {
      request_id: requestId,
      timeout_seconds: { type: 'integer', minimum: 1, maximum: WAIT_MAX, default: WAIT_DEFAULT, description: `Seconds to wait; values above ${WAIT_MAX} are lowered to ${WAIT_MAX}.` } } },
    annotations: { title: 'Wait for a job', readOnlyHint: true, openWorldHint: false } },
  { name: 'dalan_result', title: 'Read a job result',
    description: `Read the current state of a job, with the worker's report once it has finished. Secrets are redacted and output is capped at ${RESULT_CAP_BYTES / 1024} KiB.`,
    inputSchema: { type: 'object', additionalProperties: false, required: ['request_id'], properties: { request_id: requestId } },
    annotations: { title: 'Read a job result', readOnlyHint: true, openWorldHint: false } },
  { name: 'dalan_status', title: 'Bridge status',
    description: 'Show the bridge status (`dalan status --json`): queue, workers and health.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { title: 'Bridge status', readOnlyHint: true, openWorldHint: false } }
];

// A SafeError carries a message written by Dalan; any other thrown value is a crash whose text never reaches the client.
class SafeError extends Error {}
const fail = (message, detail) => Object.assign(new SafeError(message), { detail });
// Untrusted names appear in a message only when they are plain identifiers.
const shown = name => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) ? `"${name}"` : '(name withheld)';

function validate(tool, args) {
  if (args === undefined) args = {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('arguments must be an object');
  const { properties = {}, required = [] } = tool.inputSchema;
  for (const key of Object.keys(args)) if (!(key in properties)) throw fail(`unknown argument ${shown(key)} for ${tool.name}`);
  for (const key of required) if (args[key] === undefined) throw fail(`missing required argument "${key}"`);
  for (const [key, value] of Object.entries(args)) {
    const spec = properties[key];
    if (spec.type === 'object' ? !value || typeof value !== 'object' || Array.isArray(value)
      : spec.type === 'integer' ? !Number.isInteger(value) : typeof value !== spec.type) throw fail(`argument "${key}" must be ${spec.type === 'object' ? 'an object' : `a ${spec.type}`}`);
    if (spec.enum && !spec.enum.includes(value)) throw fail(`argument "${key}" must be one of ${spec.enum.join(', ')}`);
    if (spec.pattern && !new RegExp(spec.pattern).test(value)) throw fail(`argument "${key}" is not a valid request id (8-128 letters, digits, _ or -)`);
    if (spec.type === 'string' && value.startsWith('--')) throw fail(`argument "${key}" must not start with --`);
  }
  return args;
}

// Run `dalan <args> --json`. stdout and stderr are collected, never forwarded: stdout of this process is the protocol.
function runCli(args, { input, timeoutMs = 60_000, env = process.env } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args, '--json'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', done = false;
    const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ code: null, stdout, stderr: `${stderr}dalan did not answer within ${Math.round(timeoutMs / 1000)}s` }); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => finish({ code: null, stdout, stderr: error.message }));
    child.on('close', code => finish({ code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}
const parseJson = text => { try { return JSON.parse(text); } catch { return undefined; } };
// stderr may hold warnings before the final error JSON line.
const lastJsonLine = text => text.trim().split('\n').reverse().map(parseJson).find(v => v && typeof v === 'object');

export function cliError(run, label) {
  const body = lastJsonLine(run.stderr) ?? lastJsonLine(run.stdout);
  if (body) return { isError: true, value: body };
  return { isError: true, message: `${label} failed${run.code === null ? '' : ` (exit ${run.code})`}: ${safeDiagnostic((run.stderr || run.stdout).trim(), 4000) || 'no output'}` };
}

function capped(value) {
  const text = JSON.stringify(redactOutput(value));
  if (Buffer.byteLength(text) <= RESULT_CAP_BYTES) return { text, structured: JSON.parse(text) };
  const cut = Buffer.from(text).subarray(0, RESULT_CAP_BYTES).toString('utf8').replace(/�$/, '');
  // The note is part of the frame the client sees, so it is redacted too.
  return { text: `${cut}\n${redactSinkText(`[truncated: output was ${Buffer.byteLength(text)} bytes, cap is ${RESULT_CAP_BYTES}. Read the rest with \`dalan get ${value.request_id ?? 'REQUEST_ID'} --json\` or fetch artifacts with \`dalan artifact\`.]`)}` };
}

// The one exit for tool results: every message and value is redacted, success or error.
const asResult = ({ isError, value, message }) => {
  if (message !== undefined) return { content: [{ type: 'text', text: redactSinkText(message) }], isError: true };
  const { text, structured } = capped(value);
  return { content: [{ type: 'text', text }], ...(structured && typeof structured === 'object' ? { structuredContent: structured } : {}), ...(isError ? { isError: true } : {}) };
};

const handlers = {
  async dalan_submit(args) {
    const flags = [];
    if (args.worker) flags.push('--worker', args.worker);
    if (args.execution) flags.push('--execution', args.execution);
    for (const [key, flag] of [['dry_run', '--dry-run'], ['queue_anyway', '--queue-anyway'], ['refuse_defer', '--refuse-defer']]) if (args[key]) flags.push(flag);
    const run = await runCli(['submit', '--stdin', ...flags], { input: JSON.stringify(args.assignment) });
    const value = parseJson(run.stdout);
    // A dry run exits non-zero for clarify, reject and defer but still prints the verdict on stdout.
    if (value !== undefined) return asResult({ value, isError: run.code !== 0 && (value.verdict ? value.verdict !== 'admissible' : true) });
    return asResult(cliError(run, 'submit'));
  },
  async dalan_wait(args) {
    const seconds = Math.min(args.timeout_seconds ?? WAIT_DEFAULT, WAIT_MAX);
    const run = await runCli(['wait', args.request_id, '--timeout', String(Math.max(1, seconds))], { timeoutMs: (seconds + 30) * 1000 });
    // wait exits 3, 4, 5 and 124 for non-finished states; the JSON on stdout is the state, not a failure.
    const value = parseJson(run.stdout);
    return value !== undefined ? asResult({ value }) : asResult(cliError(run, 'wait'));
  },
  async dalan_result(args) {
    const run = await runCli(['get', args.request_id]);
    const value = run.code === 0 ? parseJson(run.stdout) : undefined;
    return value !== undefined ? asResult({ value }) : asResult(cliError(run, 'get'));
  },
  async dalan_status() {
    const run = await runCli(['status']);
    const value = run.code === 0 ? parseJson(run.stdout) : undefined;
    return value !== undefined ? asResult({ value }) : asResult(cliError(run, 'status'));
  }
};

export async function callTool(name, rawArgs) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) return null;
  try { return await handlers[name](validate(tool, rawArgs)); }
  catch (error) {
    if (error instanceof SafeError) return asResult({ message: error.message });
    // Python MCP SDK pattern: the client gets the tool name and an error id; the redacted detail goes to the local log.
    const id = randomUUID().slice(0, 8);
    process.stderr.write(`dalan mcp: ${name}: error ${id}: ${safeDiagnostic(error.stack ?? error, 4000)}\n`);
    return asResult({ message: `Error executing tool ${name} (error id ${id}; details are in the dalan mcp log)` });
  }
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message: redactSinkText(message) } });

// One JSON-RPC message in, zero or one frame out. Never throws.
export async function handleFrame(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(message?.id ?? null, -32600, 'invalid request');
  const { id, method, params } = message;
  if (id === undefined) return null; // notification
  const ok = result => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize': return ok({ protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
      capabilities: { tools: {} }, serverInfo: { name: 'dalan-mcp', version: '1' },
      instructions: 'Local requester tools for a Dalan bridge: dalan_submit queues a job, dalan_wait waits for it, dalan_result reads the report, dalan_status shows the bridge.' });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      if (typeof params?.name !== 'string') return rpcError(id, -32602, 'tools/call requires a tool name');
      const result = await callTool(params.name, params.arguments);
      return result ? ok(result) : rpcError(id, -32602, `unknown tool "${params.name}"`);
    }
    default: return rpcError(id, -32601, `method not found: ${method}`);
  }
}

export async function main({ input = process.stdin, output = process.stdout } = {}) {
  const inflight = new Set();
  const write = frame => output.write(`${JSON.stringify(frame)}\n`);
  for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); }
    catch { write(rpcError(null, -32700, 'parse error')); continue; }
    // Requests run concurrently: a long dalan_wait must not block a ping or another tool.
    const work = handleFrame(message).then(frame => { if (frame) write(frame); }, error => {
      process.stderr.write(`dalan mcp: ${safeDiagnostic(error.stack ?? error, 4000)}\n`); write(rpcError(message?.id ?? null, -32603, 'internal error'));
    }).finally(() => inflight.delete(work));
    inflight.add(work);
  }
  await Promise.all(inflight);
}
