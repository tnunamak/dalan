// JSON-RPC error for a prompt the adapter refuses. T3 records a prompt error as a provider_error failure.
// RequestError is injected so the kit has no runtime dependency on the ACP SDK:
//   const refuse = createRefuse(acp.RequestError);
export const REFUSE_CODE = -32000;
export const createRefuse = RequestError => (message, data) => data === undefined ? new RequestError(REFUSE_CODE, message) : new RequestError(REFUSE_CODE, message, data);

// Cancel budget. T3 allows 10 s after session/cancel for the prompt to return. An adapter answers within
// CANCEL_BUDGET_MS, then spends at most CANCEL_CLEANUP_MS on bounded cleanup, so the total stays inside the window.
export const T3_CANCEL_WINDOW_MS = 10_000;
export const CANCEL_BUDGET_MS = 5_000;
export const CANCEL_CLEANUP_MS = 2_000;
// A positive finite number (for example from an environment variable), else the default.
export const cancelBudgetMs = raw => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.min(value, T3_CANCEL_WINDOW_MS - CANCEL_CLEANUP_MS) : CANCEL_BUDGET_MS;
};
