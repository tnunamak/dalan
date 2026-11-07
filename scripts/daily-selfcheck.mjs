#!/usr/bin/env node
import { endpoint, hostname, appendPath, protectedResourceMetadataUrl, fetchProbe, listsIssuer } from './monitor-targets.mjs';
import { defaultPath } from '../src/paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { publishAlert } from '../src/alerts.mjs';
import { authConfig } from '../src/auth.mjs';

// The bridge's own OAuth file already names the public resource and issuer, so a unit that sets only
// WorkingDirectory still works. An explicit setting wins; an unreadable file leaves the setting unset
// and main() reports it by name.
function bridgeSettings() {
  try { const config = authConfig(undefined, false); return config ? { resource: config.OAUTH_AUDIENCE, issuer: config.OAUTH_ISSUER } : {}; }
  catch { return {}; }
}
const own = bridgeSettings();
const resource = process.env.DALAN_SELFCHECK_RESOURCE || process.env.DALAN_RESOURCE_URL || own.resource;
const issuer = process.env.DALAN_SELFCHECK_ISSUER || process.env.DALAN_ISSUER_URL || own.issuer;
const tlsHost = process.env.DALAN_SELFCHECK_TLS_HOST || process.env.DALAN_TLS_HOST || (resource && URL.canParse(resource) ? new URL(resource).hostname : undefined);
const githubRepository = process.env.DALAN_GITHUB_REPOSITORY;
const repositoryId = process.env.DALAN_SELFCHECK_REPOSITORY_ID;
const stateFile = defaultPath(os.homedir(),'.local/state/dot-bridge/daily-selfcheck.json');

export function assessStatus(status, now = Date.now()) {
  const issues = [];
  if (!status || !Number.isInteger(status.subscriptions_active)) return ['status_invalid'];
  if (status.subscriptions_active < 1) issues.push('subscription_inactive');
  else {
    const expires = Date.parse(status.subscription?.expires_at || '');
    if (!Number.isFinite(expires) || expires - now <= 6 * 60 * 60 * 1000) issues.push('subscription_expiring');
  }
  return issues;
}

// RFC 9728 section 3.3: the metadata's resource must be identical to the resource identifier whose
// path was inserted into the well-known URL. Compare the whole configured value, not its origin.
export function metadataMatches(metadata, resource, issuer) {
  return metadata?.resource === resource && Boolean(issuer) && listsIssuer(metadata, issuer);
}

export function repositoryIdMatches(output, expected) {
  try { const repo=JSON.parse(output); return Number.isSafeInteger(repo.id) && String(repo.id)===expected; }
  catch { return false; }
}

async function certificateExpiry() {
  if (!resource) throw new Error('DALAN_RESOURCE_URL is required');
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: tlsHost, port: 443, servername: tlsHost, timeout: 10000 }, () => {
      const expires = Date.parse(socket.getPeerCertificate().valid_to);
      socket.end();
      Number.isFinite(expires) ? resolve(expires) : reject(new Error('invalid certificate expiry'));
    });
    socket.on('timeout', () => socket.destroy(new Error('TLS timeout')));
    socket.on('error', reject);
  });
}

async function probe() {
  const issues = [];
  try {
    const cli = fileURLToPath(new URL('../bin/dalan.mjs', import.meta.url));
    const output = execFileSync(process.execPath, [cli, 'status', '--json'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
    issues.push(...assessStatus(JSON.parse(output)));
  } catch { issues.push('status_unreachable'); }

  try {
    const response = await fetchProbe('DALAN_SELFCHECK_RESOURCE', protectedResourceMetadataUrl(resource), { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('metadata HTTP failure');
    const metadata = await response.json();
    if (!metadataMatches(metadata, resource, issuer)) throw new Error('metadata mismatch');
  } catch (error) { issues.push(error.targetValidation ? error.message : 'oauth_metadata_unreachable'); }

  try {
    const expires = await certificateExpiry();
    if (expires - Date.now() <= 14 * 24 * 60 * 60 * 1000) issues.push('tls_certificate_expiring');
  } catch { issues.push('tls_certificate_invalid'); }

  try {
    const response = await fetchProbe('DALAN_SELFCHECK_ISSUER', appendPath(issuer, '/protocol/openid-connect/certs'), { signal: AbortSignal.timeout(10000) });
    if (!response.ok || !(await response.json()).keys?.some(key => key.kty === 'RSA' && key.use !== 'enc')) throw new Error('JWKS unavailable');
  } catch (error) { issues.push(error.targetValidation ? error.message : 'keycloak_jwks_unreachable'); }

  try {
    const repo = execFileSync('gh', ['api', `repos/${githubRepository}`], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!repositoryIdMatches(repo, repositoryId)) throw new Error('GitHub identity mismatch');
  } catch { issues.push('github_auth_unusable'); }
  return issues;
}

async function main() {
  const missing = [
    ['DALAN_RESOURCE_URL or DALAN_SELFCHECK_RESOURCE', resource],
    ['DALAN_ISSUER_URL or DALAN_SELFCHECK_ISSUER', issuer],
    ['DALAN_SELFCHECK_TLS_HOST or DALAN_TLS_HOST', tlsHost],
    ['DALAN_GITHUB_REPOSITORY', githubRepository],
    ['DALAN_SELFCHECK_REPOSITORY_ID', repositoryId],
  ].filter(([, value]) => !value?.trim()).map(([name]) => name);
  if (missing.length) throw new Error(`set ${missing.join(', ')}`);
  endpoint('DALAN_SELFCHECK_RESOURCE', resource, {base:true});
  endpoint('DALAN_SELFCHECK_ISSUER', issuer, {base:true});
  hostname('DALAN_SELFCHECK_TLS_HOST', tlsHost);
  // The TLS probe must examine the host that serves the resource; a different host would pass for the wrong certificate.
  if (tlsHost.toLowerCase() !== new URL(resource).hostname.toLowerCase()) throw new Error('DALAN_SELFCHECK_TLS_HOST differs from the resource hostname; unset it to use the resource hostname');
  if (!/^[1-9][0-9]*$/.test(repositoryId) || !Number.isSafeInteger(Number(repositoryId))) throw new Error('DALAN_SELFCHECK_REPOSITORY_ID must be a positive numeric repository ID');
  process.umask(0o077);
  const issues = await probe();
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  let previous = [];
  try { previous = JSON.parse(fs.readFileSync(stateFile, 'utf8')).issues; } catch {}
  if (!Array.isArray(previous)) previous = [];
  const changed = issues.some(issue => !previous.includes(issue));
  if (issues.length && changed) {
    await publishAlert('dot-bridge daily check failed', issues.join(', '), () => {}, { requirePublisher: true });
  }
  fs.writeFileSync(stateFile, JSON.stringify({ checked_at: new Date().toISOString(), issues }) + '\n', { mode: 0o600 });
  if (issues.length) {
    console.error('dot-bridge daily check:', issues.join(', '));
    process.exitCode = 1;
  } else console.log('dot-bridge daily check: healthy');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(async error => {
    // A check that cannot run must not pass in silence: say so through the alert path (setting names only, never values).
    console.error('dot-bridge daily check could not run:', error.message);
    process.exitCode = 1;
    try { await publishAlert('dot-bridge daily check could not run', error.message, () => {}, { requirePublisher: true }); }
    catch (alertError) { console.error('dot-bridge daily check could not alert:', alertError.message); }
  });
}
