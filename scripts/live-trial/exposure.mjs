// The public route of a live trial is a Gozar session route. Setup records its handle in the manifest; teardown asks Gozar to remove exactly
// that handle and reads it back. Gozar's controller enforces the lifetime, so no separate cutoff process exists.
import { closeExactRoute, gozarHomeFor, resolveGozar } from '../../src/gozar-routes.mjs';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const HANDLE_KINDS = new Set(['session', 'attached', 'durable', 'external']);

export function validateExposure(exposure, localPort) {
  if (!isRecord(exposure)) throw new Error('trial exposure metadata is invalid');
  if (exposure.kind !== 'gozar-session') throw new Error('trial exposure kind is invalid');
  const handle = exposure.handle;
  if (!isRecord(handle) || !HANDLE_KINDS.has(handle.kind) || typeof handle.id !== 'string' || handle.id.length === 0 || !Number.isInteger(handle.generation) || handle.generation < 1) {
    throw new Error('trial exposure route handle is missing or invalid');
  }
  if (typeof exposure.gozar_home !== 'string' || !exposure.gozar_home.startsWith('/')) throw new Error('trial exposure Gozar home is missing or invalid');
  // Older manifests stored display fields in addition to the route reference.
  if (exposure.origin !== undefined && (typeof exposure.origin !== 'string' || new URL(exposure.origin).protocol !== 'https:')) throw new Error('trial exposure origin is invalid');
  if (exposure.local_port !== undefined && exposure.local_port !== localPort) throw new Error('trial exposure ports do not match the manifest');
  if (exposure.deadline_at !== undefined && (typeof exposure.deadline_at !== 'string' || !Number.isFinite(Date.parse(exposure.deadline_at)))) throw new Error('trial exposure deadline is invalid');
  return exposure;
}

export const exposureRecord = ({ view, home }) => ({ kind: 'gozar-session', gozar_home: home, handle: view.handle });

const recovery = (exposure, home, reason) => [
  `trial route shutdown was not verified (${reason}); the bridge and trial home are still running at ${home}.`,
  `Ask Gozar to remove route ${exposure.handle.kind}:${exposure.handle.id} (generation ${exposure.handle.generation}) in ${exposure.gozar_home}, then rerun teardown.`,
].join('\n');

// Require confirmed removal for the exact generation, including on a replay.
export async function closeAndVerifyRoute(exposure, home, { gozar } = {}) {
  const ref = { home: exposure.gozar_home ?? gozarHomeFor(), handle: exposure.handle };
  const runtime = gozar ?? await resolveGozar({ home: ref.home });
  const result = await closeExactRoute(runtime, ref);
  if (!result.removed) throw new Error(recovery(exposure, home, result.detail));
  return { state: 'released' };
}
