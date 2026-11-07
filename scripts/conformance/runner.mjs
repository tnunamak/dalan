#!/usr/bin/env node
// Job Protocol Fixture Profile v0 trace runner. Usage:
//   node scripts/conformance/runner.mjs [--json] [--out FILE] [--traces T01,T05] [--clock-scale N] [--no-variants] [--keep-home]
// Exit status: 0 only if every trace passes and every required fault and race variant passes or holds safety; 1 otherwise.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DotBridgeAdapter, ERROR_MAP } from './adapter-dot-bridge.mjs';
import { ADAPTER_CONTRACT_VERSION, EXPECTED_TRACE_IDS, FIXTURE_PROFILE_VERSION, NATIVE_CONTRACT_VERSION, validateProfileCorpus } from './profile-version.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.resolve(here, '../..');
const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const wantJson = flag('--json');
const only = opt('--traces')?.split(',');
const outFile = opt('--out');

const canon = v => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
// Diagnostic only (never counts toward PASS): the step differs from the golden only by journal granularity, i.e. revision/seq/id
// numbering, lease times, and domain events the bridge never journals. Used to separate "concept absent" from semantic differences.
const UNJOURNALED = new Set(['uploaded', 'sealed', 'waiter_registered', 'renewed', 'answered', 'consumed', 'stop_observed']);
const stripNum = v => Array.isArray(v) ? v.map(stripNum) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !['revision', 'seq', 'leaseUntil'].includes(k)).map(([k, x]) => [k, stripNum(x)])) : v;
const semEvents = (evs, dropUnjournaled) => stripNum(evs.filter(e => !(dropUnjournaled && UNJOURNALED.has(e.type))).map(({ id, ...e }) => e));
const semEventPointer = v => JSON.parse(JSON.stringify(v, (k, x) => (k === 'event' ? '*' : x)));
export const semanticMatch = (exp, act) => same(stripNum(semEventPointer(exp.reply)), stripNum(semEventPointer(act.reply))) && same(semEvents(exp.events, true), semEvents(act.events, false));
export const REQUIRED_VARIANTS = ['V01-T05-concurrent-claims', 'V02-T09-T28-lost-reply-replay', 'V03-T21-T22-cancel-finish-race', 'V04-T23-T24-crash-barriers', 'V05-T30-T31-waiter-vs-finish', 'V06-T34-T35-delivery-uncertainty', 'V07-inbox-ack-crash', 'V08-deadline-boundaries-and-sweep-races'];
export const EXPECTED_TRACE_COUNT = EXPECTED_TRACE_IDS.length;
export function evaluateGate({ manifestTraceCount, manifestIds, loadedIds, selectedIds, results, variants }) {
  const errors = [];
  const unique = xs => new Set(xs).size === xs.length;
  if (manifestTraceCount !== EXPECTED_TRACE_COUNT || manifestTraceCount === 0) errors.push(`empty or unexpected conformance corpus: expected ${EXPECTED_TRACE_COUNT} traces`);
  if (manifestIds.length !== EXPECTED_TRACE_IDS.length || EXPECTED_TRACE_IDS.some(id => !manifestIds.includes(id))) errors.push('fixture IDs do not match expected profile corpus');
  if (manifestIds.length !== manifestTraceCount || loadedIds.length !== manifestTraceCount || !unique(manifestIds) || !unique(loadedIds) || manifestIds.some(id => !loadedIds.includes(id))) errors.push(`manifest coverage mismatch: expected ${manifestTraceCount} unique fixtures`);
  if (selectedIds.length !== manifestTraceCount || !unique(selectedIds) || manifestIds.some(id => !selectedIds.includes(id))) errors.push(`incomplete trace selection: expected all ${manifestTraceCount} manifest traces`);
  const resultIds = results.map(r => r.id);
  if (resultIds.length !== manifestTraceCount || !unique(resultIds) || manifestIds.some(id => !resultIds.includes(id))) errors.push(`incomplete trace results: expected one result for each of ${manifestTraceCount} manifest traces`);
  if (results.some(r => r.status !== 'PASS' || (r.invariantViolations ?? 0) !== 0)) errors.push('trace or storage invariant failure');
  if (!variants) errors.push('variant evidence missing');
  else {
    const variantIds = variants.map(v => v.id);
    if (!unique(variantIds) || REQUIRED_VARIANTS.some(id => !variantIds.includes(id)) || variantIds.some(id => !REQUIRED_VARIANTS.includes(id))) errors.push('variant evidence incomplete or unrecognized');
    if (variants.some(v => !['PASS', 'SAFETY_HOLDS_NOT_EXACT'].includes(v.status))) errors.push('variant failure or non-run evidence');
  }
  return { exitStatus: errors.length ? 1 : 0, errors };
}
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();

const fixturesDir = path.join(here, 'fixtures');
if (!fs.existsSync(path.join(fixturesDir, 'MANIFEST.json'))) { console.error('fixtures missing: pass the source document to extract-fixtures.mjs or set CONFORMANCE_DOC'); process.exit(2); }
const manifest = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'MANIFEST.json'), 'utf8'));
  const allTraces = fs.readdirSync(path.join(fixturesDir, 'traces')).sort().map(f => JSON.parse(fs.readFileSync(path.join(fixturesDir, 'traces', f), 'utf8')));
  const traces = allTraces.filter(t => !only || only.includes(t.id));
const schemaText = Object.fromEntries(['command', 'event', 'reply'].map(name => [name, fs.readFileSync(path.join(fixturesDir, `${name}.schema.json`), 'utf8')]));
const corpusErrors = validateProfileCorpus({ manifest, schemaText, traces: allTraces });
if (corpusErrors.length) throw new Error(`invalid conformance corpus: ${corpusErrors.join('; ')}`);
const classificationFile = path.join(here, 'classification.json');
const classification = fs.existsSync(classificationFile) ? JSON.parse(fs.readFileSync(classificationFile, 'utf8')) : {};

export async function runTrace(adapter, trace) {
  await adapter.reset();
  const steps = [];
  for (const [index, step] of trace.steps.entries()) {
    if (step.control) {
      const actual = await adapter.control(step.control);
      steps.push({ index, kind: 'control', input: step.control, expected: step.expect, actual, status: same(actual, step.expect) ? 'PASS' : 'FAIL' });
      continue;
    }
    const r = await adapter.invoke(step.input.principal, step.input.command);
    const invariants = adapter.invariants(step.input.command.job);
    const violated = invariants.filter(i => i.status === 'violated');
    const rec = { index, kind: 'command', input: step.input, expected: step.expect, native: r.native, ignoredFixtureFields: r.ignored, invariants };
    if (r.status === 'UNSUPPORTED') Object.assign(rec, { status: 'UNSUPPORTED', reason: r.reason, actual: null });
    else {
      const actual = { reply: r.reply, events: r.events };
      const replyOk = same(actual.reply, step.expect.reply), eventsOk = same(actual.events, step.expect.events);
      Object.assign(rec, { status: replyOk && eventsOk && !violated.length ? 'PASS' : 'FAIL', replyMatches: replyOk, eventsMatch: eventsOk, semanticMatch: replyOk && eventsOk ? true : semanticMatch(step.expect, actual), actual, errorMapped: r.errorMapped ?? null, nativeError: r.nativeError ?? null });
    }
    if (violated.length) rec.invariantViolations = violated;
    steps.push(rec);
  }
  const serverLogSha256 = adapter.logDigest();
  const first = steps.find(s => s.status !== 'PASS');
  const status = !first ? 'PASS' : first.status === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'FAIL';
  const unsupportedSteps = steps.filter(s => s.status === 'UNSUPPORTED').length;
  const failedSteps = steps.filter(s => s.status === 'FAIL').length;
  const semanticDivergences = steps.filter(s => s.status === 'FAIL' && s.semanticMatch === false).map(s => s.index);
  return { id: trace.id, name: trace.name, invariant: trace.invariant, status, firstDivergingStep: first?.index ?? null, semanticDivergences, failedSteps, unsupportedSteps, totalSteps: steps.length, serverLogSha256, invariantViolations: steps.flatMap(s => s.invariantViolations ?? []).length, steps };
}

async function runAll(scale) {
  const adapter = new DotBridgeAdapter({ clockScale: scale, keepHome: flag('--keep-home') });
  await adapter.init();
  const results = [];
  try {
    for (const t of traces) {
      const r = await runTrace(adapter, t); Object.assign(r, classification[t.id] ?? { category: r.status === 'PASS' ? null : 'UNCLASSIFIED' });
      results.push(r); if (!wantJson) process.stderr.write(`[scale ${scale}] ${t.id} ${r.status}\n`);
    }
  } finally { await adapter.close(); }
  const counts = { PASS: 0, FAIL: 0, UNSUPPORTED: 0 }; const byCategory = {};
  for (const r of results) { counts[r.status]++; if (r.status !== 'PASS') { const k = `${r.status}:${r.category}`; byCategory[k] = (byCategory[k] ?? 0) + 1; } }
  counts.tracesWithUnsupportedSteps = results.filter(r => r.unsupportedSteps > 0).length;
  return { clockScale: scale, info: adapter.info(), counts, byCategory, results };
}

async function main() {
  const started = new Date().toISOString();
  // Official result: clock scale 1 (the bridge's 60 s lease floor is NOT normalized). Diagnostic: scale 600 maps fixture lease 100 to
  // the bridge's 60000 ms so that behavior after the claim step becomes observable. Never counted toward conformance.
  const primaryScale = Number(opt('--clock-scale') ?? 1);
  const strict = await runAll(primaryScale);
  const scaled = primaryScale === 1 && !flag('--no-diagnostic') ? await runAll(600) : null;
  let variants = null;
  if (!flag('--no-variants') && !only) { const { runVariants } = await import('./variants.mjs'); variants = (await runVariants({ clockScale: 1 })).map(({ fn, ...v }) => v); }
  const commit = git('rev-parse', 'HEAD');
  const productCommit = git('log', '-1', '--format=%H', '--', 'src', 'bin'); // last commit that touched product code
  const bundle = {
    product: 'dot-bridge', productCommit, productHead: commit, productDirtyInSrc: git('status', '--porcelain', '--', 'src', 'bin') !== '',
    adapterCommit: commit, adapterDirty: git('status', '--porcelain', '--', 'scripts/conformance') !== '', adapterPaths: ['scripts/conformance/adapter-dot-bridge.mjs', 'scripts/conformance/clock-preload.mjs'],
    profile: 'Job Protocol Fixture Profile v0', profileVersion: FIXTURE_PROFILE_VERSION, nativeContractVersion: NATIVE_CONTRACT_VERSION, adapterContractVersion: ADAPTER_CONTRACT_VERSION, fixtureDoc: manifest.doc, fixtureSha256: manifest.docSha256,
    schemaSha256: Object.fromEntries(['command', 'event', 'reply'].map(n => [n, sha(fs.readFileSync(path.join(fixturesDir, `${n}.schema.json`)))])),
    ...strict.info,
    clockNormalization: `official run: fixture time t -> server time BASE+t ms (BASE = wall clock at reset, frozen, Date patched by clock-preload.mjs); leaseUntil = lease_expires_at-BASE. Diagnostic run: BASE+600*t so that the bridge's 60000 ms lease equals the fixture's 100.`,
    idNormalization: { job: 'J -> req_fixture_J', claim: 'native claim_id -> C<n> by first appearance', receipt: 'native receipt_id -> R:<job>:<n>', artifact: 'A -> art_fixture_A', delivery: 'D:<waiter> (adapter-named; the bridge has no delivery ids)' },
    errorMap: ERROR_MAP.map(([re, code]) => `${re.source} -> ${code}`),
    startedAt: started, finishedAt: new Date().toISOString(),
    counts: strict.counts, byCategory: strict.byCategory, results: strict.results,
    diagnosticLeaseScaled: scaled && { clockScale: scaled.clockScale, counts: scaled.counts, byCategory: scaled.byCategory, results: scaled.results },
    variants,
    gate: evaluateGate({ manifestTraceCount: manifest.traces, manifestIds: allTraces.map(t => t.id), loadedIds: allTraces.map(t => t.id), selectedIds: traces.map(t => t.id), results: strict.results, variants }),
  };
  bundle.exitStatus = bundle.gate.exitStatus; bundle.gateErrors = bundle.gate.errors;
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(bundle, null, 1) + '\n');
  const sc = new Map((scaled?.results ?? []).map(r => [r.id, r]));
  const table = strict.results.map(r => { const d = sc.get(r.id); return `${r.id}  ${r.status.padEnd(11)} ${(r.category ?? '-').padEnd(2)} first@${String(r.firstDivergingStep ?? '-').padEnd(2)} fail=${String(r.failedSteps).padEnd(2)} unsup=${String(r.unsupportedSteps).padEnd(2)} inv=${r.invariantViolations}  scaled:${(d?.status ?? '-').padEnd(11)} sem@${d?.semanticDivergences.length ? d.semanticDivergences[0] : '-'}  ${r.name}`; }).join('\n');
  if (wantJson) console.log(JSON.stringify({ level: bundle.level, counts: strict.counts, byCategory: strict.byCategory, diagnosticLeaseScaled: scaled && { counts: scaled.counts }, traces: strict.results.map(({ steps, ...r }) => r), variants: variants?.map(v => ({ id: v.id, status: v.status, level: v.level })), gateErrors: bundle.gateErrors, exitStatus: bundle.exitStatus }, null, 1));
  else console.log(`${table}\n\nOFFICIAL  PASS ${strict.counts.PASS}  FAIL ${strict.counts.FAIL}  UNSUPPORTED ${strict.counts.UNSUPPORTED} (first diverging step), ${strict.counts.tracesWithUnsupportedSteps} traces contain an UNSUPPORTED step  (${bundle.level}, fixture sha256 ${manifest.docSha256.slice(0, 12)}, commit ${commit.slice(0, 9)})${scaled ? `\nDIAGNOSTIC lease-scaled x600  PASS ${scaled.counts.PASS}  FAIL ${scaled.counts.FAIL}  UNSUPPORTED ${scaled.counts.UNSUPPORTED}, ${scaled.counts.tracesWithUnsupportedSteps} traces contain an UNSUPPORTED step` : ''}${variants ? `\nVARIANTS ${variants.map(v => `${v.id.split('-')[0]}:${v.status}`).join(' ')}` : ''}${bundle.gateErrors.length ? `\nGATE FAILURE: ${bundle.gateErrors.join('; ')}` : ''}`);
  process.exit(bundle.exitStatus);
}
import { createHash } from 'node:crypto';
function sha(b) { return createHash('sha256').update(b).digest('hex'); }
if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(3); });
