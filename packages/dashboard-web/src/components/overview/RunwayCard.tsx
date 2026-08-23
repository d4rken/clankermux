import type { KeyRunway } from "@clankermux/core";
import { effectiveRunwayOutcome, worstKeyRunway } from "@clankermux/core";
import { Hourglass } from "lucide-react";
import {
	describeRunwayCause,
	formatRunwayValue,
	runwayQualifier,
	runwayUnavailableReason,
} from "../../lib/runway-display";
import { MetricCard } from "./MetricCard";

interface RunwayCardProps {
	/** Per-key runway rows, straight from `/api/runway`. */
	runways: KeyRunway[];
	/** Account names for the pin labels and causes, from the same response. */
	accounts: { id: string; name: string }[];
	/**
	 * The parent's ticking clock. Every rendered duration is derived from
	 * `outcome.exhaustsAtMs` against this, so a countdown served by the endpoint
	 * keeps running between polls instead of freezing at the server snapshot.
	 */
	now: number;
	loading?: boolean;
	/** Set when the runway read failed and nothing is cached. */
	unavailableReason?: string;
	staleNote?: string;
}

/**
 * Overview tile: how long the pool can keep going at the current pace before an
 * API key has no account with quota left.
 *
 * The headline is the WORST runway across active keys, because a
 * provider-pinned key runs out when its own provider's accounts do, however
 * healthy the rest of the pool is.
 *
 * This is QUOTA, not availability: pauses, rate-limit cooldowns, usage
 * throttling and the provider-overload breaker are deliberately not counted, so
 * the copy must never promise routability.
 *
 * Summary only, in proportion with the other Overview tiles: the per-key
 * breakdown lives on the Usage page, behind the disclosure in
 * `LimitsCapacityOverview`.
 */
export function RunwayCard({
	runways,
	accounts,
	now,
	loading,
	unavailableReason,
	staleNote,
}: RunwayCardProps) {
	const worst = worstKeyRunway(runways, now);
	const activeRunways = runways.filter((runway) => runway.isActive);

	// `unavailableReason` is reserved for BACKING-READ failures — the incoming
	// prop, and a runway list with nothing active to speak for. It replaces the
	// value with an explicit unavailable state, which is exactly right for a read
	// that produced nothing and exactly wrong for an outcome that merely cannot
	// be STATED (unknown, no-accounts): that read SUCCEEDED, so its reason goes
	// in the caption beside a dash instead. The line the two sides of this split
	// hold is that a value is never derived from a read that failed. Precedence
	// in MetricCard is unavailable -> loading -> resolved, so a failed read is
	// never dressed up as a pending one.
	const unavailable =
		unavailableReason ??
		(worst === null ? "No active API keys or accounts" : undefined);
	// Only a resolved read may speak. The caption sits ABOVE MetricCard's
	// value/skeleton/dash branch and renders unconditionally, so anything derived
	// from `worst` has to be gated here or a pending or failed read would print a
	// resolved-sounding caption next to its own skeleton.
	const resolved = !loading && unavailable == null;

	const captionParts: string[] = [];
	if (worst && resolved) {
		// Read at `now`, like the headline: a served `runway` past its deadline is
		// an `out-now`, and it still names the accounts that ran the pool out.
		const effectiveKind = effectiveRunwayOutcome(worst.outcome, now).kind;
		// Only an outcome that carries causes actually identifies a constraining
		// key. When every key is beyond the horizon they all tie on severity and
		// `worstKeyRunway` returns whichever row came first out of the database —
		// naming that one would present row order as a finding. Nothing is
		// constraining there, so the caption states the SCOPE the figure covers
		// instead of a name.
		if (effectiveKind === "runway" || effectiveKind === "out-now") {
			// With one route there is nothing to disambiguate, so the key name is
			// only worth the width when several keys could be the limiting one.
			if (activeRunways.length > 1) captionParts.push(worst.keyName);
		} else if (effectiveKind === "beyond-horizon") {
			captionParts.push(
				`${activeRunways.length} key${activeRunways.length === 1 ? "" : "s"}`,
			);
		}
		// An unstateable outcome takes the "why" slot; the two are exclusive,
		// since an outcome that names a cause is one that can be stated.
		const cause =
			runwayUnavailableReason(worst.outcome) ??
			describeRunwayCause(worst.outcome, accounts, now);
		if (cause) captionParts.push(cause);
		const qualifier = runwayQualifier(worst.outcome, now);
		if (qualifier) captionParts.push(qualifier);
	}

	return (
		<MetricCard
			title="Quota Runway"
			icon={Hourglass}
			value={worst ? (formatRunwayValue(worst.outcome, now) ?? "—") : "—"}
			caption={captionParts.length > 0 ? captionParts.join(" · ") : undefined}
			unavailableReason={unavailable}
			staleNote={staleNote}
			loading={loading}
		/>
	);
}
