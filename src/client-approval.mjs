// What the owner sees, and what is recorded, when a client asks to connect. Everything the client supplied (name, client ID,
// redirect) is shown as untrusted text: no control, format or separator characters, bounded length, and always labelled.
// Nothing here makes a trust decision. The name never selects a grant; only the owner's approval of one code does.
import { untrusted } from './as-files.mjs';
import { validateRedirectUri } from './redirect-policy.mjs';
import { displayFor } from './client-convenience.mjs';

const OWNER_ID = 'owner';

// A display model from one pairing. `resource` must already be the shortened form that hides the secret path.
export function describeClient({ name, clientId, redirectUri, worker, issuer, resource, scopes, code }) {
  const policy = validateRedirectUri(redirectUri);
  // Display only: a curated label for an exact, already validated HTTPS origin. It never feeds an approval decision.
  const known = policy.ok ? displayFor(policy.uri) : null;
  return {
    code,
    worker: untrusted(worker, 64),
    client_name: untrusted(name, 80),
    client_name_untrusted: true,
    client_id: untrusted(clientId, 128),
    redirect_uri: policy.ok ? policy.uri : untrusted(redirectUri, 512),
    redirect_host: policy.ok ? policy.host : null,
    redirect_origin: policy.ok ? policy.origin : null,
    redirect_kind: policy.ok ? policy.kind : null,
    redirect_punycode: policy.ok ? policy.punycode : false,
    known_client: known ? untrusted(known.name, 80) : null,
    issuer: untrusted(issuer, 256),
    resource: untrusted(resource, 256),
    scopes: [...scopes].map(scope => untrusted(scope, 64)),
  };
}

// Plain-text lines for the browser page (the caller escapes them for HTML).
export function approvalFacts(view) {
  return [
    ['Client name (set by the app, not verified)', view.client_name || '(none)'],
    ...(view.known_client ? [['Known client (matched by redirect origin; a label only, not proof)', view.known_client]] : []),
    ['Redirect host', view.redirect_host ?? '(invalid)'],
    ['Full redirect', view.redirect_uri],
    ['Client ID', view.client_id],
    ['Worker', view.worker],
    ['Issuer', view.issuer],
    ['Resource', view.resource],
    ['Scopes', view.scopes.join(' ')],
    ...(view.redirect_punycode ? [['Note', 'The host contains punycode (xn--). It may look like another name when decoded.']] : []),
  ];
}

// The record of one approval. The origin groups review and revocation only; it grants nothing to another client, path or port.
export function approvalRecord({ worker, issuer, resource, clientId, redirectUri, scopes, approvedAt, connectionId }) {
  const policy = validateRedirectUri(redirectUri);
  return {
    ownerId: OWNER_ID, worker, issuer, resource, clientId,
    redirectOrigin: policy.ok ? policy.origin : null, redirectUri, scopes: [...scopes],
    approvedAt: new Date(approvedAt).toISOString(), connectionId,
  };
}
