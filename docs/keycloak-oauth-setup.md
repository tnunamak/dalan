# External OAuth issuer setup

For new installations, use the built-in OAuth flow in the [README](../README.md). Use this guide when you already operate an external issuer such as Keycloak. Configure it for your worker client; no particular account, domain or identity provider deployment is required.

## Configure the issuer

Create a public OpenID Connect client with the authorization-code flow, PKCE S256, and the worker client’s exact redirect URI. Disable implicit and service-account grants. Configure an audience mapper so access tokens contain the bridge’s exact resource URI, the full public MCP URL used as `OAUTH_AUDIENCE` below. Access tokens must be JWTs signed with RS256 whose header has a string `kid` matching an RSA key in the JWKS; opaque tokens and other algorithms are rejected. `OAUTH_ISSUER` and `OAUTH_JWKS_URI` must be HTTPS URLs on the same origin. Allow the `dot-bridge.read` and `dot-bridge.work` scopes. By default the bridge advertises and challenges with these names, so an existing issuer needs no change. To use the neutral names instead, define `dalan.read` and `dalan.work` in the issuer and add `OAUTH_SCOPE_NAMES=neutral` to `oauth.env`; the bridge accepts both spellings either way. These are identifiers for Dalan’s read and work permissions, not restrictions to a particular worker.

Store the issuer settings in the bridge home’s `~/.config/dalan/oauth.env`, mode 0600. For an existing installation use `dalan paths --json` to find the active configuration root; legacy roots remain supported. Replace all example values with your own deployment settings:

```env
OAUTH_ISSUER=https://identity.example.com/realms/agents
OAUTH_AUDIENCE=https://dalan.example.com/<bridge-path-secret>/mcp
OAUTH_JWKS_URI=https://identity.example.com/realms/agents/protocol/openid-connect/certs
OAUTH_ALLOWED_SUBJECTS=<approved-subject-id>
```

`<bridge-path-secret>` is the bridge's `BRIDGE_PATH_SECRET`. The audience contains it, so it also appears in the identity provider's mapper settings and in every token's `aud` claim. Treat the Keycloak client configuration as secret for the same reason.

The bridge validates issuer, audience, expiry, signature, approved subject and scopes. Keep tokens and identity subject values out of repository files and logs. In external-issuer mode, configure worker connection identities in the local worker profile as described in [the authentication profile](portable-auth-profile.md).

## Configure and verify the bridge

Set `DALAN_AUTH_MODE=oauth` in the service environment. For a non-loopback listener, configure an HTTPS reverse proxy and `DALAN_TRUST_PROXY=1`; preserve the public Host header. The bridge serves protected-resource metadata at `/.well-known/oauth-protected-resource` and at `/.well-known/oauth-protected-resource/<bridge-path-secret>/mcp`; forward both on the same public origin as the MCP endpoint. Discovery must identify the same issuer and resource used in token validation.

Back up private configuration and state before restarting an existing bridge. Verify the issuer discovery document and JWKS, complete the worker client’s authorization flow, and submit a repository-free text job through claim and finish. Verify refresh behavior with that client before relying on unattended work.

Keep workspace tools and host checks disabled until the basic worker journey succeeds. See [operations](operations.md) for repository grants, execution authority, backups and rollback. T3 access is a separate opt-in; the worker does not need it for ordinary jobs.

The [example Keycloak client export](keycloak-client-chatgpt-dot-bridge.json) retains its legacy filename. Review its redirect URIs, client ID, audience and scopes before importing it; it is not a deployable configuration for your host.
