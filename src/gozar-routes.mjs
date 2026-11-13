// The one place where Dalan reaches the network. Dalan asks Gozar for a route through its frozen consumer exports and branches only on
// the shapes and the 21 error codes of that contract (tnunamak/gozar, contract/route-contract-c0 @ 91b41a1; the pinned fixture is
// src/test-support/gozar-contract.json). Dalan never names a provider, never validates or translates a route id, and never builds a
// command for a provider: the id from `--route` goes to Gozar as `query.providerId`, exactly as written.
//
// Every function takes the Gozar module as `gozar`, so tests inject a fake that is checked against the same fixture.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeDiagnostic } from './diagnostic.mjs';
import { readJournal, removeJournal, writeJournal, readRouteSetting, writeRouteSetting } from './route-setting.mjs';

export const OWNER = 'dalan';
export const SCHEMA_VERSION = 1;
export const FROZEN_CODES = Object.freeze(['invalid_input', 'requirements_unsatisfied', 'setup_required', 'consent_required', 'consent_unknown', 'consent_expired',
  'consent_mismatch', 'candidate_stale', 'preference_conflict', 'route_not_found', 'route_conflict', 'address_changed', 'stopped_by_user', 'handing_back',
  'verification_failed', 'provider_unavailable', 'cleanup_debt', 'unsupported', 'ambiguous_route', 'busy', 'internal_error']);
// The exports Dalan calls. A Gozar that lacks one is older than the contract: that is `runtime_missing`, not a route error.
export const REQUIRED_EXPORTS = Object.freeze(['catalogRoutes', 'ensureRoute', 'adoptRoute', 'expose', 'routeStatus', 'closeRoute', 'watchRoutes', 'inspectLegacyRoute', 'runSetupAction', 'addService']);

export class RouteError extends Error {
  constructor(code, message, { nextAction = null, cause } = {}) { super(message, cause ? { cause } : undefined); this.name = 'RouteError'; this.code = code; this.nextAction = nextAction; }
}

// ---- finding Gozar ---------------------------------------------------------------------------------------------------------------------
const require = createRequire(import.meta.url);
// The bundled package, resolved from Dalan's own install tree (not the working directory). An install without the contract's exports
// is reported as `runtime_missing` with the next step; nothing falls back to another executable.
export async function resolveGozar({ importer = () => import('@tnunamak/gozar'), resolvePackage = () => require.resolve('@tnunamak/gozar/package.json') } = {}) {
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
  return module;
}

// Gozar's profile home for the real OS user. An explicit GOZAR_HOME selects a separate profile.
export const gozarHomeFor = (env = process.env) => path.resolve(env.GOZAR_HOME ?? path.join(env.HOME ?? os.homedir(), '.local', 'state', 'gozar'));

// ---- requests --------------------------------------------------------------------------------------------------------------------------
export const dalanRequirements = ({ address = 'any' } = {}) => ({ reach: 'internet', transport: 'https', payloadAccess: 'allow-provider', address, setup: 'allow', protocols: ['sse', 'streamable-http', 'oauth-dcr'] });

// `route` is the id the owner typed after `--route`. It becomes `query.providerId`, exactly as written; Gozar judges it and answers an unknown id with
// its own `route_not_found`. An empty or non-string value is refused only because it is no id at all.
export function buildQuery({ home, target, usage, route, origin, intent, migrationRef, address = 'any', requirements }) {
  if (route !== undefined && (typeof route !== 'string' || route.length === 0)) throw new RouteError('invalid_input', '--route needs an id');
  const query = { schemaVersion: SCHEMA_VERSION, owner: OWNER, target, usage, requirements: requirements ?? dalanRequirements({ address }), home };
  if (route !== undefined) query.providerId = route;
  if (origin !== undefined) query.origin = origin;
  if (intent !== undefined) query.intent = intent;
  if (migrationRef !== undefined) query.migrationRef = migrationRef;
  return query;
}
export const targetFor = port => `127.0.0.1:${port}`;

// ---- choosing and showing candidates (data only) ---------------------------------------------------------------------------------------
export const readyCandidates = catalog => [...catalog.candidates].filter(c => c.eligible && c.setup.state === 'ready' && typeof c.candidateToken === 'string').sort((a, b) => a.rank - b.rank);
export const pickCandidate = catalog => readyCandidates(catalog)[0] ?? null;
export const approvalFor = candidate => ({ candidateToken: candidate.candidateToken, disclosureRevision: candidate.disclosure.revision });

const yesNo = value => value === true ? 'yes' : value === false ? 'no' : 'unknown';
// One block of lines per candidate, built only from what Gozar returned. Labels name a provider only as returned display data.
export function describeCandidate(candidate, index) {
  const p = candidate.properties;
  const readers = p.traffic.readers.length ? p.traffic.readers.join(', ') : 'none listed';
  const ports = p.address.ports === null ? 'assigned by the provider' : p.address.ports.join(', ');
  const proof = `checked from ${p.proof.vantage}${p.proof.checks.length ? `; checks: ${p.proof.checks.join(', ')}` : '; no checks'}`;
  const lines = [`${index === undefined ? '' : `${index + 1}. `}${candidate.display.label}${candidate.eligible ? '' : ' (not usable for this)'}`, `   id: ${candidate.providerId}`, `   ${candidate.display.description}`,
    `   needs: ${candidate.display.needs}`, `   ports: ${ports}; proof: ${proof}`,
    `   reach: ${p.reach}; address: ${p.address.stability} (${p.address.scope}${p.address.conditions.length ? `; ${p.address.conditions.join('; ')}` : ''})`,
    `   traffic readers: ${readers}; provider can read payload: ${yesNo(p.traffic.providerCanReadPayload)}; ends TLS at: ${p.traffic.tlsTermination}`,
    `   cost: ${p.cost.summary}; account needed: ${yesNo(p.needsAccount)}; lifetimes: ${p.lifetimes.join(', ')}`];
  if (!candidate.eligible) lines.push(`   not met: ${candidate.unmet.map(u => `${u.requirement} (${u.reasonCode})`).join(', ')}`);
  if (candidate.setup.state !== 'ready') lines.push(`   setup: ${candidate.setup.state}${candidate.setup.actions.length ? `; actions: ${candidate.setup.actions.map(a => a.label).join('; ')}` : ''}`);
  return lines;
}
export function describeDisclosure(candidate) {
  const d = candidate.disclosure;
  return [d.text, ...d.links.map(l => `${l.label}: ${l.href}`)];
}

// Frozen code -> one line and the owner's next step. Provider diagnostics stay inside Gozar; Dalan prints only its own text, the
// message Gozar chose to expose, and the action Gozar names.
const EXPLAIN = {
  invalid_input: 'Dalan sent Gozar a request it refused as invalid.', requirements_unsatisfied: 'No route satisfies what Dalan needs (an HTTPS address reachable from the internet).',
  setup_required: 'A route needs one setup step first.', consent_required: 'This route needs your approval first.', consent_unknown: 'The approval was already used or is unknown. Ask for the choices again.',
  consent_expired: 'The approval expired. Ask for the choices again.', consent_mismatch: 'The approval was for a different request. Ask for the choices again.', candidate_stale: 'The route choice changed while you decided. Ask again.',
  preference_conflict: 'Your route preferences changed meanwhile. Try again.', route_not_found: 'Gozar has no route with that id.', route_conflict: 'Another owner or a newer route replaced this one; it was left untouched.',
  address_changed: 'The public address changed.', stopped_by_user: 'This route was stopped by you; approve it again to start it.', handing_back: 'The route is being handed back to its previous owner.',
  verification_failed: 'The route did not pass Gozar\'s check.', provider_unavailable: 'The route provider is unavailable right now.', cleanup_debt: 'A route could not be fully removed.',
  unsupported: 'This computer or request is not supported by any route.', ambiguous_route: 'Gozar cannot tell which existing route this is, so it changed nothing.',
  busy: 'Gozar is busy. Wait a moment and try again.', internal_error: 'Gozar had an unexpected fault.', runtime_missing: 'Gozar is not available.',
};
export function explainRouteError(error) {
  const code = typeof error?.code === 'string' && (FROZEN_CODES.includes(error.code) || error.code === 'runtime_missing') ? error.code : null;
  // Gozar's own message for an unknown id lists the ids it offers. It is printed as Gozar wrote it, with no second list here.
  if (code === 'route_not_found' && typeof error.message === 'string' && error.message) return { code, line: error.message, fix: null };
  if (!code) return { code: null, line: safeDiagnostic(String(error?.message ?? error), 240), fix: null };
  const action = error.nextAction ?? null;
  const fix = action ? [action.label, action.instructions, action.href].filter(Boolean).join(' - ') : null;
  const detail = code === 'runtime_missing' ? error.message : `${EXPLAIN[code]}${error.message && !EXPLAIN[code].includes(error.message) ? ` (${safeDiagnostic(error.message, 160)})` : ''}`;
  return { code, line: detail, fix };
}

// ---- a session route (`dalan try --public`) --------------------------------------------------------------------------------------------
// `consent(candidate)` shows the disclosure and resolves true only on an explicit yes. The route lasts for the trial and is closed with it.
const abortError = signal => signal.reason ?? Object.assign(new Error('stopped'), { name: 'AbortError', code: 'ABORT_ERR' });

// `wait: 'allocated'` is for a trial whose bridge needs the address before it can answer Gozar's check: Dalan then runs its own readiness check.
export async function startSessionRoute({ gozar, query, consent, signal, wait = 'verified', pick = pickCandidate }) {
  signal?.throwIfAborted();
  const catalog = await gozar.catalogRoutes(query);
  signal?.throwIfAborted();
  const candidate = pick(catalog);
  if (!candidate) throw noCandidateError(catalog);
  if (!await consent(candidate, catalog)) throw Object.assign(new RouteError('consent_required', 'No public route was started because consent was not given.'), { tryKind: 'consent' });
  let view;
  try { view = await gozar.expose({ ...query, approval: approvalFor(candidate), wait }); } catch (error) { throw error; }
  const handle = view?.handle;
  const closeNow = () => gozar.closeRoute({ home: query.home, handle, mode: 'remove' }).catch(() => null);
  let url; try { url = new URL(view.origin); } catch { /* rejected below */ }
  if (!handle || !url || url.protocol !== 'https:' || url.origin !== view.origin || (wait === 'verified' && (view.state !== 'usable' || view.verification?.status !== 'verified'))) {
    if (handle) await closeNow();
    throw new RouteError('verification_failed', 'Gozar did not return a verified HTTPS origin for this route.');
  }
  // Ctrl-C while Gozar was starting: the route exists now, so it is closed before the abort is reported.
  if (signal?.aborted) { await closeNow(); throw abortError(signal); }
  return sessionRoute({ gozar, home: query.home, view, candidate });
}

function sessionRoute({ gozar, home, view, candidate }) {
  const { handle, origin } = view;
  const watch = new AbortController();
  let reason = null, resolveEnded;
  const exited = new Promise(resolve => { resolveEnded = resolve; });
  const end = why => { if (reason === null) reason = why; resolveEnded(reason); };
  const watcher = (async () => {
    try {
      for await (const event of gozar.watchRoutes({ home, handle, signal: watch.signal })) {
        const route = event.route;
        // A route Gozar has not verified yet (the bridge was still starting when it looked) is pending, not lost. Dalan's own public
        // identity check covers a route that never works; only a lost or moved route ends the trial here.
        if (route.state === 'unverified' && !route.published) continue;
        if (event.type === 'snapshot' && route.state === 'usable' && route.published === origin) continue;
        if (route.state === 'usable' && route.published === origin) continue;
        if (route.state === 'address_changed' || (route.published && route.published !== origin)) end('rotated');
        else end('lost');
        return;
      }
      if (!watch.signal.aborted) end('lost');
    } catch (error) { if (!watch.signal.aborted) end('lost'); }
  })();
  let stopped = null;
  return {
    origin, handle, view, candidate, exited, endedBecause: () => reason,
    stop() { // idempotent; ends the watch first, then asks Gozar to remove exactly this handle
      stopped ??= (async () => {
        watch.abort(); await watcher.catch(() => {});
        try {
          const closed = await gozar.closeRoute({ home, handle, mode: 'remove' });
          if (closed.cleanup?.state === 'debt') return { removed: false, detail: `Gozar reports cleanup debt for this route: ${safeDiagnostic(closed.cleanup.message ?? 'no detail', 200)}. Run \`dalan setup\` to review it.` };
          return closed.state === 'released' ? { removed: true } : { removed: false, detail: `Gozar reports the route is ${closed.state}; its removal could not be confirmed.` };
        } catch (error) {
          if (error?.code === 'route_not_found') return { removed: true };
          if (error?.code === 'route_conflict') return { removed: false, detail: 'Gozar reports a newer route replaced this one, so cleanup of this trial could not be confirmed. The replacement was left untouched.' };
          return { removed: false, detail: `Gozar could not confirm the route removal (${explainRouteError(error).line}).` };
        }
      })();
      return stopped;
    },
  };
}

function noCandidateError(catalog) {
  const needsSetup = catalog.candidates.find(c => c.setup.state === 'action-required');
  if (needsSetup) return new RouteError('setup_required', 'A route needs one setup step before it can start.', { nextAction: needsSetup.setup.actions[0] ?? null });
  if (catalog.candidates.length && catalog.candidates.every(c => c.setup.state === 'unsupported')) return new RouteError('unsupported', 'No route is supported on this computer yet.');
  return new RouteError('requirements_unsatisfied', 'No route satisfies what Dalan needs.');
}

// ---- durable routes and external services ----------------------------------------------------------------------------------------------
// A durable route is never closed by an app exit. The first allocation asks once (the pin keeps the consent); a later call reuses it.
export async function ensureDurableRoute({ gozar, query, consent, reconsent = false, pick = pickCandidate }) {
  try { return await gozar.ensureRoute({ ...query, ...(reconsent ? { reconsent: true } : {}) }); }
  catch (error) { if (error?.code !== 'consent_required') throw error; }
  const catalog = await gozar.catalogRoutes(query);
  const candidate = pick(catalog);
  if (!candidate) throw noCandidateError(catalog);
  if (!await consent(candidate, catalog)) throw Object.assign(new RouteError('consent_required', 'The route was not started because consent was not given.'), { tryKind: 'consent' });
  return gozar.ensureRoute({ ...query, approval: approvalFor(candidate), ...(reconsent ? { reconsent: true } : {}) });
}

// Registers the owner's own origin (a route the owner runs) and reads it back through the same view as any other route.
export async function registerExternalService({ gozar, home, origin, target, verifyCmd }) {
  const reply = await gozar.addService({ origin, target, home, ...(verifyCmd ? { verifyCmd } : {}) });
  const route = reply?.route;
  if (reply?.schemaVersion !== SCHEMA_VERSION || route?.origin !== origin || route?.target !== target) throw new RouteError('verification_failed', 'Gozar returned a service route that does not match the requested origin and target.');
  const view = await gozar.routeStatus({ home, handle: { kind: 'external', id: origin, generation: 1 } });
  return { route, view };
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
