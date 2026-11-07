// Who a result is for, and how urgent that makes it. Code decides, never the submitter.
//
// A submitter can lie about anything it writes: a manifest field, a payload key, a --source flag. So the consumer type
// and the tier come only from facts the code path owns: the request id that proves a drainer or fix-loop identity
// (verifyObjective), and the priority the bridge enforces for that identity. A self-declared consumer, severity or tier
// is refused, not ignored, so a producer that tries it learns at once. Naming a requester (consumer.type thread or lane) is
// not refused; nothing reads it yet.
import { verifyObjective, fixLoopSource, fromStoredSource } from './objectives.mjs';

// Pseudo-consumers belong to the code path that owns them. A submitter never names one.
//   fix_pipeline  fix-loop assignments (proved by the fix-loop request id)
//   reserve       work nobody asked for: the drainer's audits and PR reviews (proved by the drainer request id)
//   ledger        no code path assigns it yet, so nothing can hold it
export const systemConsumers = Object.freeze(['fix_pipeline', 'ledger', 'reserve']);

// Fields that would let a submitter pick its own consumer or promote its own work. `value_tier` and `tier` are never the
// submitter's. `consumer` may name a requester (a thread or lane, for later) but never a system consumer. `severity` is the
// producer's own claim about its finding: a drainer or fix-loop submission cannot use it to rank itself, and an agent's
// severity hint is harmless (agent work is already tier 0) and passes.
export const forbiddenDeclarations = Object.freeze(['value_tier', 'tier']);

// Tier 0 is work an agent asked for; a lower number runs first. Only these three exist until the data justify more.
const tiers = { agent: 0, fix_pipeline: 1, reserve: 5 };

// The forbidden declarations at the top level of a manifest, assignment or request body. Empty when clean.
// `source` is the submitter's claimed source; without one the value is treated as an agent's.
export function declaredConsumerFields(value, source = 'agent') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const found = forbiddenDeclarations.filter(key => Object.hasOwn(value, key));
  const named = typeof value.consumer === 'string' ? value.consumer : value.consumer?.type;
  if (Object.hasOwn(value, 'consumer') && (systemConsumers.includes(named) || typeof named !== 'string')) found.push('consumer');
  if (Object.hasOwn(value, 'severity') && source !== 'agent') found.push('severity');
  return found;
}

export function assertNoDeclaredConsumer(value, label, source = 'agent') {
  const found = declaredConsumerFields(value, source);
  if (found.length) throw new Error(`${label} declares ${found.join(', ')}; the bridge assigns the consumer and tier from the code path, never from the submitter`);
}

// row: {request_id, payload (object or JSON), meta: {objective_key, revision, task_kind, source}}.
// Returns {type, tier, proven} and, when not proven, the reason verifyObjective gives. A claim of source drainer or fix-loop that the request id does not prove is not a consumer
// at all: the caller must refuse it (see unprovenSource).
export function consumerOf(row) {
  const source = row.meta?.source ?? 'agent', normalizedSource = fromStoredSource(source);
  if (normalizedSource === fixLoopSource || normalizedSource === 'drainer') {
    const type = normalizedSource === fixLoopSource ? 'fix_pipeline' : 'reserve';
    const reason = verifyObjective({ request_id: row.request_id, payload: row.payload }, row.meta);
    return { type, tier: tiers[type], proven: reason === null, ...(reason === null ? {} : { reason }) };
  }
  return { type: 'agent', tier: tiers.agent, proven: true };
}

// Why this submission may not use its claimed source, or null. A drainer or fix-loop identity needs its request id proof, and
// drainer work is always background: no manifest can put itself ahead of agent-requested work.
export function unprovenSource(row, priority) {
  const consumer = consumerOf(row);
  if (!consumer.proven) return `source ${row.meta.source} is proven by the request id of its own code path, and this one is not: ${consumer.reason}`;
  if (consumer.type === 'reserve' && priority !== 'background') return 'drainer work is always background priority';
  return null;
}
