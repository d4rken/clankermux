import {
	extractUnifiedClaimReadings,
	REJECTING_STATUSES,
} from "@clankermux/core";
import { isAnthropicOutOfCredits } from "@clankermux/providers";
import type { Account, QuotaDerivedRateLimitReason } from "@clankermux/types";

export interface AccountQuota429 {
	binding: "session" | "weekly";
	reason: QuotaDerivedRateLimitReason;
	/** Absent when no rejected claim has a usable reset: use adaptive backoff. */
	resetTime?: number;
}

const HOUR_MS = 60 * 60 * 1000;
// Allow small clock/rounding differences, never a different quota's horizon.
const RESET_TOLERANCE_MS = 60_000;

/**
 * A trusted 429's explicit account-wide claims outrank a lagging usage poll.
 * The summary retry-after/reset can describe a scoped weekly claim even while
 * 5h rejects: using it account-wide caused Claude-1's 2026-09-07 24-hour lock.
 *
 * Null means no live account-quota decision. A rejected claim with no usable
 * reset still has a known cause; callers use the existing adaptive backoff
 * rather than disguising a synthesized deadline as a server-directed reset.
 * Callers retain their synthetic-probe exemptions and billing precedence.
 */
export function resolveLiveAccountQuota429(
	account: Pick<Account, "provider" | "custom_endpoint">,
	response: Response,
	now: number = Date.now(),
): AccountQuota429 | null {
	if (
		response.status !== 429 ||
		account.provider !== "anthropic" ||
		account.custom_endpoint ||
		isAnthropicOutOfCredits(response)
	)
		return null;

	let binding: AccountQuota429["binding"] | null = null;
	let latestReset: number | null = null;
	for (const reading of extractUnifiedClaimReadings(response.headers)) {
		if (reading.claim !== "5h" && reading.claim !== "7d") continue;
		if (!REJECTING_STATUSES.has(reading.status)) continue;
		if (reading.claim === "7d") binding = "weekly";
		else binding ??= "session";

		const horizon = reading.claim === "5h" ? 5 * HOUR_MS : 7 * 24 * HOUR_MS;
		if (
			reading.resetMs !== null &&
			reading.resetMs > now &&
			reading.resetMs <= now + horizon + RESET_TOLERANCE_MS
		) {
			latestReset = Math.max(latestReset ?? 0, reading.resetMs);
		}
	}
	if (binding === null) return null;
	return {
		binding,
		reason:
			binding === "weekly" ? "weekly_exhausted_429" : "session_exhausted_429",
		// Every rejecting account-wide window must reset. The displayed cause
		// remains weekly-first even when the five-hour reset is later.
		resetTime: latestReset ?? undefined,
	};
}
