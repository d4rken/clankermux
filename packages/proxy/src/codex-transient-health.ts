/** Short-lived routing hints, independent of quota state. Never excludes an account. */
const failures = new Map<string, { until: number; observedAt: number }>();
const DEMOTION_MS = 60_000;
const MAX_ENTRIES = 1_000;

/**
 * `streamFailureCode` reports the error's `code` whenever one is present, so a
 * bare type only ever arrives on a payload that carries none:
 *   {"error":{"type":"server_error","code":"server_error"}}
 *   {"error":{"type":"service_unavailable_error","code":"server_is_overloaded"}}
 */
export function isCodexTransientError(reason: string | null): boolean {
	return (
		reason === "server_error" ||
		reason === "service_unavailable_error" ||
		reason === "server_is_overloaded"
	);
}

export function recordCodexTransientFailure(
	accountId: string,
	now = Date.now(),
): void {
	for (const [id, entry] of failures) {
		if (entry.until <= now) failures.delete(id);
	}
	// Refresh insertion order so eviction forgets the oldest observation.
	failures.delete(accountId);
	if (failures.size >= MAX_ENTRIES) {
		const oldest = failures.keys().next().value;
		if (oldest !== undefined) failures.delete(oldest);
	}
	failures.set(accountId, { until: now + DEMOTION_MS, observedAt: now });
}

export function getCodexTransientFailureUntil(
	accountId: string,
	now = Date.now(),
): number | null {
	const entry = failures.get(accountId);
	if (!entry) return null;
	if (entry.until <= now) {
		failures.delete(accountId);
		return null;
	}
	return entry.until;
}

/** An older in-flight success must not erase a more recent failure. */
export function clearCodexTransientFailure(
	accountId: string,
	requestStartedAt: number,
): void {
	const entry = failures.get(accountId);
	if (entry && entry.observedAt < requestStartedAt) failures.delete(accountId);
}

export function resetCodexTransientHealthForTests(): void {
	failures.clear();
}
