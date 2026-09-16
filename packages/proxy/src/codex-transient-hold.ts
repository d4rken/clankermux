import { abortableSleep } from "./handlers/transparent-retry";

// ---------------------------------------------------------------------------
// Tuning for the in-band Codex failure hold.
//
// A Codex account that fails in-band before generating content (the rung in
// handlers/proxy-operations.ts) usually recovers within seconds, so the request
// waits and retries the SAME account once before handing the work to a sibling.
// ---------------------------------------------------------------------------

/** How long one held retry waits before re-attempting the same account. */
export const CODEX_TRANSIENT_HOLD_MS = 30_000;

/** Whole-request ceiling: up to two held retries, first-come. */
export const CODEX_TRANSIENT_HOLD_TOTAL_BUDGET_MS = 60_000;

/** Held retries per ATTEMPT — one, then the account fails over. */
export const CODEX_TRANSIENT_MAX_RETRY = 1;

// Test-only overrides. They are independent on purpose: a single knob would
// drive both the sleep and the budget arithmetic, so no test could reach budget
// exhaustion without also sleeping for real. Production never sets either.
let holdOverrideMs: number | null = null;
let holdTotalBudgetOverrideMs: number | null = null;

export function codexTransientHoldMs(): number {
	return holdOverrideMs ?? CODEX_TRANSIENT_HOLD_MS;
}

export function codexTransientHoldTotalBudgetMs(): number {
	return holdTotalBudgetOverrideMs ?? CODEX_TRANSIENT_HOLD_TOTAL_BUDGET_MS;
}

/** Test-only override of the per-hold wait. Pass null to restore the default. */
export function setCodexTransientHoldOverrideForTests(ms: number | null): void {
	holdOverrideMs = ms;
}

/** Test-only override of the request budget. Pass null to restore the default. */
export function setCodexTransientHoldTotalBudgetOverrideForTests(
	ms: number | null,
): void {
	holdTotalBudgetOverrideMs = ms;
}

/**
 * Wait `ms` before retrying the failed account, returning early when the client
 * disconnects. Never rejects: the caller re-checks `signal.aborted` to tell the
 * two exits apart.
 */
export function holdBeforeCodexRetry(
	ms: number,
	signal: AbortSignal,
): Promise<void> {
	return abortableSleep(ms, signal).then(() => undefined);
}
