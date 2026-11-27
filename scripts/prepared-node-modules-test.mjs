import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { npmCliPath, prepareNodeModules, resolvePreparedNodeModules } from '../src/prepared-node-modules.mjs';

const root = fs.mkdtempSync(path.join(os.homedir(), 'prepared-test-'));
const src = path.join(root, 'source'), cache = path.join(root, 'cache');
fs.mkdirSync(src);
const options = { cacheDir: cache };
const marker = path.join(root, 'lifecycle-marker');
const manifest = { name:'fixture', version:'1.0.0', scripts:{ install:`node -e "require('fs').writeFileSync('${marker}','bad')"` } };
const lock = { name:'fixture', version:'1.0.0', lockfileVersion:3, packages:{ '':{ name:'fixture', version:'1.0.0', hasInstallScript:true } } };
const write = (file, data) => fs.writeFileSync(path.join(src,file), JSON.stringify(data));
try {
  assert.equal(resolvePreparedNodeModules(src, options), null);
  write('package.json', manifest); write('package-lock.json', lock);
  assert.throws(()=>resolvePreparedNodeModules(src, options), {code:'dependencies_unprepared', message:/\(missing\)/});
  const cliHome=path.join(root,'cli-home'); fs.mkdirSync(cliHome,{mode:0o700});
  const sharedParents=[path.join(cliHome,'.local'),path.join(cliHome,'.local','share')];
  fs.mkdirSync(sharedParents[1],{recursive:true});for(const dir of sharedParents)fs.chmodSync(dir,0o775);
  const cli=spawnSync(process.execPath,[path.resolve('bin/dot-worker.mjs'),'prepare-deps',src,'--json'],{env:{...process.env,HOME:cliHome,npm_config_ignore_scripts:'false'},encoding:'utf8'});
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
  const previousOffline = process.env.npm_config_offline;
  process.env.npm_config_offline = 'true';
  try { assert.throws(()=>prepareNodeModules(bad,options), error => error.code==='dependencies_install_failed' && error.message.includes(npmCliPath()) && /exit status \d+/.test(error.message)); }
  finally {
    if (previousOffline === undefined) delete process.env.npm_config_offline;
    else process.env.npm_config_offline = previousOffline;
  }
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
  const marker2 = path.join(root,'fake-npm-marker'), env2 = { PATH: process.env.PATH, FAKE_NPM_MARKER: marker2 };
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
