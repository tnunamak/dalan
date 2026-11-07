import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

export function endpoint(name, value, { loopbackHttp = false, base = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be a valid HTTPS URL`); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (value !== value.trim() || (url.protocol !== 'https:' && !(loopbackHttp && loopback && url.protocol === 'http:')) ||
      url.username || url.password || url.hash || (base && url.search)) throw new Error(`${name} must be a valid HTTPS URL without credentials, query or fragment`);
  return url;
}

export function hostname(name, value) {
  const ascii = domainToASCII(value);
  if (value !== value.trim() || (!isIP(value) && (!ascii || ascii.length > 253 || !ascii.split('.').every(label => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i.test(label)))))
    throw new Error(`${name} must be a hostname or IP address without a port or path`);
}

export function appendPath(url, suffix) {
  const result = new URL(url);
  result.pathname = result.pathname.replace(/\/+$/, '') + suffix;
  return result.href;
}

export function protectedResourceMetadataUrl(resource) {
  const result = new URL(resource);
  result.pathname = '/.well-known/oauth-protected-resource' + (result.pathname === '/' ? '' : result.pathname);
  return result.href;
}

// RFC 9728 authorization_servers is an array of issuer identifiers. A string must be
// refused: String.prototype.includes would accept any value that merely contains the issuer.
export function listsIssuer(metadata, issuer) {
  return Array.isArray(metadata?.authorization_servers) && metadata.authorization_servers.includes(issuer);
}

export async function fetchProbe(name, url, options = {}) {
  const response = await fetch(url, { ...options, redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw Object.assign(new Error(`${name} probe must not redirect`), { targetValidation: true, probeRedirect: true });
  }
  return response;
}
