#!/usr/bin/env node
// Check metadata: prerequisites, readiness_argv and test links per ecosystem, and the regression-test rule.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectCheck, availableChecks } from '../src/projects.mjs';
import { regressionTestRule, isTestScopePath, probePrerequisites, versionAtLeast } from '../src/check-readiness.mjs';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-check-metadata-'));
process.env.DOT_BRIDGE_CHECKS_FILE=path.join(home,'none.json');
function fixture(files) { const dir=fs.mkdtempSync(path.join(home,'repo-'));for(const [f,t] of Object.entries(files)) fs.writeFileSync(path.join(dir,f),typeof t==='string'?t:JSON.stringify(t));return dir; }
const detect=files=>detectCheck('o/r',fixture(files));
try {
  // npm: node runtime from engines, lockfile when npm ci is used, test paths from the script.
  let c=detect({'package.json':{scripts:{test:'node --test test/ scripts/a-e2e.mjs'},engines:{node:'>=22.5'}},'package-lock.json':'{}'});
  assert.deepEqual(c.prerequisites,{binaries:[],lockfile:'package-lock.json',runtime:'node>=22.5'});
  assert.deepEqual(c.test_paths,['test','scripts/a-e2e.mjs']);assert.equal(c.test_paths_reason,null);assert.equal(c.readiness_argv,null);
  c=detect({'package.json':{scripts:{test:'jest'}}});
  assert.deepEqual(c.prerequisites,{binaries:[],lockfile:null,runtime:null});
  assert.equal(c.test_paths,null);assert.match(c.test_paths_reason,/names no files or directories/);
  c=detect({'package.json':{scripts:{test:'vitest run --config ../x.js https://x.test/y.js'}}});assert.equal(c.test_paths,null,'flags values, parent paths and URLs are not test paths');
  // pnpm and yarn: manager binary plus its lockfile.
  c=detect({'package.json':{scripts:{test:'vitest'}},'pnpm-lock.yaml':''});assert.deepEqual(c.prerequisites,{binaries:['pnpm'],lockfile:'pnpm-lock.yaml',runtime:null});
  c=detect({'package.json':{scripts:{test:'jest'}},'yarn.lock':''});assert.deepEqual(c.prerequisites,{binaries:['yarn'],lockfile:'yarn.lock',runtime:null});
  // pytest: testpaths from pytest.ini or pyproject; unknown otherwise.
  c=detect({'pytest.ini':'[pytest]\ntestpaths = tests unit\n'});assert.deepEqual(c.prerequisites.binaries,['uv']);assert.deepEqual(c.test_paths,['tests','unit']);
  c=detect({'pyproject.toml':'[tool.pytest.ini_options]\ntestpaths = ["tests", "integration"]\n'});assert.deepEqual(c.test_paths,['tests','integration']);
  c=detect({'pyproject.toml':'[project]\nname="x"\n'});assert.equal(c.test_paths,null);assert.match(c.test_paths_reason,/no pytest testpaths/);
  // cargo, go, make.
  c=detect({'Cargo.toml':''});assert.deepEqual(c.prerequisites,{binaries:['cargo'],lockfile:null,runtime:null});assert.deepEqual(c.test_paths,['tests']);
  c=detect({'go.mod':'module x\n'});assert.deepEqual(c.prerequisites.binaries,['go']);assert.deepEqual(c.test_paths,['./...']);
  c=detect({Makefile:'test:\n\ttrue\n'});assert.deepEqual(c.prerequisites.binaries,['make']);assert.equal(c.test_paths,null);assert.match(c.test_paths_reason,/Makefile/);
  // Overrides: declared metadata is kept; undeclared stays unknown with a reason, never an empty list.
  c=detect({'.dot-bridge.json':{checks:{default:{argv:['make','ci'],prerequisites:{binaries:['make'],lockfile:true,runtime:'python>=3.11'},readiness_argv:['make','-n','ci'],test_paths:['./spec/','t']}}}});
  assert.deepEqual(c.prerequisites,{binaries:['make'],lockfile:true,runtime:'python>=3.11'});assert.deepEqual(c.readiness_argv,['make','-n','ci']);assert.deepEqual(c.test_paths,['spec','t']);
  c=detect({'.dot-bridge.json':{checks:{default:{argv:['true']}}}});
  assert.equal(c.prerequisites,null);assert.equal(c.prerequisites_reason,'not declared');assert.equal(c.test_paths,null);assert.equal(c.test_paths_reason,'not declared');
  c=detect({'.dot-bridge.json':{checks:{default:{argv:['true'],prerequisites:{}}}}});assert.equal(c.prerequisites,null,'an empty declaration is unknown');
  for(const bad of [{prerequisites:'x'},{prerequisites:{binaries:['a/b']}},{prerequisites:{binaries:'sh'}},{prerequisites:{lockfile:'../x'}},{prerequisites:{runtime:'node'}},{readiness_argv:[]},{readiness_argv:'x'},{test_paths:[]},{test_paths:['/abs']},{test_paths:['a/../b']},{test_paths:['not/in/argv.test.mjs']}])
    assert.throws(()=>availableChecks('o/r',fixture({'.dot-bridge.json':{checks:{default:{argv:['true'],...bad}}}})),/invalid/,JSON.stringify(bad));

  // Regression-test rule: positives (refused).
  const impl=(expected_output,scope_paths)=>({execution_scope:'implementation',expected_output,scope_paths});
  for(const text of ['A patch with a regression test','Add regression tests.','patch + Regression-Test','Write a failing regression test first, then fix'])
    assert.match(regressionTestRule(impl(text,['src/a.js'])),/^regression_test_scope: /,text);
  assert.match(regressionTestRule(impl('regression test',['src/a.js','docs']),['tests']),/linked test paths: tests/);
  // Negatives (allowed): no ask, negated ask, other scope, a test path in scope.
  assert.equal(regressionTestRule(impl('A patch',['src/a.js'])),null);
  assert.equal(regressionTestRule(impl('a patch, do not add a regression test',['src/a.js'])),null);
  assert.equal(regressionTestRule(impl('without a regression test',['src/a.js'])),null);
  assert.equal(regressionTestRule({execution_scope:'read-only',expected_output:'regression test',scope_paths:['src/a.js']}),null);
  for(const p of ['test','tests/x.py','pkg/__tests__','spec/a.rb','src/a.test.ts','src/a.spec.js','pkg/a_test.go','pkg/test_a.py','scripts/x-test.mjs','scripts/x-e2e.mjs','./tests/'])
    assert.equal(regressionTestRule(impl('a regression test',['src/a.js',p])),null,p);
  for(const p of ['src/a.js','scripts/build.mjs','latest.js','docs/testing.md','src/contest/a.js']) assert.equal(isTestScopePath(p),false,p);
  // Linked paths: equal, inside, or an ancestor of the linked path; './...' (Go) admits any directory, never a plain source file.
  assert.equal(isTestScopePath('checks/unit/a.py',['checks/unit']),true);
  assert.equal(isTestScopePath('checks',['checks/unit']),true);
  assert.equal(isTestScopePath('.',['checks/unit']),true);
  assert.equal(isTestScopePath('src/a.go',['./...']),false);
  assert.equal(isTestScopePath('internal/foo',['./...']),true);
  assert.equal(isTestScopePath('internal/foo',null),false);
  assert.equal(regressionTestRule(impl('a regression test',['internal/foo/bar.go','internal/foo']),['./...']),null);
  // Colocated tests found in the tree at base_sha admit their directory; conventions match anywhere in a path.
  const tree=['cmd/app/main.go','internal/foo/bar.go','internal/foo/bar_test.go','internal/baz/baz.go','src/a.js','src/a.test.js','py/pkg/mod.py','py/pkg/mod_test.py','lib/x.spec.ts'];
  assert.equal(regressionTestRule(impl('a regression test',['internal/foo/bar.go','internal/foo']),null,tree),null,'go colocated');
  assert.equal(regressionTestRule(impl('a regression test',['src/a.js','src']),null,()=>tree),null,'js colocated, lazy tree');
  assert.equal(regressionTestRule(impl('a regression test',['py/pkg']),null,tree),null,'py *_test.py colocated');
  assert.equal(regressionTestRule(impl('a regression test',['lib']),null,tree),null,'*.spec.* colocated');
  assert.match(regressionTestRule(impl('a regression test',['internal/baz/baz.go','internal/baz']),null,tree),/^regression_test_scope/,'directory without tests');
  assert.match(regressionTestRule(impl('a regression test',['internal/foo/bar.go']),null,tree),/^regression_test_scope/,'a source file alone');
  for(const p of ['pkg/x_test.go','a/b/c.test.mjs','deep/x.spec.js','m/test_a.py','m/a_test.py','x/test/y.js','x/tests/y.js','x/__tests__/y.js','x/spec/y.rb']) assert.equal(isTestScopePath(p),true,p);
  assert.equal(isTestScopePath('src/a.go',null),false);

  // Probe against injected host facts.
  const bin=fs.mkdtempSync(path.join(home,'bin-'));fs.writeFileSync(path.join(bin,'tool'),'#!/bin/sh\n',{mode:0o755});fs.writeFileSync(path.join(bin,'plain'),'x',{mode:0o644});
  const spec=prerequisites=>({id:'default',prerequisites,prerequisites_reason:'not declared',readiness_argv:null});
  const probe=(prerequisites,extra={})=>probePrerequisites(spec(prerequisites),{mirror:home,sha:'a'.repeat(40),binDirs:[bin],nodeVersion:'24.1.0',...extra});
  assert.deepEqual(probe({binaries:['tool'],lockfile:null,runtime:'node>=24'}).unmet,[]);
  assert.match(probe({binaries:['tool','absent','plain'],lockfile:null,runtime:null}).unmet.join('|'),/binary absent not found.*\|binary plain not found/);
  assert.match(probe({binaries:null,lockfile:null,runtime:'node>=25'}).unmet[0],/node 24\.1\.0 is older than required >=25/);
  assert.deepEqual(probe({binaries:null,lockfile:null,runtime:'node>=24.1'}).unmet,[]);
  assert.equal(probe({binaries:null,lockfile:null,runtime:'python>=3.11'}).skipped[0].what,'runtime python>=3.11');
  assert.deepEqual(probe(null).skipped,[{what:'prerequisites of default',reason:'not declared'}]);
  assert.match(probe({binaries:null,lockfile:'x.lock',runtime:null}).unmet[0],/lockfile x\.lock missing/);
  assert.equal(versionAtLeast('24.0.0','24'),true);assert.equal(versionAtLeast('23.9','24'),false);assert.equal(versionAtLeast('24.10.0','24.9'),true);
  console.log('check-metadata-test: PASS');
} finally { fs.rmSync(home,{recursive:true,force:true}); }
