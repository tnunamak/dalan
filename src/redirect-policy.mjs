// The redirect-URI policy of the built-in authorization server. It is a pure function of the URI's own properties:
// no I/O, no client name, no brand, no list of vendors. Who may connect is decided by the owner's approval of one pairing
// code and the redirect shown with it, not by this file. This file only refuses URIs that could not be a safe browser target.
//
// Accepted:
//  - HTTPS, a dotted DNS host in lower-case ASCII (punycode for IDN) that is not an IP address, no userinfo, no fragment,
//    canonical spelling, a fixed query kept byte for byte.
//  - Native loopback (RFC 8252): http://127.0.0.1, http://[::1] or exactly http://localhost, any port, a canonical path, no query.
// Everything else (other schemes, remote HTTP, wildcards, IP-literal HTTPS, aliases of loopback) is refused.

const MAX_LENGTH = 512;
const UNSAFE = /[\p{C}\p{Z}\\]/u; // controls, format and separator characters (bidi marks, spaces, NUL) and backslash
const HTTPS_HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::([0-9]+))?(\/[A-Za-z0-9._~\-/]*)$/;

const refuse = reason => ({ ok: false, reason });

export function validateRedirectUri(uri) {
  if (typeof uri !== 'string' || !uri) return refuse('redirect URI must be a non-empty string');
  if (uri.length > MAX_LENGTH) return refuse(`redirect URI is longer than ${MAX_LENGTH} characters`);
  if (UNSAFE.test(uri)) return refuse('redirect URI has control, space, separator or backslash characters');
  if (uri.includes('#')) return refuse('redirect URI must not have a fragment');
  if (uri.includes('*')) return refuse('redirect URI must not contain a wildcard');
  let url;
  try { url = new URL(uri); } catch { return refuse('redirect URI is not a valid URL'); }
  // The registered string is the one the client will send back. It must already be in canonical form: the parser may not
  // rewrite case, default ports, dot segments, escapes or numeric host spellings behind our back.
  if (url.href !== uri) return refuse('redirect URI is not in canonical spelling');
  if (url.username || url.password) return refuse('redirect URI must not carry credentials');
  if (url.protocol === 'https:') {
    const host = url.hostname;
    if (!HTTPS_HOST.test(host)) return refuse('HTTPS redirect needs a dotted lower-case ASCII host name');
    if (/^[0-9]+$/.test(host.slice(host.lastIndexOf('.') + 1))) return refuse('HTTPS redirect must use a host name, not an IP address');
    if (host === 'localhost' || host.endsWith('.localhost')) return refuse('HTTPS redirect must not name localhost');
    return { ok: true, kind: 'https', origin: url.origin, host, uri, punycode: host.split('.').some(label => label.startsWith('xn--')) };
  }
  if (url.protocol === 'http:') {
    const match = LOOPBACK.exec(uri);
    if (!match) return refuse('HTTP is only allowed for http://127.0.0.1, http://[::1] or http://localhost');
    const [, host, port, pathname] = match;
    if (port !== undefined && (String(Number(port)) !== port || Number(port) < 1 || Number(port) > 65535)) return refuse('loopback port must be from 1 to 65535');
    const segments = pathname.split('/').slice(1);
    if (pathname !== '/' && segments.some(s => !s || s === '.' || s === '..')) return refuse('loopback path must have exact canonical segments');
    return { ok: true, kind: 'loopback', origin: `http://${host}`, host, uri, punycode: false };
  }
  return refuse('redirect URI must use https, or http on loopback');
}

// The origin that groups review and revocation. It never grants anything on its own. Null when the URI is not valid.
export const redirectOrigin = uri => { const r = validateRedirectUri(uri); return r.ok ? r.origin : null; };

// Does a requested redirect match one the client registered? Exact string, or native loopback where only the port differs.
export function matchRegisteredRedirect(registered, requested) {
  if (!Array.isArray(registered) || typeof requested !== 'string') return false;
  return registered.some(uri => {
    if (uri === requested) return true;
    const a = validateRedirectUri(uri), b = validateRedirectUri(requested);
    if (!a.ok || !b.ok || a.kind !== 'loopback' || b.kind !== 'loopback') return false;
    return a.host === b.host && new URL(uri).pathname === new URL(requested).pathname;
  });
}
