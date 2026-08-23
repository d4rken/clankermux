import type { KeyRunway } from "@clankermux/core";
import { effectiveRunwayOutcome, summarizeKeyRunways } from "@clankermux/core";
import type { RunwayAccountSummary } from "@clankermux/types";
import { Hourglass } from "lucide-react";
import { formatDurationDhm } from "../../lib/format-prediction";
import {
	describeRunwayCause,
	formatRunwayValue,
	runwayUnavailableReason,
	unprojectableCount,
} from "../../lib/runway-display";
import {
	msUntilNextReset,
	reachableAccounts,
	tightestWindow,
} from "../../lib/runway-evidence";
import { MetricCard, type MetricCardSubRow } from "./MetricCard";
import { RunwayHorizonStrip } from "./RunwayHorizonStrip";

interface RunwayCardProps {
	/** Per-key runway rows, straight from `/api/runway`. */
	runways: KeyRunway[];
	/** The account evidence from the same response. */
	accounts: RunwayAccountSummary[];
	/** The horizon the scan modelled, from the same response. */
	horizonMs: number;
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
 * The headline is the worst STATEABLE runway across active keys — see
 * `summarizeKeyRunways`. A key whose accounts have no readable window is set
 * aside and counted, rather than taking the whole tile to a dash: with eleven
 * keys across two providers, one un-polled account would otherwise blank a
 * summary that ten other keys have perfect evidence for. Because dropping a key
 * can only make the surviving figure LONGER, the count it was measured over
 * travels with it in the caption and in an explicit sub-row — the figure is not
 * honest without it.
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
	horizonMs,
	now,
	loading,
	unavailableReason,
	staleNote,
}: RunwayCardProps) {
	const headline = summarizeKeyRunways(runways, now);
	const worst = headline.worst;

	// `unavailableReason` is reserved for BACKING-READ failures — the incoming
	// prop, and a runway list with nothing stateable to speak for. It replaces
	// the value with an explicit unavailable state, which is exactly right for a
	// read that produced nothing and exactly wrong for an outcome that merely
	// cannot be STATED: that read SUCCEEDED, so its reason goes in the caption
	// beside a dash instead. The line the two sides of this split hold is that a
	// value is never derived from a read that failed. Precedence in MetricCard is
	// unavailable -> loading -> resolved, so a failed read is never dressed up as
	// a pending one.
	//
	// Gated on `loading` as well, because the parent passes `runway?.keys ?? []`
	// and an empty list is what the FIRST fetch looks like. Synthesizing the
	// reason before the read resolves outranks MetricCard's own loading branch,
	// so the tile would open on a warning instead of a skeleton.
	const unavailable =
		unavailableReason ??
		(!loading && headline.activeKeyCount === 0
			? "No active API keys or accounts"
			: undefined);
	// Only a resolved read may speak. The caption sits ABOVE MetricCard's
	// value/skeleton/dash branch and renders unconditionally, so anything derived
	// from the headline has to be gated here or a pending or failed read would
	// print a resolved-sounding caption next to its own skeleton.
	const resolved = !loading && unavailable == null;

	// Scope, or the reason an outcome that CAN be stated still names no figure —
	// `no-accounts` is definite and unquantifiable, and its reason is worth more
	// than a key count. Never a key NAME: that used to live here and now sits
	// under the strip's marker, at the instant it explains. A caption is a single
	// unbounded line in a quarter-width tile and truncated the moment it carried
	// more than one fact.
	//
	// `worst === null` here means active keys EXIST but none can be stated: the
	// read succeeded and simply has nothing to project from. That is a resolved
	// dash with a reason beside it, never the unavailable slot — routing it there
	// would present a successful read as a failed one.
	const unquantifiable = worst
		? runwayUnavailableReason(worst.outcome)
		: "No quota evidence for any account";
	const caption = !resolved
		? undefined
		: (unquantifiable ??
			(headline.unobservedKeyCount > 0
				? `${headline.statedKeyCount} of ${headline.activeKeyCount} keys`
				: `${headline.activeKeyCount} key${headline.activeKeyCount === 1 ? "" : "s"}`));

	const effective = worst ? effectiveRunwayOutcome(worst.outcome, now) : null;
	const exhaustsAtMs =
		effective?.kind === "runway"
			? effective.exhaustsAtMs
			: effective?.kind === "out-now"
				? now
				: null;
	// The account and window that runs out — and nothing else. There is
	// deliberately no fallback to the KEY's name: `describeRunwayCause` returns
	// null exactly when the outcome names no cause, which is exactly when the
	// strip draws an empty track, and when several keys tie on outcome the one
	// the headline picked is database row order. Labelling a marker with it would
	// put that order on screen as a finding.
	const markerLabel = worst
		? describeRunwayCause(worst.outcome, accounts, now)
		: null;

	// Scoped to what the ACTIVE keys can actually reach, so an account no key
	// routes to cannot drive a reading the runway figure never considered.
	const pool = reachableAccounts(runways, accounts);
	const tightest = tightestWindow(pool, now);
	const nextResetMs = msUntilNextReset(pool, now);

	const subRows: MetricCardSubRow[] = [
		{
			label: "Tightest",
			value: tightest?.label ?? "—",
			tooltip: tightest
				? tightest.detail
				: "No account this pool can reach reported a window utilization",
		},
		{
			label: "Next reset",
			value: nextResetMs == null ? "—" : formatDurationDhm(nextResetMs),
			tooltip:
				nextResetMs == null
					? "No window reported a reset still ahead"
					: "Soonest quota window reset across the reachable pool",
		},
	];
	// Two different ways evidence goes missing, both of which make the figure a
	// BOUND rather than a reading, so both have to be on screen beside it:
	//  - keys set aside entirely, which can only make the figure LONGER than the
	//    truth (a hidden key might be the worst one);
	//  - accounts the winning key could not read, which can only make it SHORTER
	//    (fewer accounts to survive on), which the value's `≥` marks on its own
	//    whenever no key was also set aside. When both hold the compound
	//    direction is indeterminate, the `≥` is withdrawn, and this row is the
	//    only thing left saying the figure is not a plain reading.
	const unobservedAccounts = worst ? unprojectableCount(worst.outcome) : 0;
	if (headline.unobservedKeyCount > 0 || unobservedAccounts > 0) {
		const parts: string[] = [];
		if (headline.unobservedKeyCount > 0) {
			parts.push(
				`${headline.unobservedKeyCount} key${headline.unobservedKeyCount === 1 ? "" : "s"}`,
			);
		}
		if (unobservedAccounts > 0) {
			parts.push(
				`${unobservedAccounts} account${unobservedAccounts === 1 ? "" : "s"}`,
			);
		}
		const tooltipParts: string[] = [];
		if (headline.unobservedKeyCount > 0) {
			tooltipParts.push(
				`No quota evidence for any account ${headline.unobservedKeyCount === 1 ? "one key" : `${headline.unobservedKeyCount} keys`} can reach, so the figure covers only ${headline.statedKeyCount} of ${headline.activeKeyCount} and the real runway can be shorter.`,
			);
		}
		if (unobservedAccounts > 0) {
			tooltipParts.push(
				`${unobservedAccounts} account${unobservedAccounts === 1 ? "" : "s"} the headline key can route to had no readable window, so its figure is a lower bound.`,
			);
		}
		subRows.push({
			label: "Unobserved",
			value: parts.join(" · "),
			tooltip: tooltipParts.join(" "),
		});
	}

	return (
		<MetricCard
			title="Quota Runway"
			icon={Hourglass}
			// A stateable outcome can still decline to name a figure —
			// `no-accounts` is definite AND unquantifiable. Its reason goes in the
			// caption above; the figure slot holds a dash, never prose.
			//
			// `suppressBound` once any key was set aside: the row-level `≥` claims
			// "at least this long", and a key excluded for want of evidence could
			// run out sooner than the figure, which would make that claim false.
			value={
				(worst
					? formatRunwayValue(worst.outcome, now, {
							suppressBound: headline.unobservedKeyCount > 0,
						})
					: null) ?? "—"
			}
			caption={caption}
			afterValue={
				<RunwayHorizonStrip
					exhaustsAtMs={exhaustsAtMs}
					horizonMs={horizonMs}
					now={now}
					markerLabel={markerLabel}
				/>
			}
			subRows={subRows}
			unavailableReason={unavailable}
			staleNote={staleNote}
			loading={loading}
		/>
	);
}
