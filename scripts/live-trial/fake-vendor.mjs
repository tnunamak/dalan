// Shared fake MCP vendor client used by builtin-as-e2e.mjs and the portable live-trial dry run.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { fetchFresh as fetch } from '../../src/test-support/fetch.mjs';

export const CALLBACK = 'https://vendor.example/oauth/callback';

export class Jar {
  constructor() { this.map = new Map(); }
  take(res) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      const [key, value] = [pair.slice(0, i), pair.slice(i + 1)];
      if (value === '') this.map.delete(key);
      else this.map.set(key, value);
    }
  }
  get header() { return [...this.map].map(([key, value]) => `${key}=${value}`).join('; '); }
}

export async function hit(url, { jar, method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    redirect: 'manual',
    headers: { ...headers, ...(jar?.header ? { cookie: jar.header } : {}) },
    body,
  });
  jar?.take(res);
  return res;
}

export const form = fields => new URLSearchParams(fields);

async function jsonMetadata(url, label) {
  const response = await fetch(url);
  assert.equal(response.status, 200, `${label} returned ${response.status}`);
  return response.json();
}

export const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

export class Vendor {
  constructor(srv, redirect = CALLBACK) {
    this.srv = srv;
    this.redirect = redirect;
    this.resourceMetadata = null;
    this.metadata = null;
  }
  async discover() {
    if (this.metadata) return this.metadata;

    const resource = new URL(this.srv.resource);
    const resourceMetadataUrl = new URL(`/.well-known/oauth-protected-resource${resource.pathname}`, resource.origin);
    this.resourceMetadata = await jsonMetadata(resourceMetadataUrl, 'protected-resource metadata');
    assert.equal(this.resourceMetadata.resource, resource.href);
    const issuer = new URL(this.resourceMetadata.authorization_servers?.[0]);
    assert.equal(issuer.origin, resource.origin, 'authorization server is outside the resource origin');

    const authorizationServerMetadataUrl = new URL(`/.well-known/oauth-authorization-server${issuer.pathname}`, issuer.origin);
    this.metadata = await jsonMetadata(authorizationServerMetadataUrl, 'authorization-server metadata');
    assert.equal(this.metadata.issuer, issuer.href);
    for (const name of ['registration_endpoint', 'authorization_endpoint', 'token_endpoint']) {
      const endpoint = new URL(this.metadata[name]);
      assert.equal(endpoint.origin, issuer.origin, `${name} is outside the issuer origin`);
      assert.ok(endpoint.pathname.startsWith(`${issuer.pathname}/`), `${name} is outside the issuer path`);
    }
    return this.metadata;
  }
  endpoint(name) {
    const endpoint = this.metadata?.[name];
    assert.equal(typeof endpoint, 'string', 'vendor must discover metadata before using an endpoint');
    return endpoint;
  }
  resolveLocation(location) {
    return new URL(location, new URL(this.metadata.issuer).origin).href;
  }
  async register(meta = {}) {
    await this.discover();
    const res = await fetch(this.endpoint('registration_endpoint'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [this.redirect],
        client_name: 'Fake Vendor',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        ...meta,
      }),
    });
    const body = await res.json();
    if (res.status === 201) this.client_id = body.client_id;
    return { status: res.status, body };
  }
  authUrl({ challenge, method = 'S256', redirect = this.redirect, scope = 'dalan.read dalan.work', resource = this.srv.resource, state = randomBytes(6).toString('hex'), omit = [], extra = {}, client_id = this.client_id } = {}) {
    const params = {
      client_id,
      response_type: 'code',
      redirect_uri: redirect,
      scope,
      state,
      ...(challenge ? { code_challenge: challenge, code_challenge_method: method } : {}),
      ...(resource ? { resource } : {}),
      ...extra,
    };
    for (const key of omit) delete params[key];
    return `${this.endpoint('authorization_endpoint')}?${form(params)}`;
  }
  // Open a fresh browser leg and read the pairing code from the interaction page.
  async begin(opts = {}) {
    await this.discover();
    const proof = opts.pkce ?? pkce();
    const jar = opts.jar ?? new Jar();
    const state = opts.state ?? randomBytes(6).toString('hex');
    const res = await hit(this.authUrl({ challenge: proof.challenge, ...opts, state }), { jar });
    const flow = { jar, pkce: proof, res, state, loc: res.headers.get('location'), redirect: opts.redirect ?? this.redirect };
    const interactionPrefix = `${new URL(this.metadata.issuer).pathname}/interaction/`;
    if (res.status === 303 && flow.loc?.startsWith(interactionPrefix)) {
      const page = await hit(this.resolveLocation(flow.loc), { jar });
      flow.page = await page.text();
      flow.pageStatus = page.status;
      flow.code = flow.page.match(/class="code">([A-Z0-9-]+)</)?.[1] ?? null;
      flow.uid = flow.loc.split('/').pop();
    }
    return flow;
  }
  // After approval, the browser resumes the interaction and follows its vendor callback.
  async finish(flow) {
    await this.discover();
    const done = await hit(this.resolveLocation(flow.loc), { jar: flow.jar });
    if (done.status !== 303) return { stage: 'interaction', status: done.status, text: await done.text() };
    const resume = await hit(this.resolveLocation(done.headers.get('location')), { jar: flow.jar });
    const location = resume.headers.get('location');
    if (resume.status !== 303 || !location) {
      return { stage: 'resume', status: resume.status, text: await resume.text(), location };
    }
    const params = new URL(location, this.metadata.issuer).searchParams;
    const callback = new URL(location, this.metadata.issuer);
    const callbackPath = `${callback.origin}${callback.pathname}`;
    if (callbackPath !== flow.redirect) return { stage: 'resume', status: resume.status, text: 'callback URI changed', location };
    if (params.get('state') !== flow.state) return { stage: 'callback', status: resume.status, error: 'state mismatch', params, location };
    if (params.get('iss') !== this.metadata.issuer) return { stage: 'callback', status: resume.status, error: 'issuer mismatch', params, location };
    return { stage: 'callback', code: params.get('code'), error: params.get('error'), iss: params.get('iss'), state: params.get('state'), params, location };
  }
  async token(fields) {
    await this.discover();
    const res = await fetch(this.endpoint('token_endpoint'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ client_id: this.client_id, ...fields }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  exchange(code, verifier, extra = {}) {
    return this.token({ grant_type: 'authorization_code', code, redirect_uri: this.redirect, code_verifier: verifier, resource: this.srv.resource, ...extra });
  }
  refresh(refresh_token, extra = {}) { return this.token({ grant_type: 'refresh_token', refresh_token, ...extra }); }
  // Complete DCR, pairing-window approval, browser callback and PKCE token exchange.
  async connect(worker, opts = {}) {
    if (!opts.windowOpen) this.srv.start_window(worker);
    const flow = await this.begin(opts);
    assert.ok(flow.code, `no pairing code: ${flow.res.status} ${flow.page?.slice(0, 200) ?? ''}`);
    const approved = this.srv.approve(flow.code, worker, opts.replace ?? true);
    assert.equal(approved.code, 0, approved.stderr + approved.stdout);
    const callback = await this.finish(flow);
    assert.equal(callback.stage, 'callback', JSON.stringify(callback).slice(0, 300));
    assert.ok(callback.code, 'no code in callback');
    const tokens = await this.exchange(callback.code, flow.pkce.verifier);
    assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
    return {
      flow,
      approval: approved.json(),
      callback,
      tokens: tokens.body,
      access: tokens.body.access_token,
      refresh: tokens.body.refresh_token,
    };
  }
}
