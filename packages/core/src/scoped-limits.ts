import type { AnthropicUsageData, CapacitySignal } from "@clankermux/types";
import { getModelFamily, type ModelFamily } from "./model-mappings";

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
 * A `weekly_scoped` entry qualifies when its `percent` is a number at/above
 * `thresholdPercent`, its `resets_at` parses to a finite future timestamp, and
 * its scope model display name resolves to a known family. `is_active` is
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
	if (!usageData) return [];
	// Anthropic shape guard — mirror dashboard-web/src/lib/secondary-limits.ts.
	if (!("five_hour" in usageData) || !("seven_day" in usageData)) return [];

	const results: ScopedFamilyLimit[] = [];
	for (const entry of usageData.limits ?? []) {
		if (entry.kind !== "weekly_scoped") continue;
		// Require finite numeric evidence: NaN/Infinity must never qualify as
		// "exhausted" (NaN < threshold is false, so an unguarded NaN would slip
		// through and violate the positive-evidence rule).
		if (typeof entry.percent !== "number" || !Number.isFinite(entry.percent))
			continue;
		if (entry.percent < thresholdPercent) continue;
		if (entry.resets_at == null) continue;

		const resetsAtMs = new Date(entry.resets_at).getTime();
		if (!Number.isFinite(resetsAtMs)) continue;
		if (resetsAtMs <= now) continue;

		const displayName = entry.scope?.model?.display_name ?? "";
		const family = getModelFamily(displayName);
		if (family === null) continue;

		results.push({
			family,
			percent: entry.percent,
			resetsAtMs,
			isActive: entry.is_active,
			displayName,
		});
	}
	return results;
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
