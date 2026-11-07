#!/usr/bin/env node
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateFdProbeRun } from './lib/sandbox-probe-fd-result.mjs';

const completed = { job: { status: 'completed', error: null }, row: { phase: 'check', exit_code: 0 } };

test('FD probe refuses a missing, failed, empty, or malformed guest result', () => {
  for (const result of [
    completed,
    { ...completed, results: [] },
    { ...completed, results: [{}] },
    { ...completed, results: [{ fds: [] }] },
    { ...completed, results: [{ fds: [{ fd: 700, type: 'other', link: 'pipe:[1]' }, { fd: 700, type: 'other', link: 'pipe:[1]' }] }] },
    { job: { status: 'failed', error: 'cancelled' }, row: { phase: 'check', exit_code: 125 }, results: [{ fds: [{ fd: 700, type: 'other', link: 'pipe:[1]' }] }] },
    { job: completed.job, row: { phase: 'check', exit_code: 7 }, results: [{ fds: [{ fd: 700, type: 'other', link: 'pipe:[1]' }] }] },
  ]) assert.equal(validateFdProbeRun(result).ok, false, JSON.stringify(result));

  const valid = { ...completed, results: [{ fds: [3, 700, 701, 702].map(fd => ({ fd, type: 'other', link: 'pipe:[1]' })) }] };
  assert.deepEqual(validateFdProbeRun(valid), { ok: true, fds: valid.results[0].fds });
});
