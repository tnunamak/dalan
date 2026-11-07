import { createServer, request as requestHttp, validateHeaderValue } from 'node:http';
import { request as requestHttps } from 'node:https';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const defaults = { deadlineMs: 5 * 60_000, clearMs: 15 * 60_000, reminderMs: 2 * 60 * 60_000, tickMs: 10_000, retryMs: 60_000 };
const digest = value => createHash('sha256').update(value).digest();
const safeTokenEqual = (token, expectedHash) => timingSafeEqual(digest(token), expectedHash);
const preSendCodes = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

function safePreSendCode(error) {
  const pending = [error], seen = new Set();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (preSendCodes.has(value.code)) return value.code.toLowerCase();
    if (value.cause) pending.push(value.cause);
    if (Array.isArray(value.errors)) pending.push(...value.errors);
  }
  return null;
}

function isLoopback(hostname) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
}

function tlsConfigurationCode(error) {
  if(error?.transportReady===true) return null;
  const codes=new Set(['EPROTO','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_GET_ISSUER_CERT','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
  const pending=[error],seen=new Set();
  while(pending.length) {
    const value=pending.pop();
    if(!value||typeof value!=='object'||seen.has(value)) continue;
    seen.add(value);
    if(codes.has(value.code)||/^(CERT_|ERR_TLS_|ERR_SSL_)/.test(value.code??'')) return value.code.toLowerCase();
    if(value.cause)pending.push(value.cause);
    if(Array.isArray(value.errors))pending.push(...value.errors);
  }
  return null;
}

function publisherFromEnv(env) {
  const url = env.DOT_DEADMAN_NTFY_URL;
  if (!url) return null;
  let parsed;
  try { parsed=new URL(url); } catch { throw new Error('invalid dead-man publisher URL'); }
  if(parsed.username||parsed.password) throw new Error('dead-man publisher URL must not contain credentials');
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback(parsed.hostname))) throw new Error('dead-man publisher must use HTTPS');
  const token = env.DOT_DEADMAN_NTFY_TOKEN;
  if(token) {
    try {
      if(/[\x00-\x1f\x7f]/.test(token)) throw new Error();
      validateHeaderValue('Authorization',`Bearer ${token}`);
    } catch { throw new Error('invalid dead-man publisher authorization token'); }
  }
  return (title, message) => new Promise((resolve,reject) => {
    const headers = { Title: title, 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(message) };
    if (token) headers.Authorization = `Bearer ${token}`;
    let transportReady=false,settled=false,req;
    const fail=error => {
      if(settled)return;
      settled=true;
      clearTimeout(deadline);
      error.transportReady=transportReady;
      reject(error);
      req?.destroy();
    };
    const deadline=setTimeout(() => {
      const error=new Error('publisher total timeout after 5000ms');
      error.code='DOT_PUBLISH_TIMEOUT';
      fail(error);
    },5000);
    const request=parsed.protocol==='https:'?requestHttps:requestHttp;
    try {
      req=request(parsed,{ method:'POST',headers,agent:false },res => {
        if(settled){res.destroy();return;}
        settled=true;
        clearTimeout(deadline);
        const status=res.statusCode;
        resolve(status>=200&&status<300?{accepted:true}:{status});
        res.destroy();
      });
      req.on('socket',socket => {
        socket.once(parsed.protocol==='https:'?'secureConnect':'connect',() => {transportReady=true;});
      });
      req.on('error',fail);
      req.end(message);
    } catch(error) { fail(error); }
  });
}

export class Deadman {
  constructor({ dbFile, token, publisher = null, now = Date.now, elapsedNow = () => performance.now(), ...config }) {
    if (typeof token !== 'string' || token.length < 32) throw new Error('dead-man bearer token must contain at least 32 characters');
    this.tokenHash = digest(token);
    this.now = now;
    this.elapsedNow = elapsedNow;
    this.config = { ...defaults, ...config };
    for (const key of ['deadlineMs', 'clearMs', 'reminderMs', 'tickMs', 'retryMs']) {
      if (!Number.isInteger(this.config[key]) || this.config[key] < 1) throw new Error(`invalid ${key}`);
    }
    this.publisher = publisher;
    fs.mkdirSync(path.dirname(dbFile), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbFile);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS monitor (id INTEGER PRIMARY KEY CHECK(id=1), started_at INTEGER NOT NULL, logical_now INTEGER NOT NULL, wall_at INTEGER NOT NULL, last_heartbeat_at INTEGER, active_episode_id INTEGER, recovery_since INTEGER);
      CREATE TABLE IF NOT EXISTS episodes (id INTEGER PRIMARY KEY AUTOINCREMENT, opened_at INTEGER NOT NULL, closed_at INTEGER, initial_state TEXT NOT NULL DEFAULT 'pending', initial_sent_at INTEGER, reminder_state TEXT NOT NULL DEFAULT 'waiting', next_attempt_at INTEGER NOT NULL DEFAULT 0, uncertain_at INTEGER, last_error TEXT, initial_publication_id TEXT, reminder_publication_id TEXT, initial_receipt_hash TEXT, reminder_receipt_hash TEXT);
      `);
    const columns=new Set(this.db.prepare("SELECT name FROM pragma_table_info('episodes')").all().map(row=>row.name));
    for(const name of ['initial_publication_id','reminder_publication_id','initial_receipt_hash','reminder_receipt_hash'])
      if(!columns.has(name))this.db.exec(`ALTER TABLE episodes ADD COLUMN ${name} TEXT`);
    this.db.exec(`
      UPDATE episodes SET initial_state='uncertain',uncertain_at=unixepoch('subsec') * 1000,last_error='process ended during publish' WHERE initial_state='sending';
      UPDATE episodes SET reminder_state='uncertain',last_error='process ended during publish' WHERE reminder_state='sending';
      UPDATE episodes SET initial_state='pending',next_attempt_at=0 WHERE initial_state='configuration_error';
      UPDATE episodes SET reminder_state='waiting',next_attempt_at=0 WHERE reminder_state='configuration_error';`);
    for(const row of this.db.prepare('SELECT id,initial_publication_id,reminder_publication_id FROM episodes').all())
      this.db.prepare('UPDATE episodes SET initial_publication_id=COALESCE(initial_publication_id,?),reminder_publication_id=COALESCE(reminder_publication_id,?) WHERE id=?')
        .run(randomUUID(),randomUUID(),row.id);
    const wallAtStart = this.now(), elapsedAtStart = this.elapsedNow();
    this.db.prepare('INSERT OR IGNORE INTO monitor(id,started_at,logical_now,wall_at) VALUES(1,?,?,?)').run(wallAtStart, wallAtStart, wallAtStart);
    const previous = this.#row();
    this.logicalAtStart = previous.logical_now + Math.max(0, wallAtStart - previous.wall_at);
    this.elapsedAtStart = elapsedAtStart;
    this.receivedHeartbeatSinceStart = false;
    this.db.prepare('UPDATE monitor SET logical_now=?,wall_at=? WHERE id=1').run(this.logicalAtStart, Math.max(previous.wall_at, wallAtStart));
    this.tickPromise = Promise.resolve();
    this.timer = null;
    this.server = null;
  }

  #row() { return this.db.prepare('SELECT * FROM monitor WHERE id=1').get(); }
  #episode(id) { return this.db.prepare('SELECT * FROM episodes WHERE id=?').get(id); }

  #effectiveNow() {
    const monitor = this.#row();
    const elapsed = Math.max(0, this.elapsedNow() - this.elapsedAtStart);
    const logicalNow = this.logicalAtStart + elapsed;
    this.db.prepare('UPDATE monitor SET logical_now=?,wall_at=? WHERE id=1').run(logicalNow, Math.max(monitor.wall_at, this.now()));
    return logicalNow;
  }

  #transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  async heartbeat(token, body) {
    if (typeof token !== 'string' || !safeTokenEqual(token, this.tokenHash)) return { status: 401, body: { error: 'unauthorized' } };
    if (!body || body.healthy !== true || Object.keys(body).some(key => key !== 'healthy')) return { status: 400, body: { error: 'expected {"healthy":true}' } };
    await this.tick();
    const at = this.#effectiveNow();
    this.db.prepare('UPDATE monitor SET last_heartbeat_at=? WHERE id=1').run(at);
    this.receivedHeartbeatSinceStart = true;
    await this.tick();
    return { status: 202, body: { accepted: true } };
  }

  async tick() {
    const next = this.tickPromise.then(() => this.#advance());
    this.tickPromise = next.catch(() => {});
    return next;
  }

  async #advance() {
    const now = this.#effectiveNow();
    let monitor = this.#row();
    const base = monitor.last_heartbeat_at ?? monitor.started_at;
    const timely = monitor.last_heartbeat_at !== null && now >= monitor.last_heartbeat_at && now - monitor.last_heartbeat_at <= this.config.deadlineMs;
    const startupGraceDone = this.receivedHeartbeatSinceStart || this.elapsedNow() - this.elapsedAtStart >= this.config.deadlineMs;
    if (!monitor.active_episode_id && startupGraceDone && now - base > this.config.deadlineMs) {
      const opened = base + this.config.deadlineMs;
      this.#transaction(() => {
        const result = this.db.prepare('INSERT INTO episodes(opened_at,initial_publication_id,reminder_publication_id) VALUES(?,?,?)')
          .run(opened,randomUUID(),randomUUID());
        this.db.prepare('UPDATE monitor SET active_episode_id=?,recovery_since=NULL WHERE id=1').run(Number(result.lastInsertRowid));
      });
      monitor = this.#row();
    }
    if (monitor.active_episode_id) {
      if (timely) {
        this.db.prepare('UPDATE monitor SET recovery_since=COALESCE(recovery_since,?) WHERE id=1').run(now);
        monitor = this.#row();
        if (now - monitor.recovery_since >= this.config.clearMs) {
          this.#transaction(() => {
            this.db.prepare(`UPDATE episodes SET closed_at=?,
              initial_state=CASE WHEN initial_state='pending' THEN 'suppressed_recovered' ELSE initial_state END,
              reminder_state=CASE WHEN reminder_state='waiting' THEN 'suppressed_recovered' ELSE reminder_state END
              WHERE id=?`).run(now, monitor.active_episode_id);
            this.db.prepare('UPDATE monitor SET active_episode_id=NULL,recovery_since=NULL WHERE id=1').run();
          });
          monitor = this.#row();
        }
      } else {
        this.db.prepare('UPDATE monitor SET recovery_since=NULL WHERE id=1').run();
        monitor = this.#row();
      }
    }
    const episode = monitor.active_episode_id ? this.#episode(monitor.active_episode_id) : null;
    if (!episode || !this.publisher) return;
    if (episode.initial_state === 'pending' && now >= episode.next_attempt_at) {
      const result = await this.#publish(episode.id, 'initial', episode.initial_publication_id, 'Dalan host heartbeat missed', 'The external dot-deadman monitor has not received a timely health heartbeat. Check the bridge host and network.');
      if (result.state === 'sent') this.db.prepare("UPDATE episodes SET initial_state='sent',initial_sent_at=?,reminder_state='waiting',last_error=NULL WHERE id=? AND initial_state='sending'").run(now, episode.id);
      else if (result.state === 'safe_failure') this.db.prepare("UPDATE episodes SET initial_state='pending',next_attempt_at=?,last_error=? WHERE id=? AND initial_state='sending'").run(now + this.config.retryMs, result.reason, episode.id);
      else if (result.state === 'configuration_error') this.db.prepare("UPDATE episodes SET initial_state='configuration_error',last_error=? WHERE id=? AND initial_state='sending'").run(result.reason, episode.id);
      else this.db.prepare("UPDATE episodes SET initial_state='uncertain',uncertain_at=?,last_error='publisher outcome uncertain' WHERE id=? AND initial_state='sending'").run(now, episode.id);
      return;
    }
    const fresh = this.#episode(episode.id);
    if (fresh.initial_state === 'sent' && fresh.reminder_state === 'waiting' && now >= fresh.next_attempt_at && now - fresh.initial_sent_at >= this.config.reminderMs) {
      const result = await this.#publish(episode.id, 'reminder', fresh.reminder_publication_id, 'Dalan still unreachable', 'The Dalan heartbeat is still unresolved two hours after the initial alert.');
      if (result.state === 'sent') this.db.prepare("UPDATE episodes SET reminder_state='sent',last_error=NULL WHERE id=? AND reminder_state='sending'").run(episode.id);
      else if (result.state === 'safe_failure') this.db.prepare("UPDATE episodes SET reminder_state='waiting',next_attempt_at=?,last_error=? WHERE id=? AND reminder_state='sending'").run(now + this.config.retryMs, result.reason, episode.id);
      else if (result.state === 'configuration_error') this.db.prepare("UPDATE episodes SET reminder_state='configuration_error',last_error=? WHERE id=? AND reminder_state='sending'").run(result.reason, episode.id);
      else this.db.prepare("UPDATE episodes SET reminder_state='uncertain',uncertain_at=?,last_error='publisher reminder outcome uncertain' WHERE id=? AND reminder_state='sending'").run(now, episode.id);
    }
  }

  async #publish(id, kind, publicationId, title, message) {
    const column = kind === 'initial' ? 'initial_state' : 'reminder_state';
    this.db.prepare(`UPDATE episodes SET ${column}='sending' WHERE id=?`).run(id);
    try {
      const result = await this.publisher(title, `${message}\nDelivery reference: ${publicationId}`, publicationId);
      if (result?.accepted === true) return { state: 'sent' };
      if (Number.isInteger(result?.status) && result.status >= 300 && result.status < 400) return { state: 'configuration_error', reason: `publisher_redirect_http_${result.status}` };
      if (Number.isInteger(result?.status) && result.status >= 400 && result.status < 500) return { state: 'safe_failure', reason: `publisher_http_${result.status}` };
      return { state: 'uncertain' };
    } catch (error) {
      if(error?.transportReady===true) return { state:'uncertain' };
      const configurationCode=tlsConfigurationCode(error);
      if(configurationCode) return { state:'configuration_error',reason:`publisher_tls_${configurationCode}` };
      const code = error?.code==='DOT_PUBLISH_TIMEOUT'&&error.transportReady===false?'timeout':safePreSendCode(error)??(error?.transportReady===false?'before_transport_ready':null);
      return code ? { state: 'safe_failure', reason: `publisher_connect_${code}` } : { state: 'uncertain' };
    }
  }

  async start({ host = '127.0.0.1', port = 8788 } = {}) {
    await this.tick();
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.config.tickMs);
    this.timer.unref();
    this.server = createServer(async (req, res) => {
      if (req.method !== 'POST' || !['/heartbeat','/reconcile'].includes(req.url)) return this.#reply(res, 404, { error: 'not found' });
      const authorization = req.headers.authorization || '';
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!token || !safeTokenEqual(token, this.tokenHash)) return this.#reply(res, 401, { error: 'unauthorized' });
      let raw = '';
      try {
        for await (const chunk of req) {
          raw += chunk.toString('utf8');
          if (Buffer.byteLength(raw) > 1024) { req.destroy(); return; }
        }
        const body=JSON.parse(raw);
        if(req.url==='/heartbeat') {
          const result=await this.heartbeat(token,body);
          this.#reply(res,result.status,result.body);
        } else {
          const episode=this.reconcilePublication(body);
          this.#reply(res,200,{episode_id:episode.id,phase:body.phase,state:body.phase==='initial'?episode.initial_state:episode.reminder_state});
        }
      } catch {
        if (!res.headersSent && !res.destroyed) this.#reply(res, req.url==='/reconcile'?409:400, { error: req.url==='/reconcile'?'reconciliation refused':'invalid request' });
      }
    });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, host, resolve); });
    return this.server.address();
  }

  #reply(res, status, body) {
    const bytes = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bytes), 'cache-control': 'no-store' });
    res.end(bytes);
  }

  status() {
    const monitor = this.#row();
    const episodes = this.db.prepare('SELECT * FROM episodes ORDER BY id').all();
    return { last_heartbeat_at: monitor.last_heartbeat_at, active_episode_id: monitor.active_episode_id, recovery_since: monitor.recovery_since, episodes };
  }

  reconcilePublication({episodeId,phase,outcome,receipt}) {
    if(!Number.isSafeInteger(episodeId)||episodeId<1||!['initial','reminder'].includes(phase)||
      !['sent','unsent'].includes(outcome)||typeof receipt!=='string'||!receipt.trim()||receipt.length>512)
      throw new Error('invalid publication reconciliation');
    return this.#transaction(()=>{
      const episode=this.#episode(episodeId);
      if(!episode)throw new Error('dead-man episode not found');
      const stateColumn=phase==='initial'?'initial_state':'reminder_state';
      if(episode[stateColumn]!=='uncertain')throw new Error('publication is not uncertain');
      const receiptColumn=phase==='initial'?'initial_receipt_hash':'reminder_receipt_hash';
      const receiptHash=digest(receipt.trim()).toString('hex');
      if(phase==='initial') {
        if(outcome==='sent') this.db.prepare("UPDATE episodes SET initial_state='sent',initial_sent_at=COALESCE(initial_sent_at,?),initial_receipt_hash=?,uncertain_at=NULL,last_error='operator reconciled publication' WHERE id=? AND initial_state='uncertain'").run(this.#effectiveNow(),receiptHash,episodeId);
        else if(episode.closed_at!==null) this.db.prepare("UPDATE episodes SET initial_state='suppressed_recovered',initial_receipt_hash=?,uncertain_at=NULL,last_error='operator confirmed publication absent after recovery' WHERE id=? AND initial_state='uncertain'").run(receiptHash,episodeId);
        else this.db.prepare("UPDATE episodes SET initial_state='pending',next_attempt_at=?,initial_receipt_hash=?,uncertain_at=NULL,last_error='operator confirmed publication absent' WHERE id=? AND initial_state='uncertain'").run(this.#effectiveNow(),receiptHash,episodeId);
      } else if(outcome==='sent') this.db.prepare("UPDATE episodes SET reminder_state='sent',reminder_receipt_hash=?,last_error='operator reconciled reminder' WHERE id=? AND reminder_state='uncertain'").run(receiptHash,episodeId);
      else if(episode.closed_at!==null) this.db.prepare("UPDATE episodes SET reminder_state='suppressed_recovered',reminder_receipt_hash=?,last_error='operator confirmed reminder absent after recovery' WHERE id=? AND reminder_state='uncertain'").run(receiptHash,episodeId);
      else this.db.prepare("UPDATE episodes SET reminder_state='waiting',next_attempt_at=?,reminder_receipt_hash=?,last_error='operator confirmed reminder absent' WHERE id=? AND reminder_state='uncertain'").run(this.#effectiveNow(),receiptHash,episodeId);
      return this.#episode(episodeId);
    });
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    if (this.server) await new Promise(resolve => this.server.close(resolve));
    await this.tickPromise;
    this.db.close();
  }
}

export function createDeadmanFromEnv(env = process.env) {
  const token = env.DOT_DEADMAN_TOKEN;
  const dbFile = env.DOT_DEADMAN_DB || '/var/lib/dot-deadman/deadman.sqlite';
  return new Deadman({ dbFile, token, publisher: publisherFromEnv(env) });
}

export function readDeadmanStatus(dbFile) {
  const db=new DatabaseSync(dbFile,{readOnly:true});
  try {
    const monitor=db.prepare('SELECT * FROM monitor WHERE id=1').get();
    const episodes=db.prepare('SELECT * FROM episodes ORDER BY id').all();
    if(!monitor)throw new Error('dead-man monitor is not initialized');
    return {last_heartbeat_at:monitor.last_heartbeat_at,active_episode_id:monitor.active_episode_id,
      recovery_since:monitor.recovery_since,episodes};
  } finally {db.close();}
}
