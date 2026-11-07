
// The short terminal view of `dalan get`. Report text comes from a worker, so the caller prints it through
// terminalSafe. A job that is not finished gets the command that moves it on, never a decision.
export function formatGetSummary(job, { id, cli }) {
  const state = job.status ?? 'unknown';
  const report = job.report ?? null;
  const lines = [`Job ${id}: ${state}`];
  if (job.target_worker) lines.push(`Worker: ${job.target_worker}`);
  if (report?.outcome && report.outcome !== 'done') lines.push(`Outcome: ${report.outcome}`);
  if (report?.summary) lines.push(`Summary: ${report.summary}`);
  if (report?.result) lines.push('', report.result);
  // BLOCKED: and QUESTION: progress notes are how a worker asks the owner for something; a running job shows them.
  const asks = state === 'finished' || state === 'cancelled' ? [] : (job.progress ?? []).map(p => p?.note).filter(n => typeof n === 'string' && /^\s*(?:BLOCKED:|QUESTION:)/i.test(n));
  if (asks.length) lines.push('', 'Worker asks or is blocked:', ...asks.slice(-3).map(n => `  ${n.trim()}`), `Answer with: ${cli} note ${id} "TEXT"`);
  const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const artifacts = (job.artifacts?.length ?? 0) || (job.artifact_ids?.length ?? 0), checks = job.checks?.length ?? 0;
  if (artifacts || checks) lines.push('', `Evidence: ${[artifacts && count(artifacts, 'artifact'), checks && count(checks, 'check')].filter(Boolean).join(', ')}`);
  const next = state === 'finished' ? `${cli} decide ${id} accepted`
    : state === 'cancelled' ? null
    : `${cli} wait ${id} --timeout 3600, then ${cli} get ${id}`;
  if (next) lines.push('', `Next: ${next}`);
  lines.push(`Full record: ${cli} get ${id} --json`);
  return lines.join('\n');
}

// `dalan wait` on a terminal: one line, in place of the JSON status document.
export function formatWaitLine(result, { id, cli, seconds }) {
  const state = result?.status ?? 'unknown';
  if (state === 'timeout') return `Job ${id}: still open after ${seconds} s. Wait longer with: ${cli} wait ${id} --timeout 3600`;
  const tail = state === 'cancelled' ? '' : `. Read it with: ${cli} get ${id}`;
  return `Job ${id}: ${state}${tail}`;
}
