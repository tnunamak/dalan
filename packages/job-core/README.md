# job-core

job-core holds Dalan's claim decision logic and canonical JSON helpers. The caller owns storage and authentication.

Version 0 contains the fixture-profile schemas in `protocol/v0`. The generated
conformance traces remain in `scripts/conformance/fixtures/traces` in the host
repository; the existing runner owns their generation and execution.

`decide(snapshot, command, context)` checks the revision and renewal duration
after the caller has authenticated the claim and checked for a replay. It
returns events and required effects; the caller applies the revision effect
atomically with its mutation and receipt. `context` supplies time and the
maximum lease. Transactional compare-and-swap remains the caller's duty.
`assertClaimAuthority` checks a supplied authority record and deadline before
receipt lookup; the caller obtains that record and supplies the current time.

Canonical JSON rejects non-finite numbers and non-plain objects. The optional
error code preserves each caller's existing error vocabulary.
