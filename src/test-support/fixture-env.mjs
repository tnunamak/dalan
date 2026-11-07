import fs from 'node:fs';
import path from 'node:path';
export function fixtureEnv(home, extra={}) {
  for(const dir of ['tmp','.tmp','.cache','.config','.local/share','.local/state'])
    fs.mkdirSync(path.join(home,dir),{recursive:true});
  return {
    PATH:path.dirname(process.execPath)+':/usr/bin:/bin',
    HOME:home,TMPDIR:path.join(home,'tmp'),LANG:'C.UTF-8',TZ:'UTC',
    XDG_CONFIG_HOME:path.join(home,'.config'),
    XDG_CACHE_HOME:path.join(home,'.cache'),
    XDG_DATA_HOME:path.join(home,'.local/share'),
    XDG_STATE_HOME:path.join(home,'.local/state'),
    GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',
    DOT_BRIDGE_T3_DRY_RUN:'1',DALAN_LEGACY_PROFILE:'1',...extra,
  };
}
