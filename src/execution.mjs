import { readEnv } from './env.mjs';
import fs from 'node:fs';
import { hostCheckRefusal } from './host-execution-policy.mjs';
import { withCheckCoverage } from './check-coverage.mjs';

// Per-job execution capability (design section 3) and the declared capabilities of the one executor the bridge has.
//   none   nobody on the bridge host runs checks
//   worker the worker runs checks in its own sandbox; the bridge stores those claims as worker_attested
//   host   operator-enabled Linux checks use bwrap + systemd budgets; results are bridge_verified
export const EXECUTIONS = Object.freeze(['none', 'worker', 'host']);
export const TRUST = Object.freeze({ bridge: 'bridge_verified', worker: 'worker_attested' });

export const parseExecution = (value, what = 'execution') => {
  if (!EXECUTIONS.includes(value)) throw new Error(`invalid ${what}: expected one of ${EXECUTIONS.join(', ')}`);
  return value;
};

// Vocabulary of design section 13. A check may require any of these.
export const CAPABILITY_NAMES = Object.freeze([
  'private_loopback', 'host_loopback_denied', 'lan_denied', 'unix_sockets_denied', 'credential_services_denied',
  'closed_inherited_fds', 'read_scope_enforced', 'write_scope_enforced', 'full_tree_cancel_verified',
  'offline_transition_revokes_connections', 'artifact_export_no_follow', 'runner_observed_evidence', 'native_darwin_execution', 'immutable_input_snapshot']);
export const CAPABILITY_STATES = Object.freeze(['verified', 'unsupported', 'unknown']);

export function parseRequiredCapabilities(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > CAPABILITY_NAMES.length || value.some(c => !CAPABILITY_NAMES.includes(c))) {
    throw new Error(`invalid required_capabilities: expected a list of ${CAPABILITY_NAMES.join(', ')}`);
  }
  return value.length ? [...new Set(value)].sort() : null;
}

// The legacy pasta backend has no systemd control-group stop receipt, so it cannot
// verify that the full process tree has stopped. The opted-in systemd backend records
// a recursive control-group scan in a durable receipt, reconciled by Workspace.check.
const SYSTEMD_CAPABILITIES = Object.freeze({
  private_loopback: 'verified', host_loopback_denied: 'verified', lan_denied: 'verified', unix_sockets_denied: 'verified',
  credential_services_denied: 'verified', closed_inherited_fds: 'verified', read_scope_enforced: 'verified',
  write_scope_enforced: 'verified', full_tree_cancel_verified: 'verified', offline_transition_revokes_connections: 'verified',
  artifact_export_no_follow: 'verified', runner_observed_evidence: 'verified', native_darwin_execution: 'unsupported', immutable_input_snapshot: 'unsupported',
});
export const SYSTEMD_BACKEND = Object.freeze({ name: 'linux-bwrap-systemd', version: '1' });
export const BACKENDS = Object.freeze({
  'linux-bwrap-pasta': Object.freeze({
    // Neither pasta version writes the systemd control-group receipt used as full-tree stop proof.
    '1': Object.freeze({
      measured_by: Object.freeze({ script: 'scripts/sandbox-probe-e2e.mjs' }),
      capabilities: Object.freeze({
        private_loopback: 'verified', host_loopback_denied: 'verified', lan_denied: 'verified', unix_sockets_denied: 'verified',
        credential_services_denied: 'verified', closed_inherited_fds: 'unsupported', read_scope_enforced: 'verified',
        write_scope_enforced: 'verified', full_tree_cancel_verified: 'unsupported', offline_transition_revokes_connections: 'verified',
        artifact_export_no_follow: 'verified', runner_observed_evidence: 'verified', native_darwin_execution: 'unsupported', immutable_input_snapshot: 'unsupported' }) }),
    // The v2 process-tree helpers are retained for tests; production uses the systemd control-group receipt.
    '2': Object.freeze({
      measured_by: Object.freeze({ script: 'scripts/sandbox-probe-e2e.mjs' }),
      capabilities: Object.freeze({
        private_loopback: 'verified', host_loopback_denied: 'verified', lan_denied: 'verified', unix_sockets_denied: 'verified',
        credential_services_denied: 'verified', closed_inherited_fds: 'verified', read_scope_enforced: 'verified',
        write_scope_enforced: 'verified', full_tree_cancel_verified: 'unsupported', offline_transition_revokes_connections: 'verified',
        artifact_export_no_follow: 'verified', runner_observed_evidence: 'verified', native_darwin_execution: 'unsupported', immutable_input_snapshot: 'unsupported' }) }) }),
  'linux-bwrap-systemd': Object.freeze({
    '1': Object.freeze({
      measured_by: Object.freeze({ script: 'scripts/sandbox-probe-e2e.mjs', full_tree_cancel_verified: 'scripts/host-stop-production-path-test.mjs' }),
      capabilities: SYSTEMD_CAPABILITIES,
    }),
  }),
});
export const HOST_BACKEND = Object.freeze({ name: 'linux-bwrap-pasta', version: '2' });

export function hostBackend(readiness=hostReadiness()) {
  const selected=readEnv('DALAN_HOST_CHECKS')==='1'?SYSTEMD_BACKEND:HOST_BACKEND;
  const entry = BACKENDS[selected.name][selected.version];
  const capabilities=Object.fromEntries(Object.entries(entry.capabilities).map(([name,state])=>[name,readiness.ready?state:'unknown']));
  // The budgeted backend gives no phase a network, so no probe can show a connection being revoked at the install-to-check switch.
  // A declaration may trail a measurement but never lead it: this one is reported unknown, not verified.
  if(selected===SYSTEMD_BACKEND) capabilities.offline_transition_revokes_connections='unknown';
  return { ...selected, capabilities, measured_by: { ...entry.measured_by } };
}

// Baseline platform prerequisites retained for legacy admission compatibility.
// Presence does not authorize execution: policy and the budget service verify
// opt-in, scope, Python, systemd and effective cgroup limits at launch.
// DALAN_TEST_HIDE_BWRAP=1 only makes the answer stricter (tests use it to model a host without an executor); nothing can make it looser.
export function hostReadiness(exists = fs.existsSync) {
  if (readEnv('DALAN_TEST_HIDE_BWRAP') === '1') exists = () => false;
  if (process.platform !== 'linux') return { ready: false, reason: `no host executor on ${process.platform}` };
  if (!exists('/usr/bin/bwrap')) return { ready: false, reason: 'bwrap not found' };
  // Preserve the historical bash prerequisite; budgeted commands instead use
  // Python close_fds and never fall back to the historical launcher.
  if (!exists('/usr/bin/bash')) return { ready: false, reason: 'bash not found (the fd-closing launcher needs it)' };
  const refusal=hostCheckRefusal();
  return { ready: !refusal, reason: refusal };
}

const capabilityError = (capability, detail) => Object.assign(new Error(`capability_not_available: ${capability} (${detail})`), { code: 'capability_not_available' });

// Throws capability_not_available naming the first thing a host job cannot get.
export function admitHostExecution(required, { readiness = hostReadiness(), backend = hostBackend(readiness) } = {}) {
  if (!readiness.ready) throw capabilityError('host_execution', readiness.reason);
  for (const capability of required || []) {
    const state = backend.capabilities[capability] ?? 'unknown';
    if (state !== 'verified') throw capabilityError(capability, `${backend.name} v${backend.version} declares ${state}`);
  }
}

export const capabilityNotAvailable = (execution, reason) => ({ status: 'capability_not_available', capability: 'host_execution', reason: reason || `this job has execution=${execution}; run_check needs execution=host`, execution });

// A check row as shown to the worker and the owner: the evidence JSON parsed, and trust taken from it (null when the bridge recorded none).
export function withEvidence(row) {
  const evidence = row.evidence ? JSON.parse(row.evidence) : null;
  return withCheckCoverage({ ...row, evidence, trust: evidence?.trust ?? null });
}
