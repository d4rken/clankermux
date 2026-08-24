import type { QuotaClaimAudit, QuotaClaimLabelCount } from "@clankermux/types";

/**
 * The standing audit of the request-aligned claim series.
 *
 * Deliberately a COLLAPSED `<details>` at the bottom of the tab, and
 * deliberately not a chart. Everything above it is an analysis; this is the
 * material that analysis is built on, and it is counters — how coarse the
 * reported utilizations are, how often they are missing, how often they fall
 * inside one window, and what share of the rows are the proxy's own probes. A
 * chart would invite reading a trend into what is a census.
 *
 * Nothing here says anything about the provider. `composition` in particular is
 * NOT coverage: it describes the rows that were captured and is silent about any
 * response that was not.
 */
export function ClaimSeriesAuditPanel({
	audit,
}: {
	audit?: QuotaClaimAudit | null;
}) {
	// Absent, not empty: a payload written before the audit existed has nothing
	// to show, and an empty table would read as "the series is empty".
	if (!audit) return null;

	return (
		<details className="rounded-lg border p-3">
			<summary className="text-sm font-medium cursor-pointer">
				Claim-series audit
			</summary>
			<p className="text-xs text-muted-foreground max-w-prose mt-2">
				What is actually in the per-request rate-limit readings this proxy has
				captured, from {formatDay(audit.fromMs)} to {formatDay(audit.toMs)}.
				Counts only — nothing here is a statement about the provider. The
				composition figures describe the rows that were captured and say nothing
				about responses that were not.
			</p>
			{audit.claims.length === 0 ? (
				<p className="text-xs text-muted-foreground mt-2">
					No claim readings captured in this span.
				</p>
			) : (
				<div className="overflow-x-auto mt-2">
					<table className="w-full text-xs">
						<thead>
							<tr className="text-muted-foreground text-left">
								<th className="font-normal pb-1">Claim</th>
								<th className="font-normal pb-1">Rows</th>
								<th className="font-normal pb-1">Series</th>
								<th className="font-normal pb-1">Rows/day</th>
								<th className="font-normal pb-1">No reading</th>
								<th className="font-normal pb-1">Distinct values</th>
								<th className="font-normal pb-1">On 0.01 grid</th>
								<th className="font-normal pb-1">On 0.001 grid</th>
								<th className="font-normal pb-1">Transitions</th>
								<th className="font-normal pb-1">Min rise</th>
								<th className="font-normal pb-1">Median rise</th>
								<th className="font-normal pb-1">Same-window drops</th>
								<th className="font-normal pb-1">Gift drops</th>
								<th className="font-normal pb-1">Composition</th>
							</tr>
						</thead>
						<tbody>
							{audit.claims.map((claim) => (
								<tr key={claim.claim} className="border-t align-top">
									<td className="py-1 font-medium">{claim.claim}</td>
									<td className="py-1 tabular-nums">
										{claim.rows.toLocaleString()}
									</td>
									<td className="py-1 tabular-nums">
										{claim.nSeries} · {claim.nAccounts} acct
									</td>
									<td className="py-1 tabular-nums">
										{formatNumber(claim.rowsPerDay, 1)}
									</td>
									<td className="py-1 tabular-nums">
										{formatShare(claim.nullUtilizationShare)}
									</td>
									<td className="py-1 tabular-nums">
										{/* A capped tracker reports a FLOOR, and says so. */}
										{claim.distinctValuesExact ? "" : "≥"}
										{claim.distinctValues}
									</td>
									<td className="py-1 tabular-nums">
										{formatShare(claim.gridShare01)}
									</td>
									<td className="py-1 tabular-nums">
										{formatShare(claim.gridShare001)}
									</td>
									<td className="py-1 tabular-nums">
										{claim.transitions.toLocaleString()} (
										{claim.positiveIncrements.toLocaleString()} up)
									</td>
									<td className="py-1 tabular-nums">
										{formatNumber(claim.minPositiveIncrement, 4)}
									</td>
									<td className="py-1 tabular-nums">
										{formatNumber(claim.medianPositiveIncrement, 4)}
									</td>
									<td className="py-1 tabular-nums">
										{claim.stableResetNegatives.toLocaleString()} /{" "}
										{claim.stableResetTransitions.toLocaleString()}
									</td>
									<td className="py-1 tabular-nums">
										{claim.giftDrops.toLocaleString()} (
										{claim.giftDropsOrderingSuspect.toLocaleString()} ordering,{" "}
										{claim.giftDropsUnexplained.toLocaleString()} unexplained)
									</td>
									<td className="py-1">
										{formatLabels(claim.composition.bySource)}
										<span className="block text-muted-foreground">
											{formatLabels(claim.composition.byHttpStatus)}
										</span>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</details>
	);
}

/** A share as a percentage, or an em dash when there was no denominator. */
function formatShare(value: number | null): string {
	if (value == null || !Number.isFinite(value)) return "—";
	return `${(value * 100).toFixed(1)}%`;
}

/** A number at fixed precision, or an em dash when it is absent. */
function formatNumber(value: number | null, digits: number): string {
	if (value == null || !Number.isFinite(value)) return "—";
	return value.toFixed(digits);
}

/** `client 812 · keepalive 44`, in the order the audit reported them. */
function formatLabels(counts: QuotaClaimLabelCount[]): string {
	if (counts.length === 0) return "—";
	return counts
		.map((c) => `${c.label} ${c.count.toLocaleString()}`)
		.join(" · ");
}

/** Calendar day of a ms-epoch instant, in the reader's own timezone. */
function formatDay(ms: number): string {
	return new Date(ms).toLocaleDateString();
}
