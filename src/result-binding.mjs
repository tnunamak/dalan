const fail=c=>{throw Object.assign(new Error(c),{code:c});};
const str=v=>typeof v==='string'&&v.length>0;
const nat=v=>Number.isSafeInteger(v)&&v>=0;
function canon(v){
 if(v===null||typeof v==='boolean'||typeof v==='string')return v;
 if(typeof v==='number'&&Number.isFinite(v))return v;
 if(Array.isArray(v))return v.map(canon);
 if(v&&Object.getPrototypeOf(v)===Object.prototype)return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])]));
 fail('invalid_json');
}
const json=v=>JSON.stringify(canon(v));
export function migrateResultBindings(db){
 if(!db.isTransaction)fail('transaction_required');
 db.exec('CREATE TABLE IF NOT EXISTS immutable_result_bindings(job TEXT PRIMARY KEY,identity TEXT NOT NULL,receipt TEXT NOT NULL)');
}
// No physical process-stop claim is derived from terminal assignment state.
export function terminalAuthority(native){
 const terminal=['finished','cancelled','deleted'].includes(native?.status);
 return {status:native?.status??'unknown',live_authority:terminal?false:null,
  result_authority:native?.status==='finished'&&native?.late!==true,
  compute_stopped:typeof native?.compute_stopped==='boolean'?native.compute_stopped:null};
}
export function createResultBindings({db,authorize,readIntent,readArtifact,readTerminal}){
 if([authorize,readIntent,readArtifact,readTerminal].some(f=>typeof f!=='function'))fail('callbacks_required');
 function bind(input,publish){
  if(!db.isTransaction)fail('transaction_required');
  const {job,subject,worker,claim,epoch,source,policy,outcome,summary,result,artifacts}=input;
  if(![job,subject,worker,claim,source,policy].every(str)||!nat(epoch)||epoch<1||
    !['completed','blocked','failed'].includes(outcome)||typeof summary!=='string'||typeof result!=='string'||!Array.isArray(artifacts))fail('invalid_result');
  const old=db.prepare('SELECT * FROM immutable_result_bindings WHERE job=?').get(job);
  // The retained-receipt branch must bind original worker/subject/claim, not require live lease.
  if(authorize({job,subject,worker,claim,epoch,mode:old?'receipt':'live'})!==true)fail('unauthorized');
  const identity=json(input);
  if(old){
   if(old.identity!==identity)fail('result_conflict');
   return {...JSON.parse(old.receipt),duplicate:true,authority:terminalAuthority(readTerminal(job))};
  }
  const intent=readIntent(job);
  if(!intent||typeof intent.source!=='string'||typeof intent.policy!=='string'||source!==intent.source||policy!==intent.policy)fail('binding_mismatch');
  const ids=new Set();
  for(const ref of artifacts){
   if(!ref||!str(ref.id)||!str(ref.origin_claim)||!nat(ref.origin_epoch)||ref.origin_epoch<1||
      !/^[a-f0-9]{64}$/.test(ref.sha256??'')||!nat(ref.size)||ids.has(ref.id)||
      Object.keys(ref).some(k=>!['id','origin_claim','origin_epoch','sha256','size'].includes(k)))fail('invalid_artifact_reference');
   ids.add(ref.id);
   const native=readArtifact({job,id:ref.id});
   if(!native||native.sealed!==true||native.job!==job||native.id!==ref.id||
      native.sha256!==ref.sha256||native.size!==ref.size||native.origin_claim!==ref.origin_claim||
      native.origin_epoch!==ref.origin_epoch)fail('artifact_binding_mismatch');
  }
  if(input.evidence!==undefined){
   if(!Array.isArray(input.evidence)||input.evidence.some(e=>!e||e.trust!=='worker_attested'||typeof e.statement!=='string'||
      Object.keys(e).some(k=>!['trust','statement'].includes(k))))fail('worker_evidence_cannot_be_verified');
  }
  if(typeof publish!=='function')fail('publish_required');
  // Trusted Store hook performs finishOnce in THIS transaction after all binding checks.
  const receipt=publish({job,subject,worker,claim,epoch,outcome,summary,result,artifacts,source,policy,evidence:input.evidence??[]});
  if(!receipt||typeof receipt.then==='function'||!str(receipt.receipt_id)||receipt.late===true)fail('invalid_native_receipt');
  const terminal=readTerminal(job);
  if(terminal?.status!=='finished'||terminal.late===true)fail('native_result_not_terminal');
  db.prepare('INSERT INTO immutable_result_bindings VALUES(?,?,?)').run(job,identity,json(receipt));
  return {...receipt,duplicate:false,authority:terminalAuthority(terminal)};
 }
 return {bind};
}
