// Work-order compiler: the one place that turns a submitted assignment into an admission verdict.
//
//   admissible  the bridge will store it and the worker can take it
//   clarify     the requester must choose or fix something (ambiguous name, probable typo, missing input); the reason says what
//   reject      invalid or forbidden (bad schema, unsafe path, sensitive scope, secret content); retrying unchanged cannot work
//   defer       fine as written, but cannot run now (worker paused or on a usage break, capability missing on this host,
//               queue deeper than the requester's threshold); the reason carries a retry hint
//
// It runs the checks that already guarded submit (src/submission-policy.mjs, src/execution.mjs, src/check-readiness.mjs, PR
// preflight) and maps what they throw to typed reasons {code, field, message, fix}. It writes nothing to the store: the same
// call serves `submit --dry-run` and the real submit, so a preview cannot disagree with the decision. The checks read the pinned
// repository through the bridge mirror (a fetch may refresh that cache); that is the only side effect.
import { submissionLimits, instructionBytes } from './submission-policy.mjs';

export const VERDICTS = Object.freeze(['admissible', 'clarify', 'reject', 'defer']);
// Exit codes of `dalan submit` (0 = stored or admissible).
export const VERDICT_EXIT = Object.freeze({ admissible: 0, reject: 2, clarify: 3, defer: 4 });
const rank = { admissible: 0, defer: 1, clarify: 2, reject: 3 };

const bytes = value => Buffer.byteLength(String(value ?? ''), 'utf8');
const list = text => String(text).split(', ').map(x => x.trim()).filter(Boolean);
const fmt = n => n == null || !Number.isFinite(Number(n)) ? 'unknown' : Number(n).toLocaleString('en-US');

// A thrown check error to typed reasons. Each rule: [pattern, build(match, error) -> reason | reason[]]; the first match wins.
// `verdict` is the class the reason belongs to. Unmatched errors are rejections with code 'refused' and the original text.
const rules = [
  [/^(brief|task instructions|expected output): (\d+) UTF-8 bytes exceeds (\d+)/, m => {
    const field = m[1] === 'brief' ? 'brief' : m[1] === 'expected output' ? 'expected_output' : 'instructions';
    const cut = Number(m[2]) - Number(m[3]);
    return { verdict: 'reject', code: `${field}_too_large`, field, message: `${m[1]} is ${fmt(m[2])} UTF-8 bytes; the limit is ${fmt(m[3])}`,
      fix: `cut at least ${fmt(cut)} bytes${field === 'instructions' ? ' from the brief, expected_output or scope lists' : ''}${field === 'brief' ? ' (the bridge may append a scope allow-list; the count already includes it where it was added)' : ''}` };
  }],
  [/^(?:aggregate )?owner note/, m => ({ verdict: 'reject', code: 'note_too_large', field: 'note', message: m.input, fix: 'shorten the note' })],
  [/^hard sensitive path exclusion: (.+)$/, m => ({ verdict: 'reject', code: 'sensitive_path_hard', field: 'scope_paths', message: `${m[1]} is credential, key or signing material and can never be in scope`, fix: `remove ${m[1]} from scope_paths and from the brief` })],
  [/^sensitive scope path: (.+?)(?: \((.*)\))?$/, m => ({ verdict: 'reject', code: 'sensitive_path', field: 'scope_paths', message: `${m[1]} matches the sensitive-path rules${m[2] ? ` (${m[2]})` : ''}`,
    fix: `remove ${m[1]} from scope_paths, or for read-only work submit with exclude_sensitive (--exclude-sensitive) to drop sensitive files from a directory scope` })],
  [/^hard sensitive (?:patch )?content exclusion$/, m => ({ verdict: 'reject', code: 'secret_content', field: 'brief', message: 'the assignment contains what looks like a secret value (key, token or password URL)', fix: 'remove the secret and refer to it by name' })],
  [/^live-slot or expanded-authority claim in instructions$/, () => ({ verdict: 'reject', code: 'authority_claim', field: 'brief', message: 'the instructions claim live slots or expanded authority', fix: 'remove the claim; the bridge, not the brief, grants capacity and authority' })],
  [/^invalid (scope_paths|read_paths|read_list|brief read-list|mention|sensitive_paths|exception path); explicit repository-relative paths required$/, m => ({ verdict: 'reject', code: 'invalid_path', field: m[1], message: `${m[1]} holds a path that is not repository-relative (absolute, "..", glob or control characters)`, fix: 'name each file or directory by its path from the repository root' })],
  [/^invalid output_paths: (.+)$/s, m => ({ verdict: 'reject', code: 'invalid_output_paths', field: 'output_paths', message: m[1], fix: 'list up to 10 new repository-relative file paths, with no globs or directories' })],
  [/^output_paths are not allowed with --review/, m => ({ verdict: 'reject', code: 'output_paths_in_review', field: 'output_paths', message: m.input, fix: 'remove output_paths, or submit without --review' })],
  [/^output_paths require pinned repository input/, m => ({ verdict: 'clarify', code: 'missing_inputs', field: 'inputs', message: m.input, fix: 'add inputs: [{github_repo, base_sha}] to the assignment' })],
  [/^output_paths cannot be combined with input_patch/, m => ({ verdict: 'reject', code: 'output_paths_with_patch', field: 'output_paths', message: m.input, fix: 'submit the patch as its own job, or push it and pin head_sha' })],
  [/^output_paths: (?:hard sensitive|sensitive scope)/, m => ({ verdict: 'reject', code: 'output_path_sensitive', field: 'output_paths', message: m.input, fix: 'name the new file so that it does not look like credential, auth or signing material' })],
  [/^output_paths: (.+)$/s, m => ({ verdict: 'clarify', code: 'output_path_taken', field: 'output_paths', message: m[1], fix: 'choose output paths that do not exist at the pinned revision; to change an existing file list it in scope_paths' })],
  [/^unknown repository scope; scope_paths required$/, () => ({ verdict: 'clarify', code: 'missing_scope', field: 'scope_paths', message: 'repository work needs scope_paths', fix: 'list the files or directories the worker may read (and change)' })],
  [/^structured repository assignment requires scope_paths$/, () => ({ verdict: 'clarify', code: 'missing_scope', field: 'scope_paths', message: 'a structured repository assignment needs scope_paths', fix: 'add scope_paths' })],
  [/^scope_paths require pinned repository input$/, () => ({ verdict: 'clarify', code: 'missing_inputs', field: 'inputs', message: 'scope_paths are set but the assignment pins no repository', fix: 'add inputs: [{github_repo, base_sha}], or remove scope_paths' })],
  [/^contradictory (read_paths|read_list|brief read-list) and scope_paths: (.+)$/s, m => ({ verdict: 'clarify', code: 'contradictory_scope', field: m[1], message: m.input, fix: `make ${m[1]} equal scope_paths, or drop ${m[1]}` })],
  [/^(?:diff|patch) outside scope_paths: (.+)$/, m => ({ verdict: 'clarify', code: 'diff_outside_scope', field: 'scope_paths', message: m.input, fix: `add ${m[1]} to scope_paths` })],
  [/^symlink in (?:repository scope|input patch scope): ?(.*)$/, m => ({ verdict: 'reject', code: 'symlink_in_scope', field: 'scope_paths', message: m.input, fix: 'name the real files, or exclude the symlink (read-only work can use exclude_sensitive)' })],
  [/^scope growth limit: /, m => ({ verdict: 'reject', code: 'scope_too_wide', field: 'scope_paths', message: m.input, fix: 'list the files in scope_paths' })],
  [/^incomplete input patch/, m => ({ verdict: 'reject', code: 'invalid_input_patch', field: 'inputs', message: m.input, fix: 'send a complete `git diff` as input_patch' })],
  [/^head_sha_unsupported: /, m => ({ verdict: 'reject', code: 'head_sha_unsupported', field: 'inputs', message: m.input, fix: 'pin base_sha to the revision to work on, or use --review or read-only scope for head_sha' })],
  [/^invalid valid_until$/, m => ({ verdict: 'reject', code: 'invalid_valid_until', field: 'valid_until', message: m.input, fix: 'give valid_until as a future RFC 3339 timestamp, or omit it to use the bridge default when evidence is sufficient' })],
  [/^valid_until has expired$/, m => ({ verdict: 'reject', code: 'validity_expired', field: 'valid_until', message: m.input, fix: 'refresh the pinned inputs and provide a new future valid_until; the bridge will not extend a caller deadline' })],
  [/^regression_test_scope: /, m => ({ verdict: 'clarify', code: 'missing_test_scope', field: 'scope_paths', message: m.input, fix: 'add a test path to scope_paths, or drop the regression-test request from expected_output' })],
  [/^BLOCKED: check prerequisites unmet: /, m => ({ verdict: 'defer', code: 'check_prerequisites_unmet', field: 'checks', message: m.input.replace(/^BLOCKED: /, ''), fix: 'install the missing prerequisite on the bridge host, or submit with --execution worker', retry: true, blocking: true })],
  [/^BLOCKED: check metadata unreadable/, m => ({ verdict: 'reject', code: 'check_metadata_unreadable', field: 'checks', message: m.input.replace(/^BLOCKED: /, ''), fix: 'fix the check metadata file at base_sha, or submit with --execution worker' })],
  [/^capability_not_available: (\w+) \((.*)\)$/, m => /declares unsupported/.test(m[2])
    ? { verdict: 'reject', code: 'capability_unsupported', field: 'required_capabilities', message: `${m[1]} ${m[2]}`, fix: 'drop this required capability or run the job where the backend supports it' }
    : { verdict: 'defer', code: 'capability_unavailable', field: 'required_capabilities', message: `${m[1]}: ${m[2]}`, fix: 'wait until the host provides it (install the executor), or submit with --execution worker', retry: true, blocking: true }],
  [/^(?:worker|dot) queue is full \((\d+) queued, in-flight cap (\d+)\)/, m => ({ verdict: 'defer', code: 'queue_full', field: 'max_queued', message: m.input, fix: 'wait for queued work to drain, or raise max_queued', retry: true })],
  [/^background_capacity_full$/, () => ({ verdict: 'defer', code: 'background_capacity_full', field: 'priority', message: 'background lane is full', fix: 'wait for background work to drain', retry: true })],
  [/^invalid (assignment|delivery|max_queued|review|background|allow_main|exclude_sensitive|required_capabilities|execution|sensitive scope override|dry_run|queue_anyway|\w+)\b/, m => ({ verdict: 'reject', code: 'invalid_schema', field: m[1].replace(/ /g, '_'), message: m.input, fix: `correct ${m[1]} (see docs/usage.md, Submit)` })],
  [/^unknown sensitive scope override/, m => ({ verdict: 'reject', code: 'unknown_override', field: 'sensitive_scope_override', message: m.input, fix: 'use an exception id from the submission policy' })],
  [/^(?:structured assignment requires|scope_text)/, m => ({ verdict: 'reject', code: 'invalid_schema', field: 'assignment', message: m.input, fix: 'give objective and stop_rule, or a plain brief' })],
];

// "a, b, c" or "a, b, ..." candidates out of an ambiguity message.
const candidatesIn = text => { const m = /\(([^)]*)\)/.exec(text); return m ? m[1].split(', ').filter(x => x && x !== '...') : []; };

// One thrown error to its reasons (multi-line refusals split into one reason per problem).
export function reasonsFromError(error) {
  const message = String(error?.message ?? error);
  const out = [];
  const lines = message.split('\n');
  if (lines.some(l => /^(?:undeclared instruction path|ambiguous |unknown bare filename)/.test(l))) {
    for (const line of lines) {
      let m;
      if ((m = /^undeclared instruction path: (.+)$/.exec(line))) out.push({ verdict: 'clarify', code: 'undeclared_path', field: 'scope_paths', message: line,
        fix: error.suggested_scope_paths ? `add ${list(m[1]).join(', ')} to scope_paths (corrected scope_paths: ${JSON.stringify(error.suggested_scope_paths)}), or remove the mention from the brief` : `remove ${m[1]} from the brief, or name the repository file that scope_paths should hold`, ...(error.suggested_scope_paths ? { suggested_scope_paths: error.suggested_scope_paths } : {}) });
      else if ((m = /^(ambiguous (?:bare filename|abbreviated path)) "([^"]+)"/.exec(line))) out.push({ verdict: 'clarify', code: 'ambiguous_path', field: 'brief', message: line, candidates: candidatesIn(line),
        fix: `write the full repository path of the one you mean instead of "${m[2]}"` });
      else if ((m = /^unknown bare filename "([^"]+)"/.exec(line))) out.push({ verdict: 'clarify', code: 'unknown_path', field: 'brief', message: line, candidates: [], fix: `write the full repository path of ${m[1]} (a new file needs its full path, in output_paths)` });
    }
    return out;
  }
  const unknown = /^unknown scope path: (.+)$/.exec(message);
  if (unknown) {
    const paths = list(unknown[1]);
    return paths.map(p => ({ verdict: 'clarify', code: 'unknown_scope_path', field: 'scope_paths', message: `scope path ${p} is not in the repository at the pinned revision`,
      ...(error.candidates?.[p] ? { candidates: error.candidates[p] } : {}),
      fix: error.candidates?.[p]?.length ? `did you mean ${error.candidates[p].join(' or ')}? Otherwise remove ${p} (a new file belongs in output_paths)` : `remove ${p} from scope_paths (a new file belongs in output_paths), or check the base_sha`,
      ...(error.suggested_scope_paths ? { suggested_scope_paths: error.suggested_scope_paths } : {}) }));
  }
  for (const [pattern, build] of rules) {
    const m = pattern.exec(message);
    if (!m) continue;
    m.input = message;
    const built = build(m, error);
    return (Array.isArray(built) ? built : [built]);
  }
  return [{ verdict: 'reject', code: 'refused', field: 'assignment', message, fix: 'see the message; correct the assignment and submit again' }];
}

export const strongest = reasons => reasons.reduce((v, r) => rank[r.verdict] > rank[v] ? r.verdict : v, 'admissible');
// Reasons as the public shape {code, field, message, fix, ...hints}.
// A `blocking` defer is a host that cannot run the job at all (no executor, unmet check prerequisite): it always refuses, and
// --queue-anyway does not apply, because a queued job would only fail later.
const publicReason = ({ verdict, retry, blocking, ...r }) => r;
function inputShape(inputs=[]) {
  const repositoryPins=[];
  for(const input of listOf(inputs)) {
    if(!input||typeof input!=='object'||typeof input.github_repo!=='string'||!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(input.github_repo)) continue;
    const pin={github_repo:input.github_repo};
    for(const key of ['base_sha','head_sha']) if(typeof input[key]==='string'&&/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(input[key])) pin[key]=input[key];
    repositoryPins.push(pin);
    if(repositoryPins.length===20) break;
  }
  const values=listOf(inputs);
  return {count:values.length,repository_pin_count:values.filter(x=>x&&typeof x==='object'&&typeof x.github_repo==='string').length,repository_pins:repositoryPins};
}
function safeRepositoryPaths(value=[]) {
  const list=Array.isArray(value)?value:[];
  const safe=list.filter(p=>typeof p==='string'&&p.length<=256&&!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(p)&&!p.startsWith('/')&&!p.includes('\\')&&!p.split('/').includes('..')&&!/[\x00-\x1f\x7f*?]/.test(p)&&!/\b(?:token|secret|password|api[_-]?key)=/i.test(p));
  return {paths:safe.slice(0,100),count:list.length,omitted:list.length-Math.min(100,safe.length)};
}

// Fields the byte counter reads as text or as lists. Any other type is a malformed submission, not a size to count.
const TEXT_FIELDS = ['brief', 'expected_output', 'execution_scope', 'scope_text'];
const LIST_FIELDS = ['scope_paths', 'output_paths', 'scope_excluded', 'inputs'];
const listOf = value => (Array.isArray(value) ? value : []);
function malformedFields(r) {
  if (!r || typeof r !== 'object') return [];
  return [
    ...TEXT_FIELDS.filter(k => r[k] != null && typeof r[k] !== 'string'),
    ...LIST_FIELDS.filter(k => r[k] != null && !Array.isArray(r[k])),
  ];
}

// Byte accounting of what the worker will see. `submitted` is the final adapter assignment after rendering (a structured
// assignment becomes a brief); `expanded` is what the bridge stores after it appends its allow-list or scope note. Adapter
// additions already live in `submitted.brief`, so the actual UTF-8 bytes count in both views.
// A malformed field yields no counts (null) and names the fields in `invalid_fields`; the compiler rejects it separately.
export function accountBytes(submitted, expanded) {
  const invalid = [...new Set([...malformedFields(submitted), ...malformedFields(expanded)])];
  if (invalid.length) return { brief: null, instructions: null, after_expansion: null, limits: { ...submissionLimits }, over_by: null, invalid_fields: invalid };
  const sub ={ brief: bytes(submitted?.brief), instructions: submitted ? instructionBytes({ ...submitted, brief: submitted.brief ?? '', expected_output: submitted.expected_output ?? '' }) : 0 };
  const after = expanded ? { brief: bytes(expanded.brief), instructions: instructionBytes(expanded) } : null;
  const eff = after ?? sub;
  const over = (n, limit) => Math.max(0, n - limit);
  return {
    brief: sub.brief, instructions: sub.instructions,
    after_expansion: after,
    limits: { ...submissionLimits },
    over_by: { brief: over(eff.brief, submissionLimits.brief), instructions: over(eff.instructions, submissionLimits.instructions) },
  };
}

// request:  { assignment, review, backgroundPriority, excludeSensitive, sensitiveScopeOverride, jobExecution, requiredCapabilities,
//             meta, maxQueued, target, deferQueued }
// deps:     { render(assignment), shapeOk(payload), validate(payload, opts), admitExecution(payload, request), admitReadiness(payload, request),
//             preflight(payload), state(request) -> {paused, pause_reason, worker_break, queued, claimed, ...}, kind(request, payload),
//             defaultValidity(kind, request) -> queue-window evidence, retryAfterSeconds(request) }
// Resolves to {verdict, reasons, bytes, normalized_scope, valid_until, warnings, retry_after_seconds?, refusal?}. `refusal` (a
// non-enumerable property) is the first thrown error, so a caller that must keep its message can rethrow it.
// Infrastructure failures (the scanner could not run) are not verdicts: they propagate.
export async function compileWorkOrder(request, deps) {
  const warnings = [];
  const reasons = [];
  let refusal = null;
  let payload = null, expanded = null, readiness = null, preflight = null;
  const fail = error => {
    if (error?.code === 'DOT_BRIDGE_INFRASTRUCTURE') throw error;
    refusal ??= error;
    reasons.push(...reasonsFromError(error));
  };
  try { payload = deps.render(request.assignment); } catch (error) { fail(error); }
  if(payload&&payload.valid_until!==undefined&&payload.valid_until!==null) {
    const deadline=typeof payload.valid_until==='string'?Date.parse(payload.valid_until):NaN;
    if(!Number.isFinite(deadline)) fail(new Error('invalid valid_until'));
    else if(deadline<=Date.now()) fail(new Error('valid_until has expired'));
  }
  if (payload && !reasons.length && deps.shapeOk) {
    try { deps.shapeOk(payload); } catch (error) { fail(error); }
  }
  // Order matches the old submit path: capability, then scope and size, then check readiness, then PR preflight.
  if (payload && !reasons.length) {
    try { deps.admitExecution(payload, request); } catch (error) { fail(error); }
  }
  if (payload && !reasons.some(r => r.verdict === 'reject' || r.verdict === 'clarify')) {
    try { expanded = await deps.validate(payload, { warnings }); } catch (error) { expanded=error.expandedPayload??null; fail(error); }
  }
  if (expanded && !reasons.some(r => r.verdict === 'reject' || r.verdict === 'clarify')) {
    try { readiness = await deps.admitReadiness(expanded, request); } catch (error) { fail(error); }
    if (!reasons.some(r => r.verdict === 'reject' || r.verdict === 'clarify')) {
      try { preflight = (await deps.preflight?.(expanded)) ?? null; } catch (error) { fail(error); }
    }
  }
  // State-dependent reasons never hide a rejection: they are added only when the order itself is sound.
  let retryAfter = null, state = null;
  if (!reasons.some(r => r.verdict === 'reject' || r.verdict === 'clarify')) {
    state = deps.state(request);
    if (state.paused) reasons.push({ verdict: 'defer', code: 'worker_paused', field: 'worker', message: `the bridge is paused${state.pause_reason ? `: ${state.pause_reason}` : ''}`, fix: 'the work will queue and start after the owner resumes the bridge; use --refuse-defer to leave it unsubmitted', retry: true });
    if (state.worker_break) reasons.push({ verdict: 'defer', code: 'usage_break', field: 'worker', message: `the worker is on a usage break since ${state.worker_break.since}`, fix: 'the work will queue and start after the usage break; use --refuse-defer to leave it unsubmitted', retry: true });
    const threshold = request.deferQueued ?? deps.deferQueued ?? null;
    if (threshold !== null && state.queued >= threshold) reasons.push({ verdict: 'defer', code: 'queue_depth', field: 'worker', message: `${state.queued} items are queued for the worker (defer threshold ${threshold})`, fix: 'the work will queue; use --refuse-defer to leave it unsubmitted', retry: true });
    if (request.maxQueued != null && state.queued >= request.maxQueued && !reasons.some(r => r.code === 'queue_depth')) reasons.push({ verdict: 'defer', code: 'queue_full', field: 'max_queued', message: `worker queue is full (${state.queued} queued, in-flight cap ${request.maxQueued})`, fix: 'wait for queued work to drain, or use --refuse-defer to leave it unsubmitted', retry: true });
  }
  // A malformed field cannot be counted or admitted: a typed rejection, not a crash or a success-shaped count.
  for (const field of new Set([...malformedFields(payload), ...malformedFields(expanded)])) {
    const list = LIST_FIELDS.includes(field);
    reasons.push({ verdict: 'reject', code: 'invalid_field', field, message: `${field} must be ${list ? 'a list' : 'text'}`, fix: `send ${field} as ${list ? 'a JSON array' : 'a string'} and submit again` });
  }
  const verdict = strongest(reasons);
  if (verdict === 'defer') retryAfter = deps.retryAfterSeconds?.(request) ?? 300;
  const effective = expanded ?? payload;
  const kind = payload ? deps.kind(request, payload) : 'unknown';
  const requested = effective?.valid_until ?? null;
  const malformed = [...malformedFields(payload), ...malformedFields(expanded)].length > 0;
  const invalidOrder = malformed || reasons.some(r => ['reject','clarify'].includes(r.verdict) || r.blocking);
  const canSizeDefault = !requested && !invalidOrder && request.priority !== 'background' && !state?.paused && !state?.worker_break;
  const dv = canSizeDefault && deps.defaultValidity ? deps.defaultValidity(kind, request) : null;
  const result = {
    verdict,
    reasons: reasons.map(publicReason),
    bytes: accountBytes(payload, expanded),
    normalized_scope: effective ? {
      ...Object.fromEntries([['scope_paths',effective.scope_paths??[]],['output_paths',effective.output_paths??[]],['scope_excluded',effective.scope_excluded??[]]].map(([name,value])=>{const shaped=safeRepositoryPaths(value);return [name,shaped.paths]})),
      scope_path_count:listOf(effective.scope_paths).length,output_path_count:listOf(effective.output_paths).length,scope_excluded_count:listOf(effective.scope_excluded).length,
      omitted_scope_path_count:safeRepositoryPaths(effective.scope_paths).omitted,omitted_output_path_count:safeRepositoryPaths(effective.output_paths).omitted,
      inputs: inputShape(effective.inputs), execution_scope: effective.execution_scope ?? null,
    } : null,
    valid_until: requested ? { value: requested, source: 'requester' } : dv ? { value: dv.valid_until, source: dv.source??(dv.valid_until?'queue_p90':'insufficient_history'), window_ms: dv.window_ms??null, p90_ms: dv.p90_ms, samples: dv.samples, min_samples: dv.min_samples??null, factor: dv.factor, floor_ms: dv.floor_ms, cap_ms: dv.cap_ms, worker: dv.worker, kind: dv.kind, window_days: dv.window_days, expired_lower_bounds: dv.expired_lower_bounds } : { value: null, source: invalidOrder ? 'suppressed_invalid_order' : request.priority === 'background' ? 'suppressed_background' : state?.paused ? 'suppressed_paused' : state?.worker_break ? 'suppressed_usage_break' : 'insufficient_history' },
    warnings,
    ...(readiness ? { check_readiness: readiness } : {}),
    ...(verdict === 'defer' ? { retry_after_seconds: retryAfter ?? 300 } : {}),
  };
  Object.defineProperties(result, {
    refusal: { value: refusal, enumerable: false },
    payload: { value: expanded, enumerable: false },
    defaultValidity: { value: dv, enumerable: false },
    preflight: { value: preflight, enumerable: false },
    blocking: { value: reasons.some(r => r.blocking), enumerable: false },
  });
  return result;
}

// Text for a human: `dalan submit` prints this on stderr when the verdict is not admissible.
export function formatVerdict(order) {
  const lines = [`verdict: ${order.verdict}`];
  for (const r of order.reasons) {
    lines.push(`  ${r.code} (${r.field}): ${r.message}`);
    if (r.candidates?.length) lines.push(`    candidates: ${r.candidates.join(', ')}`);
    lines.push(`    fix: ${r.fix}`);
  }
  const b = order.bytes;
  const a = b?.after_expansion;
  if (b) lines.push(`  bytes: brief ${fmt(b.brief)}${a ? ` -> ${fmt(a.brief)} after expansion` : ''} (limit ${fmt(b.limits.brief)}); instructions ${fmt(b.instructions)}${a ? ` -> ${fmt(a.instructions)}` : ''} (limit ${fmt(b.limits.instructions)})`);
  if (order.retry_after_seconds) lines.push(`  retry after about ${order.retry_after_seconds}s`);
  if (order.valid_until?.value) lines.push(`  valid_until: ${order.valid_until.value} (${order.valid_until.source})`);
  else if(order.valid_until?.source==='insufficient_history') lines.push(`  valid_until: no default (${order.valid_until.samples??'unknown'}/${order.valid_until.min_samples??'?'} queue samples; insufficient history)`);
  return lines.join('\n');
}
