#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-host-check-policy-'));
process.env.HOME = home;
const config = path.join(home, '.config/dot-bridge');
fs.mkdirSync(config, { recursive: true });
const policy = path.join(config, 'host-check-allowlist.json');
const ownerFile = path.join(config, 'checks.json');
const { readHostCheckAllowlist, hostCheckPairAllowed } = await import('../src/host-check-allowlist.mjs');
const { hostCheckAuthorization } = await import('../src/host-execution-policy.mjs');
const { ownerCheck, detectCheckWithOrigin } = await import('../src/projects.mjs');
const writePolicy = (value, options = {}) => fs.writeFileSync(policy, typeof value === 'string' ? value : JSON.stringify(value), { mode: options.mode ?? 0o600 });
const ownerSpec = { argv: ['/runtime/node', '-e', 'console.log("OWNER")'], host_budget: { cpu_ms: 1000, wall_ms: 5000, memory_bytes: 134217728, processes: 16, disk_write_bytes: 1048576, output_bytes: 4096 } };

try {
  assert.equal(readHostCheckAllowlist(), null, 'missing policy denies');
  writePolicy({ version: 1, checks: [] });
  assert.equal(hostCheckPairAllowed('example-owner/sample-repo', 'host-disk'), false, 'empty policy denies all');
  for (const malformed of [
    '{',
    JSON.stringify({ version: 2, checks: [] }),
    JSON.stringify({ version: 1, checks: [], extra: true }),
    JSON.stringify({ version: 1, checks: [{ repo: '*', check_id: '*' }] }),
    JSON.stringify({ version: 1, checks: [{ repo: 'example-owner/sample-repo', check_id: 'host-disk', extra: 1 }] }),
    JSON.stringify({ version: 1, checks: [{ repo: 'example-owner/sample-repo', check_id: 'host-disk' }, { repo: 'example-owner/sample-repo', check_id: 'host-disk' }] }),
  ]) {
    writePolicy(malformed);
    assert.equal(readHostCheckAllowlist(), null, `malformed closed policy denied: ${malformed}`);
  }
  writePolicy({ version: 1, checks: [] }); fs.chmodSync(policy, 0o644);
  assert.equal(readHostCheckAllowlist(), null, 'wrong mode denies');
  fs.unlinkSync(policy);
  fs.writeFileSync(path.join(config, 'policy-target'), JSON.stringify({ version: 1, checks: [] }), { mode: 0o600 });
  fs.symlinkSync(path.join(config, 'policy-target'), policy);
  assert.equal(readHostCheckAllowlist(), null, 'symlink denies');
  fs.unlinkSync(policy); fs.unlinkSync(path.join(config, 'policy-target'));

  const selectedPairs = [
    ['example-owner/sample-repo', 'host-disk'],
    ['example-owner/sample-repo', 'docs-consistency'],
    ['example-owner/sample-repo', 'check-alpha'],
    ['example-owner/sample-repo', 'check-beta'],
    ['example-owner/sample-repo', 'check-gamma'],
    ['example-owner/sample-repo', 'v1'],
    ['example-owner/sample-config', 'check-delta'],
  ].map(([repo, check_id]) => ({ repo, check_id }));
  writePolicy({ version: 1, checks: selectedPairs });
  const selected = readHostCheckAllowlist();
  assert.equal(selected.size, 7);
  assert.equal(selected.size, selectedPairs.length);
  for (const { repo, check_id } of selectedPairs) assert.equal(selected.has(`${repo}\0${check_id}`), true, `named example pair is exact: ${repo}/${check_id}`);

  writePolicy({ version: 1, checks: [{ repo: 'example-owner/sample-repo', check_id: 'host-disk' }, { repo: 'example-owner/sample-repo', check_id: 'check-gamma/v1' }, { repo: 'example-owner/sample-config', check_id: 'host-disk' }] });
  assert.equal(readHostCheckAllowlist(policy, process.getuid() + 1), null, 'a policy owned by a different service UID denies');
  assert.equal(hostCheckPairAllowed('example-owner/sample-repo', 'host-disk'), true, 'exact repo/check pair allows');
  assert.equal(hostCheckPairAllowed('example-owner/sample-repo', 'check-gamma/v1'), true, 'slash-form exact check IDs are valid');
  assert.equal(hostCheckPairAllowed('Example-owner/sample-repo', 'host-disk'), false, 'repo spelling is exact and matches owner resolution');
  assert.equal(hostCheckPairAllowed('example-owner/sample-repo', 'docs-consistency'), false, 'another check stays denied');
  assert.equal(hostCheckPairAllowed('example-owner/other', 'host-disk'), false, 'another repo stays denied');

  fs.writeFileSync(ownerFile, JSON.stringify({ 'example-owner/sample-repo': { checks: { 'host-disk': ownerSpec } } }), { mode: 0o600 });
  assert.deepEqual(ownerCheck('example-owner/sample-repo', 'host-disk'), { ...ownerSpec, id: 'host-disk', install_argv: null, timeout_ms: 120000, output_bytes: 262144, prerequisites: null, prerequisites_reason: 'not declared', readiness_argv: null, test_paths: null, test_paths_reason: 'not declared' });
  assert.equal(hostCheckAuthorization('example-owner/sample-repo', 'host-disk').refusal, undefined, 'owner spec and owner budget authorize the selected pair');
  assert.match(hostCheckAuthorization('example-owner/sample-repo', 'docs-consistency').refusal, /not_allowlisted/);
  assert.match(hostCheckAuthorization('example-owner/other', 'host-disk').refusal, /not_allowlisted/);
  assert.match(hostCheckAuthorization('example-owner/sample-repo', 'host-disk', { ...ownerCheck('example-owner/sample-repo', 'host-disk'), argv: ['/runtime/node', '-e', 'worker'] }).refusal, /definition_changed/);
  assert.match(hostCheckAuthorization('example-owner/sample-repo', 'host-disk', { ...ownerCheck('example-owner/sample-repo', 'host-disk'), host_budget: { ...ownerSpec.host_budget, cpu_ms: 999999 } }).refusal, /definition_changed/);

  const repo = fs.mkdtempSync(path.join(home, 'candidate-'));
  fs.writeFileSync(path.join(repo, '.dot-bridge.json'), JSON.stringify({ checks: { 'host-disk': { argv: ['/runtime/node', '-e', 'console.log("WORKER")'], host_budget: ownerSpec.host_budget } } }));
  assert.equal(detectCheckWithOrigin('example-owner/sample-repo', repo, 'host-disk').from, 'owner_config', 'repo metadata cannot impersonate owner definition');
  assert.equal(detectCheckWithOrigin('example-owner/sample-config', repo, 'host-disk').from, 'workspace_file', 'repo metadata remains discovery only for a different repository');
  assert.match(hostCheckAuthorization('example-owner/sample-config', 'host-disk').refusal, /owner_definition_required/, 'candidate definition cannot acquire host authority');
  const { Workspace } = await import('../src/workspace.mjs');
  const assignment = { execution_scope: 'implementation', inputs: [{ github_repo: 'example-owner/sample-config', base_sha: '0'.repeat(40) }] };
  const none = Workspace.prototype.availableChecksResponse.call({ availableChecksFor: () => ['host-disk'] }, assignment, repo, 'none');
  const worker = Workspace.prototype.availableChecksResponse.call({ availableChecksFor: () => ['host-disk'] }, assignment, repo, 'worker');
  assert.deepEqual(none.available_checks, ['host-disk'], 'none mode preserves declared metadata without host runnable claims');
  assert.deepEqual(worker.available_checks, ['host-disk'], 'worker mode preserves declared metadata without host runnable claims');
  assert.equal(Object.hasOwn(none, 'host_execution_available'), false);
  assert.equal(Object.hasOwn(worker, 'host_execution_available'), false);

  fs.writeFileSync(ownerFile, JSON.stringify({ 'example-owner/sample-repo': { checks: { 'host-disk': { ...ownerSpec, host_budget: undefined } } } }), { mode: 0o600 });
  assert.match(hostCheckAuthorization('example-owner/sample-repo', 'host-disk').refusal, /owner_definition_required|host_budget_missing/);
  writePolicy({ version: 1, checks: [] });
  const moduleUrl = new URL('../src/host-check-allowlist.mjs', import.meta.url).href;
  const restarted = spawnSync(process.execPath, ['--input-type=module', '-e', `import {hostCheckPairAllowed} from ${JSON.stringify(moduleUrl)};if(hostCheckPairAllowed('example-owner/sample-repo','host-disk'))process.exit(9)`], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(restarted.status, 0, restarted.stderr || 'fresh process must load the empty owner policy');
  console.log('PASS host-check-allowlist: closed owner policy, exact pair, current owner definition and owner budget');
} finally { fs.rmSync(home, { recursive: true, force: true }); }
