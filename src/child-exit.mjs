// A ChildProcess can emit `error` while its PID is still alive (for example, a failed signal).
// Only `close` proves a started process ended. Spawn failure has no PID and needs no wait.
export function waitForChildExit(child, { onError = () => {}, onClose = () => {} } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = (...args) => {
      if (settled) return;
      settled = true;
      onClose(...args);
      resolve();
    };
    child.once('close', (...args) => finish(...args));
    child.once('error', error => {
      onError(error);
      if (!Number.isInteger(child.pid) || child.pid <= 0) finish();
    });
  });
}
