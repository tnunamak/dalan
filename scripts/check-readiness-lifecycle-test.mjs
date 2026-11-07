#!/usr/bin/env node
// An early server exit must preserve the startup error instead of awaiting a spent exit event.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const scratch=path.join(os.homedir(),'.tmp');
fs.mkdirSync(scratch,{recursive:true});
const root=fs.mkdtempSync(path.join(scratch,'rd-'));
const preload=path.join(root,'startup-failure.mjs'),portFile=path.join(root,'requested-port');
try {
  fs.writeFileSync(preload,`import cp from 'node:child_process';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const spawn=cp.spawn;
cp.spawn=function(command,args=[],options={}) {
  if(command===process.execPath&&args[0]==='src/server.mjs') {
    fs.writeFileSync(${JSON.stringify(portFile)},String(options.env?.DOT_BRIDGE_PORT));
    return spawn(command,['-e',"console.error('READINESS_STARTUP_FAILURE_CONTROL');process.exit(23)"],options);
  }
  return spawn(command,args,options);
};
syncBuiltinESMExports();\n`);
  for (const target of ['check-readiness-e2e.mjs','metadata-e2e.mjs']) {
  const result=spawnSync(process.execPath,['--import',preload,new URL('./'+target,import.meta.url).pathname],{
    env:{...process.env,TMPDIR:root},encoding:'utf8',timeout:15000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal,null);
  assert.equal(result.status,1,`${target}: startup failure must exit normally with its original error, not an unsettled-await exit: ${result.stderr}`);
  assert.match(result.stderr,/READINESS_STARTUP_FAILURE_CONTROL/);
  assert.doesNotMatch(result.stderr,/unsettled top-level await/);
  assert.doesNotMatch(result.stderr,/SyntaxError/,'the injected child must fail deliberately, not from invalid control code');
  assert.equal(fs.readFileSync(portFile,'utf8'),'0',`${target}: child owns its ephemeral public port`);
  console.log(`PASS ${target} preserves early startup failure and requests a child-owned port`);
  }
} finally {fs.rmSync(root,{recursive:true,force:true});}
