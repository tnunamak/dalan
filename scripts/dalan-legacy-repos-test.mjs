import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {Store} from '../src/store.mjs';
import {LEGACY_PROFILE} from '../src/workers.mjs';
const root=path.resolve(new URL('..',import.meta.url).pathname);
const assignment=(id,repo=false)=>({schema_version:1,request_id:id,brief:'Repository policy fixture',inputs:repo?[{github_repo:'acme/project',base_sha:'a'.repeat(40)}]:[],scope_paths:repo?['README.md']:[],expected_output:'one sentence',execution_scope:'read-only'});

test('missing profile and omitted repos deny admission and existing queued claims; text jobs work',{timeout:20000},async()=>{
 assert.equal(LEGACY_PROFILE.allowsRepo('dot','acme/project'),false);
 const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-legacy-repos-'));
 let child;
 try {
  for(const configured of [false,true]) {
   const home=path.join(scratch,configured?'omitted':'missing'),config=path.join(home,'.config/dot-bridge'),data=path.join(home,'.local/share/dot-bridge');
   fs.mkdirSync(config,{recursive:true,mode:0o700});fs.mkdirSync(data,{recursive:true,mode:0o700});
   const existing='req_legacy_existing',textId='req_legacy_text',rejected='req_legacy_rejected';
   const store=new Store(path.join(data,'bridge.db'));store.db.close();
   if(configured)fs.writeFileSync(path.join(config,'workers.json'),JSON.stringify({workers:{dot:{connections:[{issuer:'https://issuer.example',subject:'fixture',client_id:'fixture'}]}}}),{mode:0o600});
   child=spawn(process.execPath,['src/server.mjs'],{cwd:root,env:{HOME:home,PATH:process.env.PATH,DALAN_PORT:'0',DALAN_ALLOW_INSECURE_PUBLIC:'1',DALAN_BIND_HOST:'127.0.0.1',GITHUB_CLONE_BASE_URL:'http://127.0.0.1:1'},stdio:['ignore','pipe','pipe']});
   let out='',errors='',port;child.stdout.on('data',b=>{out+=b;port=Number(/MCP listening on [^\n]+:(\d+)/.exec(out)?.[1]);});child.stderr.on('data',b=>errors+=b);
   for(let i=0;i<200&&!port&&child.exitCode===null;i++)await new Promise(resolve=>setTimeout(resolve,25));assert(port,errors);
   const injected=new Store(path.join(data,'bridge.db'));injected.submit(assignment(existing,true),{mode:'none'},null,'fixture-owner');injected.db.close();
   const secret=/BRIDGE_PATH_SECRET=(.+)/.exec(fs.readFileSync(path.join(config,'env'),'utf8'))[1];
   const tool=async(name,args)=>(await(await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})})).json()).result;
   const submit=job=>new Promise((resolve,reject)=>{const bytes=JSON.stringify({assignment:job,owner_token:'fixture-owner',delivery:'none',execution:'none'});const req=http.request({socketPath:path.join(data,'admin.sock'),path:'/submit',method:'POST',headers:{'content-type':'application/json'}},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));});req.on('error',reject);req.end(bytes);});
   const denied=await submit(assignment(rejected,true));assert.equal(denied.status,400);assert.match(denied.body.error,/repository .* is not allowed/);
   const claim=await tool('claim',{request_id:existing,claimant:'legacy-worker'});assert.equal(claim.isError,true);assert.match(claim.content[0].text,/repository .* is not allowed/);
   const side=new Store(path.join(data,'bridge.db'));try{assert.equal(side.get(existing).status,'queued');assert.equal(side.hasAssignment(rejected),false);assert.equal(side.db.prepare('SELECT count(*) n FROM claims').get().n,0);}finally{side.db.close();}
   assert.equal((await submit(assignment(textId))).status,200);
   const text=await tool('claim',{request_id:textId,claimant:'legacy-worker'});assert.equal(text.isError,false);assert(JSON.parse(text.content[0].text).claim_id);
   await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');});child=null;
  }
 } finally {
  if(child&&child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');});
  fs.rmSync(scratch,{recursive:true,force:true});
 }
});
