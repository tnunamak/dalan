import { createHash } from 'node:crypto';

/**
 * Pure, explicit owner-invoked publication planning. This is not a writer.
 *
 * API: createPublicationPlan({ selection, candidate, presentation }). The caller
 * must authenticate the owner and obtain immutable metadata before calling.
 * selection.binding pins the candidate.binding fields below; neither is inferred
 * from lifecycle observations. selection.required_checks and verified_receipts
 * are independently owner-selected evidence, not copied from worker assertions.
 * The planner checks consistency, not authenticity, freshness or remote state.
 * A coherent forgery cannot be authenticated by this data-only boundary.
 *
 * Inputs are plain JSON data (not executable objects). Only github.com, exact
 * same-repository/source-base planning and a new branch plus draft PR are
 * supported in v1. Rebase, forks, other hosts and other operations fail closed.
 * Text fields are plain text; consumers must not interpret them as HTML or shell.
 * canonical_json ends in LF; sha256 covers exactly its UTF-8 bytes, excluding the
 * digest envelope. Branch identity binds the version, full binding and PR text.
 * Evidence changes may change plan bytes but do not create another branch intent.
 */
export const PLANNER_VERSION = 'dalan-publish-plan/1';

const BINDING_KEYS = ['request_id', 'result_receipt', 'artifact_id', 'artifact_sha256',
  'source_base_sha', 'source_repository', 'target_repository', 'target_base_ref',
  'target_base_sha', 'intended_operation'];
const OBSERVATIONS = ['finished', 'accepted', 'applied', 'repository_read_admitted', 'tool_success'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fail = message => { throw new TypeError(message); };
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');

// Copy only data descriptors; toJSON and accessors are never evaluated.
function jsonData(value, ancestors = new Set(), budget = { nodes: 0 }, depth = 0) {
  if (++budget.nodes > 20000 || depth > 24) fail('JSON input exceeds bounds');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > 50000) fail('JSON string exceeds bounds');
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object') fail('plain JSON data required');
  if (ancestors.has(value)) fail('cyclic JSON input');
  const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail('plain JSON data required');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) fail('JSON symbol keys are unsupported');
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!Object.hasOwn(descriptor, 'value') || (!descriptor.enumerable && !(array && key === 'length'))) fail('JSON data descriptors required; no accessors');
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('unsafe JSON key');
  }
  ancestors.add(value);
  let result;
  if (array) {
    const size = descriptors.length.value;
    if (size > 1000 || Object.keys(descriptors).length !== size + 1) fail('dense bounded JSON array required');
    result = [];
    for (let n = 0; n < size; n++) {
      if (!Object.hasOwn(descriptors, n)) fail('dense JSON array required');
      result.push(jsonData(descriptors[n].value, ancestors, budget, depth + 1));
    }
  } else {
    result = {};
    for (const key of Object.keys(descriptors).sort(compare)) {
      result[key] = jsonData(descriptors[key].value, ancestors, budget, depth + 1);
    }
  }
  ancestors.delete(value);
  return result;
}

function shape(value, required, optional, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}: object required`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${label}.${key}: required`);
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) fail(`${label}: unknown field ${key}`);
  return value;
}

function matches(value, pattern, label, maximum = 256) {
  if (typeof value !== 'string' || value.length > maximum || !pattern.test(value)) fail(`${label}: invalid value`);
  return value;
}

const id = (value, label) => matches(value, /^[A-Za-z0-9][A-Za-z0-9_-]*$/, label, 128);
const commit = (value, label) => matches(value, /^[a-f0-9]{40}$/, label, 40);
const digest = (value, label) => matches(value, /^[a-f0-9]{64}$/, label, 64);

function repository(value, label) {
  shape(value, ['host', 'id', 'owner_id', 'owner', 'name'], [], label);
  if (value.host !== 'github.com') fail(`${label}.host: unsupported host; URLs are not accepted`);
  matches(value.id, /^[1-9][0-9]*$/, `${label}.id`, 32);
  matches(value.owner_id, /^[1-9][0-9]*$/, `${label}.owner_id`, 32);
  matches(value.owner, /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/, `${label}.owner`, 39);
  matches(value.name, /^[A-Za-z0-9][A-Za-z0-9_.-]*$/, `${label}.name`, 100);
  if (value.owner.includes('--') || value.name.includes('..') || value.name.endsWith('.') || /\.git$/i.test(value.name)) fail(`${label}: traversal-like name`);
  return value;
}

function baseRef(value, label) {
  matches(value, /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/, label, 240);
  if (value.includes('..') || value.endsWith('.') || value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) fail(`${label}: invalid ref`);
  return value;
}

function binding(value, label) {
  shape(value, BINDING_KEYS, [], label);
  for (const key of ['request_id', 'result_receipt', 'artifact_id']) id(value[key], `${label}.${key}`);
  digest(value.artifact_sha256, `${label}.artifact_sha256`);
  commit(value.source_base_sha, `${label}.source_base_sha`);
  commit(value.target_base_sha, `${label}.target_base_sha`);
  repository(value.source_repository, `${label}.source_repository`);
  repository(value.target_repository, `${label}.target_repository`);
  baseRef(value.target_base_ref, `${label}.target_base_ref`);
  if (value.intended_operation !== 'create-branch-and-draft-pr') fail(`${label}: unsupported intended operation`);
  return value;
}

function setOfIds(value, label) {
  if (!Array.isArray(value) || value.length > 128) fail(`${label}: bounded array required`);
  const result = value.map(item => id(item, label)).sort(compare);
  if (new Set(result).size !== result.length) fail(`${label}: duplicate value`);
  return result;
}

function text(value, label, maximum, multiline) {
  if (typeof value !== 'string' || value.length > maximum || (!multiline && !value.trim())) fail(`${label}: invalid text`);
  const controls = multiline ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/ : /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
  if (controls.test(value) || !value.isWellFormed()) fail(`${label}: unsafe text controls`);
  return value;
}

function canonical(value) {
  const sort = item => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort(compare).map(key => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(value)).replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n';
}

function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}

// Human-readable literal text, deliberately not Markdown, HTML or shell quoting.
function literal(value) {
  return JSON.stringify(value).replace(/[<>&`$\[\]()*_#!|~@]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function evidence(candidate, selection, bound) {
  const required = setOfIds(selection.required_checks ?? [], 'selection.required_checks');
  const selectedReceipts = setOfIds(selection.verified_receipts ?? [], 'selection.verified_receipts');
  const raw = candidate.checks ?? [];
  if (!Array.isArray(raw) || raw.length > 128) fail('candidate.checks: bounded array required');
  const blockers = [], checks = [], ids = new Set(), receipts = new Set();
  const block = (code, check_id = null) => blockers.push({ code, check_id });
  if (candidate.artifact_sealed !== true) block('artifact_not_sealed');
  if (required.length === 0) block('required_check_policy_missing');
  for (const rawCheck of raw) {
    shape(rawCheck, ['check_id', 'status'], ['receipt_id', 'provenance', 'binding'], 'check');
    const check_id = id(rawCheck.check_id, 'check.check_id');
    if (ids.has(check_id)) fail('duplicate check_id');
    ids.add(check_id);
    if (!['passed', 'failed', 'skipped', 'pending'].includes(rawCheck.status)) fail('check.status: invalid status');
    const receipt_id = rawCheck.receipt_id == null ? null : id(rawCheck.receipt_id, 'check.receipt_id');
    if (receipt_id && receipts.has(receipt_id)) fail('duplicate evidence receipt');
    if (receipt_id) receipts.add(receipt_id);
    const provenance = rawCheck.provenance ?? null;
    if (provenance) {
      shape(provenance, ['kind', 'actor_id'], [], 'check.provenance');
      id(provenance.actor_id, 'check.provenance.actor_id');
      if (!['owner-verified', 'worker-attested', 'tool-reported'].includes(provenance.kind)) fail('check.provenance: invalid kind');
    }
    const checkBinding = rawCheck.binding == null ? null : binding(rawCheck.binding, 'check.binding');
    if (rawCheck.status !== 'passed') block(`check_${rawCheck.status}`, check_id);
    if (checkBinding === null || canonical(checkBinding) !== canonical(bound)) block('check_binding_mismatch', check_id);
    if (provenance?.kind !== 'owner-verified') block('check_not_owner_verified', check_id);
    if (receipt_id === null || !selectedReceipts.includes(receipt_id)) block('check_receipt_not_owner_selected', check_id);
    checks.push({ check_id, receipt_id, status: rawCheck.status, provenance, binding: checkBinding });
  }
  for (const checkId of required) if (!ids.has(checkId)) block('required_check_missing', checkId);
  for (const receipt of selectedReceipts) if (!receipts.has(receipt)) block('selected_receipt_missing', receipt);
  checks.sort((a, b) => compare(a.check_id, b.check_id));
  blockers.sort((a, b) => compare(a.check_id ?? '', b.check_id ?? '') || compare(a.code, b.code));
  return {
    status: blockers.length ? 'blocked' : 'owner-evidence-satisfied',
    independently_verified: false,
    basis: 'Owner-selected receipts and supplied provenance only; the planner does not authenticate or run checks.',
    required_checks: required, owner_selected_receipts: selectedReceipts, checks, blockers,
  };
}

export function createPublicationPlan(input) {
  const data = jsonData(input);
  shape(data, ['selection', 'candidate', 'presentation'], [], 'input');
  shape(data.selection, ['binding'], ['required_checks', 'verified_receipts'], 'selection');
  shape(data.candidate, ['binding'], ['checks', 'artifact_sealed', 'observations'], 'candidate');
  shape(data.presentation, ['title', 'body'], [], 'presentation');
  const selected = binding(data.selection.binding, 'selection.binding');
  const supplied = binding(data.candidate.binding, 'candidate.binding');
  if (canonical(selected) !== canonical(supplied)) fail('selection/candidate binding mismatch');
  if (canonical(selected.source_repository) !== canonical(selected.target_repository)) fail('same repository required; no implicit fork');
  if (selected.source_base_sha !== selected.target_base_sha) fail('source/target base mismatch; no implicit rebase');
  if (data.candidate.artifact_sealed !== undefined && typeof data.candidate.artifact_sealed !== 'boolean') fail('candidate.artifact_sealed: boolean required');
  const observations = data.candidate.observations ?? {};
  shape(observations, [], OBSERVATIONS, 'candidate.observations');
  for (const value of Object.values(observations)) if (typeof value !== 'boolean') fail('observation: boolean required');
  const presentation = {
    title: text(data.presentation.title, 'presentation.title', 200, false),
    body: text(data.presentation.body, 'presentation.body', 20000, true),
  };
  const intentDigest = hash(canonical({ planner_version: PLANNER_VERSION, binding: selected, presentation }));
  const branchName = `dalan/plan-${intentDigest}`;
  const branchRef = `refs/heads/${branchName}`;
  if (selected.target_base_ref === branchRef) fail('proposed branch must differ from target base ref');
  const verification = evidence(data.candidate, data.selection, selected);
  const plan = {
    schema_version: 1, planner_version: PLANNER_VERSION, mode: 'dry-run', authorized_to_publish: false,
    execution: 'not-executed', receipt_kind: 'plan-only', intent_sha256: intentDigest,
    binding: selected, observations,
    branch: { name: branchName, ref: branchRef, source_base_sha: selected.source_base_sha,
      artifact_id: selected.artifact_id, artifact_sha256: selected.artifact_sha256,
      resulting_commit_sha: null, existence: 'not-checked', update_existing: false },
    pull_request: { repository: selected.target_repository, base_ref: selected.target_base_ref,
      base_sha: selected.target_base_sha, head_ref: branchRef, draft: true, content_format: 'plain-text',
      title_text: presentation.title, body_text: presentation.body },
    verification,
    limitations: [
      'This is a plan, not publication authority or an executed-write receipt.',
      'No patch bytes, resulting commit, remote ref freshness or branch availability were checked.',
      'A human must review the exact artifact and current target, obtain separate publication authority, and create any branch or draft PR independently.',
      'Acceptance, application, finish, read admission and tool success grant no publication authority.',
    ],
  };
  const canonical_json = canonical(plan);
  const explanation = [
    'DRY RUN ONLY — not authorized to publish; nothing executed.',
    `Repository: ${literal(`${selected.target_repository.host}/${selected.target_repository.owner}/${selected.target_repository.name}`)} (ID ${selected.target_repository.id}).`,
    `Proposed branch: ${literal(branchRef)}; target: ${literal(selected.target_base_ref)} at ${selected.target_base_sha}.`,
    `Artifact: ${literal(selected.artifact_id)} SHA-256 ${selected.artifact_sha256}; result: ${literal(selected.result_receipt)}.`,
    `Draft PR title (literal text): ${literal(presentation.title)}`,
    `Draft PR body (literal text): ${literal(presentation.body)}`,
    `Evidence: ${verification.status}. ${verification.basis}`,
    ...verification.blockers.map(item => `Blocker: ${item.code}${item.check_id ? ` (${literal(item.check_id)})` : ''}.`),
    ...plan.limitations,
  ].join('\n') + '\n';
  return frozen({ plan, canonical_json, sha256: hash(canonical_json), explanation });
}
