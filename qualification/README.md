# Adapter qualification

A worker profile may name an `adapter`: `mcp` or `protocol-v0`. Omission means unqualified. This field is independent of the `t3` authority grant and of Gozar tunnel routes.

Records follow [the adapter schema](../contracts/adapter-qualification.schema.json), copied from the handoff schema with adapter naming. `yes` with a passing observation maps to `verified`; `no` with a passing observation maps to `unsupported`; everything else maps to `unknown`. Unknown capabilities never satisfy a submission requirement.

`protocol-v0` qualifies identified question/answer/consume behavior through the local real-server fixture. Its declaration applies only with the `protocol-v0` catalog profile. `mcp` makes no verified capability claims. Neither record qualifies a hosted model, native session continuity, activation, or a worker sandbox. The source pin identifies the baseline exercised by the probe, rather than a live provider version.

Run `node scripts/qualification-gate-test.mjs` to validate the records, compare them with the runtime capability table, and rerun their observations. The gate refuses missing observations, failed probes, mismatched values, duplicate or missing capability names, and unbound evidence. Run `node scripts/adapter-qualification-test.mjs` to exercise actual `/submit` admission and inspect SQLite after refusals. `node scripts/pull-catalog-hash-test.mjs` pins the unchanged worker catalog for all profiles with T3 tools on and off.

For `execution=none` or `worker`, required capabilities must be verified by the worker's declared adapter. For `execution=host`, sandbox requirements still use the host backend; adapter requirements also need the worker adapter. Existing immutable retries retain their original admission and binding. Policy submissions reject `required_capabilities` rather than silently dropping it.

To add an adapter, add its record, register its strict identifier in `src/execution.mjs`, and add a probe whose passing output measures each declared value. Do not promote a hosted capability from documentation alone.
