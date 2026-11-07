#!/usr/bin/env node
// A lost final pairing CAS must roll back replacement of the old connection and insertion of the new one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AsStore } from '../src/as-store.mjs';

const temp = new URL('../.test-home/', import.meta.url);
fs.mkdirSync(temp, { recursive: true });
const home = fs.mkdtempSync(path.join(temp.pathname, 'approval-rollback-'));
const file = path.join(home, 'as.sqlite');
let store = new AsStore(file);
const snapshot = { client_id: 'client', client_name: 'fixture', redirect_uri: 'https://vendor.example/cb', resource: 'https://bridge.example/mcp', scopes: 'dot-bridge.read', interaction_expires_at: Date.now() + 600000 };
try {
  // Approval requires the client to exist (removal and approval serialize in commitApproval).
  store.addStaticClient(snapshot.client_id, { client_id: snapshot.client_id, redirect_uris: [snapshot.redirect_uri], token_endpoint_auth_method: 'none' });
  const window = store.openWindow('lark', 5);
  const first = store.pairingFor('interaction-first', snapshot, window);
  assert.equal(store.reserve(first.code), true);
  const original = store.commitApproval({ code: first.code, worker: 'lark', grantId: 'old-grant', snapshot, replace: false });
  const next = store.pairingFor('interaction-next', snapshot, window);
  // Model a pairing invalidated before the final commit, after the owner operation had already reserved it.
  assert.equal(store.reserve(next.code), true);
  store.failPairing(next.code);
  const before = store.connections().map(row => ({ ...row }));
  assert.throws(() => store.commitApproval({ code: next.code, worker: 'lark', grantId: 'new-grant', snapshot, replace: true }), /pairing is no longer being approved/);
  store.close(); store = new AsStore(file);
  assert.deepEqual(store.connections().map(row => ({ ...row })), before, 'failed final CAS committed no connection changes');
  assert.equal(store.activeConnection('lark').connection_id, original.connection_id, 'old connection remains active after restart');
  assert.equal(store.pairingByCode(next.code).state, 'failed');
  // A real successful replacement remains possible after the failed transaction.
  const retry = store.pairingFor('interaction-retry', snapshot, store.window());
  assert.equal(store.reserve(retry.code), true);
  const replaced = store.commitApproval({ code: retry.code, worker: 'lark', grantId: 'retry-grant', snapshot, replace: true });
  assert.equal(replaced.replaced.connection_id, original.connection_id);
  assert.equal(store.activeConnection('lark').connection_id, replaced.connection_id);
  console.log('PASS failed approval replacement rolls back both connection writes; restart and later replacement work');
} finally { store.close(); fs.rmSync(home, { recursive: true, force: true }); }
