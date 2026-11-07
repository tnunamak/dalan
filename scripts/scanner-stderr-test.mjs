import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanGit } from '../src/submission-policy.mjs';

// Real child process, synthetic stderr only; no repository or network access.
function failure(stderr) {
  const bin=fs.mkdtempSync(path.join(os.tmpdir(),'scanner-stderr-'));
  const mirror=path.join(bin,'private-mirror');
  fs.writeFileSync(path.join(bin,'git'),`#!${process.execPath}\nrequire('node:fs').writeFileSync(2, ${JSON.stringify(stderr.replaceAll('<mirror>',mirror))});process.exit(42);\n`,{mode:0o700});
  try {
    let caught;
    try { scanGit(mirror,['ls-tree','-r','synthetic-revision'],(cmd,args,options)=>{
      assert.equal(options.timeout,30000);
      assert.equal(options.maxBuffer,32*1024*1024);
      return spawnSync(cmd,args,{...options,env:{...options.env,PATH:bin}});
    }); } catch(error) { caught=error; }
    assert.equal(caught?.code,'DOT_BRIDGE_INFRASTRUCTURE');
    assert.ok(!caught.message.includes(mirror));
    assert.ok(!caught.message.includes('synthetic-revision'));
    return caught.message;
  } finally { fs.rmSync(bin,{recursive:true,force:true}); }
}
test('C1: git failure preserves status and useful stderr, not mirror path',()=>{
  assert.equal(failure('fatal: missing tree object\n'),'submission scope scanner failed: git ls-tree exited 42: fatal: missing tree object');
  assert.match(failure('fatal: <mirror>/objects missing'),/objects missing/);
});
test('C2: over 1 MiB stderr retains both ends in a bounded diagnostic',()=>{
  const message=failure('HEAD:'+ 'x'.repeat(1024*1024+1)+':TAIL');
  assert.ok(Buffer.byteLength(message)<8192);
  assert.match(message,/HEAD:/);assert.match(message,/:TAIL$/);
  assert.match(message,/\[truncated\]/);
});
test('C3: secret-shaped stderr suppresses the entire excerpt',()=>{
  const synthetic=['gh','p_'].join('')+'A'.repeat(36);
  for(const stderr of ['before '+synthetic+' after','HEAD'+'x'.repeat(4096)+' '+synthetic+' '+'y'.repeat(4096)+'TAIL']) {
    assert.equal(failure(stderr),'submission scope scanner failed: git ls-tree exited 42');
  }
});
test('spawn failures remain infrastructure errors without raw error details',()=>{
  assert.throws(()=>scanGit('/synthetic/private-mirror',['diff'],()=>({status:null,error:Object.assign(new Error('must not be exposed'),{code:'EACCES'})})),
    error=>error.code==='DOT_BRIDGE_INFRASTRUCTURE'&&error.message==='submission scope scanner failed: git diff failed to start');
});
test('a timeout or signal is named instead of an unknown status',()=>{
  const fail=r=>{try{scanGit('/synthetic/private-mirror',['diff'],()=>r);}catch(error){return error;}};
  const timedOut=fail({status:null,signal:'SIGTERM',stderr:'',error:Object.assign(new Error('must not be exposed'),{code:'ETIMEDOUT'})});
  assert.equal(timedOut.code,'DOT_BRIDGE_INFRASTRUCTURE');
  assert.equal(timedOut.message,'submission scope scanner failed: git diff timed out');
  assert.equal(fail({status:null,signal:'SIGKILL',stderr:''}).message,'submission scope scanner failed: git diff was stopped by SIGKILL');
});
