const post54Tables = [
  'submit_supersedes',
  'destination_blocks', 'destination_approvals',
  'question_answer_wakes', 'job_questions',
  'protocol_events', 'protocol_jobs', 'claim_command_receipts', 'claim_command_revisions',
  'artifact_mutation_journal', 'artifact_journal_heads', 'immutable_result_bindings',
  'job_retention_tombstones', 'job_retention_policy',
  'protocol_delivery_receipts', 'protocol_delivery_attempts',
  'protocol_stop_receipts', 'protocol_stop_observations', 'protocol_stop_enrollments',
  'durable_waiter_deliveries', 'durable_waiters',
];

function validateEmptyPost54State(db) {
  const existing = [];
  for (const table of post54Tables) {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)) continue;
    const count = db.prepare(`SELECT count(*) AS count FROM "${table}"`).get().count;
    if (count !== 0) throw new Error(`historical fixture cannot drop nonempty ${table}`);
    existing.push(table);
  }
  const hasLeaseDeadline = db.prepare("SELECT 1 FROM pragma_table_info('claims') WHERE name='lease_deadline_at'").get();
  if (hasLeaseDeadline && db.prepare('SELECT 1 FROM claims WHERE lease_deadline_at IS NOT NULL LIMIT 1').get()) {
    throw new Error('historical fixture cannot drop nonnull claims.lease_deadline_at');
  }
  const hasDestinationRevision = db.prepare("SELECT 1 FROM pragma_table_info('claims') WHERE name='destination_revision'").get();
  if (hasDestinationRevision && db.prepare('SELECT 1 FROM claims WHERE destination_revision IS NOT NULL LIMIT 1').get()) {
    throw new Error('historical fixture cannot drop nonnull claims.destination_revision');
  }
  const hasMonotonicDeadline=db.prepare("SELECT 1 FROM pragma_table_info('claims') WHERE name='lease_deadline_monotonic_ms'").get();
  if(hasMonotonicDeadline&&db.prepare('SELECT 1 FROM claims WHERE lease_deadline_monotonic_ms IS NOT NULL OR lease_boot_id IS NOT NULL LIMIT 1').get())
    throw new Error('historical fixture cannot drop nonnull claims monotonic lease clock');
  return {existing, hasLeaseDeadline: !!hasLeaseDeadline, hasDestinationRevision: !!hasDestinationRevision};
}

export function dropEmptyPost54FixtureState(db,{requireEmptyLeaseDeadlines=false}={}) {
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    const hasLeaseColumn=!!db.prepare("SELECT 1 FROM pragma_table_info('claims') WHERE name='lease_deadline_at'").get();
    if(hasLeaseColumn&&!requireEmptyLeaseDeadlines) db.prepare('UPDATE claims SET lease_deadline_at=NULL').run();
    const hasMonotonicDeadline=!!db.prepare("SELECT 1 FROM pragma_table_info('claims') WHERE name='lease_deadline_monotonic_ms'").get();
    if(hasMonotonicDeadline&&!requireEmptyLeaseDeadlines) db.prepare('UPDATE claims SET lease_deadline_monotonic_ms=NULL,lease_boot_id=NULL').run();
    // Validate the complete downgrade before the first DROP or ALTER.
    const {existing, hasLeaseDeadline, hasDestinationRevision} = validateEmptyPost54State(db);
    for (const table of existing) db.exec(`DROP TABLE "${table}"`);
    if (hasLeaseDeadline) db.exec('ALTER TABLE claims DROP COLUMN lease_deadline_at');
    if (hasMonotonicDeadline) { db.exec('ALTER TABLE claims DROP COLUMN lease_deadline_monotonic_ms'); db.exec('ALTER TABLE claims DROP COLUMN lease_boot_id'); }
    if (hasDestinationRevision) db.exec('ALTER TABLE claims DROP COLUMN destination_revision');
    // Schema 65 renamed the break table and the skip marker. A fixture older than that carries the original names.
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='worker_breaks'").get()) db.exec('ALTER TABLE worker_breaks RENAME TO dot_breaks');
    if (db.prepare("SELECT 1 FROM pragma_table_info('assignments') WHERE name='skipped_at'").get()) db.exec('ALTER TABLE assignments RENAME COLUMN skipped_at TO skipped_by_dot_at');
    if (ownsTransaction) db.exec('COMMIT');
  } catch (error) {
    if (ownsTransaction && db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

// Older migration tests start with today's Store, then remove the fields that their historical fixture predates.
// Remove the worker-isolation marker too: retaining its marker while dropping an older table produces a schema no released build ever wrote.
export function preWorkerFixture(store) {
  const db=store.db;
  // The historical schema predates persisted lease deadlines. Keep the claim's
  // activity and lease duration so the legacy fallback remains realistic.
  if(db.prepare("SELECT 1 FROM pragma_table_info('claims') WHERE name='lease_deadline_at'").get())
    db.prepare('UPDATE claims SET lease_deadline_at=NULL').run();
  if(db.prepare("SELECT 1 FROM pragma_table_info('claims') WHERE name='lease_deadline_monotonic_ms'").get())
    db.prepare('UPDATE claims SET lease_deadline_monotonic_ms=NULL,lease_boot_id=NULL').run();
  dropEmptyPost54FixtureState(db);
  db.exec('DROP TRIGGER IF EXISTS subscriptions_encrypted_insert; DROP TRIGGER IF EXISTS subscriptions_encrypted_update');
  for(const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE '%_immutable' OR name='claims_lane_key_epoch')").all()) db.exec(`DROP TRIGGER ${row.name}`);
  db.exec(`DROP INDEX artifacts_alias;
    ALTER TABLE artifacts DROP COLUMN client_artifact_id;
    DROP TRIGGER lifecycle_events_no_update;
    ALTER TABLE lifecycle_events DROP COLUMN worker;
    CREATE TRIGGER lifecycle_events_no_update BEFORE UPDATE ON lifecycle_events BEGIN SELECT RAISE(ABORT,'lifecycle events are append-only'); END;`);
  for(const [table,cols] of Object.entries({assignments:['target_worker'],messages:['target_worker'],claims:['worker','lane_key','lane_scope','connection_id'],subscriptions:['worker','connection'],reports:['worker'],progress:['worker'],claim_denials:['worker']}))
    for(const column of cols) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  db.exec(`CREATE TABLE worker_calls_old (subject TEXT NOT NULL,minute INTEGER NOT NULL,tool TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,bytes INTEGER,PRIMARY KEY(subject,minute,tool));
    INSERT INTO worker_calls_old SELECT subject,minute,tool,count,bytes FROM worker_calls;
    DROP TABLE worker_calls; ALTER TABLE worker_calls_old RENAME TO worker_calls;
    CREATE INDEX worker_calls_minute ON worker_calls(minute);
    CREATE TABLE worker_activity_old (subject TEXT PRIMARY KEY,last_call_at TEXT NOT NULL,last_list_pending_at TEXT);
    INSERT INTO worker_activity_old SELECT subject,last_call_at,last_list_pending_at FROM worker_activity;
    DROP TABLE worker_activity; ALTER TABLE worker_activity_old RENAME TO worker_activity;
    DROP TABLE schema_migrations; PRAGMA user_version=34;`);
}
