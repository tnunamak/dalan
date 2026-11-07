// The short, plain `dalan status` output. Pure: it reads the /status document and returns text. `dalan status --json`
// prints the full document instead, so nothing here is a contract for scripts.

import path from 'node:path';
import { docsUrl } from './docs-url.mjs';

const CONNECT_URL = docsUrl('README.md', 'connect-your-own-worker');

export function age(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172_800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} days`;
}

const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

const countOf = (counts, status) => (counts ?? []).find(c => c.status === status)?.count ?? 0;

// The status document cannot tell which client made a worker's last call (after `dalan try` it is the demo worker), so
// the line reports when the worker last called, not whether "your" worker is connected.
function workerLine(name, w, { now, oldestMs }) {
  const last = w.last_call_at ? Date.parse(w.last_call_at) : NaN;
  const connection = [(w.subscriptions_active ?? 0) > 0 ? 'subscribed' : null, Number.isFinite(last) ? `last call ${age(now - last)} ago` : 'no calls yet'].filter(Boolean).join(', ');
  const queued = countOf(w.counts, 'queued'), claimed = countOf(w.counts, 'claimed'), finished = countOf(w.counts, 'finished');
  const others = (w.counts ?? []).filter(c => !['queued', 'claimed', 'finished'].includes(c.status) && c.count > 0).map(c => `${c.count} ${String(c.status).replaceAll('_', ' ')}`);
  const parts = [connection, `${queued} queued${queued && oldestMs != null ? ` (oldest ${age(oldestMs)})` : ''}`,
    ...(claimed ? [`${claimed} in progress`] : []), ...others, `${finished} finished`];
  return { text: `Worker ${name}: ${parts.join(' · ')}`, queued, total: (w.counts ?? []).reduce((n, c) => n + c.count, 0) };
}

// status: the /status document. home: the bridge home. url: the bridge's public origin, or null. trial: a `dalan try` home.
// cli: how to name this CLI in the commands it prints (`dalan`, `npx dalan` or node and a path).
export function formatStatusSummary(status, { home, url = null, trial = false, now = Date.now(), cli = 'dalan', envHome = null } = {}) {
  const byWorker = Object.entries(status?.by_worker ?? {}).sort(([a], [b]) => a.localeCompare(b));
  // The bridge reports the oldest queued age for all workers together, so it is shown only when one worker has queued work.
  const queuedWorkers = byWorker.filter(([, w]) => countOf(w.counts, 'queued') > 0);
  const oldestMs = queuedWorkers.length === 1 ? status?.oldest_queue_age_ms ?? null : null;
  const workers = byWorker.map(([name, w]) => workerLine(name, w, { now, oldestMs: queuedWorkers[0]?.[0] === name ? oldestMs : null }));
  const paused = status?.paused === true;
  const lines = [`Bridge: ${paused ? 'running, paused' : 'running'}${url ? ` on ${url}` : ''} (${trial ? 'trial home' : 'home'} ${home})${paused && status.pause_reason ? `. Pause reason: ${status.pause_reason}` : ''}`,
    ...(workers.length ? workers.map(w => w.text) : ['Workers: none yet'])];
  const total = workers.reduce((n, w) => n + w.total, 0) || (status?.counts ?? []).reduce((n, c) => n + c.count, 0);
  const next = paused ? `resume handing out jobs: ${cli} resume`
    : workers.some(w => w.queued) ? `send your worker the queued job (to connect a worker first, see ${CONNECT_URL}); list your jobs: ${cli} inbox --all`
      : total ? `see what needs you: ${cli} inbox --all`
        : `queue a job: ${cli} submit --help`;
  // A trial home is never picked up without DALAN_HOME, and a status run as `DALAN_HOME=... dalan status` leaves the
  // shell without it. A process cannot see its parent shell, so a trial summary always says how to select the home:
  // a command, true in every shell. Other homes are chosen deliberately and get no line.
  const select = trial && (!envHome || path.resolve(envHome) !== path.resolve(home)) ? [`In this shell, select this bridge home: export DALAN_HOME=${shellQuote(home)}`] : [];
  return [...lines, ...select, `Next: ${next}`, `Full detail: ${cli} status --json`].join('\n');
}
