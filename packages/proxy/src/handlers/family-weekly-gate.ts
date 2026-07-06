import {
	getExhaustedFamilies,
	getModelFamily,
	isFamilyWeeklyExhaustedWithHeadroom,
	type ModelFamily,
} from "@clankermux/core";
import type { AnyUsageData } from "@clankermux/providers";
import type {
	Account,
	AnthropicUsageData,
	CapacitySignal,
} from "@clankermux/types";

/** Fallback Retry-After (seconds) when no usable family reset time is known. */
const RETRY_AFTER_FALLBACK_SECONDS = 60;

/**
 * Max age of cached usage data the family-weekly gate will trust (2× the 90s
 * default usage poll interval, matching `ensureUsageFreshForSelection`). Older
 * than this, `getFreshCapacity` returns null and the gate fails open. A plain
 * constant (not a config knob) keeps this off the request hot path and out of
 * every proxy test's ctx.config mock.
 */
export const FAMILY_WEEKLY_MAX_USAGE_AGE_MS = 180_000;

/**
 * An Anthropic account excluded from serving a request because the request's
 * model family has exhausted its weekly quota, while the account still has
 * unified (5h/7d) headroom for other families.
 */
export interface FamilyWeeklyExcludedAccount {
	account: Account;
	/** The requested model family that is weekly-exhausted on this account. */
	family: ModelFamily;
	/** Epoch ms at which the family's weekly window resets. */
	resetAt: number;
}

/**
 * Pure per-account decision for the proactive family-weekly gate.
 *
 * Returns an exclusion (carrying the family reset time) when the account's
 * requested model family is weekly-exhausted AND the account still has unified
 * headroom for other families; otherwise returns null (keep the account).
 *
 * Fails open: an unresolved family, or null/stale/malformed capacity, yields
 * null — this gate must never be the thing that sidelines an account on missing
 * evidence (the account-wide cooldown path remains the fallback). The Anthropic
 * shape guard lives in the core predicate, so non-Anthropic usage data is
 * handled safely even though the cast below asserts the Anthropic shape.
 */
export function resolveFamilyWeeklyExclusion(
	account: Account,
	modelForGate: string | null,
	usageData: AnyUsageData | null,
	capacity: CapacitySignal | null,
	now: number,
): FamilyWeeklyExcludedAccount | null {
	const family = modelForGate ? getModelFamily(modelForGate) : null;
	if (!family) return null;
	// The core predicate/parser shape-guard non-Anthropic data, so this cast is
	// safe — mirrors dashboard-web/src/lib/secondary-limits.ts.
	const data = (usageData ?? undefined) as AnthropicUsageData | undefined;
	if (!isFamilyWeeklyExhaustedWithHeadroom(data, capacity, family, now)) {
		return null;
	}
	// The predicate above guarantees a matching exhausted entry exists; fall back
	// defensively to `now` so a non-finite reset can never poison Retry-After.
	const match = getExhaustedFamilies(data, now).find(
		(e) => e.family === family,
	);
	return { account, family, resetAt: match?.resetsAtMs ?? now };
}

/**
 * Build the fail-clean 429 returned when every candidate account's requested
 * model family is weekly-exhausted. `Retry-After` is derived from the soonest
 * family reset across the excluded accounts (falling back to a fixed default
 * when no finite future reset is known).
 */
export function createFamilyWeeklyExhaustedResponse(
	excluded: FamilyWeeklyExcludedAccount[],
	family: ModelFamily,
	requestModel: string | null,
	now: number,
): Response {
	const soonestReset = excluded.reduce(
		(min, e) => (e.resetAt < min ? e.resetAt : min),
		Number.POSITIVE_INFINITY,
	);
	const hasFutureReset = Number.isFinite(soonestReset) && soonestReset > now;
	const retryAfterSeconds = hasFutureReset
		? Math.max(1, Math.ceil((soonestReset - now) / 1000))
		: RETRY_AFTER_FALLBACK_SECONDS;
	const resetIso = hasFutureReset ? new Date(soonestReset).toISOString() : null;
	const names = excluded.map((e) => e.account.name).join(", ");
	const message =
		`All available accounts have exhausted their weekly "${family}" quota ` +
		`(account(s): ${names})${resetIso ? `; soonest reset at ${resetIso}` : ""}. ` +
		`Other model families on these accounts are unaffected.`;

	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "rate_limit_error",
				message,
				request_model: requestModel,
				family,
				excluded_accounts: excluded.map((e) => ({
					name: e.account.name,
					resets_at: Number.isFinite(e.resetAt)
						? new Date(e.resetAt).toISOString()
						: null,
				})),
			},
		}),
		{
			status: 429,
			headers: {
				"Content-Type": "application/json",
				"Retry-After": String(retryAfterSeconds),
				"x-clankermux-pool-status": "family-weekly-exhausted",
			},
		},
	);
}
