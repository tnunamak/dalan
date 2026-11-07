import { isMainThread } from 'node:worker_threads';
// Keep compatibility at the read boundary: callers never need to copy or mutate secrets.
let warned=false;
function warnLegacy() {
  if(isMainThread&&!warned) {warned=true;console.error('DOT_BRIDGE_* environment settings are deprecated; use DALAN_* instead.');}
}
// Submission scanners use worker threads; only the main thread emits notices.
export function readEnv(name, env=process.env) {
  const suffix=name.startsWith('DOT_BRIDGE_')?name.slice(11):name.startsWith('DALAN_')?name.slice(6):null;
  if(suffix===null) return env[name];
  const current=`DALAN_${suffix}`,legacy=`DOT_BRIDGE_${suffix}`;
  // An empty auth template must not mask an existing authenticated deployment.
  if(env[current]!==undefined && !(suffix==='AUTH_MODE'&&env[current]==='')) return env[current];
  if(env[legacy]!==undefined && !(suffix==='AUTH_MODE'&&env[legacy]==='')) {
    warnLegacy();
    return env[legacy];
  }
  return undefined;
}
