import type { QuotaClaimAudit, QuotaClaimLabelCount } from "@clankermux/types";
import {
	Table,
	TableBody,
	TableCell,
	TableFrame,
	TableHead,
	TableHeader,
	TableRow,
} from "../ui/table";

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
				// Bare: this table's only border is the `<details>` around it, and a
				// frame here would double it. Compact for the 14 columns — at the
				// comfortable padding they would add roughly 336px of width.
				<TableFrame variant="bare" className="mt-2">
					<Table className="text-xs" density="compact">
						<TableHeader className="bg-transparent">
							<TableRow className="border-t-0">
								<TableHead>Claim</TableHead>
								<TableHead>Rows</TableHead>
								<TableHead>Series</TableHead>
								<TableHead>Rows/day</TableHead>
								<TableHead>No reading</TableHead>
								<TableHead>Distinct values</TableHead>
								<TableHead>On 0.01 grid</TableHead>
								<TableHead>On 0.001 grid</TableHead>
								<TableHead>Transitions</TableHead>
								<TableHead>Min rise</TableHead>
								<TableHead>Median rise</TableHead>
								<TableHead>Same-window drops</TableHead>
								<TableHead>Gift drops</TableHead>
								<TableHead>Composition</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{audit.claims.map((claim) => (
								<TableRow key={claim.claim} className="align-top">
									<TableCell className="font-medium">{claim.claim}</TableCell>
									<TableCell className="figure">
										{claim.rows.toLocaleString()}
									</TableCell>
									<TableCell className="figure">
										{claim.nSeries} · {claim.nAccounts} acct
									</TableCell>
									<TableCell className="figure">
										{formatNumber(claim.rowsPerDay, 1)}
									</TableCell>
									<TableCell className="figure">
										{formatShare(claim.nullUtilizationShare)}
									</TableCell>
									<TableCell className="figure">
										{/* A capped tracker reports a FLOOR, and says so. */}
										{claim.distinctValuesExact ? "" : "≥"}
										{claim.distinctValues}
									</TableCell>
									<TableCell className="figure">
										{formatShare(claim.gridShare01)}
									</TableCell>
									<TableCell className="figure">
										{formatShare(claim.gridShare001)}
									</TableCell>
									<TableCell className="figure">
										{claim.transitions.toLocaleString()} (
										{claim.positiveIncrements.toLocaleString()} up)
									</TableCell>
									<TableCell className="figure">
										{formatNumber(claim.minPositiveIncrement, 4)}
									</TableCell>
									<TableCell className="figure">
										{formatNumber(claim.medianPositiveIncrement, 4)}
									</TableCell>
									<TableCell className="figure">
										{claim.stableResetNegatives.toLocaleString()} /{" "}
										{claim.stableResetTransitions.toLocaleString()}
									</TableCell>
									<TableCell className="figure">
										{claim.giftDrops.toLocaleString()} (
										{claim.giftDropsOrderingSuspect.toLocaleString()} ordering,{" "}
										{claim.giftDropsUnexplained.toLocaleString()} unexplained)
									</TableCell>
									<TableCell>
										{formatLabels(claim.composition.bySource)}
										<span className="block text-muted-foreground">
											{formatLabels(claim.composition.byHttpStatus)}
										</span>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</TableFrame>
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
