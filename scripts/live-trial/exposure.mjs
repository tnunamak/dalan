// The public route of a live trial is a Gozar session route. Setup records its handle in the manifest; teardown asks Gozar to remove exactly
// that handle and reads it back. Gozar's controller enforces the lifetime, so no separate cutoff process exists.
import { gozarHomeFor, resolveGozar } from '../../src/gozar-routes.mjs';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const HANDLE_KINDS = new Set(['session', 'durable', 'external']);

export function validateExposure(exposure, localPort) {
  if (!isRecord(exposure)) throw new Error('trial exposure metadata is invalid');
  if (exposure.kind !== 'gozar-session') throw new Error('trial exposure kind is invalid');
  const handle = exposure.handle;
  if (!isRecord(handle) || !HANDLE_KINDS.has(handle.kind) || typeof handle.id !== 'string' || handle.id.length === 0 || !Number.isInteger(handle.generation) || handle.generation < 1) {
    throw new Error('trial exposure route handle is missing or invalid');
  }
  if (typeof exposure.gozar_home !== 'string' || !exposure.gozar_home.startsWith('/')) throw new Error('trial exposure Gozar home is missing or invalid');
  if (typeof exposure.origin !== 'string' || new URL(exposure.origin).protocol !== 'https:') throw new Error('trial exposure origin is missing or invalid');
  if (exposure.local_port !== localPort) throw new Error('trial exposure ports do not match the manifest');
  if (typeof exposure.deadline_at !== 'string' || !Number.isFinite(Date.parse(exposure.deadline_at))) throw new Error('trial exposure deadline is missing or invalid');
  return exposure;
}

export const exposureRecord = ({ view, home, localPort, lifetimeMs, now = Date.now }) => ({
  kind: 'gozar-session', gozar_home: home, handle: view.handle, origin: view.origin, local_port: localPort, deadline_at: new Date(now() + lifetimeMs).toISOString(),
});

const recovery = (exposure, home, reason) => [
  `trial route shutdown was not verified (${reason}); the bridge and trial home are still running at ${home}.`,
  `Ask Gozar to remove route ${exposure.handle.kind}:${exposure.handle.id} (generation ${exposure.handle.generation}) in ${exposure.gozar_home}, then rerun teardown.`,
].join('\n');

// Closes the recorded handle and reads it back. A route that is already gone counts as closed; anything unconfirmed throws.
export async function closeAndVerifyRoute(exposure, home, { gozar } = {}) {
  const runtime = gozar ?? await resolveGozar();
  const ref = { home: exposure.gozar_home ?? gozarHomeFor(), handle: exposure.handle };
  let closed;
  try { closed = await runtime.closeRoute({ ...ref, mode: 'remove' }); } catch (error) {
    if (error?.code !== 'route_not_found') throw new Error(recovery(exposure, home, `close failed: ${error?.code ?? error?.message}`));
    return { state: 'gone' };
  }
  if (closed.cleanup?.state === 'debt') throw new Error(recovery(exposure, home, 'Gozar reports cleanup debt'));
  if (closed.state !== 'released') throw new Error(recovery(exposure, home, `route state is ${closed.state}`));
  try {
    const after = await runtime.routeStatus(ref);
    if (after.published) throw new Error(recovery(exposure, home, 'the route still publishes an address'));
  } catch (error) { if (error?.code !== 'route_not_found' && !/still publishes/.test(error?.message ?? '')) throw new Error(recovery(exposure, home, `status unavailable (${error?.code ?? error?.message})`)); if (/still publishes/.test(error.message)) throw error; }
  return { state: 'released' };
}
