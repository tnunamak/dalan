#!/usr/bin/env node
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// Synthetic fixtures are removed on exit; set DALAN_KEEP_TEST_FIXTURES=1 to keep them for debugging.
const home = fs.mkdtempSync(path.join(os.homedir(), '.tmp/dalan-auth-repository-'));
if (process.env.DALAN_KEEP_TEST_FIXTURES === '1') console.log(`Security fixtures retained: ${home}`);
else process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));
process.env.HOME = home;
process.env.DOT_BRIDGE_WORKSPACE_ROOT = path.join(home, 'work');
process.env.DOT_BRIDGE_MIN_FREE_BYTES = '0';
const awaitRedactor = await import('../src/redaction.mjs');
const { Store } = await import('../src/store.mjs');
const { Workspace } = await import('../src/workspace.mjs');
const { prepareT3Audit, initT3Audit, admitT3Audit, appendT3Audit } = await import('../src/t3-audit.mjs');
const repo = path.join(home, 'repo');
fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
fs.mkdirSync(path.join(repo, 'plans'));
const token = 'ghp_' + 'A'.repeat(36), canary = 'SIBLING_CONFIDENTIAL_CANARY';
const key = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
const keyBody = key.split('\n')[1];
const armorBody = 'U1lOVEhFVElDX1BSSVZBVEVfS0VZX0JPRFk=';
const armorLabels = ['PRIVATE KEY', 'RSA PRIVATE KEY', 'DSA PRIVATE KEY', 'EC PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'PGP PRIVATE KEY BLOCK', 'SSH2 PRIVATE KEY', 'SSH2 ENCRYPTED PRIVATE KEY'];
// Assemble markers at runtime so read_file can display the fixture source.
const armorMarker=(kind,label,dashes=5,spaced=false)=>'-'.repeat(dashes)+(spaced?' ':'')+kind+' '+label+(spaced?' ':'')+'-'.repeat(dashes);
const armor=label=>[armorMarker('BEGIN',label,label.startsWith('SSH2')?4:5,label.startsWith('SSH2')),armorBody,armorMarker('END',label,label.startsWith('SSH2')?4:5,label.startsWith('SSH2')),''].join('\n');
const longArmor = [armorMarker('BEGIN','PRIVATE KEY'), ...Array.from({length:30},(_,i)=>`U1lOVEhFVElDQk9EWUxJTkU${String(i).padStart(3,'0')}`), armorMarker('END','PRIVATE KEY')];
const longKey = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ format: 'pem', type: 'pkcs1' });
const git = (...args) => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
git('init', '-q'); git('config', 'user.name', 'Security fixture'); git('config', 'user.email', 'fixture@example.test');
fs.writeFileSync(path.join(repo, 'source.mjs'), `// ${token}\nexport const n = 1;\n`);
fs.writeFileSync(path.join(repo, 'material.mjs'), `before\n${key}after\n`);
fs.writeFileSync(path.join(repo, 'long-material.mjs'), `before\n${longKey}after\n`);
fs.writeFileSync(path.join(repo, 'long-armor.mjs'), longArmor.join('\n')+'\n');
fs.writeFileSync(path.join(repo, 'binary.mjs'), Buffer.from(`before\0${token}\nafter\n`));
fs.writeFileSync(path.join(repo, 'plans/pricing.csv'), canary);
fs.writeFileSync(path.join(repo, 'test/probe.mjs'), 'console.log("IN_SCOPE_OK");\n');
fs.writeFileSync(path.join(repo, '.dot-bridge.json'), JSON.stringify({ checks: { default: {
  argv: ['/runtime/node', 'test/probe.mjs'], timeout_ms: 3000, output_bytes: 65536,
} } }));
git('add', 'source.mjs', 'material.mjs', 'long-material.mjs', 'long-armor.mjs', 'binary.mjs', 'plans/pricing.csv', 'test/probe.mjs', '.dot-bridge.json'); git('commit', '-qm', 'synthetic fixture');
const base = git('rev-parse', 'HEAD');
process.env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE = repo;
const data = path.join(home, '.local/share/dot-bridge');
fs.mkdirSync(data, { recursive: true });
const store = new Store(path.join(data, 'bridge.db'), { allowDefaultHomeMigration: true });
const ws = new Workspace(store, false);
let scopedJob, finishedJob, legacyJob;
function open(extra = {}) {
  const request_id = `req_${randomUUID()}`;
  const payload = { schema_version: 1, request_id, brief: 'synthetic security regression', inputs: [{ github_repo: 'test/fixture', base_sha: base }], expected_output: 'patch', execution_scope: 'implementation', ...extra };
  store.submit(payload, { mode: 'none' }, null, 'owner', false, null, 'normal', null, payload, null, null, 'host');
  const claim = store.claim(request_id, 'fixture', 'fixture-subject', 99).claim_id;
  const { dir } = ws.ensure(request_id, claim, 'fixture-subject');
  return { id: request_id, claim, dir };
}
const patch = 'diff --git a/source.mjs b/source.mjs\n--- a/source.mjs\n+++ b/source.mjs\n@@ -2 +2 @@\n-export const n = 1;\n+export const n = 2;\n';

test('I1: scoped host check cannot copy or print a sibling, even after an authorized test patch', async () => {
  const a = open({ scope_paths: ['test'] });
  scopedJob = a;
  assert.throws(() => ws.read(a.id, a.claim, 'fixture-subject', 'plans/pricing.csv'), /outside scope_paths/);
  assert.match(ws.read(a.id, a.claim, 'fixture-subject', 'test/probe.mjs').text, /IN_SCOPE_OK/);
  const attack = `import fs from 'node:fs'; const s=fs.readFileSync('/workspace/plans/pricing.csv','utf8'); fs.writeFileSync('test/copied.txt',s); console.log(s);`;
  ws.apply(a.id, a.claim, 'fixture-subject', `diff --git a/test/probe.mjs b/test/probe.mjs\n--- a/test/probe.mjs\n+++ b/test/probe.mjs\n@@ -1 +1 @@\n-console.log("IN_SCOPE_OK");\n+${attack}\n`);
  const r = await ws.check(a.id, a.claim, 'fixture-subject', 'default');
  assert.equal(r.status, 'capability_not_available');
  assert.match(r.reason, /scope_paths/);
  assert.equal(fs.existsSync(path.join(a.dir, 'test/copied.txt')), false);
  assert(!JSON.stringify(ws.result(a.id, a.claim, 'fixture-subject')).includes(canary));
});

test('I2: diff display and stored finish evidence redact tokens; owner patch and digest stay intact', () => {
  const a = open({ scope_paths: ['source.mjs'] });
  assert(!ws.read(a.id, a.claim, 'fixture-subject', 'source.mjs').text.includes(token));
  ws.apply(a.id, a.claim, 'fixture-subject', patch);
  const r = ws.result(a.id, a.claim, 'fixture-subject');
  assert(!r.diff_preview.includes(token), 'diff context exposed the token');
  assert.equal(r.diff_preview_applicable, false);
  const snap = ws.snapshot(a.id, a.claim, 'fixture-subject');
  const raw = ws.artifact(snap.patch_artifact.artifact_id, a.id).bytes;
  assert(raw.includes(token), 'owner patch must retain the original context');
  assert.equal(createHash('sha256').update(raw).digest('hex'), r.diff_sha256);
  store.finish(a.id, a.claim, 'completed', 'done', 'report', 'fixture-subject', snap);
  finishedJob = { ...a, artifact: snap.patch_artifact };
  assert(!JSON.stringify(store.get(a.id).report.workspace_evidence).includes(token));
});

test('I3: a diff hunk starting inside a PEM body cannot reveal key lines', () => {
  const a = open();
  const line = `before\n${longKey}after\n`.split('\n').length - 1;
  ws.apply(a.id, a.claim, 'fixture-subject', `diff --git a/long-material.mjs b/long-material.mjs\n--- a/long-material.mjs\n+++ b/long-material.mjs\n@@ -${line} +${line} @@\n-after\n+changed\n`);
  const raw = ws.diff(a.dir, base).patch;
  assert(!raw.includes('-----BEGIN'), 'fixture must put the key header outside the hunk');
  const display = ws.result(a.id, a.claim, 'fixture-subject').diff_preview;
  assert(!display.includes(longKey.trim().split('\n').at(-2)));
  // Simulate an already finished record from the old bridge, before previews
  // were scanned with full context. Its headerless body must not survive get.
  const legacy = ws.snapshot(a.id, a.claim, 'fixture-subject');
  delete legacy.output_redaction_version; delete legacy.diff_preview_applicable;
  legacy.diff_preview = raw;
  store.finish(a.id, a.claim, 'completed', 'legacy report', 'report', 'fixture-subject', legacy);
  store.db.prepare("INSERT INTO check_jobs(id,request_id,claim_id,check_id,diff_sha256,status,started_at,output_preview) VALUES(?,?,?,?,?,'completed',?,?)")
    .run(`check_${randomUUID()}`, a.id, a.claim, 'legacy', 'old-digest', new Date().toISOString(), longKey.trim().split('\n').slice(1, -1).join('\n'));
  legacyJob = a;
});

test('I3: reads remove whole disposable PEM keys before pagination, including CRLF', () => {
  const a = open();
  const variants = [key, key.replaceAll('\n', '\r\n'),
    generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ format: 'pem', type: 'pkcs1' }),
    generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'sec1' }),
    generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase: 'disposable-fixture' })];
  for (const pem of variants) {
    fs.writeFileSync(path.join(a.dir, 'material.mjs'), `before\n${pem}after\n`);
    const body = pem.split(/\r?\n/).find(line => /^[A-Za-z0-9+/=]{20,}$/.test(line));
    const r = ws.read(a.id, a.claim, 'fixture-subject', 'material.mjs');
    assert(!r.text.includes(body), 'private key body remains reconstructable');
    assert.match(r.text, /before/); assert.match(r.text, /after/);
    const afterLine = `before\n${pem}after\n`.split('\n').findIndex(line => line === 'after') + 1;
    assert.match(ws.read(a.id, a.claim, 'fixture-subject', 'material.mjs', afterLine, 1).text, /^after$/);
    assert(!ws.read(a.id, a.claim, 'fixture-subject', 'material.mjs', 3, 200).text.includes(body));
  }
});

for (const label of armorLabels) {
  test(`R2: read_file masks the complete ${label} armor before paging`, () => {
    const a = open(), text = `before\n${armor(label)}after\n`;
    fs.writeFileSync(path.join(a.dir, 'material.mjs'), text);
    const r = ws.read(a.id, a.claim, 'fixture-subject', 'material.mjs');
    assert(!r.text.includes(armorBody), label);
    assert.match(r.text, /before/); assert.match(r.text, /after/);
    assert.equal(r.text.split('\n').length, text.split('\n').length);
    assert(!ws.read(a.id, a.claim, 'fixture-subject', 'material.mjs', 3, 1).text.includes(armorBody));
  });
  test(`R4: unmatched ${label} BEGIN masks to EOF; stray END masks only its line`, () => {
    const a = open();
    for (const marker of [armor(label).split('\n')[0], armor(label).trimEnd().split('\n').at(-1)]) {
      const text = `before\nconst marker = '${marker}';\nexport const visible = 42;\n`;
      fs.writeFileSync(path.join(a.dir, 'material.mjs'), text);
      const r = ws.read(a.id, a.claim, 'fixture-subject', 'material.mjs').text;
      assert.match(r, /before/);
      if(marker.includes('BEGIN')) assert(!r.includes('export const visible = 42;'));
      else assert.match(r, /export const visible = 42;/);
      assert(!r.includes(marker));
      assert.equal(r.split('\n').length, text.split('\n').length);
    }
  });
}

for (const label of armorLabels) {
  const begin=armor(label).split('\n')[0];
  const end=armor(label).trimEnd().split('\n').at(-1);
  const otherLabel=label==='EC PRIVATE KEY'?'RSA PRIVATE KEY':'EC PRIVATE KEY';
  for (const [form,closing] of [
    ['no END',''],
    ['mismatched label',end.replace(label,otherLabel)],
    ['mismatched dashes',label.startsWith('SSH2')?`-----END ${label}-----`:`---- END ${label} ----`],
  ]) test(`R3 N1: ${label} with ${form} masks file pages and check output`,()=>{
    const a=open(),text=`before\n${begin}\n${armorBody}\n${closing?closing+'\n':''}after\n`;
    fs.writeFileSync(path.join(a.dir,'material.mjs'),text);
    const read=ws.read(a.id,a.claim,'fixture-subject','material.mjs');
    assert(!read.text.includes(armorBody),'read_file exposed a malformed armor body');
    assert(!ws.read(a.id,a.claim,'fixture-subject','material.mjs',3,1).text.includes(armorBody),'a body-only page leaked');
    assert.equal(read.text.split('\n').length,text.split('\n').length);
    const artifact=ws.saveArtifact(a.id,a.claim,'check-output',Buffer.from(text));
    const output=ws.artifact(artifact.artifact_id,a.id).bytes.toString();
    assert(!output.includes(armorBody),'check output exposed a malformed armor body');
    assert.match(output,/before/);
    assert(!read.text.includes('after'));assert(!output.includes('after'));
  });
}

test('R4 R2: a real embedded BEGIN fixture masks its body and remaining code',()=>{
  const marker=armorMarker('BEGIN','PRIVATE KEY');
  const text=`const key = '${marker}\n${armorBody}\nexport const visible = 42;\n`;
  assert(text.includes(marker));
  assert(awaitRedactor.privateKeyHeader.test(text),'fixture must contain a real BEGIN marker');
  const output=awaitRedactor.redactSecrets(text).text;
  assert(!output.includes(marker));assert(!output.includes(armorBody));
  assert(!output.includes('export const visible = 42;'));
  assert(output.startsWith("const key = '"));
});

for(const label of ['RSA PRIVATE KEY','PGP PRIVATE KEY BLOCK','SSH2 ENCRYPTED PRIVATE KEY']) {
  const begin=armor(label).split('\n')[0],end=armor(label).trimEnd().split('\n').at(-1);
  for(const [prefixName,prefix] of [['template literal','const key = `'],['key prefix','key: '],['BOM','\uFEFF']]) {
    for(const [form,closing] of [['no END',''],['mismatched label',end.replace(label,'EC PRIVATE KEY')],
      ['mismatched dashes',label.startsWith('SSH2')?`-----END ${label}-----`:`---- END ${label} ----`]]) {
      test(`R4 R1/R2: ${prefixName} ${label} with ${form} masks through EOF`,()=>{
        const a=open(),text=`before\n${prefix}${begin}\n${armorBody}\n${closing?closing+'\n':''}AFTER_MALFORMED_KEY\n`;
        assert(awaitRedactor.privateKeyHeader.test(text),'fixture must contain a real BEGIN marker');
        assert(text.includes(armorBody),'fixture must contain a synthetic body');
        fs.writeFileSync(path.join(a.dir,'material.mjs'),text);
        const read=ws.read(a.id,a.claim,'fixture-subject','material.mjs').text;
        assert(!read.includes(armorBody),'embedded private-key body leaked');
        assert(!read.includes('AFTER_MALFORMED_KEY'),'malformed armor must mask through EOF');
        assert(read.startsWith(`before\n${prefix}`),'non-secret prefix should survive');
        assert.equal(read.split('\n').length,text.split('\n').length);
        assert(!ws.read(a.id,a.claim,'fixture-subject','material.mjs',3,1).text.includes(armorBody));
        const artifact=ws.saveArtifact(a.id,a.claim,'check-output',Buffer.from(text));
        const output=ws.artifact(artifact.artifact_id,a.id).bytes.toString();
        assert(!output.includes(armorBody));assert(!output.includes('AFTER_MALFORMED_KEY'));
      });
    }
  }
}

test('R4 R1: a complete embedded block preserves following source',()=>{
  const text=`const key = '${armor('RSA PRIVATE KEY')}'\nexport const visible = 42;\n`;
  assert(awaitRedactor.privateKeyHeader.test(text));
  const output=awaitRedactor.redactSecrets(text).text;
  assert(!output.includes(armorBody));assert.match(output,/export const visible = 42;/);
});

test('R5: armor is a class across case, dashes, whitespace, labels and incomplete embedded blocks',()=>{
  const cases=[s=>s.toUpperCase(),s=>s.toLowerCase(),s=>Array.from(s,(c,i)=>i%2?c.toLowerCase():c.toUpperCase()).join('')];
  const labels=['RSA PRIVATE KEY','PUBLIC KEY','KEY','PRIVATE','OPENSSH-KEY/V2','PRIVATE MATERIAL','MONKEY'];
  const failures=[];let generated=0;
  for(const [caseIndex,casing] of cases.entries()) for(const dashes of [3,4,5,6,17]) for(const space of ['',' \t ','\u00a0']) {
    for(const label of labels) for(const prefix of ['','key: ','\uFEFFconst key = `']) for(const ending of ['complete','missing','label mismatch','dash mismatch']) {
      const begin='-'.repeat(dashes)+space+casing('BEGIN')+(space||' ')+casing(label.replaceAll(' ',space||' '))+space+'-'.repeat(dashes);
      const endLabel=ending==='label mismatch'?'OTHER PRIVATE MATERIAL':label;
      const endDashes=ending==='dash mismatch'?dashes+1:dashes;
      const end='-'.repeat(endDashes)+space+cases[(caseIndex+1)%cases.length]('END '+endLabel)+space+'-'.repeat(endDashes);
      const text=`before\n${prefix}${begin}\n${armorBody}\n${ending==='missing'?'':end+'\n'}AFTER_ARMOR\n`;
      const variant=JSON.stringify({caseIndex,dashes,space,label,prefix,ending});generated++;
      try {
        assert(text.includes(begin)&&text.includes(armorBody),'fixture must contain armor and a synthetic body');
        const output=awaitRedactor.redactSecrets(text);
        assert(!output.text.includes(armorBody),'key body survived');
        assert(output.text.startsWith(`before\n${prefix}`),'non-secret prefix was lost');
        assert.equal(output.text.includes('AFTER_ARMOR'),ending==='complete','block boundary was wrong');
        assert.equal(output.text.split('\n').length,text.split('\n').length,'line count changed');
        assert(awaitRedactor.privateKeyHeader.test(text),'diff-header detection missed the class');
        assert(awaitRedactor.secretContent.test(text),'admission detection missed the class');
        assert(!JSON.stringify(awaitRedactor.redactOutput({text})).includes(armorBody),'response leaked the body');
        assert.equal(awaitRedactor.redactSecrets(`before\nprefix ${end}\nafter\n`).text,'before\n[redacted secret]\nafter\n','a stray END must mask only its own line');
      } catch(error) {failures.push(`${variant}: ${error.message.split('\n')[0]}`);}
    }
  }
  const beginA=armorMarker('BEGIN','RSA PRIVATE KEY'),beginB=armorMarker('BEGIN','EC PRIVATE KEY');
  const endA=armorMarker('END','RSA PRIVATE KEY'),endB=armorMarker('END','EC PRIVATE KEY');
  for(const [form,ends,closed] of [
    ['nested',`${endB}\n${armorBody}\n${endA}`,true],
    ['overlapping',`${endA}\n${armorBody}\n${endB}`,true],
    ['missing inner END',`${endA}\n${armorBody}`,false],
    ['missing outer END',`${endB}\n${armorBody}`,false],
  ]) {
    generated++;
    const text=`before\n${beginA}\n${beginB}\n${armorBody}\n${ends}\nAFTER_ARMOR\n`;
    try {
      const output=awaitRedactor.redactSecrets(text).text;
      assert(!output.includes(armorBody),'a second BEGIN lost its block mask');
      assert.equal(output.includes('AFTER_ARMOR'),closed,'every unmatched BEGIN must mask to EOF');
      assert.equal(output.split('\n').length,text.split('\n').length);
    } catch(error) {failures.push(`${form}: ${error.message.split('\n')[0]}`);}
  }
  const prose='We begin with a key idea, then end this private discussion.\n--- begin chapter ---\nOrdinary prose.\n--- end chapter ---\n';
  assert.deepEqual(awaitRedactor.redactSecrets(prose),{text:prose,redacted:0});
  console.log(`Armor class table: ${generated} generated variants, ${failures.length} failures`);
  assert.equal(failures.length,0,failures.slice(0,12).join('\n'));
});

test('R5: read_file pages and check output use the general armor class',()=>{
  const a=open();
  for(const [label,dashes,space,prefix,closed] of [
    ['rsa private key',3,'','key: ',true],['PRIVATE',8,' \t ','\uFEFFconst key = `',false],
    ['OpenSSH-Key/v2',11,'\u00a0','',true],['public key',3,'','const key = `',false],
  ]) {
    const begin='-'.repeat(dashes)+space+'begin '+label+space+'-'.repeat(dashes);
    const end='-'.repeat(dashes)+space+'END '+label.toUpperCase()+space+'-'.repeat(dashes);
    const text=`before\n${prefix}${begin}\n${armorBody}\n${closed?end+'\n':''}AFTER_ARMOR\n`;
    fs.writeFileSync(path.join(a.dir,'material.mjs'),text);
    const output=ws.read(a.id,a.claim,'fixture-subject','material.mjs').text;
    assert(!output.includes(armorBody));assert.equal(output.includes('AFTER_ARMOR'),closed);
    assert(!ws.read(a.id,a.claim,'fixture-subject','material.mjs',3,1).text.includes(armorBody));
    const artifact=ws.saveArtifact(a.id,a.claim,'check-output',Buffer.from(text));
    assert(!ws.artifact(artifact.artifact_id,a.id).bytes.toString().includes(armorBody));
  }
});

test('N6/N7: short, simple-label and folded armor is masked before file paging and artifacts',()=>{
  const a=open();
  for(const [begin,end] of [
    [armorMarker('BEGIN','PRIVATE KEY',1),armorMarker('END','PRIVATE KEY',1)],
    [armorMarker('BEGIN','PRIVATE KEY',2),''],
    [armorMarker('BEGIN','KEY'),armorMarker('END','KEY')],
    ['-'.repeat(5)+'BEGIN\nPRIVATE\nKEY'+'-'.repeat(5),armorMarker('END','PRIVATE KEY')],
  ]) {
    const text=`before\nconst key = \`${begin}\n${armorBody}\n${end?end+'\n':''}AFTER_ARMOR\n`;
    fs.writeFileSync(path.join(a.dir,'material.mjs'),text);
    const output=ws.read(a.id,a.claim,'fixture-subject','material.mjs').text;
    assert(!output.includes(armorBody));assert.equal(output.includes('AFTER_ARMOR'),!!end);
    const bodyLine=text.split('\n').indexOf(armorBody)+1;
    assert(!ws.read(a.id,a.claim,'fixture-subject','material.mjs',bodyLine,1).text.includes(armorBody));
    const artifact=ws.saveArtifact(a.id,a.claim,'check-output',Buffer.from(text));
    assert(!ws.artifact(artifact.artifact_id,a.id).bytes.toString().includes(armorBody));
  }
});

test('R2: a mid-body diff excludes BOTH markers and withholds key bodies', () => {
  const a = open();
  const lines = [...longArmor];
  lines[15] = 'U1lOVEhFVElDQ0hBTkdFRExJTkU';
  fs.writeFileSync(path.join(a.dir, 'long-armor.mjs'), lines.join('\n') + '\n');
  const raw = ws.diff(a.dir, base).patch;
  assert(!/BEGIN|END/.test(raw), 'neither armor marker may occur in the hunk');
  assert(raw.includes(lines[14]));
  const result = ws.result(a.id, a.claim, 'fixture-subject');
  assert(!result.diff_preview.includes(lines[14]), 'full-context scan must withhold headerless bodies');
  assert.match(result.diff_preview, /private key material/);
});

test('R2: diff display uses the redacted patch BEFORE truncation', () => {
  const a = open();
  // Isolate display construction from git: a credential crosses the display cutoff.
  const raw = 'x'.repeat(32759) + ' ' + token + '\nsafe tail';
  const originalDiff = ws.diff;
  ws.diff = () => ({patch:raw,sha256:'synthetic',bytes:raw.length,omissions:[],paths:[]});
  try {
    const actual = ws.result(a.id, a.claim, 'fixture-subject').diff_preview;
    assert.equal(actual, awaitRedactor.redactSecrets(raw).text.slice(0,32768));
    assert(!actual.includes('ghp_'), 'raw truncation leaves a token prefix that the final redactor cannot recognize');
  } finally { ws.diff = originalDiff; }
});

test('I2: binary patch displays are withheld rather than exposing encoded secret blobs', () => {
  const a = open({ scope_paths: ['binary.mjs'] });
  assert(!ws.read(a.id, a.claim, 'fixture-subject', 'binary.mjs').text.includes(token));
  fs.appendFileSync(path.join(a.dir, 'binary.mjs'), 'safe change\n');
  const raw = ws.diff(a.dir, base).patch;
  assert.match(raw, /GIT binary patch/);
  fs.writeFileSync(path.join(a.dir, 'binary.mjs'), Buffer.from(`before\0${token}\nafter\n`));
  ws.apply(a.id, a.claim, 'fixture-subject', raw);
  const result = ws.result(a.id, a.claim, 'fixture-subject');
  assert.match(result.diff_preview, /binary diff withheld/); assert(!result.diff_preview.includes('GIT binary patch'));
  const snapshot = ws.snapshot(a.id, a.claim, 'fixture-subject');
  assert.equal(ws.artifact(snapshot.patch_artifact.artifact_id, a.id).bytes.toString(), raw);
});

test('I2/I3: check artifacts use the same whole-block redactor as file and diff displays', () => {
  const a = open();
  const artifact = ws.saveArtifact(a.id, a.claim, 'check-output', Buffer.from(`before\n${token}\n${key}after\n`));
  const text = ws.artifact(artifact.artifact_id, a.id).bytes.toString();
  assert(!text.includes(token)); assert(!text.includes(keyBody));
  assert.match(text, /before/); assert.match(text, /after/);
});

test('I4: both host phases refuse without resource containment, while another job remains readable', async () => {
  const a = open(), other = open();
  for (const network of [false, true]) {
    await assert.rejects(ws.runConfined(a.id, a.dir, ['/runtime/node', '-e', 'require("fs").writeFileSync("started","yes")'], { network, timeout_ms: 1000, output_bytes: 4096 }), /resource_limits_unavailable/);
    assert.equal(fs.existsSync(path.join(a.dir, 'started')), false);
  }
  const r = await ws.check(a.id, a.claim, 'fixture-subject', 'default');
  assert.equal(r.status, 'capability_not_available'); assert.match(r.reason, /resource_limits_unavailable/);
  const skipped=store.db.prepare("SELECT reason FROM lifecycle_events WHERE request_id=? AND type='check_skipped'").all(a.id);
  assert.equal(skipped.length,1,'owners must see refused check attempts');
  assert.match(skipped[0].reason,/resource_limits_unavailable/);
  assert.match(ws.read(other.id, other.claim, 'fixture-subject', 'test/probe.mjs').text, /IN_SCOPE_OK/);
});

test('I6: malformed or insecure sensitive policy refuses before either phase starts', async () => {
  const config = path.join(home, '.config/dot-bridge'); fs.mkdirSync(config, { recursive: true });
  const policy = path.join(config, 'submission-policy.json');
  const a = open(); let starts = 0;
  const original = ws.runConfined;
  ws.runConfined = async () => { starts++; throw new Error('phase started'); };
  try {
    fs.writeFileSync(policy, '{broken', { mode: 0o600 });
    let r = await ws.check(a.id, a.claim, 'fixture-subject', 'default');
    assert.equal(r.status, 'capability_not_available'); assert.match(r.reason, /sensitive_policy_unavailable/); assert.equal(starts, 0);
    for (const network of [false, true]) await assert.rejects(original.call(ws, a.id, a.dir, ['/must-not-run'], { network }), /sensitive_policy_unavailable/);
    fs.writeFileSync(policy, JSON.stringify({ version: 1, sensitive_paths: ['plans/pricing.csv'] })); fs.chmodSync(policy, 0o644);
    r = await ws.check(a.id, a.claim, 'fixture-subject', 'default');
    assert.match(r.reason, /sensitive_policy_unavailable/); assert.equal(starts, 0);
    for (const network of [false, true]) await assert.rejects(original.call(ws, a.id, a.dir, ['/must-not-run'], { network }), /sensitive_policy_unavailable/);
    fs.chmodSync(policy, 0o600);
    r = await ws.check(a.id, a.claim, 'fixture-subject', 'default');
    assert.match(r.reason, /resource_limits_unavailable/); assert.equal(starts, 0);
  } finally { ws.runConfined = original; }
});

test('I5: permitted audit metadata is allowlisted, bounded and redacted', () => {
  const entry = prepareT3Audit('t3_thread_send', { threadId: 'thread_fixture', padding: 'X'.repeat(900000), options: ['x'.repeat(200000)], message: token });
  assert(Buffer.byteLength(entry.args_summary) <= 2048);
  assert(!entry.args_summary.includes('padding')); assert.equal(entry.text_preview, null);
});

test('R2: rolling principal audit budgets survive reopen and recover without deleting history', () => {
  const file = path.join(home, 'audit-budget.db');
  let db = new DatabaseSync(file); initT3Audit(db);
  const now = Date.now(), env = {DOT_BRIDGE_T3_CALLS_PER_MINUTE:'2',DOT_BRIDGE_T3_CALLS_PER_DAY:'3'};
  const add = (subject, at, status='denied: insufficient_scope') => db.prepare(`INSERT INTO t3_audit(at,call_id,subject,tool,args_summary,result_status,worker,budget_version) VALUES(?,?,?,?,?,?,?,1)`).run(new Date(at).toISOString(),randomUUID(),subject,'t3_thread_send','{}',status,'dot');
  add('reader',now); add('reader',now);
  assert.throws(() => admitT3Audit(db,'dot','reader',{now,env}), /t3_rate_limit/);
  assert.doesNotThrow(() => admitT3Audit(db,'dot','full',{now,env}));
  assert.doesNotThrow(() => admitT3Audit(db,'other','reader',{now,env}));
  assert.doesNotThrow(() => admitT3Audit(db,'dot','reader',{now:now+60001,env}));
  add('reader',now-120000);
  db.close(); db=new DatabaseSync(file); initT3Audit(db);
  assert.throws(() => admitT3Audit(db,'dot','reader',{now:now+60001,env}), /t3_rate_limit/);
  assert.doesNotThrow(() => admitT3Audit(db,'dot','reader',{now:now+86400001,env}));
  assert.equal(db.prepare('SELECT count(*) n FROM t3_audit').get().n,3);
  assert.throws(() => db.exec('DELETE FROM t3_audit'), /append-only/);
  db.close();
});

test('R2: migrated unattributed worker rows do not charge a live principal budget', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE t3_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,call_id TEXT NOT NULL,subject TEXT NOT NULL,tool TEXT NOT NULL,args_summary TEXT NOT NULL,text_sha256 TEXT,text_preview TEXT,result_status TEXT NOT NULL,t3_ids TEXT NOT NULL DEFAULT '{}');
    WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n<61)
    INSERT INTO t3_audit(at,call_id,subject,tool,args_summary,result_status) SELECT '${new Date().toISOString()}',n,'reader','t3_thread_send','{}','started' FROM rows;`);
  initT3Audit(db);
  const env={DOT_BRIDGE_T3_CALLS_PER_MINUTE:'1',DOT_BRIDGE_T3_CALLS_PER_DAY:'1'};
  assert.doesNotThrow(()=>admitT3Audit(db,'dot','reader',{env}));
  appendT3Audit(db,prepareT3Audit('t3_thread_list',{},'dot'),'reader','started');
  appendT3Audit(db,prepareT3Audit('t3_thread_list',{},'dot'),'reader','success');
  assert.throws(()=>admitT3Audit(db,'dot','reader',{env}),/t3_rate_limit/);
  assert.equal(db.prepare('SELECT count(*) n FROM t3_audit').get().n,63);
  db.close();
});

test('I5: real MCP denials are bounded and rate-limited per principal before argument audit or T3 execution', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' };
  const jwks = http.createServer((req, res) => res.end(JSON.stringify({ keys: [jwk] })));
  await new Promise(resolve => jwks.listen(0, '127.0.0.1', resolve));
  const issuer = `http://127.0.0.1:${jwks.address().port}`;
  const reservation = http.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const config = path.join(home, '.config/dot-bridge'); fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'oauth.env'), `OAUTH_ISSUER=${issuer}\nOAUTH_AUDIENCE=https://fixture.test\nOAUTH_JWKS_URI=${issuer}/jwks\nOAUTH_ALLOWED_SUBJECTS=fixture-subject,trusted-subject,reader-subject\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(config, 'workers.json'), JSON.stringify({ workers: {
    dot: { connections: [{ issuer, subject: 'fixture-subject', client_id: 'fixture' }], capabilities: [] },
    trusted: { connections: [{ issuer, subject: 'trusted-subject', client_id: 'fixture' }, { issuer, subject: 'reader-subject', client_id: 'fixture' }], capabilities: ['t3'] },
  } }), { mode: 0o600 });
  const stub = path.join(home, 't3code');
  fs.writeFileSync(stub, '#!/usr/bin/env node\nrequire("fs").appendFileSync(process.env.HOME+"/invoked","yes\\n"); console.log(JSON.stringify({ok:true,data:{threads:[]}}));\n', { mode: 0o700 });
  const env = { ...process.env, NODE_ENV: 'test', DOT_BRIDGE_TEST_OAUTH: '1', DALAN_ENABLE_T3_TOOLS: '1', DOT_BRIDGE_AUTH_MODE: 'oauth', DOT_BRIDGE_ENABLE_WORKSPACE: '1', DOT_BRIDGE_PORT: String(port), DOT_BRIDGE_T3CODE_BIN: stub };
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: path.resolve(new URL('..', import.meta.url).pathname), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', b => stderr += b);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server readiness: ${stderr}`)), 10000);
      child.stdout.on('data', b => { if (b.toString().includes('MCP listening')) { clearTimeout(timer); resolve(); } });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${stderr}`)); });
    });
    const secret = fs.readFileSync(path.join(config, 'env'), 'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
    async function call(subject, scope, name, args = {}) {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ iss: issuer, aud: 'https://fixture.test', exp: Math.floor(Date.now()/1000)+300, sub: subject, azp: 'fixture', scope })).toString('base64url');
      const unsigned = `${header}.${payload}`, jwt = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
      const response = await fetch(`http://127.0.0.1:${port}/${secret}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }) });
      assert.equal(response.status, 200); return (await response.json()).result;
    }
    const args = { threadId: 'thread_fixture', padding: 'X'.repeat(900000) };
    const denied = await call('fixture-subject', 'dot-bridge.read', 't3_thread_read', args);
    assert.equal(denied.isError, true); assert.match(denied.content[0].text, /worker_capability_denied/);
    let rows = store.db.prepare('SELECT * FROM t3_audit WHERE subject=?').all('fixture-subject');
    assert.equal(rows.length, 1, 'one denial must produce at most one small row');
    assert(Buffer.byteLength(JSON.stringify(rows)) < 4096); assert(!JSON.stringify(rows).includes('padding'));
    assert.equal(fs.existsSync(path.join(home, 'invoked')), false);
    const scopedArgs = { request_id: scopedJob.id, claim_id: scopedJob.claim };
    assert.equal((await call('fixture-subject', 'dot-bridge.read', 'read_file', { ...scopedArgs, path: 'plans/pricing.csv' })).isError, true);
    const scopedCheck = await call('fixture-subject', 'dot-bridge.work', 'run_check', { ...scopedArgs, check_id: 'default' });
    assert.match(scopedCheck.content[0].text, /scope_paths_read_isolation_unavailable/);
    assert(!JSON.stringify(scopedCheck).includes(canary));
    const finished = await call('fixture-subject', 'dot-bridge.read', 'get', { request_id: finishedJob.id });
    assert.equal(finished.isError, false); assert(!JSON.stringify(finished).includes(token));
    const legacy = await call('fixture-subject', 'dot-bridge.read', 'get', { request_id: legacyJob.id });
    assert.equal(legacy.isError, false);
    assert(!JSON.stringify(legacy).includes(longKey.trim().split('\n').at(-2)), 'legacy diff or check output exposed a headerless PEM body');
    const ownerPatch = await new Promise((resolve, reject) => {
      const request = http.get({ socketPath: path.join(data, 'admin.sock'), path: `/artifact?id=${finishedJob.artifact.artifact_id}`, headers: { 'x-owner-capability': 'owner' } }, response => {
        const bytes = []; response.on('data', b => bytes.push(b)); response.on('end', () => resolve({ status: response.statusCode, bytes: Buffer.concat(bytes) }));
      }); request.on('error', reject);
    });
    assert.equal(ownerPatch.status, 200); assert(ownerPatch.bytes.includes(token));
    assert.equal(createHash('sha256').update(ownerPatch.bytes).digest('hex'), finishedJob.artifact.sha256);
    const insufficient = await call('trusted-subject', 'dot-bridge.read', 'notify_owner', { text: token });
    assert.match(insufficient.content[0].text, /insufficient_scope/);
    const invalid = await call('trusted-subject', 'dot-bridge.read', 't3_thread_read', args);
    assert.equal(invalid.isError, true);
    assert(!JSON.stringify(store.db.prepare('SELECT * FROM t3_audit').all()).includes(token));
    const responses = [];
    for (let i = 0; i < 70; i++) responses.push(await call('fixture-subject', 'dot-bridge.read', 't3_thread_read', { threadId: 'fixture' }));
    assert(responses.some(r => /rate_limit/.test(r.content[0].text)));
    rows = store.db.prepare('SELECT * FROM t3_audit WHERE subject=?').all('fixture-subject');
    assert(rows.length <= 60); assert(Buffer.byteLength(JSON.stringify(rows)) < 65536);
    for(let i=0;i<61;i++) await call('reader-subject','dot-bridge.read','notify_owner',{text:'synthetic denial'});
    // More than 30 successful calls must fit the default 60-CALL budget despite two audit rows per call.
    for(let i=0;i<40;i++) {
      const listed=await call('trusted-subject','dot-bridge.read','t3_thread_list');
      assert.equal(listed.isError,false,JSON.stringify(listed));
    }
    const readerRows=store.db.prepare('SELECT * FROM t3_audit WHERE subject=?').all('reader-subject');
    assert.equal(readerRows.length,60);
    assert(readerRows.every(row=>row.result_status==='denied: insufficient_scope'));
    const allowed = await call('trusted-subject', 'dot-bridge.read', 't3_thread_list');
    assert.equal(allowed.isError, false, JSON.stringify(allowed));
    assert(fs.existsSync(path.join(home, 'invoked')));
    assert.equal((await call('fixture-subject', 'dot-bridge.read', 'list_pending')).isError, false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    await new Promise(resolve => jwks.close(resolve));
  }
});

after(() => store.db.close());
