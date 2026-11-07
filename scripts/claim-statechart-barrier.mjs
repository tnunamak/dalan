// Test-only gate at the actual awaited server finish boundary. No production source changes.
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const {Workspace}=await import(pathToFileURL(path.join(process.cwd(),'src/workspace.mjs')).href);
const original=Workspace.prototype.makeRoom;
Workspace.prototype.makeRoom=async function(id,...args) {
  if(id==='req_http_revoke_finish') {
    process.send?.({barrier:id});
    // Bounded: if the parent test dies or times out, release the gate rather than hang this server forever.
    await new Promise(resolve=>{const timer=setTimeout(resolve,30000);process.once('message',()=>{clearTimeout(timer);resolve();});});
  }
  return original.call(this,id,...args);
};
