import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { randomInt, randomUUID, randomBytes, createCipheriv, createDecipheriv, createHmac } from 'node:crypto';
import path from 'node:path';
import { errors } from 'oidc-provider';
import { isLoopbackCallback, PAIRING_MINUTES } from './as-files.mjs';

// Storage of the built-in authorization server. One SQLite file (WAL, synchronous FULL) holds
//   oidc          every oidc-provider model, through the adapter below
//   static_clients markers for owner-created Client rows, which are not subject to stale DCR cleanup
//   connections   the owner-approved connections (the bridge's authority record)
//   pairings      one row per browser interaction that wants a connection
//   windows       the open pairing window (at most one row)
// Statements are synchronous, so a single statement or a BEGIN IMMEDIATE block is atomic inside this process.
const CLOCK_TOLERANCE_S = 15; // the provider's default clockTolerance; consumed and expired records live this much longer
export const LIMITS = Object.freeze({ clients: 100, staleClientMs: 24 * 3600 * 1000 });
const GRANTABLE = ['AccessToken', 'AuthorizationCode', 'RefreshToken'];
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

import { normalizeCode } from './as-files.mjs';
export { normalizeCode } from './as-files.mjs';
const showCode = code => `${code.slice(0, 4)}-${code.slice(4)}`;

// Opens one sealed value. The restore check calls this with the same logic the store uses at startup.
export function openAsValue(key, value, context) {
  try {
    const [version, nonce, tag, data, extra] = value.split('.');
    if (version !== 'v1' || extra !== undefined || !nonce || !tag || data === undefined) throw new Error();
    const iv = Buffer.from(nonce, 'base64url'), auth = Buffer.from(tag, 'base64url');
    if (iv.length !== 12 || auth.length !== 16) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', key, iv); cipher.setAuthTag(auth); cipher.setAAD(Buffer.from(context));
    return Buffer.concat([cipher.update(Buffer.from(data, 'base64url')), cipher.final()]).toString('utf8');
  } catch { throw new Error('as: encrypted storage is damaged or its key is invalid'); }
}
export class AsStore {
  constructor(file, { now = Date.now, limits = { registrations: 5, interactions: 5 } } = {}) {
    this.now = now;
    this.file = file;
    this.limits = limits;
    this.admission = new AsyncLocalStorage();
    this.refreshExchange = new AsyncLocalStorage();
    // Create the file with mode 0600 before SQLite sees it; WAL and shared-memory files copy the mode of the main file.
    fs.closeSync(fs.openSync(file, 'a', 0o600));
    fs.chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oidc(
        model TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, grant_id TEXT, uid TEXT, user_code TEXT,
        consumed INTEGER, created_at INTEGER NOT NULL, expires_at INTEGER, PRIMARY KEY(model,id)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS oidc_grant ON oidc(grant_id) WHERE grant_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS oidc_uid ON oidc(model,uid) WHERE uid IS NOT NULL;
      CREATE INDEX IF NOT EXISTS oidc_user_code ON oidc(model,user_code) WHERE user_code IS NOT NULL;
      CREATE INDEX IF NOT EXISTS oidc_expiry ON oidc(expires_at) WHERE expires_at IS NOT NULL;
      CREATE TABLE IF NOT EXISTS refresh_receipts(
        grant_id TEXT PRIMARY KEY, token_id TEXT NOT NULL, deadline INTEGER NOT NULL, payload TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS static_clients(client_id TEXT PRIMARY KEY) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS connections(
        connection_id TEXT PRIMARY KEY, worker TEXT NOT NULL, grant_id TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL, resource TEXT NOT NULL, scopes TEXT NOT NULL, created_at INTEGER NOT NULL,
        revoked_at INTEGER, revoked_reason TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS connections_one_active ON connections(worker) WHERE revoked_at IS NULL;
      CREATE TABLE IF NOT EXISTS pairings(
        code TEXT PRIMARY KEY, uid TEXT NOT NULL UNIQUE, worker TEXT NOT NULL, client_id TEXT NOT NULL, client_name TEXT,
        redirect_uri TEXT NOT NULL, resource TEXT NOT NULL, scopes TEXT NOT NULL, created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','approving','approved','done','failed')),
        grant_id TEXT, connection_id TEXT);
      CREATE TABLE IF NOT EXISTS windows(id INTEGER PRIMARY KEY CHECK(id=1), worker TEXT NOT NULL, opened_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    `);
    const columns = this.db.prepare('PRAGMA table_info(windows)').all().map(c => c.name);
    if (!columns.includes('registrations')) this.db.exec('ALTER TABLE windows ADD COLUMN registrations INTEGER NOT NULL DEFAULT 0');
    if (!columns.includes('generation')) this.db.exec('ALTER TABLE windows ADD COLUMN generation TEXT');
    try { this.#initializeCodec(); } catch { this.db.close(); throw new Error('as: encrypted storage could not be opened'); }
    this.onGrantRevoked = () => {};
    const self = this;
    // oidc-provider builds one adapter object for each model name.
    this.Adapter = class SqliteAdapter {
      constructor(model) { this.model = model; }
      async upsert(id, payload, expiresIn) {
        const exchange = self.refreshExchange.getStore();
        if (exchange && ['RefreshToken', 'AccessToken'].includes(this.model)) exchange.writes.push(['upsert', this.model, id, payload, expiresIn]);
        else self.upsert(this.model, id, payload, expiresIn);
      }
      async find(id) {
        const result = await self.find(this.model, id);
        if (this.model === 'AuthorizationCode' && result?.consumed) self.consume(this.model, id);
        const exchange = self.refreshExchange.getStore();
        if (exchange && ['RefreshToken', 'Grant'].includes(this.model)) {
          exchange.reads.push([this.model, id, JSON.stringify(result)]);
          if (this.model === 'RefreshToken' && id === exchange.retryToken && result?.consumed) {
            const copy = { ...result }; delete copy.consumed; return copy;
          }
        }
        return result;
      }
      async findByUid(uid) { return self.findBy(this.model, 'uid', uid); }
      async findByUserCode(userCode) { return self.findBy(this.model, 'user_code', userCode); }
      async destroy(id) { self.db.prepare('DELETE FROM oidc WHERE model=? AND id=?').run(this.model, self.#id(this.model, id)); }
      async revokeByGrantId(grantId) { self.deleteByGrant(grantId, this.model); }
      async consume(id) {
        const exchange = self.refreshExchange.getStore();
        if (exchange && this.model === 'RefreshToken') exchange.writes.push(['consume', this.model, id]);
        else self.consume(this.model, id);
      }
    };
  }

  // The key never enters SQLite. The marker makes a lost key distinguishable from a legacy database.
  #initializeCodec() {
    this.db.exec('CREATE TABLE IF NOT EXISTS as_storage_meta (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL, verifier TEXT NOT NULL)');
    const marker = this.db.prepare('SELECT state,verifier FROM as_storage_meta WHERE id=1').get();
    const keyFile = path.join(path.dirname(this.file), 'as-storage.key');
    const dirStat = fs.statSync(path.dirname(keyFile));
    if (!dirStat.isDirectory() || (dirStat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && dirStat.uid !== process.getuid())) throw new Error('as: storage directory permissions are invalid');
    // Ownership excludes another publisher. Remove only our private, regular temporary key files.
    for (const name of fs.readdirSync(path.dirname(keyFile))) {
      if (!/^\.as-storage-key-[a-f0-9]{32}\.tmp$/.test(name)) continue;
      const temp = path.join(path.dirname(keyFile), name), stat = fs.lstatSync(temp);
      if (stat.isFile() && (stat.mode & 0o777) === 0o600 && (typeof process.getuid !== 'function' || stat.uid === process.getuid())) fs.unlinkSync(temp);
    }
    if (!fs.existsSync(keyFile)) {
      if (marker) throw new Error('as: storage key is missing');
      const temp = path.join(path.dirname(keyFile), `.as-storage-key-${randomBytes(16).toString('hex')}.tmp`);
      try {
        const fd = fs.openSync(temp, 'wx', 0o600);
        try { fs.writeFileSync(fd, randomBytes(32)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        // A hard link publishes a complete key atomically and never replaces an existing key.
        fs.linkSync(temp, keyFile);
        const dir = fs.openSync(path.dirname(keyFile), 'r');
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      } finally { fs.rmSync(temp, { force: true }); }
    }
    const stat = fs.lstatSync(keyFile);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || (dirStat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && (stat.uid !== process.getuid() || dirStat.uid !== process.getuid()))) throw new Error('as: storage key or directory permissions are invalid');
    this.key = fs.readFileSync(keyFile);
    if (this.key.length !== 32) throw new Error('as: storage key is invalid');
    // Recovery may see a complete link whose publication was interrupted before fsync.
    // Make that directory entry durable before committing any encrypted state.
    const keyDir = fs.openSync(path.dirname(keyFile), 'r');
    try { fs.fsyncSync(keyDir); } finally { fs.closeSync(keyDir); }
    if (marker) {
      if (this.#open(marker.verifier, 'verifier') !== 'dot-bridge storage v1') throw new Error('as: storage key is invalid');
      if (!['cleanup', 'ready'].includes(marker.state)) throw new Error('as: storage state is invalid');
    } else {
      this.tx(() => {
        for (const row of this.db.prepare('SELECT model,id,payload,uid,user_code FROM oidc').all()) {
          JSON.parse(row.payload);
          this.db.prepare('UPDATE oidc SET id=?,payload=?,uid=?,user_code=? WHERE model=? AND id=?').run(this.#id(row.model, row.id), this.#seal(row.payload, `oidc:${row.model}:${this.#id(row.model, row.id)}`), this.#lookup('uid', row.uid), this.#lookup('user_code', row.user_code), row.model, row.id);
        }
        for (const table of ['connections', 'pairings']) {
          const key = table === 'connections' ? 'connection_id' : 'code';
          for (const row of this.db.prepare(`SELECT ${key} AS id,resource FROM ${table}`).all()) this.db.prepare(`UPDATE ${table} SET resource=? WHERE ${key}=?`).run(this.#seal(row.resource, `${table}:${row.id}`), row.id);
        }
        this.db.prepare("INSERT INTO as_storage_meta VALUES(1,'cleanup',?)").run(this.#seal('dot-bridge storage v1', 'verifier'));
      });
    }
    // Validate all ciphertext at startup, even rows that are not currently in use.
    for (const row of this.db.prepare('SELECT model,id,payload FROM oidc').all()) JSON.parse(this.#open(row.payload, `oidc:${row.model}:${row.id}`));
    for (const table of ['connections', 'pairings']) {
      const key = table === 'connections' ? 'connection_id' : 'code';
      for (const row of this.db.prepare(`SELECT ${key} AS id,resource FROM ${table}`).all()) this.#open(row.resource, `${table}:${row.id}`);
    }
    if (!marker || marker.state === 'cleanup') {
      this.#checkpoint();
      this.db.exec('VACUUM');
      this.#checkpoint();
      this.db.prepare("UPDATE as_storage_meta SET state='ready' WHERE id=1").run();
      this.#checkpoint();
    }
  }
  #checkpoint() {
    const result = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (result.busy) throw new Error('as: storage checkpoint is busy');
  }
  #seal(value, context) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
  }
  #open(value, context) { return openAsValue(this.key, value, context); }
  #lookup(domain, value) { return value == null ? null : createHmac('sha256', this.key).update(domain).update('\0').update(value).digest('base64url'); }
  #id(model, id) { return ['Client', 'Grant', 'Interaction'].includes(model) ? id : this.#lookup(`id:${model}`, id); }
  #resource(row) { return row ? { ...row, resource: this.#open(row.resource, row.connection_id && !row.code ? `connections:${row.connection_id}` : `pairings:${row.code}`) } : row; }

  close() { this.db.close(); }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); this.db.exec('COMMIT'); return out; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  refreshReceipt(token) {
    const tokenId = this.#id('RefreshToken', token);
    const row = this.db.prepare('SELECT * FROM refresh_receipts WHERE token_id=?').get(tokenId);
    if (!row || row.deadline <= this.now()) return undefined;
    return { ...row, value: JSON.parse(this.#open(row.payload, `refresh-receipt:${row.grant_id}`)) };
  }
  refreshValid(grantId, clientId, successor) {
    const connection = this.connectionByGrant(grantId);
    const grant = this.find('Grant', grantId);
    const token = this.find('RefreshToken', successor);
    return !!(connection && connection.revoked_at === null && connection.client_id === clientId && grant &&
      grant.clientId === clientId && grant.exp * 1000 > Date.now() && token && !token.consumed && token.grantId === grantId && token.clientId === clientId && token.exp * 1000 > Date.now());
  }
  commitFailedRefresh(exchange) {
    this.tx(() => {
      for (const [model, id, original] of exchange.reads) {
        if (JSON.stringify(this.find(model, id)) !== original) throw new errors.InvalidGrant('refresh state changed');
      }
      for (const [op, model, id] of exchange.writes) if (op === 'consume') this.consume(model, id);
    });
  }
  commitRefresh(exchange, grantId, clientId, token, params, response, deadline) {
    this.tx(() => {
      for (const [model, id, original] of exchange.reads) {
        if (JSON.stringify(this.find(model, id)) !== original) throw new errors.InvalidGrant('refresh state changed');
      }
      const connection = this.connectionByGrant(grantId);
      const grant = this.find('Grant', grantId);
      if (!connection || connection.revoked_at !== null || connection.client_id !== clientId || !grant || grant.clientId !== clientId) throw new errors.InvalidGrant('grant inactive');
      for (const [op, model, id, payload, ttl] of exchange.writes) {
        if (op === 'consume') this.consume(model, id);
        else this.upsert(model, id, payload, ttl);
      }
      this.db.prepare('DELETE FROM refresh_receipts WHERE deadline<=? OR grant_id=?').run(this.now(), grantId);
      this.db.prepare('INSERT INTO refresh_receipts VALUES(?,?,?,?)').run(grantId, this.#id('RefreshToken', token), deadline,
        this.#seal(JSON.stringify({ clientId, params, response }), `refresh-receipt:${grantId}`));
    });
  }

  // ---- the oidc-provider adapter ---------------------------------------------------------------------------------
  upsert(model, id, payload, expiresIn) {
    const now = this.now();
    if (['Client', 'Interaction'].includes(model) && !this.db.prepare('SELECT 1 FROM oidc WHERE model=? AND id=?').get(model, this.#id(model, id))) {
      const window = this.window();
      // A request that was parsing during reset or stop/start must not recreate cleared state.
      if (!window || window.generation !== this.admission.getStore()) throw new errors.InvalidRequest('pairing window changed; retry', 403);
      if (model === 'Client' && this.clientCount() >= LIMITS.clients) throw new errors.InvalidClientMetadata('the client registration limit is reached');
      if (model === 'Interaction' && this.interactionsFull()) throw new errors.InvalidRequest('Too many connection attempts are waiting. Ask the owner to run dalan connect reset, then retry.', 503);
    }
    const expires = typeof expiresIn === 'number' ? now + (expiresIn + CLOCK_TOLERANCE_S) * 1000 : null;
    const grantId = GRANTABLE.includes(model) || model === 'Grant' ? payload.grantId ?? null : null;
    this.db.prepare(`INSERT INTO oidc(model,id,payload,grant_id,uid,user_code,consumed,created_at,expires_at) VALUES(?,?,?,?,?,?,NULL,?,?)
      ON CONFLICT(model,id) DO UPDATE SET payload=excluded.payload,grant_id=excluded.grant_id,uid=excluded.uid,user_code=excluded.user_code,expires_at=excluded.expires_at`)
      .run(model, this.#id(model, id), this.#seal(JSON.stringify(payload), `oidc:${model}:${this.#id(model, id)}`), grantId, this.#lookup('uid', payload.uid), this.#lookup('user_code', payload.userCode), now, expires);
  }
  #row(row) {
    if (!row || (row.expires_at !== null && row.expires_at <= this.now())) return undefined;
    const payload = JSON.parse(this.#open(row.payload, `oidc:${row.model}:${row.id}`));
    if (row.consumed) payload.consumed = row.consumed;
    return payload;
  }
  find(model, id) { return this.#row(this.db.prepare('SELECT * FROM oidc WHERE model=? AND id=?').get(model, this.#id(model, id))); }
  findBy(model, column, value) {
    if (!['uid', 'user_code'].includes(column)) throw new Error('bad column');
    return this.#row(this.db.prepare(`SELECT * FROM oidc WHERE model=? AND ${column}=?`).get(model, this.#lookup(column, value)));
  }
  // Compare-and-set: exactly one caller marks a record consumed. A second caller is a replay: the whole grant is revoked.
  consume(model, id) {
    const done = this.db.prepare('UPDATE oidc SET consumed=? WHERE model=? AND id=? AND consumed IS NULL').run(Math.floor(this.now() / 1000), model, this.#id(model, id));
    if (done.changes === 1) return;
    const row = this.db.prepare('SELECT grant_id FROM oidc WHERE model=? AND id=?').get(model, this.#id(model, id));
    if (row?.grant_id) this.revokeGrant(row.grant_id, 'replay');
    throw new errors.InvalidGrant(`${model === 'AuthorizationCode' ? 'authorization code' : 'refresh token'} already consumed`);
  }
  deleteByGrant(grantId, model) { this.db.prepare('DELETE FROM oidc WHERE grant_id=? AND model=?').run(grantId, model); }
  #revokeGrantRows(grantId, reason, now = this.now()) {
    this.db.prepare('DELETE FROM oidc WHERE grant_id=?').run(grantId);
    this.db.prepare("DELETE FROM oidc WHERE model='Grant' AND id=?").run(grantId);
    this.db.prepare('UPDATE connections SET revoked_at=?,revoked_reason=? WHERE grant_id=? AND revoked_at IS NULL').run(now, reason, grantId);
  }
  // The one revocation path: tokens, codes and the Grant record go, and the connection row is marked. Idempotent.
  revokeGrant(grantId, reason) {
    this.tx(() => this.#revokeGrantRows(grantId, reason));
    this.onGrantRevoked(grantId, reason);
  }
  addStaticClient(clientId, metadata) {
    const now = this.now();
    this.tx(() => {
      if (this.clientCount() >= LIMITS.clients) throw new Error('the client registration limit is reached');
      this.db.prepare('INSERT INTO oidc(model,id,payload,grant_id,uid,user_code,consumed,created_at,expires_at) VALUES(\'Client\',?,?,NULL,NULL,NULL,NULL,?,NULL)')
        .run(clientId, this.#seal(JSON.stringify(metadata), `oidc:Client:${clientId}`), now);
      this.db.prepare('INSERT INTO static_clients(client_id) VALUES(?)').run(clientId);
    });
    return now;
  }
  clientRows() {
    return this.db.prepare(`SELECT c.id AS client_id,c.payload,c.created_at,CASE WHEN s.client_id IS NULL THEN 0 ELSE 1 END AS is_static
      FROM oidc c LEFT JOIN static_clients s ON s.client_id=c.id WHERE c.model='Client' ORDER BY c.created_at,c.id`).all()
      .map(row => ({ ...row, metadata: JSON.parse(this.#open(row.payload, `oidc:Client:${row.client_id}`)) }));
  }
  removeStaticClient(clientId) {
    const grantIds = this.tx(() => {
      if (!this.db.prepare('SELECT 1 FROM static_clients WHERE client_id=?').get(clientId)) throw new Error('client is not a static client');
      const ids = new Set([
        ...this.db.prepare("SELECT id,payload FROM oidc WHERE model='Grant'").all().filter(row => JSON.parse(this.#open(row.payload, `oidc:Grant:${row.id}`)).clientId === clientId).map(row => row.id),
        ...this.db.prepare('SELECT grant_id AS id FROM connections WHERE client_id=? AND revoked_at IS NULL').all(clientId).map(row => row.id),
      ]);
      const now = this.now();
      for (const grantId of ids) this.#revokeGrantRows(grantId, 'client_removed', now);
      this.db.prepare("DELETE FROM oidc WHERE model='Interaction' AND id IN (SELECT uid FROM pairings WHERE client_id=?)").run(clientId);
      this.db.prepare("UPDATE pairings SET state='failed' WHERE client_id=? AND state IN ('pending','approving','approved')").run(clientId);
      this.db.prepare("DELETE FROM oidc WHERE model='Client' AND id=?").run(clientId);
      this.db.prepare('DELETE FROM static_clients WHERE client_id=?').run(clientId);
      return [...ids];
    });
    for (const grantId of grantIds) this.onGrantRevoked(grantId, 'client_removed');
    return { client_id: clientId, revoked_grants: grantIds.length };
  }
  purge() {
    const now = this.now();
    this.db.prepare('DELETE FROM refresh_receipts WHERE deadline<=?').run(now);
    const expired = this.db.prepare('DELETE FROM oidc WHERE expires_at IS NOT NULL AND expires_at<=?').run(now).changes;
    // Registered clients that never got a connection are dropped after a day: anonymous registration must not grow without bound.
    const stale = this.db.prepare(`DELETE FROM oidc WHERE model='Client' AND created_at<? AND id NOT IN (SELECT client_id FROM static_clients) AND id NOT IN (SELECT client_id FROM connections)
      AND id NOT IN (SELECT client_id FROM pairings WHERE state IN ('pending','approving','approved'))`).run(now - LIMITS.staleClientMs).changes;
    this.db.prepare("DELETE FROM pairings WHERE (state IN ('done','failed') OR expires_at<=?) AND created_at<?").run(now, now - 24 * 3600 * 1000);
    return { expired, stale_clients: stale };
  }
  clientCount() { return this.db.prepare("SELECT count(*) n FROM oidc WHERE model='Client'").get().n; }

  // ---- pairing window --------------------------------------------------------------------------------------------
  openWindow(worker, minutes) {
    const now = this.now(), open = this.window();
    if (open && open.worker !== worker) throw new Error(`a pairing window for ${open.worker} is open until ${new Date(open.expires_at).toISOString()}; stop it first`);
    if (open) this.db.prepare('UPDATE windows SET expires_at=? WHERE id=1').run(now + minutes * 60000);
    else this.db.prepare('INSERT INTO windows(id,worker,opened_at,expires_at,registrations,generation) VALUES(1,?,?,?,0,?) ON CONFLICT(id) DO UPDATE SET worker=excluded.worker,opened_at=excluded.opened_at,expires_at=excluded.expires_at,registrations=0,generation=excluded.generation')
      .run(worker, now, now + minutes * 60000, randomUUID());
    return this.window();
  }
  window() {
    const row = this.db.prepare('SELECT * FROM windows WHERE id=1').get();
    return row && row.expires_at > this.now() ? { ...row } : null;
  }
  // True when a window was opened and ran out; false when it is open, or was closed by the owner.
  windowExpired() {
    const row = this.db.prepare('SELECT expires_at FROM windows WHERE id=1').get();
    return Boolean(row) && row.expires_at <= this.now();
  }
  closeWindow() { return this.db.prepare('DELETE FROM windows').run().changes; }

  // Count attempts before reading DCR bodies, so concurrent and slow registrations cannot bypass the budget.
  reserveRegistration() {
    return this.db.prepare('UPDATE windows SET registrations=registrations+1 WHERE id=1 AND expires_at>? AND registrations<?')
      .run(this.now(), this.limits.registrations).changes === 1;
  }
  reset() {
    return this.tx(() => {
      const result = this.#purgeUnapproved();
      const clients = this.db.prepare(`DELETE FROM oidc WHERE model='Client' AND id NOT IN (SELECT client_id FROM static_clients)
        AND id NOT IN (SELECT client_id FROM connections)
        AND id NOT IN (SELECT client_id FROM pairings WHERE state IN ('approving','approved'))`).run().changes;
      this.db.prepare('UPDATE windows SET registrations=0,generation=? WHERE id=1').run(randomUUID());
      return { ...result, clients, window_open: !!this.window() };
    });
  }

  // ---- pairings --------------------------------------------------------------------------------------------------
  // Idempotent for one interaction: a page reload shows the same code.
  interactionsFull() { return this.db.prepare("SELECT count(*) n FROM oidc WHERE model='Interaction' AND expires_at>?").get(this.now()).n >= this.limits.interactions; }
  // Unapproved attempts (pending pairings and their interactions). Attempts being approved or already approved are kept.
  purgeUnapproved() { return this.tx(() => this.#purgeUnapproved()); }
  #purgeUnapproved() {
    // A done pairing still needs its Interaction until the browser follows the provider's resume redirect.
    const keep = "SELECT uid FROM pairings WHERE state IN ('approving','approved','done')";
    const interactions = this.db.prepare(`DELETE FROM oidc WHERE model='Interaction' AND id NOT IN (${keep})`).run().changes;
    const pairings = this.db.prepare("DELETE FROM pairings WHERE state='pending'").run().changes;
    return { interactions, pairings };
  }
  pairingFor(uid, snapshot, window) {
    const existing = this.db.prepare('SELECT * FROM pairings WHERE uid=?').get(uid);
    if (existing) return this.#resource(existing);
    const now = this.now();
    if (this.db.prepare("SELECT count(*) n FROM pairings WHERE state='pending' AND expires_at>?").get(now).n >= this.limits.interactions) throw new Error('too many pending pairings');
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
      try {
        this.db.prepare(`INSERT INTO pairings(code,uid,worker,client_id,client_name,redirect_uri,resource,scopes,created_at,expires_at,state)
          VALUES(?,?,?,?,?,?,?,?,?,?, 'pending')`).run(code, uid, window.worker, snapshot.client_id, snapshot.client_name, snapshot.redirect_uri, this.#seal(snapshot.resource, `pairings:${code}`), snapshot.scopes, now, Math.min(snapshot.interaction_expires_at, now + PAIRING_MINUTES * 60000));
        return this.#resource(this.db.prepare('SELECT * FROM pairings WHERE code=?').get(code));
      } catch (error) { if (!/UNIQUE/.test(String(error.message))) throw error; }
    }
    throw new Error('could not allocate a pairing code');
  }
  pairingByCode(code) { return this.#resource(this.db.prepare('SELECT * FROM pairings WHERE code=?').get(normalizeCode(code))); }
  pairingByUid(uid) { return this.#resource(this.db.prepare('SELECT * FROM pairings WHERE uid=?').get(uid)); }
  pendingPairings() {
    const now = this.now();
    return this.db.prepare("SELECT * FROM pairings WHERE state='pending' AND expires_at>? ORDER BY created_at").all(now).map(row => this.#resource(row));
  }
  // Atomic reservation: exactly one approval wins a pending code, and it reserves only that code.
  // A web pairing (https redirect) is refused while a newer web pairing at the same redirect origin is pending for the same worker:
  // an app that registered again abandons its older attempts, and a re-registration reaches the same origin. Other origins never displace it.
  // A native pairing (loopback redirect) is never refused for a newer attempt and never displaces another one: its
  // redirect names no party, so a newer registrant must not take the owner's approval from an older teammate.
  reserve(code) {
    return this.tx(() => {
      const now = this.now();
      const row = this.db.prepare("SELECT rowid AS rid, * FROM pairings WHERE code=? AND state='pending' AND expires_at>?").get(code, now);
      if (!row) return false;
      if (!isLoopbackCallback(new URL(row.redirect_uri))) {
        // Only a newer web pairing at the SAME redirect origin displaces this one. A client at another origin cannot starve it.
        const origin = new URL(row.redirect_uri).origin;
        const newer = this.db.prepare("SELECT redirect_uri FROM pairings WHERE state='pending' AND expires_at>? AND worker=? AND rowid<>? AND (created_at>? OR (created_at=? AND rowid>?))")
          .all(now, row.worker, row.rid, row.created_at, row.created_at, row.rid);
        if (newer.some(p => !isLoopbackCallback(new URL(p.redirect_uri)) && new URL(p.redirect_uri).origin === origin)) return false;
      }
      return this.db.prepare("UPDATE pairings SET state='approving' WHERE code=? AND state='pending'").run(code).changes === 1;
    });
  }
  failPairing(code) { this.db.prepare("UPDATE pairings SET state='failed' WHERE code=? AND state='approving'").run(code); }
  // One transaction: the pairing becomes approved, the connection row appears, and (with replace) the old connection ends.
  commitApproval({ code, worker, grantId, snapshot, replace }) {
    return this.tx(() => {
      const now = this.now();
      // Removal and approval serialize here, so a delayed approval cannot recreate a connection after client removal.
      if (!this.db.prepare("SELECT 1 FROM oidc WHERE model='Client' AND id=?").get(snapshot.client_id)) throw new Error('client was removed');
      let replaced = null;
      const active = this.db.prepare('SELECT * FROM connections WHERE worker=? AND revoked_at IS NULL').get(worker);
      if (active) {
        if (!replace) throw new Error(`worker ${worker} already has an active connection. Approving with --replace ends it and gives the new client every queued and future job for worker ${worker}, including briefs approved before the switch. Approve only a code you started yourself`);
        this.db.prepare("UPDATE connections SET revoked_at=?,revoked_reason='replaced' WHERE connection_id=?").run(now, active.connection_id);
        replaced = this.#resource(active);
      }
      const connectionId = randomUUID();
      this.db.prepare('INSERT INTO connections(connection_id,worker,grant_id,client_id,redirect_uri,resource,scopes,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(connectionId, worker, grantId, snapshot.client_id, snapshot.redirect_uri, this.#seal(snapshot.resource, `connections:${connectionId}`), snapshot.scopes, now);
      const done = this.db.prepare("UPDATE pairings SET state='approved',grant_id=?,connection_id=? WHERE code=? AND state='approving'").run(grantId, connectionId, code);
      if (done.changes !== 1) throw new Error('pairing is no longer being approved');
      return { connection_id: connectionId, replaced };
    });
  }
  // The browser completes an approved pairing exactly once.
  finishPairing(uid) {
    return this.db.prepare("UPDATE pairings SET state='done' WHERE uid=? AND state='approved'").run(uid).changes === 1;
  }

  // ---- connections -----------------------------------------------------------------------------------------------
  connectionByGrant(grantId) { return this.#resource(this.db.prepare('SELECT * FROM connections WHERE grant_id=?').get(grantId)); }
  activeConnection(worker) { return this.#resource(this.db.prepare('SELECT * FROM connections WHERE worker=? AND revoked_at IS NULL').get(worker)); }
  connectionIsLive(connectionId) {
    if(typeof connectionId!=='string'||!connectionId) return false;
    const connection=this.db.prepare('SELECT worker,grant_id,revoked_at FROM connections WHERE connection_id=?').get(connectionId);
    if(!connection||connection.revoked_at!==null) return false;
    const active=this.activeConnection(connection.worker);
    if(active?.connection_id!==connectionId||active.grant_id!==connection.grant_id) return false;
    const grant=this.db.prepare("SELECT expires_at FROM oidc WHERE model='Grant' AND id=?").get(connection.grant_id);
    return !!grant&&(grant.expires_at===null||grant.expires_at>this.now());
  }
  liveConnectionIds(worker) {
    return this.db.prepare('SELECT connection_id FROM connections WHERE worker=? AND revoked_at IS NULL ORDER BY connection_id').all(worker)
      .map(row=>row.connection_id).filter(id=>this.connectionIsLive(id));
  }
  connections() { return this.db.prepare('SELECT * FROM connections ORDER BY created_at').all().map(row => this.#resource(row)); }
}

export { showCode };
