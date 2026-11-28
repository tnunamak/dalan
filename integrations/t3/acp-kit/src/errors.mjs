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
// An override must leave the cancellation cleanup budget inside T3's response window.
export function cancelBudgetMs(raw) {
  const requested = Number(raw);
  const max = T3_CANCEL_WINDOW_MS - CANCEL_CLEANUP_MS;
  return Number.isFinite(requested) && requested > 0 && requested <= max ? requested : CANCEL_BUDGET_MS;
}
