import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
test('dalan prints help and lists workers without a deprecation notice',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-cli-'));
  try {
    for(const args of [['--help'],['worker','list','--json']]) {
      const run=spawnSync(process.execPath,['bin/dalan.mjs',...args],{env:{...process.env,HOME:home},encoding:'utf8'});
      assert.equal(run.status,0,run.stderr);
      assert.doesNotMatch(run.stderr,/deprecated/);
    }
  } finally {fs.rmSync(home,{recursive:true,force:true});}
});

test('CLI output does not contain the identity provider runtime warning',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-cli-'));
  try {
    const result=spawnSync(process.execPath,['bin/dalan.mjs','worker','list','--json'],{encoding:'utf8',env:{...process.env,HOME:home}});
    assert.equal(result.status,0,result.stderr);
    assert.doesNotMatch(result.stdout+result.stderr,/oidc-provider WARNING: Unsupported runtime/);
  } finally { fs.rmSync(home,{recursive:true,force:true}); }
});

test('dalan version flags print the package version',()=>{
  const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  for(const flag of ['--version','-v']) {
    const run=spawnSync(process.execPath,['bin/dalan.mjs',flag],{encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
    assert.equal(run.stdout.trim(),pkg.version);
    // The installed command runs from any directory, so the version must not depend on the working directory.
    const elsewhere=spawnSync(process.execPath,[path.resolve('bin/dalan.mjs'),flag],{cwd:os.tmpdir(),encoding:'utf8'});
    assert.equal(elsewhere.status,0,elsewhere.stderr);
    assert.equal(elsewhere.stdout.trim(),pkg.version);
  }
});

test('dalan doctor on macOS names no Linux sandbox backend',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-cli-'));
  try {
    // Pretend to be macOS; the host executor's backends exist on Linux only.
    const preload=path.join(home,'darwin.cjs');
    fs.writeFileSync(preload,"Object.defineProperty(process,'platform',{value:'darwin'});\n");
    for(const args of [['doctor'],['doctor','--json']]) {
      const run=spawnSync(process.execPath,['-r',preload,path.resolve('bin/dalan.mjs'),...args],{encoding:'utf8',env:{...process.env,HOME:home}});
      assert.equal(run.status,0,run.stderr);
      assert.match(run.stdout,/unavailable on macOS: host checks are not available; jobs can still be delegated with --execution none \(no host checks\)/);
      assert.doesNotMatch(run.stdout,/linux-bwrap|bwrap-pasta/);
    }
  } finally { fs.rmSync(home,{recursive:true,force:true}); }
});
