import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDurableWaiters, migrateDurableWaiters } from '../src/durable-waiters.mjs';

const directory = mkdtempSync(join(tmpdir(), 'durable-waiters-'));
const file = join(directory, 'waiters.sqlite');
let db;

function transaction(action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = action();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function code(expected, action) {
  assert.throws(action, error => error.code === expected, `expected ${expected}`);
}

try {
  db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  transaction(() => migrateDurableWaiters(db));

  let now = 10;
  const nativeEvents = [];
  const ownerAllowed = ({ owner }) => owner === 'owner-1';
  const predicates = {
    terminal: event => event.state === 'finished' || event.state === 'cancelled',
    input: event => event.type === 'answer_added',
  };
  const openComponent = () => createDurableWaiters({
    db,
    authorize: ownerAllowed,
    readEvents: ({ job }) => nativeEvents.filter(event => event.job === job),
    predicates,
    clock: () => now,
  });
  let waiters = openComponent();

  const first = {
    job: 'job-1', owner: 'owner-1', waiter: 'waiter-a', key: 'key-a',
    predicate: 'terminal', afterSeq: 1, expiresAt: 100,
  };
  const second = { ...first, waiter: 'waiter-b', key: 'key-b' };
  assert.deepEqual(transaction(() => waiters.register(first)), first);
  assert.deepEqual(transaction(() => waiters.register(first)), first, 'same key replays the registration');
  code('registration_conflict', () => transaction(() => waiters.register({ ...first, afterSeq: 0 })));
  code('registration_conflict', () => transaction(() => waiters.register({ ...first, waiter: 'waiter-c' })));
  transaction(() => waiters.register(second));

  nativeEvents.push(
    { id: 'job-1:1', job: 'job-1', seq: 1, type: 'submitted', state: 'queued' },
    { id: 'job-1:2', job: 'job-1', seq: 2, type: 'progressed', state: 'running' },
  );
  assert.equal(transaction(() => waiters.materialize(first)).added, 0, 'cursor and predicate reject earlier/nonterminal facts');
  nativeEvents.push({ id: 'job-1:3', job: 'job-1', seq: 3, type: 'finished', state: 'finished' });
  assert.deepEqual(waiters.inbox(first), [], 'inbox is read-only and does not materialize');

  code('transaction_required', () => waiters.materialize(first));
  assert.throws(() => transaction(() => {
    waiters.materialize(first);
    throw new Error('force rollback');
  }), /force rollback/);
  assert.deepEqual(waiters.inbox(first), [], 'materialization rolls back with its caller');

  assert.equal(transaction(() => waiters.materialize(first)).added, 1);
  assert.equal(transaction(() => waiters.materialize(first)).added, 0, 'materialization is idempotent');
  assert.equal(transaction(() => waiters.materialize(second)).added, 1, 'each waiter receives the same native fact independently');
  const [firstDelivery] = waiters.inbox(first);
  const [secondDelivery] = waiters.inbox(second);
  assert.equal(firstDelivery.eventId, secondDelivery.eventId);
  assert.notEqual(firstDelivery.delivery, secondDelivery.delivery);

  code('delivery_not_found', () => transaction(() => waiters.ack({
    job: first.job, owner: first.owner, waiter: first.waiter, delivery: secondDelivery.delivery,
  })));
  const ack = transaction(() => waiters.ack({
    job: first.job, owner: first.owner, waiter: first.waiter, delivery: firstDelivery.delivery,
  }));
  assert.deepEqual(transaction(() => waiters.ack({
    job: first.job, owner: first.owner, waiter: first.waiter, delivery: firstDelivery.delivery,
  })), ack, 'ACK retry returns the original receipt');
  assert.deepEqual(waiters.inbox(first), [], 'ACK removes only this waiter delivery from its inbox');
  assert.equal(waiters.inbox(second).length, 1, 'ACK for one waiter does not consume another waiter delivery');

  db.close();
  db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  waiters = openComponent();
  assert.deepEqual(waiters.inbox(first), [], 'ACK state persists across reopen');
  assert.equal(waiters.inbox(second).length, 1, 'other waiter remains pending across reopen');
  const storedAck = db.prepare('SELECT acknowledged_at FROM durable_waiter_deliveries WHERE delivery_id = ?').get(firstDelivery.delivery);
  assert.equal(storedAck.acknowledged_at, ack.acknowledgedAt);

  code('unauthorized', () => waiters.inbox({ ...first, owner: 'owner-2' }));
  code('unauthorized', () => transaction(() => waiters.register({ ...first, owner: 'owner-2' })));
  code('invalid_registration', () => transaction(() => waiters.register({ ...first, waiter: 'bad', key: 'bad', predicate: 'invented' })));

  const inputWaiter = {
    ...first, waiter: 'waiter-input', key: 'key-input', predicate: 'input', afterSeq: 2,
  };
  transaction(() => waiters.register(inputWaiter));
  nativeEvents.push({ id: 'job-1:4', job: 'job-1', seq: 4, type: 'answer_added', state: 'running' });
  assert.equal(transaction(() => waiters.materialize(inputWaiter)).added, 1, 'predicate selects matching event after its cursor');
  assert.equal(waiters.inbox(inputWaiter)[0].eventId, 'job-1:4');

  now = 100;
  const expired = { ...first, waiter: 'waiter-expired', key: 'key-expired', expiresAt: 100 };
  code('waiter_expired', () => transaction(() => waiters.register(expired)));
  assert.deepEqual(transaction(() => waiters.materialize(second)), { expired: true, added: 0 }, 'expiry is exclusive at the exact boundary');
  assert.equal(waiters.inbox(second).length, 1, 'expiry does not erase already delivered facts');

  assert.throws(() => transaction(() => {
    waiters.ack({ job: second.job, owner: second.owner, waiter: second.waiter, delivery: secondDelivery.delivery });
    throw new Error('force ACK rollback');
  }), /force ACK rollback/);
  assert.equal(waiters.inbox(second).length, 1, 'ACK rolls back with its caller');
  console.log('durable waiter offline assertions passed');
} finally {
  db?.close();
  rmSync(directory, { recursive: true, force: true });
}
