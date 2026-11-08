# Owner-side patch verification

The owner-side verifier takes a sealed report patch and a local target ref. It creates a detached scratch worktree, applies the stored patch with the recorded digest and base SHA, and runs each evidence check through the `Workspace.runConfined` runner. Each check gets its own copy of the patched tree, so one check cannot alter the input to the next.

This is a reference for maintainers embedding the JavaScript API in `src/integrator.mjs`, not a standalone CLI walkthrough. For owner-facing patch review and application, start with the [requester reference](usage.md). To use the internal verifier:

1. Call `loadSealedResult(store, requestId)` to read the sealed patch artifact and its recorded base SHA from the stored report. `Workspace.artifact()` checks the artifact byte length and SHA-256 before it returns the bytes.
2. Call `verifySealedResult({store, sealedResult, repoDir, targetBaseRef})` with a local checkout that already contains the target ref. It accepts only a nonempty patch from an implementation-scope assignment that is not a review result; a read-only `output_paths` patch is rejected.
3. Read the returned candidate and verification record, or query them later with `Store.getIntegrationCandidate()` and `Store.integrationVerifications()`.

`verifySealedResult()` validates the fields and patch digest of `sealedResult`, but it cannot authenticate an arbitrary caller's object. Pass only a result that `loadSealedResult()` loaded from the bridge Store.

The evidence plan contract (taken by `runEvidencePlan()`) is `{schema_version: 1, checks: [{id, argv, issuer, trust_profile}]}`. `verifySealedResult()` does not select an explicit plan from the stored assignment or the report; it always derives its plan from the project check definitions at the assignment's recorded base SHA. A repository check is labeled `repository-config`; an owner override is `owner-config`; a detected project check is labeled `repository:detected`. The runner records the declared issuer and trust profile alongside the observed exit, timeout, stop, output digest, and preview. A check is passed only when it exits with code zero, does not time out or cancel, and the sandbox reports a verified stop.

The verifier resolves refs from the local repository only. It does not fetch, use a credential, push, or make a network write. Checks use the `Workspace.runConfined` sandbox with networking disabled. The network-backed PR source freshness check in `src/pr-preflight.mjs` remains a separate operation because it requires a direct GitHub observation. A Git whitespace-policy rejection is recorded as `failed`; `conflict` is reserved for patch or base incompatibility.

The verifier stores patches up to 262,144 bytes, matching the workspace patch-apply limit. Before it inserts a candidate, the Store checks the patch bytes against their digest and rejects patches over that bound.

If the target SHA differs from the patch base SHA, the verifier creates a new candidate linked to an immutable original candidate. It never changes the original candidate's target. A patch that conflicts with the target is recorded as `conflict` and does not run checks. Each attempt marker is stored atomically with its candidate before checkout or checks; a completed result appends a second immutable verification record. If writing that final record fails, the function returns its in-memory result with top-level `verification_recorded: false` and `verification.recording_error`, while the interrupted attempt marker remains stored. Verification statuses are `verified`, `failed`, `conflict`, `skipped` (no check failed, but at least one was skipped) and `owner_approval_required` (the patch changes check inputs, so no check ran). Records include the candidate ID, patch digest, patch base SHA, target SHA and per-check issuer.

Scratch worktrees, per-check copies, and runner state stay under the integrator scratch root. They are left in place for inspection. The candidate's verified patch remains the sealed patch bytes plus the target SHA; the test runner's copies are evidence only.

From a source checkout installed with `npm ci`, run the focused segment below; its script is not included in the npm package:

```sh
node scripts/integrator-verifier-test.mjs
```
