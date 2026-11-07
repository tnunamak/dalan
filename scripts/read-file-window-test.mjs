#!/usr/bin/env node
// read_file reports the window it returned: end_line is the last line in `text`, and `truncated` is true only when the
// 32 KiB byte cap removed text from the requested line window. The cut keeps whole lines when it can and never splits a
// UTF-8 character. Runs without host checks, unlike workspace-e2e.mjs.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-bridge-read-window-'));process.env.HOME=home;process.env.DALAN_WORKSPACE_ROOT=path.join(home,'work');
const {Store}=await import('../src/store.mjs'),{Workspace}=await import('../src/workspace.mjs');
const run=(cmd,args,cwd)=>{const x=spawnSync(cmd,args,{cwd,encoding:'utf8'});if(x.status!==0)throw new Error(x.stderr||x.stdout);return x.stdout.trim();};
const assert=(x,m)=>{if(!x)throw new Error(m);};
try {
 const repo=path.join(home,'repo');fs.mkdirSync(repo);run('git',['init','-q'],repo);run('git',['config','user.email','test@example.com'],repo);run('git',['config','user.name','Test'],repo);
 fs.writeFileSync(path.join(repo,'leak.ts'),'seed\n');run('git',['add','.'],repo);run('git',['commit','-qm','base'],repo);const base=run('git',['rev-parse','HEAD'],repo);
 process.env.DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE=repo;
 const store=new Store(path.join(home,'db.sqlite')),ws=new Workspace(store);
 const rid=`req_${randomUUID()}`;
 store.submit({schema_version:1,request_id:rid,brief:'fixture',inputs:[{github_repo:'example-owner/fixture',base_sha:base}],expected_output:'patch',execution_scope:'implementation'},'thread','environment','owner');
 const rc=store.claim(rid,'dot','subject',10).claim_id;
 assert(ws.read(rid,rc,'subject','leak.ts').text==='seed\n','checkout readable');
 const readText=(text,start=1,max=200)=>{fs.writeFileSync(path.join(home,'work','worktrees',rid,'leak.ts'),text);return ws.read(rid,rc,'subject','leak.ts',start,max);};

 // The line limit alone is not byte truncation.
 const many=Array.from({length:250},(_,i)=>'line '+(i+1));
 const first=readText(many.join('\n'));
 assert(first.text===many.slice(0,200).join('\n')&&first.end_line===200&&first.total_lines===250&&!first.truncated,'200-line window: '+JSON.stringify({...first,text:undefined}));
 const tail=readText(many.join('\n'),201);
 assert(tail.start_line===201&&tail.end_line===250&&tail.total_lines===250&&!tail.truncated,'tail window');
 const past=readText('plain',3);
 assert(past.text===''&&past.end_line===2&&!past.truncated,'window past the end');

 // Byte cap: keep whole lines without a trailing delimiter that would imply a further line.
 const bounded=readText('skip\n'+'a'.repeat(20000)+'\n'+'b'.repeat(20000),2);
 assert(bounded.text==='a'.repeat(20000)&&bounded.end_line===2&&bounded.total_lines===3&&bounded.truncated,'whole-line byte cut');
 const exact=readText('a'.repeat(32768));
 assert(exact.text.length===32768&&exact.end_line===1&&!exact.truncated,'exact byte limit');
 const boundary=readText('a'.repeat(32768)+'\nnext');
 assert(boundary.text==='a'.repeat(32768)&&boundary.end_line===1&&boundary.truncated,'newline at byte limit');
 const emptyLine=readText('\n'+'a'.repeat(40000));
 assert(emptyLine.text===''&&emptyLine.end_line===1&&emptyLine.truncated,'empty complete first line');

 // A first line longer than the cap is cut inside the line, never inside a UTF-8 character.
 const oversized=readText('a'.repeat(40000)+'\nnext');
 assert(oversized.text==='a'.repeat(32768)&&oversized.end_line===1&&oversized.truncated,'oversized first line');
 for(const char of ['é','€','😀']) {
  const partial=readText('a'.repeat(32767)+char+'\nnext');
  assert(partial.text==='a'.repeat(32767)&&partial.end_line===1&&partial.truncated,'partial UTF-8 character: '+char);
  const complete=readText('a'.repeat(32768-Buffer.byteLength(char))+char+'z');
  assert(complete.text.endsWith(char)&&Buffer.byteLength(complete.text)===32768&&complete.truncated,'complete UTF-8 character: '+char);
 }
 console.log('PASS read_file reports end_line and truncated, keeps whole lines and whole UTF-8 characters');
} finally { fs.rmSync(home,{recursive:true,force:true}); }
