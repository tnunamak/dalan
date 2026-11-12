// Display-only client conveniences: curated name, icon, setup hints and install links.
//
// This module is pure presentation. It imports no auth code and exports nothing that
// answers "may this client connect?". Callers must validate a redirect and make every
// approval decision first, then ask this module only how to label the result. Adding or
// deleting a data entry changes labels and nothing else.
//
// A deep link carries the owner's endpoint, which can contain a private path. The caller
// must show it behind an explicit Open action and must never log it or send it anywhere.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const readJson = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8'));
const SCHEMA = readJson('./client-conveniences.schema.json');

// ---- schema interpreter: the keyword subset used by client-conveniences.schema.json ----

const regexCache = new Map();
function regexFor(pattern) {
  let re = regexCache.get(pattern);
  if (!re) { re = new RegExp(pattern, 'u'); regexCache.set(pattern, re); }
  return re;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function resolveRef(ref) {
  const m = /^#\/definitions\/([A-Za-z]+)$/.exec(ref);
  const node = m && SCHEMA.definitions[m[1]];
  if (!node) throw new Error('unsupported schema reference');
  return node;
}

function check(node, value, path, errors) {
  if (node.$ref) return check(resolveRef(node.$ref), value, path, errors);
  if (node.oneOf) {
    const passing = node.oneOf.filter((n) => { const e = []; check(n, value, path, e); return e.length === 0; });
    if (passing.length !== 1) errors.push(`${path}: must match exactly one alternative`);
    return undefined;
  }
  if ('const' in node && value !== node.const) { errors.push(`${path}: must equal ${JSON.stringify(node.const)}`); return undefined; }
  if (node.enum && !node.enum.includes(value)) { errors.push(`${path}: not an allowed value`); return undefined; }
  if (node.type && typeOf(value) !== node.type) { errors.push(`${path}: must be ${node.type}`); return undefined; }
  if (node.type === 'string') {
    if (node.minLength !== undefined && value.length < node.minLength) errors.push(`${path}: too short`);
    if (node.maxLength !== undefined && value.length > node.maxLength) errors.push(`${path}: too long`);
    if (node.pattern && !regexFor(node.pattern).test(value)) errors.push(`${path}: does not match the allowed form`);
  } else if (node.type === 'array') {
    if (node.maxItems !== undefined && value.length > node.maxItems) errors.push(`${path}: too many items`);
    if (node.minItems !== undefined && value.length < node.minItems) errors.push(`${path}: too few items`);
    if (node.uniqueItems && new Set(value).size !== value.length) errors.push(`${path}: items must be unique`);
    if (node.items) value.forEach((v, i) => check(node.items, v, `${path}/${i}`, errors));
  } else if (node.type === 'object') {
    const props = node.properties ?? {};
    for (const key of node.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}: missing ${key}`);
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(props, key)) check(props[key], value[key], `${path}/${key}`, errors);
      else if (node.additionalProperties === false) errors.push(`${path}: unknown field ${key}`);
    }
  }
  return undefined;
}

const isRealDate = (s) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };

export function validateCatalog(catalog) {
  const errors = [];
  check(SCHEMA, catalog, '#', errors);
  if (errors.length === 0) {
    const ids = new Set();
    const origins = new Map();
    for (const c of catalog.clients) {
      if (ids.has(c.id)) errors.push(`duplicate id ${c.id}`);
      ids.add(c.id);
      if (!isRealDate(c.evidence.checkedAt)) errors.push(`${c.id}: impossible evidence date`);
      if (c.deepLink && !isRealDate(c.deepLink.checkedAt)) errors.push(`${c.id}: impossible link date`);
      for (const o of c.verifiedRedirectOrigins) {
        let normal = null;
        try { normal = new URL(o).origin; } catch { /* reported below */ }
        if (normal !== o) errors.push(`${c.id}: origin is not exact`);
        if (origins.has(o)) errors.push(`${c.id}: origin already claimed by ${origins.get(o)}`);
        origins.set(o, c.id);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---- helper ----

function deepFreeze(v) {
  if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); }
  return v;
}

const URL_MAX = 2048;
const UNSAFE_CHARS = /[\u0000- \u007f\\]/;

function parseHttps(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > URL_MAX || UNSAFE_CHARS.test(value)) return null;
  let u;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return null;
  return u;
}

function encodeConfig(encoding, endpoint, name) {
  if (encoding === 'base64-json') {
    return encodeURIComponent(Buffer.from(JSON.stringify({ url: endpoint }), 'utf8').toString('base64'));
  }
  return encodeURIComponent(JSON.stringify({ name, type: 'http', url: endpoint }));
}

export function createConvenience(catalog) {
  const verdict = validateCatalog(catalog);
  if (!verdict.ok) throw new Error(`invalid client conveniences: ${verdict.errors[0]}`);
  const clients = deepFreeze(structuredClone(catalog)).clients;
  const byOrigin = new Map();
  const byId = new Map();
  for (const c of clients) {
    byId.set(c.id, c);
    for (const o of c.verifiedRedirectOrigins) byOrigin.set(o, c);
  }

  return Object.freeze({
    // Call only after the redirect has passed the caller's own validation. Returns a fresh
    // label object or null. Loopback, http and any origin not listed exactly get null.
    displayFor(redirectUri) {
      const u = parseHttps(redirectUri);
      const c = u && byOrigin.get(u.origin);
      return c ? { name: c.name, icon: c.icon, clientConvenienceId: c.id } : null;
    },
    hintsFor(id) {
      const c = byId.get(id);
      return c ? [...c.setupHints] : [];
    },
    listClients() {
      return clients.map((c) => ({ id: c.id, name: c.name, icon: c.icon, setupHints: [...c.setupHints], hasDeepLink: c.deepLink !== null }));
    },
    // Returns {url, target, requiresExplicitOpen:true} or null. Never log or transmit url.
    deepLinkFor(id, { endpoint, name } = {}) {
      const c = byId.get(id);
      if (!c || !c.deepLink) return null;
      const target = parseHttps(endpoint);
      if (!target || target.hash || typeof name !== 'string' || name.length === 0 || name.length > 200) return null;
      const link = c.deepLink;
      const url = link.template.replace(/\{(endpoint|name|config)\}/g, (_, key) => {
        if (key === 'endpoint') return encodeURIComponent(endpoint);
        if (key === 'name') return encodeURIComponent(name);
        return encodeConfig(link.encoding, endpoint, name);
      });
      return { url, target: c.name, requiresExplicitOpen: true };
    },
  });
}

export const bundledCatalog = deepFreeze(readJson('./client-conveniences.json'));
const bundled = createConvenience(bundledCatalog);
export const displayFor = bundled.displayFor;
export const hintsFor = bundled.hintsFor;
export const listClients = bundled.listClients;
export const deepLinkFor = bundled.deepLinkFor;
