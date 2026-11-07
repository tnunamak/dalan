import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { evaluateGate, REQUIRED_VARIANTS } from './runner.mjs';

const ids = Array.from({ length: 42 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`);
const good = { manifestTraceCount: 42, manifestIds: ids, loadedIds: ids, selectedIds: ids, results: ids.map(id => ({ id, status: 'PASS', invariantViolations: 0 })), variants: REQUIRED_VARIANTS.map(id => ({ id, status: 'PASS' })) };
assert.deepEqual(evaluateGate(good), { exitStatus: 0, errors: [] });
function fails(input, message) {
  const result = evaluateGate(input);
  assert.ok(result.errors.includes(message), `expected ${JSON.stringify(result.errors)} to include ${message}`);
  assert.equal(result.exitStatus, 1);
}
fails({ ...good, selectedIds: ids.slice(0, 1), results: good.results.slice(0, 1) }, 'incomplete trace selection: expected all 42 manifest traces');
fails({ ...good, results: [] }, 'incomplete trace results: expected one result for each of 42 manifest traces');
const wrongCorpusIds = ids.map((id, index) => index === 41 ? 'T99' : id);
fails({ ...good, manifestIds: wrongCorpusIds, loadedIds: wrongCorpusIds, selectedIds: wrongCorpusIds, results: good.results.map((r, index) => index === 41 ? { ...r, id: 'T99' } : r) }, 'fixture IDs do not match expected profile corpus');
fails({ ...good, results: ids.map(id => ({ id, status: 'PASS', invariantViolations: id === 'T01' ? 1 : 0 })) }, 'trace or storage invariant failure');
fails({ ...good, variants: null }, 'variant evidence missing');
fails({ ...good, variants: [] }, 'variant evidence incomplete or unrecognized');
fails({ ...good, variants: good.variants.slice(1) }, 'variant evidence incomplete or unrecognized');
fails({ ...good, variants: [...good.variants, { id: 'unexpected', status: 'PASS' }] }, 'variant evidence incomplete or unrecognized');
fails({ manifestTraceCount: 0, manifestIds: [], loadedIds: [], selectedIds: [], results: [], variants: REQUIRED_VARIANTS.map(id => ({ id, status: 'PASS' })) }, 'empty or unexpected conformance corpus: expected 42 traces');
for (const status of ['ERROR', 'SAFETY_VIOLATED', 'NOT_RUN', 'SKIP', 'FAIL', undefined]) {
  fails({ ...good, variants: good.variants.map((v, i) => i ? v : { ...v, status }) }, 'variant failure or non-run evidence');
}

// Exercise the actual CLI: a one-trace subset must fail for both incomplete selection and missing variants.
const cli = spawnSync(process.execPath, ['scripts/conformance/runner.mjs', '--traces', 'T01', '--no-diagnostic'], { encoding: 'utf8', timeout: 120_000 });
assert.match(cli.stdout, /GATE FAILURE: incomplete trace selection: expected all 42 manifest traces/);
assert.match(cli.stdout, /variant evidence missing/);
assert.equal(cli.status, 1, cli.stderr || cli.stdout);
