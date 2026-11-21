import assert from 'node:assert/strict';
import test from 'node:test';
import {decide} from '../transitions.mjs';

const context = {now: 1000, maxLeaseMs: 60_000};
const renew = (expectedRevision, leaseMs) => ({expectedRevision, operation: 'renew', args: {leaseMs}});
const revision = {revision: 7};
const hasCode = code => error => error.code === code && error.message === code;

test('a stale revision wins before any renewal effect', () => {
  assert.throws(() => decide(revision, renew(6, 1), context), hasCode('revision_conflict'));
});

test('both inclusive duration bounds emit the exact revision effect and deadline', () => {
  for (const leaseMs of [1, context.maxLeaseMs]) {
    assert.deepEqual(decide(revision, renew(7, leaseMs), context), {
      events: [],
      effects: [{type: 'advance_revision', expectedRevision: 7}],
      leaseUntil: context.now + leaseMs,
    });
  }
});

test('invalid duration and deadline overflow cannot produce an effect', () => {
  for (const leaseMs of [0, context.maxLeaseMs + 1, 1.5, '1', undefined]) {
    assert.throws(() => decide(revision, renew(7, leaseMs), context), hasCode('invalid_lease'));
  }
  const atBoundary = {...context, now: Number.MAX_SAFE_INTEGER - 1};
  assert.deepEqual(decide(revision, renew(7, 1), atBoundary), {
    events: [],
    effects: [{type: 'advance_revision', expectedRevision: 7}],
    leaseUntil: Number.MAX_SAFE_INTEGER,
  });
  assert.throws(() => decide(revision, renew(7, 2), atBoundary), hasCode('invalid_lease'));
});

test('revision exhaustion refuses renewal even with a valid duration', () => {
  const exhausted = Number.MAX_SAFE_INTEGER;
  assert.throws(() => decide({revision: exhausted}, renew(exhausted, 1), context), hasCode('invalid_revision'));
});
