// Local operator reads. Keep SQL and storage names behind this versioned CLI interface.
import { DatabaseSync } from 'node:sqlite';
import { defaultPath } from './paths.mjs';
import { canonicalMetaValue, canonicalKindSql } from './objectives.mjs';
import { parseWhen } from './inbox.mjs';

const schemaVersion = 1;

function optionsFor(command, args) {
  const allowed = new Set(['worker', 'since', 'cursor', 'limit', ...(command === 'jobs' ? ['status', 'kind', 'source'] : ['type'])]);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') continue;
    const match = /^--([^=]+)(?:=(.*))?$/.exec(args[i]);
    if (!match || !allowed.has(match[1])) throw new Error(`unknown ${command} option: ${args[i]}`);
    const value = match[2] ?? args[++i];
    if (!value || value.startsWith('--') || Object.hasOwn(options, match[1])) throw new Error(`--${match[1]} needs one value`);
    options[match[1]] = value;
  }
  const limit = options.limit === undefined ? 100 : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('--limit must be an integer from 1 to 1000');
  const since = options.since === undefined ? null : parseWhen(options.since);
  return { ...options, limit, since: since === null ? null : new Date(since).toISOString() };
}

function positionFor(cursor, command) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (value.schema_version !== schemaVersion || value.command !== command ||
        (command === 'events' ? !Number.isSafeInteger(value.id) || value.id < 1 :
          typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at)) || typeof value.id !== 'string')) throw new Error();
    return value;
  } catch { throw new Error(`invalid ${command} cursor`); }
}

export function readPage(file, command, options) {
  const position = positionFor(options.cursor, command);
  const where = [], params = [];
  const filter = (sql, value) => { if (value !== undefined && value !== null) { where.push(sql); params.push(value); } };
  let select, order;
  if (command === 'jobs') {
    filter('a.target_worker=?', options.worker);
    filter('a.status=?', options.status);
    filter('a.created_at>=?', options.since);
    // Normalize the legacy spelling just as the existing metadata readers do.
    for (const [flag, column] of [['kind', 'task_kind'], ['source', 'source']]) {
      if (options[flag] !== undefined) {
        const value = canonicalMetaValue(column, options[flag]);
        filter(`${canonicalKindSql(`a.${column}`)}=?`, value);
      }
    }
    if (position) { where.push('(a.created_at>? OR (a.created_at=? AND a.request_id>?))'); params.push(position.at, position.at, position.id); }
    select = `SELECT a.request_id,a.status,a.target_worker AS worker,a.priority,a.task_kind,a.source,a.objective_key,
      a.created_at,c.claimed_at,r.created_at AS finished_at,r.outcome,r.summary,r.result,a.payload,
      a.cancelled_at,a.valid_until,a.skipped_at,c.worker AS claim_worker,c.state AS claim_state,
      c.abandoned_at,c.last_claim_activity_at,c.acquisition_id,r.worker AS report_worker,
      (SELECT decision FROM decisions d WHERE d.request_id=a.request_id ORDER BY d.id DESC LIMIT 1) AS decision,
      (SELECT type FROM lifecycle_events e WHERE e.request_id=a.request_id AND
        (e.type='accepted' OR e.type='consumed' AND e.reason LIKE 'rejected%') ORDER BY e.id DESC LIMIT 1) AS legacy_decision
      FROM assignments a LEFT JOIN claims c USING(request_id) LEFT JOIN reports r USING(request_id)`;
    order = 'a.created_at,a.request_id';
  } else {
    filter('worker=?', options.worker);
    filter('at>=?', options.since);
    filter('type=?', options.type);
    filter('id>?', position?.id);
    select = 'SELECT id,request_id,claim_id,epoch,type,at,actor,source,reason,worker,scope,outcome FROM lifecycle_events';
    order = 'id';
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const rows = db.prepare(`${select}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ?`).all(...params, options.limit + 1);
    const more = rows.length > options.limit;
    const page = rows.slice(0, options.limit);
    const last = page.at(-1);
    const next = more ? Buffer.from(JSON.stringify({ schema_version: schemaVersion, command,
      ...(command === 'jobs' ? { at: last.created_at, id: last.request_id } : { id: last.id }) })).toString('base64url') : null;
    const items = command === 'jobs' ? page.map(({ legacy_decision, ...row }) => ({ ...row,
      task_kind: canonicalMetaValue('task_kind', row.task_kind), source: canonicalMetaValue('source', row.source),
      objective_key: canonicalMetaValue('objective_key', row.objective_key), payload: JSON.parse(row.payload),
      decision: row.decision ?? (legacy_decision === 'accepted' ? 'accepted' : legacy_decision === 'consumed' ? 'not_useful' : null),
    })) : page;
    return { schema_version: schemaVersion, [command]: items, next_cursor: next };
  } finally { db.close(); }
}

export function readMain(command, args, home) {
  try {
    const options = optionsFor(command, args);
    const page = readPage(defaultPath(home, '.local/share/dot-bridge/bridge.db'), command, options);
    process.stdout.write(JSON.stringify(page) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ schema_version: schemaVersion, error: error.message, kind: 'local' }) + '\n');
    process.exitCode = 1;
  }
}
