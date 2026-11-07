// Payload for scripts/sandbox-probe-e2e.mjs. The harness copies this file into a fixture workspace and runs it twice:
// once unsandboxed (positive control) and once as a check command inside the bridge sandbox. It prints one `RESULT {json}` line.
// Pure Node, so the sandbox needs nothing beyond /runtime/node. It only touches synthetic canaries named in ./manifest.json.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';

const [,, mode = '', arg = '', marker = ''] = process.argv;
const manifest = JSON.parse(fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const out = o => console.log('RESULT ' + JSON.stringify(o));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const attempt = async f => { try { return { ok: true, v: await f() }; } catch (e) { return { ok: false, err: e.code || e.message }; } };

// connected: the TCP/AF_UNIX handshake finished. data: bytes received back (the host fixtures answer HOST_CANARY once they see a byte).
const stream = (opts, { send = true, ms = 1500 } = {}) => new Promise(resolve => {
  let connected = false, data = '', settled = false;
  const s = net.connect(opts);
  const done = err => { if (settled) return; settled = true; s.destroy(); resolve({ connected, data, err }); };
  s.setTimeout(ms, () => done(data ? undefined : 'TIMEOUT'));
  s.on('error', e => done(e.code || e.message));
  s.on('connect', () => { connected = true; if (send) s.write('PROBE-HELLO'); else setTimeout(() => done(), 150); });
  s.on('data', b => { data += b; if (data.includes('HOST_CANARY') || data.includes('OWN')) done(); });
  s.on('end', () => done());
});
const udp = (host, port, ms = 1200) => new Promise(resolve => {
  const s = dgram.createSocket('udp4'); let data = '';
  const done = err => { try { s.close(); } catch {} resolve({ data, err }); };
  s.on('error', e => done(e.code || e.message));
  s.on('message', b => { data = String(b); done(); });
  s.send('PROBE-HELLO', port, host, e => { if (e) done(e.code || e.message); });
  setTimeout(() => done(data ? undefined : 'TIMEOUT'), ms);
});

if (mode === 'files') {
  const r = {};
  r.readOutside = await attempt(() => fs.readFileSync(manifest.readCanary, 'utf8'));
  r.writeOutside = await attempt(() => { fs.writeFileSync(manifest.writeCanary, 'CHANGED'); return 'wrote'; });
  r.workspaceWrite = await attempt(() => { fs.writeFileSync('ws-write-proof.txt', 'WS_OK'); return fs.readFileSync('ws-write-proof.txt', 'utf8'); });
  r.env = process.env.BRIDGE_CANARY_SECRET ?? null;
  r.tcp4 = await stream({ host: '127.0.0.1', port: manifest.tcp4 });
  r.tcp6 = manifest.tcp6 ? await stream({ host: '::1', port: manifest.tcp6 }) : null;
  r.udp = await udp('127.0.0.1', manifest.udp);
  r.unix = await stream({ path: manifest.unixPath });
  r.abstract = await stream({ path: manifest.abstractPath });
  out(r);
} else if (mode === 'loopback') {
  const r = {};
  const server = net.createServer(s => s.end('OWN'));
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  r.own = await stream({ host: '127.0.0.1', port: server.address().port });
  server.close();
  const same = net.createServer();
  r.bindHostPort = await attempt(() => new Promise((res, rej) => { same.once('error', rej); same.listen(manifest.tcp4, '127.0.0.1', () => res('bound')); }));
  try { same.close(); } catch {}
  await sleep(100);
  r.hostReach = await stream({ host: '127.0.0.1', port: manifest.tcp4 });
  out(r);
} else if (mode === 'localhost') {
  const r = {};
  r.hosts = await attempt(() => fs.readFileSync('/etc/hosts', 'utf8'));
  r.nsswitch = await attempt(() => fs.readFileSync('/etc/nsswitch.conf', 'utf8'));
  r.resolv = await attempt(() => fs.readFileSync('/etc/resolv.conf', 'utf8'));
  r.hostsWrite = await attempt(() => { fs.writeFileSync('/etc/hosts', 'x'); return 'wrote'; });
  r.lookup = await attempt(() => new Promise((res, rej) => dns.lookup('localhost', { all: true }, (e, a) => e ? rej(e) : res(a.map(x => x.address).sort()))));
  const server = net.createServer(s => s.end('OWN'));
  r.listen = await attempt(() => new Promise((res, rej) => { server.once('error', rej); server.listen(0, 'localhost', res); }));
  if (r.listen.ok) r.connect = await stream({ host: 'localhost', port: server.address().port });
  server.close();
  const t = Date.now();
  r.publicName = await attempt(() => new Promise((res, rej) => dns.lookup('registry.npmjs.org', (e, a) => e ? rej(e) : res(a))));
  r.publicMs = Date.now() - t;
  out(r);
} else if (mode === 'host-boundaries') {
  const r = {};
  r.home = await attempt(() => fs.readFileSync(manifest.hostHomeCanary, 'utf8'));
  r.homeEnv = process.env.HOME ?? null;
  r.sourceGit = await attempt(() => fs.readFileSync(manifest.sourceGitHead, 'utf8'));
  r.hostProc = await attempt(() => fs.readFileSync(`/proc/${manifest.hostPid}/cmdline`, 'utf8'));
  r.procScan = '';
  try {
    for (const pid of fs.readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
      try { r.procScan += fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch {}
    }
  } catch (e) { r.procScan = `SCAN_ERROR:${e.code || e.message}`; }
  out(r);
} else if (mode === 'netns') {
  out({ interfaces: Object.keys(os.networkInterfaces()).sort(), routes: fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1) });
} else if (mode === 'fds') {
  const fds = [];
  const numbers = fs.readdirSync('/proc/self/fd').filter(name => /^\d+$/.test(name)).map(Number).filter(fd => fd >= 3).sort((a, b) => a - b);
  for (const fd of numbers) {
    let st; try { st = fs.fstatSync(fd); } catch { continue; }
    let link = null; try { link = fs.readlinkSync('/proc/self/fd/' + fd); } catch {}
    const type = st.isFile() ? 'file' : st.isSocket() ? 'socket' : st.isDirectory() ? 'dir' : st.isFIFO() ? 'fifo' : st.isCharacterDevice() ? 'chr' : 'other';
    const e = { fd, link, type };
    if (type === 'file') {
      e.read = (await attempt(() => { const b = Buffer.alloc(64); const n = fs.readSync(fd, b, 0, 64, 0); return b.subarray(0, n).toString(); }));
      e.write = (await attempt(() => fs.writeSync(fd, 'FDWRITE')));
    } else if (type === 'socket') {
      e.write = (await attempt(() => fs.writeSync(fd, 'FDWRITE')));
    } else if (type === 'dir') {
      e.list = (await attempt(() => fs.readdirSync('/proc/self/fd/' + fd)));
      e.openat = (await attempt(() => fs.readFileSync('/proc/self/fd/' + fd + '/dir-canary.txt', 'utf8')));
    }
    fds.push(e);
  }
  out({ fds });
} else if (mode === 'net') {
  const r = { targets: {} };
  await Promise.all(manifest.net.map(async t => { r.targets[t.name] = await stream({ host: t.host, port: t.port }, { send: false, ms: t.ms ?? 2500 }); }));
  r.udpHost = await udp('127.0.0.1', manifest.udp, 1000);
  r.publicTcp = await stream({ host: '1.1.1.1', port: 443 }, { send: false, ms: 3000 });
  r.dns = await attempt(() => new Promise((res, rej) => dns.lookup('registry.npmjs.org', (e, a) => e ? rej(e) : res(a))));
  r.https = await new Promise(res => { const q = https.request('https://registry.npmjs.org/', { method: 'HEAD', timeout: 6000 }, p => { res({ status: p.statusCode }); p.resume(); }); q.on('error', e => res({ err: e.code || e.message })); q.on('timeout', () => { q.destroy(); }); q.end(); });
  out(r);
} else if (mode === 'netbg') {
  // Install-phase leftover: a detached process that keeps trying a public connection and logs each attempt.
  const code = 'const fs=require("fs"),net=require("net");process.on("SIGTERM",()=>{});let n=0;const end=Date.now()+30000;' +
    'const tick=()=>{if(Date.now()>end)process.exit(0);const s=net.connect({host:"1.1.1.1",port:443,timeout:700});' +
    's.on("connect",()=>{fs.appendFileSync("net-bg.log","Y "+Date.now()+"\\n");s.destroy()});' +
    's.on("error",e=>{fs.appendFileSync("net-bg.log","N "+e.code+" "+Date.now()+"\\n")});s.on("timeout",()=>{fs.appendFileSync("net-bg.log","N TIMEOUT "+Date.now()+"\\n");s.destroy()});};' +
    'setInterval(tick,300);';
  spawn('/runtime/node', ['-e', code, marker], { detached: true, stdio: 'ignore' }).unref();
  await sleep(1500);
  out({ started: true });
} else if (mode === 'netbg-read') {
  const log = () => { try { return fs.readFileSync('net-bg.log', 'utf8').trim().split('\n'); } catch { return []; } };
  const before = log().length; await sleep(1500); const after = log().length;
  out({ before, after, yes: log().filter(l => l.startsWith('Y')).length });
} else if (mode === 'hb') {
  // arg: root-stays | root-exits. A detached (setsid) grandchild B ignores SIGTERM/SIGINT and writes hb.txt every 200 ms for at most 45 s.
  const exe = process.execPath;
  const beat = 'process.on("SIGTERM",()=>{});process.on("SIGINT",()=>{});const fs=require("fs");const p=process.cwd()+"/hb.txt";let n=0;const end=Date.now()+45000;' +
    'setInterval(()=>{if(Date.now()>end)process.exit(0);fs.writeFileSync(p,String(++n)+" "+Date.now())},200);';
  const aCode = 'const {spawn}=require("child_process");spawn(process.execPath,["-e",process.argv[1],process.argv[2]],{detached:true,stdio:["ignore","inherit","inherit"]}).unref();setTimeout(()=>process.exit(0),100);';
  spawn(exe, ['-e', aCode, beat, marker], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref();
  console.log('ROOT STARTED CHAIN');
  if (arg === 'root-stays') setInterval(() => {}, 1000);
  else setTimeout(() => process.exit(0), 1500);
} else if (mode === 'export') {
  const r = {};
  if (arg === 'symlink') {
    r.abs = await attempt(() => fs.symlinkSync(manifest.readCanary, 'link-abs'));
    r.dir = await attempt(() => fs.symlinkSync('/etc', 'link-dir'));
    r.rel = await attempt(() => fs.symlinkSync('../../../../outside/read-canary', 'link-rel'));
  } else if (arg === 'hardlink') {
    r.outside = await attempt(() => fs.linkSync(manifest.readCanary, 'hl-outside'));
    r.runtime = await attempt(() => fs.linkSync('/runtime/node', 'hl-runtime'));
    r.inside = await attempt(() => fs.linkSync('manifest.json', 'hl-inside'));
  } else if (arg === 'fifo') {
    const m = spawnSync('mkfifo', ['pipe1']);
    r.mkfifo = { ok: m.status === 0, err: m.status === 0 ? undefined : String(m.stderr || m.error) };
  } else if (arg === 'big') {
    r.write = await attempt(() => { const fd = fs.openSync('big.bin', 'w'); const chunk = Buffer.alloc(1 << 20, 0x41); for (let i = 0; i < 13; i++) fs.writeSync(fd, chunk); fs.closeSync(fd); return fs.statSync('big.bin').size; });
  } else if (arg === 'receipt') {
    const fake = JSON.stringify({ status: 'passed', exit_code: 0, phase: 'check', check_status: 'check_passed' });
    for (const f of ['receipt.json', 'check-receipt.json', '.dot-bridge-receipt', 'exit_code', 'check_result.json']) fs.writeFileSync(f, fake);
    console.log('CHECK PASSED exit_code=0 status=passed');
    out(r);
    process.exit(7);
  } else if (arg === 'tamper') {
    fs.writeFileSync('.dot-bridge.json', JSON.stringify({ checks: { default: { argv: ['/runtime/node', '-e', 'console.log("TAMPERED_DEFINITION_RAN")'], timeout_ms: 5000, output_bytes: 16384 } } }));
  }
  out(r);
} else {
  console.log('unknown mode ' + mode);
  process.exit(2);
}
