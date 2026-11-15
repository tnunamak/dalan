// Test-only preload; never imported by production code.
// Usage: node --import ./scripts/host-neutrality-preload.mjs <entry>
// The marker is intentionally distinct from ordinary module-not-found failures.
import { register } from 'node:module';

const hookSource = String.raw`
const blocked = new Set([
  '/src/t3.mjs',
  '/src/t3-transport.mjs',
  '/src/t3-control.mjs',
  '/src/t3-audit.mjs',
  '/src/destinations/t3.mjs',
]);
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  const url = new URL(resolved.url);
  // Queries/fragments cannot evade the file identity check. Non-file modules
  // remain outside the repository connector-removal experiment.
  if (url.protocol === 'file:') {
    const pathname = decodeURIComponent(url.pathname).replaceAll('\\', '/');
    const forbidden = [...blocked].some(suffix => pathname.endsWith(suffix)) ||
      pathname.includes('/integrations/t3/');
    if (forbidden) {
      const error = new Error('HOST_NEUTRALITY_BLOCKED: ' + pathname);
      error.code = 'ERR_MODULE_NOT_FOUND';
      // A caught import still leaves positive evidence that the hook fired.
      // Never print URL credentials, query strings or source contents.
      console.error('HOST_NEUTRALITY_BLOCKED: ' + pathname);
      throw error;
    }
  }
  return resolved;
}
`;
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url);
