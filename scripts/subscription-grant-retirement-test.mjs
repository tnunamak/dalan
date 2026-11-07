#!/usr/bin/env node
// Runtime grant loss retires every callback of that connection, while preserving a peer's callbacks and delivery rows.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AsStore } from '../src/as-store.mjs';
import { Store } from '../src/store.mjs';
import { parseWorkers } from '../src/workers.mjs';

const temp = new URL('../.test-home/', import.meta.url);
fs.mkdirSync(temp, { recursive: true });
const home = fs.mkdtempSync(path.join(temp.pathname, 'grant-retirement-'));
let now = 1800000000000;
const as = new AsStore(path.join(home, 'as.sqlite'), { now: () => now });
const workers = parseWorkers({ workers: { dot: {}, lark: {} } }, { builtin: true });
const store = new Store(path.join(home, 'bridge.db'), { workers, now: () => now, connectionIsLive: id => as.connectionIsLive(id) });
try {
  const connections = {};
  for (const worker of ['lark', 'dot']) {
    const snapshot = { client_id: `client-${worker}`, client_name: 'fixture', redirect_uri: 'https://vendor.example/cb', resource: 'https://bridge.example/mcp', scopes: 'dot-bridge.read', interaction_expires_at: now + 600000 };
    // Approval requires the client to exist; the owner static-client path needs no pairing window.
    as.addStaticClient(snapshot.client_id, { client_id: snapshot.client_id, redirect_uris: [snapshot.redirect_uri], token_endpoint_auth_method: 'none' });
    as.closeWindow();
    const pairing = as.pairingFor(`interaction-${worker}`, snapshot, as.openWindow(worker, 5));
    assert.equal(as.reserve(pairing.code), true);
    const grantId = `grant-${worker}`;
    connections[worker] = as.commitApproval({ code: pairing.code, worker, grantId, snapshot, replace: false }).connection_id;
    as.upsert('Grant', grantId, { clientId: snapshot.client_id }, worker === 'lark' ? 60 : 3600);
    for (const suffix of ['a', 'b']) store.subscribe(`sub-${worker}-${suffix}`, `http://127.0.0.1/${worker}/${suffix}`, 'whsec_fixture', new Date(now + 86400000).toISOString(), 'owner', worker, { builtin: true, connection_id: connections[worker], connection: { worker } });
    const payload = { schema_version: 1, request_id: `req-${worker}`, brief: 'runtime expiry', inputs: [], expected_output: 'report', execution_scope: 'read-only' };
    store.submit(payload, { mode: 'none' }, null, 'owner', false, null, 'normal', null, payload, null, worker);
  }
  store.db.prepare("UPDATE notifications SET state='failed' WHERE subscription_id='sub-lark-b'").run();
  const peer = () => store.db.prepare("SELECT * FROM notifications WHERE subscription_id LIKE 'sub-dot-%' ORDER BY id").all().map(row => ({ ...row }));
  const beforePeer = peer();
  now += 75000; // exact expiry boundary, including oidc-provider's 15-second storage tolerance
  assert.equal(as.connectionIsLive(connections.lark), false);
  const inactive = store.db.prepare("SELECT * FROM subscriptions WHERE id='sub-lark-a'").get();
  assert.equal(store.subscriptionActive(inactive), false, 'grant expiry takes effect without restarting the bridge');
  assert.deepEqual(store.retireUnusableSubscription(inactive).sort(), ['sub-lark-a', 'sub-lark-b'], 'all callbacks of the expired connection retire together');
  assert.equal(store.db.prepare("SELECT count(*) n FROM subscriptions WHERE worker='lark' AND state='revoked'").get().n, 2);
  assert.equal(store.db.prepare("SELECT count(*) n FROM notifications WHERE subscription_id LIKE 'sub-lark-%' AND state='suppressed'").get().n, 2, 'both pending and failed retries were suppressed');
  assert.deepEqual(peer(), beforePeer, 'peer notifications remain byte-for-byte unchanged');
  const event = beforePeer[0];
  assert.ok(store.startAttempt(event.id, null)?.attempt_id, 'peer event is still deliverable');
  console.log('PASS runtime grant expiry retires sibling subscriptions and pending/failed retries; peer delivery survives');
} finally { store.db.close(); as.close(); fs.rmSync(home, { recursive: true, force: true }); }
