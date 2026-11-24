import http from 'node:http';

// A bridge that stops answering leaves no trace in its own request log: a request that never reaches a handler is never logged.
// The probe asks the bridge's own loopback listener a question on a timer and records how long the answer took, plus how late the
// timer itself fired (the event loop's lag). A stall then shows up in the log and in `dalan status --json` as a number.
const answered = (url, timeoutMs) => new Promise(resolve => {
  const req = http.get(url, { agent: false, timeout: timeoutMs }, res => { res.resume(); res.once('end', () => resolve({ status: res.statusCode })); res.once('error', error => resolve({ error: error.code ?? 'error' })); });
  req.once('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
  req.once('error', error => resolve({ error: error.code ?? 'error' }));
});

export function createLoopbackProbe({
  url, log, intervalMs = 30000, slowMs = 1000, timeoutMs = 30000, heartbeatEvery = 10, keep = 120,
  request = answered, clock = () => Number(process.hrtime.bigint()) / 1e6, wall = () => new Date().toISOString(),
} = {}) {
  const samples = [];
  let timer = null, expectedAt = null, count = 0, running = false;
  const record = sample => { samples.push(sample); if (samples.length > keep) samples.shift(); };
  const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] : null;
  async function tick() {
    const lagMs = expectedAt === null ? 0 : Math.max(0, Math.round(clock() - expectedAt));
    if (running) return; running = true;
    try {
      const started = clock();
      const result = await request(typeof url === 'function' ? url() : url, timeoutMs);
      const ms = Math.round(clock() - started);
      const sample = { at: wall(), ms, lag_ms: lagMs, ...(result.error ? { error: result.error } : { status: result.status }) };
      record(sample); count++;
      if (result.error || ms >= slowMs || lagMs >= slowMs) log({ kind: 'loopback_probe_slow', ms, lag_ms: lagMs, ...(result.error ? { error: result.error } : { status: result.status }) });
      else if (count % heartbeatEvery === 0) {
        const recent = samples.slice(-heartbeatEvery);
        log({ kind: 'loopback_probe', samples: recent.length, p50_ms: percentile(recent.map(s => s.ms), 0.5), max_ms: Math.max(...recent.map(s => s.ms)), max_lag_ms: Math.max(...recent.map(s => s.lag_ms)) });
      }
    } finally { running = false; expectedAt = clock() + intervalMs; }
  }
  return {
    start() { if (timer === null) { expectedAt = clock() + intervalMs; timer = setInterval(() => { tick().catch(() => {}); }, intervalMs); timer.unref(); } return this; },
    stop() { if (timer !== null) { clearInterval(timer); timer = null; } },
    tick,
    // For `dalan status --json`: the last answer, and the worst of the samples kept (about an hour at the default interval).
    snapshot() {
      const last = samples.at(-1) ?? null;
      return { interval_ms: intervalMs, samples: samples.length, last, worst_ms: samples.length ? Math.max(...samples.map(s => s.ms)) : null, worst_lag_ms: samples.length ? Math.max(...samples.map(s => s.lag_ms)) : null, failures: samples.filter(s => s.error).length };
    },
  };
}
