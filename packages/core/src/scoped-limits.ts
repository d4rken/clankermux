import type { AnthropicUsageData, CapacitySignal } from "@clankermux/types";
import type { ModelFamily } from "./model-mappings";
import { normalizeAnthropicUsage } from "./usage-normalizer";

/**
 * Percent at/above which a per-model-family weekly window counts as
 * "exhausted" for routing purposes. Anthropic reports 100 when a family's
 * weekly quota is spent.
 */
export const FAMILY_WEEKLY_EXHAUSTED_THRESHOLD_PERCENT = 100;

/**
 * A single per-model-family weekly limit that is currently exhausted (at/above
 * the threshold with a future reset). Derived from Anthropic's generic
 * `limits[]` array.
 */
export interface ScopedFamilyLimit {
	/** Resolved model family (non-null — unmatched display names are filtered). */
	family: ModelFamily;
	/** The reported utilization percent (>= threshold). */
	percent: number;
	/** Parsed `resets_at` in epoch ms (finite and in the future). */
	resetsAtMs: number;
	/** Anthropic's `is_active` flag, carried for logging (NOT gated on). */
	isActive: boolean;
	/** The scope model display name that resolved this family. */
	displayName: string;
}

/**
 * Extract the set of model families whose per-family weekly quota is currently
 * exhausted, from Anthropic's generic `limits[]` array.
 *
 * Sources the present scoped windows from {@link normalizeAnthropicUsage} (which
 * already requires a finite numeric percent, a resolvable family, and a finite
 * FUTURE reset — NaN/Infinity/stale entries are dropped, upholding the
 * positive-evidence rule) and then keeps only those at/above `thresholdPercent`.
 *
 * Unlike the old reader this NO LONGER requires the flat `five_hour`/`seven_day`
 * keys, so a `limits[]`-only payload is now read correctly. `is_active` is
 * carried through for logging but is NOT used to gate inclusion.
 *
 * Pure: no clock access (callers pass `now`), no cache/provider imports.
 * Returns `[]` for null/undefined or non-Anthropic-shaped usage data.
 */
export function getExhaustedFamilies(
	usageData: AnthropicUsageData | null | undefined,
	now: number,
	thresholdPercent: number = FAMILY_WEEKLY_EXHAUSTED_THRESHOLD_PERCENT,
): ScopedFamilyLimit[] {
	return normalizeAnthropicUsage(usageData, now).weeklyScoped.filter(
		(limit) => limit.percent >= thresholdPercent,
	);
}

/**
 * True iff the given `family`'s weekly quota is exhausted for this account AND
 * the account still has unified (5h/7d) headroom to serve other families.
 *
 * Fails open: returns `false` when `capacity` is null (stale/unknown) or when
 * unified headroom is also zero — in both cases this predicate must not be the
 * thing that sidelines the account.
 */
export function isFamilyWeeklyExhaustedWithHeadroom(
	usageData: AnthropicUsageData | null | undefined,
	capacity: CapacitySignal | null,
	family: ModelFamily,
	now: number,
	thresholdPercent: number = FAMILY_WEEKLY_EXHAUSTED_THRESHOLD_PERCENT,
): boolean {
	// Fail open on missing/stale/malformed capacity: require a finite, positive
	// headroom. A non-finite minHeadroom (NaN) must not pass this guard.
	if (
		capacity === null ||
		!Number.isFinite(capacity.minHeadroom) ||
		capacity.minHeadroom <= 0
	)
		return false;
	return getExhaustedFamilies(usageData, now, thresholdPercent).some(
		(limit) => limit.family === family,
	);
}
