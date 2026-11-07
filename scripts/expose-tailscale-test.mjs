#!/usr/bin/env node
// scripts/worker-bridge-setup.mjs --expose tailscale|ngrok and --remove, with FAKE `tailscale` and `ngrok` first on PATH.
// The real tailscale and ngrok binaries are never run. The fakes read fixture JSON from their state dir and log their argv;
// the ngrok fake must never be called, and the test asserts that. Public DNS and HTTPS are skipped at the CLI
// (DOT_BRIDGE_EXPOSE_SKIP_PUBLIC_CHECK=1) and tested with injected fakes below.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as expose from './lib/expose-tailscale.mjs';
import { run } from './worker-bridge-setup.mjs';
// These tests replace the service manager with shims, so no bridge ever opens the admin socket that --start waits for.
process.env.DALAN_SETUP_SOCKET_WAIT_MS = '0';

const script = new URL('./worker-bridge-setup.mjs', import.meta.url).pathname;
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'et-'));
const fakeBin = path.join(root, 'fake-bin'), emptyBin = path.join(root, 'empty-bin');
const NAME = 'host-a.example.net';
const DNS = `${NAME}.`;
const APP = '/Applications/Tailscale.app';
const RECEIPT = `${APP}/Contents/_MASReceipt/receipt`;
const APP_CLI = `${APP}/Contents/MacOS/Tailscale`;
const NGROK_DOMAIN = 'lark-x.ngrok-free.app';
const CAPS = { funnel: [], https: [], 'https://tailscale.com/cap/funnel-ports?ports=443,8443,10000': [] };
const running = (capMap = CAPS, magicDns = true) => ({ BackendState: 'Running', CurrentTailnet: { MagicDNSEnabled: magicDns }, Self: { DNSName: DNS, CapMap: capMap } });
const OTHER_443 = { TCP: { 443: { HTTPS: true } }, Web: { 'host-b.example.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } };
const ourRule = (port, localPort) => ({
  TCP: { [port]: { HTTPS: true } },
  Web: { [`${NAME}:${port}`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${localPort}` } } } },
  AllowFunnel: { [`${NAME}:${port}`]: true },
});

// The fake tailscale: state files in $FAKE_TS_DIR. `funnel --bg` copies funnel-after.json to funnel.json; `off` copies funnel-off.json.
const FAKE_TAILSCALE = `#!/bin/sh
d="$FAKE_TS_DIR"
echo "$*" >> "$d/argv.log"
case "$*" in
  "status --json") cat "$d/status.json" ;;
  "serve status --json") cat "$d/serve.json" ;;
  "funnel status --json") cat "$d/funnel.json" ;;
  "funnel --bg --https="*) cp "$d/funnel-after.json" "$d/funnel.json"; [ "$KILL_AFTER_FUNNEL" != 1 ] || kill -KILL "$PPID" ;;
  "funnel --https="*" off") cp "$d/funnel-off.json" "$d/funnel.json" ;;
  *) echo "fake tailscale: unexpected: $*" >&2; exit 2 ;;
esac
`;
const FAKE_SYSTEMCTL = `#!/bin/sh\necho "$@" >> "$FAKE_TS_DIR/systemctl.log"\n`;
// Must never run: any call is recorded and fails the test.
const FAKE_NGROK = `#!/bin/sh\necho "ngrok $*" >> "$FAKE_TS_DIR/ngrok.log"\nexit 2\n`;

fs.mkdirSync(fakeBin);
fs.mkdirSync(emptyBin);
fs.writeFileSync(path.join(fakeBin, 'tailscale'), FAKE_TAILSCALE, { mode: 0o755 });
fs.writeFileSync(path.join(fakeBin, 'systemctl'), FAKE_SYSTEMCTL, { mode: 0o755 });
fs.writeFileSync(path.join(fakeBin, 'launchctl'), '#!/bin/sh\necho "$@" >> "$FAKE_TS_DIR/launchctl.log"\nexit 0\n', { mode: 0o755 });
fs.writeFileSync(path.join(fakeBin, 'ngrok'), FAKE_NGROK, { mode: 0o755 });

// Each case gets its own dir, XDG config, HOME and fixtures, so no case sees another's units or records.
function caseEnv(name, { files = {}, emptyPath = false } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  for (const [file, value] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
  const env = {
    ...process.env,
    PATH: emptyPath ? emptyBin : `${fakeBin}:${process.env.PATH}`,
    XDG_CONFIG_HOME: path.join(dir, 'xdg'),
    HOME: path.join(dir, 'userhome'),
    FAKE_TS_DIR: dir,
    DOT_BRIDGE_EXPOSE_SKIP_PUBLIC_CHECK: '1',
  };
  if (!emptyPath) assert.equal(spawnSync('sh', ['-c', 'command -v launchctl'], { env, encoding: 'utf8' }).stdout.trim(), path.join(fakeBin, 'launchctl'));
  const unitDir = process.platform === 'darwin' ? path.join(env.HOME,'Library/LaunchAgents') : path.join(dir,'xdg/systemd/user');
  const unitFile = path.join(unitDir,process.platform === 'darwin' ? 'org.dalan.dot-bridge-lark.plist' : 'dot-bridge-lark.service');
  return { dir, env, unitDir, unitFile, home: path.join(dir, 'dbm') };
}

const cli = (c, args) => spawnSync(process.execPath, [script, ...args], { env: c.env, encoding: 'utf8' });
const argvLog = c => (fs.existsSync(path.join(c.dir, 'argv.log')) ? fs.readFileSync(path.join(c.dir, 'argv.log'), 'utf8').trim().split('\n') : []);
const ngrokCalled = c => fs.existsSync(path.join(c.dir, 'ngrok.log'));
const exposeArgs = (home, extra = []) => ['--worker', 'lark', '--port', '18788', '--home', home, '--expose', 'tailscale', ...extra];
const ngrokArgs = (home, extra = []) => ['--worker', 'lark', '--port', '18788', '--home', home, '--expose', 'ngrok', '--ngrok-domain', NGROK_DOMAIN, ...extra];
const noneWritten = (c, home = c.home) => {
  assert(!fs.existsSync(home), 'home not created');
  assert(!fs.existsSync(c.unitDir), 'no unit dir written');
};

// In-process fake for preflight(): status and serve status only; any other call is a test failure.
const tsFake = (status, serve = {}, calls = []) => args => {
  const key = args.join(' ');
  calls.push(key);
  if (key === 'status --json') return { status: 0, stdout: JSON.stringify(status), stderr: '' };
  if (key === 'serve status --json') return { status: 0, stdout: JSON.stringify(serve), stderr: '' };
  throw new Error(`unexpected tailscale call in preflight: ${key}`);
};
const macOpts = ({ app = false, receipt = false, cli: pathCli = null, links = {} }) => ({
  platform: 'darwin',
  mac: {
    exists: p => (p === APP && app) || (p === RECEIPT && receipt),
    realpath: p => links[p] ?? p,
    which: () => pathCli,
  },
});

try {
  // 1. Not installed: no tailscale on PATH at all.
  {
    const c = caseEnv('not-installed', { emptyPath: true });
    const r = cli(c, exposeArgs(c.home));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Tailscale is not installed/);
    assert.match(r.stderr, /https:\/\/tailscale\.com\/download/);
    noneWritten(c);
    console.log('PASS not installed refuses with the install URL, nothing written');
  }

  // 2. Logged out.
  {
    const c = caseEnv('logged-out', { files: { 'status.json': { BackendState: 'NeedsLogin', Self: {} } } });
    const r = cli(c, exposeArgs(c.home));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /`tailscale up`/);
    assert.deepEqual(argvLog(c), ['status --json'], 'preflight only, no serve or funnel call');
    noneWritten(c);
    console.log('PASS logged out refuses with `tailscale up`, nothing written');
  }

  // 3. MagicDNS off: its own message with the DNS admin link, nothing written, no funnel call.
  {
    const c = caseEnv('magicdns-off', { files: { 'status.json': running(CAPS, false), 'serve.json': {} } });
    const r = cli(c, exposeArgs(c.home));
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes(`MagicDNS is off for this tailnet. Turn it on at ${expose.ADMIN_DNS_URL}`), r.stderr);
    assert.ok(!r.stderr.includes('HTTPS certificates are off') && !r.stderr.includes('Funnel is not allowed'), 'only the MagicDNS message');
    assert.deepEqual(argvLog(c), ['status --json'], 'refused before serve or funnel');
    noneWritten(c);
    console.log('PASS MagicDNS off refuses with its own message and the DNS link, nothing written');
  }

  // 4. HTTPS certificates off (no https cap): its own message, public-ledger warning, nothing written.
  {
    const noHttps = { funnel: [], 'https://tailscale.com/cap/funnel-ports?ports=443,8443,10000': [] };
    const c = caseEnv('https-off', { files: { 'status.json': running(noHttps), 'serve.json': {} } });
    const r = cli(c, exposeArgs(c.home));
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('HTTPS certificates are off for this tailnet'), r.stderr);
    assert.ok(r.stderr.includes(`${expose.ADMIN_DNS_URL} (HTTPS Certificates: Enable HTTPS)`), r.stderr);
    assert.ok(r.stderr.includes('public ledger'), r.stderr);
    assert.ok(!r.stderr.includes('MagicDNS is off'), 'only the HTTPS message');
    assert(!argvLog(c).some(l => l.startsWith('funnel')), 'no funnel command without HTTPS');
    noneWritten(c);
    console.log('PASS HTTPS off refuses with its own message and the DNS link, nothing written');
  }

  // 5. Funnel attribute missing: its own message with the ACL link, nothing written.
  {
    const c = caseEnv('no-funnel-cap', { files: { 'status.json': running({ https: [] }), 'serve.json': {} } });
    const r = cli(c, exposeArgs(c.home));
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes(`Funnel is not allowed for this tailnet. Add the funnel node attribute at ${expose.ADMIN_ACL_URL}`), r.stderr);
    assert.ok(!r.stderr.includes('HTTPS certificates are off'), 'only the funnel message');
    assert(!argvLog(c).some(l => l.startsWith('funnel')), 'no funnel command without the cap');
    noneWritten(c);
    console.log('PASS funnel attribute missing refuses with its own message and the ACL link, nothing written');
  }

  // 6. 443 occupied by another service: 8443 is chosen, the existing rule is untouched.
  {
    const c = caseEnv('443-occupied', { files: {
      'status.json': running(), 'serve.json': OTHER_443, 'funnel.json': OTHER_443,
      'funnel-after.json': { TCP: { ...OTHER_443.TCP, 8443: { HTTPS: true } }, Web: { ...OTHER_443.Web, [`${NAME}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:18788' } } } }, AllowFunnel: { [`${NAME}:8443`]: true } },
    } });
    const r = cli(c, exposeArgs(c.home));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(argvLog(c), ['status --json', 'serve status --json', 'funnel --bg --https=8443 http://127.0.0.1:18788', 'funnel status --json']);
    const as = JSON.parse(fs.readFileSync(path.join(c.home, '.config/dalan/as.json'), 'utf8'));
    assert.ok(JSON.stringify(as).includes(`https://${NAME}:8443`), 'as.json has the derived public URL with :8443');
    const after = JSON.parse(fs.readFileSync(path.join(c.dir, 'funnel.json'), 'utf8'));
    assert.deepEqual(after.Web[`host-b.example.net:443`], OTHER_443.Web['host-b.example.net:443'], 'existing 443 rule unchanged');
    assert(!r.stdout.includes('funnel --https=443 off') && !argvLog(c).some(l => l.includes(' off')), 'no off command');
    console.log('PASS 443 occupied chooses 8443, existing rules untouched');
  }

  // 7. All three ports occupied or not allowed: refuse and list the occupants.
  {
    const c = caseEnv('all-occupied', { files: {
      'status.json': running(), 'funnel.json': {},
      'serve.json': { TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true } }, Web: { 'other:10000': { Handlers: { '/': { Proxy: 'http://127.0.0.1:1' } } } } },
    } });
    const r = cli(c, exposeArgs(c.home));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no free Funnel port/);
    assert.match(r.stderr, /443: TCP listener on 443/);
    assert.match(r.stderr, /8443: TCP listener on 8443/);
    assert.match(r.stderr, /10000: web rule other:10000/);
    assert(!argvLog(c).some(l => l.startsWith('funnel --bg')), 'no funnel rule set');
    noneWritten(c);
    console.log('PASS all ports occupied refuses and lists what occupies each');
  }

  // 8. Happy path: 443 free. The funnel argv, the derived URL in as.json, the record, and the verified status.
  {
    const c = caseEnv('happy', { files: {
      'status.json': running(), 'serve.json': {}, 'funnel.json': {}, 'funnel-after.json': ourRule(443, 18788),
    } });
    const r = cli(c, exposeArgs(c.home));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(argvLog(c), ['status --json', 'serve status --json', 'funnel --bg --https=443 http://127.0.0.1:18788', 'funnel status --json']);
    const as = JSON.parse(fs.readFileSync(path.join(c.home, '.config/dalan/as.json'), 'utf8'));
    assert.ok(JSON.stringify(as).includes(`https://${NAME}`) && !JSON.stringify(as).includes(`https://${NAME}:`), 'as.json has https://NAME with no port');
    const urlText = fs.readFileSync(path.join(c.home, 'resource-url'), 'utf8').trim();
    assert.match(urlText, new RegExp(`^https://${NAME.replaceAll('.', '\\.')}/[a-f0-9]{64}/mcp$`));
    assert(!r.stdout.includes(urlText.split('/')[3]), 'the secret is not printed');
    const recFile = path.join(c.home, 'dot-bridge-lark.exposure.json');
    const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
    assert.equal(rec.mode, 'tailscale');
    assert.equal(rec.public_port, 443);
    assert.equal(rec.local_port, 18788);
    assert.equal(rec.public_url, `https://${NAME}`);
    assert.equal(fs.statSync(recFile).mode & 0o777, 0o600);
    assert.match(r.stdout, /Public check runs with --start/);
    assert.match(r.stdout, /SKIPPED|dig @8\.8\.8\.8/);
    console.log('PASS happy path: funnel argv, derived URL in as.json, record 0600, status verified');
  }

  // 9. The funnel rule maps somewhere else: the verification refuses.
  {
    const c = caseEnv('funnel-mismatch', { files: {
      'status.json': running(), 'serve.json': {}, 'funnel.json': {}, 'funnel-after.json': ourRule(443, 19999),
    } });
    const r = cli(c, exposeArgs(c.home));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /does not show .* mapped to http:\/\/127\.0\.0\.1:18788/);
    const pending = path.join(c.home, 'dot-bridge-lark.exposure.json');
    assert.equal(JSON.parse(fs.readFileSync(pending, 'utf8')).state, 'pending', 'intent is durable before Funnel mutation');
    const remove = cli(c, ['--remove', '--worker', 'lark', '--home', c.home]);
    assert.notEqual(remove.status, 0, 'changed mismatched rule is refused');
    assert(!argvLog(c).some(l => l.endsWith(' off')), 'foreign or changed Funnel rule is never reset');
    assert(fs.existsSync(pending), 'refused cleanup keeps the recovery record');
    console.log('PASS mismatched funnel status refuses and retains safe recovery intent');
  }

  // SIGKILL after Funnel mutation leaves a pending owner record; recovery removes only the exact mapped rule.
  {
    const c=caseEnv('funnel-killed',{files:{
      'status.json':running(),'serve.json':{},'funnel.json':{},'funnel-after.json':ourRule(443,18788),'funnel-off.json':{},
    }});
    const crashed=spawnSync(process.execPath,[script,...exposeArgs(c.home)],{env:{...c.env,KILL_AFTER_FUNNEL:'1'},encoding:'utf8'});
    assert.equal(crashed.signal,'SIGKILL','fake tailscale killed setup after applying Funnel');
    const record=path.join(c.home,'dot-bridge-lark.exposure.json');
    assert.equal(JSON.parse(fs.readFileSync(record,'utf8')).state,'pending','intent was committed before mutation');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(c.dir,'funnel.json'),'utf8')),ourRule(443,18788),'the fake rule exists at the kill boundary');
    const recovered=cli(c,['--remove','--worker','lark','--home',c.home,'--purge-home']);
    assert.equal(recovered.status,0,recovered.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(c.dir,'funnel.json'),'utf8')),{},'recovery turns off the exact owned rule');
    assert(!fs.existsSync(c.home),'recovery removes the owned home after the rule is gone');
    assert.deepEqual(argvLog(c).filter(line=>line.endsWith(' off')),['funnel --https=443 off'],'no other Funnel rule is reset');
    console.log('PASS Funnel crash boundary leaves recoverable intent and removes only the exact owned rule');
  }

  // 10. Flag errors refuse before anything is written.
  {
    const c = caseEnv('flags', { files: { 'status.json': running(), 'serve.json': {}, 'funnel.json': {} } });
    const both = cli(c, ['--worker', 'lark', '--public-url', 'https://x.example.test', '--port', '18788', '--home', c.home, '--expose', 'tailscale']);
    assert.notEqual(both.status, 0);
    assert.match(both.stderr, /do not pass both/);
    const orphan = cli(c, ['--worker', 'lark', '--public-url', 'https://x.example.test', '--port', '18788', '--home', c.home, '--funnel-port', '8443']);
    assert.notEqual(orphan.status, 0);
    assert.match(orphan.stderr, /needs --expose tailscale/);
    noneWritten(c);
    assert.deepEqual(argvLog(c), [], 'no tailscale call on flag errors');
    console.log('PASS flag conflicts refuse before any call or write');
  }

  // 11. --funnel-port that is not free or not allowed refuses.
  {
    const c = caseEnv('explicit-port', { files: { 'status.json': running(), 'serve.json': OTHER_443, 'funnel.json': OTHER_443 } });
    const occupied = cli(c, exposeArgs(c.home, ['--funnel-port', '443']));
    assert.notEqual(occupied.status, 0);
    assert.match(occupied.stderr, /already used/);
    const notAllowed = cli(c, exposeArgs(c.home, ['--funnel-port', '9000']));
    assert.notEqual(notAllowed.status, 0);
    assert.match(notAllowed.stderr, /not allowed/);
    noneWritten(c);
    console.log('PASS explicit --funnel-port refuses when used or not allowed');
  }

  // 12. --start uses the native service manager shim before configuring exposure.
  {
    const c = caseEnv('start', { files: { 'status.json': running(), 'serve.json': {}, 'funnel.json': {}, 'funnel-after.json': ourRule(443, 18788) } });
    const r = cli(c, exposeArgs(c.home, ['--start']));
    assert.equal(r.status, 0, r.stderr);
    assert(fs.existsSync(c.unitFile),'native service definition exists');
    if (process.platform === 'darwin') {
      const domain = `user/${process.getuid()}`;
      assert.deepEqual(fs.readFileSync(path.join(c.dir,'launchctl.log'),'utf8').trim().split('\n'),[
        `print ${domain}`, `bootstrap ${domain} ${c.unitFile}`, `kickstart ${domain}/org.dalan.dot-bridge-lark`,
      ]);
      assert(!fs.existsSync(path.join(c.dir,'systemctl.log')),'launchd setup does not call systemctl');
      const plist = fs.readFileSync(c.unitFile,'utf8');
      assert.match(plist,/<key>DALAN_PORT<\/key>\s*<string>18788<\/string>/);
    } else {
      assert.deepEqual(fs.readFileSync(path.join(c.dir,'systemctl.log'),'utf8').trim().split('\n'),['--user show-environment','--user daemon-reload','--user enable --now dot-bridge-lark.service']);
      assert(!fs.existsSync(path.join(c.dir,'launchctl.log')),'systemd setup does not call launchctl');
    }
    assert.match(r.stdout, /SKIPPED public check/);
    console.log('PASS --start runs the units, then the funnel, with the public check skipped by the test flag');
  }

  // 13. --remove: exactly the recorded rule goes off, verified gone, record removed; units and home stay.
  {
    const c = caseEnv('remove', { files: {
      'status.json': running(), 'serve.json': {}, 'funnel.json': {}, 'funnel-after.json': ourRule(443, 18788), 'funnel-off.json': {},
    } });
    assert.equal(cli(c, exposeArgs(c.home)).status, 0);
    const before = argvLog(c).length;
    const r = cli(c, ['--worker', 'lark', '--remove', '--home', c.home]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(argvLog(c).slice(before), ['funnel status --json', 'funnel --https=443 off', 'funnel status --json']);
    assert(!fs.existsSync(path.join(c.home, 'dot-bridge-lark.exposure.json')), 'record removed');
    assert(!fs.existsSync(c.unitFile), 'unit removed together with the Funnel rule');
    assert(fs.existsSync(path.join(c.home, 'resource-url')), 'home kept');
    const again = cli(c, ['--worker', 'lark', '--remove', '--home', c.home]);
    // A second --remove finds nothing left and says so (idempotent, exit 0).
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /Nothing to remove/);
    console.log('PASS --remove turns off exactly the recorded rule and verifies it is gone');
  }

  // 14. ngrok fallback: config 0600 with no token, URL derived, quota warning, the owner commands, ngrok never run.
  {
    const c = caseEnv('ngrok', { files: { 'status.json': running(), 'serve.json': {} } });
    const r = cli(c, ngrokArgs(c.home));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(argvLog(c), [], 'no tailscale call with --expose ngrok');
    assert(!ngrokCalled(c), 'ngrok was never run');
    const configFile = path.join(c.home, 'ngrok-lark.yml');
    assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
    const text = fs.readFileSync(configFile, 'utf8');
    assert.match(text, /^version: 3$/m);
    assert.match(text, new RegExp(`^    url: ${NGROK_DOMAIN.replaceAll('.', '\\.')}$`, 'm'));
    assert.match(text, /^      url: http:\/\/127\.0\.0\.1:18788$/m);
    assert(!/authtoken/i.test(text), 'no authtoken in the config');
    const as = JSON.parse(fs.readFileSync(path.join(c.home, '.config/dalan/as.json'), 'utf8'));
    assert.ok(JSON.stringify(as).includes(`https://${NGROK_DOMAIN}`) && !JSON.stringify(as).includes(`https://${NGROK_DOMAIN}:`), 'as.json has the ngrok https URL');
    const rec = JSON.parse(fs.readFileSync(path.join(c.home, 'dot-bridge-lark.exposure.json'), 'utf8'));
    assert.equal(rec.mode, 'ngrok');
    assert.equal(rec.state,'unverified','manual ngrok setup is never reported as verified');
    assert.equal(rec.domain, NGROK_DOMAIN);
    assert.equal(rec.local_port, 18788);
    assert.equal(fs.statSync(path.join(c.home, 'dot-bridge-lark.exposure.json')).mode & 0o777, 0o600);
    assert.ok(r.stdout.includes('ngrok config add-authtoken <TOKEN>'), r.stdout);
    assert.ok(r.stdout.includes(`ngrok service install --config ${configFile}`), r.stdout);
    assert.ok(r.stdout.includes('ngrok service start'), r.stdout);
    assert.match(r.stdout,/Public status: unverified/);
    assert.match(r.stdout,/--retry-public-check --worker lark/);
    assert.match(r.stdout, /QUOTA WARNING/);
    assert.match(r.stdout, /20,000 HTTP requests per month/);
    assert.match(r.stdout, /1 GB egress per month/);
    assert.match(r.stdout, /43,000/);
    assert.match(r.stdout, /300 s or more/);
    const urlText = fs.readFileSync(path.join(c.home, 'resource-url'), 'utf8').trim();
    assert(!r.stdout.includes(urlText.split('/')[3]), 'the secret is not printed');
    const retry=['--retry-public-check','--worker','lark','--public-url',`https://${NGROK_DOMAIN}`,'--port','18788','--home',c.home];
    const retryEnv={...c.env,DOT_BRIDGE_EXPOSE_SKIP_PUBLIC_CHECK:''};
    let failureMessage='';
    await assert.rejects(run(retry,{platform:process.platform,env:retryEnv,log:()=>{},verifyPublic:async()=>false}),error=>{
      failureMessage=error.message;
      return /left in place/.test(error.message)&&/--retry-public-check/.test(error.message);
    });
    assert.match(failureMessage,/--remove --worker lark --home .* --purge-home/);
    assert(!failureMessage.includes(urlText.split('/')[3]),'retry failure never prints the private resource URL secret');
    assert.equal(JSON.parse(fs.readFileSync(path.join(c.home,'dot-bridge-lark.exposure.json'),'utf8')).state,'unverified','failed verification stays unverified');
    await run(retry,{platform:process.platform,env:retryEnv,log:()=>{},verifyPublic:async ({url,dnsName})=>url===`https://${NGROK_DOMAIN}`&&dnsName===NGROK_DOMAIN});
    assert.equal(JSON.parse(fs.readFileSync(path.join(c.home,'dot-bridge-lark.exposure.json'),'utf8')).state,'verified','successful retry records verification');
    await assert.rejects(run(retry,{platform:process.platform,env:retryEnv,log:()=>{},verifyPublic:async()=>false}),/left in place/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(c.home,'dot-bridge-lark.exposure.json'),'utf8')).state,'unverified','a later failed check removes stale verified status');
    assert(!ngrokCalled(c),'verification uses the injected public checker and never starts ngrok');
    console.log('PASS ngrok fallback: config 0600, explicit unverified state, supported public retry, ngrok not run');
  }

  // 15. ngrok flag rules refuse before anything is written.
  {
    const c = caseEnv('ngrok-flags', { files: { 'status.json': running(), 'serve.json': {}, 'funnel.json': {} } });
    const noDomain = cli(c, ['--worker', 'lark', '--port', '18788', '--home', c.home, '--expose', 'ngrok']);
    assert.notEqual(noDomain.status, 0);
    assert.match(noDomain.stderr, /needs --ngrok-domain/);
    const badDomain = cli(c, ngrokArgs(c.home).map(a => (a === NGROK_DOMAIN ? 'https://x.ngrok-free.app/path' : a)));
    assert.notEqual(badDomain.status, 0);
    assert.match(badDomain.stderr, /bare host name/);
    const domainOnTs = cli(c, exposeArgs(c.home, ['--ngrok-domain', NGROK_DOMAIN]));
    assert.notEqual(domainOnTs.status, 0);
    assert.match(domainOnTs.stderr, /--ngrok-domain needs --expose ngrok/);
    const portOnNgrok = cli(c, ngrokArgs(c.home, ['--funnel-port', '443']));
    assert.notEqual(portOnNgrok.status, 0);
    assert.match(portOnNgrok.stderr, /--funnel-port needs --expose tailscale/);
    const bothPublic = cli(c, ngrokArgs(c.home, ['--public-url', 'https://x.example.test']));
    assert.notEqual(bothPublic.status, 0);
    assert.match(bothPublic.stderr, /do not pass both/);
    noneWritten(c);
    assert(!ngrokCalled(c) && argvLog(c).length === 0, 'no tool called on flag errors');
    console.log('PASS ngrok flag rules refuse before any call or write');
  }

  // 16. --remove of an ngrok record: record removed, ngrok commands printed, ngrok not run, config left in place.
  {
    const c = caseEnv('ngrok-remove', { files: { 'status.json': running(), 'serve.json': {} } });
    assert.equal(cli(c, ngrokArgs(c.home)).status, 0);
    const r = cli(c, ['--worker', 'lark', '--remove', '--home', c.home]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ngrok service stop/);
    assert.match(r.stdout, /ngrok service uninstall/);
    assert.match(r.stdout, /NOT stopped by this script/);
    assert(!fs.existsSync(path.join(c.home, 'dot-bridge-lark.exposure.json')), 'ngrok record removed');
    assert(fs.existsSync(path.join(c.home, 'ngrok-lark.yml')), 'ngrok config left in place');
    assert(!ngrokCalled(c), 'ngrok was never run');
    assert.equal(argvLog(c).filter(l => l.startsWith('funnel')).length, 0, 'no funnel call for an ngrok record');
    console.log('PASS --remove of an ngrok record prints the ngrok stop and uninstall commands and runs nothing');
  }

  // 17. macOS variant checks: preflight with platform=darwin and injected paths. The tailscale fake is never asked
  // for status when the app is in use.
  {
    const okStatus = running();
    const serveEmpty = {};

    for (const [label, opts] of [['App Store', { app: true, receipt: true, cli: APP_CLI }], ['Standalone', { app: true, receipt: false, cli: APP_CLI }],
      ['symlink into the app', { app: true, receipt: false, cli: '/opt/homebrew/bin/tailscale', links: { '/opt/homebrew/bin/tailscale': APP_CLI } }]]) {
      const calls = [];
      assert.throws(() => expose.preflight({ tailscale: tsFake(okStatus, serveEmpty, calls), ...macOpts(opts) }), err => {
        assert.match(err.message, new RegExp(`the Tailscale ${opts.receipt ? 'App Store' : 'Standalone'} app is installed`));
        assert.ok(err.message.includes('brew install tailscale && sudo brew services start tailscale && sudo tailscale up'), err.message);
        assert.ok(err.message.includes('--expose ngrok --ngrok-domain <assigned-domain>'), err.message);
        assert.ok(err.message.includes('quit') || err.message.includes('Quit'), err.message);
        return true;
      }, `${label} refuses`);
      assert.deepEqual(calls, [], `${label}: no tailscale call before the refusal`);
    }
    console.log('PASS macOS App Store, Standalone and symlinked app CLI refuse with the commands and make no tailscale call');

    // Homebrew open-source tailscale with no app: proceeds.
    const brewStatus = running();
    const brew = expose.preflight({ tailscale: tsFake(brewStatus, serveEmpty), ...macOpts({ app: false, cli: '/opt/homebrew/bin/tailscale' }) });
    assert.equal(brew.dnsName, NAME);
    assert.deepEqual(brew.warnings, []);
    console.log('PASS macOS Homebrew open-source tailscale proceeds');

    // App installed but PATH has the open-source CLI: proceeds with a WARN line that names the conflict.
    const mixed = expose.preflight({ tailscale: tsFake(brewStatus, serveEmpty), ...macOpts({ app: true, cli: '/opt/homebrew/bin/tailscale' }) });
    assert.equal(mixed.warnings.length, 1);
    assert.match(mixed.warnings[0], /is not its CLI/);
    console.log('PASS macOS app present but PATH uses the open-source CLI proceeds with a WARN');

    // Linux never runs the macOS check, even if the app path exists.
    const lin = expose.preflight({ tailscale: tsFake(brewStatus, serveEmpty), platform: 'linux', mac: { exists: () => true, which: () => APP_CLI, realpath: p => p } });
    assert.equal(lin.dnsName, NAME);
    console.log('PASS Linux does not run the macOS check');
  }

  // 18. Public verification logic, with injected resolver, clock and request. No network.
  {
    const lines = [];
    const log = s => lines.push(s);
    const clock = () => { let t = 0; return { now: () => t, sleep: async ms => { t += ms; } }; };

    const fake = (server, resolve4) => ({ server, resolver: { resolve4 } });
    const nxdomain = async () => { throw new Error('ENOTFOUND'); };
    assert.equal(await expose.makePublicResolver([fake('1.1.1.1', nxdomain), fake('8.8.8.8', nxdomain), fake('9.9.9.9', async () => [])])(NAME), null);
    // 1.1.1.1 negative-caches the name, 8.8.8.8 answers: the answer and the answering server are returned.
    assert.deepEqual(
      await expose.makePublicResolver([fake('1.1.1.1', nxdomain), fake('8.8.8.8', async () => ['198.51.100.7', '1.2.3.4']), fake('9.9.9.9', nxdomain)])(NAME),
      { address: '198.51.100.7', server: '8.8.8.8' });
    // A slow resolver does not hold up a fast answer.
    assert.deepEqual(
      await expose.makePublicResolver([fake('1.1.1.1', () => new Promise(() => {})), fake('9.9.9.9', async () => ['198.51.100.9'])])(NAME),
      { address: '198.51.100.9', server: '9.9.9.9' });
    assert.deepEqual(expose.PUBLIC_DNS_SERVERS, ['1.1.1.1', '8.8.8.8', '9.9.9.9']);

    // DNS appears at minute 3, then /admin returns 404. Progress lines every 30 s.
    const c1 = clock(); const seen = {};
    const ok = await expose.verifyPublic({
      url: `https://${NAME}`, dnsName: NAME, log, ...c1,
      resolve4: async () => (c1.now() >= 180_000 ? { address: '198.51.100.7', server: '8.8.8.8' } : null),
      request: async (url, address) => { seen.url = url; seen.address = address; return 404; },
    });
    assert.equal(ok, true);
    assert.equal(seen.address, '198.51.100.7');
    assert.equal(c1.now(), 180_000, 'succeeded at minute 3');
    assert.ok(lines.includes(`waiting for public DNS of ${NAME} … 30 s / 600 s`), lines.join('\n'));
    assert.ok(lines.includes(`waiting for public DNS of ${NAME} … 150 s / 600 s`), lines.join('\n'));
    assert.ok(lines.some(l => l.startsWith('PASS public DNS') && l.endsWith('(via 8.8.8.8)')) && lines.some(l => l.startsWith('PASS public HTTPS')));

    // DNS never resolves: FAIL after 10 minutes with the next step; /admin is not requested.
    lines.length = 0;
    const c2 = clock();
    let requested = false;
    const dnsFail = await expose.verifyPublic({
      url: `https://${NAME}`, dnsName: NAME, log, ...c2,
      resolve4: async () => null, request: async () => { requested = true; return 404; },
    });
    assert.equal(dnsFail, false);
    assert.equal(requested, false);
    assert.ok(c2.now() >= 600_000, `waited ${c2.now()} ms`);
    assert.equal(lines.filter(l => l.startsWith('waiting for public DNS')).length, 19, 'progress every 30 s up to 570 s');
    assert.ok(lines.includes(`waiting for public DNS of ${NAME} … 570 s / 600 s`));
    assert.ok(lines.some(l => /^FAIL public DNS.*no A record.*1\.1\.1\.1.*8\.8\.8\.8.*9\.9\.9\.9.*after 600 s/.test(l) && l.includes('Next:') && l.includes('dig @8.8.8.8')), lines.join('\n'));

    const dns = async () => ({ address: '198.51.100.7', server: '1.1.1.1' });

    // Wrong status from /admin keeps failing, so it fails after the 120 s window and names the status.
    lines.length = 0;
    const c3 = clock();
    const wrong = await expose.verifyPublic({ url: `https://${NAME}`, dnsName: NAME, log, ...c3, resolve4: dns, request: async () => 200 });
    assert.equal(wrong, false);
    assert.ok(c3.now() >= 120_000, `waited ${c3.now()} ms`);
    assert.ok(lines.some(l => l.includes('returned 200, expected 404') && l.includes('after 120 s')));

    // Persistent request error: FAIL after the window, no pass line, progress at most every 30 s.
    lines.length = 0;
    const c4 = clock();
    const thrown = await expose.verifyPublic({ url: `https://${NAME}`, dnsName: NAME, log, ...c4, resolve4: dns, request: async () => { throw new Error('ECONNRESET'); } });
    assert.equal(thrown, false);
    assert.ok(c4.now() >= 120_000);
    assert.ok(lines.some(l => l.startsWith('FAIL public HTTPS: ECONNRESET')));
    assert.ok(!lines.some(l => l.startsWith('PASS public HTTPS')));
    assert.equal(lines.filter(l => l.startsWith('waiting for public HTTPS')).length, 3, 'progress at 30, 60, 90 s');

    // Warm-up: TLS error, then 503, then 404 passes.
    lines.length = 0;
    const c5 = clock();
    const outcomes = [new Error('Client network socket disconnected before secure TLS connection was established'), 503, 404];
    const warm = await expose.verifyPublic({
      url: `https://${NAME}`, dnsName: NAME, log, ...c5, resolve4: dns,
      request: async () => { const o = outcomes.shift(); if (o instanceof Error) throw o; return o; },
    });
    assert.equal(warm, true);
    assert.equal(c5.now(), 10_000, 'two 5 s retries');
    assert.ok(lines.some(l => l.startsWith('PASS public HTTPS')) && !lines.some(l => l.startsWith('FAIL')));

    // funnelRuleMatches: exact port, exact local port, nothing else on the port.
    assert.equal(expose.funnelRuleMatches(ourRule(443, 18788), NAME, 443, 18788), true);
    assert.equal(expose.funnelRuleMatches(ourRule(443, 19999), NAME, 443, 18788), false);
    assert.equal(expose.funnelRuleMatches(ourRule(8443, 18788), NAME, 443, 18788), false);
    assert.equal(expose.funnelRuleMatches({ ...ourRule(443, 18788), AllowFunnel: {} }, NAME, 443, 18788), false);
    console.log('PASS public verification: DNS success at minute 3 with progress, DNS FAIL after 10 minutes with next step, 404 check');
  }

  // 19. Pure helpers, the wake poll interval, and exposure record reading.
  assert.equal(expose.publicUrl(NAME, 443), `https://${NAME}`);
  assert.equal(expose.publicUrl(NAME, 8443), `https://${NAME}:8443`);
  assert.deepEqual(expose.allowedFunnelPorts(CAPS), [443, 8443, 10000]);
  assert.deepEqual(expose.allowedFunnelPorts({}), []);
  assert.deepEqual(expose.choosePort({ allowed: [443, 8443, 10000], occupied: new Map([[443, 'x']]) }), 8443);
  {
    const dir = path.join(root, 'poll');
    fs.mkdirSync(dir);
    assert.deepEqual(expose.readExposureRecords(path.join(root, 'no-such-home')), []);
    assert.equal(expose.pollIntervalSeconds([]), 60);
    fs.writeFileSync(path.join(dir, 'dot-bridge-lark.exposure.json'), JSON.stringify({ mode: 'tailscale' }));
    fs.writeFileSync(path.join(dir, 'unrelated.json'), '{"mode":"ngrok"}');
    assert.equal(expose.pollIntervalSeconds(expose.readExposureRecords(dir)), 60, 'tailscale record: 60 s, unrelated file ignored');
    fs.writeFileSync(path.join(dir, 'dot-bridge-ops.exposure.json'), JSON.stringify({ mode: 'ngrok' }));
    assert.equal(expose.pollIntervalSeconds(expose.readExposureRecords(dir)), 300, 'any ngrok record: 300 s');
  }
  console.log('PASS helpers: public URL, allowed ports, port choice, poll interval from exposure records');

  console.log('PASS expose tailscale and ngrok');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
