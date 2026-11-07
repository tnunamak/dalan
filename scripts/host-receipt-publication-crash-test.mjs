import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const moduleUrl=process.env.HOST_RECEIPT_MODULE||new URL('../src/host-budget-receipts.mjs',import.meta.url).href;
const {prepareHostReceipts,writeHostStart,writeHostStop,readVerifiedHostStop}=await import(moduleUrl);
const root=fs.mkdtempSync(path.join(os.homedir(),'.tmp','receipt-crash-'));
const invocationId='a'.repeat(32);
try {
  for(const kind of ['start','stop','seal']) {
    const receiptDir=path.join(root,kind),checkRunId='check_'+kind;
    const options={...prepareHostReceipts({receiptDir,checkRunId}),invocationId};
    if(kind==='stop')writeHostStart(options);
    const code=`import fs from 'node:fs';const api=await import(process.argv[1]);const options=JSON.parse(process.argv[2]);
      const link=fs.linkSync.bind(fs);fs.linkSync=(...args)=>{link(...args);process.exit(89);};
      if(process.argv[3]==='start')api.writeHostStart(options);
      else if(process.argv[3]==='stop')api.writeHostStop({...options,verified:true,remaining_pids:[]});
      else api.sealHostNotStarted(options);`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',code,moduleUrl,JSON.stringify(options),kind],{encoding:'utf8',timeout:10000});
    assert.equal(child.status,89,child.stderr);
    const files=fs.readdirSync(receiptDir);assert(files.some(name=>name.startsWith('.receipt-')));
    if(kind==='start')writeHostStop({...options,verified:true,remaining_pids:[]});
    const recovered=readVerifiedHostStop({receiptDir,checkRunId});
    assert(recovered,'published '+kind+' survives crash before temporary alias unlink');
    assert.equal(recovered.verified,true);assert.deepEqual(recovered.remaining_pids,[]);
    assert.equal(fs.readdirSync(receiptDir).some(name=>name.startsWith('.receipt-')),false);
    for(const name of fs.readdirSync(receiptDir))assert.equal(fs.statSync(path.join(receiptDir,name)).nlink,1);
    console.log('PASS '+kind+' receipt crash between link publication and temporary unlink');
  }
  const options={...prepareHostReceipts({receiptDir:path.join(root,'external'),checkRunId:'check_external'}),invocationId};
  writeHostStart(options);writeHostStop({...options,verified:true,remaining_pids:[]});
  const stop=path.join(options.receiptDir,fs.readdirSync(options.receiptDir).find(x=>x.endsWith('.stop.json'))),external=path.join(root,'foreign-hard-link');
  fs.linkSync(stop,external);assert.equal(readVerifiedHostStop(options),null);assert(fs.existsSync(external));
  console.log('PASS unexplained external hard link stays refused and untouched');
  const concurrent={...prepareHostReceipts({receiptDir:path.join(root,'concurrent'),checkRunId:'check_concurrent'}),invocationId};
  writeHostStart(concurrent);
  const original=fs.linkSync;
  try {
    fs.linkSync=(...args)=>{original(...args);if(args[1].endsWith('.stop.json'))assert.equal(readVerifiedHostStop(concurrent)?.verified,true);};
    writeHostStop({...concurrent,verified:true,remaining_pids:[]});
  }finally{fs.linkSync=original;}
  assert.equal(readVerifiedHostStop(concurrent)?.verified,true);
  console.log('PASS reader recovery can race publisher cleanup without turning success into error');
}finally{fs.rmSync(root,{recursive:true,force:true});}
