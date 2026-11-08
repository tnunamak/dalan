import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Never read an operator's submission policy or fetch a repository.
const savedHome=process.env.HOME;
const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-validator-friction-'));
process.env.HOME=home;
const {validateSubmission,renderAssignment}=await import('../submission-policy.mjs');
const {assignmentInput}=await import('../projects.mjs');
const {compileWorkOrder,reasonsFromError}=await import('../work-order.mjs');
test.after(()=>{
  if(savedHome===undefined) delete process.env.HOME; else process.env.HOME=savedHome;
  fs.rmSync(home,{recursive:true,force:true});
});
const files=['docs/guide.md','src/main.mjs','src/other.mjs','one/config.toml','two/config.toml','one/app/config.toml','two/app/config.toml','web/(group)/page.ts'];
const base=brief=>({schema_version:1,request_id:'req_validator_friction',brief,
  inputs:[{github_repo:'example/repo',base_sha:'a'.repeat(40)}],
  expected_output:'A patch.',execution_scope:'implementation',scope_paths:['docs/guide.md']});
function check(brief,extra={}) {
  const warnings=[],assignment=base(brief);
  Object.assign(assignment,extra);
  const value=validateSubmission(assignment,{warnings,scanInput:()=>({files,diff:'',diffFiles:[],symlinks:[]})});
  return {value,warnings};
}
async function order(assignment) {
  return compileWorkOrder({assignment,jobExecution:'none'},{
    render:renderAssignment,admitExecution:()=>{},
    validate:(a,{warnings})=>validateSubmission(a,{warnings,scanInput:()=>({files,diff:'',diffFiles:[],symlinks:[]})}),
    admitReadiness:()=>null,preflight:()=>null,state:()=>({}),kind:()=> 'implementation',
    defaultValidity:()=>null
  });
}
test('invalid execution_scope names the assignment field and both allowed values',async()=>{
  assert.throws(()=>assignmentInput({...base('Describe the task.'),execution_scope:'research'}),
    {message:'invalid execution_scope: expected one of read-only, implementation'});
  const result=await order({...base('Describe the task.'),execution_scope:'research'});
  assert.equal(result.verdict,'reject');
  assert.equal(result.reasons[0].code,'invalid_schema');
  assert.equal(result.reasons[0].field,'execution_scope');
  assert.match(result.reasons[0].message,/read-only, implementation/);
});
for(const mention of ['/etc/client/config.toml','~/.codex/config.toml','$HOME/.codex/config.toml',
  '$'+'{HOME}/.codex/config.toml','$CONFIG_DIR/client.toml','$'+'{CONFIG_DIR}/client.toml',
  '/README.md','C:\\Users\\reader\\client.toml','\\\\host\\share\\client.toml']) {
  test('external prose warns without expanding scope: '+mention,()=>{
    const {value,warnings}=check('Describe the client setting at '+mention+'.');
    assert.deepEqual(value.scope_paths,['docs/guide.md']);
    assert.ok(warnings.some(w=>w.includes('external path')));
  });
}
test('external prose is accepted with a warning, not refused (main refused these as undeclared or unknown paths)',()=>{
  assert.doesNotThrow(()=>check('Describe the client setting at ~/.codex/config.toml.'));
  assert.doesNotThrow(()=>check('Describe the client setting at /etc/client/config.toml.'));
});
test('a missing bare filename still refuses (pinned by submission-policy-e2e)',()=>{
  assert.throws(()=>check('Explain how the client uses client.toml.'),/unknown bare filename/);
});
test('an ambiguous bare filename still refuses',()=>{
  assert.throws(()=>check('Describe config.toml.'),/ambiguous bare filename/);
});
test('an ambiguous abbreviated path still refuses',()=>{
  assert.throws(()=>check('Describe app/config.toml.'),/ambiguous abbreviated path/);
});
for(const brief of ['Edit client.toml.']) {
  test('missing direct edit target still refuses: '+brief,()=>{
    assert.throws(()=>check(brief,{scope_paths:['docs/guide.md','src']}),
      /unknown bare filename|undeclared instruction path/);
  });
}
for(const mention of ['~/.ssh/id_rsa','$HOME/.ssh/id_rsa','$'+'{CONFIG_DIR}/credentials.json',
  '/etc/credentials.json','C:\\Users\\reader\\.ssh\\id_rsa']) {
  test('sensitive external references remain refused: '+mention,()=>{
    assert.throws(()=>check('Read '+mention+'.'),/hard sensitive path exclusion/);
  });
}
test('explicit scope list still rejects absolute paths',()=>{
  assert.throws(()=>check('Describe the task.',{scope_paths:['/etc/client.toml']}),/invalid scope_paths/);
});
test('traversal stays refused',()=>{
  assert.throws(()=>check('Read ../outside.md.'),/undeclared instruction path/);
});
