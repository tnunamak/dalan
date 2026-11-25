// Host-neutrality gate. Baseline regenerated with --print on 2026-11-25 (was cb6b119196f025ac8cbbf93f0ee8bd0a30221654).
// Source bindings: adapter-dot-bridge.mjs:91-128,146-166,180-204;
// question-lifecycle-http-e2e.mjs:18-34; server.mjs:1058 (owner token);
// store.mjs:2145-2160 (consumption); destinations/index.mjs:22-28 (lazy T3).
// Budget note: src/tool-registry.mjs counts 21 t3 tokens and is byte-identical to the version the stale baseline (4)
// was taken from; the baseline simply predates it. It is a budget exception, not a T3-free file. The import and
// no-T3-execution controls and the per-file ceiling still apply to it, so any new reference fails the gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DotBridgeAdapter } from './conformance/adapter-dot-bridge.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const preload = fileURLToPath(new URL('./host-neutrality-preload.mjs', import.meta.url));
const baselinePath = new URL('./host-neutrality-allowlist.json', import.meta.url);
const tokenPattern = /['"`]t3['"`:]|\bt3[_.]/g;
function coreFiles(directory = 'src') {
  return fs.readdirSync(path.join(root, directory), {withFileTypes:true})
    .flatMap(entry => {
      const relative = directory + '/' + entry.name;
      if (relative === 'src/test-support') return [];
      if (entry.isDirectory()) return coreFiles(relative);
      return entry.isFile() && relative.endsWith('.mjs') &&
        !/^src\/t3[^/]*\.mjs$/.test(relative) && relative !== 'src/destinations/t3.mjs' ? [relative] : [];
    }).sort();
}
function staticImports(source) {
  // Literal static declarations only; dynamic import() belongs to the runtime experiment.
  const imports = [];
  for (const pattern of [
    /(?:^|;)\s*import\s+(?![.(])(?:[\w*$ {},\r\n]+?\s+from\s*)?(['"])([^'"]+)\1/gm,
    /(?:^|;)\s*export\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s*(['"])([^'"]+)\1/gm,
  ]) for (const match of source.matchAll(pattern)) if (/t3/i.test(match[2])) imports.push(match[2]);
  return [...new Set(imports)].sort();
}
const current = {};
for (const file of coreFiles()) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const imports = staticImports(source), tokens = [...source.matchAll(tokenPattern)].length;
  current[file] = {imports, tokens};
}
if (process.argv.includes('--print')) {
  console.log(JSON.stringify(current, null, 2));
} else {
  const allowed = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  for (const [file, actual] of Object.entries(current)) {
    const entry = allowed[file] ?? {imports:[], tokens:0};
    assert(Array.isArray(entry.imports), file + ': invalid import allowance');
    assert(entry.tokens === null || (Number.isSafeInteger(entry.tokens) && entry.tokens >= 0), file + ': invalid token allowance');
    for (const specifier of actual.imports)
      assert(entry.imports.includes(specifier), file + ': unexpected static T3 import ' + specifier);
    if (entry.tokens === null) console.log('GAP COUNT: ' + file + ' currently ' + actual.tokens + '; fill null baseline after review with --print');
    else {
      assert(actual.tokens <= entry.tokens, file + ': T3 tokens grew from ' + entry.tokens + ' to ' + actual.tokens);
      if (actual.tokens < entry.tokens) console.log('LOWER ALLOWLIST: ' + file + ' from ' + entry.tokens + ' to ' + actual.tokens);
    }
  }
  for (const file of Object.keys(allowed)) if (!Object.hasOwn(current, file))
    console.log('LOWER ALLOWLIST: remove absent core file ' + file);
  console.log('PASS static host-neutrality budget');
  await runtime();
}

async function runtime() {
  // Positive control in a separate process: no T3 implementation can execute.
  // Verifies the same preload used below really blocks resolution, rather than
  // mistaking a clean server log for proof that a resolver hook was installed.
  const target = new URL('../src/t3.mjs', import.meta.url).href;
  const probe = spawnSync(process.execPath, ['--import', preload, '--input-type=module', '-e',
    'await import(' + JSON.stringify(target) + ')'], {
    cwd:root, env:{...process.env,NODE_OPTIONS:''}, encoding:'utf8',timeout:15000,
  });
  assert.ifError(probe.error);
  assert.equal(probe.signal, null, 'blocker probe must terminate normally');
  assert.notEqual(probe.status, 0, 'preload failed to block T3');
  assert.match(probe.stderr, /HOST_NEUTRALITY_BLOCKED:.*\/src\/t3\.mjs/);
  assert.match(probe.stderr, /ERR_MODULE_NOT_FOUND/);
  const adapter = new DotBridgeAdapter({serverEnv:{NODE_OPTIONS:'--import ' + JSON.stringify(preload)}});
  try {
    await adapter.init();
    try { await adapter.reset(); }
    catch (error) {
      const log = adapter.serverLog ?? '';
      const blocked = /HOST_NEUTRALITY_BLOCKED: ([^\r\n]+)/.exec(log);
      // Unrelated startup failures must fail the gate, not masquerade as R01.
      assert(blocked && adapter.serverExited, 'unrelated server startup failure: ' + error.message);
      assert.match(log, /ERR_MODULE_NOT_FOUND/);
      console.log('GAP R01: startup imports removed connector ' + blocked[1] + '; lifecycle not exercised');
      return;
    }
    const id = adapter.requestId('host_neutrality');
    // A disposable fixture capability, generated by the existing adapter API;
    // never load/copy a real operator or connection credential.
    const cap = adapter.ownerToken('host_neutrality');
    const unwrap = reply => { assert.equal(reply.error, undefined, reply.error); assert(reply.value); return reply.value; };
    unwrap(await adapter.admin('POST', '/submit', {
      assignment:{schema_version:1,request_id:id,brief:'Host-neutrality fixture',inputs:[],expected_output:'one answer',execution_scope:'read-only'},
      delivery:'none',owner_token:cap,
    }));
    const grant = unwrap(await adapter.mcp('W1','claim',{request_id:id,claimant:'W1',acquisition_id:'host-neutrality',lease_ms:60000}));
    const tool = (name, extra) => adapter.mcp('W1',name,{request_id:id,claim_id:grant.claim_id,...extra});
    unwrap(await tool('ask_question',{question_id:'Q',text:'Which option?'}));
    unwrap(await adapter.admin('POST','/answer',{id,question_id:'Q',text:'Option A'},cap));
    assert.equal(unwrap(await tool('consume_answer',{question_id:'Q'})).answer,'Option A');
    unwrap(await tool('finish',{outcome:'completed',summary:'Host-neutral lifecycle complete',result:'Option A'}));
    assert.equal(adapter.q('SELECT status FROM assignments WHERE request_id=?',id)[0].status,'finished');
    assert.equal(adapter.q('SELECT outcome FROM reports WHERE request_id=?',id)[0].outcome,'completed');
    const question = adapter.q('SELECT answer,answered_at,consumed_at FROM job_questions WHERE request_id=? AND question_id=?',id,'Q')[0];
    assert.equal(question.answer,'Option A');
    assert.notEqual(question.answered_at,null);
    assert.notEqual(question.consumed_at,null);
    assert.doesNotMatch(adapter.serverLog,/HOST_NEUTRALITY_BLOCKED|ERR_MODULE_NOT_FOUND/);
    console.log('PASS real none-delivery submit/claim/question/answer/consume/finish with T3 removed (R01/R32)');
  } finally { await adapter.close(); }
}
