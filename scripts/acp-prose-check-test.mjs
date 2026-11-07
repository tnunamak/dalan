#!/usr/bin/env node
// The optional prose checker runs worker patch prose: it must get a scrubbed environment, die with its whole process
// tree on timeout, obey the host-check policy, and never leak secret-shaped stderr into the result text.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBuildProseCheck, buildResultText } from '../src/acp-bridge.mjs';

const root = fs.mkdtempSync(path.join(os.homedir(), '.tmp-acp-prose-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const script = (name, body) => {
  const file = path.join(root, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}`, { mode: 0o700 });
  return file;
};
const patch = '+++ b/README.md\n+Some prose line.\n';
const allow = () => null;
const baseEnv = { PATH: process.env.PATH, DALAN_ACP_PROSE_CHECK_OWNERS: 'acme' };
const secrets = { GH_TOKEN: 'ghp_SYNTHETICsyntheticSYNTHETIC0000000000', AWS_SECRET_ACCESS_KEY: 'synthetic-aws-secret', OPENAI_API_KEY: 'sk-synthetic-not-real', DALAN_OWNER_TOKEN: 'synthetic-owner-token' };

// (1a) the checker sees none of the secret environment variables.
const dump = script('dump-env.mjs', `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({findings:[{text:JSON.stringify(process.env)}]}));});`);
const seen = await runBuildProseCheck('acme/x', patch, { ...baseEnv, ...secrets, DALAN_ACP_PROSE_CHECK: dump }, { refusal: allow });
assert.equal(seen.status, 'PASS', JSON.stringify(seen));
const childEnv = seen.findings[0].text;
for (const value of Object.values(secrets)) assert.ok(!childEnv.includes(value), `checker saw secret ${value}`);
for (const name of Object.keys(secrets)) assert.ok(!childEnv.includes(name), `checker saw variable ${name}`);

// (1b) timeout kills the whole process group, including a sleeping grandchild.
const pidFile = path.join(root, 'grandchild.pid');
const hang = script('hang.mjs', `import {spawn} from 'node:child_process';import fs from 'node:fs';
const g=spawn('sleep',['300'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(g.pid));setInterval(()=>{},1000);`);
const timedOut = await runBuildProseCheck('acme/x', patch, { ...baseEnv, DALAN_ACP_PROSE_CHECK: hang }, { refusal: allow, timeoutMs: 1500 });
assert.deepEqual(timedOut, { status: 'ERROR', detail: 'timed out' });
const gpid = Number(fs.readFileSync(pidFile, 'utf8'));
await new Promise(r => setTimeout(r, 300));
let alive = true;
try { process.kill(gpid, 0); } catch { alive = false; }
if (alive) process.kill(gpid, 'SIGKILL');
assert.equal(alive, false, 'grandchild survived the timeout');

// (1c) host-check policy refusal skips the checker and says so.
const marker = path.join(root, 'ran');
const spy = script('spy.mjs', `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'x');process.stdout.write('{}');`);
const refused = await runBuildProseCheck('acme/x', patch, { ...baseEnv, DALAN_ACP_PROSE_CHECK: spy }, { refusal: () => 'resource_limits_unavailable: test' });
assert.equal(refused.status, 'ERROR');
assert.match(refused.detail, /skipped.*resource_limits_unavailable/);
assert.equal(fs.existsSync(marker), false, 'checker ran despite policy refusal');

// (2) secret-shaped stderr straddling the 300-byte clip never appears, even partially.
const ghToken = 'ghp_' + 'SYNTHETICabcdefghij0123456789ABCDEF'.slice(0, 36);
const bearer = 'Bearer synthetic-opaque-credential-value-123456';
const hex = 'ab12cd34'.repeat(8);
for (const secret of [ghToken, bearer, hex]) {
  for (const offset of [260, 280, 290, 296]) {
    const noise = 'x'.repeat(offset - 1) + ' ';
    const err = script('leak.mjs', `process.stderr.write(${JSON.stringify(noise + secret + ' trailing')});process.stdout.write('not json');`);
    const verdict = await runBuildProseCheck('acme/x', patch, { ...baseEnv, DALAN_ACP_PROSE_CHECK: err }, { refusal: allow });
    const text = buildResultText({ request_id: 'r1' }, 'done', null, verdict);
    for (const n of [12, 8, 6]) assert.ok(!text.includes(secret.slice(0, n)), `prefix of ${secret.slice(0, 6)}… leaked (offset ${offset}, ${n} chars)`);
  }
}
// Findings are redacted too.
const find = script('find.mjs', `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({findings:[{rule:'r',text:'echo '+${JSON.stringify(ghToken)}}]}));});`);
const fv = await runBuildProseCheck('acme/x', patch, { ...baseEnv, DALAN_ACP_PROSE_CHECK: find }, { refusal: allow });
assert.ok(!buildResultText({ request_id: 'r1' }, 'done', null, fv).includes(ghToken.slice(0, 8)), 'finding leaked a token');

// (3) finding shapes: arrays/objects/unknown severities are dropped, never printed.
const render = findings => {
  const file = script('shape.mjs', `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({findings:${JSON.stringify(findings)}}));});`);
  return runBuildProseCheck('acme/x', patch, { ...baseEnv, DALAN_ACP_PROSE_CHECK: file }, { refusal: allow });
};
const tokenShapes = await render([
  { severity: [ghToken], rule: [ghToken], type: [ghToken], text: 'ok' },
  { severity: { a: ghToken }, rule: { a: ghToken }, text: ['x', ghToken] },
  { severity: ghToken, rule: 'r' },
  'bare-string-' + ghToken, [ghToken], null,
]);
const shapeText = buildResultText({ request_id: 'r1' }, 'done', null, tokenShapes);
assert.ok(!shapeText.includes(ghToken.slice(0, 8)), `array/object field leaked a token: ${shapeText}`);
assert.ok(!JSON.stringify(tokenShapes.findings).includes(ghToken.slice(0, 8)), 'sanitized verdict kept a token');
for (const f of tokenShapes.findings) for (const v of Object.values(f)) assert.equal(typeof v, 'string');
assert.match(shapeText, /medium finding: ok/);

// Rendering sanitizes on its own, so an unsanitized verdict handed to buildResultText cannot leak either.
const raw = buildResultText({ request_id: 'r1' }, 'done', null, { status: 'FAIL', detail: 'exit 1', findings: [{ severity: [ghToken], rule: [ghToken], type: [ghToken], text: 'ok' }] });
assert.ok(!raw.includes(ghToken.slice(0, 8)), `render leaked a raw array field: ${raw}`);

// (4) redact-before-clip at the 240 (rendered) and 4000 (stored) limits, for every displayed field.
for (const field of ['text', 'message', 'description', 'suggestion']) {
  for (const [limit, pad] of [[4000, 3990], [240, 235]]) {
    const value = 'x'.repeat(pad) + ' ' + ghToken + ' tail';
    const v = await render([{ rule: 'r', [field]: value }]);
    if (limit === 4000) assert.ok(!v.findings[0][field].includes(ghToken.slice(0, 8)), `${field} stored a token prefix at the 4000 limit`);
    else assert.ok(!buildResultText({ request_id: 'r1' }, 'done', null, { ...v, findings: [{ rule: 'r', [field]: value }] }).includes(ghToken.slice(0, 8)), `${field} leaked a token prefix at the 240 limit`);
  }
}
for (const label of ['rule', 'type']) {
  const v = await render([{ [label]: ghToken }]);
  assert.ok(!buildResultText({ request_id: 'r1' }, 'done', null, v).includes(ghToken.slice(0, 8)), `${label} leaked a token`);
}

// (5) controlled environment: throwaway HOME/TMPDIR (existing while running, removed after), fixed PATH.
const envFile = script('env.mjs', `import fs from 'node:fs';process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({findings:[{text:JSON.stringify({home:process.env.HOME,tmp:process.env.TMPDIR,path:process.env.PATH,keys:Object.keys(process.env).sort(),homeExists:fs.existsSync(process.env.HOME)})}]}));});`);
const hostPath = '/nonexistent-host-dir/bin:' + process.env.PATH;
const ev = await runBuildProseCheck('acme/x', patch, { ...baseEnv, PATH: hostPath, DALAN_ACP_PROSE_CHECK: envFile }, { refusal: allow });
const info = JSON.parse(ev.findings[0].text);
assert.notEqual(info.home, os.homedir());
assert.ok(info.home.startsWith(path.join(os.tmpdir(), 'prose-check-')), `HOME not a throwaway dir: ${info.home}`);
assert.equal(info.tmp, info.home);
assert.equal(info.homeExists, true);
assert.equal(fs.existsSync(info.home), false, 'throwaway HOME not removed');
assert.deepEqual(info.path.split(path.delimiter), [path.dirname(process.execPath), '/usr/bin', '/bin']);
assert.ok(!info.path.includes('nonexistent-host-dir'), 'host PATH inherited');
// macOS adds __CF_USER_TEXT_ENCODING to every process it launches; it is not inherited from the host environment.
const osInjected = process.platform === 'darwin' ? new Set(['__CF_USER_TEXT_ENCODING']) : new Set();
assert.deepEqual(info.keys.filter((k) => !osInjected.has(k)), ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TZ']);

// (6) containment guarantee: a descendant in its own session whose parent is still linked is killed on timeout.
// Documented limit: a descendant orphaned before the kill (parent already exited) is not tracked and may survive.
const dPid = path.join(root, 'detached.pid');
const detached = script('detached.mjs', `import {spawn} from 'node:child_process';import fs from 'node:fs';
const g=spawn('sleep',['300'],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(dPid)},String(g.pid));setInterval(()=>{},1000);`);
const dt = await runBuildProseCheck('acme/x', patch, { ...baseEnv, DALAN_ACP_PROSE_CHECK: detached }, { refusal: allow, timeoutMs: 1500 });
assert.deepEqual(dt, { status: 'ERROR', detail: 'timed out' });
const dp = Number(fs.readFileSync(dPid, 'utf8'));
await new Promise(r => setTimeout(r, 300));
let dAlive = true;
try { process.kill(dp, 0); } catch { dAlive = false; }
if (dAlive) process.kill(dp, 'SIGKILL');
assert.equal(dAlive, false, 'detached grandchild with a live parent survived the timeout');
assert.deepEqual(await runBuildProseCheck('acme/x', patch, { DALAN_ACP_PROSE_CHECK_OWNERS: 'bad owner', DALAN_ACP_PROSE_CHECK: spy }, { refusal: allow }), { status: 'ERROR', detail: 'invalid DALAN_ACP_PROSE_CHECK_OWNERS' });
console.log('acp-prose-check-test: ok');
