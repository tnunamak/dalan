#!/usr/bin/env node
import { reservedPort } from '../src/test-support/port.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { validateSubmission,validateOwnerNote,validateOutputPaths } from '../src/submission-policy.mjs';
const repo=path.resolve(new URL('..',import.meta.url).pathname);
const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-submission-policy-'));
const env={...process.env,HOME:home,DOT_BRIDGE_PORT:String(await reservedPort()),DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_T3_DRY_RUN:'1',PATH:`${path.join(home,'bin')}:${process.env.PATH}`,DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE:path.join(home,'fixture')};
const assignment=(extra={})=>({schema_version:1,request_id:`req_${randomUUID()}`,brief:'Inspect bounded input',inputs:[],expected_output:'findings',execution_scope:'read-only',...extra});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function git(args) { const r=spawnSync('git',args,{encoding:'utf8',env});assert.equal(r.status,0,r.stderr);return r.stdout.trim(); }
function cli(args,input='') { return new Promise(resolve=>{const c=spawn(process.execPath,['bin/dalan.mjs',...args],{cwd:repo,env});let stdout='',stderr='';c.stdout.on('data',b=>stdout+=b);c.stderr.on('data',b=>stderr+=b);c.on('close',code=>resolve({code,stdout,stderr}));c.stdin.end(input);}); }
function admin(route,body,headers={}) { return new Promise((resolve,reject)=>{const req=http.request({socketPath:path.join(home,'.local/share/dot-bridge/admin.sock'),path:route,method:'POST',headers:{'content-type':'application/json',...headers}},res=>{let b='';res.on('data',s=>b+=s);res.on('end',()=>resolve({code:res.statusCode,body:JSON.parse(b)}));});req.on('error',reject);req.end(JSON.stringify(body));}); }
async function submit(a,extra={}) { return admin('/submit',{delivery:'none',assignment:a,owner_token:'policy-test-owner',...(a.execution_scope==='implementation'?{execution:'none'}:{}),...extra}); }
async function denied(a,pattern,extra={}) {const r=await submit(a,extra);assert.equal(r.code,400,JSON.stringify(r));assert.match(r.body.error,pattern);const store=new Store(path.join(home,'.local/share/dot-bridge/bridge.db'));assert.equal(store.hasAssignment(a.request_id),false);store.db.close();}
let service;
try {
  fs.mkdirSync(path.join(home,'bin'),{recursive:true});
  fs.writeFileSync(path.join(home,'bin','gh'),'#!/bin/sh\necho "unexpected gh call" >&2\nexit 1\n',{mode:0o755});
  fs.mkdirSync(path.join(home,'.local/share/dot-bridge'),{recursive:true});
  fs.mkdirSync(env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE,{recursive:true});
  git(['init',env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE]);
  git(['-C',env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE,'config','user.name','Fixture']);git(['-C',env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE,'config','user.email','fixture@example.test']);
  for(const [name,text] of [['safe.txt','safe\n'],['auth-config.json','fixture documentation\n'],['.env.fixture','INERT=1\n'],['host-module.mjs','export const inert=1;\n']]) fs.writeFileSync(path.join(env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE,name),text);
  fs.mkdirSync(path.join(env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE,'src'));fs.writeFileSync(path.join(env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE,'src','a.ts'),'export const value=1;\n');fs.writeFileSync(path.join(env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE,'src','designing-apis.md'),'inert documentation\n');fs.writeFileSync(path.join(env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE,'src','assigning.ts'),'export const inert=1;\n');fs.writeFileSync(path.join(env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE,'concrete.filename'),'inert actual file\n');fs.writeFileSync(path.join(env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE,'README.md'),'fixture\n');fs.writeFileSync(path.join(env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE,'credentials'),'inert fixture\n');
  fs.mkdirSync(path.join(env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE,'docs'));fs.symlinkSync('../safe.txt',path.join(env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE,'docs','link.txt'));fs.symlinkSync('/etc/passwd',path.join(env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE,'docs','abs.txt'));
  for(const file of ['src/dup.txt','docs/dup.txt','lib/x/util.txt','app/x/util.txt']) {const full=path.join(env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE,file);fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,'inert\n');}
  git(['-C',env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE,'add','.']);git(['-C',env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE,'commit','-m','fixture']);
  const base=git(['-C',env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE,'rev-parse','HEAD']);
  fs.writeFileSync(path.join(env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE,'safe.txt'),'safe changed\n');git(['-C',env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE,'commit','-am','safe change']);
  const head=git(['-C',env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE,'rev-parse','HEAD']);
  fs.writeFileSync(path.join(env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE,'.env.fixture'),'INERT=2\n');git(['-C',env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE,'commit','-am','inert sensitive change']);
  const sensitiveHead=git(['-C',env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE,'rev-parse','HEAD']);
  const scoped=extra=>assignment({inputs:[{github_repo:'test/fixture',base_sha:base}],scope_paths:['safe.txt'],...extra});
  fs.mkdirSync(path.join(home,'.config/dot-bridge'),{recursive:true});
  fs.mkdirSync(path.join(home,'.config/dot-bridge'),{recursive:true});
  fs.writeFileSync(path.join(home,'.config/dot-bridge/workers.json'),JSON.stringify({default_execution:'host',workers:{dot:{connections:[{issuer:'https://fixture.invalid',subject:'fixture',client_id:'fixture'}],repos:["test/fixture"]}}}),{mode:0o600});
  fs.writeFileSync(path.join(home,'.config/dot-bridge/submission-policy.json'),JSON.stringify({version:1,sensitive_paths:['host-module.mjs'],exceptions:[{id:'inert-auth-doc',github_repo:'test/fixture',path:'auth-config.json',reason:'Inert public documentation'},{id:'inert-host-module',github_repo:'test/fixture',path:'host-module.mjs',reason:'Inert fixture public module'},{id:'forbidden-env',github_repo:'test/fixture',path:'.env.fixture',reason:'Must never apply'}]}),{mode:0o600});
  // Seed legacy larger text before startup; this checks policy upgrade retry/read.
  const legacy=assignment({brief:'é'.repeat(9000)});
  const store=new Store(path.join(home,'.local/share/dot-bridge/bridge.db'));store.submit(legacy,{mode:'none'},null,'policy-test-owner');store.db.close();
  service=spawn(process.execPath,['src/server.mjs'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});let ready=false,stderr='';service.stdout.on('data',b=>{if(String(b).includes('MCP listening'))ready=true;});service.stderr.on('data',b=>stderr+=b);
  for(let i=0;i<200&&!ready;i++) await sleep(25);assert(ready,stderr);
  assert.equal((await submit(legacy)).code,200,'existing oversized retry');
  const legacyConflict=await submit({...legacy,brief:legacy.brief+'x'});assert.equal(legacyConflict.code,400);assert.match(legacyConflict.body.error,/conflict|different|immutable|request_id/i);
  const legacyDb=new Store(path.join(home,'.local/share/dot-bridge/bridge.db'));assert.equal(legacyDb.get(legacy.request_id).assignment.brief,legacy.brief);legacyDb.db.close();
  const legacyRead=await admin(`/get?id=${legacy.request_id}`,undefined,{'x-owner-capability':'policy-test-owner'});assert.equal(legacyRead.code,200);assert.equal(legacyRead.body.assignment.brief,legacy.brief);
  await denied(assignment({brief:'é'.repeat(8193)}),/16386.*16384/);
  await denied(assignment({brief:'x'.repeat(16000),expected_output:'é'.repeat(5000)}),/task instructions/);
  assert.equal((await submit(assignment({brief:'é'.repeat(8192)}))).code,200);
  await denied(assignment({brief:'There are 6 slots available; do this.'}),/live-slot/);
  await denied(assignment({brief:'Inspect .env.fixture'}),/hard sensitive/);
  await denied(scoped({scope_paths:['.env.fixture']}),/hard sensitive/,{sensitive_scope_override:'forbidden-env'});
  await denied(scoped({scope_paths:['auth-config.json']}),/sensitive scope/);
  assert.equal((await submit(scoped({scope_paths:['auth-config.json']}),{sensitive_scope_override:'inert-auth-doc'})).code,200);
  await denied(scoped({scope_paths:['host-module.mjs']}),/sensitive scope/);
  assert.equal((await submit(scoped({scope_paths:['host-module.mjs']}),{sensitive_scope_override:'inert-host-module'})).code,200);
  await denied(scoped({inputs:[{github_repo:'test/fixture',base_sha:base,head_sha:sensitiveHead}]}),/hard sensitive/);
  await denied(scoped({scope_paths:undefined}),/unknown repository scope/);
  await denied(scoped({read_list:['auth-config.json']}),/contradictory/);
  await denied(scoped({brief:'Read auth-config.json'}),/sensitive scope/);
  // A bare filename that predicts a broken job is refused with the fix: one the tree lacks, or one that names several files.
  await denied(scoped({brief:'Read other.txt'}),/unknown bare filename "other\.txt": it is not in the repository tree\. Write the full repository path/);
  await denied(scoped({brief:'Read dup.txt'}),/ambiguous bare filename "dup\.txt": it matches 2 repository paths outside scope_paths \(.*dup\.txt.*dup\.txt\)\. Write the full path of the one you mean, for example \S+dup\.txt instead of dup\.txt/);
  // every offender is listed in one refusal, not only the first
  {const r=await submit(scoped({brief:'Read dup.txt, other.txt and x/util.txt'}));assert.equal(r.code,400,JSON.stringify(r));for(const part of [/ambiguous bare filename "dup\.txt"/,/unknown bare filename "other\.txt"/,/ambiguous abbreviated path "x\/util\.txt": it matches 2 repository paths/]) assert.match(r.body.error,part);assert.equal(r.body.suggested_scope_paths,undefined,'no scope suggestion can fix an ambiguous mention');}
  // a full path fixes the refusal; a harmless warning (a host directory named in prose) still queues, with the warning
  {const r=await submit(scoped({brief:'Read src/dup.txt. Scratch output goes in /tmp, not in the repository.'}));assert.equal(r.code,200,JSON.stringify(r));assert.ok(r.body.submission_warnings.some(w=>/host directory \/tmp/.test(w)),JSON.stringify(r.body.submission_warnings));}
  // a bare filename inside scope is fine, and a retry of an accepted request matches without being linted again
  {const a=scoped({brief:'Read safe.txt'});assert.equal((await submit(a)).code,200);assert.equal((await submit(a)).body.duplicate,true);}
  // read-only work grows its scope by a tree file its brief names; implementation work refuses it
  {const r=await submit(scoped({brief:'Read a.ts'}));assert.equal(r.code,200,JSON.stringify(r));assert.match(r.body.submission_warnings.join(),/grew by 1 path\(s\).*src\/a\.ts/);}
  await denied(scoped({execution_scope:'implementation',brief:'Read a.ts'}),/undeclared instruction path: src\/a\.ts \(the brief names it as "a\.ts"; write the full path\)/);
  await denied(scoped({inputs:[{github_repo:'test/fixture',base_sha:'0'.repeat(40)}]}),/base SHA/);
  await denied(scoped({inputs:[{github_repo:'test/fixture',base_sha:base,head_sha:'0'.repeat(40)}]}),/head SHA/);
  assert.equal((await submit(scoped({inputs:[{github_repo:'test/fixture',base_sha:base,head_sha:head}]}))).code,200);
  // Implementation scope checks out base_sha, so a different head_sha would be advertised but not read: reject it unless review mode.
  const implHead=extra=>scoped({execution_scope:'implementation',inputs:[{github_repo:'test/fixture',base_sha:base,head_sha:head}],...extra});
  await denied(implHead(),/head_sha_unsupported/);
  assert.equal((await submit(implHead(),{review:true})).code,200);
  assert.equal((await submit(scoped({execution_scope:'implementation',inputs:[{github_repo:'test/fixture',base_sha:base,head_sha:base}]}))).code,200);
  await denied(scoped({execution_scope:'implementation',inputs:[{github_repo:'test/fixture',base_sha:base,input_patch:'diff --git a/.env.fixture b/.env.fixture\n--- a/.env.fixture\n+++ b/.env.fixture\n@@ -1 +1 @@\n-INERT=1\n+INERT=2\n'}]}),/hard sensitive/);
  const armorHeader='-'.repeat(5)+'BE'+'GIN PRIVATE '+'KEY'+'-'.repeat(5);
  await denied(scoped({execution_scope:'implementation',inputs:[{github_repo:'test/fixture',base_sha:base,input_patch:'diff --git a/safe.txt b/safe.txt\n--- a/safe.txt\n+++ b/safe.txt\n@@ -1 +1 @@\n-safe\n+'+armorHeader+'\n'}]}),/hard sensitive/);
  for(const file of ['.git-credentials','.pgpass','.pypirc','.htpasswd','.docker/config.json','kubeconfig','service-account.json','aws-credentials','secrets.yaml','gpg-secret.asc','release.keystore','keystore.jks','scripts/sign-connector-release.mjs','id_rsa_work','id_rsa.bak','terraform.tfstate','terraform.tfstate.backup','private.ppk']) {
    const policyFile=path.join(home,'.config/dot-bridge/submission-policy.json');const policy=JSON.parse(fs.readFileSync(policyFile));policy.exceptions.push({id:`hard-${policy.exceptions.length}`,github_repo:'test/fixture',path:file,reason:'Inert forbidden fixture'});fs.writeFileSync(policyFile,JSON.stringify(policy));
    await denied(scoped({scope_paths:[file]}),/hard sensitive/,{sensitive_scope_override:policy.exceptions.at(-1).id});
    if(file.includes('.')||file.includes('/')) await denied(assignment({brief:`Inspect ${file}`}),/hard sensitive/);
  }
  for(const file of ['signing.key','private-key.json','credentials.json']) await denied(scoped({scope_paths:[file]}),/hard sensitive/);
  await denied(scoped({scope_paths:['.']}),/hard sensitive/);
  // a name in patch code is a reference, not a read (the patch that changes .env.fixture is refused above)
  assert.equal((await submit(scoped({execution_scope:'implementation',inputs:[{github_repo:'test/fixture',base_sha:base,input_patch:'diff --git a/safe.txt b/safe.txt\n--- a/safe.txt\n+++ b/safe.txt\n@@ -1 +1 @@\n-safe\n+// read .env.fixture\n'}]}))).code,200);
  await denied(scoped({execution_scope:'implementation',inputs:[{github_repo:'test/fixture',base_sha:base,input_patch:'diff --git a/safe.txt b/safe.txt\n--- a/safe.txt\n+++ b/safe.txt\n@@ -1 +1 @@\n-safe\n+cat ~/.ssh/id_rsa\n'}]}),/hard sensitive/);
  await denied(scoped({execution_scope:'implementation',inputs:[{github_repo:'test/fixture',base_sha:base,input_patch:'diff --git a/safe.txt b/safe.txt\n@@ incomplete'}]}),/incomplete.*scanner/);
  // local patch review: a read-only input_patch is linted as a diff, so code tokens like /changed/ or /me are not host paths
  const codePatch='diff --git a/safe.txt b/safe.txt\n--- a/safe.txt\n+++ b/safe.txt\n@@ -1 +1,3 @@\n-safe\n+#!/usr/bin/env node\n+fetch(\'/me\'); if(/changed or is malformed/.test(x)) home(\'/home/synthetic-user\');\n+safe\n';
  assert.equal((await submit(scoped({inputs:[{github_repo:'test/fixture',base_sha:base,input_patch:codePatch}]}))).code,200,'read-only input_patch review');
  await denied(scoped({inputs:[{github_repo:'test/fixture',base_sha:base,input_patch:'diff --git a/.env.fixture b/.env.fixture\n--- a/.env.fixture\n+++ b/.env.fixture\n@@ -1 +1 @@\n-INERT=1\n+INERT=2\n'}]}),/hard sensitive/);
  // an inlined ```diff block: leading-slash code tokens are not instructions; the same token in prose still is; a hard name still refuses
  const fenced=body=>`Review this local patch.\n\n\`\`\`diff\n${body}\`\`\`\n`;
  const hunk='diff --git a/safe.txt b/safe.txt\n--- a/safe.txt\n+++ b/safe.txt\n@@ -1 +1 @@\n-safe\n+#!/usr/bin/env node fetch(\'/relationships/dash/connections\') /changed or is malformed/\n';
  assert.equal((await submit(scoped({brief:fenced(hunk)}))).code,200,'code tokens in a diff fence');
  assert.equal((await submit(scoped({brief:'Also call /relationships/dash/connections.'}))).code,200,'a route in prose is not a file');
  await denied(scoped({brief:'Also read /etc/hosts.'}),/undeclared instruction path: \/etc\/hosts/);
  await denied(scoped({brief:fenced(hunk.replace('/changed','/home/u/.ssh/id_rsa'))}),/hard sensitive/);
  await denied(scoped({scope_paths:['docs']}),/symlink/);
  await denied(scoped({scope_paths:['docs/link.txt']}),/symlink/);
  await denied(scoped({scope_paths:['docs/abs.txt']}),/symlink/);
  assert.equal((await submit(scoped({objective:'Inspect README.md and src/a.ts',stop_rule:'Return findings',scope_paths:['README.md','src']}))).code,200,'managed directory scope');
  assert.equal((await submit(scoped({brief:'Read-list: src/a.ts',scope_paths:['src']}))).code,200,'read-list file inside directory scope');
  assert.equal((await submit(scoped({brief:'Inspect read/write behavior and/or TCP/IP interfaces'}))).code,200,'ordinary slash prose');
  assert.equal((await submit(scoped({brief:'Inspect e.g., i.e., Node.js, Next.js, Vue.js, Express.js and example.com; see github.com/foo/bar/issues/1'}))).code,200,'ordinary dotted prose and domain links');
  const plainScan=()=>({files:['safe.txt'],diffFiles:[],diff:'',symlinks:[]});
  for(const brief of ['Review how secrets are redacted','Check credentials handling','Audit the signing flow','Check the secret manager','Review Kubernetes kubeconfig handling','Next.js and Vue.js apps','Express.js server','see github.com/foo/bar/issues/1']) {
    assert.doesNotThrow(()=>validateSubmission(scoped({brief}),{scanInput:plainScan}),brief);
    assert.doesNotThrow(()=>validateSubmission(assignment({brief})),brief);
  }
  await denied(scoped({brief:'Inspect credentials'}),/hard sensitive/);
  const referenceContexts=file=>[file,`\`${file}\``,`"${file}"`,`'${file}'`,`(${file})`,`${file}.`,`${file}?`,`${file}!`,`${file},`,`**${file}**`,`*${file}*`,`_${file}_`,`[${file}]`,`<${file}>`,`{${file}}`,`=${file}`,`/${file}`,`${file}/`,`${file}…`,`${file}—`,`first,${file}`,`@${file}`,`(@${file})`,`\`@${file}\``,`**@${file}**`,`[@${file}]`,`_@${file}_`,`<@${file}>`,`{@${file}}`,`=@${file}`,`@${file}/`,`@${file}…`,`@${file}—`,`first,@${file}`];
  for(const filename of ['credentials','id_rsa','id_dsa','kubeconfig','Makefile']) {
    const knownScan=()=>({files:['safe.txt',filename],diffFiles:[],diff:'',symlinks:[]});
    // A bare word is prose unless it is a sensitive name present in the tree; Makefile is only a warning now.
    for(const reference of referenceContexts(filename)) {
      // `/Makefile` and `Makefile/` contain a slash, so they stay explicit path references.
      if(filename==='Makefile') { if(!reference.includes('/')) assert.doesNotThrow(()=>validateSubmission(scoped({brief:`Inspect ${reference}`}),{scanInput:knownScan}),reference); }
      else assert.throws(()=>validateSubmission(scoped({brief:`Inspect ${reference}`}),{scanInput:knownScan}),/hard sensitive/,reference);
    }
  }
  for(const joined of ['secrets/credentials','signing/verification','keys/secrets','secret/token','private-key/public-key']) {
    for(const reference of referenceContexts(joined).filter(reference=>!reference.startsWith('/'))) {
      assert.doesNotThrow(()=>validateSubmission(scoped({brief:`Review ${reference} handling`}),{scanInput:plainScan}),reference);
      assert.doesNotThrow(()=>validateSubmission(assignment({brief:`Review ${reference} handling`})),reference);
    }
    const knownScan=()=>({files:['safe.txt',joined],diffFiles:[],diff:'',symlinks:[]});
    assert.throws(()=>validateSubmission(scoped({brief:`Inspect ${joined}.`}),{scanInput:knownScan}),/hard sensitive/);
  }
  const scopedMentionScan=()=>({files:['safe.txt','src/a.ts','@scope/pkg/a.ts'],diffFiles:[],diff:'',symlinks:[]});
  assert.doesNotThrow(()=>validateSubmission(scoped({scope_paths:['src'],brief:'Inspect @src/a.ts'}),{scanInput:scopedMentionScan}));
  assert.doesNotThrow(()=>validateSubmission(scoped({scope_paths:['@scope/pkg'],brief:'Inspect @scope/pkg/a.ts'}),{scanInput:scopedMentionScan}),'exact @scope package preserved');
  const directoryScan=()=>({files:['safe.txt','secrets/prod.txt'],diffFiles:[],diff:'',symlinks:[]});
  assert.throws(()=>validateSubmission(scoped({brief:'Inspect secrets/'}),{scanInput:directoryScan}),/hard sensitive/);
  for(const reference of ['/home/example-user/credentials','~/credentials','$HOME/credentials','_secrets.yaml_','**_secrets.yaml_**']) assert.throws(()=>validateSubmission(scoped({brief:`Inspect ${reference}`}),{scanInput:plainScan}),/hard sensitive/);
  const absoluteScan=()=>({files:['README.md'],diffFiles:[],diff:'',symlinks:[]});
  assert.throws(()=>validateSubmission(scoped({scope_paths:['README.md'],brief:'Inspect /README.md'}),{scanInput:absoluteScan}),/undeclared/,'absolute path never inherits relative scope');
  assert.throws(()=>validateSubmission(scoped({scope_paths:['.'],brief:'Inspect /README.md'}),{scanInput:absoluteScan}),/undeclared/,'absolute path never inherits entire repository scope');
  for(const reference of ['../README.md','./../README.md']) assert.throws(()=>validateSubmission(scoped({scope_paths:['.'],brief:`Inspect ${reference}`}),{scanInput:absoluteScan}),/undeclared/,'parent traversal never inherits repository scope');
  for(const url of ['https://github.com/foo/bar','http://localhost/api','https://example.com/secrets']) assert.doesNotThrow(()=>validateSubmission(scoped({brief:`See ${url}`}),{scanInput:plainScan}),'HTTP URL is not absolute host path');
  for(const filename of ['_Makefile_','under_score.ts']) {
    const knownScan=()=>({files:['safe.txt',filename],diffFiles:[],diff:'',symlinks:[]});
    assert.doesNotThrow(()=>validateSubmission(scoped({scope_paths:[filename],brief:`Inspect ${filename}`}),{scanInput:knownScan}),'exact underscore filename preserved');
    // A bare word without an extension (_Makefile_) is prose and only warns; a bare filename found once outside scope is refused.
    if(filename.includes('.')) assert.throws(()=>validateSubmission(scoped({execution_scope:'implementation',brief:`Inspect ${filename}.`}),{scanInput:knownScan}),/undeclared/);
    else { const warnings=[]; assert.doesNotThrow(()=>validateSubmission(scoped({brief:`Inspect ${filename}.`}),{scanInput:knownScan,warnings})); assert.match(warnings.join(),/bare word/); }
  }
  for(const reference of referenceContexts('.env')) assert.throws(()=>validateSubmission(scoped({brief:`Inspect ${reference}`}),{scanInput:plainScan}),/hard sensitive/);
  for(const reference of ['~/.ssh/id_rsa','$HOME/.ssh/id_rsa','.ssh/','id_rsa,kubeconfig']) {
    const knownScan=()=>({files:['safe.txt','kubeconfig'],diffFiles:[],diff:'',symlinks:[]});
    assert.throws(()=>validateSubmission(scoped({brief:`Inspect ${reference}`}),{scanInput:knownScan}),/hard sensitive/);
  }
  for(const brief of ['Inspect e.g., i.e., Node.js, example.com; Read-list: safe.txt','Use "secrets/credentials" wording, (signing/verification) and **keys/secrets**.','Done. Then stop.','Compare e.g./i.e. behaviour']) assert.doesNotThrow(()=>validateSubmission(scoped({brief}),{scanInput:plainScan}),brief);
  for(const reference of referenceContexts('.ssh/key')) assert.throws(()=>validateSubmission(scoped({brief:`Inspect ${reference}`}),{scanInput:plainScan}),/hard sensitive/);
  await denied(scoped({brief:'Inspect credentials.'}),/hard sensitive/);

  assert.equal((await submit(scoped({scope_paths:['src/designing-apis.md','src/assigning.ts']}))).code,200,'signing substring is ordinary filename');
  assert.equal((await submit(scoped({brief:'Inspect concrete.filename'}))).code,200,'a dotted token not in the tree names no file');
  assert.equal((await submit(scoped({scope_paths:['concrete.filename'],brief:'Inspect concrete.filename'}))).code,200,'actual filename with unknown extension');
  await denied(assignment({brief:'Inspect '+'sk_'+'live_'+'abcdefghijklmnopqrstuvwx'}),/hard sensitive content/);
  assert.equal((await submit(assignment({objective:'Assess this idea',stop_rule:'Return findings',brief:undefined}))).code,200,'managed input-free task');
  assert.equal((await submit(assignment({inputs:[{revision:'abc'}]}))).code,200,'opaque read-only input retained');
  await denied(assignment({execution_scope:'implementation',inputs:[{revision:'abc'}]}),/github_repo/);
  const managed=scoped({objective:'Inspect safe.txt',stop_rule:'Return when findings are complete',brief:'discarded free text'});const managedResult=await submit(managed);assert.equal(managedResult.code,200);
  assert.equal((await submit(scoped({objective:'Inspect safe.txt',stop_rule:'Return findings',brief:undefined}))).code,200,'structured assignment may omit free-text brief');
  const db=new Store(path.join(home,'.local/share/dot-bridge/bridge.db'));assert.match(db.get(managed.request_id).assignment.brief,/Read allow-list:\nsafe.txt/);assert.doesNotMatch(db.get(managed.request_id).assignment.brief,/discarded/);db.db.close();
  const noteAssignment=assignment();assert.equal((await submit(noteAssignment)).code,200);const note=text=>admin('/note',{id:noteAssignment.request_id,text},{'x-owner-capability':'policy-test-owner'});
  assert.equal((await note('é'.repeat(2049))).code,400);for(let i=0;i<4;i++) assert.equal((await note('é'.repeat(2048))).code,200);assert.equal((await note('x')).code,400);
  const notesDb=new Store(path.join(home,'.local/share/dot-bridge/bridge.db'));assert.equal(notesDb.ownerNotes(noteAssignment.request_id).length,4,'rejected write mutated history');notesDb.db.close();
  const cliAssignment=assignment();let result=await cli(['submit','--stdin','--json'],JSON.stringify(cliAssignment));assert.equal(result.code,0,result.stderr);
  result=await cli(['note',cliAssignment.request_id,'é'.repeat(2049),'--json']);assert.notEqual(result.code,0);assert.match(result.stderr,/UTF-8 bytes/);
  result=await cli(['submit','--stdin','--json','--sensitive-scope-override','inert-auth-doc'],JSON.stringify(scoped({scope_paths:['auth-config.json']})));assert.equal(result.code,0,result.stderr);
  result=await cli(['submit','--stdin','--json','--sensitive-scope-override','forbidden-env'],JSON.stringify(scoped({scope_paths:['.env.fixture']})));assert.notEqual(result.code,0);assert.match(result.stderr,/hard sensitive/);
  assert.throws(()=>validateOwnerNote('😀'.repeat(1025)),/4100.*4096/);
  assert.throws(()=>validateSubmission(scoped(),{scanInput:()=>{throw new Error('scanner intentionally failed');}}),/scanner/);

  // output_paths: declared NEW files (docs/usage.md "Creating new files"). Refused loudly, each with the fix.
  {
    const withOut=(output_paths,extra={})=>scoped({output_paths,...extra});
    // New outputs must not alias one another as a file or as a file's parent.
    const aliasConflicts=[
      ['new/Foo','new/foo/child.md'],
      ['new/caf\u00e9','new/cafe\u0301/child.md'],
      ['new/CAF\u00c9','new/cafe\u0301/child.md'],
      ['new/Foo.md','new/foo.md'],
      ['new/caf\u00e9.md','new/cafe\u0301.md'],
      ['new/CAF\u00c9.md','new/cafe\u0301.md'],
    ];
    const aliasFailures=[];
    for(const pair of aliasConflicts) for(const list of [pair,[...pair].reverse()]) {
      const label=JSON.stringify(list),pattern=/overlap as file and directory|name the same file/;
      try { assert.throws(()=>validateOutputPaths(list),pattern,label); }
      catch(error) { aliasFailures.push(`shape ${label}: ${error.message}`); }
      try { await denied(withOut(list),pattern); }
      catch(error) { aliasFailures.push(`submit ${label}: ${error.message}`); }
    }
    const siblingControls=[
      ['new/Foo','new/foobar/child.md'],
      ['new/caf\u00e9','new/cafe\u0301-other/child.md'],
      ['new/CAF\u00c9','new/cafe\u0301-other/child.md'],
      ['new/Dir/Foo.md','new/dir/Bar.md'],
    ];
    for(const pair of siblingControls) for(const list of [pair,[...pair].reverse()]) {
      const original=[...list];
      assert.deepEqual(validateOutputPaths(list),original,'comparison keys must not rewrite output names');
      const acceptedAssignment=withOut(list),response=await submit(acceptedAssignment);
      assert.equal(response.code,200,JSON.stringify(response));
      const aliasStore=new Store(path.join(home,'.local/share/dot-bridge/bridge.db'));
      const storedAlias=aliasStore.get(acceptedAssignment.request_id).assignment;aliasStore.db.close();
      assert.deepEqual(storedAlias.output_paths,original,'stored output names retain case and Unicode spelling');
      assert.ok(storedAlias.brief.endsWith(`Output paths (output_paths; may create):\n${original.join('\n')}`),'displayed output names retain case and Unicode spelling');
      assert.deepEqual(list,original,'submission must not mutate the original output list');
    }
    console.log('PASS 8 ordered output sibling controls preserve submitted, stored and displayed names');
    assert.deepEqual(aliasFailures,[],'new output aliases must be rejected in both orders');
    console.log('PASS 12 ordered output alias conflicts refused by shape validation and HTTP submission');
    // Absent names have no directory type: warn about nested intent without granting it.
    const directory='new-directory',nested=`${directory}/nested/report.md`;
    const ambiguous=withOut([directory],{brief:`Read safe.txt and write ${nested}`});
    const preview=await admin('/submit-preview',{delivery:'none',assignment:ambiguous,owner_token:'policy-test-owner'});
    assert.equal(preview.code,200,JSON.stringify(preview));assert.equal(preview.body.stored,false);
    assert.match(preview.body.submission_warnings.join(),/output_paths entry new-directory is an exact new file, not a directory.*List each new file in output_paths/);
    const warned=await submit(ambiguous);assert.equal(warned.code,200,JSON.stringify(warned));
    assert.match(warned.body.submission_warnings.join(),/output_paths entry new-directory is an exact new file, not a directory.*List each new file in output_paths/);
    const warnedStore=new Store(path.join(home,'.local/share/dot-bridge/bridge.db'));
    const warnedAssignment=warnedStore.get(ambiguous.request_id).assignment;warnedStore.db.close();
    assert.deepEqual(warnedAssignment.output_paths,[directory],'warning cannot add a nested output');
    assert.deepEqual(warnedAssignment.scope_paths,['safe.txt'],'warning cannot widen read or write scope');
    assert.deepEqual(ambiguous.output_paths,[directory],'validation does not mutate the submitted output list');
    const extensionless=await submit(withOut(['LICENSE'],{brief:'Read safe.txt and create LICENSE'}));
    assert.equal(extensionless.code,200,JSON.stringify(extensionless));
    assert.ok(!(extensionless.body.submission_warnings??[]).some(w=>/exact new file, not a directory/.test(w)),'legitimate extensionless file needs no directory warning');
    for(const list of [[directory,nested],[nested,directory],['report.md','report.md/child.md']]) {
      assert.throws(()=>validateOutputPaths(list),/overlap as file and directory.*list each new file/);
      await denied(withOut(list),/overlap as file and directory.*list each new file/);
    }
    assert.deepEqual(validateOutputPaths(['LICENSE','new-directory-sibling/report.md']),['LICENSE','new-directory-sibling/report.md'],'extensionless files and sibling prefixes remain valid');
    const ok=withOut(['notes/research.md','new-report.md'],{brief:'Research safe.txt and write the findings to new-report.md and notes/research.md'});
    const accepted=await submit(ok);assert.equal(accepted.code,200,JSON.stringify(accepted));
    const stored=new Store(path.join(home,'.local/share/dot-bridge/bridge.db')).get(ok.request_id).assignment;
    assert.deepEqual(stored.output_paths,['notes/research.md','new-report.md']);
    assert.match(stored.brief,/Output paths \(output_paths; may create\):\nnotes\/research\.md\nnew-report\.md$/,'the brief names the files the worker may create');
    assert.equal((await submit(ok)).code,200,'an identical retry is accepted');
    const changed=await submit({...ok,output_paths:['notes/research.md']});assert.equal(changed.code,400,'a different output_paths under the same request_id is a conflict');
    const structured=scoped({objective:'Research safe.txt',stop_rule:'Return when the note is written',brief:undefined,output_paths:['notes/structured.md']});
    assert.equal((await submit(structured)).code,200);
    assert.match(new Store(path.join(home,'.local/share/dot-bridge/bridge.db')).get(structured.request_id).assignment.brief,/Output paths \(output_paths; may create\):\nnotes\/structured\.md/);
    // implementation scope reaches the same validation
    const impl=validateSubmission({...withOut(['docs/new.md']),execution_scope:'implementation'},{scanInput:()=>({files:['safe.txt','docs/a.md'],diffFiles:[],diff:'',symlinks:[]})});
    assert.deepEqual(impl.output_paths,['docs/new.md']);
    const refusals=[
      [['safe.txt'],/output_paths: safe\.txt already exists at .*NEW files only/s],
      [['src'],/output_paths: src is an existing directory \(or the prefix of existing files\)/],
      [['safe.txt/child.md'],/cannot be created: safe\.txt is a file/],
      [['src/'],/names a directory/],
      [['./notes.md'],/write notes\.md \(no leading/],
      [['notes/*.md'],/glob/],
      [['../notes.md'],/\.\./],
      [['/etc/notes.md'],/not repository-relative/],
      [['notes\\x.md'],/not repository-relative/],
      [['.git/hooks/x'],/\.git/],
      [['notes.md','notes.md'],/listed twice/],
      [['n'.repeat(257)],/257 characters; at most 256/],
      [Array.from({length:11},(_,i)=>`new${i}.md`),/11 paths; at most 10/],
      [[],/non-empty list/],
      ['notes.md',/non-empty list/],
      [['.env.new'],/output_paths: hard sensitive path exclusion: \.env\.new/],
      [['secrets/key.md'],/output_paths: .*sensitive/],
      [['deploy/credentials.pem'],/output_paths: hard sensitive/],
      [[''],/non-empty string/],
      [[7],/non-empty string/],
    ];
    for(const [list,pattern] of refusals) await denied(withOut(list),pattern);
    // an output path that differs from an existing path only by case or Unicode normalization collides on macOS: refused, with the fix
    const lookalike=(output_paths,files,diffFiles=[])=>({...withOut(output_paths),inputs:[{github_repo:'test/fixture',base_sha:base}]});
    const scanOf=(files,diffFiles=[])=>()=>({files,diffFiles,diff:'',symlinks:[]});
    assert.throws(()=>validateSubmission(lookalike(['readme.md']),{scanInput:scanOf(['README.md','safe.txt'])}),/output path readme\.md collides with existing README\.md on case-insensitive or Unicode-normalizing filesystems \(macOS\); choose another name/);
    assert.throws(()=>validateSubmission(lookalike(['caf\u00e9.txt']),{scanInput:scanOf(['cafe\u0301.txt','safe.txt'])}),/output path caf\u00e9\.txt collides with existing cafe\u0301\.txt .*choose another name/);
    assert.throws(()=>validateSubmission({...lookalike(['docs/guide.md']),scope_paths:['safe.txt','Docs/Guide.md']},{scanInput:scanOf(['safe.txt'],['Docs/Guide.md'])}),/output path docs\/guide\.md collides with existing Docs\/Guide\.md/);
    assert.throws(()=>validateSubmission(lookalike(['SRC/new.md']),{scanInput:scanOf(['src/a.md','safe.txt'])}),/output path SRC\/new\.md collides with existing src/);
    assert.doesNotThrow(()=>validateSubmission({...lookalike(['notes/brand-new.md']),scope_paths:['safe.txt','Docs/Guide.md']},{scanInput:scanOf(['README.md','cafe\u0301.txt','safe.txt'],['Docs/Guide.md'])}),'a genuinely new name is accepted');
    // a directory at the base commit, deleted by the head, is still a prefix of existing files
    assert.throws(()=>validateSubmission({...withOut(['retired']),inputs:[{github_repo:'test/fixture',base_sha:base,head_sha:head}]},{scanInput:()=>({files:['safe.txt'],diffFiles:['retired/keep.txt'],diff:'',symlinks:[]})}),/output_paths: retired is an existing directory \(or the prefix/);
    assert.throws(()=>validateSubmission({...withOut(['notes.md']),inputs:[{github_repo:'test/fixture',base_sha:base,input_patch:'diff --git a/safe.txt b/safe.txt\n'}]},{scanInput:()=>({files:['safe.txt'],diffFiles:[],diff:'',symlinks:[]})}),/cannot be combined with input_patch/);
    await denied(withOut(['notes/review.md']),/output_paths are not allowed with --review.*Remove output_paths/,{review:true});
    await denied(assignment({output_paths:['notes.md']}),/output_paths require pinned repository input/);
    // a new file in scope_paths is still refused; the CLI fix names output_paths
    await denied(scoped({scope_paths:['safe.txt','notes/new.md']}),/^unknown scope path: notes\/new\.md$/);
    const cliResult=await cli(['submit','--stdin','--json'],JSON.stringify(scoped({scope_paths:['safe.txt','notes/new.md']})));
    assert.notEqual(cliResult.code,0);assert.ok(JSON.parse(cliResult.stderr||cliResult.stdout).fix.some(line=>/list it in output_paths instead/.test(line)),cliResult.stderr+cliResult.stdout);
    const viaCli=await cli(['submit','--stdin','--json'],JSON.stringify(withOut(['notes/via-cli.md'])));assert.equal(viaCli.code,0,viaCli.stderr);
  }
  console.log('submission-policy-e2e: PASS');
} finally { if(service&&service.exitCode===null) {service.kill('SIGTERM');await new Promise(r=>service.once('exit',r));}fs.rmSync(home,{recursive:true,force:true}); }
