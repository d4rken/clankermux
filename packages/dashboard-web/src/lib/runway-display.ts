import type { RunwayCause, RunwayOutcome } from "@clankermux/core";
import { effectiveRunwayOutcome } from "@clankermux/core";
import { formatDurationDhm } from "./format-prediction";

/**
 * Presentation rules for a capacity-runway outcome, shared by the Overview tile
 * and the Usage-page panel so the two can never state the same outcome
 * differently.
 *
 * Copy says QUOTA, never "available": the runway ignores pauses, cooldowns,
 * throttling and the overload breaker by design.
 *
 * Everything that renders a duration takes `now`. The outcome is served from
 * `/api/runway` and refreshed on a poll, so rendering the server's
 * `durationMs` verbatim would freeze the countdown between polls and could
 * still read "runway" after its own deadline had passed. The remaining time is
 * computed from `exhaustsAtMs` against the caller's clock instead — the same
 * 30s UI tick the surrounding tiles already run on.
 *
 * Reading a served outcome AT `now` is `effectiveRunwayOutcome`, which lives in
 * `@clankermux/core` beside the ranking that has to agree with it, not here.
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
 *
 * A finite runway computed while some of the key's accounts were unreadable is
 * a LOWER BOUND on that key's own runway — dropping an account can only shorten
 * it — so it carries a `≥`.
 *
 * `suppressBound` withdraws that notation. A caller that has itself set some
 * KEYS aside is no longer describing one key: excluding a key can only make the
 * figure LONGER than the truth, which is the opposite direction, and `≥ 6h` is
 * then a claim that is simply false if a hidden key runs out in two. With the
 * two uncertainties pointing opposite ways the compound direction is
 * indeterminate, so the honest render is the bare duration, scoped by whatever
 * the caller says about the keys it did and did not count.
 */
export function formatRunwayValue(
	outcome: RunwayOutcome,
	now: number,
	options?: { suppressBound?: boolean },
): string | null {
	const effective = effectiveRunwayOutcome(outcome, now);
	switch (effective.kind) {
		case "out-now":
			// An `out-now` is only as categorical as the pool it was computed over.
			// Accounts with no readable window are DROPPED before the scan runs, so
			// a key can read as spent purely because the accounts that could be read
			// were spent, while one that was merely un-polled sits there possibly
			// healthy. "Out of quota" is a definite claim and must not be made on a
			// pool that was not fully seen; the hedged form says the same thing
			// without asserting what the evidence cannot support, and the caller's
			// unobserved-count row says how much was missed.
			return effective.unprojectableAccountIds.length > 0
				? "Spent, unconfirmed"
				: "Out of quota";
		case "beyond-horizon":
			return BEYOND_HORIZON_GLYPH;
		case "runway": {
			const remaining = effective.exhaustsAtMs - now;
			return effective.unprojectableAccountIds.length > 0 &&
				!options?.suppressBound
				? `≥ ${formatDurationDhm(remaining)}`
				: formatDurationDhm(remaining);
		}
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
	now: number,
): string | null {
	const effective = effectiveRunwayOutcome(outcome, now);
	const causes: RunwayCause[] =
		effective.kind === "out-now" || effective.kind === "runway"
			? effective.causes
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
export function runwayQualifier(
	outcome: RunwayOutcome,
	now: number,
): string | null {
	const effective = effectiveRunwayOutcome(outcome, now);
	const parts: string[] = [];
	if (effective.kind === "beyond-horizon") {
		parts.push(`no run-out within ${formatDurationDhm(effective.horizonMs)}`);
	}
	const unknown = unprojectableCount(effective);
	if (unknown > 0) {
		parts.push(`${unknown} account${unknown === 1 ? "" : "s"} unknown`);
	}
	return parts.length > 0 ? parts.join(" · ") : null;
}
