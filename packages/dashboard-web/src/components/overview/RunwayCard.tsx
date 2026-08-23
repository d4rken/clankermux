import { Hourglass } from "lucide-react";
import type { KeyRunway } from "../../lib/api-key-runway";
import { worstKeyRunway } from "../../lib/api-key-runway";
import {
	describeRunwayCause,
	formatRunwayValue,
	runwayQualifier,
	runwayUnavailableReason,
} from "../../lib/runway-display";
import { MetricCard, type MetricCardSubRow } from "./MetricCard";

interface RunwayCardProps {
	/** Per-key runways from `computeApiKeyRunways`. */
	runways: KeyRunway[];
	accounts: { id: string; name: string }[];
	loading?: boolean;
	/** Set when the accounts or API-keys read failed and nothing is cached. */
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
 * the copy must never promise routability. `now` is not read here — the parent
 * recomputes the runways on its existing 30s UI refresh.
 */
export function RunwayCard({
	runways,
	accounts,
	loading,
	unavailableReason,
	staleNote,
}: RunwayCardProps) {
	const worst = worstKeyRunway(runways);
	const activeRunways = runways.filter((runway) => runway.isActive);

	// `unavailableReason` is reserved for BACKING-READ failures — the incoming
	// prop, and a runway list with nothing active to speak for. MetricCard drops
	// the sub-rows along with the value when it is set, so an outcome that merely
	// cannot be STATED (unknown, no-accounts) must not travel through it: the
	// other keys' definite figures have to stay reachable. Precedence in
	// MetricCard is unavailable -> loading -> resolved, so a failed read is never
	// dressed up as a pending one.
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
		// With one route there is nothing to disambiguate, so the key name is only
		// worth the width when several keys could be the limiting one.
		if (activeRunways.length > 1) captionParts.push(worst.keyName);
		// An unstateable outcome takes the "why" slot; the two are exclusive,
		// since an outcome that names a cause is one that can be stated.
		const cause =
			runwayUnavailableReason(worst.outcome) ??
			describeRunwayCause(worst.outcome, accounts);
		if (cause) captionParts.push(cause);
		const qualifier = runwayQualifier(worst.outcome);
		if (qualifier) captionParts.push(qualifier);
	}

	const subRows: MetricCardSubRow[] = activeRunways.map((runway) => ({
		label: runway.keyName,
		value: formatRunwayValue(runway.outcome) ?? "—",
		tooltip: runwayUnavailableReason(runway.outcome) ?? runway.pinLabel,
	}));

	return (
		<MetricCard
			title="Quota Runway"
			icon={Hourglass}
			value={worst ? (formatRunwayValue(worst.outcome) ?? "—") : "—"}
			caption={captionParts.length > 0 ? captionParts.join(" · ") : undefined}
			unavailableReason={unavailable}
			staleNote={staleNote}
			loading={loading}
			subRows={subRows}
		/>
	);
}
