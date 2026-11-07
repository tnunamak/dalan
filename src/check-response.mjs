// Scheduling affects only how long callers wait, never the check's execution timeout.
export const CHECK_RESPONSE_MS = 20000;
export async function checkResponse(work, running, {
  responseMs = CHECK_RESPONSE_MS,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  if (!Number.isFinite(responseMs) || responseMs < 0)
    throw new TypeError('responseMs must be a non-negative finite number');
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise(resolve => { timer = schedule(() => resolve(running), responseMs); }),
    ]);
  } finally {
    if (timer !== undefined) cancel(timer);
  }
}
