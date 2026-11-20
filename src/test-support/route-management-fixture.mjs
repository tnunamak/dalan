// Random registry adapters copy this file beside the SDK's public test adapter.
import base from './base.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('./management.json', import.meta.url);
const read = () => JSON.parse(readFileSync(file));
const write = state => writeFileSync(file, JSON.stringify(state));
const row = (id, kind, purpose, extra = {}) => ({
  id, kind, label: id, digest: id, required: true,
  disclosure: { revision: 'fixture-v1', text: 'Synthetic exact-scope operation', links: [] },
  step: { actor: kind === 'gozar-runs' ? 'machine' : 'owner', permission: { id, label: id }, verification: 'provider', purpose },
  ...extra,
});
const grant = row('authorize', 'open-url', 'authorize', {
  href: 'https://provider.invalid/authorize?synthetic=handoff-canary',
  step: { actor: 'owner', permission: { id: 'authorize', label: 'Authorize inventory' }, verification: 'provider',
    purpose: 'authorize', browser: { expiresAt: read().expiresAt, pollAfterMs: 50 } },
});
const secret = row('inventory', 'provide-secret', 'configure', { inputId: 'inventory', secretLabel: 'Inventory key' });
const provision = row('provision', 'gozar-runs', 'provision');
const subject = operationId => ({ fixtureAllocation: operationId });
const disconnect = row('forget-inventory', 'gozar-runs', 'disconnect');
const instructions = row('wait-for-policy', 'instructions', 'reconcile', { instructions: 'Ask the fixture owner to check policy.' });
const setup = state => state.blocked ? instructions : state.callback !== 'verified' ? grant : state.intake ? provision : secret;

export default {
  ...base,
  configurationActions: () => [secret],
  setupActions: facts => facts?.next ? [facts.next] : [],
  async detect() {
    const state = read();
    return { state: state.done ? 'ready' : 'action-required', facts: { next: state.done ? null : setup(state) } };
  },
  async observeSetup(ctx, operation) {
    const state = read();
    const [allocation] = operation.resources;
    const observedAt = new Date().toISOString();
    const identity = state.allocation?.intentId === allocation?.id ? state.allocation?.identity : null;
    const observations = identity ? [{ intentId: allocation.id, subject: subject(operation.id), identity,
      status: state.route === identity.id ? 'present' : 'absent', observedAt }] : [];
    if (operation.cancelled) {
      if (identity && state.route === identity.id) {
        const removal = row('remove-fixture', 'gozar-runs', 'remove-resource');
        return { state: 'complete', nextAction: { ...removal, step: { ...removal.step, resourceHandle: allocation.id } }, observations };
      }
      const present = await ctx.withManagementSecret('inventory', async () => true).catch(() => false);
      return { state: 'complete', nextAction: present ? disconnect : null, observations, ...(!present && {
        evidence: { operationId: operation.id, stepId: disconnect.id, source: 'host', observedAt,
          summary: 'No local management credential is retained.' },
      }) };
    }
    const evidence = state.callback === 'verified' ? { operationId: operation.id, stepId: grant.id, source: 'provider',
      observedAt: new Date().toISOString(), summary: 'Fixture granted authorization.' } : undefined;
    if (state.blocked) return { state: 'reconciling', nextAction: instructions };
    if (state.done) return { state: 'complete', nextAction: null, evidence, observations };
    const nextAction = setup(state);
    return { state: 'pending', nextAction, evidence, ...(nextAction === provision && {
      intent: { kind: 'other', label: 'Fixture allocation', subject: subject(operation.id) },
    }) };
  },
  async executeSetup(ctx, { action, intent, resource }) {
    const state = read();
    if (action.id === secret.id) {
      await ctx.withInputSecret(async bytes => {
        if (!bytes.length) throw new Error('missing fixture secret');
      });
      await ctx.retainManagementSecret('inventory');
      state.intake = true;
    } else if (action.id === provision.id) {
      const identity = { id: 'exact-' + intent.id };
      await ctx.recordAllocation(identity);
      state.allocation = { intentId: intent.id, identity };
      state.route = identity.id;
      state.done = true;
    } else if (action.id === 'remove-fixture') {
      if (resource.identity.id !== state.route) throw new Error('wrong cleanup subject');
      delete state.route;
      state.removes++;
    } else if (action.id === disconnect.id) {
      await ctx.disconnectManagementSecret('inventory');
      state.disconnects++;
    } else throw new Error('unexpected fixture effect');
    write(state);
    return { state: 'complete' };
  },
};
