# Mirror fetch ownership

Mirrors hold full Git objects for live worktrees and reference clones. They must
not use partial clones or prune objects that consumers still need.

`prepareGithubRepo` runs fetches through `src/mirror-fetch.mjs`. The synchronous
API stays in place; a Node child supervises a detached Git process group.
Python 3.8+ must be on the bridge service PATH as `python3`; install Python 3
and update that service's PATH if the prerequisite diagnostic appears. The
supervisor checks `python3` before launching the guardian, independently of host-check execution. This prerequisite applies whenever mirror fetching runs, before creating a mutex, receipt, or disposable attempt.
No compiler is required. Both platforms use `flock` and a fetch-specific Python group anchor. Linux additionally uses `PR_SET_CHILD_SUBREAPER`; macOS uses
`kqueue NOTE_EXIT`. A normal fetch has a fixed 15-minute deadline. A corruption error permits one
`--refetch` with the same deadline (at most two network attempts). The deadline replaces the earlier 120-second normal and 300-second repair limits and needs no operator setting. It bounds an attempt; it does not promise that every repository can transfer in 15 minutes.

Each mirror has a permanent sibling `.fetch-mutex` inode. A nonblocking kernel
lock excludes concurrent fetches. The inode is never unlinked or replaced. A
versioned `.fetch-owner.json` receipt is atomically published and synced before
creating the disposable `.fetch-lock` directory and its private bare repository.
The directory's `owner.json` is diagnostic only. Existing refs and an object alternate let
the attempt negotiate incrementally against the full mirror. The remote URL is
passed only to Git, never written to config. The attempt fetches full objects.
On success, complete loose objects and finalized packs are linked into the mirror
before one compare-and-swap ref transaction publishes the fetched refs. A full-ref fetch also prunes
deleted refs; a pinned-revision fetch keeps existing refs and updates only the requested pins. Existing object files are never removed or replaced. A publication
failure can leave extra finalized objects but cannot make refs depend on the
attempt directory.

On Linux, the guardian keeps the kernel
lock while Node runs. Node and its Git commands also inherit the lock descriptor.
If Node is killed, the guardian adopts and kills orphan descendants, reaping them
before releasing ownership. A new fetch can then remove the old private attempt
under the same kernel lock and retry automatically. The guardian signals only its own unreaped children, whose PIDs
cannot be reused while it owns them. A host restart releases kernel locks; the
next fetch cleans the owned attempt without inspecting old PID or boot metadata.

On both platforms, each fetch runs in a separate group whose Python anchor stays alive
until its final group-wide SIGKILL. Only Node holds the write end of the anchor's
control pipe; Git receives `/dev/null` for stdin. Pipe EOF after Node dies, the
attempt deadline, or completion of Git makes the anchor kill its own group while
its live PID still pins the PGID. This also works when Node and the guardian die
together. The permanent sibling `.fetch-writers` lock is held by the anchor and
inherited by actual Git as stderr. Node must acquire this independent barrier
before cleanup; a new guardian checks it before removing a crashed attempt.
These locks are never unlinked. The fetch error is the bounded stderr tail.

The macOS guardian also gives Node a private session for synchronous Git commands.
It observes Node's exit with `kqueue NOTE_EXIT`, signals the group before reaping
its direct child, and waits for the fetch writer barrier. This prevents a reused
PGID from being signaled. Darwin can return EPERM for an all-zombie group; that
signal is best effort. Only the inherited kernel locks, including descriptors propagated through trusted Git, authorize cleanup; neither a process listing, a stored PID nor an age does. An escaped or unsignalable
writer can delay recovery; it cannot authorize deleting a live private attempt.

A crash before receipt publication creates no attempt, so initialization can be
repeated. Once the receipt is durable, an interrupted attempt can be removed on
the next acquisition, including crashes before refs or after refs but before
cleanup. Missing or corrupt durable receipts with an existing attempt fail safe
with a bounded diagnostic and leave that attempt untouched. Legacy lock directories
without the new ownership receipt are also left untouched. Ordinary crashes under
this protocol need no operator recovery. If a child is stuck in unkillable kernel
I/O, the guardian reports delayed settlement and holds the lock until it settles;
there is no universal hard wall-clock bound for that case.

Before each fetch, and under the same kernel lock, the attempt checks the object of
every mirror ref. A ref whose object is missing makes Git fail the fetch's
connectivity check with `bad object refs/...`, so every later fetch of that
repository fails. The repair deletes only direct refs with missing objects, with an
expected-old-value check. Symbolic refs under `refs/` are left untouched by the
repair; this does not redesign alias staging or publication. Repair stderr logs
the deleted count, at most the first 20 `mirror repair: deleted missing-object ref "REF"`
lines, and `... and N more` when names were omitted. It then fetches as usual, with the same single
`--refetch` fallback. A pin that the job needs is fetched and verified; a pin the
source cannot supply is still refused. Refs whose objects exist are not changed.

No recovery deletes preexisting mirror `tmp_pack_*` files. An unrelated fetch
writing in the mirror cannot lose its temporary packs to this cleanup. Other
bridge fetches fail immediately while the kernel lock is held. External ref
writers are protected by expected-old-value checks.

Fetch removes an existing `origin` remote from the mirror and sets `gc.auto=0`,
`maintenance.auto=false`, and `gc.autoDetach=false`. These are the only intended mirror config changes. Fetch also passes these settings explicitly, uses `--no-auto-maintenance` and leaves host and global config alone. Explicit manual GC or separately scheduled maintenance remains an owner
operation and must respect reference consumers.

`scripts/mirror-fetch-test.mjs` uses a local source and a genuine Git `index-pack` fed an incomplete real pack. A controlled Git wrapper interrupts that writer after it creates its own temporary pack, or leaves it blocked until timeout; the test never manufactures an attempt pack. Its assertions cover:

- successful, no-op and incremental fetches, finalized-pack retention, reference-consumer reads, corruption-fallback failure, process settlement, config retention and live lock refusal;
- automatic recovery when the supervisor is killed with a live `index-pack`, and continued protection of the orphan attempt when its guardian is stopped first;
- publication-boundary crashes (objects precede refs, cleanup is repeatable), receipt corruption, missing receipts, a stable lock inode and stale PID or boot metadata;
- a joint kill of guardian and Node while an actual `index-pack` lives: the test checks refusal and retained attempt data, then recovery after writer settlement. On both platforms the resumed independent anchor detects EOF and settles the group. Both death orders and near-simultaneous deaths run;
- a probe showing that actual Git alone retains both descriptors once every supervisor and wrapper is excluded as a holder;
- the missing-Python diagnostic, checked before any disposable state appears.

The fixture transport can close its own stream after a fixed delay. The test does not kill the writer, delete a lock or signal a recorded product receipt.

`scripts/mirror-dangling-refs-test.mjs` builds a mirror with dangling pin, branch and pull-request refs and a missing needed pin. It shows that an ordinary fetch fails with `bad object`, that the repair logs and deletes only the dangling refs, that the needed pin is restored and verified, and that an unfetchable pin is refused. `scripts/mirror-repair-test.mjs` tests real missing-blob repair with a live worktree.

These tests prove local object and process ownership behavior. They do not
measure transfer time for a large GitHub repository, test power loss durability,
or prove containment of a hostile executable that escapes its process group.
