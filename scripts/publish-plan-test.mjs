import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

// No server, store, workspace, credential resolver or live adapter is imported.
// Run with: node --test scripts/publish-plan-test.mjs
const moduleUrl = new URL('../src/publish-plan.mjs', import.meta.url);
const source = readFileSync(moduleUrl, 'utf8');
function assertInertModule() {
  const declaration = "import { createHash } from 'node:crypto';";
  assert.equal(source.split(declaration).length, 2);
  const rest = source.replace(declaration, '');
  assert.doesNotMatch(rest, /\b(?:import|require|fetch|XMLHttpRequest|WebSocket|process|Deno|Bun|eval|Function)\b/);
  assert.doesNotMatch(rest, /\b(?:globalThis|setTimeout|setInterval)\b/);
  assert.doesNotMatch(rest, /node:(?:fs|net|http|https|http2|tls|dns|child_process|worker_threads|module|vm)/);
  assert.doesNotMatch(rest.replace(/^export (?:const PLANNER_VERSION =|function createPublicationPlan\()/gm, ''), /\bexport\b/);
}
// Run the guard before evaluation; a forbidden dependency must not execute first.
assertInertModule();
const { createPublicationPlan, PLANNER_VERSION } = await import(moduleUrl.href);
const clone = value => JSON.parse(JSON.stringify(value));
const sha = value => createHash('sha256').update(value).digest('hex');

function fixture() {
  const repository = { host: 'github.com', id: '1234', owner_id: '5678', owner: 'example-owner', name: 'dalan' };
  const binding = {
    request_id: 'request-1', result_receipt: 'report_one', artifact_id: 'artifact_one',
    artifact_sha256: 'a'.repeat(64), source_base_sha: 'b'.repeat(40),
    source_repository: repository, target_repository: clone(repository),
    target_base_ref: 'refs/heads/main', target_base_sha: 'b'.repeat(40),
    intended_operation: 'create-branch-and-draft-pr',
  };
  return {
    selection: { binding: clone(binding), required_checks: ['unit'], verified_receipts: ['check_one'] },
    candidate: {
      binding: clone(binding), artifact_sealed: true,
      checks: [{ check_id: 'unit', receipt_id: 'check_one', status: 'passed',
        provenance: { kind: 'owner-verified', actor_id: 'owner_one' }, binding: clone(binding) }],
      observations: { finished: true, accepted: false, applied: false, repository_read_admitted: false, tool_success: false },
    },
    presentation: { title: 'Fix deterministic planning', body: 'Owner-selected result for review.' },
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

function allBindings(input, mutate) {
  for (const item of [input.selection.binding, input.candidate.binding, ...input.candidate.checks.map(check => check.binding)]) mutate(item);
}

function reversedKeys(value) {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversedKeys(v)]));
  return value;
}

test('D1: sole named import is inert hashing; no dynamic imports or effect entry points', () => {
  assertInertModule();
});

test('D1: valid, invalid and repeated accepted plans invoke zero capability spies', () => {
  const attempts = [];
  const trap = name => new Proxy(function () {}, {
    get() { attempts.push(name); throw new Error(name); },
    apply() { attempts.push(name); throw new Error(name); },
    construct() { attempts.push(name); throw new Error(name); },
  });
  const sandbox = { createHash };
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'process', 'require', 'Deno', 'Bun',
    'resolveCredentials', 'networkMutation', 'spawn', 'exec', 'writeFile', 'repositoryMutation', 'setTimeout', 'setInterval']) {
    sandbox[name] = trap(name);
  }
  // Evaluate the same implementation, replacing only its one approved import and exports.
  const body = source.replace("import { createHash } from 'node:crypto';", '').replace(/^export /gm, '');
  const input = fixture(); input.candidate.observations.accepted = true;
  const exercise = `\nconst input = JSON.parse(${JSON.stringify(JSON.stringify(input))});
    const first = createPublicationPlan(input);
    for (let n = 0; n < 4; n++) {
      if (createPublicationPlan(input).canonical_json !== first.canonical_json) throw new Error('nondeterministic');
    }
    input.candidate.binding.artifact_sha256 = 'f'.repeat(64);
    let rejected = false;
    try { createPublicationPlan(input); } catch { rejected = true; }
    if (!rejected) throw new Error('mismatch accepted');
    first.canonical_json;`;
  assert.match(runInNewContext(body + exercise, sandbox, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }), /dry-run/);
  assert.deepEqual(attempts, []);
});

test('D2: every immutable binding is compared; no independently changed identity is accepted', () => {
  const mutations = [
    b => { b.request_id = 'request-2'; }, b => { b.result_receipt = 'report_two'; },
    b => { b.artifact_id = 'artifact_two'; }, b => { b.artifact_sha256 = 'c'.repeat(64); },
    b => { b.source_base_sha = 'd'.repeat(40); }, b => { b.target_base_sha = 'e'.repeat(40); },
    b => { b.target_base_ref = 'refs/heads/release'; },
    b => { b.target_repository.id = '9999'; }, b => { b.target_repository.owner_id = '9999'; },
    b => { b.target_repository.owner = 'someone'; }, b => { b.target_repository.name = 'elsewhere'; },
    b => { b.source_repository.id = '9999'; },
  ];
  for (const mutate of mutations) for (const side of ['selection', 'candidate']) {
    const input = fixture(); mutate(input[side].binding);
    assert.throws(() => createPublicationPlan(input), /mismatch|same repository|base/i);
  }
  for (const key of Object.keys(fixture().selection.binding)) {
    const input = fixture(); delete input.selection.binding[key];
    assert.throws(() => createPublicationPlan(input), /required|missing/i, key);
  }
  const changedBoth = fixture();
  for (const side of ['selection', 'candidate']) changedBoth[side].binding.artifact_sha256 = 'f'.repeat(64);
  assert.notEqual(createPublicationPlan(changedBoth).plan.branch.ref, createPublicationPlan(fixture()).plan.branch.ref);
  assert.equal(createPublicationPlan(changedBoth).plan.verification.status, 'blocked');
});

test('D2: source/target exact base and repository are required; no implicit rebase or fork', () => {
  for (const mutate of [b => { b.target_base_sha = 'f'.repeat(40); }, b => { b.target_repository.id = '9876'; }]) {
    const input = fixture(); mutate(input.selection.binding); mutate(input.candidate.binding);
    assert.throws(() => createPublicationPlan(input), /same repository|base/i);
  }
  for (const [key, value] of [['source_base_sha', 'abc'], ['target_base_sha', 'G'.repeat(40)], ['artifact_sha256', 'a'.repeat(63)], ['result_receipt', '../receipt']]) {
    const input = fixture(); allBindings(input, binding => { binding[key] = value; });
    assert.throws(() => createPublicationPlan(input));
  }
});

test('D3: canonical bytes, digest, branch and plan identity are deterministic and mutation-free', () => {
  const input = deepFreeze(fixture()); const before = JSON.stringify(input);
  const first = createPublicationPlan(input);
  assert.equal(first.sha256, sha(first.canonical_json));
  assert.equal(first.canonical_json, JSON.stringify(JSON.parse(first.canonical_json)) + '\n');
  assert.equal(first.plan.planner_version, PLANNER_VERSION);
  for (let n = 0; n < 5; n++) assert.deepEqual(createPublicationPlan(input), first);
  assert.deepEqual(createPublicationPlan(reversedKeys(input)), first);
  assert.equal(JSON.stringify(input), before);
  assert.ok(Object.isFrozen(first.plan));
  assert.ok(Object.isFrozen(first.plan.binding.target_repository));
  assert.throws(() => { first.plan.authorized_to_publish = true; }, TypeError);
  assert.equal(first.plan.execution, 'not-executed');
  assert.equal(first.plan.receipt_kind, 'plan-only');
});

test('D3: unordered check sets normalize without locale, time or randomness', () => {
  const input = fixture();
  input.selection.required_checks.push('lint'); input.selection.verified_receipts.push('check_two');
  input.candidate.checks.push({ ...clone(input.candidate.checks[0]), check_id: 'lint', receipt_id: 'check_two' });
  const first = createPublicationPlan(input);
  input.selection.required_checks.reverse(); input.selection.verified_receipts.reverse(); input.candidate.checks.reverse();
  assert.deepEqual(createPublicationPlan(input), first);
  assert.doesNotMatch(source, /\bDate\b|Math\.random|randomUUID|localeCompare/);
});

test('D3: evidence or lifecycle changes do not mint a fresh branch intent; presentation changes do', () => {
  const input = fixture(), first = createPublicationPlan(input);
  input.candidate.observations.accepted = true;
  input.candidate.checks[0].status = 'failed';
  const later = createPublicationPlan(input);
  assert.equal(later.plan.branch.ref, first.plan.branch.ref);
  assert.equal(later.plan.intent_sha256, first.plan.intent_sha256);
  assert.notEqual(later.sha256, first.sha256);
  input.presentation.title = 'A distinct proposal';
  assert.notEqual(createPublicationPlan(input).plan.branch.ref, first.plan.branch.ref);
});

test('D4: reject arbitrary URLs, credentials, unsupported hosts and traversal-like repository identities', () => {
  const invalid = [
    ['host', 'https://github.com'], ['host', 'github.com:443'], ['host', 'evil.example'],
    ['host', 'user:secret@github.com'], ['owner', '../owner'], ['owner', 'user@evil'],
    ['name', '../repo'], ['name', 'repo.git'], ['name', 'repo..name'], ['name', 'repo/name'],
    ['name', 'https://github.com/o/r'], ['id', '0'], ['owner_id', '01'],
    ['owner', 'owner\n'], ['name', 'repo\n'], ['id', '123\n'],
  ];
  for (const [key, value] of invalid) {
    const input = fixture();
    allBindings(input, binding => { binding.source_repository[key] = value; binding.target_repository[key] = value; });
    assert.throws(() => createPublicationPlan(input), undefined, `${key}: ${value}`);
  }
  const extra = fixture();
  const credentialUrl = 'https://' + ['fixture-user', 'fixture-password'].join(':') + '@invalid.example/repo';
  allBindings(extra, binding => { binding.target_repository.url = credentialUrl; });
  assert.throws(() => createPublicationPlan(extra), /unknown/i);
});

test('D4: only explicit valid heads refs are accepted', () => {
  const invalid = ['main', 'HEAD', 'refs/tags/v1', 'refs/heads/../main', 'refs/heads/a..b', 'refs/heads/a.lock',
    'refs/heads/a//b', 'refs/heads/.hidden', 'refs/heads/a.', 'refs/heads/a@{b}', 'refs/heads/a b',
    'refs/heads/a\\b', 'refs/heads/a\nb', 'refs/heads/a~1', 'refs/heads/a:b', 'refs/heads/a?b',
    'refs/heads/a[b', 'refs/heads/-bad', 'refs/heads/a/', 'refs/heads/a\u0000', 'refs/heads/main\n'];
  for (const ref of invalid) {
    const input = fixture(); allBindings(input, binding => { binding.target_base_ref = ref; });
    assert.throws(() => createPublicationPlan(input), undefined, ref);
  }
  const input = fixture();
  for (const item of [input.selection.binding, input.candidate.binding, input.candidate.checks[0].binding]) item.target_base_ref = 'refs/heads/release/v1.2';
  assert.equal(createPublicationPlan(input).plan.pull_request.base_ref, 'refs/heads/release/v1.2');
});

test('D4: titles/body stay inert text; readable rendering escapes markup, mentions and shell syntax', () => {
  const input = fixture();
  input.presentation = { title: '<script>bad()</script> @all $(touch nope)', body: '[go](https://evil.example)\n`rm -rf .` & <img src=x>' };
  const result = createPublicationPlan(input);
  assert.equal(result.plan.pull_request.title_text, input.presentation.title);
  assert.equal(result.plan.pull_request.body_text, input.presentation.body);
  assert.equal(result.plan.pull_request.content_format, 'plain-text');
  assert.doesNotMatch(result.explanation, /<script>|@all|\$\(|`rm|\[go\]|<img/);
  assert.doesNotMatch(result.canonical_json, /<script>|<img/);
  assert.equal(Object.hasOwn(result.plan, 'commands'), false);
  for (const title of ['bad\ntitle', 'bad\u001btitle', 'bad\u202etitle']) {
    const bad = fixture(); bad.presentation.title = title; assert.throws(() => createPublicationPlan(bad));
  }
});

test('D4: executable/accessor/cyclic metadata is rejected without invoking its getter', () => {
  let called = false; const input = fixture();
  Object.defineProperty(input.presentation, 'title', { enumerable: true, get() { called = true; throw new Error('getter'); } });
  assert.throws(() => createPublicationPlan(input), /data|accessor|JSON/i);
  assert.equal(called, false);
  const executable = fixture(); executable.presentation.body = () => {};
  assert.throws(() => createPublicationPlan(executable), /JSON/i);
  const cyclic = fixture(); cyclic.presentation.body = cyclic;
  assert.throws(() => createPublicationPlan(cyclic), /cyclic|JSON/i);
});

test('D5: evidence requires passed, exactly bound, separately owner-selected receipts', () => {
  const good = createPublicationPlan(fixture());
  assert.equal(good.plan.verification.status, 'owner-evidence-satisfied');
  assert.equal(good.plan.verification.independently_verified, false);
  assert.match(good.plan.verification.basis, /owner-selected/i);
  for (const mutate of [
    i => { i.candidate.checks = []; },
    i => { i.selection.required_checks = []; },
    i => { i.selection.verified_receipts = []; },
    i => { i.candidate.artifact_sealed = false; },
    i => { i.candidate.checks[0].status = 'failed'; },
    i => { i.candidate.checks[0].status = 'skipped'; },
    i => { i.candidate.checks[0].status = 'pending'; },
    i => { i.candidate.checks[0].provenance.kind = 'worker-attested'; },
    i => { i.candidate.checks[0].provenance.kind = 'tool-reported'; },
    i => { i.candidate.checks[0].binding.artifact_sha256 = 'c'.repeat(64); },
    i => { i.candidate.checks[0].binding.result_receipt = 'report_other'; },
    i => { i.candidate.checks[0].binding.target_base_ref = 'refs/heads/old'; },
    i => { delete i.candidate.checks[0].binding; },
    i => { delete i.candidate.checks[0].receipt_id; },
    i => { delete i.candidate.checks[0].provenance; },
  ]) {
    const input = fixture(); mutate(input); input.candidate.observations.accepted = true;
    const plan = createPublicationPlan(input).plan;
    assert.equal(plan.verification.status, 'blocked'); assert.ok(plan.verification.blockers.length);
    assert.equal(plan.authorized_to_publish, false);
  }
});

test('D5: preserve provenance and reject ambiguous duplicates instead of cherry-picking a pass', () => {
  const input = fixture(); input.candidate.checks[0].provenance.kind = 'worker-attested';
  assert.deepEqual(createPublicationPlan(input).plan.verification.checks[0].provenance, input.candidate.checks[0].provenance);
  input.candidate.checks.push({ ...clone(input.candidate.checks[0]), status: 'failed' });
  assert.throws(() => createPublicationPlan(input), /duplicate/i);
  const duplicatePolicy = fixture(); duplicatePolicy.selection.required_checks.push('unit');
  assert.throws(() => createPublicationPlan(duplicatePolicy), /duplicate/i);
});

test('D5: missing evidence policy is visibly blocked, never silently verified', () => {
  const input = fixture();
  delete input.selection.required_checks; delete input.selection.verified_receipts;
  delete input.candidate.checks; delete input.candidate.artifact_sealed;
  const plan = createPublicationPlan(input).plan;
  assert.equal(plan.verification.status, 'blocked');
  assert.deepEqual(plan.verification.blockers.map(item => item.code), ['artifact_not_sealed', 'required_check_policy_missing']);
  assert.equal(plan.branch.resulting_commit_sha, null);
  assert.equal(plan.branch.existence, 'not-checked');
  assert.equal(plan.branch.update_existing, false);
});

test('D6: lifecycle facts and tool success are never publication authorization', () => {
  for (const observation of Object.keys(fixture().candidate.observations)) {
    const input = fixture(); input.candidate.observations[observation] = true;
    const plan = createPublicationPlan(input).plan;
    assert.equal(plan.authorized_to_publish, false); assert.equal(plan.mode, 'dry-run');
    assert.equal(plan.execution, 'not-executed'); assert.equal(plan.pull_request.draft, true);
  }
  for (const key of ['authorized_to_publish', 'grant', 'token', 'live', 'adapter']) {
    const input = fixture(); input[key] = true;
    assert.throws(() => createPublicationPlan(input), /unknown/i);
  }
  const unsupported = fixture(); allBindings(unsupported, binding => { binding.intended_operation = 'merge'; });
  assert.throws(() => createPublicationPlan(unsupported), /operation/i);
});

test('D7: planning preserves decision/report/artifact input snapshots and creates no restart state', async () => {
  const input = fixture(); input.candidate.observations.accepted = true; input.candidate.observations.applied = true;
  const before = clone(input); deepFreeze(input);
  const first = createPublicationPlan(input);
  assert.deepEqual(input, before);
  // A fresh evaluation has no persisted writer setting, event subscription or receipt ledger.
  const fresh = await import(`${moduleUrl.href}?compatibility-restart`);
  assert.deepEqual(fresh.createPublicationPlan(input), first);
  assert.equal(first.plan.receipt_kind, 'plan-only');
  assert.equal(first.plan.authorized_to_publish, false);
  assert.doesNotMatch(source, /\b(?:Store|migration|sqlite|subscribe|dispatch|adapter|credential|token)\b/i);
  assert.doesNotMatch(source, /(?:server|store)\.mjs/);
  // Existing server/store/manifest files are deliberately not changed or executed by this test.
  // Additive diff review and the existing suite remain the integration evidence.
});
