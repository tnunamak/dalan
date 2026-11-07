import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readEnv} from './env.mjs';

const areas=['.config','.local/share','.local/state'];
const components={
  '.config':['env','operator.key','workers.json','workers-repos.json','workers-audit.jsonl','limits.json','alerts.env','acp-secret','oauth.env','as.json','as-jwks.json','as-cookie-keys.json','as-storage.key','as.sqlite'],
  '.local/share':['bridge.db','delivery-acks.db','notify-sent.db','bridge.db.secrets/storage.key','receipts','artifact-index'],
  '.local/state':['requests.jsonl'],
  '.tmp':['artifacts','host-receipts'],
};
function info(file) {
  try {return fs.lstatSync(file);} catch(error) {if(error.code==='ENOENT')return null;throw error;}
}
function populated(file) {
  const stat=info(file);
  if(!stat)return false;
  if(['.keep','.gitkeep','.DS_Store'].includes(path.basename(file))||/^as-owner\.sqlite(?:-(?:wal|shm))?$/.test(path.basename(file)))return false;
  if(stat.isDirectory())return fs.readdirSync(file).some(name=>populated(path.join(file,name)));
  // Empty placeholder files and directory scaffolding do not initialize a root.
  // Do not follow symlinks: an explicitly linked root is an operator choice.
  return !stat.isFile()||stat.size>0;
}
// Signal tokens rotate between the shared signal-token and per-worker signal-token.<worker> files, and stale copies can
// remain. A root that had any signal token needs at least one in its replacement, not the same file names.
const signalToken=/^signal-token(?:\.[a-z][a-z0-9_-]{0,31})?$/;
function hasSignalToken(dir) {
  try {return fs.readdirSync(dir).some(name=>signalToken.test(name)&&populated(path.join(dir,name)));}
  catch(error) {if(error.code==='ENOENT'||error.code==='ENOTDIR')return false;throw error;}
}
function initialized(current,legacy,area) {
  return populated(current)&&(components[area]??[]).every(name=>!populated(path.join(legacy,name))||populated(path.join(current,name)))
    &&(area!=='.config'||!hasSignalToken(legacy)||hasSignalToken(current));
}
// Choose one complete root; never fill missing keys or databases from its sibling.
// Empty new scaffolding cannot hide an existing installation's durable state.
export function defaultPath(home, relative, ...tail) {
  const parts=relative.split('/'),index=parts.findIndex(part=>/^\.?dot-bridge(?:\.|$)/.test(part));
  if(index<0)throw new Error('defaultPath requires a legacy product path');
  const oldRoot=path.join(home,...parts.slice(0,index+1));
  const newRoot=path.join(home,...parts.slice(0,index),parts[index].replace('dot-bridge','dalan'));
  let root=newRoot;
  const area=parts.slice(0,index).join('/');
  if(!initialized(newRoot,oldRoot,area)) {
    const legacyInstall=areas.some(area=>info(path.join(home,area,'dot-bridge')));
    const currentInstall=areas.some(area=>initialized(path.join(home,area,'dalan'),path.join(home,area,'dot-bridge'),area));
    if(populated(oldRoot)||info(oldRoot)&&!info(newRoot)||legacyInstall&&!currentInstall)root=oldRoot;
  }
  return path.join(root,...parts.slice(index+1),...tail);
}
export function workspaceRoot(home=os.homedir(),env=process.env) {
  return readEnv('DALAN_WORKSPACE_ROOT',env)||defaultPath(home,'.tmp/dot-bridge');
}
// Observe the existing choice without merging roots or reading private file contents.
export function rootWarnings(home=os.homedir()) {
  return areas.flatMap((parent,index)=>{
    const legacy=path.join(home,parent,'dot-bridge'),current=path.join(home,parent,'dalan');
    const chosen=defaultPath(home,parent+'/dot-bridge');
    if(chosen!==legacy||!populated(current))return [];
    const missing=components[parent].filter(name=>populated(path.join(legacy,name))&&!populated(path.join(current,name)));
    if(parent==='.config'&&hasSignalToken(legacy)&&!hasSignalToken(current)) {
      missing.push(...fs.readdirSync(legacy).filter(name=>signalToken.test(name)&&populated(path.join(legacy,name))).sort());
    }
    return [{area:['config','data','state'][index],chosen,passed_over:current,missing}];
  });
}
