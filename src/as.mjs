import { uaToken } from './mcp-outcome.mjs';
import { Provider, errors } from 'oidc-provider';
import { ACCEPTED_SCOPES, ADVERTISED_SCOPES, canonicalScopes } from './scopes.mjs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { acquireAsOwner, asFiles, LIFETIMES, PAIRING_MINUTES, loadAsConfig, loadKeys, isLoopbackCallback, matchesCallback, parseAsConfig, parseCallbackPattern, parseNativeLoopback, saveAsCallbacks, untrusted } from './as-files.mjs';
import { AsStore, LIMITS, normalizeCode, showCode } from './as-store.mjs';

// The built-in authorization server. The protocol (registration, PKCE, codes, tokens, rotation, revocation) is the maintained
// oidc-provider library. This file holds only configuration, the owner-approval policy around it, and the lookup that turns a
// bearer token into an approved connection. It implements no OAuth protocol cryptography.
export const SCOPES = ADVERTISED_SCOPES;
export const ACCOUNT = 'owner';
const ACCESS_TOKEN_TTL = 3600;
const OFF = Object.freeze({ enabled: false });
const html = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export { untrusted };
const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
});
// Metadata that would make the server fetch a URL or hold extra trust. None of these is supported (the library only reads them when a feature that is off uses them).
const FORBIDDEN_METADATA = ['jwks_uri', 'jwks', 'sector_identifier_uri', 'request_uris', 'initiate_login_uri', 'post_logout_redirect_uris', 'backchannel_logout_uri', 'frontchannel_logout_uri'];

function page(res, status, title, body, { refresh = 0 } = {}) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}<title>${html(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem}.code{font:700 2rem/1.2 ui-monospace,monospace;letter-spacing:.1em}pre{background:#eee;padding:.6rem;overflow:auto}</style></head><body><h1>${html(title)}</h1>${body}</body></html>`);
}

export function createAs(options) {
  const owner = options.owner ?? acquireAsOwner(options.dir);
  try { return createOwnedAs(options, owner); }
  catch (error) { owner.release(); throw error; }
}

function createOwnedAs({ dir, resource, allowHttp = false, loopback = false, workerNames, log = () => {}, now = Date.now, onConnectionRevoked = () => {} }, owner) {
  const config = loadAsConfig(dir, { allowHttp, loopback });
  // Ownership precedes every key-state write and stays held while this provider can sign.
  owner.pruneKeys(now());
  const keys = loadKeys(dir); // missing, damaged or non-working keys stop the start
  const files = asFiles(dir);
  const store = new AsStore(files.db, { now, limits: config.limits });
  const publicUrl = new URL(config.public_url);
  const resourceUrl = new URL(resource);
  if (!/^\/[^/]+\/mcp$/.test(resourceUrl.pathname) || resourceUrl.search || resourceUrl.hash) throw new Error('as: resource needs a secret path prefix and /mcp');
  const PREFIX = `${resourceUrl.pathname.slice(0, -4)}/oauth`;
  const issuer = `${publicUrl.origin}${PREFIX}`;
  const secure = publicUrl.protocol === 'https:';
  if (!secure && !allowHttp && !loopback) throw new Error('as: an http public_url needs the explicit test flag');
  let patterns = config.patterns;
  if (new URL(resource).origin !== publicUrl.origin) throw new Error('as: resource must live on the public URL');
  const callbackAllowed = uri => matchesCallback(patterns, uri);
  // Native registrations ignore only the port; the approved request still binds the full redirect URI.
  const registeredRedirectAllowed = (client, redirect) => client?.redirectUris?.some(uri => {
    if(uri===redirect)return true;
    try {
      const requested = parseNativeLoopback(redirect);
      const registered = parseNativeLoopback(uri);
      return requested.loopback && registered.loopback
        && requested.hostname === registered.hostname && requested.pathname === registered.pathname;
    } catch { return false; }
  });

  const policy = (ctx, metadata) => {
    if (Buffer.byteLength(JSON.stringify(metadata)) > 4096 || (metadata.client_name?.length ?? 0) > 128 || (metadata.redirect_uris?.length ?? 0) > 8 || metadata.redirect_uris?.some(uri => uri.length > 512)) throw new errors.InvalidClientMetadata('client metadata exceeds the size limit');
    if (!metadata.redirect_uris?.length) throw new errors.InvalidClientMetadata('redirect_uris is required');
    for (const uri of metadata.redirect_uris) {
      if (!callbackAllowed(uri)) {
        log({ kind: 'as_registration_refused' });
        throw new errors.InvalidClientMetadata('redirect_uris must each match an allowed vendor callback (dalan connect allow-callback)');
      }
    }
    const nativeRedirects = metadata.redirect_uris.map(uri => isLoopbackCallback(new URL(uri)));
    if (nativeRedirects.some(Boolean) && !nativeRedirects.every(Boolean)) throw new errors.InvalidClientMetadata('native and HTTPS redirect URIs cannot be mixed');
    // Some vendors register as non-web clients. The callbacks above are exact allowlisted https vendor URLs, so the
    // client behaves as a web client here: normalize it rather than refuse. Anything else stays refused.
    if (metadata.redirect_uris.every(uri => isLoopbackCallback(new URL(uri)))) {
      metadata.application_type = 'native';
    } else if (metadata.application_type !== 'web') {
      if (!metadata.redirect_uris.every(uri => uri.startsWith('https://'))) throw new errors.InvalidClientMetadata('only web clients are supported');
      metadata.application_type = 'web';
    }
    for (const key of FORBIDDEN_METADATA) {
      const value = metadata[key];
      if (value !== undefined && !(Array.isArray(value) && !value.length)) throw new errors.InvalidClientMetadata(`${key} is not supported`);
    }
    for (const type of metadata.grant_types ?? []) if (!['authorization_code', 'refresh_token'].includes(type)) throw new errors.InvalidClientMetadata('grant_types may only be authorization_code and refresh_token');
    if (ctx.oidc?.route === 'registration' && store.clientCount() >= LIMITS.clients) throw new errors.InvalidClientMetadata('the client registration limit is reached');
  };

  const configuration = {
    adapter: store.Adapter,
    jwks: keys.jwks,
    cookies: {
      keys: keys.cookieKeys,
      long: { httpOnly: true, sameSite: 'lax', secure },
      short: { httpOnly: true, sameSite: 'lax', secure },
    },
    clients: [],
    // Public web clients only: PKCE replaces a client secret. No other client authentication method exists.
    clientAuthMethods: ['none'],
    clientDefaults: { grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'web', id_token_signed_response_alg: 'ES256' },
    enabledJWA: { idTokenSigningAlgValues: ['ES256'] },
    allowOmittingSingleRegisteredRedirectUri: false,
    acceptQueryParamAccessTokens: false,
    responseTypes: ['code'],
    scopes: [...ACCEPTED_SCOPES],
    pkce: { required: () => true }, // S256 is the only method the library supports
    ttl: { AuthorizationCode: 600, AccessToken: ACCESS_TOKEN_TTL, RefreshToken: 30 * 86400, Grant: 90 * 86400, Interaction: LIFETIMES.interaction, Session: LIFETIMES.session, IdToken: LIFETIMES.idToken, ClientCredentials: 600, DeviceCode: 600 },
    rotateRefreshToken: true,
    // A connection is the owner's approval, not a browser login: its tokens must not die with the pairing session.
    // oidc-provider's default binds them to the session unless the client asks for offline_access. Revocation stays per connection.
    expiresWithSession: async () => false,
    issueRefreshToken: async (ctx, client) => client.grantTypeAllowed('refresh_token'),
    findAccount: async (ctx, sub) => sub === ACCOUNT ? { accountId: ACCOUNT, claims: async () => ({ sub: ACCOUNT }) } : undefined,
    // Consent comes only from the grant that the owner's approval created for this very interaction, and only while its
    // connection is active. A session, an earlier grant or a revoked connection never authorizes a new request.
    loadExistingGrant: async ctx => {
      const grantId = ctx.oidc.result?.consent?.grantId;
      if (!grantId) return undefined;
      const connection = store.connectionByGrant(grantId);
      const client = ctx.oidc.client;
      if (!connection || connection.revoked_at !== null || connection.client_id !== client?.clientId) return undefined;
      const grant = await ctx.oidc.provider.Grant.find(grantId);
      return grant && grant.accountId === ACCOUNT && grant.clientId === client.clientId ? grant : undefined;
    },
    interactions: { url: async (ctx, interaction) => `${PREFIX}/interaction/${interaction.uid}` },
    extraClientMetadata: { properties: ['dot_bridge_policy'], validator: (ctx, key, value, metadata) => { if (ctx) policy(ctx, metadata); } },
    renderError: async (ctx, out) => {
      ctx.type = 'html';
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) ctx.set(name, value);
      ctx.body = `<!doctype html><title>Error</title><h1>Error</h1><p>${html(out.error)}</p><p>${html(out.error_description ?? '')}</p>`;
    },
    features: {
      devInteractions: OFF, dPoP: OFF, pushedAuthorizationRequests: OFF, rpInitiatedLogout: OFF, userinfo: OFF, introspection: OFF,
      backchannelLogout: OFF, ciba: OFF, mTLS: OFF, attestClientAuth: OFF, clientIdMetadataDocument: OFF, claimsParameter: OFF,
      clientCredentials: OFF, deviceFlow: OFF, encryption: OFF, fapi: OFF, jwtIntrospection: OFF, jwtResponseModes: OFF,
      registrationManagement: OFF, richAuthorizationRequests: OFF, requestObjects: OFF, rpMetadataChoices: OFF, jwtUserinfo: OFF,
      webMessageResponseMode: OFF, externalSigningSupport: OFF, openid4vci: OFF,
      registration: { enabled: true, initialAccessToken: false, issueRegistrationAccessToken: false },
      revocation: { enabled: true },
      resourceIndicators: {
        enabled: true,
        defaultResource: async () => undefined,
        useGrantedResource: async () => true,
        getResourceServerInfo: async (ctx, indicator) => {
          if (indicator !== resource) throw new errors.InvalidTarget();
          return { scope: ACCEPTED_SCOPES.join(' '), audience: resource, accessTokenTTL: ACCESS_TOKEN_TTL, accessTokenFormat: 'opaque' };
        },
      },
    },
  };

  // Serialize refresh exchanges so a duplicate cannot enter the provider before its receipt is committed.
  let refreshTail = Promise.resolve();
  class BridgeProvider extends Provider {
    registerGrantType(name, handler, params, dupes) {
      if (name !== 'refresh_token') return super.registerGrantType(name, handler, params, dupes);
      return super.registerGrantType(name, async ctx => {
        let release;
        const previous = refreshTail;
        refreshTail = new Promise(resolve => { release = resolve; });
        await previous;
        try {
          const tokenValue = ctx.oidc.params.refresh_token;
          const source = await ctx.oidc.provider.RefreshToken.find(tokenValue, { ignoreExpiration: true });
          // Do not intercept other client authentication or sender-constrained credentials.
          if (!source || configuration.features.dPoP.enabled || configuration.features.mTLS.enabled || configuration.features.attestClientAuth.enabled || ctx.get('dpop') || ctx.oidc.client.clientAuthMethod !== 'none' || source.jkt || source['x5t#S256'] || source.attestationJkt) return await handler(ctx);
          const clientId = ctx.oidc.client.clientId;
          const fingerprint = JSON.stringify([issuer, resource, Object.fromEntries(Object.keys(ctx.oidc.params).sort().map(key => [key, ctx.oidc.params[key]]))]);
          const receipt = source.consumed && store.refreshReceipt(tokenValue);
          const retry = receipt && receipt.grant_id === source.grantId && receipt.value.clientId === clientId &&
            receipt.value.params === fingerprint && store.refreshValid(source.grantId, clientId, receipt.value.response.refresh_token);
          if (source.consumed && !retry) return await handler(ctx);
          const exchange = { reads: [], writes: [], retryToken: retry ? tokenValue : undefined };
          try { await store.refreshExchange.run(exchange, () => handler(ctx)); }
          catch (error) {
            // A rejected resource was checked after consume in the provider. Preserve that
            // replay behavior; internal failures leave the original token untouched.
            if (!retry && error instanceof errors.InvalidTarget) store.commitFailedRefresh(exchange);
            throw error;
          }
          if (source.exp * 1000 <= Date.now()) throw new errors.InvalidGrant('refresh token expired');
          if (retry) {
            if (!store.refreshReceipt(tokenValue)) return await handler(ctx);
            if (!store.refreshValid(source.grantId, clientId, receipt.value.response.refresh_token) ||
                exchange.reads.some(([model, id, original]) => JSON.stringify(store.find(model, id)) !== original)) throw new errors.InvalidGrant('refresh state changed');
            ctx.body = receipt.value.response;
          } else {
            store.commitRefresh(exchange, source.grantId, clientId, tokenValue, fingerprint, ctx.body, now() + 5000);
          }
        } finally { release(); }
      }, params, dupes);
    }
  }
  const provider = new BridgeProvider(issuer, configuration);
  provider.proxy = true; // Protocol and host come from the headers that this file writes, never from the client's
  provider.use(async (ctx, next) => {
    // The router ignores case and a trailing slash, so compare the normalised path. The store refuses to persist an interaction
    // outside an open window as well (as-store.mjs), so no spelling of the route can create one.
    const route = ctx.path.toLowerCase().replace(/\/+$/, '');
    const refuse = (status, title, text) => { ctx.status = status; ctx.type = 'html'; ctx.body = `<!doctype html><title>${title}</title><h1>${title}</h1><p>${text}</p>`; };
    if (route === '/reg' && ctx.method === 'POST') {
      const reject = (status, error, description) => { ctx.status = status; ctx.body = { error, error_description: description }; };
      if (!store.window()) return reject(403, 'access_denied', 'Open a pairing window before registering.');
      if (!store.reserveRegistration()) return reject(429, 'temporarily_unavailable', 'Registration limit reached. Reuse the client this worker already registered. If you cannot, ask the owner to run dalan connect reset, then retry.');
      if (Number(ctx.get('content-length')) > 8192) return reject(413, 'invalid_client_metadata', 'Registration body exceeds 8192 bytes.');
      if (!await normalizeRegistration(ctx.req)) { ctx.req.destroy(); return; } // over 8192 bytes
      let bytes = 0;
      const count = chunk => { bytes += chunk.length; if (bytes > 8192) ctx.req.destroy(); };
      ctx.req.on('data', count);
      try { await next(); } finally { ctx.req.off('data', count); }
      return;
    }
    if (route === '/token' && ctx.method === 'POST') {
      await next();
      // Names and shapes only, never a value of a secret: what a client sent and what it was given back.
      const sent = ctx.oidc?.body ?? {}, given = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
      log({ kind: 'as_token_detail', status: ctx.status, grant_type: typeof sent.grant_type === 'string' ? sent.grant_type.slice(0, 40) : null, request_params: Object.keys(sent).sort(), response_has: ['access_token', 'refresh_token', 'id_token', 'scope', 'expires_in', 'token_type'].filter(k => given[k] !== undefined).map(k => k.replace('_token', 'Tok')), token_type: given.token_type ?? null, scope: given.scope ?? null, expires_in: given.expires_in ?? null, has_resource: Boolean(sent.resource) });
      return;
    }
    if (route === '/auth' && ctx.query.response_type !== 'code') return refuse(400, 'Unsupported response type', 'Only response_type=code is supported.');
    if (route === '/auth' || route.startsWith('/auth/')) {
      // Only response_mode=query is supported: form_post would need a script-free page the CSP cannot allow.
      const mode = ctx.query.response_mode;
      if (mode !== undefined && mode !== 'query') {
        ctx.status = 400; ctx.type = 'html';
        ctx.body = '<!doctype html><title>Unsupported response mode</title><h1>Unsupported response mode</h1><p>Only response_mode=query is supported.</p>';
        return;
      }
    }
    if (route === '/auth' && store.window() && store.interactionsFull()) {
      ctx.set('retry-after', '60');
      return refuse(503, 'Busy', 'Too many connection attempts are waiting. Ask the owner to run dalan connect reset, then retry.');
    }
    if (route === '/auth' && !store.window()) {
      ctx.status = 403; ctx.type = 'html';
      ctx.body = '<!doctype html><title>Not accepting connections</title><h1>Not accepting connections</h1><p>This bridge is not accepting new connections right now.</p>';
      return;
    }
    await next();
    // Discovery tells the truth about what this server accepts (the library lists modes and types it also supports).
    if (ctx.body && typeof ctx.body === 'object' && ctx.body.issuer === issuer && ctx.body.authorization_endpoint) {
      ctx.body = { ...ctx.body, response_modes_supported: ['query'], response_types_supported: ['code'] };
    }
  });
  store.onGrantRevoked = (grantId, reason) => {
    log({ kind: 'as_grant_revoked', reason });
    const connection=store.connectionByGrant(grantId);
    if(connection) onConnectionRevoked(connection.connection_id,reason);
  };
  provider.on('grant.revoked', (ctx, grantId) => store.revokeGrant(grantId, 'grant_revoked'));
  for (const event of ['server_error', 'authorization.error', 'grant.error', 'registration_create.error']) {
    provider.on(event, (ctx, error) => {
      // Provider error text and field names can contain request secrets.
      log({ kind: 'as_error', event });
    });
  }
  const callback = provider.callback();
  const purge = () => { try { const r = store.purge(); if (r.expired || r.stale_clients) log({ kind: 'as_purge', ...r }); } catch { log({ kind: 'as_purge_error' }); } };
  purge();
  const purgeTimer = setInterval(purge, 600000); purgeTimer.unref();

  // ---- public HTTP surface --------------------------------------------------------------------------------------
  const hostOk = req => String(req.headers.host ?? '').toLowerCase() === publicUrl.host.toLowerCase();
  const WELL_KNOWN = { [`/.well-known/oauth-authorization-server${PREFIX}`]: '/.well-known/oauth-authorization-server', [`/.well-known/openid-configuration${PREFIX}`]: '/.well-known/openid-configuration' };
  const interactionPath = /^\/interaction\/([A-Za-z0-9_-]{10,64})$/;

  async function handle(req, res) {
    const pathname = req.url.split('?')[0];
    const alias = WELL_KNOWN[pathname];
    if (!alias && pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return false;
    const interaction = interactionPath.exec(pathname.slice(PREFIX.length));
    // One line per request with a fixed route name and the status, never a path, query or body: a connection that stalls after
    // approval can then be told apart (no token request vs a refused one) without the log holding a secret.
    const routeName = alias ? 'discovery' : ({ '/reg': 'registration', '/auth': 'authorize', '/token': 'token', '/token/revocation': 'revocation', '/jwks': 'jwks' }[pathname.slice(PREFIX.length).toLowerCase().replace(/\/+$/, '')]
      ?? (interaction ? 'interaction' : pathname.slice(PREFIX.length).startsWith('/auth/') ? 'authorize_resume' : 'other'));
    res.once('finish', () => log({ kind: 'as_request', route: routeName, http_method: req.method, status: res.statusCode, ua: uaToken(req) }));
    try {
      if (interaction) await interactionPage(req, res, interaction[1]);
      else await provide(req, res, alias);
    } catch (error) {
      log({ kind: 'as_handler_error' });
      if (!res.headersSent) page(res, 500, 'Error', '<p>The request failed.</p>'); else res.destroy();
    }
    return true;
  }
  // Every client here is public (PKCE, no secret). RFC 7591 §2 makes `client_secret_basic` the default when a registration omits
  // `token_endpoint_auth_method`, and the library then issues a secret that the token endpoint and the metadata (only `none`)
  // would never accept. RFC 7591 §3.2.1 lets the server replace requested values as long as the response shows what it registered,
  // so an omitted or unsupported method is registered as `none`: the response carries `token_endpoint_auth_method: "none"` and no
  // `client_secret`, in agreement with the metadata and the token endpoint. A strict client (claude.ai) stops on that mismatch.
  async function normalizeRegistration(req) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return true;
    const chunks = []; let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) { size += chunk.length; if (size > 8192) return false; chunks.push(chunk); }
    const text = Buffer.concat(chunks).toString('utf8');
    let body; try { body = JSON.parse(text); } catch { req.body = text; return true; } // the library reports a body that is not JSON, as before
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      if (body.token_endpoint_auth_method !== 'none') body.token_endpoint_auth_method = 'none';
      delete body.client_secret; delete body.client_secret_expires_at;
    }
    req.body = body;
    return true;
  }
  async function provide(req, res, alias) {
    if (alias && !['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return; }
    for (const name of Object.keys(req.headers)) if (name === 'forwarded' || name === 'x-real-ip' || name.startsWith('x-forwarded-')) delete req.headers[name];
    req.headers['x-forwarded-proto'] = publicUrl.protocol.slice(0, -1);
    req.headers['x-forwarded-host'] = publicUrl.host;
    req.originalUrl = req.url;
    req.baseUrl = PREFIX;
    req.url = alias ? alias : (req.url.slice(PREFIX.length) || '/');
    if (!req.url.startsWith('/')) req.url = `/${req.url}`;
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    await store.admission.run(store.window()?.generation, () => callback(req, res));
  }

  // ---- the browser's side of an interaction ---------------------------------------------------------------------
  const sameRequest = (pairing, params, client) => {
    const scopes = requestedScopes(params.scope);
    return params.client_id === pairing.client_id && params.redirect_uri === pairing.redirect_uri && scopes.join(' ') === pairing.scopes
      && params.resource === pairing.resource && (params.response_mode === undefined || params.response_mode === 'query') && registeredRedirectAllowed(client, pairing.redirect_uri) && callbackAllowed(pairing.redirect_uri);
  };
  // `openid` is the one scope the server lists itself. A client may ask for it; the grant then carries it. Any other scope is ignored.
  const requestedScopes = scope => [...new Set(String(scope ?? '').split(' ').filter(s => ACCEPTED_SCOPES.includes(s) || s === 'openid'))];
  async function interactionPage(req, res, uid) {
    if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return; }
    let details;
    try { details = await provider.interactionDetails(req, res); } catch { return page(res, 400, 'Connection attempt invalid or expired', `<p>This connection attempt is invalid or expired. Attempts last ${PAIRING_MINUTES} minutes. If yours ran out, ask the bridge owner to start a new one. Start a new connection from the app.</p>`); }
    // The cookie names the interaction. The path must name the same one.
    if (details.uid !== uid) return page(res, 400, 'Connection attempt invalid or expired', `<p>This connection attempt is invalid or expired. Attempts last ${PAIRING_MINUTES} minutes. If yours ran out, ask the bridge owner to start a new one. Start a new connection from the app.</p>`);
    const window = store.window();
    let pairing = store.pairingByUid(uid);
    const client = await provider.Client.find(details.params.client_id);
    if (!pairing) {
      if (!window) return page(res, 403, 'Not accepting connections', '<p>This bridge is not accepting new connections right now.</p>');
      const scopes = requestedScopes(details.params.scope);
      const redirect = details.params.redirect_uri;
      if (!scopes.some(s => ACCEPTED_SCOPES.includes(s))) return page(res, 400, 'No usable scope', '<p>The app asked for no scope that this bridge offers.</p>');
      if (!client || !registeredRedirectAllowed(client, redirect) || !callbackAllowed(redirect)) return page(res, 400, 'Callback not allowed', '<p>The app\'s callback address is not on this bridge\'s allowed list.</p>');
      if (details.params.resource !== resource) return page(res, 400, 'Wrong resource', '<p>The app did not ask for this bridge\'s resource.</p>');
      try {
        pairing = store.pairingFor(uid, { client_id: client.clientId, client_name: untrusted(client.clientName), redirect_uri: redirect, resource, scopes: scopes.join(' '), interaction_expires_at: details.exp * 1000 }, window);
      } catch (error) { return page(res, 503, 'Busy', `<p>${html(error.message)}.</p>`); }
    }
    if (pairing.state === 'approved') return complete(req, res, details, pairing, client);
    if (pairing.state !== 'pending' && pairing.state !== 'approving') return page(res, 410, 'Finished', '<p>This connection attempt is already finished. Start again from the app.</p>');
    if (pairing.expires_at <= now() || (!window && store.windowExpired())) return page(res, 403, 'Connection attempt expired', `<p>This connection attempt expired. Attempts last ${PAIRING_MINUTES} minutes. Ask the bridge owner to start a new one.</p>`);
    if (!window || window.worker !== pairing.worker) return page(res, 403, 'Not accepting connections', '<p>This bridge is not accepting new connections right now.</p>');
    const code = showCode(pairing.code);
    const native = isLoopbackCallback(new URL(pairing.redirect_uri));
    page(res, 200, 'Connect to Dalan', `<p>Pairing code</p><p class="code">${html(code)}</p><p>Run approval on the bridge computer:</p><pre>dalan connect approve ${html(code)} --worker ${html(pairing.worker)}</pre>${native ? '<p>Native client, identity not verified: host and name prove nothing. The owner must compare this code with the teammate\'s browser page over a trusted channel. The redirect confirmation is only a typo check, not proof of identity.</p>' : ''}<p>This page waits. It checks again every few seconds.</p>`, { refresh: 3 });
  }
  async function complete(req, res, details, pairing, client) {
    const connection = store.connectionByGrant(pairing.grant_id);
    if (!connection || connection.revoked_at !== null || connection.client_id !== pairing.client_id || connection.redirect_uri !== pairing.redirect_uri
      || connection.resource !== pairing.resource || connection.scopes !== pairing.scopes || !sameRequest(pairing, details.params, client)) {
      return page(res, 409, 'Approval no longer valid', '<p>The approved request changed or was revoked. Start again from the app.</p>');
    }
    // Order matters for crash recovery. The pairing stays `approved` until the provider has stored the interaction result, so a
    // crash between the two leaves a page the browser can load again. Marking it `done` first would strand an approved connection.
    // Repeating this step is safe: it stores the same result for the same grant, and the provider's resume step consumes the
    // interaction, so only one authorization code can ever be issued.
    await provider.interactionFinished(req, res, { login: { accountId: ACCOUNT, remember: false }, consent: { grantId: pairing.grant_id } }, { mergeWithLastSubmission: false });
    store.finishPairing(pairing.uid);
  }

  // ---- owner operations (called from the owner Unix socket only) -------------------------------------------------
  // Some web apps register multiple clients during one connection flow, so an older pending web code for the same worker
  // may no longer finish its token exchange. Those older codes stay visible, marked superseded by the newest web one.
  // Native (loopback) pairings are never superseded: each is approved by its own code only.
  const supersede = views => {
    const newest = views.filter(view => !view.native).at(-1);
    return views.map(view => view.native || view === newest ? view : { ...view, superseded: true, superseded_by: newest.code });
  };
  // The owner CLI never prints the bridge path secret (approve output checks this), so show the resource's origin and shape only.
  const shownResource = resource => `${new URL(resource).origin}/<secret>/mcp`;
  const pendingView = pairing => ({
    code: showCode(pairing.code), worker: pairing.worker, client_id: pairing.client_id, client_name: untrusted(pairing.client_name), client_name_untrusted: true,
    native: isLoopbackCallback(new URL(pairing.redirect_uri)),
    redirect_uri: pairing.redirect_uri, resource: shownResource(pairing.resource), scopes: pairing.scopes.split(' '), age_seconds: Math.max(0, Math.round((now() - pairing.created_at) / 1000)),
    expires_in_seconds: Math.max(0, Math.round((pairing.expires_at - now()) / 1000)),
  });
  const known = worker => typeof worker === 'string' && workerNames().includes(worker);
  const ops = {
    addClient({ redirectUri, name } = {}) {
      if (!callbackAllowed(redirectUri)) throw new Error('redirect_uri must match an allowed vendor callback');
      if (name !== undefined && (typeof name !== 'string' || name.length > 100 || !untrusted(name, 80))) throw new Error('name must be a non-empty string of at most 100 characters');
      const metadata = {
        client_id: randomUUID(), redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        token_endpoint_auth_method: 'none', application_type: isLoopbackCallback(new URL(redirectUri)) ? 'native' : 'web', ...(name !== undefined ? { client_name: untrusted(name, 80) } : {}),
      };
      const client = new provider.Client(metadata);
      const persisted = client.metadata();
      if (persisted.token_endpoint_auth_method !== 'none' || persisted.client_secret) throw new Error('static clients must use public client authentication');
      delete persisted.client_secret;
      delete persisted.client_secret_expires_at;
      const createdAt = store.addStaticClient(client.clientId, persisted);
      log({ kind: 'static_client_added', client_id: client.clientId });
      return { client_id: client.clientId, created_at: new Date(createdAt).toISOString() };
    },
    clients() {
      return { clients: store.clientRows().map(({ client_id, metadata, created_at, is_static }) => ({
        client_id, type: is_static ? 'static' : 'dcr', client_name: untrusted(metadata.client_name), client_name_untrusted: true,
        redirect_uris: Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris : [], created_at: new Date(created_at).toISOString(),
      })) };
    },
    removeClient({ clientId } = {}) {
      if (typeof clientId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(clientId)) throw new Error('invalid client ID');
      const removed = store.removeStaticClient(clientId);
      log({ kind: 'static_client_removed', client_id: clientId, revoked_grants: removed.revoked_grants });
      return removed;
    },
    start({ worker, minutes = 10 }) {
      if (!known(worker)) throw new Error(`unknown worker ${JSON.stringify(untrusted(worker, 64))}; configured workers: ${workerNames().join(', ')}`);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new Error('minutes must be an integer from 1 to 60');
      // An owner action: attempts left over from earlier windows are dropped. A window that is already open keeps its attempts.
      if (!store.window()) store.purgeUnapproved();
      const window = store.openWindow(worker, minutes);
      return { worker, window_open: true, expires_at: new Date(window.expires_at).toISOString(), minutes };
    },
    reset() { return store.reset(); },
    stop() { return { closed: store.closeWindow() }; },
    pending() {
      const window = store.window();
      return { window: window ? { worker: window.worker, expires_at: new Date(window.expires_at).toISOString() } : null, pending: window ? supersede(store.pendingPairings().filter(p => p.worker === window.worker).map(pendingView)) : [] };
    },
    async approve({ code, worker, replace = false, confirm_redirect: confirmRedirect }) {
      if (typeof code !== 'string' || normalizeCode(code).length !== 8) throw new Error('invalid pairing code');
      if (typeof replace !== 'boolean') throw new Error('replace must be true or false');
      const pairing = store.pairingByCode(code);
      if (!pairing) throw new Error('unknown pairing code');
      if (pairing.state !== 'pending') throw new Error(`pairing code is ${pairing.state === 'approving' ? 'being approved' : 'already used'}`);
      if (pairing.expires_at <= now()) throw new Error('pairing code expired');
      if (worker !== pairing.worker) throw new Error(`pairing code belongs to worker ${pairing.worker}, not ${JSON.stringify(untrusted(worker, 64))}`);
      if (!known(worker)) throw new Error('unknown worker');
      const native = isLoopbackCallback(new URL(pairing.redirect_uri));
      if (native && confirmRedirect !== pairing.redirect_uri) throw new Error('native callback approval requires exact redirect confirmation');
      if (!native && confirmRedirect !== undefined) throw new Error('redirect confirmation is only valid for a native callback');
      const window = store.window();
      if (!window || window.worker !== worker) throw new Error('no open pairing window for this worker; run dalan connect start');
      // The interaction and the registered client must still be exactly what the owner saw.
      const interaction = store.find('Interaction', pairing.uid);
      const client = await provider.Client.find(pairing.client_id);
      if (!interaction || !sameRequest(pairing, interaction.params ?? {}, client)) throw new Error('the pending request changed or expired; not approved');
      if (store.activeConnection(worker) && !replace) throw new Error(`worker ${worker} already has an active connection. Approving with --replace ends it and gives the new client every queued and future job for worker ${worker}, including briefs approved before the switch. Approve only a code you started yourself`);
      if (!store.reserve(pairing.code)) {
        if (store.pairingByCode(pairing.code)?.state === 'pending') throw new Error('pairing code was superseded by a newer attempt for this worker; approve the newest code (dalan connect pending)');
        throw new Error('pairing code is being approved or already used');
      }
      let grantId;
      try {
        const grant = new provider.Grant({ accountId: ACCOUNT, clientId: pairing.client_id });
        const wanted = pairing.scopes.split(' ');
        // The owner approved exactly these scopes. With the bridge scopes in `scopes` (so DCR accepts a `scope` field), the
        // provider also checks them as OIDC scopes at consent, so the grant carries them there too; tokens use the resource scope.
        grant.addOIDCScope(wanted.join(' '));
        grant.addResourceScope(pairing.resource, wanted.filter(scope => scope !== 'openid').join(' '));
        grantId = await grant.save();
        const { connection_id, replaced } = store.commitApproval({ code: pairing.code, worker, grantId, snapshot: pairing, replace });
        if (replaced) store.revokeGrant(replaced.grant_id, 'replaced');
        log({ kind: 'connection_approved', connection_id, worker, client_id: pairing.client_id, replaced: !!replaced });
        return { approved: true, connection_id, worker, grant_id: grantId, client_id: pairing.client_id, redirect_uri: pairing.redirect_uri, scopes: pairing.scopes.split(' '), replaced: replaced?.connection_id ?? null };
      } catch (error) {
        store.failPairing(pairing.code);
        if (grantId) { try { store.revokeGrant(grantId, 'approval_failed'); } catch { /* the grant has no connection row; deleting its rows is enough */ } }
        throw error;
      }
    },
    list() {
      const window = store.window();
      return { window: window ? { worker: window.worker, expires_at: new Date(window.expires_at).toISOString() } : null, callbacks: patterns.map(p => p.pattern),
        connections: store.connections().map(c => ({ connection_id: c.connection_id, worker: c.worker, client_id: c.client_id, redirect_uri: c.redirect_uri, scopes: c.scopes.split(' '), created_at: new Date(c.created_at).toISOString(), revoked_at: c.revoked_at === null ? null : new Date(c.revoked_at).toISOString(), revoked_reason: c.revoked_reason })) };
    },
    revoke({ worker }) {
      if (!known(worker)) throw new Error('unknown worker');
      const connection = store.activeConnection(worker);
      if (!connection) throw new Error(`worker ${worker} has no active connection`);
      store.revokeGrant(connection.grant_id, 'owner_revoked');
      log({ kind: 'connection_revoked', connection_id: connection.connection_id, worker });
      return { revoked: true, connection_id: connection.connection_id, worker };
    },
    allowCallback({ pattern }) {
      const parsed = parseCallbackPattern(pattern);
      if (!patterns.some(p => p.pattern === parsed.pattern)) {
        const next = [...patterns, parsed];
        const validated = parseAsConfig({ version: 1, public_url: publicUrl.origin, callbacks: next.map(p => p.pattern), limits: config.limits }, { allowHttp, loopback, stored: true });
        saveAsCallbacks(dir, validated.callbacks);
        patterns = validated.patterns;
      }
      return { callbacks: patterns.map(p => p.pattern) };
    },
  };

  // ---- the bridge's side: bearer token -> approved connection ------------------------------------------------------
  // Opaque token -> AccessToken -> grant_id -> connection row. Anything missing, expired, revoked or different is a refusal.
  async function verifyBearer(header, trace = {}) {
    const start = performance.now();
    Object.assign(trace, { auth_outcome: 'pending', auth_reason: null, auth_duration_ms: null, jwks_outcome: 'not_applicable', jwks_duration_ms: null, jwks_http_status: null });
    let reason = 'missing_bearer';
    try {
      if (typeof header !== 'string' || !header.startsWith('Bearer ')) throw new Error('missing bearer token');
      const value = header.slice(7);
      reason = 'invalid_token';
      if (!/^[A-Za-z0-9_-]{20,128}$/.test(value)) throw new Error('invalid bearer token');
      const token = await provider.AccessToken.find(value);
      if (!token || token.kind !== 'AccessToken' || token.accountId !== ACCOUNT || token.aud !== resource || !token.grantId || token.isExpired) throw new Error('invalid bearer token');
      reason = 'connection_inactive';
      const connection = store.connectionByGrant(token.grantId);
      if (!connection || connection.revoked_at !== null || connection.client_id !== token.clientId || connection.resource !== resource) throw new Error('connection inactive');
      const grant = await provider.Grant.find(token.grantId);
      if (!grant || grant.accountId !== ACCOUNT || grant.clientId !== token.clientId) throw new Error('grant inactive');
      reason = 'invalid_scope';
      const granted = canonicalScopes(connection.scopes.split(' '));
      const scopes = canonicalScopes(String(token.scope ?? '').split(' '));
      if (!scopes.size || [...scopes].some(s => !granted.has(s))) throw new Error('invalid bearer scope');
      trace.auth_outcome = 'success'; trace.auth_reason = 'verified';
      return { subject: ACCOUNT, scopes, issuer, client_id: token.clientId, connection_id: connection.connection_id, builtin: true, connection: { worker: connection.worker } };
    } catch (error) {
      trace.auth_outcome = 'failure'; trace.auth_reason = reason;
      throw error;
    } finally { trace.auth_duration_ms = Math.max(0, Math.round(performance.now() - start)); }
  }

  return { provider, store, issuer, resource, publicUrl, config: { ...config, issuer }, hostOk, handle, ops, verifyBearer, close() { clearInterval(purgeTimer); store.close(); owner.release(); } };
}
