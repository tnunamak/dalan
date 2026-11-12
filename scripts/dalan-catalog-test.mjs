import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';

const root=path.resolve(new URL('..',import.meta.url).pathname);
// The parent fixture holds the tools that must survive an upgrade. The earlier notification alias is not among them: it was removed,
// and `notify_owner` is the only notification tool.
// Catalog v2 added annotations and the `list_tools`, `call_tool_read` and `call_tool_write` registry tools; list_files gained paging earlier.
// The upgrade check allows only the explicitly announced descriptor changes below.
const parentTools=JSON.parse(fs.readFileSync(new URL('./fixtures/catalog.pre-dalan.schemas.json',import.meta.url))).map(tool=>tool.name!=='list_files'?tool:{...tool,description:"List files in this assignment's checked-out repository workspace. Read-only; scoped to the assignment. When truncated is true, pass next_cursor as cursor to get the next page.",inputSchema:{...tool.inputSchema,properties:{...tool.inputSchema.properties,cursor:{type:'string',maxLength:1024}}}});
// Announced changes: optional/long finish summary, long progress note, and a 90-second modern T3 wait bound.
const announcedWait=tool=>({...tool,description:'Wait at most 90 seconds for a T3 turn; returns partial state on timeout.',inputSchema:{...tool.inputSchema,properties:{...tool.inputSchema.properties,timeoutMs:{...tool.inputSchema.properties.timeoutMs,maximum:90000}}}});
const announced={
 t3_thread_wait:announcedWait,
 finish:tool=>({...tool,description:tool.description+' summary is optional: when absent it is the first line of result, and one over 4096 bytes is cut.',inputSchema:{...tool.inputSchema,required:tool.inputSchema.required.filter(name=>name!=='summary'),properties:{...tool.inputSchema.properties,summary:{...tool.inputSchema.properties.summary,maxLength:262144}}}}),
 progress:tool=>({...tool,description:tool.description+' A note over 4096 bytes is cut.',inputSchema:{...tool.inputSchema,properties:{...tool.inputSchema.properties,note:{...tool.inputSchema.properties.note,maxLength:262144}}}}),
};
const v1Surface=tool=>{const {annotations,...rest}=tool;return rest;};
const legacy=JSON.parse(fs.readFileSync(new URL('./fixtures/catalog.legacy-v46.tools.json',import.meta.url)));
const schemas=tools=>tools.map(({name,inputSchema})=>({name,inputSchema}));
for(const [index,tool] of parentTools.entries())if(announced[tool.name])parentTools[index]=announced[tool.name](tool);
const frozen=schemas(parentTools);

// This is an explicit opt-in upgrade: no claim is made that an unchanged install keeps T3 enabled.
test('explicit T3 opt-in allows only announced schema changes; default refuses reverse control',{timeout:45000},async()=>{
 const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-catalog-')),running=new Set(),notices=[];
 const ntfy=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;notices.push(body);res.end('ok');});
 await new Promise(resolve=>ntfy.listen(0,'127.0.0.1',resolve));
 const t3Stub=path.join(scratch,'t3code');
 fs.writeFileSync(t3Stub,'#!/usr/bin/env node\nrequire("fs").writeFileSync(require("path").join(process.env.HOME,"t3-called"),"called");process.exit(99);\n',{mode:0o755});
 const notice=(server,name,text)=>server.rpc('tools/call',{name,arguments:{text},_meta:{'dot-bridge/idempotencyKey':'upgrade-notice'}});
 async function start(codeRoot,home,profile,enable,extra={}) {
  const env={HOME:home, DALAN_LEGACY_PROFILE: '1',PATH:process.env.PATH,NODE_ENV:'test',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_PORT:'0',DOT_BRIDGE_CATALOG_PROFILE:profile,DOT_BRIDGE_T3CODE_BIN:t3Stub,...extra};
  if(enable!==undefined)env[profile==='questions-v1'?'DOT_BRIDGE_ENABLE_T3_TOOLS':'DALAN_ENABLE_T3_TOOLS']=enable;
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:codeRoot,env,stdio:['ignore','pipe','pipe']});running.add(child);
  let output='',errors='',port;
  child.stdout.on('data',chunk=>{output+=chunk;port=Number(/MCP listening on [^\n]+:(\d+)/.exec(output)?.[1])||null;});
  child.stderr.on('data',chunk=>errors+=chunk);
  for(let i=0;i<200&&!port&&child.exitCode===null;i++)await new Promise(resolve=>setTimeout(resolve,25));
  assert(port,'catalog server did not start: '+errors);
  const secret=/BRIDGE_PATH_SECRET=(.+)/.exec(fs.readFileSync(path.join(home,'.config/dot-bridge/env'),'utf8'))[1];
  const rpc=async(method,params={})=>(await(await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json()).result;
  return {rpc,get stderr(){return errors;},tools:async()=>(await rpc('tools/list')).tools,stop:async()=>{if(child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');});running.delete(child);}};
 }
 try {
  for(const profile of ['stable','questions-v1','protocol-v0','legacy-v46']) {
   const home=path.join(scratch,profile);fs.mkdirSync(path.join(home,'.config/dot-bridge'),{recursive:true,mode:0o700});
   fs.writeFileSync(path.join(home,'.config/dot-bridge/alerts.env'),`NTFY_URL=http://127.0.0.1:${ntfy.address().port}/alerts\n`,{mode:0o600});
   let beforeTools=profile==='stable'?parentTools:null;
   let before=profile==='stable'?frozen:profile==='legacy-v46'?schemas(legacy):null;
   if(process.env.DALAN_TEST_UPGRADE_FROM) {
    const old=await start(process.env.DALAN_TEST_UPGRADE_FROM,home,profile);beforeTools=(await old.tools()).filter(tool=>parentTools.some(kept=>kept.name===tool.name));if(profile!=='legacy-v46')beforeTools=beforeTools.map(tool=>tool.name==='t3_thread_wait'?announcedWait(tool):tool);before=schemas(beforeTools);await old.stop();
   }
   const off=await start(root,home,profile),offTools=await off.tools();
   assert.match(off.stderr,/startup WARNING: worker "dot".*DALAN_ENABLE_T3_TOOLS=1/,profile+' silently removed reverse control');
   assert(offTools.every(tool=>!tool.name.startsWith('t3_')),profile+' advertises T3 by default');
   const refusal=await off.rpc('tools/call',{name:'t3_thread_list',arguments:{}});
   assert.equal(refusal.isError,true);assert.match(refusal.content[0].text,/unknown tool/);assert(!fs.existsSync(path.join(home,'t3-called')),'disabled reverse control dispatched');
   for(const [name,args] of [
    ['t3_thread_list',{status:'all'}],['t3_thread_read',{threadId:'thread_fake'}],['t3_thread_create',{prompt:'x'}],
    ['t3_thread_send',{threadId:'thread_fake',message:'x'}],['t3_thread_wait',{threadId:'thread_fake'}],['t3_thread_set',{threadId:'thread_fake'}],
   ]) { const denied=await off.rpc('tools/call',{name,arguments:args});assert.equal(denied.isError,true,name+' must be hidden when disabled');assert.match(denied.content[0].text,/unknown tool/,name); }
   assert(!fs.existsSync(path.join(home,'t3-called')),'a disabled direct call invoked t3code');
   if(profile==='stable'&&!process.env.DALAN_TEST_UPGRADE_FROM)assert.equal((await notice(off,'notify_owner','before restart')).isError,false);
   await off.stop();
   const enabled=await start(root,home,profile,'1'),actualTools=await enabled.tools(),actual=schemas(actualTools);
   if(beforeTools)assert.deepEqual(actualTools.filter(tool=>!['notify_owner','list_tools','call_tool_read','call_tool_write'].includes(tool.name)).map(v1Surface),beforeTools,profile+' changed an existing tool field despite explicit T3 opt-in');
   if(profile==='stable') {
    const replay=await notice(enabled,'notify_owner','changed text after upgrade');
    assert.equal(replay.isError,false);assert.deepEqual(JSON.parse(replay.content[0].text),{notified:true});assert.equal(notices.length,1,'alias sent a duplicate after restart');
    const db=new DatabaseSync(path.join(home,'.local/share/dot-bridge/bridge.db'),{readOnly:true});
    try {for(const name of ['notify_owner'])assert(db.prepare("SELECT 1 FROM t3_audit WHERE tool=? AND result_status='success'").get(name),name+' missing audit');}finally{db.close();}
   }
   if(before) {
    const names=new Set(before.map(tool=>tool.name));
    assert.deepEqual(actual.filter(tool=>names.has(tool.name)).map(v1Surface),before,profile+' lost an old name or input schema');
    assert.deepEqual(actual.filter(tool=>!names.has(tool.name)).map(tool=>tool.name),profile==='legacy-v46'?[]:['notify_owner','list_tools','call_tool_read','call_tool_write']);
   }
   if(profile==='legacy-v46')assert.deepEqual(actual,schemas(legacy));
   else {assert(actual.some(tool=>tool.name==='notify_owner'));assert.equal(actual.filter(tool=>tool.name.startsWith('notify')).length,1,'only notify_owner is advertised');assert.equal(actual.filter(tool=>tool.name.startsWith('t3_')).length,6);}
   await enabled.stop();
   assert(!fs.existsSync(path.join(home,'.config/dalan')),'catalog upgrade orphaned its old home');
  }
  for(const [label,enable,extra,expected] of [
   ['legacy-on',undefined,{DOT_BRIDGE_ENABLE_T3_TOOLS:'1'},true],
   ['legacy-off',undefined,{DOT_BRIDGE_ENABLE_T3_TOOLS:'0'},false],
   ['canonical-off-wins', '0',{DOT_BRIDGE_ENABLE_T3_TOOLS:'1'},false],
   ['canonical-on-wins', '1',{DOT_BRIDGE_ENABLE_T3_TOOLS:'0'},true],
  ]) {
   const home=path.join(scratch,label);fs.mkdirSync(path.join(home,'.config/dot-bridge'),{recursive:true,mode:0o700});
   const server=await start(root,home,'stable',enable,extra);
   try {
    const names=(await server.tools()).map(tool=>tool.name);assert.equal(names.filter(name=>name.startsWith('t3_thread_')).length,expected?6:0,label+' gate result');
    if(!expected) {
     for(const [name,args] of [
      ['t3_thread_list',{status:'all'}],['t3_thread_read',{threadId:'thread_fake'}],['t3_thread_create',{prompt:'x'}],
      ['t3_thread_send',{threadId:'thread_fake',message:'x'}],['t3_thread_wait',{threadId:'thread_fake'}],['t3_thread_set',{threadId:'thread_fake'}],
     ]) { const denied=await server.rpc('tools/call',{name,arguments:args});assert.equal(denied.isError,true,label+': '+name);assert.match(denied.content[0].text,/unknown tool/,label+': '+name); }
     assert(!fs.existsSync(path.join(home,'t3-called')),label+' direct call invoked t3code');
    }
   }
   finally { await server.stop(); }
  }
  {
   const home=path.join(scratch,'without-t3-capability'),config=path.join(home,'.config/dot-bridge');fs.mkdirSync(config,{recursive:true,mode:0o700});
   const workersFile=path.join(config,'workers.json');fs.writeFileSync(workersFile,JSON.stringify({workers:{dot:{connections:[{issuer:'issuer',subject:'subject',client_id:'client'}]}}}),{mode:0o600});
   const server=await start(root,home,'stable','1',{DALAN_WORKERS_FILE:workersFile});
   try {
    const denied=await server.rpc('tools/call',{name:'t3_thread_list',arguments:{status:'all'}});
    assert.equal(denied.isError,true);assert.match(denied.content[0].text,/worker_capability_denied/);
    assert(!fs.existsSync(path.join(home,'t3-called')),'a worker without the t3 capability invoked t3code');
   } finally { await server.stop(); }
  }
  const emptyHome=path.join(scratch,'empty-catalog');fs.mkdirSync(path.join(emptyHome,'.config/dot-bridge'),{recursive:true,mode:0o700});
  const empty=await start(root,emptyHome,'legacy-v46',undefined,{DALAN_CATALOG_PROFILE:''});
  assert.equal((await empty.rpc('initialize')).serverInfo.name,'dalan','empty new catalog setting intentionally selects stable, overriding the legacy pin');
  assert((await empty.tools()).some(tool=>tool.name==='notify_owner'));await empty.stop();
 } finally {
  for(const child of running)if(child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');});
  await new Promise(resolve=>ntfy.close(resolve));
  fs.rmSync(scratch,{recursive:true,force:true});
 }
});

test('invalid reverse-control values fail before serving',()=>{
 for(const value of ['yes','']) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-bad-t3-'));
  try {
   const result=spawnSync(process.execPath,['src/server.mjs'],{cwd:root,env:{HOME:home,DALAN_LEGACY_PROFILE:'1',PATH:process.env.PATH,DALAN_PORT:'0',DALAN_ALLOW_INSECURE_PUBLIC:'1',DALAN_BIND_HOST:'127.0.0.1',DALAN_ENABLE_T3_TOOLS:value},encoding:'utf8',timeout:5000});
   assert.notEqual(result.status,0);assert.match(result.stderr,/DALAN_ENABLE_T3_TOOLS must be 0 or 1/);assert(!result.stdout.includes('MCP listening'));
  } finally {fs.rmSync(home,{recursive:true,force:true});}
 }
});
