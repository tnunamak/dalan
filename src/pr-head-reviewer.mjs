import { defaultPath } from './paths.mjs';
import { parseJsonBody, safeDiagnostic } from './diagnostic.mjs';
import { redactLogEntry } from './redaction.mjs';
// PR-head reviewer: one scoped, read-only review assignment per open PR head that has no worker review yet.
// Deterministic (no model calls). Pure helpers first, then `run`, which takes its I/O (gh, dalan, databases, clock) as
// dependencies so the whole flow is testable. See docs/pr-head-reviewer.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { validateSubmission } from './submission-policy.mjs';
import { legacyReportThreadKey } from './legacy-names.mjs';

const home = os.homedir();
export const paths = {
  config: path.join(home, '.config/dot-pr-reviewer/config.json'),
  stateDir: path.join(home, '.local/state/dot-pr-reviewer'),
  bridgeDb: defaultPath(home,'.local/share/dot-bridge/bridge.db'),
  t3Db: path.join(home, '.t3/userdata/statev2.sqlite'),
};

export const DEFAULTS = Object.freeze({
  owners: [],
  repos: [],
  exclude_owners: [],
  exclude_repos: [],
  include_forks: false,
  skip_bots: true,
  max_submits_per_run: 10,
  headroom: 6,
  draft_days: 7,
  max_age_days: 30,
  max_changed_files: 200,
  max_scope_paths: 150,
  max_scope_bytes: 8000,
  ttl_hours: 4,
  refusal_cooldown_hours: 6,
  report_thread_id: null,
  dot_worker: 'dalan',
  gh_concurrency: 6,
  max_closed_checks: 40,
});

export function loadConfig(file = paths.config) {
  let user = {};
  if (fs.existsSync(file)) {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!user || typeof user !== 'object' || Array.isArray(user)) throw new Error(`invalid config ${file}`);
    // The report thread key had another name in earlier releases; it is still read, and the new key wins when both are set.
    if (legacyReportThreadKey in user) {
      if (user.report_thread_id == null) user.report_thread_id = user[legacyReportThreadKey];
      delete user[legacyReportThreadKey];
    }
    for (const k of Object.keys(user)) if (!(k in DEFAULTS) && !['bridge_db', 't3_db'].includes(k)) throw new Error(`unknown config key ${k}`);
  }
  return { ...DEFAULTS, bridge_db: paths.bridgeDb, t3_db: paths.t3Db, ...user };
}

const threadId = /^[A-Za-z0-9._:%-]{8,1024}$/;
const lower = s => String(s).toLowerCase();
export const prKey = (repo, number) => `${lower(repo)}#${number}`;

export function parseOnly(value) {
  const match = typeof value === 'string' && !value.startsWith('-') && /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(value);
  if (!match || match[0] !== value || !Number.isSafeInteger(Number(match[2]))) throw new Error('invalid --only: expected owner/repo#number');
  return { repo: match[1], number: Number(match[2]) };
}

// ---- repository selection --------------------------------------------------------------------------------------------

export function reviewRepos(listed, cfg) {
  const owners = new Set(cfg.exclude_owners.map(lower)), repos = new Set(cfg.exclude_repos.map(lower));
  const all = [...listed, ...cfg.repos];
  return [...new Map(all.map(r => [lower(r), r])).values()]
    .filter(r => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r) && !owners.has(lower(r.split('/')[0])) && !repos.has(lower(r)));
}

// Open PRs worth a review now: bots skipped, a draft only when recently updated, anything else only when not stale.
// Ready PRs first, then newest.
export function selectPrs(prs, cfg, now) {
  const day = 86400000;
  return prs.filter(pr => {
    const age = now - Date.parse(pr.updatedAt);
    if (cfg.skip_bots && (pr.author?.is_bot || pr.author?.type === 'Bot' || /\[bot\]$/i.test(pr.author?.login ?? ''))) return false;
    if (pr.isDraft) return age <= cfg.draft_days * day;
    return cfg.max_age_days == null || age <= cfg.max_age_days * day;
  }).sort((a, b) => (a.isDraft - b.isDraft) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

// ---- identity --------------------------------------------------------------------------------------------------------

export function requestId(repo, number, head) {
  const [owner, name] = repo.split('/'), suffix = `-${number}-${head.slice(0, 12)}`;
  const id = `${`prh-${owner}-${name}`.slice(0, 128 - suffix.length)}${suffix}`.replace(/[^-\w]/g, '_');
  if (!/^[-\w]{8,128}$/.test(id)) throw new Error(`request id out of bounds: ${id}`);
  return id;
}
export const objectiveKey = (repo, number) => `pr:${repo}#${number}`;

// ---- scope and brief -------------------------------------------------------------------------------------------------

const byteLength = list => Buffer.byteLength(list.join('\n'));
// The PR's files as they are, or, past the limits, the deepest directory level at which they fit.
export function collapseScope(files, { maxPaths, maxBytes }) {
  const unique = [...new Set(files)];
  const fits = list => list.length <= maxPaths && byteLength(list) <= maxBytes;
  if (fits(unique)) return unique;
  const deepest = Math.max(...unique.map(f => f.split('/').length));
  let level = [];
  for (let depth = deepest - 1; depth >= 1; depth--) {
    level = [...new Set(unique.map(f => { const parts = f.split('/'); return parts.length <= depth ? f : parts.slice(0, depth).join('/'); }))];
    if (fits(level)) return level;
  }
  return level;
}

export function buildBrief({ repo, number, head, base, diff }) {
  const where = diff
    ? `The workspace is pinned at that head; workspace_result shows the PR diff against its merge base ${base.slice(0, 12)}. The allow-list is exactly the files the PR changes.`
    : 'The workspace is pinned at that head. The PR diff is not available here; the allow-list holds the files the PR changes (files that look sensitive are withheld), so read them as they stand at the head.';
  return `Review only; make no changes. Review ${repo} pull request #${number} at head ${head}. ${where} `
    + 'Review design and architecture before lines. '
    + '(1) goal: does the design serve the real goal, or a proxy such as passing tests? '
    + '(2) simplicity as separation of independent concerns: what is braided that should be independent (state and value, time and identity, policy and mechanism, domain logic and input-output, waiting and error, unrelated reasons for change)? Moving code into more files is not decomplecting. '
    + '(3) invariant owners: which single component owns each invariant (completeness, ordering, identity, authorization, durability), do two places decide the same thing, and are modules deep rather than shallow wrappers? '
    + '(4) explicit state and information flow: are effects, retries and caching visible, and does each decision see the state it needs, or is state hidden, dropped or reported as success when partial? '
    + '(5) feedback loops and real data: can retries, polling or cursors stall or run away, and does the code fit real data sizes and shapes? '
    + 'Report a finding or an explicit no-issue for each of (1) to (4), and say whether a simpler design would remove several findings at once. '
    + 'Then find correctness, data-loss, security and regression defects in the changed behavior, and missing or vacuous tests for it. '
    + 'For each finding give severity (P1 = wrong results, data loss or security; P2 = real bug or missing test for a risky path; P3 = minor), the file and line, the concrete failing scenario, and the fix. '
    + 'Return NONE if you find nothing real. Do not report style.';
}

// A bridge or transport failure, not a verdict on the assignment.
const transient = /"http_status":5\d\d|unavailable|timeout|ECONN|ENOTFOUND|exit 127|\bdeferred:/i;
const deferredSubmit = error => {
  if (/^deferred:/i.test(error ?? '')) return true;
  try { const value=JSON.parse(error); return value?.verdict==='defer'||/^deferred:/i.test(value?.error ?? ''); }
  catch { return false; }
};
const sensitiveRefusal = /^(?:sensitive scope path|hard sensitive path exclusion): (.+?)(?: \(.*)?$/;

// The assignment, built to pass the bridge's submit lint. The same `validateSubmission` the bridge runs checks it here,
// against the PR's own file list instead of a clone. A changed file the lint calls sensitive leaves the scope, and the PR is
// then reviewed at its head without the diff (the bridge refuses any diff that touches a sensitive name).
// Returns {assignment, scope, excluded, diff, warnings} or {skip: reason}.
export function planReview(pr, { files, mergeBase }, cfg, now, validate = validateSubmission) {
  let live = [...new Set(files)], diff = Boolean(mergeBase);
  const excluded = [];
  for (let attempt = 0; attempt <= files.length + 1; attempt++) {
    if (!live.length) return { skip: files.length ? 'every changed file is excluded as sensitive' : 'the PR changes no files' };
    const scope = collapseScope(live, { maxPaths: cfg.max_scope_paths, maxBytes: cfg.max_scope_bytes });
    const input = diff ? { github_repo: pr.repo, base_sha: mergeBase, head_sha: pr.head } : { github_repo: pr.repo, base_sha: pr.head };
    const assignment = {
      schema_version: 1,
      request_id: requestId(pr.repo, pr.number, pr.head),
      inputs: [input],
      scope_paths: scope,
      brief: buildBrief({ repo: pr.repo, number: pr.number, head: pr.head, base: mergeBase, diff }),
      expected_output: 'Ranked findings with severity, file and line, and the failing scenario, or NONE.',
      execution_scope: 'read-only',
      prepared_at: new Date(now).toISOString().replace(/\.\d+Z$/, 'Z'),
      valid_until: new Date(now + cfg.ttl_hours * 3600000).toISOString().replace(/\.\d+Z$/, 'Z'),
    };
    const warnings = [];
    try {
      validate(assignment, { scanInput: () => ({ files: live, diffFiles: diff ? live : [], diff: '', symlinks: [] }), warnings, excludeSensitive: true });
      return { assignment, scope, excluded, diff, warnings };
    } catch (error) {
      const m = sensitiveRefusal.exec(error.message);
      if (!m || !live.includes(m[1])) return { skip: `lint: ${error.message}` };
      excluded.push(m[1]);
      live = live.filter(f => f !== m[1]);
      diff = false;
    }
  }
  return { skip: 'lint: sensitive-file exclusion did not converge' };
}

// ---- gating ----------------------------------------------------------------------------------------------------------

// {hold: reason} while the worker must not be fed, else {slots}: lanes plus headroom, minus what is claimed or live-queued.
export function gate(status, cfg, now) {
  if (status.paused) return { hold: `paused (${status.pause_reason ?? 'no reason'})` };
  if (status.worker_break?.active && status.worker_break.source === 'owner') return { hold: 'owner-confirmed worker_break active' };
  const until = status.claim_denied?.capacity_hold_until;
  if (until) { const t = Date.parse(until); if (Number.isNaN(t) || t > now) return { hold: `capacity hold until ${until}` }; }
  const count = s => status.counts?.find(c => c.status === s)?.count ?? 0;
  const claimed = count('claimed'), queued = Math.max(0, count('queued') - (status.queued_expired?.count ?? 0));
  const lanes = status.max_claimed_outer_assignments ?? 6;
  return { slots: Math.max(0, lanes + cfg.headroom - (claimed + queued)), claimed, queued, lanes };
}

// ---- dedupe ----------------------------------------------------------------------------------------------------------

// request_id of an assignment that already covers this PR head: same repository, head pinned as head_sha (or as the lone
// base_sha), or the same objective at this revision. Queued, claimed and finished cover it; a cancelled one does not.
export function findCovered(db, repo, number, head) {
  const rows = db.prepare(`select request_id, status from assignments
    where status != 'cancelled' and (
      (objective_key = ? and revision = ?)
      or (lower(json_extract(payload,'$.inputs[0].github_repo')) = ? and coalesce(json_extract(payload,'$.inputs[0].head_sha'), json_extract(payload,'$.inputs[0].base_sha')) = ?))
    order by created_at desc limit 1`).all(objectiveKey(repo, number), head, lower(repo), head);
  return rows[0] ?? null;
}

// ---- closed PRs ------------------------------------------------------------------------------------------------------

// Queued and claimed assignments that target a PR, grouped by PR: {repo, number, ids}. The PR comes from the objective key
// pr:<owner>/<repo>#<n> (this producer, and any submitter that sets it) or from inputs[0] github_repo plus pr_number.
export function trackedPrs(db) {
  const prs = new Map();
  for (const r of db.prepare(`select request_id, objective_key, json_extract(payload,'$.inputs[0].github_repo') as repo,
      json_extract(payload,'$.inputs[0].pr_number') as number from assignments where status in ('queued','claimed') order by created_at`).all()) {
    const key = /^pr:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(r.objective_key ?? '');
    const repo = key?.[1] ?? r.repo, number = key ? Number(key[2]) : r.number;
    if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !Number.isSafeInteger(number) || number <= 0) continue;
    const k = prKey(repo, number);
    (prs.get(k) ?? prs.set(k, { repo, number, ids: [] }).get(k)).ids.push(r.request_id);
  }
  return [...prs.values()];
}

// ---- T3 thread links -------------------------------------------------------------------------------------------------

// "repo#number" -> thread id. A live thread beats an archived one; then the most recent link wins.
export function threadIndex(db) {
  const rows = db.prepare(`select t.thread_id as id, t.archived_at as archived, json_extract(j.value,'$.repository') as repo,
      json_extract(j.value,'$.number') as number, json_extract(j.value,'$.linkedAt') as linked
    from orchestration_v2_projection_threads t, json_each(t.payload_json, '$.pullRequests') j where t.deleted_at is null`).all();
  const best = new Map();
  for (const r of rows) {
    if (!r.repo || !Number.isInteger(r.number) || !threadId.test(r.id)) continue;
    const key = prKey(r.repo, r.number), rank = [r.archived ? 0 : 1, r.linked ?? ''];
    const cur = best.get(key);
    if (!cur || rank[0] > cur.rank[0] || (rank[0] === cur.rank[0] && rank[1] > cur.rank[1])) best.set(key, { id: r.id, rank });
  }
  return new Map([...best].map(([k, v]) => [k, v.id]));
}

export function deliveryFor(index, repo, number, cfg) {
  const linked = index.get(prKey(repo, number));
  if (linked) return { delivery: `t3:${linked}`, via: 'pr-link' };
  if (cfg.report_thread_id && threadId.test(cfg.report_thread_id)) return { delivery: `t3:${cfg.report_thread_id}`, via: 'report-thread' };
  return { delivery: 'none', via: 'none' };
}

// Follow the delegated child's lineage, choosing the nearest owner that can receive a result.
export function delegateOwner(db, id) {
  const get = db.prepare(`select thread_id as id, archived_at as archived, deleted_at as deleted,
      json_extract(payload_json,'$.settledAt') as settled,
      json_extract(payload_json,'$.settledOverride') as settled_override,
      json_extract(payload_json,'$.lineage.parentThreadId') as parent,
      json_extract(payload_json,'$.lineage.rootThreadId') as root
    from orchestration_v2_projection_threads where thread_id = ?`);
  const seen = new Set(), first = get.get(id);
  let next = first?.parent;
  while (next && !seen.has(next)) {
    seen.add(next);
    const row = get.get(next);
    if (!row) break;
    if (!next.startsWith('thread:delegated-task:') && threadId.test(next)
      && !row.archived && !row.deleted && !row.settled && row.settled_override !== 'settled') return next;
    next = row.parent;
  }
  const root = first?.root;
  if (root && !seen.has(root)) {
    const row = get.get(root);
    if (row && !root.startsWith('thread:delegated-task:') && threadId.test(root)
      && !row.archived && !row.deleted && !row.settled && row.settled_override !== 'settled') return root;
  }
  return null;
}

function fallbackDelivery(cfg, current) {
  const report = cfg.report_thread_id;
  return report && threadId.test(report) && current !== `t3:${report}`
    ? { delivery: `t3:${report}`, via: 'report-thread' } : { delivery: 'none', via: 'none' };
}

// ---- state and log ---------------------------------------------------------------------------------------------------

export class State {
  constructor(dir) {
    this.dir = dir; this.file = path.join(dir, 'state.json');
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
    this.data.refused ??= {};
    this.data.covered ??= [];
  }
  // A covered head is logged once, not on every run for as long as the PR stays open.
  firstCovered(id) { if (this.data.covered.includes(id)) return false; this.data.covered.push(id); return true; }
  recentlyRefused(id, now, hours) { const at = this.data.refused[id]; return at !== undefined && now - Date.parse(at) < hours * 3600000; }
  refuse(id, now, reason) { this.data.refused[id] = new Date(now).toISOString(); this.data.reasons = { ...this.data.reasons, [id]: reason }; }
  save(now, hours) {
    for (const [id, at] of Object.entries(this.data.refused)) if (now - Date.parse(at) >= hours * 3600000) { delete this.data.refused[id]; delete this.data.reasons?.[id]; }
    this.data.covered = this.data.covered.slice(-2000);
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1) + '\n'); fs.renameSync(tmp, this.file);
  }
}

// ---- real I/O --------------------------------------------------------------------------------------------------------

const exec = (cmd, args, { input, timeout = 120000 } = {}) => new Promise(resolve => {
  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', done = false;
  const finish = code => { if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout, stderr }); } };
  const timer = setTimeout(() => { child.kill('SIGKILL'); stderr += 'timeout'; finish(124); }, timeout);
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  child.on('error', e => { stderr += e.message; finish(127); });
  child.on('close', finish);
  child.stdin.on('error', () => {});
  child.stdin.end(input ?? '');
});

// gh -i may emit one response per page. Never attach a collection's first-page ETag
// to every page: cache validators only for single-response resources.
function apiResponses(text) {
  const starts = [...text.matchAll(/^HTTP\/[\d.]+\s+(\d{3})[^\r\n]*\r?$/gm)];
  if (!starts.length) throw new Error('gh api: missing HTTP response headers');
  return starts.map((m, i) => {
    const chunk = text.slice(m.index, starts[i + 1]?.index ?? text.length);
    const split = /\r?\n\r?\n/.exec(chunk);
    if (!split) throw new Error('gh api: incomplete response headers');
    const headers = Object.fromEntries(chunk.slice(0, split.index).split(/\r?\n/).slice(1).map(line => {
      const colon = line.indexOf(':'); return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
    }));
    const body = chunk.slice(split.index + split[0].length).trim();
    return { status: Number(m[1]), headers, body };
  });
}

export class GitHubRateLimit extends Error {
  // `text` is the original response (its headers drive the backoff); `message` is the sanitized human-readable line.
  constructor(text, now, message = text) {
    super('GitHub rate limit: ' + message.trim().split('\n')[0]);
    const reset = /x-ratelimit-reset:\s*(\d+)/i.exec(text);
    const retry = /retry-after:\s*([^\r\n]+)/i.exec(text);
    const retryAt = retry ? (/^\d+$/.test(retry[1].trim()) ? now + Number(retry[1]) * 1000 : Date.parse(retry[1])) : NaN;
    const resetAt = reset ? Number(reset[1]) * 1000 : NaN;
    this.until = new Date(Math.max(now + 60000, ...[resetAt, retryAt].filter(Number.isFinite),
      ...(!Number.isFinite(resetAt) && !Number.isFinite(retryAt) ? [now + 3600000] : []))).toISOString();
  }
}

// Only the application policy refusal is eligible, never an authorization/Guardian denial.
function protectedDestination(error) {
  let reason = error;
  try { reason = JSON.parse(error)?.error ?? error; } catch { /* plain policy reason */ }
  return typeof reason === 'string' && /^protected T3 destination(?:$|:)/i.test(reason)
    && !/guardian|authorization|permission denied|user cancel/i.test(reason);
}

export function realDeps(cfg, runCommand = exec) {
  let state, dryRun = false;
  const counts = {};
  const gh = async (kind, args) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
    const r = await runCommand('gh', args, { timeout: 120000 });
    const text = r.stdout + '\n' + r.stderr;
    // Only the status line, the remaining-quota header and gh's own stderr can signal a limit. A PR body or diff that
    // mentions "rate limit" must not trigger a backoff.
    const status = /^HTTP\/[\d.]+\s+(\d{3})/.exec(r.stdout)?.[1], remaining = /^x-ratelimit-remaining:\s*(\d+)/im.exec(r.stdout)?.[1];
    if (status === '429' || (status === '403' && remaining === '0') || /rate limit exceeded|secondary rate limit/i.test(r.stderr)) throw new GitHubRateLimit(text, Date.now(), safeDiagnostic(text, 2000));
    if (r.code !== 0 && !/^HTTP\/[\d.]+\s+304\b/m.test(r.stdout)) throw new Error('gh ' + args.slice(0, 3).join(' ') + ': ' + safeDiagnostic((r.stderr || r.stdout).trim().split('\n')[0], 2000));
    return r.stdout;
  };
  const api = async (url, paginate = false) => {
    const cache = state?.data.api_cache ?? {};
    const saved = cache[url];
    const raw = await gh(paginate ? 'files' : 'pull', ['api', url, '-i', ...(paginate ? ['--paginate'] : []),
      ...(saved?.etag ? ['-H', 'If-None-Match: ' + saved.etag] : [])]);
    const pages = apiResponses(raw);
    let body;
    if (pages[0].status === 304) {
      if (!saved || !Object.hasOwn(saved, 'body')) throw new Error('gh api: 304 without cached body for ' + url);
      counts.not_modified = (counts.not_modified ?? 0) + 1;
      return saved.body;
    }
    for (const page of pages) if (page.status < 200 || page.status >= 300) throw new Error('gh api HTTP ' + page.status + ' for ' + url);
    body = paginate ? pages.flatMap(p => parseJsonBody(p.body, 'gh api page')) : parseJsonBody(pages[0].body, 'gh api response');
    if (state && !dryRun) {
      state.data.api_cache ??= {};
      state.data.api_cache[url] = { body, etag: pages.length === 1 && !/rel="next"/.test(pages[0].headers.link ?? '') ? pages[0].headers.etag : null };
    }
    return body;
  };
  return {
    now: () => Date.now(),
    beginRun: (s, dry) => { state = s; dryRun = dry; for (const key of Object.keys(counts)) delete counts[key]; },
    ghCounts: () => ({ ...counts }),
    status: async () => { const r = await runCommand(cfg.dot_worker, ['status', '--json']); if (r.code !== 0) throw new Error('status: ' + safeDiagnostic(r.stderr.trim(), 2000)); return parseJsonBody(r.stdout, 'status output'); },
    searchPrs: async ({ owner, repo }, since) => parseJsonBody(await gh('search', ['search', 'prs', ...(owner ? ['--owner', owner] : ['--repo', repo]),
      '--state', 'open', '--json', 'number,repository,url,updatedAt,isDraft,author', '--limit', '200', ...(since ? ['updated:>=' + since] : [])])),
    prDetails: async (repo, number) => api('repos/' + repo + '/pulls/' + number),
    prFiles: async (repo, number) => api('repos/' + repo + '/pulls/' + number + '/files', true),
    openBridge: () => new DatabaseSync(cfg.bridge_db, { readOnly: true }),
    cancel: async (id, reason) => {
      const r = await runCommand(cfg.dot_worker, ['cancel', id, '--reason', reason]);
      if (r.code !== 0) throw new Error('cancel ' + id + ': ' + safeDiagnostic((r.stderr || r.stdout).trim().split('\n').pop(), 2000));
    },
    openT3: () => new DatabaseSync(cfg.t3_db, { readOnly: true }),
    submit: async (assignment, { delivery, objective, head }) => {
      const args = ['submit', '--stdin', '--json', '--background', '--exclude-sensitive', '--allow-scope-prune', '--deliver', delivery,
        '--objective-key', objective, '--revision', head, '--task-kind', 'review', '--source', 'agent'] // assignments.source is CHECK-constrained to drainer|fix-loop|agent|unknown; prh- ids and pr: objective keys mark this producer;
      const r = await runCommand(cfg.dot_worker, args, { input: JSON.stringify(assignment), timeout: 180000 });
      const text = (r.stderr + r.stdout).trim();
      let error = null;
      if (r.code !== 0) error = safeDiagnostic(text.split('\n').filter(Boolean).pop() ?? `exit ${r.code}`, 2000);
      else { try { const out = JSON.parse(r.stdout); if (out?.error) error = safeDiagnostic(String(out.error), 2000); } catch { /* plain output is fine */ } }
      return { ok: error === null, error, output: r.stdout.trim() };
    },
  };
}

// ---- one run ---------------------------------------------------------------------------------------------------------

export async function run({ cfg, deps, stateDir = paths.stateDir, dryRun = false, only = null, maxSubmits = null, ignoreCapacity = false, print = () => {} }) {
  if (only !== null) {
    if (!only || typeof only !== 'object' || typeof only.repo !== 'string' || !Number.isSafeInteger(only.number) || only.number <= 0) throw new Error('invalid --only: expected owner/repo#number');
    parseOnly(`${only.repo}#${only.number}`);
  }
  const logFile = path.join(stateDir, 'log.jsonl');
  const log = (event, fields = {}) => {
    const line = redactLogEntry({ at: new Date(deps.now()).toISOString(), event, dry_run: dryRun || undefined, ...fields });
    print(JSON.stringify(line));
    if (!dryRun) { fs.mkdirSync(stateDir, { recursive: true }); fs.appendFileSync(logFile, JSON.stringify(line) + '\n'); }
  };
  const summary = { submitted: 0, skipped: 0, refused: 0, errors: 0, cancelled: 0, hold: null, slots: null };
  const now = deps.now(), state = new State(stateDir);
  deps.beginRun?.(state, dryRun);
  let complete = true;
  try {
    if (Date.parse(state.data.backoff_until) > now) {
      summary.hold = 'GitHub backoff until ' + state.data.backoff_until;
      log('hold', { reason: summary.hold }); return summary;
    }
    // A merged or closed PR no longer needs its review: cancel its queued and claimed requests so they free their lanes. Runs
    // before the capacity gate, since a full or held queue is when stale work costs the most. One REST pulls call per tracked
    // PR (conditional on the saved ETag, so an unchanged PR is a 304), never GraphQL, and at most max_closed_checks per run.
    if (!only) {
      let tracked = [];
      const bridge = deps.openBridge();
      try { tracked = trackedPrs(bridge); } finally { bridge.close(); }
      for (const pr of tracked.slice(0, cfg.max_closed_checks ?? DEFAULTS.max_closed_checks)) {
        try {
          if ((await deps.prDetails(pr.repo, pr.number)).state !== 'closed') continue;
          for (const id of pr.ids) {
            if (dryRun) { log('would-cancel', { repo: pr.repo, pr: pr.number, request_id: id, reason: 'pr_closed' }); continue; }
            await deps.cancel(id, 'pr_closed'); summary.cancelled++;
            log('cancel', { repo: pr.repo, pr: pr.number, request_id: id, reason: 'pr_closed' });
          }
        } catch (e) {
          if (e instanceof GitHubRateLimit) throw e;
          log('error', { repo: pr.repo, pr: pr.number, stage: 'pr-closed-check', error: e.message });
        }
      }
    }
    const status = await deps.status(), g = gate(status, cfg, now);
    if (g.hold) { summary.hold = g.hold; log('hold', { reason: g.hold }); return summary; }
    const limit = Math.min(maxSubmits ?? cfg.max_submits_per_run, ignoreCapacity ? Infinity : g.slots);
    summary.slots = g.slots;
    log('capacity', { claimed: g.claimed, queued: g.queued, lanes: g.lanes, headroom: cfg.headroom, slots: g.slots, limit: Number.isFinite(limit) ? limit : null });
    if (limit <= 0) return summary;

    const excludedOwners = new Set(cfg.exclude_owners.map(lower));
    const owners = [...new Set(cfg.owners.map(lower))].filter(o => !excludedOwners.has(o));
    const sources = only ? reviewRepos([], { ...cfg, repos: [only.repo] }).map(repo => ({ repo }))
      : [...owners.map(owner => ({ owner })), ...reviewRepos([], cfg).filter(repo => !owners.includes(lower(repo.split('/')[0]))).map(repo => ({ repo }))];
    const previous = Date.parse(state.data.last_successful_run);
    const since = !only && Number.isFinite(previous) ? new Date(previous - 600000).toISOString() : null;
    const listing = [];
    // Sequential gh calls ensure a rate-limit response cannot leave more work running.
    for (const source of sources) {
      try {
        const rows = await deps.searchPrs(source, since);
        if (rows.length >= 200) { complete = false; log('note', { reason: 'search limit reached; incremental watermark retained', ...source }); }
        for (const row of rows) {
          const repo = row.repository?.nameWithOwner ?? row.repository?.fullName ?? row.repository?.full_name ?? source.repo;
          if (!repo || !reviewRepos([], { ...cfg, repos: [repo] }).length) continue;
          if (row.repository?.isArchived || row.repository?.archived) continue;
          if (!cfg.include_forks && (row.repository?.isFork || row.repository?.fork)) continue;
          if (only && row.number !== only.number) continue;
          listing.push({ ...row, repo });
        }
      } catch (e) {
        if (e instanceof GitHubRateLimit) throw e;
        summary.errors++; complete = false; log('error', { stage: 'search-prs', ...source, error: e.message });
      }
    }
    const prs = selectPrs([...new Map(listing.map(pr => [prKey(pr.repo, pr.number), pr])).values()], cfg, now);
    let bridge, t3;
    try {
      bridge = deps.openBridge(); t3 = deps.openT3();
      const index = threadIndex(t3);
      for (const row of prs) {
        if (summary.submitted >= limit) { complete = false; break; }
        let pr;
        try {
          const detail = await deps.prDetails(row.repo, row.number);
          if (detail.state === 'closed' || detail.base?.repo?.archived || (!cfg.include_forks && detail.base?.repo?.fork)) continue;
          const head = String(detail.head?.sha ?? '').toLowerCase(), base = detail.base?.sha;
          if (!/^[a-f0-9]{40}$/.test(head) || !/^[a-f0-9]{40}$/i.test(base ?? '')) throw new Error('invalid PR head/base SHA');
          pr = { repo: row.repo, number: row.number, head, base, isDraft: row.isDraft };
        } catch (e) {
          if (e instanceof GitHubRateLimit) throw e;
          summary.errors++; complete = false; log('error', { repo: row.repo, pr: row.number, stage: 'pr-details', error: e.message }); continue;
        }
        const id = requestId(pr.repo, pr.number, pr.head), ident = { repo: pr.repo, pr: pr.number, head: pr.head, request_id: id };
        const covered = findCovered(bridge, pr.repo, pr.number, pr.head);
        if (covered) { summary.skipped++; if (state.firstCovered(id)) log('skip', { ...ident, reason: 'covered', by: covered.request_id, status: covered.status }); continue; }
        const protectedReason = protectedDestination(state.data.reasons?.[id] ?? '') ? state.data.reasons[id] : null;
        if (!protectedReason && state.recentlyRefused(id, now, cfg.refusal_cooldown_hours)) { complete = false; summary.skipped++; log('skip', { ...ident, reason: 'refused earlier', detail: state.data.reasons?.[id] }); continue; }
        let files;
        try {
          files = await deps.prFiles(pr.repo, pr.number);
          const latest = await deps.prDetails(pr.repo, pr.number);
          const latestHead = String(latest.head?.sha ?? '').toLowerCase();
          if (latestHead !== pr.head) {
            complete = false; summary.skipped++;
            log('skip', { ...ident, reason: 'PR head changed while fetching files', latest_head: latestHead });
            continue;
          }
        }
        catch (e) {
          if (e instanceof GitHubRateLimit) throw e;
          summary.errors++; complete = false; log('error', { ...ident, stage: 'pr-files', error: e.message }); continue;
        }
        const liveFiles = files.filter(f => typeof f === 'string' || f.status !== 'removed').map(f => typeof f === 'string' ? f : f.filename);
        if (files.length && !liveFiles.length) { summary.skipped++; log('skip', { ...ident, reason: 'only deletions' }); continue; }
        if (files.length > (cfg.max_changed_files ?? DEFAULTS.max_changed_files)) { summary.skipped++; log('skip', { ...ident, reason: 'too many changed files', changed_files: files.length, max_changed_files: cfg.max_changed_files ?? DEFAULTS.max_changed_files }); continue; }
        // REST pulls supplies the base tip, not the merge base. Never claim it is a merge base.
        const plan = planReview(pr, { files: liveFiles, mergeBase: null }, cfg, now);
        if (plan.skip) { complete = false; summary.skipped++; state.refuse(id, now, plan.skip); log('skip', { ...ident, reason: plan.skip, excluded: plan.excluded }); continue; }
        const target = deliveryFor(index, pr.repo, pr.number, cfg);
        const delegate = target.via === 'pr-link' && target.delivery.startsWith('t3:thread:delegated-task:');
        const fallbackReason = delegate
          ? 'delegate thread' : protectedReason;
        if (fallbackReason && target.delivery.startsWith('t3:')) {
          const owner = delegate ? delegateOwner(t3, target.delivery.slice(3)) : null;
          const next = owner
            ? { delivery: `t3:${owner}`, via: 'owner' }
            : fallbackDelivery(cfg, target.delivery);
          log('delivery-fallback', { ...ident, reason: fallbackReason, from: target.delivery, delivery: next.delivery });
          Object.assign(target, next);
        }
        const detail = { ...ident, scope_paths: plan.scope.length, changed_files: files.length, excluded: plan.excluded, diff: plan.diff, delivery: target.delivery, delivery_via: target.via, warnings: plan.warnings };
        if (target.via === 'none') log('note', { ...ident, reason: 'no deliverable T3 thread or report_thread_id; delivery none' });
        if (dryRun) { summary.submitted++; log('would-submit', detail); continue; }
        const meta = { delivery: target.delivery, objective: objectiveKey(pr.repo, pr.number), head: pr.head };
        let result = await deps.submit(plan.assignment, meta);
        while (!result.ok && meta.delivery.startsWith('t3:') && protectedDestination(result.error ?? '')) {
          const next = fallbackDelivery(cfg, meta.delivery);
          log('delivery-fallback', { ...ident, reason: result.error, from: meta.delivery, delivery: next.delivery });
          meta.delivery = detail.delivery = next.delivery; detail.delivery_via = next.via;
          result = await deps.submit(plan.assignment, meta);
        }
        if (result.ok) { summary.submitted++; log('submit', detail); }
        else if (deferredSubmit(result.error)) { complete = false; summary.hold = result.error; log('hold', { ...detail, reason: result.error }); break; }
        else if (transient.test(result.error)) { complete = false; summary.errors++; state.refuse(id, now, result.error); log('error', { ...detail, stage: 'submit', error: result.error }); break; }
        else { complete = false; summary.refused++; state.refuse(id, now, result.error); log('refused', { ...detail, error: result.error }); }
      }
    } finally { bridge?.close(); t3?.close(); }
    if (complete && !summary.errors && !only) state.data.last_successful_run = new Date(now).toISOString();
  } catch (e) {
    summary.errors++;
    if (e instanceof GitHubRateLimit) {
      state.data.backoff_until = e.until; summary.hold = 'GitHub rate limit';
      log('rate-limit', { error: e.message, backoff_until: e.until });
    } else { log('error', { stage: 'run', error: e.message }); }
  } finally {
    if (!dryRun) state.save(now, cfg.refusal_cooldown_hours);
    summary.gh_calls = deps.ghCounts?.() ?? {};
    log('gh-calls', { counts: summary.gh_calls });
    log('run', summary);
  }
  return summary;
}

export function acquireLock(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'run.lock');
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); return () => { try { fs.unlinkSync(file); } catch { /* gone */ } }; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) return null;
      try { process.kill(Number(raw), 0); return null; } catch (err) { if (err.code !== 'ESRCH') return null; }
      try { fs.unlinkSync(file); } catch { /* raced */ }
    }
  }
  return null;
}
