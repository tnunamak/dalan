// Thread states copied from `t3code --json threads inspect` on T3 0.1.10-nightly.20261113.4643.1 (orchestrator protocol 2),
// one throwaway thread, 2026-11-15. See docs/t3-wake-fence-r4.md. Only the fields Dalan reads are kept.
// `interrupted` came from `t3code threads interrupt`; `stopped` came from the MCP t3_thread_interrupt with stop:true.
// The two differ in nothing but ordinal and timestamps.
export const r4ThreadStates = {
  "finished": {
    "id": "c786865f-811d-4b95-9894-64f3d0231b0c",
    "projectId": "ad428a81-ab07-41d8-b4da-4881bae88e5b",
    "status": "active",
    "runStatus": "completed",
    "activeRun": null,
    "latestRun": {
      "runId": "run:thread:c786865f-811d-4b95-9894-64f3d0231b0c:ordinal:1",
      "ordinal": 1,
      "status": "completed",
      "requestedAt": "2026-11-15T04:07:03.264Z",
      "startedAt": "2026-11-15T04:07:03.401Z",
      "completedAt": "2026-11-15T04:07:06.291Z"
    },
    "queue": [],
    "pendingRequests": [],
    "archivedAt": null,
    "deletedAt": null,
    "settledAt": null,
    "settledOverride": null,
    "snoozedUntil": null
  },
  "running": {
    "id": "c786865f-811d-4b95-9894-64f3d0231b0c",
    "projectId": "ad428a81-ab07-41d8-b4da-4881bae88e5b",
    "status": "active",
    "runStatus": "running",
    "activeRun": {
      "runId": "run:thread:c786865f-811d-4b95-9894-64f3d0231b0c:ordinal:5",
      "ordinal": 5,
      "status": "running",
      "requestedAt": "2026-11-15T04:09:28.942Z",
      "startedAt": "2026-11-15T04:09:29.048Z",
      "completedAt": null
    },
    "latestRun": {
      "runId": "run:thread:c786865f-811d-4b95-9894-64f3d0231b0c:ordinal:5",
      "ordinal": 5,
      "status": "running",
      "requestedAt": "2026-11-15T04:09:28.942Z",
      "startedAt": "2026-11-15T04:09:29.048Z",
      "completedAt": null
    },
    "queue": [],
    "pendingRequests": [],
    "archivedAt": null,
    "deletedAt": null,
    "settledAt": null,
    "settledOverride": null,
    "snoozedUntil": null
  },
  "interrupted": {
    "id": "c786865f-811d-4b95-9894-64f3d0231b0c",
    "projectId": "ad428a81-ab07-41d8-b4da-4881bae88e5b",
    "status": "active",
    "runStatus": "interrupted",
    "activeRun": null,
    "latestRun": {
      "runId": "run:thread:c786865f-811d-4b95-9894-64f3d0231b0c:ordinal:4",
      "ordinal": 4,
      "status": "interrupted",
      "requestedAt": "2026-11-15T04:08:46.450Z",
      "startedAt": "2026-11-15T04:08:46.847Z",
      "completedAt": "2026-11-15T04:09:14.642Z"
    },
    "queue": [],
    "pendingRequests": [],
    "archivedAt": null,
    "deletedAt": null,
    "settledAt": null,
    "settledOverride": null,
    "snoozedUntil": null
  },
  "stopped": {
    "id": "c786865f-811d-4b95-9894-64f3d0231b0c",
    "projectId": "ad428a81-ab07-41d8-b4da-4881bae88e5b",
    "status": "active",
    "runStatus": "interrupted",
    "activeRun": null,
    "latestRun": {
      "runId": "run:thread:c786865f-811d-4b95-9894-64f3d0231b0c:ordinal:5",
      "ordinal": 5,
      "status": "interrupted",
      "requestedAt": "2026-11-15T04:09:28.942Z",
      "startedAt": "2026-11-15T04:09:29.048Z",
      "completedAt": "2026-11-15T04:09:45.981Z"
    },
    "queue": [],
    "pendingRequests": [],
    "archivedAt": null,
    "deletedAt": null,
    "settledAt": null,
    "settledOverride": null,
    "snoozedUntil": null
  },
  "resumed_after_stop": {
    "id": "c786865f-811d-4b95-9894-64f3d0231b0c",
    "projectId": "ad428a81-ab07-41d8-b4da-4881bae88e5b",
    "status": "active",
    "runStatus": "completed",
    "activeRun": null,
    "latestRun": {
      "runId": "run:thread:c786865f-811d-4b95-9894-64f3d0231b0c:ordinal:6",
      "ordinal": 6,
      "status": "completed",
      "requestedAt": "2026-11-15T04:10:48.692Z",
      "startedAt": "2026-11-15T04:10:48.721Z",
      "completedAt": "2026-11-15T04:10:54.645Z"
    },
    "queue": [],
    "pendingRequests": [],
    "archivedAt": null,
    "deletedAt": null,
    "settledAt": null,
    "settledOverride": null,
    "snoozedUntil": null
  }
};
export const r4EnvironmentId = 'b73799f9-f56b-4f52-bf7c-9dfc437c9563';
// Inspect envelope for a state: the shape callT3 returns for `threads inspect`.
export const r4Inspect = (state, overrides = {}) => ({ thread: { ...structuredClone(r4ThreadStates[state]), ...overrides }, runtime: { environmentId: r4EnvironmentId } });
