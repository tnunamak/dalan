#!/usr/bin/env node
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';

const store=new Store(':memory:');
assert.equal(typeof store.insertConfinedCheckAssignment,'function','the Store owns the confined runner assignment insert');
const payload={inputs:[{github_repo:'integrator/local',base_sha:'0'.repeat(40)}],execution_scope:'implementation'};
const row=store.insertConfinedCheckAssignment('integrator_test_assignment',payload);
assert.equal(row.request_id,'integrator_test_assignment');
assert.equal(row.status,'running');
assert.equal(row.thread_id,'integrator');
assert.equal(row.environment_id,'integrator');
assert.equal(row.payload_hash.length,64);
// The row belongs to the integrator, not to any worker. The reserved name "unknown" cannot be a worker name, so no
// worker can list, claim or count it, and no schema default decides its owner.
assert.equal(row.target_worker,'unknown');
assert.equal(store.db.prepare("SELECT count(*) n FROM assignments WHERE target_worker='dot'").get().n,0);
assert.deepEqual(JSON.parse(row.payload),payload);
assert.equal(store.db.prepare('SELECT count(*) AS count FROM assignments WHERE request_id=?').get(row.request_id).count,1);
store.db.close();
console.log('confined-check-assignment-store-test: the runner assignment uses a Store-owned insert');
