# Submit one read-only result to an eligible pool

A policy work order lets one of several named workers take a job. It creates one
ordinary assignment when the first eligible worker claims it. Later attempts stay
with that worker; Dalan does not assign the slot to another worker automatically.

Every candidate must already have access to the job's repository. Listing and
acquisition both check the current repository grant and approved destination.
Listing a job does not reserve it or authorize work to start.

For workers without a destination declaration, give the assignment an explicit
`valid_until` deadline and submit:

```sh
dalan submit --file review.json --eligible alpha,beta --execution worker
```

The assignment must use `execution_scope: "read-only"`. Version 1 accepts
`execution=none` or `execution=worker`, one result slot and explicit worker names.
It rejects host execution, protocol jobs, fan-out, worker classes, superseding,
command keys and backend capability requirements. The effective deadline is the
earlier of the policy deadline and the assignment's `valid_until`.

For declared destinations, start with a policy file containing this routing
object:

```json
{
  "version": 1,
  "allowed_workers": ["alpha", "beta"],
  "fan_out": 1,
  "deadline_at": "2026-12-01T00:00:00Z"
}
```

Run `dalan submit --file review.json --policy policy.json --execution worker --dry-run --json`.
The preview stores no job and returns `destination_disclosures` for each candidate.
Review each disclosure. Add its exact `revision` to the policy file:

```json
{
  "routing": {
    "version": 1,
    "allowed_workers": ["alpha", "beta"],
    "fan_out": 1,
    "deadline_at": "2026-12-01T00:00:00Z"
  },
  "destination_revisions": {
    "alpha": "sha256:<alpha revision from the preview>",
    "beta": "sha256:<beta revision from the preview>"
  }
}
```

Then run:

```sh
dalan submit --file review.json --policy policy.json --execution worker --dry-run
dalan submit --file review.json --policy policy.json --execution worker
```

A policy file can also contain the routing object directly when no candidate needs
a destination revision. The owner can use `get`, `wait`, `inbox` and `cancel` with
the submitted request ID before or after acquisition. Reports and decisions use
that same request ID and the same saved owner capability.

## Worker flow without a connector refresh

1. Call `list_pending`. Its existing `assignments` list is unchanged. The new
   `policy_work.items` field contains up to 50 eligible work orders, with priority,
   original queue time and deadline. Normal priority precedes background work.
2. If `policy_work.next_page_request_id` is present, call the existing `get` tool
   with that value as `request_id`. Continue until it is null. Pagination captures
   a queue high-water mark; jobs added later appear on the next fresh list. Every
   page checks current eligibility. Page tokens are encrypted and bound to the
   authenticated worker, and survive a bridge restart.
3. Call `get` with an offered job's `request_id` to read its assignment. Call
   `claim` with that ID, a claimant and a fresh `acquisition_id`. Respect the
   existing free-lane and pause limits. A race has one winner.
4. Use the returned `request_id` and `claim_id` with the existing progress,
   workspace and finish tools. The receipt includes a distinct `work_order_id`
   and `child_request_id`; the child reserves the original submitted request ID.
   A lost-reply retry must use the original claimant, lease and acquisition ID.
5. Read the owner's decision separately. Completion does not accept the result.

The eligible backlog is independent of available lanes. An unauthorized worker
sees neither work-order titles nor a global backlog count. Repository revocation,
destination drift or connection-set drift removes an offer from that worker and
refuses a new acquisition. A committed live acquisition retry follows the existing
grant fences; changing policy does not silently replace its holder.

Version 1 discovers unacquired work through polling `list_pending`. It adds no
availability event for an unacquired work order. Existing events for materialized
children remain hints. Lease expiry and abandonment use the ordinary child
recovery path with a fresh acquisition ID, once prior work has verifiably stopped.
There is no second result slot or cross-worker retry.

The advertised MCP tool definitions are unchanged in every catalog profile.
`pull-catalog-hash-test.mjs` pins all four profiles with T3 tools off and on.
The database upgrade is additive schema 66; use a pre-upgrade backup to return to
an older Dalan build.
