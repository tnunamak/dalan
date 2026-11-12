import { defaultPath } from './paths.mjs';
// Bridge-facing pieces of the ACP adapter (bin/dot-acp-agent.mjs): the admin-socket client, the owner token, brief and
// request-id rules, submit eligibility and the payload builder. Nothing here speaks ACP.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { packRepoDiff, stripPacked } from './acp-context.mjs';
import { hostCheckRefusal } from './host-execution-policy.mjs';
import { redactLogEntry } from './redaction.mjs';
import { submissionLimits } from './submission-policy.mjs';
import { readOrCreateSecret, ownerToken } from '../integrations/t3/acp-kit/src/capability.mjs';
import { CONTINUE_PROMPT, promptText, unwrapUserRequest, isT3RuntimeBlock, parseIdentity } from '../integrations/t3/acp-kit/src/t3-envelope.mjs';
import { adminSocketPathError } from './admin-socket.mjs';

// Shared with external ACP adapters: integrations/t3/acp-kit.
export { readOrCreateSecret, ownerToken, CONTINUE_PROMPT, promptText, unwrapUserRequest, isT3RuntimeBlock };

export const sha256 = text => createHash('sha256').update(text).digest('hex');
const idPattern = /^[-\w]{8,128}$/;

export function paths(env = process.env) {
  const home = os.homedir();
  return {
    socket: env.DOT_ACP_SOCKET || defaultPath(home,'.local/share/dot-bridge/admin.sock'),
    secretFile: env.DOT_ACP_SECRET_FILE || defaultPath(home,'.config/dot-bridge/acp-secret'),
    stateDir: env.DOT_ACP_STATE_DIR || defaultPath(home,'.local/state/dot-bridge/acp'),
  };
}

// ---------------------------------------------------------------- admin socket
export class BridgeError extends Error {
  constructor(message, kind, httpStatus) { super(message); this.kind = kind; this.http_status = httpStatus ?? null; }
}
export const transient = e => e.kind === 'transport' || e.http_status >= 500;

export function adminRequest(socket, route, { method = 'GET', payload, token, signal, timeoutMs } = {}) {
  const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
  const baseMs = positive(process.env.DOT_ACP_HTTP_TIMEOUT_MS, 5000);
  const graceMs = positive(process.env.DOT_ACP_HTTP_GRACE_MS, 1000);
  const url = new URL(route, 'http://localhost');
  const pollMs = url.pathname === '/wait' ? positive(url.searchParams.get('timeout'), 30) * 1000 : 0;
  const deadlineMs = timeoutMs ?? (pollMs ? pollMs + graceMs : baseMs);
  return new Promise((resolve, reject) => {
    const socketPathError = adminSocketPathError(socket);
    if (socketPathError) return reject(Object.assign(new BridgeError(socketPathError.message, 'local'), { code: socketPathError.code, fix: socketPathError.fix }));
    const bytes = payload ? JSON.stringify(payload) : '';
    let timer;
    const fail = error => { clearTimeout(timer); reject(error instanceof BridgeError ? error : Object.assign(new BridgeError(error.message, 'transport'), { name: error.name })); };
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bytes), ...(token ? { 'x-owner-capability': token } : {}) };
    const req = http.request({ socketPath: socket, path: route, method, headers, signal }, res => {
      let out = '';
      res.on('data', b => { out += b; });
      res.on('error', fail);
      res.on('aborted', () => fail(new Error('admin response aborted')));
      res.on('end', () => {
        clearTimeout(timer);
        let value;
        try { value = JSON.parse(out); } catch { return fail(new Error('invalid admin response')); }
        if (res.statusCode < 200 || res.statusCode >= 300) reject(Object.assign(new BridgeError(value?.error || `HTTP ${res.statusCode}`, 'http', res.statusCode), value?.verdict ? { verdict: value.verdict, reasons: value.reasons, bytes: value.bytes, retry_after_seconds: value.retry_after_seconds } : {}));
        else resolve(value);
      });
    });
    req.on('error', fail);
    timer = setTimeout(() => req.destroy(new BridgeError(`admin request deadline exceeded (${deadlineMs} ms)`, 'transport')), deadlineMs);
    req.end(bytes);
  });
}

// Raw artifact bytes (the admin route answers octet-stream, not JSON). Resolves null on any failure: evidence is best effort.
export function adminArtifact(socket, artifactId, token, timeoutMs = 5000) {
  return new Promise(resolve => {
    const req = http.request({ socketPath: socket, path: `/artifact?id=${encodeURIComponent(artifactId)}`, headers: { 'x-owner-capability': token } }, res => {
      const chunks = [];
      res.on('data', b => chunks.push(b));
      res.on('error', () => resolve(null));
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        resolve(res.statusCode === 200 && sha256(data) === res.headers['x-artifact-sha256'] ? data : null);
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => req.destroy());
    req.end();
  });
}

// ---------------------------------------------------------------- brief and ids
// The brief the worker sees is the prompt without the router's token line. The root decision id keys the bridge request.
// T3's delegate_task puts `Act as the <role> sub-agent for this task.\n\n` before the task for every role except general
// (and none); parseIdentity strips it, because otherwise the token line and a [dot-build] line are no longer first.
export function parsePrompt(prompt) {
  const { id: root, text, brief } = parseIdentity(prompt, { prefix: 'dot-decision', idPattern });
  // Without a token the identity is the text after the T3 preamble, so a resend with or without a role maps to one request.
  return { brief, root, requestRoot: root ?? `acp-${sha256(text).slice(0, 24)}` };
}
// Attempt 1 is the root itself. After a cancelled or expired row the next attempt is `<root>_r<n>` (the bridge accepts only
// [-\w] in a request id, so the doc's `#` separator cannot be used).
export const attemptId = (root, n) => {
  const id = n === 1 ? root : `${root}_r${n}`;
  return idPattern.test(id) ? id : `acp-${sha256(id).slice(0, 24)}`;
};

// ---------------------------------------------------------------- eligibility
// failure_type is the closed vocabulary of src/failure-type.mjs; verdict/reasons come from the bridge's work-order compiler.
export class Refusal extends Error {
  constructor(message, failure_type = 'admission_refused', extra = {}) { super(message); this.failure_type = failure_type; Object.assign(this, extra); }
}
// The words a requester reads for a typed refusal: each reason with its fix, plus the byte accounting when a limit is the cause.
export function verdictRefusal(order) {
  const lines = (order.reasons ?? []).map(r => `${r.message}${r.candidates?.length ? ` (did you mean ${r.candidates.join(' or ')}?)` : ''}. Fix: ${r.fix}`);
  const retry = order.verdict === 'defer' && order.retry_after_seconds ? ` Retry in about ${Math.round(order.retry_after_seconds / 60) || 1} min.` : '';
  const failure_type=order.verdict==='defer'?'deferred':order.verdict==='clarify'?'clarification_required':'admission_refused';
  return new Refusal(`${lines.join(' | ')}${retry}`, failure_type, { verdict: order.verdict, reasons: order.reasons, bytes: order.bytes, failure_type_source:'bridge_work_order_verdict' });
}

// The router's checks repeated as a backstop: the worker must be able to take work now.
export function bridgeRefusal(status, inFlightCap) {
  if (status.paused) return `worker paused${status.pause_reason ? `: ${status.pause_reason}` : ''}`;
  // Only evidence holds work: an owner-confirmed break. An inferred break is silence; estimated limits are metrics.
  if (status.worker_break?.active && status.worker_break.source === 'owner') return `worker_break active since ${status.worker_break.since}`;
  const queued = status.counts?.find(c => c.status === 'queued')?.count ?? 0;
  if (queued >= inFlightCap) return `worker queue is full (${queued} queued, in-flight cap ${inFlightCap})`;
  return null;
}

const execFileAsync = promisify(execFile);
// Async so a slow git never blocks the event loop (ACP notifications, the cancel window); each call is killed after the timeout.
async function git(cwd, args) {
  try {
    const r = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, out: r.stdout.trim(), err: r.stderr.trim() };
  } catch (e) { return { ok: false, out: (e.stdout || '').trim(), err: (e.stderr || e.message).trim() }; }
}
export function githubRepoOf(url) {
  const m = /^(?:https?:\/\/(?:[^/@]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url || '');
  return m ? `${m[1]}/${m[2]}` : null;
}
// A clean, pushed GitHub checkout gives the worker that commit. Local work can be packed against an origin branch's
// pushed ancestor; without one, the worker gets text only, so it never reviews a revision the requester has moved past.
// Refusing instead would cost the parent a wake and a re-route for work that may need no code at all.
// repoOf is injectable for local bare-repo tests; production accepts only GitHub origins.
export const NO_REPO_NOTE = "No repository access: the requester's checkout has unpushed or uncommitted work. Answer from this brief alone; if you need code that is not quoted here, finish with BLOCKED: and name what is missing.";
// Added when the checkout differs from its pushed HEAD only by untracked files: the worker reads HEAD, not those files.
export const UNTRACKED_NOTE = 'Untracked local files in the requester\'s checkout are not included: the repository is the pushed commit, without them. If you need one, finish with BLOCKED: and name it.';
const NOTES = [NO_REPO_NOTE, UNTRACKED_NOTE];
export const withoutNote = brief => {
  const note = NOTES.find(n => brief.startsWith(`${n}\n\n`));
  return stripPacked(note ? brief.slice(note.length + 2) : brief);
};
export async function repoInputs(cwd, { repoOf = githubRepoOf } = {}) {
  if (!cwd || !fs.existsSync(cwd)) return { inputs: [] };
  if (!(await git(cwd, ['rev-parse', '--is-inside-work-tree'])).ok) return { inputs: [] };
  // Untracked, non-ignored files do not change the pushed commit, so only tracked changes make the checkout dirty.
  // An unreadable or commit-less checkout never refuses the job: a text-only job needs no repository, and a build
  // is refused later for having no pinned input.
  const status = await git(cwd, ['status', '--porcelain']);
  if (!status.ok) return { inputs: [], note: NO_REPO_NOTE };
  const lines = status.out.split('\n').filter(Boolean);
  const dirty = { out: lines.filter(line => !line.startsWith('?? ')).join('\n') };
  const untracked = lines.some(line => line.startsWith('?? '));
  const head = await git(cwd, ['rev-parse', 'HEAD']);
  if (!head.ok) return { inputs: [], note: NO_REPO_NOTE };
  // Containment is checked on origin only: a commit that exists only under another remote must not be sent as origin evidence.
  const remote = await git(cwd, ['for-each-ref', '--contains', head.out, '--format=%(refname) %(symref)', 'refs/remotes/origin/']);
  const onOrigin = remote.ok && remote.out.split('\n').some(line => /^refs\/remotes\/origin\/(?!HEAD(?:\s|$))\S+\s*$/.test(line));
  const repo = repoOf((await git(cwd, ['remote', 'get-url', 'origin'])).out);
  if (!dirty.out && onOrigin) return { inputs: repo ? [{ github_repo: repo, base_sha: head.out, head_sha: head.out }] : [], ...(repo && untracked ? { untracked: true } : {}) };
  if (!repo) return { inputs: [], note: NO_REPO_NOTE };
  // Newest ancestors reachable from an origin branch (boundary commits). Only refs of the origin remote count.
  // No fetch and no change to the requester's index.
  const history = await git(cwd, ['rev-list', '--topo-order', '--boundary', 'HEAD', '--not', '--remotes=origin']);
  const base = onOrigin ? head.out : history.ok && history.out.split('\n').find(line => /^-[a-f0-9]{40}$/.test(line))?.slice(1);
  return base ? { inputs: [{ github_repo: repo, base_sha: base, head_sha: base }], packBase: base } : { inputs: [], note: NO_REPO_NOTE };
}

// Async end to end (git runs as child processes with timeouts), so packing never blocks ACP notifications or the cancel window.
// A text-only worker (DOT_ACP_TEXT_ONLY=1) never gets repository inputs; builds are then refused by the no-inputs rule below.
export const TEXT_ONLY_NOTE = 'Text-only job: there is no repository or file access. Answer from this brief alone.';
// A size error from the packer or the bridge (`brief: N UTF-8 bytes exceeds L`) rewritten to say which part is over and by how
// much. `requestBytes` is the requester's own text; the rest of the total is what the adapter and bridge added. Null when the
// message is not a size error.
const fmt = n => Number(n).toLocaleString('en-US');
export function sizeRefusal(message, requestBytes) {
  const m = /^(brief|task instructions): (\d+) UTF-8 bytes exceeds (\d+)/.exec(message ?? '');
  if (!m) return null;
  const what = m[1], total = Number(m[2]), limit = Number(m[3]), extra = total - requestBytes, cut = total - limit;
  const split = extra > 0 ? `your request ${fmt(requestBytes)} + context added by the adapter and bridge ${fmt(extra)}` : `your request alone`;
  const head = what === 'brief' ? `brief is ${fmt(total)} bytes` : `task instructions (brief, expected output and scope) are ${fmt(total)} bytes`;
  return `${head}: ${split}; the limit is ${fmt(limit)}; cut at least ${fmt(cut)} bytes from your request${extra > 0 ? ' (pushing your local work drops the added context)' : ''}`;
}
export async function prepareAssignment(request, options, env = process.env) {
  try {
    const assignment = await prepareUnexplained(request, options, env);
    // The bridge repeats this check; making it here too refuses before the round trip, with the same numbers.
    const total = Buffer.byteLength(assignment.brief);
    if (total > submissionLimits.brief) throw new Error(`brief: ${total} UTF-8 bytes exceeds ${submissionLimits.brief}`);
    return assignment;
  } catch (error) {
    const text = sizeRefusal(error.message, Buffer.byteLength(request.brief));
    if (text) throw new Refusal(text);
    throw error;
  }
}
async function prepareUnexplained({ cwd, ...request }, options, env) {
  // A text-only worker cannot open host files, so a brief that names one would end BLOCKED after a wake-up cycle. Refuse
  // at submit, while the sender can still paste the content. URLs and repository-relative names are allowed.
  if (env.DOT_ACP_TEXT_ONLY === '1') {
    const hostPath = request.brief.match(/(?<![\w:/.-])(?:~\/|\/(?:home|Users|tmp|root|var|etc|mnt|opt)\/)[^\s'"`)<>]+/);
    if (hostPath) throw new Refusal(`text-only worker: the brief names a local path (${hostPath[0].slice(0, 80)}) that the worker cannot read; paste the needed content into the brief instead`);
  }
  const context = env.DOT_ACP_TEXT_ONLY === '1' ? { inputs: [], note: TEXT_ONLY_NOTE } : await repoInputs(cwd, options);
  const build = isBuild(request.brief);
  // A build patch must apply to the requester's own commit: no packed local diff and no text-only fallback.
  if (build && !buildScope(request.brief).length) throw new Refusal(BUILD_NEEDS_SCOPE);
  if (build && (!context.inputs.length || context.packBase || context.note)) throw new Refusal(BUILD_NEEDS_PUSHED);
  if (build) {
    const why = buildIneligible(context.inputs[0].github_repo, buildScope(request.brief));
    if (why) throw new Refusal(why);
    // Each listed path is a file at HEAD or a new file; a directory would widen the scope past the file bound and path terms.
    for (const p of buildScope(request.brief)) if ((await git(cwd, ['cat-file', '-t', `HEAD:${p}`])).out === 'tree') throw new Refusal(`[dot-build] lists a directory (${p}); list files`);
  }
  // Identity is the requester's brief only; packed context and notes are presentation and never enter this hash.
  const assignment = { ...buildAssignment({ ...request, inputs: context.inputs, build }), acp_brief_hash: sha256(request.brief) };
  if (context.packBase) return packRepoDiff(cwd, assignment, context.packBase, NO_REPO_NOTE);
  if (context.untracked && !build) return { ...assignment, brief: `${UNTRACKED_NOTE}\n\n${assignment.brief}` };
  return context.note ? { ...assignment, brief: `${context.note}\n\n${assignment.brief}` } : assignment;
}

// ---------------------------------------------------------------- build tasks
// A brief whose first line is exactly BUILD_MARKER asks the worker for a patch: implementation scope (apply_patch, run_check)
// on the requester's pushed HEAD, task_kind "build" (the delegation gate measures acceptance of these), and a result that
// carries the patch evidence and the verdict commands. Any other brief keeps read-only scope.
// The marker line names the repository paths the worker may read and change: `[dot-build] src/a.py tests/test_a.py`. Implementation
// scope admits no sensitive file in scope (--exclude-sensitive is for read-only work), so a whole-repo scope fails on any
// repository with a .env.example; an explicit list also keeps the worker's reads, and so its usage, small.
export const BUILD_MARKER = '[dot-build]';
const buildLine = /^\[dot-build\]((?:[ \t]+\S+)*)[ \t]*$/;
export const isBuild = brief => typeof brief === 'string' && buildLine.test(brief.split('\n', 1)[0].trim());
export const buildScope = brief => (buildLine.exec(brief.split('\n', 1)[0].trim())?.[1] ?? '').trim().split(/[ \t]+/).filter(Boolean);
export const BUILD_NEEDS_PUSHED = 'a [dot-build] task needs a clean checkout whose HEAD is pushed to a GitHub origin; push first, or use dalan submit with an explicit base_sha';
export const BUILD_NEEDS_SCOPE = 'a [dot-build] line must name the files the worker may read and change, e.g. "[dot-build] src/a.py tests/test_a.py"';
// Who may receive a build comes from the operator's owner allowlist because a parent can send a [dot-build] task without
// the delegation gate's offer. The repo exclusion config and credential path terms add further restrictions.
// The current and legacy environment variable names are supported; a missing owner list refuses every build.
export const BUILD_MAX_FILES = 5;
const glob = pattern => new RegExp(`^${pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
function configuredOwners(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const owners = value.split(',').map(owner => owner.trim().toLowerCase());
  if (owners.some(owner => !/^[a-z0-9_.-]+$/.test(owner))) return null;
  return owners;
}
export function buildIneligible(repo, files, env = process.env) {
  const owners = configuredOwners(env.DALAN_ACP_BUILD_OWNERS || env.DOT_ACP_BUILD_OWNERS);
  if (!owners) return '[dot-build] refused: DALAN_ACP_BUILD_OWNERS or DOT_ACP_BUILD_OWNERS must list authorized repository owners';
  const name = String(repo || '').toLowerCase();
  if (!owners.includes(name.split('/')[0])) return `[dot-build] refused: ${repo} is outside the configured owner allowlist`;
  if (files.length > BUILD_MAX_FILES) return `[dot-build] names ${files.length} paths; at most ${BUILD_MAX_FILES}`;
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(env.DALAN_ACP_REPO_CONFIG || env.DOT_ACP_REPO_CONFIG || defaultPath(os.homedir(),'.config/dot-bridge/producer.json'), 'utf8')); }
  catch { return '[dot-build] refused: the repo exclusion config is unreadable'; }
  const exclude = cfg?.repo_selection?.exclude, terms = cfg?.deny_path_terms;
  if (!Array.isArray(exclude) || !Array.isArray(terms) || ![...exclude, ...terms].every(x => typeof x === 'string' && x)) return '[dot-build] refused: the repo exclusion config is malformed';
  if (exclude.some(g => glob(g).test(name))) return `[dot-build] refused: ${repo} is excluded by the repo exclusion config`;
  const hit = files.find(f => terms.some(t => f.toLowerCase().includes(t.toLowerCase())));
  if (hit) return `[dot-build] refused: ${hit} matches a credential path term`;
  return null;
}
const BUILD_OUTPUT = 'A patch: make the change with apply_patch, run the named check with run_check, then finish with a short summary, the check result and anything you could not do.';

export function buildAssignment({ requestId, brief, inputs, validUntil, build = false }) {
  return {
    schema_version: 1, request_id: requestId, brief, inputs,
    ...(inputs.length ? { scope_paths: build ? buildScope(brief) : ['.'] } : {}),
    expected_output: build ? BUILD_OUTPUT : 'A complete answer as plain text. Put the result in the finish call.',
    execution_scope: build ? 'implementation' : 'read-only', valid_until: validUntil,
  };
}

const PREVIEW_BYTES = 3072;
const CODE_COMMENT = /^(?:\/\/|\/\*|\*|#(?!\s*(?:include\b|!\/))|--|<!--)/;
function addedProse(patch) {
  const prose = [];
  let file = null;
  for (const line of patch.split('\n')) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) { file = header[1]; continue; }
    if (!line.startsWith('+') || line.startsWith('+++') || !file) continue;
    const content = line.slice(1);
    if (/\.md$/i.test(file) || CODE_COMMENT.test(content.trim())) prose.push(`${file}: ${content}`);
  }
  return prose.join('\n');
}
// Redact first, then clip, so a token cut by the clip cannot leave a prefix behind.
const clip = (value, max) => redactLogEntry(String(value)).slice(0, max);
const SEVERITIES = new Set(['info', 'low', 'minor', 'medium', 'warning', 'high', 'major', 'error', 'critical']);
const FINDING_TEXT_KEYS = ['text', 'message', 'description', 'suggestion'];
const FINDING_LABEL_KEYS = ['rule', 'type'];
// Keep only known string fields of a finding. Arrays, objects and unknown severities are dropped, so nothing reaches
// the result text without passing through the redactor as one string.
function sanitizeFinding(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return {};
  const out = {};
  if (typeof f.severity === 'string' && SEVERITIES.has(f.severity.toLowerCase())) out.severity = f.severity.toLowerCase();
  for (const k of FINDING_LABEL_KEYS) if (typeof f[k] === 'string') out[k] = clip(f[k], 80);
  for (const k of FINDING_TEXT_KEYS) if (typeof f[k] === 'string') out[k] = clip(f[k], 4000);
  return out;
}
// The checker gets only what it needs to start: no inherited credentials, a throwaway HOME, and a fixed PATH
// (the running node's directory plus the system directories) so the host PATH text and entries are not inherited.
const checkerPath = () => [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);
const checkerEnv = home => ({ PATH: checkerPath(), HOME: home, TMPDIR: home, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' });
// Containment guarantee (not a sandbox): on timeout or completion the checker's process group is killed, and so is
// every descendant still linked to it by parent pid at that moment, even one that started its own session. A
// descendant that was already orphaned (its parent exited first), or that forks during the kill, can escape. There is
// no sound containment without a sandbox or cgroup, so the checker also runs only when the host-check policy allows
// unsandboxed host execution, and it must be a trusted local data-only command, not a security boundary.
function descendantPids(rootPid) {
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 }).trim().split('\n').map(l => l.trim().split(/\s+/).map(Number));
  const kids = new Map();
  for (const [pid, ppid] of rows) { if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(pid); }
  const found = [], queue = [rootPid];
  while (queue.length) for (const pid of kids.get(queue.pop()) ?? []) { found.push(pid); queue.push(pid); }
  return found;
}
// Optional prose check of a build patch: pipes the added prose lines to an owner-configured linter command.
export function runBuildProseCheck(repo, patch, env = process.env, { refusal = hostCheckRefusal, timeoutMs = 30000, descendants = descendantPids } = {}) {
  const ownersName = 'DALAN_ACP_PROSE_CHECK_OWNERS';
  const command = env.DALAN_ACP_PROSE_CHECK;
  const owners = configuredOwners(env[ownersName]);
  if (env[ownersName] && !owners) return Promise.resolve({ status: 'ERROR', detail: `invalid ${ownersName}` });
  if (!owners || !owners.includes(String(repo || '').toLowerCase().split('/')[0])) return Promise.resolve(null);
  if (patch === null || patch === undefined) return Promise.resolve({ status: 'ERROR', detail: 'patch unavailable' });
  if (!command) return Promise.resolve({ status: 'ERROR', detail: 'prose check command not configured' });
  const refused = refusal();
  if (refused) return Promise.resolve({ status: 'ERROR', detail: `skipped: host checks refused (${clip(refused, 160)})` });
  const prose = addedProse(Buffer.from(patch).toString('utf8'));
  return new Promise(resolve => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prose-check-'));
    const child = spawn(command, ['check', '--stdin', '--kind', 'doc', '--json'], { env: checkerEnv(home), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const killTree = () => {
      let tracked;
      try { tracked = descendants(child.pid); } catch { tracked = null; }
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      for (const pid of tracked ?? []) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      return tracked !== null;
    };
    let stdout = '', stderr = '', settled = false;
    const finish = result => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (killTree()) fs.rmSync(home, { recursive: true, force: true });
      else result = { ...result, status: 'ERROR', detail: `process inspection failed; temporary files retained at ${home}`, cleanupHome: home };
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: 'ERROR', detail: 'timed out' }), timeoutMs);
    child.stdout.setEncoding('utf8').on('data', chunk => { if (stdout.length < 256000) stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { if (stderr.length < 4000) stderr += chunk; });
    child.on('error', error => finish({ status: 'ERROR', detail: error.code === 'ENOENT' ? 'command not found' : clip(error.message, 300) }));
    child.on('close', code => {
      let result;
      try { result = JSON.parse(stdout); }
      catch { finish({ status: 'ERROR', detail: `invalid JSON output${stderr.trim() ? ' (checker stderr withheld: the shared redactor does not recognize every opaque credential shape)' : ''}` }); return; }
      const findings = Array.isArray(result.findings) ? result.findings : [];
      finish({ status: code === 0 ? 'PASS' : 'FAIL', findings: findings.slice(0, 3).map(sanitizeFinding), detail: code === 0 ? null : `exit ${code}` });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prose);
  });
}
function proseCheckText(verdict) {
  if (!verdict) return null;
  if (verdict.status === 'ERROR') return `prose check: ERROR (${verdict.detail})`;
  const findings = verdict.findings?.length
    ? `; top findings: ${verdict.findings.map(sanitizeFinding).map(f => {
      const detail = f.text ?? f.message ?? f.description ?? f.suggestion;
      return `${f.severity ?? 'medium'} ${f.rule ?? f.type ?? 'finding'}${detail ? `: ${clip(detail, 240)}` : ''}`;
    }).join(' | ')}`
    : '; no findings';
  return `prose check: ${verdict.status}${verdict.detail ? ` (${verdict.detail})` : ''}${findings}`;
}
function diffstat(patch) {
  const files = new Map();
  let file = null;
  for (const line of patch.split('\n')) {
    const head = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
    if (head) { file = head[2]; files.set(file, { add: 0, del: 0 }); continue; }
    if (!file || line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) files.get(file).add++;
    else if (line.startsWith('-')) files.get(file).del++;
  }
  return [...files].map(([f, n]) => `  ${f} +${n.add} -${n.del}`);
}
// One line that asks the requester for the one word that records what the result was worth.
export const decideHint = rid => `decide: dalan decide ${rid} accepted|applied|useful_no_change|useful_negative|not_useful`;
// The text a build task returns to its T3 parent: the worker's own result, then what to apply and how to record the verdict.
// patch is the artifact's bytes (Buffer or string) or null when it could not be read.
export function buildResultText(row, text, patch, proseCheck = null) {
  const rid = row.request_id, ev = row.report?.workspace_evidence ?? {}, input = row.assignment?.inputs?.[0] ?? {};
  const art = ev.patch_artifact, lines = [text, '', `--- worker build evidence (request ${rid}) ---`, `base: ${input.github_repo ?? '?'}@${ev.base_sha ?? input.base_sha ?? '?'}`];
  const checks = (ev.checks ?? []).map(c => `${c.check_id} ${c.status}${c.exit_code === null || c.exit_code === undefined ? '' : ` exit ${c.exit_code}`} on diff ${String(c.diff_sha256 ?? '').slice(0, 12)}${c.check_summary?`; ${c.check_summary}`:''}`);
  lines.push(`worker checks: ${checks.length ? checks.join('; ') : 'none run'}`);
  if (proseCheck) lines.push(proseCheckText(proseCheck));
  if (!art?.artifact_id || !art.size) lines.push('patch: none (empty diff). Nothing to apply.');
  else {
    const body = patch === null || patch === undefined ? null : Buffer.from(patch).toString('utf8');
    lines.push(`patch: ${art.size} bytes, sha256 ${art.sha256}, artifact ${art.artifact_id}`);
    if (body !== null) lines.push(...diffstat(body), body.length <= PREVIEW_BYTES ? `\`\`\`diff\n${body}\`\`\`` : `(preview omitted: over ${PREVIEW_BYTES} bytes)`);
    lines.push(`Fetch: dalan get ${rid} --json >/dev/null && dalan artifact ${art.artifact_id} --output <file>`);
  }
  lines.push(`Next: on a clean checkout of that base, git apply the patch, re-run the tests yourself, push only if they pass. Then record the verdict: dalan accept ${rid}, or dalan reject ${rid} --note '<why>'. The delegation gate offers the worker builds only while these verdicts stay good.`);
  lines.push(`Or apply it for you: dalan apply ${rid} [--dir <checkout>] (checks the digest and base, then records applied). ${decideHint(rid)}`);
  return lines.join('\n');
}
