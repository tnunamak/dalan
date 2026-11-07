// Durable mutation facts only. Workspace owns bytes and native metadata.
// Call migrateArtifactJournal in the parent's schema migration transaction.
// Every mutation requires the parent's transaction and a synchronous authority check.
import { createHash } from 'node:crypto';

const fail = code => { throw Object.assign(new Error(code), {code}); };
const text = v => typeof v === 'string' && v.length > 0 && v.length <= 512;
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const integer = v => Number.isSafeInteger(v) && v >= 0;
function canonical(v) {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (Array.isArray(v)) return v.map(canonical);
  if (v && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  }
  fail('invalid_json');
}
const json = v => JSON.stringify(canonical(v));
export function migrateArtifactJournal(db) {
  if (!db.isTransaction) fail('transaction_required');
  db.exec(`CREATE TABLE IF NOT EXISTS artifact_mutation_journal (
    job TEXT NOT NULL, artifact TEXT NOT NULL, mutation_key TEXT NOT NULL,
    identity TEXT NOT NULL, result TEXT NOT NULL,
    PRIMARY KEY(job, artifact, mutation_key));
  CREATE TABLE IF NOT EXISTS artifact_journal_heads (
    job TEXT NOT NULL, artifact TEXT NOT NULL, reference TEXT NOT NULL,
    origin_claim TEXT NOT NULL, origin_epoch INTEGER NOT NULL,
    size INTEGER NOT NULL, sha256 TEXT, sealed INTEGER NOT NULL,
    PRIMARY KEY(job, artifact));`);
}
export function createArtifactJournal({db, authorize, inspect}) {
  if (typeof authorize !== 'function' || typeof inspect !== 'function') fail('callbacks_required');
  const head = (job, artifact) => {
    const row = db.prepare('SELECT * FROM artifact_journal_heads WHERE job=? AND artifact=?').get(job, artifact);
    return row ? {...row, sealed:!!row.sealed} : null;
  };
  function record(command) {
    if (!db.isTransaction) fail('transaction_required');
    const {job, artifact, key, subject, worker, claim, epoch, operation, size, sha256, reference} = command;
    if (![job,artifact,key,subject,worker,claim,reference].every(text) ||
        !Number.isSafeInteger(epoch) || epoch < 1 ||
        !['upload','seal','upload_seal'].includes(operation) || !integer(size) || !digest(sha256)) fail('invalid_mutation');
    // Authority must be checked even for exact replay and inherited seals.
    if (authorize({job,subject,worker,claim,epoch,operation}) !== true) fail('stale_authority');
    const identity = json(command);
    const prior = db.prepare('SELECT identity,result FROM artifact_mutation_journal WHERE job=? AND artifact=? AND mutation_key=?').get(job,artifact,key);
    if (prior) {
      if (prior.identity !== identity) fail('mutation_conflict');
      return JSON.parse(prior.result);
    }
    const previous = head(job,artifact);
    if (previous?.sealed) fail('artifact_sealed');
    if (previous && (previous.origin_claim !== claim || previous.origin_epoch !== epoch ||
        previous.reference !== reference)) fail('artifact_binding_mismatch');
    const uploads=operation==='upload'||operation==='upload_seal';
    if (uploads) {
      if (!integer(command.offset) || !integer(command.chunkSize) || !digest(command.chunkSha256) ||
          command.offset !== (previous?.size ?? 0) || command.offset + command.chunkSize !== size) fail('invalid_chunk_extent');
    } else if (!previous || previous.size !== size || previous.sha256 !== sha256) fail('seal_extent_mismatch');
    // inspect reads the native, durable file; never accept caller attestations.
    const observed = inspect({job,artifact,reference,offset:command.offset,chunkSize:command.chunkSize});
    if (!observed || observed.reference !== reference || observed.size !== size || observed.sha256 !== sha256 ||
        (uploads && observed.chunkSha256 !== command.chunkSha256)) fail('artifact_integrity_mismatch');
    const result = {artifact,reference,size,sha256,sealed:operation !== 'upload',
      origin_claim:previous?.origin_claim ?? claim, origin_epoch:previous?.origin_epoch ?? epoch};
    db.prepare(`INSERT INTO artifact_journal_heads(job,artifact,reference,origin_claim,origin_epoch,size,sha256,sealed)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(job,artifact) DO UPDATE SET size=excluded.size,sha256=excluded.sha256,sealed=excluded.sealed`)
      .run(job,artifact,reference,result.origin_claim,result.origin_epoch,size,sha256,Number(result.sealed));
    db.prepare('INSERT INTO artifact_mutation_journal VALUES(?,?,?,?,?)').run(job,artifact,key,identity,json(result));
    return result;
  }
  return {record, get:head};
}
export const artifactBytesDigest = bytes => createHash('sha256').update(bytes).digest('hex');
