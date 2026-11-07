import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

for (const [script, names] of [
  ['daily-selfcheck.mjs', ['DALAN_SELFCHECK_RESOURCE', 'DALAN_SELFCHECK_ISSUER', 'DALAN_SELFCHECK_TLS_HOST', 'DALAN_GITHUB_REPOSITORY', 'DALAN_SELFCHECK_REPOSITORY_ID']],
]) {
  test(`${script} rejects missing configuration before network access`, () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], {
      env: { HOME: '/nonexistent', PATH: process.env.PATH }, encoding: 'utf8', timeout: 3000,
    });
    assert.equal(result.status, 1);
    for (const name of names) assert.match(result.stderr, new RegExp(name));
  });
}

test('selfcheck rejects malformed endpoint settings before probing', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-selfcheck-validation-'));
  const preload=path.join(dir,'sentinel.cjs'), calls=path.join(dir,'calls');
  fs.writeFileSync(preload, `const fs=require('node:fs'), cp=require('node:child_process'), tls=require('node:tls');
const called=()=>{fs.appendFileSync(process.env.PROBE_CALLS,'called\\n');throw new Error('unexpected probe');};
globalThis.fetch=called;cp.execFileSync=called;tls.connect=called;require('node:module').syncBuiltinESMExports();`);
  const base = { DALAN_SELFCHECK_RESOURCE:'https://resource.example/path', DALAN_SELFCHECK_ISSUER:'https://id.example/realms/test', DALAN_SELFCHECK_TLS_HOST:'resource.example', DALAN_GITHUB_REPOSITORY:'example-org/example-repo', DALAN_SELFCHECK_REPOSITORY_ID:'12345' };
  try {
    for (const [name,value] of [['DALAN_SELFCHECK_RESOURCE','https://a.example/?x=1'],['DALAN_SELFCHECK_ISSUER','https://a.example/#bad'],['DALAN_SELFCHECK_ISSUER','http://a.example'],['DALAN_SELFCHECK_RESOURCE','https://u:p@a.example'],['DALAN_SELFCHECK_TLS_HOST','https://a.example'],['DALAN_SELFCHECK_REPOSITORY_ID','not-a-number']]) {
      const result=spawnSync(process.execPath,['--require',preload,fileURLToPath(new URL('daily-selfcheck.mjs',import.meta.url))],{env:{HOME:dir,PATH:process.env.PATH,PROBE_CALLS:calls,...base,[name]:value},encoding:'utf8',timeout:3000});
      assert.equal(result.status,1); assert.match(result.stderr,new RegExp(name)); assert.ok(!result.stderr.includes(value),'rejected value leaked to stderr');
      assert.deepEqual(fs.readdirSync(dir),['sentinel.cjs'],'invalid configuration must not probe or write state');
    }
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('endpoint path construction preserves issuer realm paths', async () => {
  const { endpoint, appendPath } = await import('./monitor-targets.mjs');
  const issuer=endpoint('issuer','https://id.example/realms/test/',{base:true});
  assert.equal(appendPath(issuer,'/protocol/openid-connect/certs'),'https://id.example/realms/test/protocol/openid-connect/certs');
});


test('selfcheck validates the configured repository identity', async () => {
  const { repositoryIdMatches }=await import('./daily-selfcheck.mjs');
  assert.equal(repositoryIdMatches('{"id":12345,"full_name":"renamed/repo"}','12345'),true);
  assert.equal(repositoryIdMatches('{"id":54321,"full_name":"example-org/example-repo"}','12345'),false);
  assert.equal(repositoryIdMatches('{}','12345'),false);
  assert.equal(repositoryIdMatches('invalid','12345'),false);
});

test('metadata discovery inserts well-known before resource path', async () => {
  const { protectedResourceMetadataUrl } = await import('./monitor-targets.mjs');
  assert.equal(protectedResourceMetadataUrl('https://h/api'), 'https://h/.well-known/oauth-protected-resource/api');
  assert.equal(protectedResourceMetadataUrl('https://h'), 'https://h/.well-known/oauth-protected-resource');
  assert.equal(protectedResourceMetadataUrl('https://h/'), 'https://h/.well-known/oauth-protected-resource');
  assert.equal(protectedResourceMetadataUrl('https://h/api/'), 'https://h/.well-known/oauth-protected-resource/api/');
  assert.equal(protectedResourceMetadataUrl('https://h/a/b'), 'https://h/.well-known/oauth-protected-resource/a/b');
});

test('selfcheck probes reject redirects without contacting another port', async () => {
  const http = await import('node:http');
  const { fetchProbe } = await import('./monitor-targets.mjs');
  let followed = 0;
  const destination = http.createServer((req, res) => { followed++; res.end('{}'); });
  const redirect = http.createServer((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${destination.address().port}/private-location` }); res.end();
  });
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const close = server => new Promise(resolve => server.close(resolve));
  await listen(destination); await listen(redirect);
  try {
    for (const name of ['DALAN_SELFCHECK_RESOURCE', 'DALAN_SELFCHECK_ISSUER']) {
      await assert.rejects(fetchProbe(name, `http://127.0.0.1:${redirect.address().port}`), error => {
        assert.equal(error.message, `${name} probe must not redirect`);
        return true;
      });
    }
    assert.equal(followed, 0);
    // The daily self-check's own behavior is covered by the end-to-end tests below.
  } finally { await close(redirect); await close(destination); }
});

// Run the real daily-selfcheck.mjs end to end. A preload replaces only the outside world: fetch, the status and gh
// subprocesses, and the TLS socket. The fetch stub honors `redirect`, so a probe that follows redirects reaches the
// destination and is recorded there.
function runSelfcheck(t, { resource, issuer = 'https://id.example.test/realms/example', metadata, jwks, repositoryId = '4242', fromBridgeFile = false, env: extraEnv = {}, fileMode = 0o600 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-behavior-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'contacts.jsonl');
  const alertsFile = path.join(dir, 'alerts.env');
  fs.writeFileSync(alertsFile, 'NTFY_URL=https://ntfy.example.test/topic\n', { mode: 0o600 });
  if (fromBridgeFile) {
    // The deployed unit sets only WorkingDirectory; the bridge's own OAuth file is the source.
    fs.mkdirSync(path.join(dir, '.config/dot-bridge'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.config/dot-bridge/oauth.env'), `OAUTH_ISSUER=${issuer}\nOAUTH_AUDIENCE=${resource}\nOAUTH_JWKS_URI=${issuer}/protocol/openid-connect/certs\nOAUTH_ALLOWED_SUBJECTS=subject-1\n`, { mode: fileMode });
    fs.chmodSync(path.join(dir, '.config/dot-bridge/oauth.env'), fileMode);
  }
  const preload = path.join(dir, 'preload.mjs');
  fs.writeFileSync(preload, `
    import fs from 'node:fs';
    import cp from 'node:child_process';
    import tls from 'node:tls';
    import { EventEmitter } from 'node:events';
    import { syncBuiltinESMExports } from 'node:module';
    const scenario = JSON.parse(process.env.SELFCHECK_SCENARIO);
    const note = entry => fs.appendFileSync(process.env.SELFCHECK_LOG, JSON.stringify(entry) + '\\n');
    const healthy = { resource: scenario.metadata.resource, authorization_servers: [scenario.issuer] };
    const answer = (url, spec, body, options) => {
      if (spec.redirect === undefined) return Response.json(body);
      if (options?.redirect === 'manual') return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.test/destination' } });
      note({ followed: url });
      return Response.json(body);
    };
    globalThis.fetch = async (input, options = {}) => {
      const url = String(input);
      if (url === scenario.metadataUrl) { note({ probe: 'metadata' }); return answer(url, scenario.metadata, healthy, options); }
      if (url === scenario.jwksUrl) { note({ probe: 'jwks' }); return answer(url, scenario.jwks, { keys: [{ kty: 'RSA', use: 'sig' }] }, options); }
      if (url === 'https://ntfy.example.test/topic') { note({ alert: String(options.body) }); return new Response(null, { status: 204 }); }
      note({ unexpected: url });
      return new Response(null, { status: 599 });
    };
    cp.execFileSync = (file, args) => file === 'gh'
      ? JSON.stringify({ id: Number(scenario.repositoryId) })
      : JSON.stringify({ subscriptions_active: 1, subscription: { expires_at: new Date(Date.now() + 864e5 * 30).toISOString() } });
    tls.connect = (options, callback) => {
      note({ tls: { host: options.host, servername: options.servername } });
      const socket = new EventEmitter();
      socket.getPeerCertificate = () => ({ valid_to: new Date(Date.now() + 864e5 * 90).toUTCString() });
      socket.end = () => {}; socket.destroy = () => {};
      queueMicrotask(callback);
      return socket;
    };
    syncBuiltinESMExports();
  `);
  const result = spawnSync(process.execPath, ['--import', preload, fileURLToPath(new URL('daily-selfcheck.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 20000,
    env: {
      HOME: dir, PATH: process.env.PATH, DALAN_ALERTS_FILE: alertsFile, SELFCHECK_LOG: log,
      ...(fromBridgeFile ? {} : { DALAN_SELFCHECK_RESOURCE: resource, DALAN_SELFCHECK_ISSUER: issuer, DALAN_SELFCHECK_TLS_HOST: 'h.example.test' }),
      DALAN_GITHUB_REPOSITORY: 'owner/repo', DALAN_SELFCHECK_REPOSITORY_ID: repositoryId, ...extraEnv,
      SELFCHECK_SCENARIO: JSON.stringify({
        issuer, repositoryId, metadata: metadata ?? {}, jwks: jwks ?? {},
        metadataUrl: new URL('/.well-known/oauth-protected-resource' + (new URL(resource).pathname === '/' ? '' : new URL(resource).pathname), resource).href,
        jwksUrl: issuer + '/protocol/openid-connect/certs',
      }),
    },
  });
  const entries = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { ...result, entries, contacted: name => entries.some(entry => entry.probe === name), followed: entries.filter(entry => entry.followed) };
}

test('daily self-check takes resource, issuer and TLS host from the bridge OAuth file when the unit sets none', t => {
  const result = runSelfcheck(t, { resource: 'https://h.example.test/api', metadata: { resource: 'https://h.example.test/api' }, fromBridgeFile: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /healthy/);
  assert.ok(result.contacted('metadata') && result.contacted('jwks'));
  assert.deepEqual(result.entries.find(entry => entry.tls).tls, { host: 'h.example.test', servername: 'h.example.test' }, 'TLS host and SNI come from the resource');
});

test('daily self-check names the missing settings and alerts when neither the unit nor the OAuth file has them', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-bare-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const alertsFile = path.join(home, 'alerts.env'), sent = path.join(home, 'sent');
  fs.writeFileSync(alertsFile, 'NTFY_URL=https://ntfy.example.test/topic\n', { mode: 0o600 });
  const preload = path.join(home, 'preload.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs'; globalThis.fetch = async (url, options = {}) => { fs.appendFileSync(process.env.SENT, String(options.body) + '\\n'); return new Response(null, { status: 204 }); };`);
  const bare = spawnSync(process.execPath, ['--import', preload, fileURLToPath(new URL('daily-selfcheck.mjs', import.meta.url))], { env: { HOME: home, PATH: process.env.PATH, DALAN_ALERTS_FILE: alertsFile, SENT: sent }, encoding: 'utf8', timeout: 5000 });
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /DALAN_RESOURCE_URL/);
  assert.match(fs.readFileSync(sent, 'utf8'), /DALAN_RESOURCE_URL/, 'the missing settings were alerted by name');
});

test('daily self-check refuses a metadata redirect and still probes JWKS', t => {
  const result = runSelfcheck(t, { resource: 'https://h.example.test/api', metadata: { resource: 'https://h.example.test/api', redirect: true } });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.followed, [], 'the self-check followed a redirect');
  assert.match(result.stderr, /DALAN_SELFCHECK_RESOURCE probe must not redirect/);
  assert.doesNotMatch(result.stderr, /elsewhere\.example\.test|jwks|keycloak_jwks_unreachable/);
  assert.ok(result.contacted('jwks'), 'the JWKS probe did not run independently');
  assert.ok(result.entries.some(entry => entry.alert?.includes('DALAN_SELFCHECK_RESOURCE probe must not redirect')), 'no alert named the setting');
  assert.ok(result.entries.every(entry => !String(entry.alert ?? '').includes('elsewhere.example.test')));
});

test('daily self-check refuses a JWKS redirect and still probes metadata', t => {
  const result = runSelfcheck(t, { resource: 'https://h.example.test/api', metadata: { resource: 'https://h.example.test/api' }, jwks: { redirect: true } });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.followed, [], 'the self-check followed a redirect');
  assert.match(result.stderr, /DALAN_SELFCHECK_ISSUER probe must not redirect/);
  assert.doesNotMatch(result.stderr, /oauth_metadata_unreachable|elsewhere\.example\.test/);
  assert.ok(result.contacted('metadata'), 'the metadata probe did not run independently');
});

test('daily self-check compares metadata resource with the whole configured resource (RFC 9728)', t => {
  for (const resource of ['https://h.example.test/api', 'https://h.example.test/', 'https://h.example.test/a/b']) {
    const ok = runSelfcheck(t, { resource, metadata: { resource } });
    assert.equal(ok.status, 0, `${resource}: ${ok.stderr}`);
    assert.match(ok.stdout, /healthy/);
  }
  // Origin-only metadata is not the identity of a path resource, and another path is not either.
  for (const [resource, published] of [
    ['https://h.example.test/api', 'https://h.example.test'],
    ['https://h.example.test/api', 'https://h.example.test/other'],
    ['https://h.example.test/api', 'https://h.example.test/api/'],
    ['https://h.example.test/', 'https://h.example.test'],
  ]) {
    const bad = runSelfcheck(t, { resource, metadata: { resource: published } });
    assert.equal(bad.status, 1, `${resource} accepted ${published}`);
    assert.match(bad.stderr, /oauth_metadata_unreachable/);
  }
});

test('metadataMatches requires the issuer as well as the identical resource', async () => {
  const { metadataMatches } = await import('./daily-selfcheck.mjs');
  const metadata = { resource: 'https://h/api', authorization_servers: ['https://id/realm'] };
  assert.equal(metadataMatches(metadata, 'https://h/api', 'https://id/realm'), true);
  assert.equal(metadataMatches(metadata, 'https://h', 'https://id/realm'), false);
  assert.equal(metadataMatches(metadata, 'https://h/api', 'https://other/realm'), false);
  assert.equal(metadataMatches(metadata, 'https://h/api', ''), false);
  assert.equal(metadataMatches(null, 'https://h/api', 'https://id/realm'), false);
});

test('metadataMatches refuses a non-array authorization_servers that contains the issuer', async () => {
  const { metadataMatches } = await import('./daily-selfcheck.mjs');
  for (const servers of ['https://id/realm', 'https://id/realm/extra', 'x https://id/realm', { 0: 'https://id/realm' }]) {
    assert.equal(metadataMatches({ resource: 'https://h/api', authorization_servers: servers }, 'https://h/api', 'https://id/realm'), false, JSON.stringify(servers));
  }
  assert.equal(metadataMatches({ resource: 'https://h/api', authorization_servers: ['https://id/realm/extra'] }, 'https://h/api', 'https://id/realm'), false);
});

test('an explicit TLS host that differs from the resource hostname is reported by setting name, never value', t => {
  const wrong = 'wrong-private-host.example.test';
  const result = runSelfcheck(t, { resource: 'https://h.example.test/api', metadata: { resource: 'https://h.example.test/api' }, env: { DALAN_SELFCHECK_TLS_HOST: wrong } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DALAN_SELFCHECK_TLS_HOST/);
  assert.ok(!result.stderr.includes(wrong) && !result.stderr.includes('h.example.test/api'), 'value leaked to stderr');
  const alert = result.entries.find(entry => entry.alert)?.alert;
  assert.match(alert, /DALAN_SELFCHECK_TLS_HOST/);
  assert.ok(!alert.includes(wrong) && !alert.includes('/api'), 'value leaked to the alert');
  assert.equal(result.entries.some(entry => entry.tls), false, 'must not probe TLS against the wrong host');
});

test('an env issuer the resource metadata does not list fails even when the resource comes from the OAuth file', t => {
  const resource = 'https://h.example.test/api';
  const result = runSelfcheck(t, { resource, metadata: { resource }, fromBridgeFile: true, env: { DALAN_SELFCHECK_ISSUER: 'https://other-id.example.test/realms/x' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /oauth_metadata_unreachable/);
});

test('a malformed-setting alert names the setting and carries no value', t => {
  const secret = 'https://h.example.test/path-secret-123?x=1';
  const result = runSelfcheck(t, { resource: 'https://h.example.test/api', metadata: {}, env: { DALAN_SELFCHECK_RESOURCE: secret } });
  assert.equal(result.status, 1);
  assert.ok(!result.stderr.includes('path-secret-123'));
  const alert = result.entries.find(entry => entry.alert)?.alert;
  assert.match(alert, /DALAN_SELFCHECK_RESOURCE/);
  assert.ok(!alert.includes('path-secret-123'), 'secret reached the alert');
});

test('a world-readable bridge OAuth file is treated as unavailable, not read', t => {
  const result = runSelfcheck(t, { resource: 'https://h.example.test/api', metadata: { resource: 'https://h.example.test/api' }, fromBridgeFile: true, fileMode: 0o644 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DALAN_RESOURCE_URL/);
  assert.equal(result.contacted('metadata'), false);
});
