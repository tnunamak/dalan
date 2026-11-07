// Send a signal to a process that may already have exited. ESRCH means it is gone, which is the goal.
export function killIfAlive(pid, signal) {
  try { process.kill(pid, signal); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

// Stop an owned fixture child, including one whose signal-exit event already fired.
export async function stopChild(child, { signal = 'SIGTERM', graceMs = 1000, killMs = 1000 } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  let onExit;
  const exited = new Promise(resolve => { onExit = resolve; child.once('exit', onExit); });
  const within = async ms => {
    let timer;
    try { return await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    child.kill(signal);
    if (await within(graceMs)) return;
    child.kill('SIGKILL');
    if (!await within(killMs)) throw new Error(`fixture child ${child.pid} did not exit after SIGKILL`);
  } finally { child.removeListener('exit', onExit); }
}
