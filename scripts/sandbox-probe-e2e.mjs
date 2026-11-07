#!/usr/bin/env node
// Adversarial probe suite for the check sandbox (design doc section 13). It drives the REAL Workspace.check path on a fixture repo
// whose check command is scripts/sandbox-probe-payload.mjs. Every denial first needs a live unsandboxed positive control; a denial
// without one is reported UNSUPPORTED, never PASS. Only synthetic canaries and listeners owned by this script are used.
// Output: `PROBE <group>.<n> <name>: PASS|FAIL|UNSUPPORTED <evidence>` per probe, then a capability summary.
// With --json the human lines go to stderr and stdout carries one JSON object {suite,backend,probes,capabilities,summary}:
// scripts/capability-table-test.mjs compares its capabilities with the declared table in src/execution.mjs.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import dgram from 'node:dgram';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateFdProbeRun } from './lib/sandbox-probe-fd-result.mjs';
import './require-host-sandbox.mjs'; // opts in to host checks; skips (exit 77) only when the platform lacks the sandbox, otherwise a refusal fails the run

delete process.env.DOT_BRIDGE_ALLOW_SHARED_NET_INSTALL; // install probes must use pasta, as in production
const FD_CHILD = process.argv[2] === 'fd-child';
const JSON_MODE = process.argv.includes('--json');
const X1_ONLY = process.argv.includes('--x1-only');
const say = (...a) => (JSON_MODE ? console.error(...a) : console.log(...a));
const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, '..');
const hostHome = process.env.HOME || os.homedir();
const payloadSrc = path.join(here, 'sandbox-probe-payload.mjs');
const SECRET = `SYNTHETIC_ENV_SECRET_${randomUUID()}`;
const HOST_BUDGET = { cpu_ms: 3000, wall_ms: 8000, memory_bytes: 192 * 1024 ** 2, processes: 32, disk_write_bytes: 8 * 1024 ** 2, output_bytes: 16384 };
process.env.BRIDGE_CANARY_SECRET = SECRET; // set in the bridge process; the sandbox must not inherit it
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pbp-'));
process.env.HOME = home;
process.env.DALAN_WORKSPACE_ROOT = path.join(home, 'work');
const ownerConfig = path.join(home, '.config/dot-bridge');
fs.mkdirSync(ownerConfig, { recursive: true, mode: 0o700 });
const ownerChecksFile = path.join(ownerConfig, 'checks.json');
const hostCheckAllowlistFile = path.join(ownerConfig, 'host-check-allowlist.json');
fs.writeFileSync(hostCheckAllowlistFile, JSON.stringify({ version: 1, checks: [{ repo: 'example-owner/fixture', check_id: 'default' }] }), { mode: 0o600 });
const { Store } = await import('../src/store.mjs');
const { Workspace } = await import('../src/workspace.mjs');
const { hostBackend } = await import('../src/execution.mjs'); // DALAN_HOST_CHECKS=1 is set above, so this names the budgeted backend that the probes exercise

const sleep = ms => new Promise(r => setTimeout(r, ms));
const NODE = '/runtime/node';
const run = (cmd, args, cwd) => { const x = spawnSync(cmd, args, { cwd, encoding: 'utf8' }); if (x.status !== 0) throw new Error(x.stderr || x.stdout); return x.stdout.trim(); };
const execAsync = (cmd, args, opts = {}) => new Promise(resolve => {
  const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }); let stdout = '', stderr = '';
  c.stdout.on('data', b => stdout += b); c.stderr.on('data', b => stderr += b);
  c.on('close', code => resolve({ code, stdout, stderr }));
});
const parseResults = text => String(text).split('\n').filter(l => l.startsWith('RESULT ')).map(l => JSON.parse(l.slice(7)));
const markers = [];
const newMarker = () => { const m = `PBPMARK${randomUUID().replace(/-/g, '')}`; markers.push(m); return m; };
const markerPids = m => spawnSync('ps', ['-eo', 'pid=,args=']).stdout.toString().split('\n').filter(l => l.includes(m)).map(l => +l.trim().split(/\s+/)[0]).filter(p => p && p !== process.pid);
const killMarkers = () => { for (const m of markers) for (const p of markerPids(m)) { try { process.kill(p, 'SIGKILL'); } catch {} } };
const waitForMarker = async m => { const end = Date.now() + 10000; while (Date.now() < end) { const pids = markerPids(m); if (pids.length) return pids; await sleep(25); } return []; };
function sourceGitHead() {
  const dotGit = path.join(sourceRoot, '.git');
  const layout = fs.statSync(dotGit);
  let gitDir = dotGit;
  if (layout.isFile()) {
    const raw = fs.readFileSync(dotGit, 'utf8').trim();
    if (!raw.startsWith('gitdir: ') || !raw.slice(8).trim()) {
      throw new Error('source .git file must contain a nonempty gitdir pointer');
    }
    gitDir = path.resolve(sourceRoot, raw.slice(8).trim());
  } else if (!layout.isDirectory()) {
    throw new Error('source .git must be a directory or gitdir file');
  }
  return path.join(fs.realpathSync(gitDir), 'HEAD');
}

// ---- fixture: repo, store, workspace ----
const repo = path.join(home, 'repo');
fs.mkdirSync(repo);
run('git', ['init', '-q'], repo); run('git', ['config', 'user.email', 't@example.com'], repo); run('git', ['config', 'user.name', 'T'], repo);
fs.writeFileSync(path.join(repo, 'hello.txt'), 'before\n');
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'x1-fixture', version: '1.0.0', scripts: { test: 'node -e "console.log(\\\"PINNED_PACKAGE_SCRIPT\\\")"' } }));
// A repository file may only lower the owner's budget (the smaller value of each field wins), so the committed fixture declares generous
// limits and each probe's owner definition decides the effective ones.
const REPO_BUDGET_CEILING = { cpu_ms: 120000, wall_ms: 180000, memory_bytes: 1024 ** 3, processes: 128, disk_write_bytes: 256 * 1024 ** 2, output_bytes: 1024 ** 2 };
fs.writeFileSync(path.join(repo, '.dot-bridge.json'), JSON.stringify({ checks: { default: { argv: [NODE, '-e', '0'], timeout_ms: 5000, output_bytes: 16384, host_budget: REPO_BUDGET_CEILING } } }), { mode: 0o600 });
run('git', ['add', '.'], repo); run('git', ['commit', '-qm', 'base'], repo);
const baseSha = run('git', ['rev-parse', 'HEAD'], repo);
process.env.DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE = repo;
const store = new Store(path.join(home, 'db.sqlite'));
const ws = new Workspace(store);
let manifest = {};
let lastSandboxExit = null;

async function newAssignment() {
  const id = `req_${randomUUID()}`;
  store.submit({ schema_version: 1, request_id: id, brief: 'probe', inputs: [{ github_repo: 'example-owner/fixture', base_sha: baseSha }], expected_output: 'patch', execution_scope: 'implementation', execution: 'host' }, 'thread', 'environment', 'owner');
  const claim = store.claim(id, 'dot', 'subject', 99).claim_id;
  ws.ensure(id, claim, 'subject');
  const dir = path.join(home, 'work/worktrees', id);
  fs.copyFileSync(payloadSrc, path.join(dir, 'probe.mjs'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return { id, claim, dir };
}
// A host check needs an owner-configured definition with a host_budget plus an allowlist entry; a repository file cannot supply either.
const setCheck = (a, spec) => {
  const definition = { timeout_ms: 30000, output_bytes: 65536, host_budget: HOST_BUDGET, ...spec };
  fs.writeFileSync(ownerChecksFile, JSON.stringify({ 'example-owner/fixture': { checks: { default: definition } } }), { mode: 0o600 });
};
const probeArgv = (...rest) => [NODE, 'probe.mjs', ...rest];
async function runCheck(a, started) {
  let r = started ?? await ws.check(a.id, a.claim, 'subject', 'default');
  if (!r.check_run_id) throw new Error(`check did not start: ${brief(r)}`);
  const deadline = Date.now() + 120000;
  while (r.status === 'running' && Date.now() < deadline) {
    await sleep(100);
    const job = store.db.prepare('SELECT status FROM check_jobs WHERE id=?').get(r.check_run_id);
    if (job.status !== 'running') r = { ...r, status: job.status };
  }
  const job = store.db.prepare('SELECT status,error FROM check_jobs WHERE id=?').get(r.check_run_id);
  const row = store.db.prepare('SELECT * FROM check_runs WHERE id=?').get(r.check_run_id) ?? null;
  lastSandboxExit = row?.exit_code ?? null;
  let text = '';
  if (row) text = ws.artifact(row.output_artifact_id, a.id).bytes.toString();
  return { check_run_id: r.check_run_id, job, row, text, results: parseResults(text) };
}
const lifecycleTypes = id => store.db.prepare('SELECT type FROM lifecycle_events WHERE request_id=? ORDER BY id').all(id).map(r => r.type);

// ---- reporting ----
const results = [];
const ownedHostPaths = [];
function report(group, n, name, status, evidence) {
  results.push({ id: `${group}.${n}`, name, status, ...(X1_ONLY ? { sandbox_exit_code: lastSandboxExit } : {}), evidence: String(evidence).replace(/\s+/g, ' ').slice(0, 1100) });
  say(`PROBE ${group}.${n} ${name}: ${status} ${String(evidence).replace(/\s+/g, ' ').slice(0, 1100)}`);
}
// A denial is only proven when the same action succeeded unsandboxed.
function denial(group, n, name, { control, controlEv, denied, ev }) {
  if (!control) report(group, n, name, 'UNSUPPORTED', `no live positive control (${controlEv}); denial not proven. sandbox: ${ev}`);
  else report(group, n, name, denied ? 'PASS' : 'FAIL', `control: ${controlEv}; sandbox: ${ev}`);
}
const brief = o => JSON.stringify(o, (k, v) => (typeof v === 'string' && v.length > 60 ? v.slice(0, 60) + '..' : v));

// ---- fd-injection child: this process is the "bridge" holding inherited fds ----
if (FD_CHILD) {
  const info = JSON.parse(process.env.PBP_INFO);
  manifest = {};
  const a = await newAssignment();
  const ctl = {};
  const t = f => { try { return { ok: true, v: f() }; } catch (e) { return { ok: false, err: e.code || e.message }; } };
  for (const fd of info.fileFds) {
    ctl['read' + fd] = t(() => { const b = Buffer.alloc(64); return b.subarray(0, fs.readSync(fd, b, 0, 64, 0)).toString(); });
    ctl['write' + fd] = t(() => fs.writeSync(fd, 'FDWRITE'));
  }
  for (const fd of info.sockFds) ctl['sock' + fd] = t(() => fs.writeSync(fd, 'CTRL-SOCK'));
  for (const fd of info.dirFds) {
    ctl['dirList' + fd] = t(() => fs.readdirSync('/proc/self/fd/' + fd));
    ctl['dirOpenat' + fd] = t(() => fs.readFileSync(`/proc/self/fd/${fd}/dir-canary.txt`, 'utf8'));
  }
  console.log('CONTROL_DONE ' + JSON.stringify(ctl));
  await new Promise(r => process.stdin.once('data', r));
  setCheck(a, { argv: probeArgv('fds') });
  const res = await runCheck(a);
  console.log('SANDBOX_DONE ' + JSON.stringify({ results: res.results, job: res.job, phase: res.row?.phase, exit: res.row?.exit_code }));
  store.db.close();
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(0);
}

// ---- host fixtures: canaries and owned listeners that log every connection ----
const outside = path.join(home, 'outside');
fs.mkdirSync(outside);
const readCanary = path.join(outside, 'read-canary'), writeCanary = path.join(outside, 'write-canary'), fdCanary = path.join(outside, 'fd-canary.txt');
const resetCanaries = () => { fs.writeFileSync(readCanary, 'SYNTHETIC_HOST_CANARY'); fs.writeFileSync(writeCanary, 'UNCHANGED'); fs.writeFileSync(fdCanary, 'FDCANARY'); fs.writeFileSync(path.join(outside, 'dir-canary.txt'), 'DIRCANARY'); };
resetCanaries();
const logs = {}, servers = [];
const resetLogs = () => { for (const k of Object.keys(logs)) logs[k] = { conns: 0, bytes: 0 }; };
const logSum = (...keys) => (keys.length ? keys : Object.keys(logs)).reduce((s, k) => s + (logs[k] ? logs[k].conns + logs[k].bytes : 0), 0);
const logStr = () => Object.entries(logs).map(([k, v]) => `${k}=${v.conns}/${v.bytes}`).join(' ');
function listenStream(name, listen) {
  logs[name] = { conns: 0, bytes: 0 };
  const s = net.createServer(sock => { logs[name].conns++; sock.on('data', b => { logs[name].bytes += b.length; sock.write('HOST_CANARY'); }); sock.on('error', () => {}); });
  servers.push(s);
  return new Promise(resolve => { s.once('error', () => resolve(false)); listen(s, () => resolve(true)); });
}
const unixPath = path.join(home, 's.sock'), abstractPath = '\0pbp-' + randomUUID();
const has = {};
has.tcp4 = await listenStream('tcp4', (s, ok) => s.listen(0, '127.0.0.1', ok));
has.tcp6 = await listenStream('tcp6', (s, ok) => s.listen(0, '::1', ok));
has.lan = await listenStream('lan', (s, ok) => s.listen(0, '0.0.0.0', ok));
has.unix = await listenStream('unix', (s, ok) => s.listen(unixPath, ok));
has.abstract = await listenStream('abstract', (s, ok) => s.listen(abstractPath, ok));
logs.udp = { conns: 0, bytes: 0 };
const udpServer = dgram.createSocket('udp4'); servers.push({ close: cb => udpServer.close(cb) });
udpServer.on('message', (b, rinfo) => { logs.udp.conns++; logs.udp.bytes += b.length; udpServer.send('HOST_CANARY', rinfo.port, rinfo.address); });
await new Promise(r => udpServer.bind(0, '127.0.0.1', r));
const tcp4Port = servers[0].address().port, tcp6Port = has.tcp6 ? servers[1].address().port : null, lanPort = servers[2].address().port, udpPort = udpServer.address().port;
manifest = { readCanary, writeCanary, tcp4: tcp4Port, tcp6: tcp6Port, udp: udpPort, unixPath, abstractPath, net: [] };
resetLogs();

const ctlDir = path.join(home, 'ctl');
fs.mkdirSync(ctlDir);
fs.copyFileSync(payloadSrc, path.join(ctlDir, 'probe.mjs'));
const writeCtlManifest = () => fs.writeFileSync(path.join(ctlDir, 'manifest.json'), JSON.stringify(manifest));
async function control(args, extraCwd) {
  writeCtlManifest();
  const r = await execAsync(process.execPath, ['probe.mjs', ...args], { cwd: extraCwd ?? ctlDir, env: process.env });
  return { ...r, results: parseResults(r.stdout) };
}
const hostTcp = (host, port, ms = 1500) => new Promise(resolve => { const s = net.connect({ host, port }); const done = ok => { s.destroy(); resolve(ok); }; s.setTimeout(ms, () => done(false)); s.on('connect', () => done(true)); s.on('error', () => done(false)); });
const hostHttps = () => new Promise(res => { const q = https.request('https://registry.npmjs.org/', { method: 'HEAD', timeout: 6000 }, p => { res(p.statusCode); p.resume(); }); q.on('error', () => res(null)); q.on('timeout', () => q.destroy()); q.end(); });

const t0 = Date.now();
try {
  // ======== Group 1: files, env, sockets ========
  {
    const a = await newAssignment();
    resetLogs();
    const c = await control(['files']);
    const cr = c.results[0] ?? {};
    const controlLogs = JSON.parse(JSON.stringify(logs));
    const canaryAfterControl = fs.readFileSync(writeCanary, 'utf8');
    resetCanaries(); resetLogs();
    setCheck(a, { argv: probeArgv('files') });
    const res = await runCheck(a);
    const sr = res.results[0] ?? {};
    const canaryAfter = fs.readFileSync(writeCanary, 'utf8');
    const hostWs = fs.existsSync(path.join(a.dir, 'ws-write-proof.txt')) ? fs.readFileSync(path.join(a.dir, 'ws-write-proof.txt'), 'utf8') : null;
    const sbLogs = JSON.parse(JSON.stringify(logs));
    if (!res.row || !res.results.length) report(1, 0, 'sandbox-run', 'FAIL', `check did not produce a probe result: job=${brief(res.job)} out=${res.text.slice(0, 200)}`);
    denial(1, 1, 'read-outside-file', { control: cr.readOutside?.v === 'SYNTHETIC_HOST_CANARY', controlEv: brief(cr.readOutside), denied: sr.readOutside?.ok === false && !res.text.includes('SYNTHETIC_HOST_CANARY'), ev: brief(sr.readOutside) });
    denial(1, 2, 'write-outside-file', { control: cr.writeOutside?.ok && canaryAfterControl === 'CHANGED', controlEv: `write ok, canary became ${canaryAfterControl}`, denied: sr.writeOutside?.ok === false && canaryAfter === 'UNCHANGED', ev: `${brief(sr.writeOutside)}, host canary now ${canaryAfter}` });
    const privateCopy = res.row?.evidence && JSON.parse(res.row.evidence).execution_storage === 'private_tmpfs_copy_not_exported';
    report(1, 3, 'workspace-write-stays-in-private-execution-copy', cr.workspaceWrite?.ok && sr.workspaceWrite?.v === 'WS_OK' && hostWs === null && privateCopy ? 'PASS' : 'FAIL', `control workspace write=${brief(cr.workspaceWrite)}; sandbox write=${brief(sr.workspaceWrite)}; host worktree sees ${hostWs}; private execution copy evidence=${privateCopy}`);
    denial(1, 4, 'env-canary-absent', { control: cr.env === SECRET, controlEv: `unsandboxed env has canary=${cr.env === SECRET}`, denied: sr.env === null && !res.text.includes(SECRET), ev: `env=${sr.env}` });
    const sock = (n, name, key, logKey, present) => {
      if (!present) return report(1, n, name, 'UNSUPPORTED', `no ${name} listener available on this host`);
      const ctlGot = key === 'udp' ? cr[key]?.data === 'HOST_CANARY' : cr[key]?.data?.includes('HOST_CANARY');
      const sbGot = key === 'udp' ? sr[key]?.data : sr[key]?.data || sr[key]?.connected;
      denial(1, n, name, { control: ctlGot && controlLogs[logKey].conns >= 1, controlEv: `got HOST_CANARY, listener logged ${controlLogs[logKey].conns} conn/${controlLogs[logKey].bytes}B`, denied: !sbGot && sbLogs[logKey].conns === 0, ev: `${brief(sr[key])}, listener logged ${sbLogs[logKey].conns} conn/${sbLogs[logKey].bytes}B` });
    };
    sock(5, 'host-tcp-127.0.0.1', 'tcp4', 'tcp4', has.tcp4);
    sock(6, 'host-tcp-::1', 'tcp6', 'tcp6', has.tcp6);
    sock(7, 'host-udp', 'udp', 'udp', true);
    sock(8, 'host-unix-path-socket', 'unix', 'unix', has.unix);
    sock(9, 'host-unix-abstract-socket', 'abstract', 'abstract', has.abstract);
    report(1, 10, 'no-listener-saw-sandbox', logSum() === 0 ? 'PASS' : 'FAIL', `sandbox-run listener logs conn/bytes: ${logStr()}; control-run: ${Object.entries(controlLogs).map(([k, v]) => `${k}=${v.conns}/${v.bytes}`).join(' ')}`);
  }

  // ======== Group 2: own loopback, offline phase ========
  {
    const a = await newAssignment();
    resetLogs();
    const c = await control(['loopback']); const cr = c.results[0] ?? {};
    resetLogs();
    setCheck(a, { argv: probeArgv('loopback') });
    const res = await runCheck(a); const sr = res.results[0] ?? {};
    const own = sr.own?.data === 'OWN';
    report(2, 1, 'private-loopback-offline-phase', own ? 'PASS' : 'UNSUPPORTED', `capability private_loopback ${own ? 'verified' : 'not available'}: self-connect on 127.0.0.1:0 -> ${brief(sr.own)}; control ${brief(cr.own)}`);
    denial(2, 2, 'private-loopback-isolated-from-host', { control: cr.bindHostPort?.ok === false && cr.hostReach?.data === 'HOST_CANARY', controlEv: `unsandboxed: bind host port ${brief(cr.bindHostPort)}, connect reaches ${brief(cr.hostReach?.data)}`, denied: sr.bindHostPort?.ok === true && !sr.hostReach?.connected && logs.tcp4.conns === 0, ev: `bind of host's port ${brief(sr.bindHostPort)} (own netns), connect to host port ${brief(sr.hostReach)}, host listener logged ${logs.tcp4.conns}` });
  }

  // ======== Group 9: run-phase network namespace has no external route ========
  {
    const a = await newAssignment();
    const cr = (await control(['netns'])).results[0] ?? {};
    setCheck(a, { argv: probeArgv('netns') });
    const res = await runCheck(a), sr = res.results[0] ?? {};
    const hostInterfaces = cr.interfaces?.filter(name => name !== 'lo') ?? [];
    const hostRoutes = cr.routes?.filter(route => !/^lo\s/.test(route)) ?? [];
    const hostHasNetwork = hostInterfaces.length > 0 && hostRoutes.length > 0;
    const sandboxLoopbackOnly = JSON.stringify(sr.interfaces) === JSON.stringify(['lo']) && sr.routes?.every(route => /^lo\s/.test(route));
    denial(9, 1, 'run-phase-has-no-external-network-interface-or-route', { control: hostHasNetwork, controlEv: `host control has ${hostInterfaces.length} non-loopback interfaces and ${hostRoutes.length} non-loopback routes`, denied: sandboxLoopbackOnly, ev: `sandbox interfaces=${JSON.stringify(sr.interfaces)}, route_count=${sr.routes?.length}` });
  }

  // ======== Group 2b: the name localhost in the offline phase ========
  if (!X1_ONLY) {
    const a = await newAssignment();
    const c = await control(['localhost']); const cr = c.results[0] ?? {};
    setCheck(a, { argv: probeArgv('localhost') });
    const res = await runCheck(a); const sr = res.results[0] ?? {};
    const hostsOk = sr.hosts?.v === '127.0.0.1 localhost\n::1 localhost\n' && sr.nsswitch?.v === 'hosts: files\n';
    const noLeak = sr.resolv?.ok === false && sr.hostsWrite?.ok === false;
    const works = sr.lookup?.ok && sr.lookup.v.includes('127.0.0.1') && sr.connect?.data === 'OWN';
    const fast = sr.publicName?.ok === false && /^(ENOTFOUND|EAI_)/.test(sr.publicName.err) && sr.publicMs < 2000;
    denial(2, 3, 'offline-localhost-name-minimal-hosts', { control: cr.connect?.data === 'OWN', controlEv: `unsandboxed: localhost listen/connect ${brief(cr.connect)}`, denied: hostsOk && noLeak && works && fast, ev: `hosts ${brief(sr.hosts)}, nsswitch ${brief(sr.nsswitch)}, resolv ${brief(sr.resolv)}, hosts write ${brief(sr.hostsWrite)}, lookup ${brief(sr.lookup)}, listen ${brief(sr.listen)}, connect ${brief(sr.connect)}, public name ${brief(sr.publicName)} in ${sr.publicMs} ms` });
  }

  // ======== Group 3: inherited FD injection ========
  {
    resetCanaries(); resetLogs();
    const fileFd = fs.openSync(fdCanary, 'a+'), dirFd = fs.openSync(outside, 'r');
    const sock = net.connect({ host: '127.0.0.1', port: tcp4Port });
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
    const sockFd = sock._handle.fd;
    const stdio = ['pipe', 'pipe', 'pipe']; for (let i = 3; i <= 702; i++) stdio[i] = 'ignore';
    for (const i of [3, 57, 200, 700]) stdio[i] = fileFd;
    for (const i of [4, 58, 701]) stdio[i] = sockFd;
    for (const i of [5, 702]) stdio[i] = dirFd;
    const info = { fileFds: [3, 57, 200, 700], sockFds: [4, 58, 701], dirFds: [5, 702] };
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'fd-child'], { stdio, env: { ...process.env, PBP_INFO: JSON.stringify(info) } });
    let buf = ''; const waiters = [];
    child.stdout.on('data', b => { buf += b; for (const w of [...waiters]) w(); });
    child.stderr.on('data', b => process.stderr.write(b));
    const waitFor = tag => new Promise((resolve, reject) => {
      const check = () => { const line = buf.split('\n').find(l => l.startsWith(tag + ' ')); if (line) { waiters.splice(waiters.indexOf(check), 1); resolve(JSON.parse(line.slice(tag.length + 1))); } };
      waiters.push(check); child.once('close', () => reject(new Error(`fd child exited before ${tag}: ${buf.slice(-300)}`))); check();
    });
    let fdReport;
    try {
      const ctl = await waitFor('CONTROL_DONE');
      await sleep(200);
      const controlSockBytes = logs.tcp4.bytes, fileAfterControl = fs.readFileSync(fdCanary, 'utf8');
      fs.writeFileSync(fdCanary, 'FDCANARY'); resetLogs();
      child.stdin.write('go\n');
      fdReport = await waitFor('SANDBOX_DONE');
      await sleep(200);
      const checked = validateFdProbeRun({ job: fdReport.job, row: { phase: fdReport.phase, exit_code: fdReport.exit }, results: fdReport.results });
      if (!checked.ok) {
        for (const [n, name] of [[1, 'inherited-file-fd-read-write'], [2, 'inherited-socket-fd-write'], [3, 'inherited-dir-fd-openat'], [4, 'no-extra-inherited-fds-through-702']]) {
          report(3, n, name, 'FAIL', `refusing to infer descriptor closure from an invalid guest result: ${checked.reason}; job=${fdReport.job?.status ?? 'missing'}, phase=${fdReport.phase ?? 'missing'}, exit=${fdReport.exit ?? 'missing'}`);
        }
      } else {
        const fds = checked.fds;
        const fileAfter = fs.readFileSync(fdCanary, 'utf8'), sockBytes = logs.tcp4.bytes;
        const open = fds.filter(f => f.fd >= 257 || ['file', 'socket', 'dir'].includes(f.type) || (['fifo', 'other'].includes(f.type) && !/^(anon_inode:|pipe:)/.test(f.link ?? '')));
        const summary = `guest open fds >=3: ${fds.length}; unexpected: ${open.length}${open.length ? ' LEAKED: ' + open.map(f => `${f.fd}:${f.type}:${f.link}`).join(' ') : ''}`;
        const fileLeak = fds.filter(f => f.type === 'file' && (f.read?.v?.includes('FDCANARY') || f.write?.ok));
        const fileControl = ctl.read3?.v?.includes('FDCANARY') && ctl.write3?.ok && ctl.read700?.v?.includes('FDCANARY') && ctl.write700?.ok && fileAfterControl.includes('FDWRITE');
        denial(3, 1, 'inherited-file-fd-read-write', { control: fileControl, controlEv: `bridge-side fd3/fd700 read canary and wrote; file became ${fileAfterControl}`, denied: fileLeak.length === 0 && fileAfter === 'FDCANARY', ev: `leaked file fds: ${fileLeak.map(f => f.fd).join(',') || 'none'}; canary file now ${fileAfter}. ${summary}` });
        const sockControl = ctl.sock4?.ok && ctl.sock701?.ok && controlSockBytes > 0;
        denial(3, 2, 'inherited-socket-fd-write', { control: sockControl, controlEv: `bridge-side fd4/fd701 writes succeeded; host listener logged ${controlSockBytes}B`, denied: sockBytes === 0 && !fds.some(f => f.type === 'socket'), ev: `host listener logged ${sockBytes}B after sandbox; socket fds in sandbox: ${fds.filter(f => f.type === 'socket').map(f => f.fd).join(',') || 'none'}` });
        const dirControl = ctl.dirList5?.ok && ctl.dirOpenat5?.v === 'DIRCANARY' && ctl.dirList702?.ok && ctl.dirOpenat702?.v === 'DIRCANARY';
        denial(3, 3, 'inherited-dir-fd-openat', { control: dirControl, controlEv: `bridge-side fd5/fd702 list directory and open canary`, denied: !fds.some(f => f.type === 'dir' && (f.list?.ok || f.openat?.ok)), ev: `dir fds in sandbox: ${fds.filter(f => f.type === 'dir').map(f => f.fd).join(',') || 'none'}` });
        report(3, 4, 'no-extra-inherited-fds-through-702', open.length === 0 ? 'PASS' : 'FAIL', summary);
      }
    } catch (e) {
      report(3, 0, 'fd-injection-harness', 'FAIL', `harness error: ${e.message}`);
    } finally {
      try { child.kill('SIGKILL'); } catch {}
      for (const fd of [fileFd, dirFd]) try { fs.closeSync(fd); } catch {}
      sock.destroy();
      fs.writeFileSync(fdCanary, 'FDCANARY');
    }
    report(3, 5, 'fd-injection-into-the-bridge-process-itself', 'UNSUPPORTED', 'cannot be done from outside: the bridge process cannot be modified from outside, so the harness spawned the bridge-side Workspace as a child with controlled file, connected socket, and directory descriptors at 3,4,5,57,58,200,700,701,702. Sparse values above 702 and the real systemd unit were not injected.');
    resetLogs();
  }

  // ======== Group 7: host HOME, source Git, and PID/proc isolation ========
  {
    const hostTmp = path.join(hostHome, '.tmp');
    fs.mkdirSync(hostTmp, { recursive: true, mode: 0o700 });
    const homeCanaryDir = fs.mkdtempSync(path.join(hostTmp, 'dalan-bridge-x1-home-'));
    ownedHostPaths.push(homeCanaryDir);
    const hostHomeCanary = path.join(homeCanaryDir, 'home-canary');
    fs.writeFileSync(hostHomeCanary, `HOST_HOME_CANARY_${randomUUID()}`, { mode: 0o600 });
    const pidMarker = newMarker();
    const pidChild = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', pidMarker], { stdio: 'ignore' });
    const pidReady = await waitForMarker(pidMarker);
    const hostPid = pidChild.pid;
    manifest = { ...manifest, hostHomeCanary, hostHome, sourceGitHead: sourceGitHead(), hostPid, pidMarker };
    const c = await control(['host-boundaries']);
    const cr = c.results[0] ?? {};
    const a = await newAssignment();
    setCheck(a, { argv: probeArgv('host-boundaries') });
    const res = await runCheck(a), sr = res.results[0] ?? {};
    const evidence = res.row?.evidence ? JSON.parse(res.row.evidence) : null;
    const privateCopy = evidence?.execution_storage === 'private_tmpfs_copy_not_exported';
    denial(7, 1, 'host-home-canary-unreadable', { control: cr.home?.v === fs.readFileSync(hostHomeCanary, 'utf8'), controlEv: `host control read owned HOME canary (${Boolean(cr.home?.v)})`, denied: sr.home?.ok === false && !res.text.includes('HOST_HOME_CANARY_') && sr.homeEnv !== hostHome && privateCopy, ev: `sandbox HOME=${sr.homeEnv}; canary read=${brief(sr.home)}; private execution copy=${privateCopy}` });
    denial(7, 2, 'source-git-head-unreadable', { control: cr.sourceGit?.ok && cr.sourceGit?.v === fs.readFileSync(sourceGitHead(), 'utf8'), controlEv: `host control read the source worktree Git HEAD (${sourceGitHead()})`, denied: sr.sourceGit?.ok === false && privateCopy, ev: `source Git HEAD read=${brief(sr.sourceGit)}; private execution copy=${privateCopy}` });
    denial(7, 3, 'host-pid-proc-unreadable', { control: pidReady.length > 0 && cr.hostProc?.ok && String(cr.hostProc.v).includes(pidMarker) && cr.procScan?.includes(pidMarker), controlEv: `owned host PID ${hostPid} is visible by exact /proc read and process scan`, denied: sr.hostProc?.ok === false && !sr.procScan?.includes(pidMarker) && privateCopy, ev: `host PID ${hostPid} exact read=${brief(sr.hostProc)}; marker in sandbox /proc scan=${sr.procScan?.includes(pidMarker) === true}; private execution copy=${privateCopy}` });
    try { process.kill(hostPid, 'SIGKILL'); } catch {}
    fs.rmSync(homeCanaryDir, { recursive: true, force: true });
  }

  // ======== Group 4: detached cancellation ========
  {
    const hbRead = file => { try { const [n, ts] = fs.readFileSync(file, 'utf8').trim().split(' '); return n ? { n: +n, ts: +ts } : null; } catch { return null; } };
    const waitBeats = async (file, n) => { const end = Date.now() + 10000; while (Date.now() < end) { if ((hbRead(file)?.n ?? 0) >= n) return true; await sleep(50); } return false; };
    // positive controls: the same chain unsandboxed survives the bridge's own kill (kill of the process group) and a root exit
    const m1 = newMarker(), cdir1 = path.join(home, 'ctl-hb1'); fs.mkdirSync(cdir1); fs.copyFileSync(payloadSrc, path.join(cdir1, 'probe.mjs')); fs.writeFileSync(path.join(cdir1, 'manifest.json'), '{}');
    const root1 = spawn(process.execPath, ['probe.mjs', 'hb', 'root-stays', m1], { cwd: cdir1, detached: true, stdio: 'ignore' });
    const ok1 = await waitBeats(path.join(cdir1, 'hb.txt'), 3);
    try { process.kill(-root1.pid, 'SIGKILL'); } catch {}
    const nAtKill = hbRead(path.join(cdir1, 'hb.txt'))?.n ?? 0; await sleep(1000);
    const survived1 = (hbRead(path.join(cdir1, 'hb.txt'))?.n ?? 0) > nAtKill + 2;
    const pidsControl1 = markerPids(m1).length; killMarkers();
    const m2 = newMarker(), cdir2 = path.join(home, 'ctl-hb2'); fs.mkdirSync(cdir2); fs.copyFileSync(payloadSrc, path.join(cdir2, 'probe.mjs')); fs.writeFileSync(path.join(cdir2, 'manifest.json'), '{}');
    await new Promise(r => spawn(process.execPath, ['probe.mjs', 'hb', 'root-exits', m2], { cwd: cdir2, stdio: 'ignore' }).on('exit', r));
    const n2 = hbRead(path.join(cdir2, 'hb.txt'))?.n ?? 0; await sleep(1000);
    const survived2 = (hbRead(path.join(cdir2, 'hb.txt'))?.n ?? 0) > n2 + 2; killMarkers();

    // 4.1 root stays alive, bridge cancels through the store
    const mk = newMarker(), a = await newAssignment();
    setCheck(a, { argv: probeArgv('hb', 'root-stays', mk), timeout_ms: 60000 });
    const started = ws.check(a.id, a.claim, 'subject', 'default');
    const runningPids = await waitForMarker(mk);
    const pidsDuring = markerPids(mk).length;
    const tCancel = Date.now();
    const cancelRet = store.cancel(a.id, 'probe cancel');
    const atCancel = store.get(a.id);
    let pidsRemain = pidsDuring, stoppedAt = null, doneAt = null;
    const doneP = started.then(r => { doneAt = Date.now(); return r; });
    while (Date.now() - tCancel < 4000) { await sleep(20); pidsRemain = markerPids(mk).length; if (!pidsRemain && stoppedAt === null) stoppedAt = Date.now(); }
    const started2 = await doneP;
    const res = await runCheck(a, started2);
    const pidsAfter = markerPids(mk);
    const observedStopMs = stoppedAt === null ? null : stoppedAt - tCancel;
    const stopsInTime = runningPids.length > 0 && pidsDuring > 0 && observedStopMs !== null && observedStopMs < 2000;
    denial(4, 1, 'detached-process-tree-stops-after-cancel', { control: ok1 && survived1 && pidsControl1 >= 1, controlEv: `unsandboxed setsid+double-fork chain survived kill(-pgid, SIGKILL): heartbeat advanced past kill, ${pidsControl1} marker procs`, denied: stopsInTime, ev: `sandbox payload PIDs visible before cancel=${pidsDuring}; marker PIDs reached zero ${observedStopMs ?? 'never'} ms after store.cancel; check call returned ${doneAt ? doneAt - tCancel : 'never'} ms after cancel` });
    report(4, 2, 'no-host-process-left-after-cancel', pidsDuring >= 1 && pidsAfter.length === 0 ? 'PASS' : 'FAIL', `marker processes visible from host while running: ${pidsDuring}; 4 s after cancel: ${pidsAfter.length} (${pidsAfter.join(',')})`);
    const row = store.db.prepare('SELECT * FROM check_runs WHERE id=?').get(res.check_run_id), st = store.get(a.id);
    const sandboxStop = st.sandbox_stop;
    report(4, 3, 'cancel-receipt-vs-observation', atCancel.compute_stopped === false && cancelRet.compute_stopped === false && st.compute_stopped === true && sandboxStop?.reason === 'verified' && stopsInTime ? 'PASS' : 'FAIL',
      `OBSERVED: marker PIDs stopped ${observedStopMs} ms after cancel, ${pidsAfter.length} host procs left. RECEIPT: store.cancel returned compute_stopped=${cancelRet.compute_stopped}; get() right after the cancel: cancellation_requested=${atCancel.cancellation_requested} compute_stopped=${atCancel.compute_stopped} (${atCancel.sandbox_stop?.reason}); get() after the check ended: status=${st.status} authority_revoked=${st.authority_revoked} compute_stopped=${st.compute_stopped} sandbox_stop=${JSON.stringify(sandboxStop)}; check_run exit_code=${row?.exit_code} (job ${res.job.status}${res.job.error ? ': ' + res.job.error : ''}); lifecycle=${lifecycleTypes(a.id).join('>')}. compute_stopped becomes true after the systemd cgroup stop receipt confirms no process remains.`);

    // 4.4 root exits on its own, detached chain holds the stdout pipe
    const mk2 = newMarker(), b = await newAssignment(), hb2 = path.join(b.dir, 'hb.txt');
    setCheck(b, { argv: probeArgv('hb', 'root-exits', mk2), timeout_ms: 60000 });
    const tStart = Date.now();
    const r2 = await runCheck(b); const tDone = Date.now();
    const afterDone = hbRead(hb2)?.n ?? 0; await sleep(1200);
    const grew = (hbRead(hb2)?.n ?? 0) - afterDone, pids2 = markerPids(mk2).length;
    denial(4, 4, 'detached-heartbeat-stops-when-root-exits', { control: survived2, controlEv: 'unsandboxed: chain kept writing heartbeats after the root exited', denied: r2.row?.exit_code === 0 && grew === 0 && pids2 === 0 && tDone - tStart < 6000, ev: `check returned after ${tDone - tStart} ms (exit ${r2.row?.exit_code}); heartbeat grew ${grew} in the 1.2 s after return; ${pids2} marker procs left` });
  }

  // ======== Group 5: network, install phase (pasta) and offline phase ========
  if (!X1_ONLY) {
    const pastaPath = ['/usr/bin/pasta', '/usr/local/bin/pasta'].find(f => fs.existsSync(f));
    if (!pastaPath) {
      const a = await newAssignment(); setCheck(a, { install_argv: probeArgv('net'), argv: probeArgv('net') });
      const res = await runCheck(a);
      report(5, 1, 'install-fails-closed-without-pasta', res.row?.exit_code === 126 && res.row?.phase === 'install' ? 'PASS' : 'FAIL', `pasta absent; phase=${res.row?.phase} exit=${res.row?.exit_code} out=${res.text.slice(0, 160)}`);
    } else {
      const ifaces = Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address);
      const classify = ip => ip.startsWith('100.') ? 'tailnet' : ip.startsWith('172.') ? 'docker-bridge' : 'lan-own-ip';
      const gw = (spawnSync('ip', ['route', 'show', 'default'], { encoding: 'utf8' }).stdout.match(/default via (\S+)/) || [])[1];
      let gwPort = null; if (gw) for (const p of [80, 443, 53, 22, 8080, 8443, 445]) if (await hostTcp(gw, p, 800)) { gwPort = p; break; }
      const targets = [{ name: 'host-lo4', host: '127.0.0.1', port: tcp4Port, ctl: true }, ...(has.tcp6 ? [{ name: 'host-lo6', host: '::1', port: tcp6Port, ctl: true }] : []),
        ...ifaces.map(ip => ({ name: `${classify(ip)}:${ip}`, host: ip, port: lanPort, ctl: true })),
        { name: 'pasta-gw', host: '198.18.0.1', port: tcp4Port, ctl: false }, { name: 'private-10', host: '10.255.255.254', port: 80, ctl: false, ms: 1500 },
        ...(gw ? [{ name: `lan-gateway:${gw}:${gwPort ?? 80}`, host: gw, port: gwPort ?? 80, ctl: gwPort !== null }] : [])];
      manifest.net = targets.map(({ name, host, port, ms }) => ({ name, host, port, ms }));
      const ctlRes = (await control(['net'])).results[0] ?? {};
      const hostPublic = await hostHttps();
      const ctlLogs = JSON.parse(JSON.stringify(logs));
      resetLogs();
      const a = await newAssignment();
      setCheck(a, { install_argv: probeArgv('net'), argv: probeArgv('net') });
      const res = await runCheck(a);
      const [inst, off] = [res.results[0] ?? {}, res.results[1] ?? {}];
      const conn = (r, name) => r.targets?.[name]?.connected;
      const reached = (r, names) => names.filter(n => conn(r, n));
      const listenerLogs = logStr();
      if (!res.results.length) report(5, 0, 'net-run', 'FAIL', `no probe output: phase=${res.row?.phase} exit=${res.row?.exit_code} ${res.text.slice(0, 200)}`);
      // The budgeted backend prepares dependencies outside the sandbox, so no phase has a network: the registry must be unreachable.
      denial(5, 1, 'install-phase-registry-unreachable', { control: !!hostPublic, controlEv: `host HTTPS ${hostPublic}`, denied: !inst.https?.status && !inst.dns?.ok, ev: `install-phase HTTPS ${brief(inst.https)}, dns ${brief(inst.dns)}` });
      const one = (n, name, tname, key) => { const t = targets.find(x => x.name === tname); if (!t) return report(5, n, name, 'UNSUPPORTED', `no ${tname} target on this host`);
        denial(5, n, name, { control: ctlRes.targets?.[tname]?.connected === true, controlEv: `unsandboxed connect ${t.host}:${t.port} ok`, denied: !conn(inst, tname), ev: `${brief(inst.targets?.[tname])}` }); };
      one(2, 'install-host-loopback-127.0.0.1', 'host-lo4');
      one(3, 'install-host-loopback-::1', 'host-lo6');
      denial(5, 4, 'install-host-udp-loopback', { control: ctlRes.udpHost?.data === 'HOST_CANARY', controlEv: `unsandboxed UDP reply ${brief(ctlRes.udpHost)}`, denied: !inst.udpHost?.data && logs.udp.conns === 0, ev: `${brief(inst.udpHost)}, udp listener logged ${logs.udp.conns}` });
      const gwT = targets.find(t => t.name.startsWith('lan-gateway'));
      if (!gwT) report(5, 5, 'install-lan-gateway', 'UNSUPPORTED', 'no default route on host');
      else denial(5, 5, 'install-lan-gateway-connect-only', { control: ctlRes.targets?.[gwT.name]?.connected === true, controlEv: `unsandboxed connect ${gwT.host}:${gwT.port} ${gwPort ? 'ok' : 'refused on 80,443,53,22,8080,8443,445 (gateway offers none)'}`, denied: !conn(inst, gwT.name), ev: brief(inst.targets?.[gwT.name]) });
      const priv = targets.filter(t => /^(lan-own-ip|docker-bridge|tailnet):/.test(t.name));
      const privOk = priv.filter(t => ctlRes.targets?.[t.name]?.connected === true);
      denial(5, 6, 'install-private-ips', { control: privOk.length > 0 && privOk.length === priv.length, controlEv: `unsandboxed reached owned listener via ${privOk.map(t => t.host).join(',')} of ${priv.map(t => t.host).join(',')}`, denied: reached(inst, priv.map(t => t.name)).length === 0, ev: priv.map(t => `${t.host}:${inst.targets?.[t.name]?.err ?? (inst.targets?.[t.name]?.connected ? 'CONNECTED' : '?')}`).join(' ') + `; 10.255.255.254:${inst.targets?.['private-10']?.err}` });
      denial(5, 7, 'install-pasta-gateway-198.18.0.1-to-host', { control: ctlLogs.tcp4.conns >= 1, controlEv: 'owned listener live (reached via 127.0.0.1 by the control); 198.18.0.1 is only addressable inside the namespace', denied: !conn(inst, 'pasta-gw'), ev: brief(inst.targets?.['pasta-gw']) });
      const hostPublicTcp = await hostTcp('1.1.1.1', 443, 3000);
      denial(5, 8, 'offline-phase-public-internet', { control: hostPublicTcp && !!hostPublic, controlEv: `host connect 1.1.1.1:443 ${hostPublicTcp}, HTTPS ${hostPublic}`, denied: !off.publicTcp?.connected && !off.https?.status && !off.dns?.ok, ev: `tcp ${brief(off.publicTcp)}, https ${brief(off.https)}, dns ${brief(off.dns)}` });
      const hostNames = targets.filter(t => t.ctl && ctlRes.targets?.[t.name]?.connected === true).map(t => t.name);
      denial(5, 9, 'offline-phase-host-and-lan-targets', { control: hostNames.length === targets.filter(t => t.ctl).length, controlEv: `unsandboxed reached ${hostNames.length} controlled targets`, denied: reached(off, targets.map(t => t.name)).length === 0 && logSum('tcp4', 'tcp6', 'lan', 'udp') === 0, ev: `offline reached [${reached(off, targets.map(t => t.name)).join(',')}]; listener logs conn/bytes after both phases: ${listenerLogs}` });

      // transition: a detached install-phase process must not keep its network after the phase ends
      const mk = newMarker(), b = await newAssignment();
      setCheck(b, { install_argv: probeArgv('netbg', 'x', mk), argv: probeArgv('netbg-read') });
      const rb = await runCheck(b);
      const bgLog = () => { try { return fs.readFileSync(path.join(b.dir, 'net-bg.log'), 'utf8').trim().split('\n'); } catch { return []; } };
      const during = bgLog(), yes = during.filter(l => l.startsWith('Y')).length; await sleep(1200);
      const later = bgLog();
      denial(5, 10, 'install-process-cannot-outlive-install-phase', { control: yes >= 1, controlEv: `install-phase detached process made ${yes} successful public connects before the switch`, denied: later.length === during.length && markerPids(mk).length === 0, ev: `log lines at check start/end/+1.2s: ${rb.results[1]?.before}/${rb.results[1]?.after}/${later.length}; marker procs left ${markerPids(mk).length}` });
      report(5, 11, 'install-fails-closed-without-pasta', 'UNSUPPORTED', `pasta present at ${pastaPath}; the budgeted backend gives no phase a network, so the legacy fail-closed-without-pasta branch does not apply.`);
    }
  }

  // ======== Group 8: candidate metadata cannot raise pinned authority ========
  if (X1_ONLY) {
    const a = await newAssignment();
    const controlDir = path.join(home, 'ctl-package');
    fs.mkdirSync(controlDir);
    const packageCode = `const fs=require("fs"),b=Buffer.alloc(65536,1);let n=0;console.log("PACKAGE_PAYLOAD_STARTED");while(n<256)fs.writeFileSync("package-fill-"+n++,b);console.log("PACKAGE_CONTROL_BYTES="+n*b.length)`;
    const packageJson = JSON.stringify({ name: 'x1-attack', version: '1.0.0', scripts: { test: `node -e '${packageCode}'` } });
    fs.writeFileSync(path.join(controlDir, 'package.json'), packageJson);
    const controlResult = await execAsync('npm', ['test'], { cwd: controlDir, env: process.env });
    fs.writeFileSync(path.join(a.dir, 'package.json'), packageJson);
    setCheck(a, { argv: ['npm', 'test'], timeout_ms: 30000, host_budget: { cpu_ms: 120000, wall_ms: 180000, memory_bytes: 1024 ** 3, processes: 128, disk_write_bytes: 256 * 1024 ** 2, output_bytes: 1024 ** 2 } });
    const res = await runCheck(a);
    const evidence = res.row?.evidence ? JSON.parse(res.row.evidence) : null;
    const limits = evidence?.host_budget?.limits;
    const usage = evidence?.host_budget?.usage;
    const controlBytes = Number(controlResult.stdout.match(/PACKAGE_CONTROL_BYTES=(\d+)/)?.[1] ?? 0);
    report(8, 1, 'malicious-package-script-stays-within-pinned-budget', controlResult.code === 0 && controlBytes === 256 * 65536 && res.text.includes('PACKAGE_PAYLOAD_STARTED') && evidence?.host_budget?.error === 'budget exceeded: disk_write' && JSON.stringify(limits) === JSON.stringify(HOST_BUDGET) && usage?.disk_write_bytes <= HOST_BUDGET.disk_write_bytes && evidence?.execution_storage === 'private_tmpfs_copy_not_exported' ? 'PASS' : 'FAIL',
      `unsandboxed package test wrote ${controlBytes} bytes/exit ${controlResult.code}; sandbox package marker=${res.text.includes('PACKAGE_PAYLOAD_STARTED')}, exit=${res.row?.exit_code}, job=${res.job.status}/${res.job.error}, evidence error=${evidence?.host_budget?.error}, pinned limits=${brief(limits)}, observed disk=${usage?.disk_write_bytes}; candidate requested ${256 * 1024 ** 2} bytes; storage=${evidence?.execution_storage}`);
  }

  // ======== Group 6: export and evidence ========
  if (!X1_ONLY) {
    const exportCase = async (arg, spec = {}) => {
      const a = await newAssignment();
      setCheck(a, { argv: probeArgv('export', arg), ...spec });
      const t = Date.now(); const res = await runCheck(a); const checkMs = Date.now() - t;
      const d0 = Date.now(); let diff = null, diffErr = null, resultErr = null, snapErr = null, patchBytes = null;
      try { diff = ws.diff(a.dir, baseSha); } catch (e) { diffErr = e.message; }
      try { ws.result(a.id, a.claim, 'subject'); } catch (e) { resultErr = e.message; }
      try { const s = ws.snapshot(a.id, a.claim, 'subject'); patchBytes = ws.artifact(s.patch_artifact.artifact_id, a.id).bytes.toString(); } catch (e) { snapErr = e.message; }
      return { a, res, checkMs, diffMs: Date.now() - d0, diff, diffErr, resultErr, snapErr, patchBytes };
    };
    const leaks = text => /SYNTHETIC_HOST_CANARY|root:x:0:0/.test(text ?? '');
    // 6.1 symlinks
    {
      const x = await exportCase('symlink'), sr = x.res.results[0] ?? {};
      // The sandbox's writes stay in its private copy, so the control is a host-side link to the same canary.
      const ctlSymlink = path.join(home, 'sl-ctl'); let readThrough = null; try { fs.symlinkSync(readCanary, ctlSymlink); readThrough = fs.readFileSync(ctlSymlink, 'utf8'); } catch (e) { readThrough = e.code; }
      let wsRead = 'returned'; try { ws.read(x.a.id, x.a.claim, 'subject', 'link-abs'); } catch (e) { wsRead = 'refused'; }
      denial(6, 1, 'outside-symlink-not-followed-in-export', { control: sr.abs?.ok && readThrough === 'SYNTHETIC_HOST_CANARY', controlEv: `sandbox created the links; a host-side read through link-abs yields ${brief(readThrough)}`, denied: !x.diffErr && !leaks(x.diff?.patch) && !leaks(x.patchBytes) && wsRead === 'refused' && x.res.row?.exit_code === 0, ev: `diff err=${x.diffErr}, canary/passwd in diff=${leaks(x.diff?.patch)}, in patch artifact=${leaks(x.patchBytes)}, workspace_read(link)=${wsRead}, symlinks listed in diff=${/link-(abs|dir|rel)/.test(x.diff?.patch ?? '')}` });
    }
    // 6.2 hardlinks
    {
      const x = await exportCase('hardlink'), sr = x.res.results[0] ?? {};
      const ctlLink = path.join(home, 'hl-ctl'); let ctlOk = false; try { fs.linkSync(readCanary, ctlLink); ctlOk = fs.readFileSync(ctlLink, 'utf8') === 'SYNTHETIC_HOST_CANARY'; } catch {}
      denial(6, 2, 'hardlink-to-outside-file', { control: ctlOk && sr.inside?.ok, controlEv: `host-side link(outside file) works on this fs=${ctlOk}; in-sandbox link inside the workspace works=${sr.inside?.ok}`, denied: sr.outside?.ok === false && sr.runtime?.ok === false && !leaks(x.diff?.patch) && !x.diffErr, ev: `link(outside)=${brief(sr.outside)}, link(/runtime/node)=${brief(sr.runtime)}, diff err=${x.diffErr}, canary in diff=${leaks(x.diff?.patch)}` });
    }
    // 6.3/6.4 FIFO
    {
      const x = await exportCase('fifo'), sr = x.res.results[0] ?? {};
      const made = sr.mkfifo?.ok === true; // created inside the sandbox's private copy; nothing is exported back
      const bounded = x.checkMs < 8000 && x.diffMs < 8000;
      report(6, 3, 'fifo-does-not-hang-export', made && bounded ? 'PASS' : made ? 'FAIL' : 'UNSUPPORTED', `FIFO ${made ? 'created by the sandbox' : 'not created'}; check returned in ${x.checkMs} ms, ws.diff in ${x.diffMs} ms (diff ${x.diffErr ? 'threw: ' + x.diffErr : 'ok'})`);
      report(6, 4, 'fifo-does-not-poison-evidence', made && x.res.row && !x.diffErr && !x.resultErr && !x.snapErr ? 'PASS' : made ? 'FAIL' : 'UNSUPPORTED', `check job=${x.res.job.status}${x.res.job.error ? ' error=' + x.res.job.error : ''}, check_runs row=${x.res.row ? 'exit ' + x.res.row.exit_code : 'none'}; workspace_result ${x.resultErr ? 'threw: ' + x.resultErr : 'ok'}; snapshot ${x.snapErr ? 'threw: ' + x.snapErr : 'ok'}`);
      fs.rmSync(path.join(x.a.dir, 'pipe1'), { force: true });
    }
    // 6.5/6.6 oversized file (13 MiB, above the 12 MiB git diff buffer)
    {
      const x = await exportCase('big', { host_budget: { ...HOST_BUDGET, disk_write_bytes: 64 * 1024 ** 2 } }), sr = x.res.results[0] ?? {};
      const bigSize = sr.write?.ok ? sr.write.v : 0, made = bigSize >= 13 << 20;
      report(6, 5, 'oversized-file-bounded', made && x.checkMs < 15000 && x.diffMs < 15000 ? 'PASS' : made ? 'FAIL' : 'UNSUPPORTED', `${bigSize}-byte file ${made ? 'written by the sandbox' : 'not written'}; check ${x.checkMs} ms, ws.diff ${x.diffMs} ms; diff ${x.diffErr ? 'threw: ' + x.diffErr : 'ok, ' + x.diff?.bytes + ' bytes'}`);
      report(6, 6, 'oversized-file-does-not-poison-evidence', made && x.res.row && !x.diffErr && !x.resultErr && !x.snapErr ? 'PASS' : made ? 'FAIL' : 'UNSUPPORTED', `check job=${x.res.job.status}${x.res.job.error ? ' error=' + x.res.job.error : ''}, check_runs row=${x.res.row ? 'exit ' + x.res.row.exit_code : 'none'}; workspace_result ${x.resultErr ? 'threw: ' + x.resultErr : 'ok'}; snapshot ${x.snapErr ? 'threw: ' + x.snapErr : 'ok'}`);
    }
    // 6.7 fake receipt files and stdout
    {
      const x = await exportCase('receipt');
      const types = lifecycleTypes(x.a.id), recorded = x.res.row?.exit_code;
      const listed = ws.result(x.a.id, x.a.claim, 'subject').checks.at(-1);
      report(6, 7, 'fake-receipt-cannot-change-exit-code', recorded === 7 && listed?.exit_code === 7 && types.at(-1) === 'check_failed' && x.res.row?.phase === 'check' ? 'PASS' : 'FAIL', `check exited 7 and wrote receipt.json/exit_code/etc. saying exit_code 0 plus stdout "CHECK PASSED"; recorded exit_code=${recorded}, workspace_result exit_code=${listed?.exit_code}, last lifecycle=${types.at(-1)}, fake files in diff as data=${/receipt\.json/.test(x.diff?.patch ?? '')}`);
    }
    // 6.8 the check rewrites its own definition: the owner definition still decides what runs, and the rewrite stays in the private copy
    {
      const x = await exportCase('tamper');
      const again = await runCheck(x.a);
      const ran = again.text.includes('TAMPERED_DEFINITION_RAN') || x.res.text.includes('TAMPERED_DEFINITION_RAN');
      const evidence = again.row?.evidence ? JSON.parse(again.row.evidence) : null;
      const hostFile = path.join(x.a.dir, '.dot-bridge.json');
      const hostRewritten = fs.existsSync(hostFile) && fs.readFileSync(hostFile, 'utf8').includes('TAMPERED_DEFINITION_RAN');
      report(6, 8, 'check-definition-rewrite-by-check', x.res.row?.exit_code === 0 && again.row?.exit_code === 0 && !ran && !hostRewritten && evidence?.definition?.source === 'owner_config' ? 'PASS' : 'FAIL',
        `the check rewrote .dot-bridge.json inside the sandbox; the next run executed the tampered command=${ran}; the host worktree file holds the rewrite=${hostRewritten}; first exit=${x.res.row?.exit_code}, second exit=${again.row?.exit_code}; definition.source=${evidence?.definition?.source}`);
    }
  }
} finally {
  killMarkers();
  for (const p of ownedHostPaths) fs.rmSync(p, { recursive: true, force: true });
  for (const s of servers) try { await new Promise(r => s.close(r)); } catch {}
  try { store.db.close(); } catch {}
  fs.rmSync(home, { recursive: true, force: true });
}

// ---- capability summary in the vocabulary of design section 13 ----
const by = Object.fromEntries(results.map(r => [r.id, r.status]));
const cap = ids => {
  const st = ids.map(i => by[i]);
  if (st.includes('FAIL')) return `unsupported (FAIL: ${ids.filter(i => by[i] === 'FAIL').join(',')})`;
  if (st.some(s => s === undefined || s === 'UNSUPPORTED')) return `unknown (not proven: ${ids.filter(i => by[i] !== 'PASS').join(',')})`;
  return 'verified';
};
say(`\nCAPABILITIES (backend: ${hostBackend().name})`);
const caps = [
  ['private_loopback', ['2.1']], ['host_loopback_denied', X1_ONLY ? ['1.5', '1.6', '1.7', '2.2'] : ['1.5', '1.6', '1.7', '2.2', '5.2', '5.3', '5.4', '5.9']],
  ['lan_denied', X1_ONLY ? ['9.1'] : ['5.5', '5.6', '5.7']], ['unix_sockets_denied', ['1.8', '1.9']],
  ['credential_services_denied', ['1.4', '1.8', '1.9', ...(X1_ONLY ? ['7.1'] : [])]], ['closed_inherited_fds', ['3.1', '3.2', '3.3', '3.4']],
  ['read_scope_enforced', ['1.1', '6.1']], ['write_scope_enforced', ['1.2', '1.3']],
  ['full_tree_cancel_verified', ['4.1', '4.2', '4.3', '4.4']],
  ['offline_transition_revokes_connections', ['5.8', '5.10']], ['artifact_export_no_follow', ['6.1', '6.2', '6.3', '6.4', '6.5', '6.6']],
  ['runner_observed_evidence', ['6.7', '6.8']]];
const capabilities = Object.fromEntries(caps.map(([name, ids]) => [name, cap(ids).split(' ')[0]]));
if (X1_ONLY) {
  capabilities.host_pid_proc_isolated = by['7.3'] === 'PASS' ? 'verified' : by['7.3'] === 'UNSUPPORTED' ? 'unsupported' : 'unknown';
  capabilities.run_phase_networkless = by['9.1'] === 'PASS' ? 'verified' : by['9.1'] === 'UNSUPPORTED' ? 'unsupported' : 'unknown';
  capabilities.pinned_budget_resists_candidate_metadata = by['8.1'] === 'PASS' ? 'verified' : by['8.1'] === 'UNSUPPORTED' ? 'unsupported' : 'unknown';
}
capabilities.native_darwin_execution = 'unsupported';
capabilities.immutable_input_snapshot = 'unsupported'; // the workspace is bind-mounted writable: no probe can show an immutable input, and none is claimed
for (const [name, ids] of caps) say(`CAP ${name}: ${cap(ids)}`);
say('CAP native_darwin_execution: unsupported (Linux host)');
say('CAP immutable_input_snapshot: unsupported (the workspace is a writable bind mount)');
const fails = results.filter(r => r.status === 'FAIL');
const count = status => results.filter(r => r.status === status).length;
say(`\nSUMMARY ${count('PASS')} PASS, ${fails.length} FAIL, ${count('UNSUPPORTED')} UNSUPPORTED in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (JSON_MODE) console.log(JSON.stringify({ suite: 'scripts/sandbox-probe-e2e.mjs', backend: hostBackend().name, probes: results, capabilities, summary: { pass: count('PASS'), fail: fails.length, unsupported: count('UNSUPPORTED') } }));
process.exit(fails.length ? 1 : 0);
