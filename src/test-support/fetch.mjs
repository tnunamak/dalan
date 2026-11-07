// Synchronous owner CLI calls can block these clients past the server's idle timeout.
// Use a fresh connection rather than racing pooled-socket closure or retrying OAuth writes.
export function fetchFresh(url, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('connection', 'close');
  return globalThis.fetch(url, { ...options, headers });
}
