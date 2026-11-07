import { defaultPath } from './paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validT3ThreadId } from './delivery.mjs';

// Protected T3 destinations: operator admission on submit, quiet retention at delivery.
export function loadMainThreadIds(file=defaultPath(os.homedir(),'.config/dot-bridge/limits.json')) {
  if(!fs.existsSync(file)) return [];
  if((fs.statSync(file).mode&0o777)!==0o600) throw new Error('limits policy must be mode 0600');
  const ids=JSON.parse(fs.readFileSync(file,'utf8')).main_thread_ids??[];
  if(!Array.isArray(ids)||ids.some(x=>!validT3ThreadId(x))) throw new Error('invalid main_thread_ids');
  return ids;
}

export function loadBackgroundMaxInFlight(file=defaultPath(os.homedir(),'.config/dot-bridge/limits.json')) {
  if(!fs.existsSync(file)) return 4;
  if((fs.statSync(file).mode&0o777)!==0o600) throw new Error('limits policy must be mode 0600');
  const limit=JSON.parse(fs.readFileSync(file,'utf8')).background_max_in_flight??4;
  if(!Number.isInteger(limit)||limit<1||limit>10) throw new Error('invalid background_max_in_flight');
  return limit;
}

// Backstop for agents that sweep T3 history: off makes the read tools answer with a short stub.
export function t3ReadToolsOff(file=defaultPath(os.homedir(),'.config/dot-bridge/limits.json')) {
  if(!fs.existsSync(file)) return false;
  if((fs.statSync(file).mode&0o777)!==0o600) throw new Error('limits policy must be mode 0600');
  const value=JSON.parse(fs.readFileSync(file,'utf8')).t3_read_tools??'on';
  if(value!=='on'&&value!=='off') throw new Error('invalid t3_read_tools');
  return value==='off';
}
