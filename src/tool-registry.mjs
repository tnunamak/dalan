// Owner-managed tool registry. The owner registers tools and grants them to worker identities; a worker can only list
// and call what was granted to it. Registering, removing or granting never changes the MCP tools/list (this module has no
// MCP surface). Policy lives here, not in the model-facing dispatch tool: default deny, class match, schema-checked
// arguments, a closed set of handler kinds, redacted and capped results, and an audit log that never holds argument values.
import { createHash } from 'node:crypto';
import { redactOutput, redactSecrets } from './redaction.mjs';
import { execFile } from 'node:child_process';
import { compileSchema, validateValue, SchemaError } from './schema-subset.mjs';

export class RegistryError extends Error {
  constructor(code, message) { super(message ?? code); this.name = 'RegistryError'; this.code = code; }
}
const refuse = (code, message) => { throw new RegistryError(code, message); };

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const WORKER = /^[a-z][a-z0-9_-]{0,31}$/;
const RESERVED = new Set(['list_tools', 'call_tool_read', 'call_tool_write']);
const FORBIDDEN_KIND = /(delete|overwrite|unlink|truncate|wipe|destroy|remove)/i;
const FORBIDDEN_WORD = /^(delete|overwrite|remove|unlink|truncate|wipe|destroy|rm|rmdir|erase|replace)$/i;
// The longest a handler may run (the t3-post command timeout), and the lease a pending reservation holds: that timeout plus
// a margin. A crashed call leaves a pending row; once its lease passes, a retry under the same key takes the row over.
export const HANDLER_TIMEOUT_MS = 15_000;
const LEASE_MARGIN_MS = 30_000;
export const LIMITS = Object.freeze({ resultBytes: 32768, callsPerMinute: 30, admissionPerMinute: 120, idempotencyKeyMax: 128, idempotencyTtlMs: 7 * 86_400_000, idempotencyLeaseMs: HANDLER_TIMEOUT_MS + LEASE_MARGIN_MS });

const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
const sha256 = text => createHash('sha256').update(text).digest('hex');
// The definition hash recorded in the audit log. The hash a caller pins (callerHash below) also covers the caller's grants.
export const schemaHash = ({ name, description, input_schema, class: toolClass, handler }) => sha256(canonical({ name, description, input_schema, class: toolClass, handler: handler ?? null }));

// The lease follows the handler's real timeout: that timeout plus a margin (a handler without one gets the maximum).
const leaseMs = impl => (impl?.timeoutMs ?? HANDLER_TIMEOUT_MS) + LEASE_MARGIN_MS;
const iso = ms => new Date(ms).toISOString();
const workerName = worker => typeof worker === 'string' ? worker : worker?.name;
const configStrings = (value, out = []) => {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(v => configStrings(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.push(k); configStrings(v, out); }
  return out;
};

// `now` defaults to Date.now for the bare registry. The server passes the Store's monotonic clock, so within one running
// bridge process a wall-clock step cannot shorten or stretch a lease; lease expiry is not compared across processes.
// `hooks.afterIdempotencyLookup` is a test seam that pauses a call between its lookup and its reservation.
export function createToolRegistry({ store, now = Date.now, handlers = {}, audit = null, callsPerMinute = LIMITS.callsPerMinute, admissionPerMinute = LIMITS.admissionPerMinute, hooks = {} }) {
  const db = store.db;
  const windows = new Map();
  const record = entry => {
    const row = { at: iso(now()), kind: entry.kind, tool: entry.tool ?? null, worker: entry.worker ?? null,
      args_digest: entry.args_digest ?? null, outcome: entry.outcome, schema_hash: entry.schema_hash ?? null };
    db.prepare('INSERT INTO tool_registry_log(at,kind,tool,worker,args_digest,outcome,schema_hash) VALUES(?,?,?,?,?,?,?)')
      .run(row.at, row.kind, row.tool, row.worker, row.args_digest, row.outcome, row.schema_hash);
    try { audit?.(row); } catch { /* an audit sink must not break the registry */ }
  };
  const getTool = name => db.prepare('SELECT * FROM registered_tools WHERE name=?').get(name);
  // The registry version moves on every register, remove, grant, revoke, enable and disable, and never goes back.
  const registryVersion = () => db.prepare("SELECT value FROM tool_registry_meta WHERE key='version'").get()?.value ?? 0;
  const bump = () => db.prepare("INSERT INTO tool_registry_meta(key,value) VALUES('version',1) ON CONFLICT(key) DO UPDATE SET value=value+1").run();
  // What a caller pins: everything that decides what the call does, for this caller. It is computed from the live row,
  // so a changed description, schema, class, handler kind or config (target thread, argv template) or grant set moves it.
  // A handler kind that declares an effect class (impl.effectClass) fixes the class of every tool that uses it. A stored row
  // whose class disagrees (written by an older build, or by hand) is served and enforced as the declared class.
  const toolClass = row => handlers[JSON.parse(row.handler).kind]?.effectClass ?? row.class;
  const callerHash = (row, worker) => sha256(canonical({
    name: row.name, description: row.description, input_schema: JSON.parse(row.input_schema), class: toolClass(row), handler: JSON.parse(row.handler),
    caller: worker, grants: db.prepare('SELECT tool FROM tool_grants WHERE worker=? ORDER BY tool').all(worker).map(g => g.tool),
  }));
  const view = (row, worker) => ({ name: row.name, description: row.description, input_schema: JSON.parse(row.input_schema), class: toolClass(row), schema_hash: callerHash(row, worker) });

  // An authority change and the discarding of the messages queued under it commit together or not at all, so no crash can
  // leave an old message that a later register, grant or enable of the same tool would deliver.
  const atomically = fn => store.inTransaction(fn);

  function register(spec) {
    const bad = (code, message) => refuse(code, message);
    if (!spec || typeof spec !== 'object') bad('invalid_tool', 'tool spec must be an object');
    const { name, description, inputSchema, handler } = spec;
    if (typeof name !== 'string' || !NAME.test(name) || RESERVED.has(name)) bad('invalid_tool', 'name must match [a-z][a-z0-9_]{0,63} and not be a dispatch tool');
    if (typeof description !== 'string' || !description || description.length > 1000) bad('invalid_tool', 'description must be 1-1000 characters');
    if (spec.class !== 'read' && spec.class !== 'write') bad('invalid_tool', 'class must be read or write');
    if (!inputSchema || inputSchema.type !== 'object') bad('invalid_schema', 'inputSchema must be an object schema');
    let normalized;
    try { normalized = compileSchema(inputSchema); }
    catch (error) { if (error instanceof SchemaError) bad('invalid_schema', error.message); throw error; }
    if (!handler || typeof handler !== 'object' || typeof handler.kind !== 'string') bad('invalid_tool', 'handler.kind is required');
    const impl = handlers[handler.kind];
    if (!Object.hasOwn(handlers, handler.kind) || !impl) bad('unknown_handler_kind', `handler kind "${handler.kind.slice(0, 40)}" is not available`);
    if (impl.destructive === true || FORBIDDEN_KIND.test(handler.kind)) bad('forbidden_handler', 'handlers that delete or overwrite are not allowed');
    const { kind, ...config } = handler;
    if (configStrings(config).some(s => FORBIDDEN_WORD.test(s.trim()))) bad('forbidden_handler', 'handlers that delete or overwrite are not allowed');
    const allowed = new Set(impl.configKeys ?? []);
    for (const key of Object.keys(config)) if (!allowed.has(key)) bad('invalid_tool', `handler config key "${key.slice(0, 40)}" is not allowed for ${kind}`);
    if (impl.effectClass && spec.class !== impl.effectClass) bad('invalid_tool', `${kind} tools have side effects, so they must be registered with class "${impl.effectClass}"`);
    impl.validateConfig?.(config, { name, inputSchema: normalized });
    if (getTool(name)) bad('duplicate_tool', `tool "${name}" is already registered`);
    const hash = schemaHash({ name, description, input_schema: normalized, class: spec.class, handler: { kind, ...config } });
    // Unsent rows left under this name (by an older build or a crash) belong to no registration and are discarded here.
    atomically(() => {
      db.prepare('INSERT INTO registered_tools(name,description,input_schema,class,handler,schema_hash,enabled,created_at) VALUES(?,?,?,?,?,?,1,?)')
        .run(name, description, JSON.stringify(normalized), spec.class, JSON.stringify({ kind, ...config }), hash, iso(now()));
      dropQueued(name);
      bump();
      record({ kind: 'register', tool: name, outcome: 'ok', schema_hash: hash });
    });
    return { name, schema_hash: hash };
  }
  // Withdrawing a tool, or a worker's grant, discards the messages that worker queued but never delivered, so they cannot
  // take effect later or be sent to the destination of a tool that reuses the name.
  function dropQueued(tool, worker) {
    if (worker === undefined) db.prepare('DELETE FROM tool_outbox WHERE tool=? AND sent_at IS NULL').run(tool);
    else db.prepare('DELETE FROM tool_outbox WHERE tool=? AND worker=? AND sent_at IS NULL').run(tool, worker);
  }
  function remove(name) {
    const row = getTool(name);
    if (!row) refuse('unknown_tool', `tool "${String(name).slice(0, 64)}" is not registered`);
    atomically(() => {
      db.prepare('DELETE FROM tool_grants WHERE tool=?').run(name);
      db.prepare('DELETE FROM registered_tools WHERE name=?').run(name);
      dropQueued(name);
      bump();
      record({ kind: 'remove', tool: name, outcome: 'ok', schema_hash: row.schema_hash });
    });
    return { name };
  }
  function setEnabled(name, enabled) {
    const row = getTool(name);
    if (!row) refuse('unknown_tool', `tool "${String(name).slice(0, 64)}" is not registered`);
    atomically(() => {
      db.prepare('UPDATE registered_tools SET enabled=? WHERE name=?').run(enabled ? 1 : 0, name);
      if (!enabled) dropQueued(name);
      bump();
      record({ kind: enabled ? 'enable' : 'disable', tool: name, outcome: 'ok', schema_hash: row.schema_hash });
    });
  }
  function grantChange(kind, name, worker) {
    const row = getTool(name);
    if (!row) refuse('unknown_tool', `tool "${String(name).slice(0, 64)}" is not registered`);
    if (typeof worker !== 'string' || !WORKER.test(worker)) refuse('invalid_tool', 'worker must be a worker name');
    atomically(() => {
      if (kind === 'grant') db.prepare('INSERT OR IGNORE INTO tool_grants(tool,worker,granted_at) VALUES(?,?,?)').run(name, worker, iso(now()));
      else { db.prepare('DELETE FROM tool_grants WHERE tool=? AND worker=?').run(name, worker); dropQueued(name, worker); }
      bump();
      record({ kind, tool: name, worker, outcome: 'ok', schema_hash: row.schema_hash });
    });
  }
  const grant = (name, worker) => grantChange('grant', name, worker);
  const revoke = (name, worker) => grantChange('revoke', name, worker);

  function list() {
    return db.prepare('SELECT * FROM registered_tools ORDER BY name').all().map(row => ({
      ...view(row), handler: JSON.parse(row.handler), enabled: row.enabled === 1, created_at: row.created_at,
      workers: db.prepare('SELECT worker FROM tool_grants WHERE tool=? ORDER BY worker').all(row.name).map(g => g.worker),
      uncertain: db.prepare('SELECT count(*) n FROM tool_outbox WHERE tool=? AND sent_at IS NULL AND uncertain_at IS NOT NULL').get(row.name).n,
    }));
  }
  function listTools(worker) {
    const name = workerName(worker);
    const tools = typeof name !== 'string' ? [] : db.prepare('SELECT t.* FROM registered_tools t JOIN tool_grants g ON g.tool=t.name WHERE g.worker=? AND t.enabled=1 ORDER BY t.name').all(name).map(row => view(row, name));
    return { registry_version: registryVersion(), tools };
  }
  function lastChange() {
    const row = db.prepare("SELECT at,kind,tool,worker,schema_hash FROM tool_registry_log WHERE kind IN ('register','remove','grant','revoke','enable','disable') ORDER BY id DESC LIMIT 1").get();
    return row ? { ...row } : null;
  }

  function rateLimited(key) {
    const t = now(), recent = (windows.get(key) ?? []).filter(at => t - at < 60_000);
    if (recent.length >= callsPerMinute) { windows.set(key, recent); return true; }
    recent.push(t); windows.set(key, recent); return false;
  }
  // One admission budget per verified worker, shared by every tool name and checked before anything else: lookup, refusal,
  // replay and audit. A call past it writes no audit row; it only bumps one counter per worker in tool_registry_meta
  // (updated in place, so it cannot grow). The window is in memory and restarts empty; the counter is durable.
  const admissions = new Map();
  function admit(name) {
    const key = typeof name === 'string' ? name.slice(0, 32) : '';
    const t = now(), recent = (admissions.get(key) ?? []).filter(at => t - at < 60_000);
    if (recent.length >= admissionPerMinute) {
      admissions.set(key, recent);
      db.prepare("INSERT INTO tool_registry_meta(key,value) VALUES(?,1) ON CONFLICT(key) DO UPDATE SET value=value+1").run(`admission_refused:${key}`);
      return false;
    }
    recent.push(t); admissions.set(key, recent); return true;
  }
  // Redact first, then cap. A result over the cap becomes {truncated:true, preview} whose serialized form fits the cap.
  const capResult = result => {
    const clean = redactOutput(result ?? null);
    const text = JSON.stringify(clean) ?? 'null';
    if (text.length <= LIMITS.resultBytes) return clean;
    let length = LIMITS.resultBytes - 64;
    for (;;) {
      const capped = { truncated: true, preview: redactSecrets(text.slice(0, length)).text };
      if (JSON.stringify(capped).length <= LIMITS.resultBytes || length < 16) return capped;
      length = Math.floor(length * 0.9);
    }
  };

  const keyProblem = (key, required) => {
    if (key === undefined) return required ? 'idempotency_key is required for write calls' : null;
    if (typeof key !== 'string' || !key.length || key.length > LIMITS.idempotencyKeyMax) return `idempotency_key must be 1-${LIMITS.idempotencyKeyMax} characters`;
    return null;
  };

  // The one enforcement function. Order: per-worker admission budget, exact lookup, grant, class, schema hash, idempotency, arguments, rate limit,
  // handler. Unknown, ungranted and disabled tools share one refusal (tool_unavailable) so a worker cannot enumerate
  // tools it cannot use. The handler takes its target and config only from the registry row.
  async function callTool({ worker, tool, class: callClass, args, schema_hash: pinnedHash, idempotency_key: key }) {
    const name = workerName(worker);
    if (!admit(name)) throw new RegistryError('rate_limited', 'too many calls; retry later');
    let digest = null;
    try { digest = sha256(canonical(args ?? null)); } catch { /* an unserializable argument has no digest */ }
    const row = typeof tool === 'string' ? getTool(tool) : null;
    const done = (outcome, error) => {
      record({ kind: 'call', tool: typeof tool === 'string' ? tool.slice(0, 64) : null, worker: typeof name === 'string' ? name.slice(0, 32) : null, args_digest: digest, outcome, schema_hash: row?.schema_hash });
      if (error) throw error;
    };
    const leaseLive = stored => stored.lease_expires_at != null && Date.parse(stored.lease_expires_at) > now();
    // Retryable and machine-readable: the code is in_progress and the message names the seconds left on the lease.
    const inProgress = stored => {
      const seconds = Math.max(1, Math.ceil((Date.parse(stored?.lease_expires_at ?? '') - now()) / 1000) || 1);
      done('replay_unfinished', new RegistryError('in_progress', `an earlier call with this idempotency_key is in progress; retry later with the same key in about ${seconds} s`));
    };
    const unavailable = outcome => done(outcome, new RegistryError('tool_unavailable', 'tool unavailable'));
    if (!row) unavailable('unknown_tool');
    if (typeof name !== 'string' || !db.prepare('SELECT 1 FROM tool_grants WHERE tool=? AND worker=?').get(row.name, name)) unavailable('not_granted');
    if (row.enabled !== 1) unavailable('disabled');
    if (callClass !== toolClass(row)) done('wrong_class', new RegistryError('wrong_class', 'wrong class for this tool; see list_tools'));
    const stale = () => done('stale_registry', new RegistryError('stale_registry', 'call list_tools again'));
    if (pinnedHash === undefined ? toolClass(row) === 'write' : pinnedHash !== callerHash(row, name)) stale();
    const keyError = keyProblem(key, toolClass(row) === 'write');
    if (keyError) done('invalid_arguments', new RegistryError('invalid_arguments', keyError));
    if (key !== undefined) {
      // Retention runs from completion; a row without completed_at (pending, or from an older build) uses created_at.
      db.prepare('DELETE FROM tool_idempotency WHERE COALESCE(completed_at, created_at) < ?').run(iso(now() - LIMITS.idempotencyTtlMs));
      for (;;) {
        const stored = db.prepare('SELECT * FROM tool_idempotency WHERE worker=? AND tool=? AND key=?').get(name, row.name, key);
        const paused = hooks.afterIdempotencyLookup?.(stored);
        if (paused) await paused;
        if (stored?.state === 'pending') {
          // A live lease means the earlier call may still be running. An expired (or pre-lease, NULL) lease is taken over below.
          if (leaseLive(stored)) inProgress(stored);
        } else if (stored) {
          const outcome = JSON.parse(stored.outcome);
          if (outcome.ok) { done('replayed'); return { ok: true, result: outcome.result, replayed: true }; }
          if (!outcome.retryable) done('replayed_failure', new RegistryError(outcome.code, outcome.message));
          // Free exactly the row we read (outcome, reservation time, lease and completion time). If another caller already
          // replaced it, this changes nothing and we read again instead of erasing theirs.
          if (db.prepare("DELETE FROM tool_idempotency WHERE worker=? AND tool=? AND key=? AND state='done' AND outcome=? AND created_at=? AND lease_expires_at IS ? AND completed_at IS ?").run(name, row.name, key, stored.outcome, stored.created_at, stored.lease_expires_at, stored.completed_at).changes === 0) continue;
        }
        break;
      }
    }
    const schema = JSON.parse(row.input_schema);
    const errors = validateValue(schema, args);
    if (errors.length) done('invalid_arguments', new RegistryError('invalid_arguments', errors.slice(0, 5).join('; ')));
    if (rateLimited(`${row.name}\0${name}`)) done('rate_limited', new RegistryError('rate_limited', 'too many calls; retry later'));
    const config = JSON.parse(row.handler);
    // Every write below is bound to this call's own lease, so a first attempt that wakes up after a takeover cannot
    // overwrite or delete the taker's row.
    const lease = iso(now() + leaseMs(handlers[config.kind]));
    const mine = 'WHERE worker=? AND tool=? AND key=? AND state=\'pending\' AND lease_expires_at=?';
    const settle = outcome => { if (key !== undefined) db.prepare(`UPDATE tool_idempotency SET state='done', outcome=?, completed_at=? ${mine}`).run(JSON.stringify(outcome), iso(now()), name, row.name, key, lease); };
    // Reserve the key atomically. A fresh key is decided by the primary key. An expired pending row is taken over by a
    // conditional UPDATE, so of two concurrent takers (even in another process) exactly one changes the row.
    if (key !== undefined) {
      const stamp = iso(now());
      const taken = db.prepare("UPDATE tool_idempotency SET lease_expires_at=?, created_at=? WHERE worker=? AND tool=? AND key=? AND state='pending' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)")
        .run(lease, stamp, name, row.name, key, stamp).changes === 1;
      if (!taken && db.prepare('INSERT INTO tool_idempotency(worker,tool,key,state,outcome,created_at,lease_expires_at) VALUES(?,?,?,\'pending\',NULL,?,?) ON CONFLICT DO NOTHING').run(name, row.name, key, stamp, lease).changes === 0) {
        const current = db.prepare('SELECT * FROM tool_idempotency WHERE worker=? AND tool=? AND key=?').get(name, row.name, key);
        // The winner may already have finished: replay its result rather than report it as in progress.
        const finished = current?.state === 'done' ? JSON.parse(current.outcome) : null;
        if (finished?.ok) { done('replayed'); return { ok: true, result: finished.result, replayed: true }; }
        inProgress(current);
      }
    }
    let result;
    try {
      result = await handlers[config.kind].run({ tool: row.name, worker: name, args, config, now, idempotencyKey: key });
    } catch (error) {
      if (error instanceof RegistryError) {
        // The handler refused before doing anything, so the key is free to use again.
        if (key !== undefined) db.prepare(`DELETE FROM tool_idempotency ${mine}`).run(name, row.name, key, lease);
        done(error.code, error);
      }
      const message = redactSecrets(error?.userMessage ?? 'handler failed; retry later').text;
      settle({ ok: false, code: 'handler_failed', message, retryable: error?.notDelivered === true });
      done('handler_failed', new RegistryError('handler_failed', message));
    }
    const capped = capResult(result);
    settle({ ok: true, result: capped });
    done('ok');
    return { ok: true, result: capped };
  }

  return { register, remove, grant, revoke, list, listTools, registryVersion, callTool, setEnabled, lastChange };
}

// ---- t3_post: the owner_message handler ----------------------------------------------------------------------------
const MESSAGE_KINDS = new Set(['question', 'blocker']);
const MESSAGE_INTERVAL_MS = 10 * 60_000;
const MESSAGE_BATCH_CHARS = 8000;
// A global budget for the whole tool, across workers. Held and retried messages count; so does a failed attempt.
const MESSAGE_HOURLY_CAP = 6;
const MESSAGE_DAILY_CAP = 30;

// Default delivery: the host `t3-post` command, which posts through T3's /mcp so the message shows as an agent chip.
// execFile with an argv array (no shell); the message goes on stdin, never in argv. There is no fallback to posting as
// the owner: exit 3 (not sent), a timeout, a spawn failure and any other failure all leave the message queued.
const POST_TIMEOUT_MS = HANDLER_TIMEOUT_MS;
const senderName = worker => (String(worker).replace(/[^A-Za-z0-9-]/g, '-').slice(0, 40) || 'worker');

// A zero, negative, non-numeric or too long timeout is refused: the lease assumes no handler outlives HANDLER_TIMEOUT_MS.
const checkTimeout = timeoutMs => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > HANDLER_TIMEOUT_MS) throw new RangeError(`timeoutMs must be a number from 1 to ${HANDLER_TIMEOUT_MS}`);
  return timeoutMs;
};

export function createT3PostCommand({ command = 't3-post', timeoutMs = POST_TIMEOUT_MS } = {}) {
  checkTimeout(timeoutMs);
  return ({ threadId, label, text }) => new Promise((resolve, reject) => {
    const args = ['--as', senderName(label), '--kind', 'script', '--mode', 'queue', '--thread', threadId];
    const child = execFile(command, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true }, (error, _out, stderr) => {
      if (!error) return resolve();
      const reason = error.killed ? 'timed out' : error.code === 'ENOENT' ? 't3-post not found on PATH' : `exit ${error.code}`;
      const detail = redactSecrets(String(stderr ?? '').trim().slice(0, 300)).text.slice(0, 300);
      reject(Object.assign(new Error(`t3-post failed: ${reason}${detail ? `: ${detail}` : ''}`), { exitCode: error.code }));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  });
}

export function createT3PostHandler({ store, post, command, timeoutMs, now = Date.now, intervalMs = MESSAGE_INTERVAL_MS, hourlyCap = MESSAGE_HOURLY_CAP, dailyCap = MESSAGE_DAILY_CAP }) {
  if (timeoutMs !== undefined) checkTimeout(timeoutMs);
  post ??= createT3PostCommand({ command, timeoutMs });
  const db = store.db;
  // The budget: every post attempt is a row in tool_post_log, whether a call or a timer retry made it.
  const since = ms => db.prepare("SELECT count(*) n FROM tool_post_log WHERE at > ? AND outcome != 'rate_limited'").get(iso(now() - ms)).n;
  const overBudget = () => since(3_600_000) >= hourlyCap || since(86_400_000) >= dailyCap;
  const logPost = (outcome, tool, worker, kind) => db.prepare('INSERT INTO tool_post_log(at,tool,worker,message_kind,outcome) VALUES(?,?,?,?,?)').run(iso(now()), tool, worker, kind, outcome).lastInsertRowid;
  const settleLog = (id, outcome) => db.prepare('UPDATE tool_post_log SET outcome=? WHERE id=?').run(outcome, id);

  // One flush at a time per tool, worker and thread. A flush selects its rows only after it holds the turn, so a message
  // another flush already sent is never selected twice. (One bridge process owns the database.)
  const turns = new Map();
  const inTurn = (key, fn) => {
    const result = (turns.get(key) ?? Promise.resolve()).then(fn);
    const tail = result.catch(() => {});
    turns.set(key, tail);
    tail.then(() => { if (turns.get(key) === tail) turns.delete(key); });
    return result;
  };
  const lastSent = (tool, worker) => db.prepare('SELECT max(sent_at) AS at FROM tool_outbox WHERE tool=? AND worker=?').get(tool, worker).at;
  // The shared delivery path, for calls and for the timer. Returns {held} while the 10-minute window is open; the timer
  // path also stays inside the budget and logs its attempt. A failure that does not prove the message was undelivered
  // (only t3-post exit 3 does) marks the rows uncertain: they are never retried automatically.
  function flush(tool, worker, threadId, { timer = false } = {}) {
    return inTurn(`${tool}\0${worker}\0${threadId}`, async () => {
      const rows = db.prepare('SELECT * FROM tool_outbox WHERE tool=? AND worker=? AND thread_id=? AND sent_at IS NULL AND uncertain_at IS NULL ORDER BY id').all(tool, worker, threadId);
      if (!rows.length) return { sent: 0, remaining: 0 };
      const last = lastSent(tool, worker);
      if (last && now() - Date.parse(last) < intervalMs) return { held: true, retry_after_ms: Math.max(0, intervalMs - (now() - Date.parse(last))) };
      if (timer && overBudget()) return { held: true, retry_after_ms: 60_000 };
      const attempt = timer ? logPost('pending', tool, worker, rows[0].kind) : null;
      const batch = []; let chars = 0;
      for (const row of rows) {
        const part = `[${row.kind}] ${row.text}`;
        if (batch.length && chars + part.length > MESSAGE_BATCH_CHARS) break;
        batch.push({ row, part }); chars += part.length;
      }
      const marks = batch.map(() => '?').join(',');
      try { await post({ threadId, label: worker, text: batch.map(b => b.part).join('\n\n') }); }
      catch (error) {
        if (error?.exitCode !== 3) db.prepare(`UPDATE tool_outbox SET uncertain_at=? WHERE id IN (${marks})`).run(iso(now()), ...batch.map(b => b.row.id));
        if (attempt) settleLog(attempt, 'failed');
        throw error;
      }
      db.prepare(`UPDATE tool_outbox SET sent_at=? WHERE id IN (${marks})`).run(iso(now()), ...batch.map(b => b.row.id));
      if (attempt) settleLog(attempt, 'sent');
      return { sent: batch.length, remaining: rows.length - batch.length };
    });
  }
  // A queued message the timer can never deliver (no thread, or no enabled tool granted to its worker that still points at
  // its thread) is discarded, so it cannot sit in the queue forever or be revived by a later grant.
  const pruneUndeliverable = () => db.prepare(`DELETE FROM tool_outbox WHERE sent_at IS NULL AND (thread_id = '' OR NOT EXISTS (
    SELECT 1 FROM registered_tools t JOIN tool_grants g ON g.tool=t.name
    WHERE t.name=tool_outbox.tool AND t.enabled=1 AND g.worker=tool_outbox.worker AND json_extract(t.handler,'$.thread_id')=tool_outbox.thread_id))`).run();
  // Timer path: retry held messages whose rate window has passed. Returns the number of messages sent.
  async function flushDue() {
    pruneUndeliverable();
    const groups = db.prepare("SELECT tool, worker, thread_id FROM tool_outbox WHERE sent_at IS NULL AND uncertain_at IS NULL AND thread_id != '' GROUP BY tool, worker, thread_id").all();
    let sent = 0;
    for (const { tool, worker, thread_id } of groups) {
      // Authority is checked again at delivery: the tool is still registered and enabled, the worker still holds its grant,
      // and the tool still points at the thread the message was queued for.
      const row = db.prepare('SELECT t.handler FROM registered_tools t JOIN tool_grants g ON g.tool=t.name WHERE t.name=? AND t.enabled=1 AND g.worker=?').get(tool, worker);
      if (!row || JSON.parse(row.handler).thread_id !== thread_id) continue;
      try { sent += (await flush(tool, worker, thread_id, { timer: true })).sent ?? 0; }
      catch { /* kept queued; the next tick or call retries */ }
    }
    return sent;
  }
  const hasHeld = () => { pruneUndeliverable(); return db.prepare('SELECT 1 FROM tool_outbox WHERE sent_at IS NULL AND uncertain_at IS NULL LIMIT 1').get() !== undefined; };
  return {
    flushDue, hasHeld, timeoutMs: timeoutMs ?? POST_TIMEOUT_MS,
    configKeys: ['thread_id'],
    // Posting a message is a write effect, so a t3_post tool is always class write.
    effectClass: 'write',
    validateConfig(config, tool) {
      if (typeof config.thread_id !== 'string' || !config.thread_id || config.thread_id.length > 128) refuse('invalid_tool', 't3_post needs handler.thread_id');
      const props = tool.inputSchema.properties;
      if (props.kind?.type !== 'string' || props.text?.type !== 'string') refuse('invalid_tool', 't3_post tools take string "kind" and "text"');
    },
    async run({ tool, worker, args, config, idempotencyKey }) {
      if (!MESSAGE_KINDS.has(args.kind)) refuse('invalid_arguments', 'kind must be question or blocker');
      if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 2000) refuse('invalid_arguments', 'text must be 1-2000 characters');
      // Delivery is at least once. If an earlier attempt under this key already posted (its row is marked sent) but the
      // registry never settled, return that receipt instead of posting again.
      const digest = createHash('sha256').update(canonical([args.kind, args.text])).digest('hex');
      const earlier = idempotencyKey ? db.prepare('SELECT args_digest, sent_at FROM tool_outbox WHERE tool=? AND worker=? AND idempotency_key=? ORDER BY id DESC LIMIT 1').get(tool, worker, idempotencyKey) : undefined;
      // A reused key must carry the same message. Rows from an older build have no digest and keep the old behaviour.
      if (earlier?.args_digest && earlier.args_digest !== digest) refuse('invalid_arguments', 'idempotency key reused with different content');
      const sentRow = earlier?.sent_at != null;
      if (sentRow) return { queued: false, sent: 1, remaining: 0, note: 'already sent; receipt reused' };
      const stamp = iso(now());
      // Budget first: every attempt that gets this far is logged with its kind, and counts until it ages out.
      if (overBudget()) { logPost('rate_limited', tool, worker, args.kind); refuse('rate_limited', 'message budget reached; retry later'); }
      const logId = logPost('pending', tool, worker, args.kind);
      const settle = outcome => settleLog(logId, outcome);
      // A retry under the same key reuses its queued message instead of adding a second one.
      const queued = idempotencyKey ? db.prepare('SELECT 1 FROM tool_outbox WHERE tool=? AND worker=? AND idempotency_key=? AND sent_at IS NULL').get(tool, worker, idempotencyKey) : undefined;
      if (!queued) db.prepare('INSERT INTO tool_outbox(tool,worker,kind,text,created_at,thread_id,idempotency_key,args_digest) VALUES(?,?,?,?,?,?,?,?)').run(tool, worker, args.kind, args.text, stamp, config.thread_id, idempotencyKey ?? null, digest);
      try {
        const result = await flush(tool, worker, config.thread_id);
        if (result.held) { settle('held'); return { queued: true, retry_after_ms: result.retry_after_ms, note: 'held and merged into the next message' }; }
        settle('sent'); return { queued: false, ...result };
      }
      catch (error) {
        settle('failed');
        // Exit code 3 and any transport failure keep the message queued. Only exit 3 proves nothing was delivered,
        // which is the one case where the caller may retry under the same idempotency key.
        throw Object.assign(new Error('delivery failed'), { userMessage: error?.exitCode === 3 ? 'delivery failed; the message is kept queued, retry later' : 'delivery failed and the message may have been delivered; it is not retried automatically, check the thread', cause: error, notDelivered: error?.exitCode === 3 });
      }
    },
  };
}
