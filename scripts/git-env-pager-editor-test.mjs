import test from 'node:test';
import assert from 'node:assert/strict';
import {gitEnv} from '../src/git-env.mjs';

const base=()=>({
  PATH:"the owner's local check",
  PAGER:'evil',EDITOR:'evil',VISUAL:'evil',GIT_PAGER:'evil',GIT_EDITOR:'evil',
  GIT_ASKPASS:'fixture-askpass',GIT_TERMINAL_PROMPT:'0',GIT_DIR:'fixture-other-repo',
});

test('gitEnv overrides inherited pager and editor selections',()=>{
  const result=gitEnv(base());
  assert.equal(result.GIT_PAGER,'cat');
  assert.equal(result.GIT_EDITOR,':');
});

test('gitEnv retains its four config overrides and private-fetch exceptions',()=>{
  const result=gitEnv(base());
  assert.equal(result.GIT_CONFIG_COUNT,'4');
  assert.deepEqual(Array.from({length:4},(_,index)=>[
    result['GIT_CONFIG_KEY_'+index],result['GIT_CONFIG_VALUE_'+index],
  ]),[
    ['core.hooksPath','/dev/null'],
    ['core.fsmonitor','false'],
    ['core.excludesFile','/dev/null'],
    ['core.attributesFile','/dev/null'],
  ]);
  assert.equal(result.GIT_ASKPASS,'fixture-askpass');
  assert.equal(result.GIT_TERMINAL_PROMPT,'0');
  assert.equal(Object.hasOwn(result,'GIT_DIR'),false);
});

test('gitEnv passes PATH through unchanged without mutating its input',()=>{
  const input=base(),before={...input};
  assert.equal(gitEnv(input).PATH,"the owner's local check");
  assert.deepEqual(input,before);
});
