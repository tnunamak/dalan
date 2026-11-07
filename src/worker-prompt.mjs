// The sentence a user gives their worker so it does one Dalan job and no other. `dalan try`, `dalan submit --brief` and
// the README all give this exact prompt, so it lives here once.
export const workerPrompt = requestId =>
  `Request ${requestId} is your only job: claim it with Dalan, do what its brief asks, report progress and finish it with the claim_id. Stop if it is missing or cancelled. Claim no other job.`;
