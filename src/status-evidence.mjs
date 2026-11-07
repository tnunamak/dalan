// Worker reports are evidence of a suspected denial, not platform pause telemetry.
const denial = /auto-?review|guardian|denied|not approved|paused out of precaution/i;
const waiting = /auto.?stop|paused out of precaution|(?:resume|confirmation|approval).*(?:required|requested|needed)|(?:waiting|wait).*(?:guardian|confirmation|approval)/i;

export function statusEvidence(store) {
  const observations = [
    ...store.db.prepare('SELECT request_id,id row_id,created_at at,note text FROM progress').all().map(row => ({ ...row, source: 'progress' })),
    ...store.db.prepare('SELECT request_id,rowid row_id,created_at at,summary text FROM reports').all().map(row => ({ ...row, source: 'report' })),
    ...store.db.prepare('SELECT request_id,rowid row_id,created_at at,summary text FROM late_evidence').all().map(row => ({ ...row, source: 'late_evidence' })),
  ];
  const summarize = predicate => {
    const matches = observations.filter(row => predicate(row.text)).sort((a, b) => b.at.localeCompare(a.at));
    return {
      count: new Set(matches.map(row => row.request_id)).size,
      last_at: matches[0]?.at ?? null,
      evidence: matches.slice(0, 20).map(({ request_id, row_id, at, source }) => ({ request_id, row_id, at, source })),
    };
  };
  return {
    observed_at: store.stamp(),
    denial_suspected: summarize(text => denial.test(text)),
    worker_reported_guardian_wait: summarize(text => denial.test(text) && waiting.test(text)),
    worker_pause: 'unknown',
  };
}

// Calls and bytes against both windows always. The limits are estimates, not gates: name the ones reached (over_estimate).
const throttleToken = t => !t ? '' : (t.tool_calls_last_24h === undefined ? '' : ` calls=1h:${t.tool_calls_last_hour}/${t.max_tool_calls_per_hour},24h:${t.tool_calls_last_24h}/${t.max_tool_calls_per_24h}`) + (t.response_bytes_last_hour === undefined ? '' : ` bytes=1h:${t.response_bytes_last_hour}/${t.max_response_bytes_per_hour}${t.response_bytes_last_24h === undefined ? '' : `,24h:${t.response_bytes_last_24h}/${t.max_response_bytes_per_24h}`}`) +
  (t.over_estimate?.length ? ` over_estimate=${t.over_estimate.join('+')}` : '') +
  // Older bridges gated on these limits; keep explaining their responses.
  (t.rewake_throttled || t.submit_throttled ? ` throttle=claims:${t.claims_last_hour}+queued:${t.queued}/${t.max_claims_per_hour},tool_calls:${t.tool_calls_last_hour}/${t.max_tool_calls_per_hour}${t.holding ? `,holding:submit[${t.holding.submit.join('+')}]rewake[${t.holding.rewake.join('+')}]${t.rewake_throttled && t.normal_rewake_throttled === false ? ' agent_work=passes' : ''}` : ''}` : '');
export function explainStatus(status) {
  const queued = Array.isArray(status.counts) ? status.counts.find(row => row.status === 'queued')?.count ?? 0 : 'unknown';
  const denialEvidence = status.denial_suspected;
  const waitEvidence = status.worker_reported_guardian_wait;
  const denialCount = Number.isInteger(denialEvidence?.count) ? denialEvidence.count : 'unavailable';
  const denialLastAt = denialEvidence && Object.hasOwn(denialEvidence, 'last_at')
    ? denialEvidence.last_at ?? 'none'
    : 'unknown';
  const waitCount = Number.isInteger(waitEvidence?.count) ? waitEvidence.count : 'unavailable';
  const lastClaim = status.last_claim_at ?? status.last_claim ?? status.subscription?.last_claim_at ?? 'none';
  const priority=status.priority_counts??{};
  const normal=`${priority.normal?.queued??'unknown'}/${priority.normal?.claimed??'unknown'}`;
  const background=`${priority.background?.queued??'unknown'}/${priority.background?.claimed??'unknown'}`;
  const d=status.dispatch, dispatch=d?` dispatch=${d.state}(free:${d.free_lanes},queued:${d.queued_live},oldest:${d.oldest_unclaimed_age_ms==null?'none':`${Math.round(d.oldest_unclaimed_age_ms/60000)}m`})`:'';
  return `observed=${status.observed_at ?? 'unknown'}${dispatch} outer=${status.claimed_outer_count ?? 'unknown'}/${status.max_claimed_outer_assignments ?? 'unknown'} last_claim_at=${lastClaim} queued=${queued}${status.queued_expired?.count>0?` queued_expired=${status.queued_expired.count}`:''}${status.unclaimed_after_reannounce?.count>0?` unclaimed=${status.unclaimed_after_reannounce.count}`:''} normal=queued/claimed(${normal}) background=queued/claimed(${background}) background_max_in_flight=${status.background_max_in_flight??'unknown'} denial_suspected=${denialCount} denial_last_at=${denialLastAt} guardian_wait=worker_reported(${waitCount}) bridge_paused=${status.paused ?? 'unknown'} worker_pause=${status.worker_pause ?? 'unknown'}${status.worker_break?.active?` worker_break=since:${status.worker_break.since}(${status.worker_break.source})`:''}${throttleToken(status.throttle)}`;
}
