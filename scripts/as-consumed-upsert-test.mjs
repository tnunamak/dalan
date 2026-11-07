#!/usr/bin/env node
// A provider save after consume must not resurrect a code or refresh token, including after restart.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AsStore } from '../src/as-store.mjs';

const temp = new URL('../.test-home/', import.meta.url);
fs.mkdirSync(temp, { recursive: true });
const home = fs.mkdtempSync(path.join(temp.pathname, 'consumed-upsert-'));
const file = path.join(home, 'as.sqlite');
let store;
try {
  for (const model of ['AuthorizationCode', 'RefreshToken']) {
    store = new AsStore(file, { now: () => 1800000000000 });
    const grantId = `grant-${model}`, payload = { grantId, clientId: 'client', accountId: 'owner' };
    store.upsert('Grant', grantId, { clientId: 'client' }, 3600);
    store.upsert(model, 'spent', payload, 600);
    const adapter = new store.Adapter(model);
    await adapter.consume('spent');
    // Read the row directly: through the adapter, finding a consumed authorization code is itself a replay and revokes the grant.
    const consumed = store.find(model, 'spent').consumed;
    assert.ok(consumed > 0, 'control: the record really was consumed');
    // oidc-provider may save the same stale payload later. Its absent consumed field is not permission to reset the tombstone.
    await adapter.upsert('spent', { ...payload, extra: 'saved again' }, 600);
    store.close();
    store = new AsStore(file, { now: () => 1800000001000 });
    assert.equal(store.find(model, 'spent').consumed, consumed, `${model}: upsert and restart preserved consume`);
    store.upsert('AccessToken', 'access', { grantId }, 600);
    const revoked = [];
    store.onGrantRevoked = (_id, reason) => revoked.push(reason);
    await assert.rejects(new store.Adapter(model).consume('spent'), error => error.error === 'invalid_grant');
    assert.equal(store.find('AccessToken', 'access'), undefined, 'replay removed the grant access token');
    assert.equal(store.find('Grant', grantId), undefined, 'replay removed the grant');
    assert.deepEqual(revoked, ['replay']);
    store.close(); store = null;
  }
  console.log('PASS consumed code and refresh-token tombstones survive upsert and restart; replay still revokes the grant');
} finally { store?.close(); fs.rmSync(home, { recursive: true, force: true }); }
