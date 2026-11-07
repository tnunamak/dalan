const natural = value => Number.isSafeInteger(value) && value >= 0;
const fail = code => { throw Object.assign(new Error(code), { code }); };

export function assertClaimAuthority(command, authority, now) {
  const { job, subject, worker, claim, epoch } = command;
  if (!authority || authority.job !== job || authority.subject !== subject || authority.worker !== worker ||
      authority.claim !== claim || authority.epoch !== epoch || authority.active !== true) fail('stale_authority');
  if (!natural(authority.leaseUntil) || now >= authority.leaseUntil) fail('lease_expired');
}

// Called only after authority and receipt replay have been checked by the caller.
export function decide(snapshot, command, context) {
  const { expectedRevision, operation, args } = command;
  if (snapshot.revision !== expectedRevision) fail('revision_conflict');
  let leaseUntil;
  if (operation === 'renew') {
    if (!args || Object.keys(args).some(key => key !== 'leaseMs') ||
        !natural(args.leaseMs) || args.leaseMs < 1 || args.leaseMs > context.maxLeaseMs) fail('invalid_lease');
    leaseUntil = context.now + args.leaseMs;
    if (!natural(leaseUntil)) fail('invalid_lease');
  }
  if (!natural(expectedRevision) || expectedRevision >= Number.MAX_SAFE_INTEGER) fail('invalid_revision');
  return { events: [], effects: [{ type: 'advance_revision', expectedRevision }],
    ...(leaseUntil === undefined ? {} : { leaseUntil }) };
}
