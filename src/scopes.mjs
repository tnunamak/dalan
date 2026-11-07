// OAuth scope names. The neutral names are advertised and issued by default. The older `dot-bridge.*`
// names stay accepted as aliases for tokens, connections and clients that already use them; each alias
// maps to exactly the permission of its neutral name, so no alias grants more than before.
export const LEGACY_SCOPE_ALIASES = Object.freeze({ 'dot-bridge.read': 'dalan.read', 'dot-bridge.work': 'dalan.work' });
export const ADVERTISED_SCOPES = Object.freeze(['dalan.read', 'dalan.work', 't3.read', 't3.write']);
export const ACCEPTED_SCOPES = Object.freeze([...ADVERTISED_SCOPES, ...Object.keys(LEGACY_SCOPE_ALIASES)]);
export const canonicalScope = scope => LEGACY_SCOPE_ALIASES[scope] ?? scope;
export const canonicalScopes = scopes => new Set([...scopes].filter(Boolean).map(canonicalScope));
// Names clients see in challenges and protected-resource metadata. Built-in mode and the stable catalog use the neutral
// names. An external issuer keeps the legacy names unless the operator sets OAUTH_SCOPE_NAMES=neutral in oauth.env, so an
// issuer that only defines `dot-bridge.*` keeps working with no edit. The frozen legacy-v46 catalog always uses legacy names.
export const LEGACY_SCOPE_NAMES = Object.freeze(Object.fromEntries(Object.entries(LEGACY_SCOPE_ALIASES).map(([legacy, neutral]) => [neutral, legacy])));
export const legacyScopeNames = config => config?.legacyScopeNames === true || (config?.builtin !== true && config?.OAUTH_SCOPE_NAMES !== 'neutral');
export const wireScope = (scope, legacy) => legacy ? String(scope).split(' ').map(name => LEGACY_SCOPE_NAMES[name] ?? name).join(' ') : scope;
export const advertisedScopeNames = config => ADVERTISED_SCOPES.map(name => wireScope(name, legacyScopeNames(config)));
