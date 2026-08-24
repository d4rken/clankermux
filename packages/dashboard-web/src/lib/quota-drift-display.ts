import type {
	QuotaDriftCohort,
	QuotaDriftModel,
	QuotaDriftUnidentifiedReason,
} from "@clankermux/types";

/**
 * Display helpers for the Analytics "Quota" tab.
 *
 * The rule the whole tab is built around: a number is shown ONLY when the
 * server marked it identified. Everything else reads as a stated reason, never
 * as a zero, a dash, or a suspiciously precise figure with a wide interval
 * beside it. `null` from the wire means "we could not tell", and the copy has
 * to say that in words.
 */

/** What the panel says instead of a number, and why. */
export const UNIDENTIFIED_COPY: Record<QuotaDriftUnidentifiedReason, string> = {
	// Deliberately the SAME headline phrase for the two collinearity-shaped
	// causes: to a reader, "we cannot separate this model from the others" and
	// "the interval is too wide to mean anything" are the same answer.
	"wide-interval": "Not enough independent traffic (estimate too imprecise)",
	collinear:
		"Not enough independent traffic (always runs alongside another model)",
	"low-share": "Too little of this window's traffic to measure",
	"few-segments": "Not enough observations yet",
	"zero-estimate": "Not enough independent traffic (no measurable cost)",
};

/** One line explaining why a model has no number, or null when it has one. */
export function unidentifiedReasonText(model: QuotaDriftModel): string | null {
	if (model.latest?.identified) return null;
	const reasons = model.latest?.unidentifiedReasons ?? [];
	// Priority order, most informative first: a model that is BOTH collinear and
	// wide-intervalled is collinear, and saying so is more useful.
	for (const reason of [
		"collinear",
		"low-share",
		"few-segments",
		"wide-interval",
		"zero-estimate",
	] as const) {
		if (reasons.includes(reason)) return UNIDENTIFIED_COPY[reason];
	}
	return "Not enough independent traffic";
}

/** Human label for a usage window. */
export function quotaWindowLabel(window: string): string {
	if (window === "five_hour") return "5-hour window";
	if (window === "seven_day") return "Weekly window";
	return window.replace(/_/g, " ");
}

/**
 * Cohort heading: the provider and the tier the accounts were filed under.
 * A cohort with no captured tier says so rather than rendering an empty gap.
 */
export function cohortLabel(cohort: QuotaDriftCohort): string {
	const parts = [cohort.provider];
	if (cohort.planTier) parts.push(cohort.planTier);
	if (cohort.rateLimitTier) parts.push(cohort.rateLimitTier);
	return parts.length === 1
		? `${cohort.provider} (tier unknown)`
		: parts.join(" · ");
}

/** `2.28` points of window per 1M eq-tokens, or the stated absence. */
export function formatCoefficient(value: number | null): string | null {
	if (value == null || !Number.isFinite(value)) return null;
	return `${value.toFixed(2)}%`;
}

/** A confidence interval as `2.15 – 2.45%`, or null when either bound is absent. */
export function formatInterval(
	low: number | null,
	high: number | null,
): string | null {
	if (low == null || high == null) return null;
	if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
	return `${low.toFixed(2)} – ${high.toFixed(2)}%`;
}

/** Implied full-window capacity in millions of equivalent tokens. */
export function formatCapacity(mtok: number | null): string | null {
	if (mtok == null || !Number.isFinite(mtok)) return null;
	if (mtok >= 100) return `${Math.round(mtok)}M`;
	if (mtok >= 10) return `${mtok.toFixed(1)}M`;
	return `${mtok.toFixed(2)}M`;
}

/** Signed relative move, e.g. `-18%`. Negative means the model got cheaper. */
export function formatRelativeChange(relative: number): string {
	const pct = relative * 100;
	const sign = pct > 0 ? "+" : "";
	return `${sign}${pct.toFixed(0)}%`;
}

/**
 * Whether a `stable` verdict may be REPORTED as stable.
 *
 * The changepoint scan can run, find nothing and return `stable` for a model
 * whose coefficient is not identified in the first place. Presenting that as
 * "no change detected" would claim a negative result about a quantity the panel
 * refuses to print — so the tab downgrades it to the same "not enough
 * independent traffic" answer it gives everywhere else.
 */
export function isReportableVerdict(model: QuotaDriftModel): boolean {
	if (model.verdict === "changed") return model.changes.length > 0;
	if (model.verdict === "stable") return model.latest?.identified === true;
	return false;
}
