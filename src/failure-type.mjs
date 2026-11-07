// Read-only failure labels keep bridge facts separate from text reported by a worker.
export const failureTypes=Object.freeze(['expired','owner_cancelled','lease_expired','skipped_by_bridge','worker_blocked','usage_break','guardian_denied','transport_error','adapter_error','check_failed','unknown']);

const reportRules=[
  ['usage_break',/usage[- ]?(?:limit|break|cap)|rate[- ]?limit|quota (?:exceeded|exhausted)|worker_break|try again (?:after|at) \d/i],
  ['guardian_denied',/auto-?review|guardian|not approved|paused out of precaution|(?:denied|refused|rejected) by (?:the )?(?:safety|policy|reviewer|approval)/i],
  ['transport_error',/\bE(?:CONNRESET|CONNREFUSED|TIMEDOUT|PIPE|NOTFOUND|HOSTUNREACH)\b|socket hang up|fetch failed|network (?:error|unreachable)|\bHTTP 5\d\d\b|bad gateway|deadline exceeded/i],
  ['adapter_error',/\b(?:adapter|acp)\b[^.\n]{0,40}\b(?:error|failed|crash|refused|invalid)\b|\b(?:error|failed|crash|refused|invalid)\b[^.\n]{0,40}\b(?:adapter|acp)\b/i],
];

// This describes worker text only. It does not prove why the work stopped.
export function inferWorkerReport({outcome,summary='',result=''}={}) {
  if(outcome==='completed'||outcome==null) return null;
  const text=`${summary}\n${result}`;
  for(const [type,pattern] of reportRules) if(pattern.test(text)) return {type,source:'worker_text_inference'};
  if(/^\s*BLOCKED:/im.test(text)||outcome==='blocked') return {type:'worker_blocked',source:'worker_text_inference'};
  return {type:'unknown',source:'worker_text_inference'};
}

// Only facts observed at bridge transitions receive bridge provenance.
export function observeTransition({status,reason,cancelActor,leaseExpired=false,checkFailed=false}={}) {
  if(checkFailed) return {type:'check_failed',source:'bridge_observed_transition'};
  if(status==='cancelled'&&reason==='expired'&&cancelActor==='system') return {type:'expired',source:'bridge_observed_transition'};
  if(status==='cancelled'&&cancelActor==='owner') return {type:'owner_cancelled',source:'bridge_observed_transition'};
  if(leaseExpired) return {type:'lease_expired',source:'bridge_observed_transition'};
  if(status==='cancelled'&&(reason==='skipped_by_worker'||reason==='skipped_by_dot')&&cancelActor==='system') return {type:'skipped_by_bridge',source:'bridge_observed_transition'};
  return null;
}
