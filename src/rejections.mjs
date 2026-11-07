// Refused submits, from the request log's submit_rejected lines, grouped by reason class. The reason class drops the
// path or value after the first ': ' and any parenthesised detail, so one rule with many paths counts as one class.
import { canonicalKindLabel, fromStoredSource } from './objectives.mjs';
export const reasonClass = reason => String(reason ?? '').replace(/\s*\(.*$/s, '').replace(/: .*$/s, '').trim() || 'unknown';
export function summarizeRejections(lines, sinceMs = 0) {
  const classes = new Map(), bySource = {};
  let refused = 0;
  for (const line of lines) {
    if (!line.includes('"submit_rejected"')) continue;
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    if (entry.kind !== 'submit_rejected' || !(Date.parse(entry.at) >= sinceMs)) continue;
    refused++;
    const name = reasonClass(entry.reason), row = classes.get(name) ?? { reason: name, count: 0, example: entry.reason, request_ids: new Set() };
    row.count++; if (entry.request_id) row.request_ids.add(entry.request_id); classes.set(name, row);
    const source = canonicalKindLabel(entry.task_kind) ?? fromStoredSource(entry.source) ?? 'unknown'; bySource[source] = (bySource[source] ?? 0) + 1;
  }
  return { refused, classes: [...classes.values()].sort((a, b) => b.count - a.count).map(r => ({ reason: r.reason, count: r.count, distinct_requests: r.request_ids.size, example: r.example })), by_kind: bySource };
}
