import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { prepareT3Audit, initT3Audit, appendT3Audit, listT3Audit } from '../src/t3-audit.mjs';

const db = new DatabaseSync(':memory:');
initT3Audit(db);
const entry = prepareT3Audit('t3_thread_send', {
  threadId: 'thread-1', provider: 'claudeAgent', model: 'claude-haiku-4-5',
  wakeSettled: true, message: 'hello secret world',
});
appendT3Audit(db, entry, 'fixture-subject', 'started');
appendT3Audit(db, entry, 'fixture-subject', 'success', { threadId: 'thread-1', messageId: 'msg-1' });
const rows = listT3Audit(db);
assert.equal(rows.length, 2);
assert.deepEqual(rows.map(row => row.result_status), ['success', 'started']);
assert.equal(rows[0].args_summary.message, undefined);
assert.equal(rows[0].args_summary.wakeSettled, true);
assert.equal(rows[0].text_preview, null);
assert.equal(rows[0].text_sha256, createHash('sha256').update('hello secret world').digest('hex'));
assert.deepEqual(rows[0].t3_ids.messageIds, ['msg-1']);
const equivalentOffset = new Date(Date.parse(rows[0].at) + 2*60*60*1000).toISOString().replace('Z', '+02:00');
assert(listT3Audit(db, equivalentOffset).some(row => row.id === rows[0].id));
assert.throws(() => db.exec('DELETE FROM t3_audit'), /append-only/);
assert.throws(() => db.exec("UPDATE t3_audit SET subject='other'"), /append-only/);
console.log('PASS append-only T3 audit rows, text digest, argument summary and IDs');
