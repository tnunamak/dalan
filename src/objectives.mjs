// Objective identity of an assignment: objective_key, revision, task_kind and the submitter (source). Live submitters send
// it with /submit; older rows get it only from a tuple that the request_id itself proves (see docs/usage.md, "Metrics").
import { createHash } from 'node:crypto';
import { legacyFixLoopName } from './legacy-names.mjs';

// Submitter identity stored next to (not inside) the payload. Every manifest is submitted by the drainer, so there is no
// separate producer source; 'unknown' is for a caller that declares it cannot say.
// The fix loop was first called by an older name: it is accepted as input and normalized to `fix-loop`, and it stays the
// stored form of `assignments.source` in databases created before the rename (their CHECK constraint lists it), so no
// stored row changes there. A database created after the rename stores and allows only `fix-loop`.
export const fixLoopSource='fix-loop';
export const objectiveSources=['drainer',fixLoopSource,'agent','unknown'];
// A database whose stored schema was created before the rename keeps the earlier spelling (its CHECK constraint lists it and
// SQLite cannot change a CHECK without rebuilding the table). A newer database stores the neutral spelling. `legacy` says which.
export const toStoredSource=(source,legacy=true)=>legacy&&source===fixLoopSource?legacyFixLoopName:source;
export const fromStoredSource=source=>source===legacyFixLoopName?fixLoopSource:source;
// The earlier spelling also prefixes stored objective keys and task kinds. Rows keep what they were written with; every
// comparison and report reads both spellings as one.
export const canonicalObjectiveKey=key=>typeof key==='string'&&key.startsWith(`${legacyFixLoopName}:`)?`${fixLoopSource}${key.slice(legacyFixLoopName.length)}`:key;
export const canonicalTaskKind=kind=>kind===legacyFixLoopName?fixLoopSource:kind;
// A "kind/priority" label (or a bare kind) as the metrics report it.
export const canonicalKindLabel=label=>typeof label==='string'&&(label===legacyFixLoopName||label.startsWith(`${legacyFixLoopName}/`))?`${fixLoopSource}${label.slice(legacyFixLoopName.length)}`:label;
// SQL for the same mapping over a kind expression.
export const canonicalKindSql=expr=>`CASE WHEN (${expr})='${legacyFixLoopName}' THEN '${fixLoopSource}' ELSE (${expr}) END`;
// The reverse mapping, for hashes that were persisted under the earlier spelling.
export const storedObjectiveKey=(key,legacy=true)=>legacy&&typeof key==='string'&&key.startsWith(`${fixLoopSource}:`)?`${legacyFixLoopName}${key.slice(fixLoopSource.length)}`:key;
export const storedTaskKind=(kind,legacy=true)=>legacy&&kind===fixLoopSource?legacyFixLoopName:kind;
export function canonicalMetaValue(field,value) {
  if(value==null) return value;
  return field==='source'?fromStoredSource(value):field==='objective_key'?canonicalObjectiveKey(value):field==='task_kind'?canonicalTaskKind(value):value;
}
export const metaFields=['objective_key','revision','task_kind','source'];
export function normalizeMeta(meta) {
  const out=Object.fromEntries(metaFields.map(k=>[k,null]));
  if(meta===undefined||meta===null) return out;
  if(typeof meta!=='object'||Array.isArray(meta)||Object.keys(meta).some(k=>!metaFields.includes(k))) throw new Error('invalid meta');
  for(const k of metaFields) {
    const v=meta[k];
    if(v===undefined||v===null) continue;
    if(typeof v!=='string'||!v||Buffer.byteLength(v)>512) throw new Error(`invalid meta.${k}`);
    out[k]=k==='source'?fromStoredSource(v):v;
  }
  if(out.source!==null&&!objectiveSources.includes(out.source)) throw new Error('invalid meta.source');
  return out;
}

const hash = value => createHash('sha256').update(value).digest('hex');
// The drainer's deterministic identity: the request_id commits to the whole tuple, so a matching hash proves it. A
// re-preparation (the producer prepares the objective again after the bridge cancelled attempt n-1 as expired) appends
// `-r<n>`, as fix-loop reopen attempts do; the first preparation keeps the bare id, so existing ids are unchanged.
export const maxPreparationAttempt = 3;
export const drainerRequestId = (repo, objectiveKey, revision, taskKind, policyVersion = 1, attempt = 0) => `dot_${hash(JSON.stringify([repo ?? '', objectiveKey, revision, taskKind, policyVersion]))}${attempt ? `-r${attempt}` : ''}`;
export const preparationAttemptOf = requestId => Number(/-r(\d+)$/.exec(requestId)?.[1] ?? 0);
// fix-loop: one request id per candidate and reopen attempt (`-r<n>`); the objective is the candidate, the revision the pinned head.
// The request id prefix is persisted in existing request ids and receipts, so it does not change.
export const fixLoopRequestId = (candidate, attempt = 0) => `dotfix-${candidate.id}-${hash(`${candidate.repo}:${candidate.id}`).slice(0, 8)}${attempt ? `-r${attempt}` : ''}`.slice(0, 128);
export const fixLoopObjective = candidate => `${fixLoopSource}:${candidate.repo}#${candidate.id}`;
export const fixLoopTaskKind = fixLoopSource;
// Producers of earlier releases send the old name in the objective key and task kind; both spellings verify.
const fixLoopObjectivePattern = new RegExp(`^(?:${fixLoopSource}|${legacyFixLoopName}):([^#]+)#(.+)$`);
const fixLoopTaskKinds = [fixLoopTaskKind, legacyFixLoopName];

const firstInput = payload => (Array.isArray(payload?.inputs) ? payload.inputs[0] : null) ?? null;

// Null when the tuple is proven for this row (request_id + stored payload), else the reason it is not.
export function verifyObjective(row, tuple) {
  let meta;
  try { meta = normalizeMeta(tuple); } catch (error) { return error.message; }
  if (metaFields.some(k => meta[k] === null)) return 'incomplete tuple';
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload, input = firstInput(payload);
  if (meta.source === 'drainer') {
    if (row.request_id !== drainerRequestId(input?.github_repo ?? '', meta.objective_key, meta.revision, meta.task_kind, 1, preparationAttemptOf(row.request_id))) return 'request_id does not match the drainer identity of this tuple';
    if (input && meta.revision !== (input.head_sha ?? input.base_sha)) return 'revision differs from the pinned input';
    return null;
  }
  if (meta.source === fixLoopSource) {
    const m = fixLoopObjectivePattern.exec(meta.objective_key);
    if (!m || !fixLoopTaskKinds.includes(meta.task_kind)) return 'not a fix-loop objective';
    const candidate = { repo: m[1], id: m[2] }, attempt = Number(/-r(\d+)$/.exec(row.request_id)?.[1] ?? 0);
    if (row.request_id !== fixLoopRequestId(candidate, 0) && row.request_id !== fixLoopRequestId(candidate, attempt)) return 'request_id does not match the fix-loop candidate';
    if (input?.github_repo !== candidate.repo || input?.base_sha !== meta.revision) return 'revision or repo differs from the pinned input';
    return null;
  }
  return `source ${meta.source} cannot be verified`;
}

// Lens names the producer has used for audit objectives, including retired ones; a guess counts only if the hash matches.
const auditLenses = ['correctness', 'errors', 'tests', 'concurrency', 'clarity'];
function guesses(payload) {
  const input = firstInput(payload), repo = input?.github_repo;
  if (!repo) return [];
  const out = [];
  if (input.head_sha && input.pr_number) out.push({ objective_key: `pr-review:${repo}#${input.pr_number}`, revision: input.head_sha, task_kind: 'review' });
  const module = Array.isArray(payload.scope_paths) && typeof payload.scope_paths[0] === 'string' && payload.scope_paths[0].includes('/') ? payload.scope_paths[0].split('/')[0] : null;
  if (module && input.base_sha && !input.head_sha) {
    const part = /\(part (\d+) of \d+/.exec(payload.brief ?? '');
    const indexes = part ? [Number(part[1]) - 1] : [];
    for (const lens of auditLenses) for (const index of indexes) out.push({ objective_key: `audit:${repo}:${module}:${lens}:${index}`, revision: input.base_sha, task_kind: 'audit-review' });
    for (const kind of ['audit-review', 'audit']) out.push({ objective_key: `audit:${repo}:${module}`, revision: input.base_sha, task_kind: kind });
  }
  return out.map(t => ({ ...t, source: 'drainer' }));
}

// Host-side derivation for `dalan backfill-objectives`: receipts are the rows (their body is the submitted payload);
// manifests and the fix ledger supply exact tuples, and payload-shaped guesses cover consumed manifests. Only tuples
// that verifyObjective proves are returned; the server verifies again against its own stored payload.
export function deriveObjectives({ receipts = [], manifests = [], ledger = [] }) {
  const fromManifest = new Map(), fromLedger = new Map();
  for (const m of manifests) {
    if (!m || typeof m !== 'object' || m.policy_version !== 1) continue;
    const input = firstInput(m.assignment);
    fromManifest.set(drainerRequestId(input?.github_repo ?? '', m.objective_key, m.revision, m.task_kind, 1, m.preparation_attempt ?? 0), { objective_key: m.objective_key, revision: m.revision, task_kind: m.task_kind, source: 'drainer' });
  }
  for (const e of ledger) if (e?.stage === 'assigned' && typeof e.request_id === 'string' && e.request_id.startsWith('dotfix-') && e.id && e.repo && e.base_sha)
    fromLedger.set(e.request_id, { objective_key: fixLoopObjective(e), revision: e.base_sha, task_kind: fixLoopTaskKind, source: fixLoopSource });
  const tuples = [], counts = { receipts: 0, verified: { manifest: 0, ledger: 0, payload: 0 }, unverified: 0 };
  for (const r of receipts) {
    let payload;
    try { payload = JSON.parse(r.body); } catch { continue; }
    if (!payload || payload.request_id !== r.request_id) continue;
    counts.receipts++;
    const row = { request_id: r.request_id, payload };
    const tried = [['manifest', fromManifest.get(r.request_id)], ['ledger', fromLedger.get(r.request_id)], ...guesses(payload).map(t => ['payload', t])];
    const hit = tried.find(([, t]) => t && verifyObjective(row, t) === null);
    if (hit) { counts.verified[hit[0]]++; tuples.push({ request_id: r.request_id, ...hit[1] }); }
    else counts.unverified++;
  }
  return { tuples, counts };
}
