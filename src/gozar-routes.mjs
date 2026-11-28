// The route boundary for Dalan: supply application requirements and render Gozar's current offers and observations.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { routeSecretBackend, routeCustodyPath } from './route-custody.mjs';
import { safeDiagnostic } from './diagnostic.mjs';
import { readJournal, removeJournal, writeJournal, readRouteSetting, writeRouteSetting } from './route-setting.mjs';

export const OWNER = 'dalan';
export const SCHEMA_VERSION = 1;
export const FROZEN_CODES = Object.freeze(['invalid_input', 'requirements_unsatisfied', 'setup_required', 'consent_required', 'consent_unknown', 'consent_expired',
  'consent_mismatch', 'candidate_stale', 'preference_conflict', 'route_not_found', 'route_conflict', 'address_changed', 'stopped_by_user', 'handing_back',
  'verification_failed', 'provider_unavailable', 'cleanup_debt', 'unsupported', 'ambiguous_route', 'busy', 'internal_error',
  'configuration_stale', 'configuration_in_use', 'secret_in_use', 'secret_backend_locked', 'secret_backend_unavailable',
  'host_policy_denied', 'artifact_integrity_failed', 'configuration_migration_required', 'proof_refresh_unsupported', 'operation_conflict']);
// Check the public exports before starting an install or trial.
export const REQUIRED_EXPORTS = Object.freeze(['catalogRoutes', 'ensureRoute', 'adoptRoute', 'expose', 'routeStatus', 'closeRoute', 'watchRoutes', 'inspectLegacyRoute', 'runSetupAction', 'readSetupOperation', 'cancelSetupOperation', 'createGozar', 'listRoutes', 'releaseRoute', 'confirmHandBack']);

export class RouteError extends Error {
  constructor(code, message, { nextAction = null, cause } = {}) { super(message, cause ? { cause } : undefined); this.name = 'RouteError'; this.code = code; this.nextAction = nextAction; }
}

// ---- finding Gozar ---------------------------------------------------------------------------------------------------------------------
const require = createRequire(import.meta.url);
// The bundled package, resolved from Dalan's own install tree (not the working directory). An install without the contract's exports
// is reported as `runtime_missing` with the next step; nothing falls back to another executable.
export async function resolveGozar({ env = process.env, home = gozarHomeFor(env), custody = routeCustodyPath({ HOME: os.homedir(), ...env }, home), importer = () => import('@tnunamak/gozar'), resolvePackage = () => require.resolve('@tnunamak/gozar/package.json') } = {}) {
  let module;
  try { module = await importer(); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND') throw new RouteError('runtime_missing', 'Gozar is not installed with this Dalan. Reinstall @tnunamak/dalan with its dependencies, then run this again.', { cause: error });
    throw error;
  }
  const missing = REQUIRED_EXPORTS.filter(name => typeof module?.[name] !== 'function');
  if (missing.length) {
    let version = 'unknown';
    try { version = JSON.parse(fs.readFileSync(resolvePackage(), 'utf8')).version ?? version; } catch { /* reported as unknown */ }
    throw new RouteError('runtime_missing', `The installed Gozar (${version}) does not provide the route contract (missing ${missing.join(', ')}). Update @tnunamak/dalan to a release that bundles it.`);
  }
  const secretBackend = routeSecretBackend(custody);
  const api = module.createGozar({ secretBackend, hostCapabilities: {
    'secrets.backend': { known: true, value: true },
  } });
  // These standalone calls are public and take the same private state home explicitly.
  return { ...api, releaseRoute: module.releaseRoute, confirmHandBack: module.confirmHandBack };
}

// Gozar's profile home for the real OS user. An explicit GOZAR_HOME selects a separate profile.
export const gozarHomeFor = (env = process.env) => path.resolve(env.GOZAR_HOME ?? path.join(env.HOME ?? os.homedir(), '.local', 'state', 'gozar'));

// ---- requests --------------------------------------------------------------------------------------------------------------------------
export const dalanRequirements = ({ address = 'any' } = {}) => ({ reach: 'internet', transport: 'https', payloadAccess: 'allow-provider', address, setup: 'allow', protocols: ['sse', 'streamable-http', 'oauth-dcr'] });

// `route` is the owner's name for a Gozar route, passed through exactly. An empty or non-string value is refused only because it is no name at all.
export function buildQuery({ home, target, usage, route, origin, intent, migrationRef, address = 'any', requirements }) {
  if (route !== undefined && (typeof route !== 'string' || route.length === 0)) throw new RouteError('invalid_input', '--route needs a name');
  const query = { schemaVersion: SCHEMA_VERSION, owner: OWNER, target, usage, requirements: requirements ?? dalanRequirements({ address }), home };
  if (route !== undefined) query.route = route;
  if (origin !== undefined) query.origin = origin;
  if (intent !== undefined) query.intent = intent;
  if (migrationRef !== undefined) query.migrationRef = migrationRef;
  return query;
}
export const targetFor = port => `127.0.0.1:${port}`;

// ---- choosing and showing candidates (data only) ---------------------------------------------------------------------------------------
export const readyCandidates = catalog => [...catalog.candidates].filter(c => c.eligible && c.setup.state === 'ready' && typeof c.candidateToken === 'string').sort((a, b) => a.rank - b.rank);
export const pickCandidate = catalog => readyCandidates(catalog)[0] ?? null;
// Gozar accepts configured route names and exact catalog IDs. It validates both.
export async function resolveRouteWord({ gozar, query }) {
  if (query.route === undefined) return { query, pick: pickCandidate };
  try { await gozar.catalogRoutes(query); return { query, pick: pickCandidate }; }
  catch (error) {
    if (error?.code !== 'route_not_found') throw error;
    const { route, ...request } = query;
    const exact = { ...request, providerId: route };
    try { await gozar.catalogRoutes(exact); }
    catch (fallback) { if (fallback?.code === 'route_not_found') throw error; throw fallback; }
    return { query: exact, pick: pickCandidate };
  }
}
export const approvalFor = candidate => ({
  kind: 'route', candidateToken: candidate.candidateToken, disclosureRevision: candidate.disclosure.revision,
  consentFactsDigest: candidate.consentFactsDigest,
});

const yesNo = value => value === true ? 'yes' : value === false ? 'no' : 'unknown';
// One block of lines per candidate, built only from what Gozar returned. Labels name a provider only as returned display data.
export function describeCandidate(candidate, index) {
  const p = candidate.properties;
  const readers = p.traffic.readers.length ? p.traffic.readers.join(', ') : 'none listed';
  const lines = [`${index === undefined ? '' : `${index + 1}. `}${candidate.display.label}${candidate.eligible ? '' : ' (not usable for this)'}`, `   ${candidate.display.description}`,
    `   reach: ${p.reach}; address: ${p.address.stability} (${p.address.scope}${p.address.conditions.length ? `; ${p.address.conditions.join('; ')}` : ''})`,
    `   traffic readers: ${readers}; provider can read payload: ${yesNo(p.traffic.providerCanReadPayload)}; ends TLS at: ${p.traffic.tlsTermination}`,
    `   cost: ${p.cost.summary}; account needed: ${yesNo(p.needsAccount)}; lifetimes: ${p.lifetimes.join(', ')}`];
  if (!candidate.eligible) lines.push(`   not met: ${candidate.unmet.map(u => `${u.requirement} (${u.reasonCode})`).join(', ')}`);
  if (candidate.setup.state !== 'ready') lines.push(`   setup: ${candidate.setup.state}${candidate.setup.actions.length ? `; actions: ${candidate.setup.actions.map(a => a.label).join('; ')}` : ''}`);
  return lines;
}
export function describeDisclosure(candidate) {
  const d = candidate.disclosure;
  const cost = candidate.consent?.disclosures?.cost;
  const costLine = cost?.summary && (cost.kind === 'paid'
    ? `Cost for this approval: ${cost.summary} (${cost.amount} ${cost.currency} per ${cost.period})`
    : `Cost for this approval: ${cost.kind}, ${cost.summary}`);
  return [...(costLine ? [costLine] : []), ...describeFacts(candidate.consent?.facts ?? []), d.text, ...d.links.map(l => `${l.label}: ${l.href}`)];
}

export const describeFacts = facts => facts.map(fact => `${fact.label}: ${fact.known ? String(fact.value) : `unknown (${fact.reason})`}`);

// Translate common route errors and display safe guidance returned by Gozar.
const EXPLAIN = {
  invalid_input: 'Dalan sent Gozar a request it refused as invalid.', requirements_unsatisfied: 'No route satisfies what Dalan needs (an HTTPS address reachable from the internet).',
  setup_required: 'A route needs one setup step first.', consent_required: 'This route needs your approval first.', consent_unknown: 'The approval was already used or is unknown. Ask for the choices again.',
  consent_expired: 'The approval expired. Ask for the choices again.', consent_mismatch: 'The approval was for a different request. Ask for the choices again.', candidate_stale: 'The route choice changed while you decided. Ask again.',
  preference_conflict: 'Your route preferences changed meanwhile. Try again.', route_not_found: 'Gozar has no route with that name.', route_conflict: 'Another owner or a newer route replaced this one; it was left untouched.',
  address_changed: 'The public address changed.', stopped_by_user: 'This route was stopped by you; approve it again to start it.', handing_back: 'The route is being handed back to its previous owner.',
  verification_failed: 'The route did not pass Gozar\'s check.', provider_unavailable: 'The route provider is unavailable right now.', cleanup_debt: 'Gozar reports cleanup debt for this route.',
  unsupported: 'This computer or request is not supported by any route.', ambiguous_route: 'Gozar cannot tell which existing route this is, so it changed nothing.',
  busy: 'Gozar is busy. Wait a moment and try again.', internal_error: 'Gozar had an unexpected fault.', runtime_missing: 'Gozar is not available.',
  configuration_stale: 'The route configuration changed. Ask for the current offer.', configuration_in_use: 'This configuration is still in use.',
  secret_in_use: 'A setup or route still uses this credential.', secret_backend_locked: 'The credential store is locked.',
  secret_backend_unavailable: 'The credential store could not be reached.', host_policy_denied: 'The host did not allow this effect.',
  artifact_integrity_failed: 'The setup artifact failed its integrity check.', configuration_migration_required: 'Gozar requires a configuration migration.',
  proof_refresh_unsupported: 'Gozar cannot refresh proof for this route.', operation_conflict: 'The saved operation belongs to a different route request.',
};
export function explainRouteError(error) {
  const code = typeof error?.code === 'string' && (FROZEN_CODES.includes(error.code) || error.code === 'runtime_missing') ? error.code : null;
  // Gozar's next step is shown as text for every code, including one Dalan does not know yet; Dalan never acts on it.
  const action = error?.nextAction ?? null;
  const fix = action ? [action.label, action.instructions, !action.step?.browser && action.href].filter(value => typeof value === 'string' && value.length > 0).map(value => safeDiagnostic(value, 240)).join(' - ') || null : null;
  if (!code) return { code: null, line: safeDiagnostic(String(error?.message ?? error), 240), fix };
  const detail = code === 'runtime_missing' ? error.message : `${EXPLAIN[code]}${error.message && !EXPLAIN[code].includes(error.message) ? ` (${safeDiagnostic(error.message, 160)})` : ''}`;
  return { code, line: detail, fix };
}

// ---- a session route (`dalan try --public`) --------------------------------------------------------------------------------------------
// `consent(candidate)` shows the disclosure and resolves true only on an explicit yes. The route lasts for the trial and is closed with it.
// An allocated origin can configure the local app. Only a current, published view can be handed off.
export async function startSessionRoute({ gozar, query, consent, signal, wait = 'verified', pick = pickCandidate, remember, setup, recovery }) {
  signal?.throwIfAborted();
  query = { ...query, operationId: recovery?.operationId ?? query.operationId ?? randomUUID() };
  const { candidate, catalog } = await chooseRoute({ gozar, query, pick, setup });
  signal?.throwIfAborted();
  if (!await consent(candidate, catalog)) throw Object.assign(new RouteError('consent_required', 'No public route was started because consent was not given.'), { tryKind: 'consent' });
  signal?.throwIfAborted();
  const discard = async handle => {
    if (remember || !handle) return;
    const cleanup = await closeExactRoute(gozar, { home: query.home, handle });
    if (!cleanup.removed) {
      const debt = new RouteError('cleanup_debt', `Gozar could not confirm removal of ${safeDiagnostic(handle.kind, 24)} ${safeDiagnostic(handle.id, 160)} (generation ${handle.generation}). ${cleanup.detail}`);
      throw Object.assign(debt, { handle });
    }
  };
  let view;
  try {
    view = await dispatchRouteOperation(query, recovery, remember,
      request => gozar.expose({ ...request, approval: approvalFor(candidate), wait }));
  } catch (error) {
    await discard(error.route?.handle);
    throw error;
  }
  const handle = view?.handle;
  let url; try { url = new URL(view?.origin); } catch { /* rejected below */ }
  if (!handle || !url || url.protocol !== 'https:' || url.origin !== view.origin || (wait === 'verified' && !isPublished(view))) {
    await discard(handle);
    throw routeFailure(view, 'Gozar did not return a verified HTTPS origin for this route.');
  }
  if (signal?.aborted) { await discard(handle); signal.throwIfAborted(); }
  const route = monitorRoute({ gozar, home: query.home, view, candidate });
  if (wait === 'verified') void route.watchPublished();
  return route;
}

export const isPublished = view => view?.state === 'usable' && typeof view.published === 'string' &&
  view.origin === view.published && view.verification?.status === 'verified';

export function routeFailure(view, message) {
  return new RouteError('verification_failed', message, { nextAction: view?.binding?.remedy ?? null });
}

function routeEnding(route, type, origin) {
  if (route.state === 'address_changed' || (route.origin && route.origin !== origin) || (route.published && route.published !== origin)) return 'rotated';
  if (type === 'terminal' || route.routeState === 'expired' ||
      (route.expiresAt?.known && Date.parse(route.expiresAt.value) <= Date.now()) ||
      ['lost', 'released', 'suspended', 'suspending', 'releasing', 'handing-back'].includes(route.state)) return 'lost';
  return null;
}

export async function waitForPublication({ gozar, home, handle, origin, signal, timeoutMs }) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const watchSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let latest;
  for await (const { route, type } of gozar.watchRoutes({ home, handle, signal: watchSignal })) {
    latest = route;
    if (routeEnding(route, type, origin) || route.state === 'uncertain' || route.consentChange) break;
    if (isPublished(route) && route.published === origin) return route;
  }
  signal?.throwIfAborted();
  throw routeFailure(latest, 'Gozar could not prove that the route reaches this bridge.');
}

// Only a durable host write before the dispatch fence proves the SDK was never called.
export const routeNotDispatched = ref => ref.phase === 'prepared' && !ref.handle;

export function reconcileRouteOperationId(retained, observed) {
  const retainedId = typeof retained === 'string' && retained.length > 0 ? retained : undefined;
  const observedId = typeof observed === 'string' && observed.length > 0 ? observed : undefined;
  if (retainedId && observedId && retainedId !== observedId) {
    throw new RouteError('route_conflict', 'Gozar returned a different operation for the retained route.');
  }
  return retainedId ?? observedId;
}

export async function observeRetainedRoute(gozar, ref) {
  const { home, operationId, handle } = ref;
  if (handle) {
    try {
      const view = await gozar.routeStatus({ home, handle });
      if (!sameRouteHandle(view.handle, handle)) throw new RouteError('route_conflict', 'Gozar returned a different route handle.');
      reconcileRouteOperationId(operationId, view.operationId);
      return { state: 'recorded', view };
    } catch (error) { if (!operationId || error.code !== 'route_not_found') throw error; }
  }
  if (routeNotDispatched(ref)) return { state: 'not-started' };
  const { routes } = await gozar.listRoutes({ home, owner: OWNER });
  const matches = routes.filter(route => route.operationId === operationId);
  if (matches.length > 1) throw new RouteError('route_conflict', 'More than one Gozar route matches the retained operation.');
  if (!matches.length) {
    if (handle) throw new RouteError('route_not_found', 'Gozar could not read the retained handle. Its reference was kept.');
    return { state: 'unobserved' };
  }
  const [view] = matches;
  if (handle && !sameRouteHandle(view.handle, handle)) {
    throw new RouteError('route_conflict', 'The retained operation was observed at a different route generation.');
  }
  return { state: 'recorded', view };
}

const PRE_ALLOCATION_REFUSALS = new Set(['candidate_stale', 'consent_expired', 'consent_mismatch', 'consent_required', 'consent_unknown']);

async function dispatchRouteOperation(query, recovery, remember, dispatch) {
  const { home, operationId } = query;
  if (!remember || !operationId) return dispatch(query);
  const ref = { home, operationId };
  if (!recovery) remember({ ...ref, phase: 'prepared' });
  remember({ ...ref, phase: 'dispatching' });
  try {
    const view = await dispatch(query);
    if (view?.handle) remember({ ...ref, handle: view.handle });
    return view;
  } catch (error) {
    if (error.route?.handle) remember({ ...ref, handle: error.route.handle });
    else if (!recovery?.handle && PRE_ALLOCATION_REFUSALS.has(error.code)) {
      // A refusal before reservation leaves a handle-less reference ready to retry.
      // The SDK supplies the retained view for refusals after reservation.
      remember({ ...ref, phase: 'prepared' });
    }
    throw error;
  }
}

const sameRouteHandle = (left, right) => left?.kind === right.kind && left?.id === right.id && left?.generation === right.generation;

export async function closeExactRoute(gozar, { home, operationId, handle }) {
  const recordedHandle = handle;
  try {
    if (!handle) {
      const observed = await observeRetainedRoute(gozar, { home, operationId });
      if (observed.state !== 'recorded') return { removed: false, detail: 'Gozar has not confirmed whether the retained operation started.' };
      const retained = observed.view;
      if (retained.state === 'released' && retained.cleanup.state === 'confirmed') return { removed: true };
      handle = retained.handle;
    }
    const closed = await gozar.closeRoute({ home, handle, mode: 'remove' });
    if (!sameRouteHandle(closed.handle, handle)) {
      return { removed: false, detail: 'Gozar returned cleanup evidence for a different handle.' };
    }
    if (closed.state === 'released' && closed.published === null && closed.cleanup.state === 'confirmed') return { removed: true };
    const remedy = closed.cleanup.nextAction ?? closed.binding?.remedy;
    const explanation = explainRouteError({ code: 'cleanup_debt', message: closed.cleanup.message, nextAction: remedy });
    return { removed: false, detail: [explanation.line, explanation.fix].filter(Boolean).join(' ') };
  } catch (error) {
    if (recordedHandle && error?.code === 'route_not_found') return { removed: true };
    return { removed: false, detail: explainRouteError(error).line };
  }
}

export function monitorRoute({ gozar, home, view, candidate, remove = true }) {
  const { handle, origin } = view;
  const watch = new AbortController();
  let reason = null, resolveEnded, handoffFailure = null;
  const exited = new Promise(resolve => { resolveEnded = resolve; });
  const end = why => { if (reason === null) reason = why; resolveEnded(reason); };
  let watcher;
  const watchPublished = (onProof = () => {}) => watcher ??= (async () => {
    let published;
    try {
      for await (const { route, type } of gozar.watchRoutes({ home, handle, signal: watch.signal })) {
        if (watch.signal.aborted) return;
        const ending = routeEnding(route, type, origin);
        if (ending) { end(ending); return; }
        const next = isPublished(route);
        if (published !== next) {
          published = next;
          try { await onProof(next); }
          catch (cause) {
            handoffFailure = new Error('Could not update the trial connection handoff.', { cause });
            end('handoff_failed');
            return;
          }
        }
      }
      if (!watch.signal.aborted) end('lost');
    } catch { if (!watch.signal.aborted) end('lost'); }
  })();
  let stopped = null;
  return {
    origin, handle, view, candidate, exited, watchPublished, endedBecause: () => reason, handoffFailure: () => handoffFailure,
    stop() {
      stopped ??= (async () => {
        watch.abort();
        await watcher;
        return remove ? closeExactRoute(gozar, { home, handle }) : { removed: true };
      })();
      return stopped;
    },
  };
}

export async function chooseRoute({ gozar, query, pick = pickCandidate, setup, match }) {
  const currentCatalog = async () => {
    const catalog = await gozar.catalogRoutes(query);
    if (!match) return catalog;
    const candidates = catalog.candidates.filter(match);
    if (!candidates.length) throw new RouteError('requirements_unsatisfied', 'Gozar offered no owner-managed route for this HTTPS origin and local listener.');
    return { ...catalog, candidates };
  };
  let catalog = await currentCatalog();
  let candidate = pick(catalog);
  if (setup) {
    const selected = candidate ?? catalog.candidates.filter(c => c.eligible && c.setup.state === 'action-required').sort((a, b) => a.rank - b.rank)[0];
    if (selected) {
      if (!await setup(selected)) throw new RouteError('setup_required', 'The current Gozar setup operation still needs attention.');
      if (!candidate) {
        catalog = await currentCatalog();
        candidate = pick(catalog);
      }
    }
  }
  if (!candidate) throw noCandidateError(catalog);
  return { candidate, catalog };
}

function noCandidateError(catalog) {
  const needsSetup = catalog.candidates.find(c => c.setup.state === 'action-required');
  if (needsSetup) return new RouteError('setup_required', 'A route needs one setup step before it can start.', { nextAction: needsSetup.setup.actions[0] ?? null });
  if (catalog.candidates.length && catalog.candidates.every(c => c.setup.state === 'unsupported')) return new RouteError('unsupported', 'No route is supported on this computer yet.');
  return new RouteError('requirements_unsatisfied', 'No route satisfies what Dalan needs.');
}

// ---- durable routes and external services ----------------------------------------------------------------------------------------------
// A durable route is never closed by an app exit. The first allocation asks once (the pin keeps the consent); a later call reuses it.
export async function ensureDurableRoute({ gozar, query, consent, reconsent = false, pick = pickCandidate, setup, remember, recovery, external = false }) {
  const options = reconsent ? { reconsent: true } : {};
  if (!recovery && !external) {
    try { return await gozar.ensureRoute({ ...query, ...options }); }
    catch (error) { if (!['consent_required', 'setup_required'].includes(error?.code)) throw error; }
  }
  const match = external ? candidate => candidate.ownership === 'external-owned' &&
    candidate.consent?.disclosures?.ownership === 'external-owned' &&
    typeof query.origin === 'string' && candidate.consent.scope?.query?.expectedOrigin === query.origin &&
    candidate.consent.scope.query.target === query.target : undefined;
  const { candidate, catalog } = await chooseRoute({ gozar, query, pick, setup, match });
  if (!await consent(candidate, catalog)) throw Object.assign(new RouteError('consent_required', 'The route was not started because consent was not given.'), { tryKind: 'consent' });
  const operationId = recovery?.operationId ?? (remember ? randomUUID() : undefined);
  const request = operationId ? { ...query, operationId } : query;
  return dispatchRouteOperation(request, recovery, remember,
    approved => gozar.ensureRoute({ ...approved, approval: approvalFor(candidate), ...options }));
}

export function requireExternalRoute(view, origin, target) {
  const observedTarget = view?.hostConfiguration?.target;
  const subject = view?.verification?.subject;
  if (view?.ownership !== 'external-owned' || view.origin !== origin || !observedTarget?.known || observedTarget.value !== target) {
    throw routeFailure(view, 'Gozar returned a route that does not match the requested existing address and listener.');
  }
  if (isPublished(view) && (subject?.origin !== origin || subject.target !== target ||
      !view.handle || subject.handleGeneration !== view.handle.generation)) {
    throw routeFailure(view, 'Gozar returned publication proof for a different address, listener or generation.');
  }
}

// ---- the Host a bridge accepts -----------------------------------------------------------------------------------------------------------
// A route may forward with the default port written out (`name:443`). The configured origin names no port, so both forms are the same
// authority. Nothing else changes: another host, another port or a prefix/suffix of the name stays refused.
export function canonicalHost(hostHeader, origin) {
  const url = new URL(origin);
  const host = String(hostHeader ?? '').toLowerCase();
  if (url.protocol === 'https:' && url.port === '' && host === `${url.hostname.toLowerCase()}:443`) return url.host;
  return hostHeader;
}
export function normalizeRequestHost(req, origin) {
  const canonical = canonicalHost(req.headers.host, origin);
  if (canonical !== req.headers.host) req.headers.host = canonical;
}

// ---- moving a 0.6 route to Gozar ----------------------------------------------------------------------------------------------------------
// Fence the old exposure code -> adopt while Dalan serves the proof -> restart -> commit v2 settings. Every step is journaled and
// fsynced. Anything uncertain stops with the old ingress and the old sign-in state untouched; there is no release-and-recreate fallback.
export const CRASH_POINTS = Object.freeze(['after-prepared', 'after-fence', 'after-fence-journal', 'after-adopt', 'after-adopt-journal', 'after-restart', 'after-commit-setting']);

export async function migrateLegacyRoute({
  gozar, env = process.env, gozarHome, routeName, routeId, origin, target, bridgeHome, stateFiles,
  fence, unfence, restart, authenticatedCheck, consent, crash = () => {}, generation,
}) {
  const hand = { from: `${OWNER}-legacy`, generation };
  const q = (extra = {}) => buildQuery({ home: gozarHome, target, usage: { kind: 'durable', routeId }, route: routeName, origin, address: 'stable', ...extra });
  const journal = phase => writeJournal({ phase, generation, origin, routeId }, env);
  // A halt lifts the fence (a no-op when nothing moved) and leaves the old ingress and the old sign-in state exactly as found.
  const halt = async (reason, extra = {}) => { await unfence().catch(() => {}); removeJournal(env); return { migrated: false, reason, ...extra }; };

  const existing = readJournal(env);
  if (existing?.phase === 'dalan-committed') { removeJournal(env); return { migrated: true, resumed: true }; }
  journal('prepared'); crash('after-prepared');

  // Already adopted by an earlier, interrupted run? An ensure without approval returns an existing pin and can never create one.
  let adopted = null;
  if (existing) {
    try { const view = await gozar.ensureRoute(q()); if (view.origin === origin) adopted = view; }
    catch (error) { if (error?.code !== 'consent_required' && error?.code !== 'route_not_found') throw error; }
  }
  if (!adopted) {
    // Gozar reads the old state where it was written: lift an earlier fence, inspect, then fence again.
    await unfence();
    const inspected = await gozar.inspectLegacyRoute({ home: gozarHome, owner: OWNER, source: { stateFiles: stateFiles() }, origin, target });
    if (inspected.state !== 'adoptable') return halt(inspected.reasonCode ?? inspected.state, { nextAction: inspected.nextAction ?? null });
    try { await fence(); } catch (error) { return halt(`the old exposure could not be fenced (${safeDiagnostic(error.message, 160)})`); }
    crash('after-fence'); journal('old-owner-fenced'); crash('after-fence-journal');
    const intent = q({ intent: 'adopt', migrationRef: inspected.migrationRef });
    const catalog = await gozar.catalogRoutes(intent);
    const candidate = pickCandidate(catalog);
    if (!candidate) return halt('Gozar offered no route to adopt this origin');
    if (!await consent(candidate, catalog)) return halt('adoption was not approved');
    try { adopted = await gozar.adoptRoute({ ...intent, origin, approval: approvalFor(candidate), handover: hand }); }
    catch (error) { return halt(`Gozar did not adopt the route (${explainRouteError(error).line}); the old route is unchanged`); }
    crash('after-adopt');
  }
  journal('gozar-adopted'); crash('after-adopt-journal');

  // Restart on the same home and prove the existing credentials still work through the same origin before committing.
  let ok = false;
  try { await restart(); crash('after-restart'); ok = await authenticatedCheck(); } catch (error) { if (error?.simulatedCrash) throw error; ok = false; }
  if (!ok) {
    // Two-phase hand-back: persist Gozar's opaque transfer, let the previous owner take over, then confirm. Never two mutators.
    const back = await gozar.releaseRoute({ routeId, mode: 'hand-back', home: gozarHome });
    writeJournal({ phase: 'gozar-adopted', generation, origin, routeId, transfer: back.transfer }, env);
    await unfence();
    await gozar.confirmHandBack({ routeId, transfer: back.transfer, home: gozarHome });
    removeJournal(env);
    return { migrated: false, reason: 'the existing sign-in did not work through the new route; the old route was handed back' };
  }
  writeRouteSetting({ version: 2, requirements: dalanRequirements({ address: 'stable' }), gozarHome, routeName: routeName ?? null, routeId, origin, bridgeHome: bridgeHome ?? null }, env);
  crash('after-commit-setting');
  journal('dalan-committed'); removeJournal(env);
  return { migrated: true, origin, routeId, view: adopted };
}

// The fence for the files a 0.6 install wrote: each `dot-bridge-<worker>.exposure.json` record is moved aside, so older code that reads
// the record can no longer act on the rule. Unfence moves it back. Both are repeatable, and neither touches the rule itself.
export const FENCE_SUFFIX = '.gozar-fence';
export function legacyRecordFiles(dir) {
  let names = []; try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(name => /^dot-bridge-.+\.exposure\.json(\.gozar-fence)?$/.test(name)).map(name => path.join(dir, name));
}
export function fenceLegacyRecords(dir) {
  const moved = [];
  for (const file of legacyRecordFiles(dir)) {
    if (file.endsWith(FENCE_SUFFIX)) { moved.push(file); continue; }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error(`${file} is not a regular file you own; ownership is unclear`);
    fs.renameSync(file, `${file}${FENCE_SUFFIX}`); moved.push(`${file}${FENCE_SUFFIX}`);
  }
  if (!moved.length) throw new Error('no old exposure record to fence; ownership is unclear');
  return moved;
}
export function unfenceLegacyRecords(dir) {
  for (const file of legacyRecordFiles(dir)) if (file.endsWith(FENCE_SUFFIX) && !fs.existsSync(file.slice(0, -FENCE_SUFFIX.length))) fs.renameSync(file, file.slice(0, -FENCE_SUFFIX.length));
}

export { readRouteSetting };
