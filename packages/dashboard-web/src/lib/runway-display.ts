import type { RunwayCause, RunwayOutcome } from "@clankermux/core";
import { formatDurationDhm } from "./format-prediction";

/**
 * Presentation rules for a capacity-runway outcome, shared by the Overview tile
 * and the Usage-page panel so the two can never state the same outcome
 * differently.
 *
 * Copy says QUOTA, never "available": the runway ignores pauses, cooldowns,
 * throttling and the overload breaker by design.
 */

/** Rendered for `beyond-horizon`: no run-out inside the modelled window. */
export const BEYOND_HORIZON_GLYPH = "∞";

/**
 * Why a runway cannot be stated at all, or null when it can. Callers render
 * this as an explicit unavailable state — NEVER as a fallback zero.
 */
export function runwayUnavailableReason(outcome: RunwayOutcome): string | null {
	switch (outcome.kind) {
		case "no-accounts":
			return "No accounts this key can route to";
		case "unknown":
			return "No quota evidence for any account";
		default:
			return null;
	}
}

/**
 * The headline figure, or null when {@link runwayUnavailableReason} applies.
 * A finite runway computed while some accounts were unreadable is a LOWER
 * BOUND, so it carries a `≥`.
 */
export function formatRunwayValue(outcome: RunwayOutcome): string | null {
	switch (outcome.kind) {
		case "out-now":
			return "Out of quota";
		case "beyond-horizon":
			return BEYOND_HORIZON_GLYPH;
		case "runway":
			return outcome.unprojectableAccountIds.length > 0
				? `≥ ${formatDurationDhm(outcome.durationMs)}`
				: formatDurationDhm(outcome.durationMs);
		default:
			return null;
	}
}

/** Short name for a runway window kind. */
export function runwayWindowLabel(windowKind: string): string {
	if (windowKind === "five_hour") return "5-hour";
	if (windowKind === "seven_day") return "weekly";
	return windowKind.replace(/_/g, " ");
}

/**
 * Which account and window ran the pool out, or null when the outcome names no
 * cause. Ties are summarised rather than listed: the first cause plus a count.
 */
export function describeRunwayCause(
	outcome: RunwayOutcome,
	accounts: { id: string; name: string }[],
): string | null {
	const causes: RunwayCause[] =
		outcome.kind === "out-now" || outcome.kind === "runway"
			? outcome.causes
			: [];
	const first = causes[0];
	if (!first) return null;
	const name =
		accounts.find((account) => account.id === first.accountId)?.name ??
		first.accountId;
	const label = `${name} ${runwayWindowLabel(first.windowKind)}`;
	return causes.length > 1 ? `${label} +${causes.length - 1} more` : label;
}

/** How many eligible accounts had no readable quota window. */
export function unprojectableCount(outcome: RunwayOutcome): number {
	switch (outcome.kind) {
		case "out-now":
		case "beyond-horizon":
		case "runway":
			return outcome.unprojectableAccountIds.length;
		default:
			return 0;
	}
}

/**
 * The note that qualifies the headline: what the `beyond-horizon` glyph
 * actually checked, or how many accounts the figure could not see.
 */
export function runwayQualifier(outcome: RunwayOutcome): string | null {
	const parts: string[] = [];
	if (outcome.kind === "beyond-horizon") {
		parts.push(`no run-out within ${formatDurationDhm(outcome.horizonMs)}`);
	}
	const unknown = unprojectableCount(outcome);
	if (unknown > 0) {
		parts.push(`${unknown} account${unknown === 1 ? "" : "s"} unknown`);
	}
	return parts.length > 0 ? parts.join(" · ") : null;
}
