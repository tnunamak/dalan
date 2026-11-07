// Plain syntax on purpose: this file must load on an old Node so that `dalan` can say why it will not run,
// instead of crashing inside a module that needs a newer Node (node:sqlite) or a different platform.
export const MIN_NODE_MAJOR = 24;

// A one-line reason the `dalan` command cannot run here, or null when it can.
export function unsupportedRuntime({ nodeVersion = process.versions.node, platform = process.platform } = {}) {
  if (platform === 'win32') return 'dalan runs on Linux and macOS only. On Windows, use WSL (Windows Subsystem for Linux).';
  const major = Number(String(nodeVersion).split('.')[0]);
  if (!(major >= MIN_NODE_MAJOR)) {
    return `dalan needs Node.js ${MIN_NODE_MAJOR} or newer; this is Node.js ${nodeVersion}. Install a newer one from https://nodejs.org/en/download and run the command again.`;
  }
  return null;
}
