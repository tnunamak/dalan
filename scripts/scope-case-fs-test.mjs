// On a case-insensitive filesystem (macOS APFS by default), the filesystem opens an excluded file through Unicode
// spellings that a lowercase compare does not catch: the long s U+017F ("id_rſa" opens "id_rsa"), the Kelvin sign
// U+212A, upper case and decomposed (NFD) accents. read_file must refuse every such spelling. On a case-sensitive
// filesystem none of these names open the excluded file, so the file skips.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-case-fs-'));
const repo = path.join(home, 'repo');
fs.mkdirSync(path.join(repo, 'keys'), { recursive: true });
fs.writeFileSync(path.join(repo, 'keys/id_rsa'), 'PRIVATE\n');
if (!fs.existsSync(path.join(repo, 'keys/ID_RSA'))) {
  fs.rmSync(home, { recursive: true, force: true });
  console.log(`SKIP case-insensitive filesystem journey: ${process.argv[1]} (the temporary directory is on a case-sensitive filesystem)`);
  process.exit(77);
}
process.env.HOME = home;
process.env.DALAN_WORKSPACE_ROOT = path.join(home, 'work');
const { Store } = await import('../src/store.mjs');
const { Workspace } = await import('../src/workspace.mjs');
const run = (cmd, args) => { const x = spawnSync(cmd, args, { cwd: repo, encoding: 'utf8' }); if (x.status !== 0) throw new Error(x.stderr || x.stdout); return x.stdout.trim(); };
try {
  const cafe = 'keys/café.txt'.normalize('NFC');
  fs.writeFileSync(path.join(repo, 'keys/kube.txt'), 'KUBE\n');
  fs.writeFileSync(path.join(repo, cafe), 'CAFE\n');
  fs.writeFileSync(path.join(repo, 'keys/public.txt'), 'ok\n');
  run('git', ['init', '-q']); run('git', ['config', 'user.email', 'test@example.com']); run('git', ['config', 'user.name', 'Test']);
  run('git', ['add', '.']); run('git', ['commit', '-qm', 'base']);
  process.env.DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE = repo;
  const store = new Store(path.join(home, 'db.sqlite')), ws = new Workspace(store), id = `req_${randomUUID()}`;
  store.submit({ schema_version: 1, request_id: id, brief: 'fixture', inputs: [{ github_repo: 'example-owner/fixture', base_sha: run('git', ['rev-parse', 'HEAD']) }],
    expected_output: 'findings', execution_scope: 'read-only', scope_paths: ['keys'],
    scope_excluded: ['keys/id_rsa', 'keys/kube.txt', cafe].map(p => ({ path: p, reason: 'test' })) }, 'thread', 'environment', 'owner');
  const claim = store.claim(id, 'dot', 'subject', 10).claim_id;
  assert.equal(ws.read(id, claim, 'subject', 'keys/public.txt').text, 'ok\n');
  const aliases = ['keys/id_rsa', 'keys/ID_RSA', 'keys/id_rſa', 'keys/ID_RſA', 'keys/Kube.txt', 'keys/KUBE.TXT', cafe.normalize('NFD'), 'keys/CAFÉ.TXT'.normalize('NFD')];
  for (const alias of aliases) {
    assert.ok(fs.existsSync(path.join(repo, alias)), `the filesystem should open ${JSON.stringify(alias)}`);
    assert.throws(() => ws.read(id, claim, 'subject', alias), /outside scope_paths/, `served an excluded file as ${JSON.stringify(alias)}`);
  }
  console.log(`PASS on a case-insensitive filesystem, ${aliases.length} Unicode spellings of excluded files are refused`);
} finally { fs.rmSync(home, { recursive: true, force: true }); }
