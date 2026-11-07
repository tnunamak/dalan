import { createHash } from 'node:crypto';

const MAX_TEXT = 512;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function text(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT;
}

function natural(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function stableValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  fail('invalid_native_event');
}

function serialize(value) {
  try {
    return JSON.stringify(stableValue(value));
  } catch (error) {
    if (error.code) throw error;
    fail('invalid_native_event');
  }
}

function requireTransaction(db) {
  if (!db.isTransaction) fail('transaction_required');
}

function requireOwner(authorize, job, owner, action) {
  if (!text(job) || !text(owner) || authorize({ job, owner, action }) !== true) fail('unauthorized');
}

function registration(row) {
  return {
    job: row.job,
    owner: row.owner,
    waiter: row.waiter,
    key: row.command_key,
    predicate: row.predicate,
    afterSeq: row.after_seq,
    expiresAt: row.expires_at,
  };
}

/** Create the tables inside the caller's existing migration transaction. */
export function migrateDurableWaiters(db) {
  requireTransaction(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS durable_waiters (
      job TEXT NOT NULL,
      owner TEXT NOT NULL,
      waiter TEXT NOT NULL,
      command_key TEXT NOT NULL,
      predicate TEXT NOT NULL,
      after_seq INTEGER NOT NULL CHECK (after_seq >= 0),
      expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
      PRIMARY KEY (job, owner, waiter),
      UNIQUE (job, owner, command_key)
    );
    CREATE TABLE IF NOT EXISTS durable_waiter_deliveries (
      delivery_id TEXT PRIMARY KEY,
      job TEXT NOT NULL,
      owner TEXT NOT NULL,
      waiter TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_seq INTEGER NOT NULL CHECK (event_seq >= 0),
      fact TEXT NOT NULL,
      acknowledged_at INTEGER,
      FOREIGN KEY (job, owner, waiter)
        REFERENCES durable_waiters(job, owner, waiter) ON DELETE CASCADE,
      UNIQUE (job, owner, waiter, event_id)
    );
    CREATE INDEX IF NOT EXISTS durable_waiter_inbox
      ON durable_waiter_deliveries(job, owner, waiter, acknowledged_at, event_seq);
  `);
  // Registration after_seq is immutable replay identity; scan_seq is delivery progress.
  if (!db.prepare('PRAGMA table_info(durable_waiters)').all().some(column => column.name === 'scan_seq')) {
    db.exec('ALTER TABLE durable_waiters ADD COLUMN scan_seq INTEGER NOT NULL DEFAULT 0 CHECK (scan_seq >= 0)');
    db.exec('UPDATE durable_waiters SET scan_seq = after_seq');
  }
}

/**
 * Build the waiter component around the parent's SQLite connection and authority.
 * register/materialize/ack require the caller's transaction. inbox is read-only.
 * owner is the authenticated non-secret owner_hash, never a bearer token.
 * readEvents returns immutable native facts ordered by sequence; honor afterSeq.
 */
export function createDurableWaiters({ db, authorize, readEvents, predicates, clock = Date.now }) {
  if (typeof authorize !== 'function' || typeof readEvents !== 'function' ||
      !predicates || typeof predicates !== 'object' || Array.isArray(predicates) ||
      Object.values(predicates).some(predicate => typeof predicate !== 'function') ||
      typeof clock !== 'function') {
    fail('callbacks_required');
  }

  function register(input) {
    requireTransaction(db);
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_registration');
    const { job, owner, waiter, key, predicate, afterSeq, expiresAt } = input;
    requireOwner(authorize, job, owner, 'register');
    if (!text(waiter) || !text(key) || !Object.hasOwn(predicates, predicate) ||
        !natural(afterSeq) || !natural(expiresAt)) {
      fail('invalid_registration');
    }

    const matches = db.prepare(`
      SELECT * FROM durable_waiters
      WHERE job = ? AND owner = ? AND (waiter = ? OR command_key = ?)
    `).all(job, owner, waiter, key);
    const wanted = { job, owner, waiter, key, predicate, afterSeq, expiresAt };
    if (matches.length > 0) {
      if (matches.length !== 1 || JSON.stringify(registration(matches[0])) !== JSON.stringify(wanted)) {
        fail('registration_conflict');
      }
      return registration(matches[0]);
    }
    if (clock() >= expiresAt) fail('waiter_expired');

    db.prepare(`
      INSERT INTO durable_waiters(job, owner, waiter, command_key, predicate, after_seq, expires_at, scan_seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(job, owner, waiter, key, predicate, afterSeq, expiresAt, afterSeq);
    return wanted;
  }

  function materialize(input) {
    requireTransaction(db);
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_waiter');
    const { job, owner, waiter } = input;
    requireOwner(authorize, job, owner, 'materialize');
    const row = db.prepare(`
      SELECT * FROM durable_waiters WHERE job = ? AND owner = ? AND waiter = ?
    `).get(job, owner, waiter);
    if (!row) fail('waiter_not_found');
    if (clock() >= row.expires_at) return { expired: true, added: 0 };

    const events = readEvents({ job, afterSeq: row.scan_seq });
    if (!Array.isArray(events)) fail('invalid_native_events');
    const insert = db.prepare(`
      INSERT INTO durable_waiter_deliveries(
        delivery_id, job, owner, waiter, event_id, event_seq, fact
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job, owner, waiter, event_id) DO NOTHING
    `);
    const find = db.prepare(`
      SELECT fact FROM durable_waiter_deliveries
      WHERE job = ? AND owner = ? AND waiter = ? AND event_id = ?
    `);

    let added = 0;
    let previousSeq = -1;
    let scanned = row.scan_seq;
    const seenIds = new Set();
    for (const event of events) {
      if (!event || !text(event.id) || event.job !== job || !natural(event.seq)) fail('invalid_native_event');
      if (event.seq <= previousSeq) fail('native_event_order');
      previousSeq = event.seq;
      if (seenIds.has(event.id)) fail('native_event_conflict');
      seenIds.add(event.id);
      // Validate even filtered-out facts before advancing beyond them.
      const fact = serialize(event);
      if (event.seq <= row.scan_seq) continue;
      scanned = event.seq;

      const matchesPredicate = predicates[row.predicate](event);
      if (typeof matchesPredicate !== 'boolean') fail('invalid_predicate_result');
      if (!matchesPredicate) continue;

      const prior = find.get(job, owner, waiter, event.id);
      if (prior) {
        if (prior.fact !== fact) fail('native_event_conflict');
        continue;
      }
      const delivery = `waiter:${createHash('sha256').update(JSON.stringify([job, owner, waiter, event.id])).digest('hex')}`;
      added += insert.run(delivery, job, owner, waiter, event.id, event.seq, fact).changes;
    }
    db.prepare('UPDATE durable_waiters SET scan_seq = ? WHERE job = ? AND owner = ? AND waiter = ?')
      .run(scanned, job, owner, waiter);
    return { expired: false, added };
  }

  // Inbox reads pending deliveries only. It neither reads native events nor mutates state.
  function inbox(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_waiter');
    const { job, owner, waiter } = input;
    requireOwner(authorize, job, owner, 'inbox');
    if (!text(waiter)) fail('invalid_waiter');
    return db.prepare(`
      SELECT delivery_id, event_id, event_seq, fact
      FROM durable_waiter_deliveries
      WHERE job = ? AND owner = ? AND waiter = ? AND acknowledged_at IS NULL
      ORDER BY event_seq, delivery_id
    `).all(job, owner, waiter).map(row => ({
      delivery: row.delivery_id,
      eventId: row.event_id,
      eventSeq: row.event_seq,
      fact: JSON.parse(row.fact),
    }));
  }

  function ack(input) {
    requireTransaction(db);
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_delivery');
    const { job, owner, waiter, delivery } = input;
    requireOwner(authorize, job, owner, 'ack');
    if (!text(waiter) || !text(delivery)) fail('invalid_delivery');
    const row = db.prepare(`
      SELECT acknowledged_at FROM durable_waiter_deliveries
      WHERE delivery_id = ? AND job = ? AND owner = ? AND waiter = ?
    `).get(delivery, job, owner, waiter);
    if (!row) fail('delivery_not_found');
    if (row.acknowledged_at !== null) return { delivery, acknowledgedAt: row.acknowledged_at };

    const acknowledgedAt = clock();
    if (!natural(acknowledgedAt)) fail('invalid_clock');
    db.prepare(`
      UPDATE durable_waiter_deliveries SET acknowledged_at = ?
      WHERE delivery_id = ? AND acknowledged_at IS NULL
    `).run(acknowledgedAt, delivery);
    return { delivery, acknowledgedAt };
  }

  return { register, materialize, inbox, ack };
}
