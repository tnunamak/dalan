// Environment for the bridge's own git calls on mirrors and workspaces. They run outside the check sandbox, so neither the host's
// git configuration nor repository content may choose code for them to run: no system or global config (hooks via core.hooksPath,
// filter and LFS drivers, fsmonitor, external diff, url rewrites), no system attributes, and hooks and fsmonitor are off even if a
// repository-level config names them. Inherited GIT_* variables (GIT_CONFIG_PARAMETERS from a parent `git -c`, GIT_EXTERNAL_DIFF,
// GIT_DIR, ...) are dropped, except the two the bridge sets itself for private-repository fetches. Environment-supplied config outranks
// every config file. Mirror-local config is bridge-owned: the bridge creates it, and neither a worker nor the check sandbox can reach it.
// Git reads $XDG_CONFIG_HOME/git/ignore and git/attributes (default <config>/git/) even with no global config file, so both are
// pointed at /dev/null: a host ignore pattern such as CLAUDE.md must not drop a worker-written file from the patch.
const kept=new Set(['GIT_ASKPASS','GIT_TERMINAL_PROMPT']);
export function gitEnv(base=process.env) {
  const env=Object.fromEntries(Object.entries(base).filter(([key])=>!key.startsWith('GIT_')||kept.has(key)));
  return {...env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ATTR_NOSYSTEM:'1',
    GIT_CONFIG_COUNT:'4',GIT_CONFIG_KEY_0:'core.hooksPath',GIT_CONFIG_VALUE_0:'/dev/null',GIT_CONFIG_KEY_1:'core.fsmonitor',GIT_CONFIG_VALUE_1:'false',
    GIT_CONFIG_KEY_2:'core.excludesFile',GIT_CONFIG_VALUE_2:'/dev/null',GIT_CONFIG_KEY_3:'core.attributesFile',GIT_CONFIG_VALUE_3:'/dev/null'};
}
