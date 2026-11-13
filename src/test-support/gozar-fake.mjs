// A contract-faithful fake of the frozen Gozar route exports (contract/route-contract-c0 @ 91b41a1), for tests only.
// It is built from the pinned fixture (src/test-support/gozar-contract.json): every shape it returns starts from a fixture example, every
// request it accepts is checked against the closed shapes (the fixture's invalid cases are rejected), and every error it throws uses one
// of the 21 frozen codes. It encodes the real runtime's visible rules: single-use consent tokens bound to the request, ensure without a
// pin or approval fails with consent_required, adopt changes no provider state and needs a fenced handover, session close checks the
// handle generation. The real runtime is not under test here: that integration is unproven until Gozar's runtime lands.
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(new URL('./gozar-contract.json', import.meta.url), 'utf8'));
export const FROZEN_CODES = fixture.frozenErrorCodes;
const example = (shape, name) => structuredClone(fixture.valid.find(v => v.shape === shape && (name === undefined || v.name === name)).value);

export class FakeGozarError extends Error {
  constructor(code, message, nextAction = null) {
    if (!FROZEN_CODES.includes(code)) throw new Error(`fake bug: ${code} is not a frozen Gozar error code`);
    super(message); this.name = 'GozarError'; this.code = code; this.nextAction = nextAction;
  }
}
const fail = (code, message, nextAction) => { throw new FakeGozarError(code, message, nextAction); };
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys, what) => { const extra = Object.keys(value).filter(key => !keys.includes(key)); if (extra.length) fail('invalid_input', `${what} has unknown field ${extra[0]}`); };

// ---- request shapes (closed) -----------------------------------------------------------------------------------------------------
export function checkRequirements(r) {
  if (!isRecord(r)) fail('invalid_input', 'requirements is required');
  only(r, ['reach', 'transport', 'payloadAccess', 'address', 'setup', 'protocols'], 'requirements');
  if (!['internet', 'tailnet', 'lan', 'this-device'].includes(r.reach)) fail('invalid_input', 'requirements.reach is invalid (unknown is not a requirement)');
  if (r.transport !== 'https') fail('invalid_input', 'only https can be required');
  if (!['endpoint-only', 'allow-provider'].includes(r.payloadAccess)) fail('invalid_input', 'payloadAccess is invalid');
  if (!['stable', 'any'].includes(r.address)) fail('invalid_input', 'address is invalid');
  if (!['none', 'allow'].includes(r.setup)) fail('invalid_input', 'setup is invalid');
  if (!Array.isArray(r.protocols) || r.protocols.some(p => !['sse', 'streamable-http', 'oauth-dcr'].includes(p))) fail('invalid_input', 'protocols are sse, streamable-http or oauth-dcr');
}
export function checkUsage(u) {
  if (!isRecord(u)) fail('invalid_input', 'usage is required');
  if (u.kind === 'durable') { only(u, ['kind', 'routeId'], 'usage'); if (typeof u.routeId !== 'string' || !u.routeId) fail('invalid_input', 'durable usage needs routeId'); }
  else if (u.kind === 'session') { only(u, ['kind', 'lifetimeMs'], 'usage'); if (typeof u.lifetimeMs !== 'number') fail('invalid_input', 'session usage needs lifetimeMs'); }
  else if (u.kind === 'attached') only(u, ['kind'], 'usage');
  else fail('invalid_input', 'usage.kind is invalid');
}
const checkApproval = a => { if (!isRecord(a) || typeof a.candidateToken !== 'string' || typeof a.disclosureRevision !== 'string') fail('invalid_input', 'approval binds a token and a disclosure revision'); only(a, ['candidateToken', 'disclosureRevision'], 'approval'); };
const QUERY_KEYS = ['schemaVersion', 'owner', 'target', 'usage', 'requirements', 'home', 'route', 'providerId', 'origin', 'intent', 'migrationRef'];
export function checkQuery(q, extraKeys = []) {
  if (!isRecord(q)) fail('invalid_input', 'a request is an object');
  if (q.schemaVersion !== 1) fail('invalid_input', 'schemaVersion must be the constant 1');
  only(q, [...QUERY_KEYS, ...extraKeys], 'request');
  for (const key of ['owner', 'target', 'home']) if (typeof q[key] !== 'string' || !q[key]) fail('invalid_input', `${key} is required`);
  if (q.intent !== undefined && !['create', 'adopt'].includes(q.intent)) fail('invalid_input', 'intent is an enum');
  for (const key of ['route', 'providerId', 'origin', 'migrationRef']) if (q[key] !== undefined && typeof q[key] !== 'string') fail('invalid_input', `${key} must be a string`);
  if (q.route !== undefined && q.providerId !== undefined) fail('invalid_input', 'providerId and route cannot be combined');
  checkUsage(q.usage); checkRequirements(q.requirements);
}
function checkEnsure(r) { checkQuery(r, ['approval', 'reconsent']); if (r.usage.kind !== 'durable') fail('invalid_input', 'ensureRoute requires usage.kind durable'); if (r.intent === 'adopt') fail('invalid_input', 'ensureRoute intent can only be create'); if (r.approval !== undefined) checkApproval(r.approval); if (r.reconsent !== undefined && typeof r.reconsent !== 'boolean') fail('invalid_input', 'reconsent is a boolean'); }
function checkAdopt(r) {
  checkQuery(r, ['approval', 'reconsent', 'handover']);
  if (r.usage.kind !== 'durable') fail('invalid_input', 'adoptRoute is durable only');
  if (r.intent === 'create') fail('invalid_input', 'adoptRoute intent can only be adopt');
  if (typeof r.origin !== 'string') fail('invalid_input', 'adoptRoute needs the exact origin');
  if (r.approval === undefined) fail('invalid_input', 'adoptRoute needs a fresh approval'); checkApproval(r.approval);
  if (!isRecord(r.handover) || typeof r.handover.from !== 'string' || !Number.isInteger(r.handover.generation)) fail('invalid_input', 'adoptRoute needs the fenced handover');
  if (r.reconsent !== undefined && typeof r.reconsent !== 'boolean') fail('invalid_input', 'reconsent is a boolean');
}
function checkExpose(r) {
  checkQuery(r, ['approval', 'wait']);
  if (r.usage.kind === 'durable') fail('invalid_input', 'expose is session or attached only');
  if (r.intent === 'adopt') fail('invalid_input', 'expose intent can only be create');
  if (!['allocated', 'verified'].includes(r.wait)) fail('invalid_input', 'wait is required');
  checkApproval(r.approval);
}
const checkRef = ref => { if (!isRecord(ref) || typeof ref.home !== 'string' || !isRecord(ref.handle) || !['session', 'attached', 'durable', 'external'].includes(ref.handle.kind) || typeof ref.handle.id !== 'string') fail('invalid_input', 'a route reference needs home and handle'); };

export const requestChecks = { query: checkQuery, ensure: checkEnsure, adopt: checkAdopt, expose: checkExpose };

// ---- the fake -------------------------------------------------------------------------------------------------------------------------
// The fields Gozar 0.3 adds to a candidate (CONTRACT-0.3). The pinned 0.2 fixture does not carry them, so the fake adds them here.
const EXTRA = {
  cand_stable: { needs: 'A synthetic stable provider that needs nothing on this computer.', ports: [443], proof: { vantage: 'public', checks: ['tls', 'nonce'] } },
  cand_ephemeral: { needs: 'A synthetic temporary provider that needs nothing on this computer.', ports: null, proof: { vantage: 'this-device', checks: ['tls'] } },
  cand_setup: { needs: 'A synthetic provider that needs one setup step.', ports: [443, 8443], proof: { vantage: 'none', checks: [] } },
};
// options.providers: provider id -> candidate name. A query's providerId picks that candidate; an id not listed is route_not_found with the offered ids
// in the message, as Gozar words it. No providerId leaves every candidate.
export function createFakeGozar({ platform = 'linux', providers = { 'fake-stable': 'cand_stable', 'fake-ephemeral': 'cand_ephemeral', 'fake-setup': 'cand_setup' }, legacy = null, now = () => Date.parse('2026-11-12T12:00:00.000Z'), verifyTarget = async () => {} } = {}) {
  const state = {
    calls: [], effects: [], tokens: new Map(), sessions: new Map(), pins: new Map(), externals: new Map(), tombstones: new Set(),
    legacy: legacy && { ...legacy, owner: 'legacy', reachable: true }, nextToken: 1, nextRoute: 1, waiters: new Map(), provider: { writes: 0 },
  };
  const calls = name => { state.calls.push(name); };
  const view = (kind, id, generation, origin, extra = {}) => {
    const v = example('RouteView', 'durable usable with ingress');
    Object.assign(v, { handle: { kind, id, generation }, origin, published: origin, state: 'usable', ...extra });
    v.verification = { status: 'verified', checkedAt: new Date(now()).toISOString() };
    return v;
  };
  const candidates = query => {
    const c = example('Catalog', 'five candidates of every kind').candidates;
    const stable = c[0], ephemeral = c[1];
    const setup = structuredClone(c.find(x => x.setup.state === 'action-required') ?? c[3]);
    const out = [
      { ...stable, name: 'cand_stable', preferenceRef: 'pref_stable' },
      { ...ephemeral, name: 'cand_ephemeral', preferenceRef: 'pref_ephemeral' },
      { ...setup, name: 'cand_setup', preferenceRef: 'pref_setup' },
    ];
    const idOf = name => Object.keys(providers).find(id => providers[id] === name) ?? name;
    for (const cand of out) {
      const extra = EXTRA[cand.name];
      cand.providerId = idOf(cand.name);
      cand.display = { ...cand.display, needs: extra.needs };
      cand.properties = { ...cand.properties, address: { ...cand.properties.address, ports: extra.ports }, proof: structuredClone(extra.proof) };
    }
    return query.providerId === undefined ? out : out.filter(x => x.providerId === query.providerId);
  };
  const disclosureRevision = 'disc-fake-1';
  const bind = q => JSON.stringify([q.owner, q.home, q.target, q.usage, q.intent ?? 'create', q.requirements, q.route ?? null, q.providerId ?? null, q.origin ?? null, q.migrationRef ?? null, disclosureRevision]);
  async function catalog(q) {
    calls('catalogRoutes'); checkQuery(q);
    if (q.providerId !== undefined && !(q.providerId in providers)) fail('route_not_found', `Unknown route id "${q.providerId}". Offered: ${Object.keys(providers).join(', ')}`);
    const list = candidates(q).map((cand, index) => {
      const unmet = [];
      if (platform !== 'linux') unmet.push({ requirement: 'platform', actual: platform, reasonCode: 'unsupported_platform' });
      else {
        if (q.requirements.address === 'stable' && cand.properties.address.stability !== 'stable') unmet.push({ requirement: 'address', actual: cand.properties.address.stability, reasonCode: 'not_met' });
        if (!cand.properties.lifetimes.includes(q.usage.kind)) unmet.push({ requirement: 'usage', actual: cand.properties.lifetimes, reasonCode: 'not_met' });
      }
      const supported = platform === 'linux';
      const setupState = supported ? cand.setup.state : 'unsupported';
      const needsSetup = setupState === 'action-required' || setupState === 'unknown';
      if (needsSetup && q.requirements.setup === 'none') unmet.push({ requirement: 'setup', actual: setupState, reasonCode: 'not_met' });
      const eligible = unmet.length === 0;
      const ready = eligible && setupState === 'ready';
      let candidateToken = null, expiresAt = null;
      if (ready) {
        candidateToken = `tok_fake_${state.nextToken++}`; expiresAt = new Date(now() + 600_000).toISOString();
        state.tokens.set(candidateToken, { binding: bind(q), expiresAt: now() + 600_000, candidate: cand.name });
      }
      return { ...cand, rank: index + 1, eligible, unmet, setup: { ...cand.setup, state: setupState }, disclosure: { ...cand.disclosure, revision: disclosureRevision }, candidateToken, expiresAt };
    });
    const none = !list.some(x => x.eligible);
    return { schemaVersion: 1, catalogRevision: `catrev_fake_${state.calls.length}`, observedAt: new Date(now()).toISOString(), preferenceRevision: 0, candidates: list,
      noMatch: none && list.every(x => x.setup.state !== 'action-required') ? { code: 'requirements_unsatisfied', requirements: ['address'] } : null };
  }
  function redeem(q, approval) {
    const t = state.tokens.get(approval.candidateToken);
    if (!t) fail('consent_unknown', 'unknown or already used approval');
    state.tokens.delete(approval.candidateToken); // single use, even on mismatch
    if (t.expiresAt < now()) fail('consent_expired', 'the approval expired');
    if (approval.disclosureRevision !== disclosureRevision || t.binding !== bind(q)) fail('consent_mismatch', 'the approval is for a different request');
    return t;
  }
  const newOrigin = () => `https://fake-${state.nextRoute++}.route.invalid`;
  async function expose(q) {
    calls('expose'); checkExpose(q);
    redeem(q, q.approval);
    const id = `sess-${state.nextRoute++}`, origin = newOrigin();
    const route = { id, kind: q.usage.kind, generation: 1, origin, view: view(q.usage.kind, id, 1, origin, { properties: { ...example('RouteView').properties, address: { stability: 'ephemeral', scope: 'session', conditions: ['changes on restart'] } } }), closed: false };
    state.sessions.set(id, route); state.effects.push({ type: 'expose', id, target: q.target, lifetimeMs: q.usage.lifetimeMs ?? null });
    return structuredClone(route.view);
  }
  async function routeStatus(ref) {
    calls('routeStatus'); checkRef(ref);
    const { handle } = ref;
    if (handle.kind === 'external') { const ext = state.externals.get(handle.id); if (!ext) fail('route_not_found', 'no such external route'); return structuredClone(ext); }
    if (handle.kind === 'durable') {
      const pin = state.pins.get(handle.id); if (!pin) fail('route_not_found', 'no such durable route');
      if (handle.generation !== pin.generation) fail('route_conflict', 'the handle is stale');
      return structuredClone(pin.view);
    }
    const route = state.sessions.get(handle.id); if (!route) fail('route_not_found', 'no such route');
    if (route.generation !== handle.generation) fail('route_conflict', 'the handle is stale');
    return structuredClone(route.view);
  }
  async function closeRoute(ref) {
    calls('closeRoute'); checkRef(ref);
    if (ref.mode !== 'remove') fail('invalid_input', 'mode must be remove');
    const { handle } = ref;
    if (handle.kind === 'durable') { // a durable route is released only by an explicit uninstall
      const pin = state.pins.get(handle.id); if (!pin) fail('route_not_found', 'no such durable route');
      state.effects.push({ type: 'close-durable', id: handle.id }); state.pins.delete(handle.id);
      return { ...pin.view, state: 'released', published: null, cleanup: { state: 'none' } };
    }
    const route = state.sessions.get(handle.id); if (!route) fail('route_not_found', 'no such route');
    if (route.generation !== handle.generation) fail('route_conflict', 'the handle is stale');
    route.closed = true; route.view = { ...route.view, state: 'released', published: null, cleanup: state.cleanupDebt ? { state: 'debt', message: state.cleanupDebt } : { state: 'none' } };
    state.effects.push({ type: 'close', id: handle.id });
    emit(handle.id, route.view);
    return structuredClone(route.view);
  }
  function emit(id, v) { const w = state.waiters.get(id); if (w) { w.queue.push(structuredClone(v)); w.wake?.(); } }
  async function* watchRoutes({ home, handle, signal, intervalMs }) {
    calls('watchRoutes'); checkRef({ home, handle });
    const route = handle.kind === 'external' ? { view: await routeStatus({ home, handle }) } : state.sessions.get(handle.id) ?? state.pins.get(handle.id);
    if (!route) fail('route_not_found', 'no such route');
    const w = { queue: [], wake: null }; state.waiters.set(handle.id, w);
    let sequence = 0;
    yield { schemaVersion: 1, sequence: sequence++, type: 'snapshot', route: structuredClone(route.view) };
    try {
      while (!signal?.aborted) {
        if (!w.queue.length) await new Promise(resolve => { w.wake = resolve; signal?.addEventListener('abort', resolve, { once: true }); });
        w.wake = null;
        while (w.queue.length) {
          const v = w.queue.shift();
          const terminal = v.state === 'released' || v.published === null;
          yield { schemaVersion: 1, sequence: sequence++, type: terminal ? 'terminal' : 'changed', route: v };
          if (terminal) return;
        }
      }
    } finally { state.waiters.delete(handle.id); }
  }
  async function ensureRoute(q) {
    calls('ensureRoute'); checkEnsure(q);
    const routeId = q.usage.routeId, pin = state.pins.get(routeId);
    if (state.tombstones.has(routeId)) {
      if (!q.reconsent || !q.approval) fail(q.reconsent ? 'consent_required' : 'stopped_by_user', 'the route was stopped by the user');
      redeem(q, q.approval); state.tombstones.delete(routeId);
    }
    if (pin) {
      if (q.origin !== undefined && q.origin !== pin.view.origin) fail('route_conflict', 'the route is pinned to a different origin');
      return structuredClone(pin.view);
    }
    if (q.approval === undefined) fail('consent_required', 'a first allocation needs one displayed approval');
    redeem(q, q.approval);
    const origin = q.origin ?? newOrigin();
    const v = view('durable', routeId, 1, origin);
    state.pins.set(routeId, { generation: 1, view: v, requirements: q.requirements }); state.effects.push({ type: 'ensure', routeId, origin, target: q.target });
    return structuredClone(v);
  }
  async function inspectLegacyRoute(req) {
    calls('inspectLegacyRoute');
    if (!isRecord(req) || typeof req.home !== 'string' || typeof req.owner !== 'string' || typeof req.target !== 'string' || !isRecord(req.source) || !Array.isArray(req.source.stateFiles)) fail('invalid_input', 'bad inspect request');
    const base = { schemaVersion: 1, migrationRef: `mig_fake_${state.nextRoute++}`, origin: null, target: req.target, bridgeHome: null, nextAction: null };
    const l = state.legacy;
    if (!l || l.owner !== 'legacy') return { ...base, state: 'blocked', reasonCode: 'not_found' };
    const known = req.source.stateFiles.some(f => l.files.includes(f));
    if (!known) return { ...base, state: 'blocked', reasonCode: 'unrecognized_format', nextAction: example('Action', 'instructions') };
    if (req.target !== l.target) return { ...base, origin: l.origin, state: 'blocked', reasonCode: 'target_mismatch' };
    if (req.origin !== undefined && req.origin !== l.origin) return { ...base, origin: l.origin, state: 'blocked', reasonCode: 'origin_mismatch' };
    return { ...base, origin: l.origin, bridgeHome: l.bridgeHome ?? null, state: 'adoptable', reasonCode: null };
  }
  async function adoptRoute(q) {
    calls('adoptRoute'); checkAdopt(q);
    const routeId = q.usage.routeId;
    if (state.tombstones.has(routeId) && !q.reconsent) fail('stopped_by_user', 'the route was stopped by the user');
    if (state.pins.has(routeId)) fail('route_conflict', 'this route is already owned');
    redeem(q, q.approval);
    const l = state.legacy;
    if (!l || l.owner !== 'legacy' || l.origin !== q.origin || l.target !== q.target) fail('ambiguous_route', 'the observed rule does not match this origin and target');
    if (q.handover.generation !== l.generation) fail('route_conflict', 'the handover generation is stale');
    if (l.fenced !== true && state.requireFence !== false) fail('route_conflict', 'the previous owner is not fenced');
    await verifyTarget(q.target, q.origin); // adopt challenges the target; the caller keeps serving the proof
    const v = view('durable', routeId, l.generation + 1, q.origin);
    l.owner = 'gozar'; // no provider write: the same rule, now owned
    state.pins.set(routeId, { generation: v.handle.generation, view: v, requirements: q.requirements });
    state.effects.push({ type: 'adopt', routeId, origin: q.origin, target: q.target, providerWrites: 0 });
    return structuredClone(v);
  }
  async function releaseRoute(req) {
    calls('releaseRoute');
    if (req.mode !== 'hand-back') fail('invalid_input', 'the fake supports hand-back only');
    const pin = state.pins.get(req.routeId); if (!pin) fail('route_not_found', 'no such route');
    state.effects.push({ type: 'hand-back-start', routeId: req.routeId });
    pin.view = { ...pin.view, state: 'handing-back', published: null };
    return { schemaVersion: 1, routeId: req.routeId, claim: { opaque: true }, transfer: `xfer_${req.routeId}` };
  }
  async function confirmHandBack(req) {
    calls('confirmHandBack');
    const pin = state.pins.get(req.routeId); if (!pin || req.transfer !== `xfer_${req.routeId}`) fail('route_not_found', 'no such transfer');
    state.pins.delete(req.routeId); if (state.legacy) { state.legacy.owner = 'legacy'; state.legacy.generation = pin.generation + 1; }
    state.effects.push({ type: 'hand-back-confirm', routeId: req.routeId });
    return { schemaVersion: 1, routeId: req.routeId, handedBack: true, claim: { opaque: true } };
  }
  async function addService({ origin, target }) {
    calls('addService'); state.effects.push({ type: 'addService', origin, target });
    const v = example('RouteView', 'external-owned, unknown privacy'); Object.assign(v, { handle: { kind: 'external', id: origin, generation: 1 }, origin, published: origin });
    state.externals.set(origin, v);
    return { schemaVersion: 1, route: { origin, target, verification: { status: 'verified' } } };
  }
  async function runSetupAction({ actionId }) { calls('runSetupAction'); state.effects.push({ type: 'setup', actionId }); state.setupDone = true; return { schemaVersion: 1, state: 'complete', nextAction: null, catalogRevision: 'catrev_fake_setup' }; }
  const api = {
    catalogRoutes: catalog, detect: catalog, ensureRoute, adoptRoute, expose, routeStatus, closeRoute, watchRoutes, inspectLegacyRoute, releaseRoute, confirmHandBack, runSetupAction, addService,
    async getRoutePreferences() { calls('getRoutePreferences'); return { schemaVersion: 1, scope: 'user', revision: 0, adapterPreference: [], onUnavailable: 'ask' }; },
    async statusServices() { calls('statusServices'); return { schemaVersion: 1, routes: [...state.externals.values()] }; },
  };
  return Object.assign(api, {
    fake: {
      state, emit, tombstone: id => state.tombstones.add(id), setCleanupDebt: text => { state.cleanupDebt = text; },
      setLegacyFenced: fenced => { if (state.legacy) state.legacy.fenced = fenced; },
      // A provider-side event for a session: the address changed, or the route was lost.
      change: (id, patch) => { const route = state.sessions.get(id) ?? state.pins.get(id); route.view = { ...route.view, ...patch }; emit(id, route.view); },
    },
  });
}
