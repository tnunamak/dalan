#!/usr/bin/env node
import { defaultPath } from '../../src/paths.mjs';
import { readEnv } from '../../src/env.mjs';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildQuery, gozarHomeFor, resolveGozar, startSessionRoute, targetFor } from '../../src/gozar-routes.mjs';
import { exposureRecord } from './exposure.mjs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  assertLoopbackListener,
  bridgeSecret,
  MANIFEST_NAME,
  MANIFEST_PATH,
  REPO,
  RESOURCE_URL_FILE,
  fileList,
  parseArgs,
  runDot,
  trialHome,
  writeJsonPrivate,
} from './common.mjs';

const args = parseArgs(process.argv.slice(2), {
  values: ['--worker', '--public-url', '--home', '--port', '--route', '--lifetime-seconds'],
});

const DEFAULT_LIFETIME_SECONDS = 4 * 60 * 60;

function fail(message) { throw new Error(message); }
function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

function isLoopbackHttp(url) {
  return url.protocol === 'http:' && url.hostname === '127.0.0.1';
}

function validatePublicUrl(value, port) {
  let url;
  try { url = new URL(value); } catch { fail('--public-url must be an origin URL'); }
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) {
    fail('--public-url must be an http or https origin without credentials, query or fragment');
  }
  if (url.pathname !== '/' || value !== url.origin && value !== `${url.origin}/`) fail('--public-url must contain only scheme, host and optional port');
  if (url.protocol === 'http:' && !isLoopbackHttp(url)) fail('plain HTTP is allowed only for 127.0.0.1 test runs');
  if (isLoopbackHttp(url) && Number(url.port || 80) !== port) fail('loopback --public-url port must match --port');
  return url.origin;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function ensureFreshHome(home) {
  const absolute = path.resolve(home);
  if (absolute === path.parse(absolute).root || absolute === os.homedir() || absolute === REPO) {
    fail('--home must be a new throwaway directory');
  }
  if (fs.existsSync(absolute)) {
    const stat = fs.lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(absolute).length !== 0) {
      fail('--home must be missing or an empty real directory');
    }
  } else {
    fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(absolute, 0o700);
  const socket = defaultPath(absolute,'.local/share/dot-bridge/admin.sock');
  if (Buffer.byteLength(socket) >= 104) fail('--home makes the macOS owner socket path too long; choose a shorter path');
  return absolute;
}

function safeCommand(home, command, env) {
  const result = runDot(home, command, { env, timeout: 30_000 });
  if (result.error || result.status !== 0) fail(`dalan ${command[0]} failed (exit ${result.status ?? 'unknown'})`);
  return result.stdout;
}

function bridgeEnvironment(home, port, testHttp, runId) {
  return {
    HOME: home,
    PATH: process.env.PATH ?? '',
    DOT_BRIDGE_PORT: String(port),
    DOT_BRIDGE_AUTH_MODE: 'builtin',
    DOT_BRIDGE_LIVE_TRIAL_ID: runId,
    NODE_ENV: testHttp ? 'test' : 'production',
    ...(testHttp ? { DOT_BRIDGE_TEST_OAUTH: '1' } : {}),
  };
}

async function main() {
  if (args._.length) fail('setup accepts options only');
  const worker = args['--worker'] ?? 'fixture-a';
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(worker) || worker === 'dot') fail('--worker must be a non-dot worker name');
  const rawPort = args['--port'] ?? '8787';
  if (!/^\d+$/.test(rawPort)) fail('--port must be an integer from 0 to 65535');
  let port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('--port must be an integer from 0 to 65535');
  if (port === 0) port = await freePort();
  const publicUrl = validatePublicUrl(args['--public-url'], port);
  const publicOrigin = new URL(publicUrl);
  const routeName = args['--route'];
  if (routeName !== undefined && (!routeName || routeName.startsWith('-'))) fail('--route needs the name of a Gozar route');
  if (publicOrigin.protocol === 'https:' && routeName === undefined) fail('--route is required for HTTPS live trials so teardown can identify the public route');
  if (routeName !== undefined && publicOrigin.protocol !== 'https:') fail('--route requires an HTTPS --public-url');
  if (routeName === undefined && args['--lifetime-seconds']) fail('--lifetime-seconds requires --route');
  const rawLifetime = args['--lifetime-seconds'] ?? String(DEFAULT_LIFETIME_SECONDS);
  if (!/^\d+$/.test(rawLifetime)) fail('--lifetime-seconds must be an integer from 1 to 86400');
  const lifetimeSeconds = Number(rawLifetime);
  if (routeName !== undefined && (lifetimeSeconds < 1 || lifetimeSeconds > 86_400)) fail('--lifetime-seconds must be an integer from 1 to 86400');
  const testHttp = publicUrl.startsWith('http://');
  const home = ensureFreshHome(args['--home'] ?? trialHome(worker));
  const runId = randomUUID();
  const processTitle = `dtlt-${runId.slice(0, 8)}`;
  const logFile = path.join(home, 'bridge.log');
  const configDir = defaultPath(home,'.config/dot-bridge');

  let child;
  let sessionRoute = null;
  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(configDir, 0o700);
    const workers = { workers: { dot: { repos: [] }, [worker]: { repos: [] } }, default_execution: 'none' };
    fs.writeFileSync(path.join(configDir, 'workers.json'), `${JSON.stringify(workers, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(path.join(configDir, 'workers.json'), 0o600);

    const initEnv = {
      NODE_ENV: testHttp ? 'test' : 'production',
      ...(testHttp ? { DOT_BRIDGE_TEST_OAUTH: '1' } : {}),
    };
    safeCommand(home, ['as-init', '--public-url', publicUrl, '--json'], initEnv);

    const logFd = fs.openSync(logFile, 'a', 0o600);
    const serverUrl = pathToFileURL(path.join(REPO, 'src/server.mjs')).href;
    const bootstrap = `process.title=${JSON.stringify(processTitle)}; const {main}=await import(${JSON.stringify(serverUrl)}); await main();`;
    try {
      child = spawn(process.execPath, ['--input-type=module', '--eval', bootstrap], {
        cwd: REPO,
        env: bridgeEnvironment(home, port, testHttp, runId),
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });
    } finally {
      fs.closeSync(logFd);
    }
    child.unref();

    let started = false;
    let exitCode = null;
    child.once('exit', code => { exitCode = code; });
    const readyLine = `MCP listening on 127.0.0.1:${port}`;
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
      if (log.includes(readyLine)) { started = true; break; }
      if (exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!started) {
      const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
      if (exitCode !== null && log.includes('EADDRINUSE')) fail(`bridge did not start: port ${port} is already in use; choose another --port`);
      fail(`bridge did not start (exit ${exitCode ?? 'timeout'}); private log: ${logFile}`);
    }
    assertLoopbackListener(child.pid, port);

    const resourcePath = `/${bridgeSecret(home)}/mcp`;
    const resourceUrl = new URL(resourcePath, `${publicUrl}/`).href;
    const resourceUrlFile = path.join(home, RESOURCE_URL_FILE);
    fs.writeFileSync(resourceUrlFile, `${resourceUrl}\n`, { mode: 0o600 });
    fs.chmodSync(resourceUrlFile, 0o600);
    let exposure = null;
    if (routeName !== undefined) {
      // The owner's Gozar route, pinned to the origin this trial was set up for. It lasts for the trial and is closed by teardown.
      const gozar = await resolveGozar();
      const consent = async () => readEnv('DALAN_LIVE_TRIAL_APPROVE_ROUTE') === '1' || fail('the route needs approval: rerun with DALAN_LIVE_TRIAL_APPROVE_ROUTE=1 after reading what `dalan setup --route NAME` shows for it');
      sessionRoute = await startSessionRoute({ gozar, consent, query: buildQuery({ home: gozarHomeFor(), target: targetFor(port), route: routeName, origin: publicOrigin.origin, usage: { kind: 'session', lifetimeMs: lifetimeSeconds * 1000 } }) });
      if (sessionRoute.origin !== publicOrigin.origin) fail(`Gozar allocated ${sessionRoute.origin}, not ${publicOrigin.origin}; the route was closed`);
      exposure = exposureRecord({ view: sessionRoute.view, home: gozarHomeFor(), localPort: port, lifetimeMs: lifetimeSeconds * 1000 });
    }
    const manifest = {
      schema_version: 1,
      kind: 'dot-bridge-live-trial',
      run_id: runId,
      worker,
      home,
      repo: REPO,
      created_at: new Date().toISOString(),
      pid: child.pid,
      pids: [child.pid],
      process_title: processTitle,
      port,
      bind_host: '127.0.0.1',
      public_url: publicUrl,
      exposure,
      resource_url_file: RESOURCE_URL_FILE,
      log_file: logFile,
      jobs_file: null,
      persistence_entry_marker: `dot-bridge-live-trial:${runId}`,
      persistence_writes: [],
    };
    manifest.created_files = [...new Set([...fileList(home), MANIFEST_NAME])].sort();
    writeJsonPrivate(MANIFEST_PATH(home), manifest);

    console.log(`Trial ready: worker=${worker}, listener=127.0.0.1:${port}, pid=${child.pid}`);
    console.log(`Resource URL saved privately (mode 0600): ${resourceUrlFile}`);
    if (exposure) console.log(`Route active: ${exposure.origin} -> 127.0.0.1:${port}; Gozar ends it at ${exposure.deadline_at}, and teardown removes it sooner.`);
    console.log('Next operator commands:');
    const ownerHome = `HOME=${shellQuote(home)}`;
    console.log(`  ${ownerHome} node bin/dalan.mjs connect start --worker ${worker}`);
    console.log(`  ${ownerHome} node scripts/live-trial/job.mjs --home ${shellQuote(home)}`);
    console.log(`  ${ownerHome} node scripts/live-trial/verify.mjs --home ${shellQuote(home)}`);
    console.log(`  ${ownerHome} node scripts/live-trial/teardown.mjs --home ${shellQuote(home)}`);
  } catch (error) {
    if (sessionRoute) await sessionRoute.stop().catch(() => {});
    if (child?.pid) {
      try { child.kill('SIGTERM'); } catch { /* the process may have exited */ }
      await new Promise(resolve => setTimeout(resolve, 250));
      try { child.kill('SIGKILL'); } catch { /* the process may have exited */ }
    }
    fs.rmSync(home, { recursive: true, force: true });
    throw error;
  }
}

main().catch(error => {
  console.error(`setup failed: ${error.message}`);
  process.exitCode = 1;
});
