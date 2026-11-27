import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkParents, npmCliPath, prepareNodeModules, resolvePreparedNodeModules } from '../src/prepared-node-modules.mjs';

// The cache refuses any group- or world-writable ancestor, including a sticky /tmp, so the fixture root must sit under a HOME whose
// whole ancestor chain is safe. Each case below still gets its own private HOME. Without such a HOME this host cannot run the test.
try { checkParents(fs.realpathSync(os.homedir())); }
catch { console.log(`SKIP prepared-node-modules-test: ${os.homedir()} or an ancestor is group- or world-writable; run with a HOME whose ancestors are not`); process.exit(77); }
const root = fs.mkdtempSync(path.join(os.homedir(), 'prepared-test-'));
const privateDir = dir => { fs.mkdirSync(dir, {mode:0o700}); fs.chmodSync(dir,0o700); return dir; };
const fixtureEnv = home => ({...process.env, HOME:home, XDG_CACHE_HOME:path.join(home,'.cache'), npm_config_cache:path.join(home,'.npm-cache')});
const src = path.join(root, 'source'), cache = path.join(root, 'cache');
fs.mkdirSync(src);
const testHome = privateDir(path.join(root,'fixture-home'));
const options = { cacheDir: cache, env: fixtureEnv(testHome) };
const marker = path.join(root, 'lifecycle-marker');
const manifest = { name:'fixture', version:'1.0.0', scripts:{ install:`node -e "require('fs').writeFileSync('${marker}','bad')"` } };
const lock = { name:'fixture', version:'1.0.0', lockfileVersion:3, packages:{ '':{ name:'fixture', version:'1.0.0', hasInstallScript:true } } };
const write = (file, data) => fs.writeFileSync(path.join(src,file), JSON.stringify(data));
try {
  assert.equal(resolvePreparedNodeModules(src, options), null);
  write('package.json', manifest); write('package-lock.json', lock);
  assert.throws(()=>resolvePreparedNodeModules(src, options), {code:'dependencies_unprepared', message:/\(missing\)/});
  const cliHome=privateDir(path.join(root,'cli-home'));
  const unsafeCliHome=privateDir(path.join(root,'unsafe-cli-home'));
  fs.chmodSync(unsafeCliHome,0o770);
  const runCli = home => spawnSync(process.execPath,[path.resolve('bin/dot-worker.mjs'),'prepare-deps',src,'--json'],{env:{...fixtureEnv(home),npm_config_ignore_scripts:'false'},encoding:'utf8'});
  const unsafeCli = runCli(unsafeCliHome);
  assert.notEqual(unsafeCli.status,0);
  assert.match(unsafeCli.stderr + unsafeCli.stdout,/unsafe cache parent/);
  assert.equal(fs.statSync(unsafeCliHome).mode&0o777,0o770);
  const sharedParents=[path.join(cliHome,'.local'),path.join(cliHome,'.local','share')];
  fs.mkdirSync(sharedParents[1],{recursive:true});for(const dir of sharedParents)fs.chmodSync(dir,0o775);
  const cli=runCli(cliHome);
  assert.equal(cli.status,0,cli.stderr); assert.equal(JSON.parse(cli.stdout).lock_sha256.length,64);
  assert(JSON.parse(cli.stdout).treePath.startsWith(path.join(cliHome,'.dalan','prepared-node-modules')+path.sep));
  for(const dir of sharedParents)assert.equal(fs.statSync(dir).mode&0o777,0o775,'unrelated parent permissions must stay unchanged');
  assert.equal(fs.existsSync(marker),false);
  const result = prepareNodeModules(src, options); // Actual npm ci; no network dependencies.
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(resolvePreparedNodeModules(src, options), result);
  assert.equal(result.runtime.node, process.version);
  write('package.json', {...manifest, description:'changed'});
  assert.throws(()=>resolvePreparedNodeModules(src, options), {code:'dependencies_unprepared', message:/\(missing\)/});
  const changedResult=prepareNodeModules(src, options);
  assert.equal(changedResult.lock_sha256,result.lock_sha256);
  assert.notEqual(changedResult.treePath,result.treePath);
  assert.deepEqual(resolvePreparedNodeModules(src, options),changedResult);
  write('package.json', manifest);
  assert.deepEqual(resolvePreparedNodeModules(src, options),result);
  write('package-lock.json', {...lock, version:'2.0.0'});
  assert.throws(()=>resolvePreparedNodeModules(src, options), {code:'dependencies_unprepared'});
  write('package-lock.json', lock);
  const meta = path.join(path.dirname(result.treePath),'metadata.json');
  fs.chmodSync(meta,0o600); const saved=fs.readFileSync(meta,'utf8');
  const changed=JSON.parse(saved); changed.identity.runtime.abi='wrong'; fs.writeFileSync(meta,JSON.stringify(changed)); fs.chmodSync(meta,0o400);
  assert.throws(()=>resolvePreparedNodeModules(src, options), {code:'dependencies_unprepared', message:/\(identity mismatch\)/});
  fs.chmodSync(meta,0o600); fs.writeFileSync(meta,saved); fs.chmodSync(meta,0o400);
  fs.chmodSync(result.treePath,0o700); fs.symlinkSync('/etc/passwd',path.join(result.treePath,'escape')); fs.chmodSync(result.treePath,0o500);
  assert.throws(()=>resolvePreparedNodeModules(src, options), {code:'dependencies_unprepared'});
  fs.chmodSync(result.treePath,0o700); fs.unlinkSync(path.join(result.treePath,'escape')); fs.chmodSync(result.treePath,0o500);
  fs.unlinkSync(meta); assert.throws(()=>resolvePreparedNodeModules(src, options), {code:'dependencies_unprepared', message:/\(missing\)/});
  const retainedInode=fs.statSync(result.treePath).ino;
  assert.deepEqual(prepareNodeModules(src,{...options,replaceInvalid:true}),result);
  const replaced=fs.readdirSync(cache).filter(name=>name.startsWith('.replaced-'));
  assert.equal(replaced.length,1);
  assert.equal(fs.statSync(path.join(cache,replaced[0],'node_modules')).ino,retainedInode);
  assert.notEqual(fs.statSync(result.treePath).ino,retainedInode);
  assert.deepEqual(resolvePreparedNodeModules(src,options),result);
  const bad = path.join(root,'bad'); fs.mkdirSync(bad); fs.writeFileSync(path.join(bad,'package.json'),JSON.stringify({name:'bad',version:'1',dependencies:{missing:'1.0.0'}})); fs.writeFileSync(path.join(bad,'package-lock.json'),JSON.stringify({name:'bad',version:'1',lockfileVersion:3,packages:{'':{name:'bad',version:'1'}}}));
  const offlineOptions = {...options, env:{...options.env,npm_config_offline:'true'}};
  assert.throws(()=>prepareNodeModules(bad,offlineOptions), error => error.code==='dependencies_install_failed' && error.message.includes(npmCliPath()) && /exit status \d+/.test(error.message));
  assert.throws(()=>resolvePreparedNodeModules(bad,options), {code:'dependencies_unprepared'});
  // A Node install whose `npm` beside the binary is a shell wrapper (mise) must still run npm's JavaScript entry.
  const fakeSrc = path.join(root,'fake-src'); fs.mkdirSync(fakeSrc);
  fs.writeFileSync(path.join(fakeSrc,'package.json'),JSON.stringify({name:'fake',version:'1.0.0'}));
  fs.writeFileSync(path.join(fakeSrc,'package-lock.json'),JSON.stringify({name:'fake',version:'1.0.0',lockfileVersion:3,packages:{'':{name:'fake',version:'1.0.0'}}}));
  const fakeNpmCli = `const fs=require('fs');fs.mkdirSync('node_modules');fs.writeFileSync('node_modules/ok.js','');fs.writeFileSync(process.env.FAKE_NPM_MARKER,process.argv.slice(1).join('\\n'));`;
  const fakeNode = (name, { cli }) => {
    const dir = path.join(root,name), bin = path.join(dir,'bin'); fs.mkdirSync(bin,{recursive:true});
    fs.symlinkSync(process.execPath,path.join(bin,'node'));
    fs.writeFileSync(path.join(bin,'npm'),'#!/usr/bin/env bash\nset -euo pipefail\nexec "$(dirname "${BASH_SOURCE[0]}")/../lib/node_modules/npm/bin/npm-cli.js" "$@"\n',{mode:0o755});
    if (cli) { const cliDir = path.join(dir,cli); fs.mkdirSync(path.dirname(cliDir),{recursive:true}); fs.writeFileSync(cliDir,fakeNpmCli); }
    return { execPath: path.join(bin,'node'), cli: cli && path.join(dir,cli) };
  };
  const unrelatedCli = path.join(root,'ambient','npm-cli.js');
  fs.mkdirSync(path.dirname(unrelatedCli));
  fs.writeFileSync(unrelatedCli,fakeNpmCli);
  const previousNpmExecpath=process.env.npm_execpath;
  let env2;
  const marker2 = path.join(root,'fake-npm-marker');
  // npm test/CI can set this to the runner's unrelated npm. Keep it alive in
  // the parent to prove these explicit fixture options isolate layout lookup.
  try {
    process.env.npm_execpath=unrelatedCli;
    env2={ ...fixtureEnv(privateDir(path.join(root,'fake-home'))), FAKE_NPM_MARKER:marker2 };
    delete env2.npm_execpath;
    assert.equal(process.env.npm_execpath,unrelatedCli);
    assert.equal(Object.hasOwn(env2,'npm_execpath'),false);
  } finally {
    if(previousNpmExecpath===undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath=previousNpmExecpath;
  }
  const layouts = [['lib layout','lib/node_modules/npm/bin/npm-cli.js'],['bin layout','bin/node_modules/npm/bin/npm-cli.js']];
  for (const [label, cli] of layouts) {
    const fake = fakeNode(label.replace(' ','-'),{cli}), fakeOptions = { cacheDir: path.join(root,`cache-${label.replace(' ','-')}`), execPath: fake.execPath, env: env2 };
    assert.equal(npmCliPath({ execPath: fake.execPath, env: env2 }), fs.realpathSync(fake.cli), label);
    const prepared = prepareNodeModules(fakeSrc, fakeOptions);
    assert.equal(fs.existsSync(path.join(prepared.treePath,'ok.js')),true,label);
    assert.deepEqual(fs.readFileSync(marker2,'utf8').split('\n').slice(0,2),[fs.realpathSync(fake.cli),'ci'],label); fs.rmSync(marker2);
  }
  const wrapperOnly = fakeNode('wrapper-only',{});
  assert.equal(npmCliPath({ execPath: wrapperOnly.execPath, env: env2 }), path.join(path.dirname(wrapperOnly.execPath),'npm'));
  assert.throws(()=>prepareNodeModules(fakeSrc,{ cacheDir: path.join(root,'cache-wrapper-only'), execPath: wrapperOnly.execPath, env: env2 }), error => error.code==='dependencies_install_failed');
  // `npm_execpath` (set when a running npm started this process) wins over the install layout, but only if it is npm's own entry.
  const running = fakeNode('running',{cli:'lib/node_modules/npm/bin/npm-cli.js'}), other = path.join(root,'other','npm-cli.js');
  fs.mkdirSync(path.dirname(other)); fs.writeFileSync(other,fakeNpmCli);
  assert.equal(npmCliPath({ execPath: running.execPath, env: { npm_execpath: other } }), fs.realpathSync(other));
  assert.equal(npmCliPath({ execPath: running.execPath, env: { npm_execpath: '/usr/lib/node_modules/pnpm/bin/pnpm.cjs' } }), fs.realpathSync(running.cli));
  console.log('prepared dependencies focused tests passed (actual npm ci, no-network fixture)');
} finally {
  // Test-owned read-only files are made removable before deleting the fixture.
  spawnSync('chmod',['-R','u+w',root]); fs.rmSync(root,{recursive:true,force:true});
}
