/**
 * Global, in-memory, single-account routing override ("force account").
 *
 * When a forced account id is set, EVERY non-internal client request is routed
 * straight to that account — bypassing account selection, all gates
 * (provider-overload / usage-throttle / context-window), and all failover/retry.
 * The forced account's response (including errors) is returned to the client
 * as-is, with no rate-limit/cooldown state mutation.
 *
 * Storage is a module-level singleton (not per-request): this is global,
 * API-set state. One account at a time is automatic — setting a new id replaces
 * the old. The value is ephemeral and clears on server restart.
 */

let forcedAccountId: string | null = null;

/**
 * Set (or clear, with `null`) the globally forced account id. Setting a new id
 * replaces any previous one — only one account can be forced at a time.
 */
export function setForcedAccount(id: string | null): void {
	forcedAccountId = id;
}

/**
 * Get the currently forced account id, or `null` if no account is forced.
 */
export function getForcedAccount(): string | null {
	return forcedAccountId;
}
