# pnpm support for the prepared-dependency store (plan, 11-26)

Built (see "Spike and build results" at the end). The text above is the plan as approved; the results section records where the build differs.

## Answer to the question asked
Main (#90) supports npm lockfiles v2/v3 only, including npm workspaces. A `pnpm-lock.yaml` is not read at all. The repo's `package-lock.json` is looked up; none exists in pdpp, so every pdpp check fails with unprepared dependencies.

## Prior art (divan: sandboxing/fast-untrusted-jobs-should-reuse-verified-immutable-dependencies-...)
- `pnpm fetch` builds a store from the lockfile alone (manifest contents ignored); `pnpm install --offline --frozen-lockfile` then assembles node_modules with no registry. Local `file:` deps are skipped at fetch time.
- pnpm node_modules is hardlinks into a content-addressed store plus relative symlinks. A shared store is not an assembled tree.
- pnpm settings docs restrict repo-controlled registry/env interpolation (secret-leak risk). So the preparation must not honour a repo `.npmrc`.
- Sandboxed CI pattern (Codex/Copilot/Devin/Jules setup scripts, devbox, Nix): fetch with network once, freeze, run offline. Our npm and Go preparers already follow it.

## Design
A new kind modelled on `prepared-go-modules.mjs`, publishing through the same pipeline as npm workspaces (trees, metadata, freeze, validate, in-child prepare, pinned-base rule).
- Identity: sha256 of `pnpm-lock.yaml`, `pnpm-workspace.yaml`, root `package.json`, each importer `package.json`; runtime (node, pnpm version, platform, arch). Importer list comes from the lock's `importers:` keys with a fail-closed parser. Host pnpm version must equal `packageManager` or the repo is unsupported.
- Unsupported (fail closed, offer filter says so): repo `.npmrc`, `patchedDependencies`, `link:` or `file:` outside the importer set, importer paths with links or odd characters.
- Prepare, in the detached child: stage dir with the pinned files; `pnpm fetch` then `pnpm install --offline --frozen-lockfile --ignore-scripts --package-import-method=copy` into a stage-private store (or a shared download store with copy import). Copy import is required: hardlinked store files share inodes, so `freezeTree` chmod would alter the store. Minimal env, as in the Go preparer.
- Publish: root `node_modules` plus each importer's `node_modules` as workspace trees (already supported). `validateTree` gets one new rule: a relative link is valid when its lexical target is inside the root tree, another allowed importer tree, or an importer directory. Trial: 2694 links in the root tree; the only ones leaving it are 12 links to importer directories, which the existing workspace-link rule already allows.
- Wire-up: `workspace.mjs prepareDependencies` (same unchanged-from-base rule, adds `pnpm-lock.yaml` and workspace yaml), `dalan prepare-deps --pnpm`, offer filter from #88, docs.
- Checks: do not use `pnpm test` (pnpm is not in the sandbox, and pdpp's script wrapper starts its own cgroup sandbox). Each package check runs `node --import tsx scripts/run-node-tests.mjs --test ...` directly.

## Size
- `src/prepared-pnpm.mjs` about 170 lines; validateTree rule about 20; wiring about 30; docs about 15.
- Tests about 300 lines: identity and fail-closed cases, link rules (escape, absolute, other-tree), copy independence (freeze does not touch a source file), failed fetch publishes nothing, offline fixture workspace with a seeded store.
- One PR, one builder (Sonnet, medium), about one day. A spike of 1-2 h comes first (below).
- Disk: about 1 GB per distinct lock (trial tree 961 MB, 55,766 entries). The disk is 92% full, 114 GB free; the store holds 3.2 GB for 7 npm entries and has no pruning. pdpp's lock changed once in the last 7 days. A keep-newest-N prune is a separate row; I would add it with this build.

## Coverage (last 7 days, 71 pdpp worker patches that have a patch file)
- display, list-envelope, reference-contract, pdpp-brand-react, operator-ui: 35/71 = 49%.
- Plus reference-operations-sandbox: 48/71 = 68%.
- apps/site would reach 87%, but its tests need a generate step (`@/generated` is missing after install), so it is out of scope.
That clears the maintainer's rule (a default only if the test covers code patches touch; the npm candidates covered 0%).

## Expect it to work because:
1. The hard parts already work on main: read-only tree mounts, workspace trees, the pinned-base rule, in-child preparation, freeze and validate. pnpm only replaces the installer.
2. Trial (pdpp worktree, pnpm 12.6.0), not a guess: offline frozen `--ignore-scripts` install 6.4 s with a warm store; all links relative; tests pass offline with no postinstall: reference-contract 165, operator-ui 264/264, display 80/80 (4.6 s), pdpp-brand-react 71/71 (8.7 s), reference-operations-sandbox pass (1 s), tsc 0.7 s.
3. Coverage is measured from the real patches (above), not assumed.

Likeliest-wrong assumption: the bridge sandbox can run those commands with the pnpm tree mounted read-only and the cross-tree links resolving at the mount points (root tree at `node_modules`, importer trees at `packages/x/node_modules`). I tested the commands on the host, not in the sandbox.
Cheapest settler (step 0, about 1-2 h, before the build): hand-assemble the trial tree into a throwaway store entry and run one real allowlisted host check on a pdpp worktree through the bridge sandbox. If it passes, build. If links or tsx's cache write fail, the plan changes before any code is written.

Other risks: copy import time (not measured, est. 10-20 s extra per prepare); native postinstalls (better-sqlite3, onnxruntime-node, protobufjs) are skipped, so a package whose tests load them fails. None of the six packages above needs one. A rebuild step for an owner-approved list is v2.

## Open decision for the maintainer
One default check for pdpp that runs the six packages in sequence (simple; each ran 1-9 s, the whole run is not yet timed), or per-path checks (needs checks.json support I have not confirmed). I recommend the single sequential check.

## Spike and build results (11-26)
Spike (pdpp origin/main, pnpm 12.6.0, lock v9, real bridge sandbox through `runHostBudget`):
- `pnpm install --frozen-lockfile --ignore-scripts --offline --package-import-method=copy`: 5.0 s, tree 1002 MB, 7 importer trees (apps/site, packages/pdpp-brand, conformance-suite, pdpp-brand-react, display, operator-ui, reference-contract); 2694 links in the root tree, all relative; only 12 leave the root tree, all to importer directories.
- Mounted as `host-budget-storage.py` does (root tree at `/workspace/node_modules`, importer trees at `/workspace/<path>/node_modules`), the six packages pass: display 80, list-envelope 16, reference-contract 165, pdpp-brand-react 71, operator-ui 264, reference-operations-sandbox 15 = 611 tests. One `/usr/bin/sh -c` check; CPU 27-31 s of 120, wall 24-32 s of 180, memory 366 MB, disk write 22 MB of 512.
- The process cap is the tight budget: peak 120-123 of 128 at `--test-concurrency=1`; at pdpp's default concurrency the sequence failed with `budget exceeded: processes`. A single package peaks at 63-97. The check must pass `--test-concurrency=1` (documented in docs/operations.md). The cause of the extra ~23 processes was not chased.
- Out of scope: apps/site (its tests need a generate step), native postinstalls (skipped by `--ignore-scripts`; none of the six packages needs one).

Build (the same check, prepared through the new code, passed again: 611 tests, exit 0, CPU 22.9 s, wall 23.6 s, memory 365 MB, 121 processes). Where the build differs from, or adds to, the plan:
- The lock is two YAML documents (pnpm 11+): the first pins pnpm itself, the second is the project. The parser reads only the last document.
- A workspace package with no dependencies has no `importers:` block, yet others link to it (`list-envelope`, `reference-operations-sandbox`). A `link:` target is therefore valid when it is an importer or matches a `packages:` glob of `pnpm-workspace.yaml`; the same set is the "importer directory" set for the tree-link rule.
- `pnpm fetch` also fills the virtual store, so it gets `--package-import-method=copy` too; otherwise hardlinks into the store reach the published tree. The store is deleted before `freezeTree`, so a hardlink could never alter a surviving store file, but the flag keeps the trees independent.
- The offline install reads package metadata that `fetch` cached under pnpm's cache directory. The stage points `XDG_CACHE_HOME` at a stage-private directory (`--cache-dir` is not accepted by every pnpm 12 release) and deletes it with the stage. HOME stays the owner's so pnpm finds the pinned release it switches to.
- The version rule is checked by running `pnpm --version` in a scratch directory whose package.json pins `packageManager`: pnpm switches to the pinned release when it has one. On this host the default pnpm is 12.23.0 and pdpp pins 12.6.0; the switch works from the cached release. If the release is absent and cannot be fetched, the repository is unsupported with that reason.
- Also unsupported: `.pnpmfile.cjs` and its variants (repository code at install), and `registries`, `registry`, hooks, `patchedDependencies` and similar keys in `pnpm-workspace.yaml`.
- pnpm 12 reads `pnpm_config_*` environment variables, not `npm_config_*`, for the registry. The preparer forwards `pnpm_config_registry` and the fetch-retry settings from the owner's environment; the in-child environment filter forwards `pnpm_config_*`.
- Prune: `src/prepared-store-prune.mjs`, run by `dalan prepare-deps` after each npm or pnpm preparation (never in the library calls), plus `dalan prepare-deps --prune [--keep N]`.
- Known limits: no native rebuild; process peak close to the cap; `pnpm` must be on the PATH of the bridge and the owner.
