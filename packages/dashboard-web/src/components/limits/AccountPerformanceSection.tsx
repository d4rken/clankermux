import type { PaymentsSummary } from "@clankermux/types";
import { formatUsd } from "@clankermux/ui-common";
import { AlertCircle } from "lucide-react";
import { useMemo } from "react";
import { CHART_TOKENS } from "../../constants";
import { BaseBarChart } from "../charts";
import type { ChartDataPoint } from "../charts/types";
import {
	type AccountCostRow,
	getAccountCostTotals,
	getSortedAccountCostRows,
	hasAnyAccountCostData,
} from "../overview/account-cost-table-utils";
import { TimeRangeSelector } from "../overview/TimeRangeSelector";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import {
	amortizedMonthlyByAccountName,
	formatValueRatio,
} from "./payments-utils";

// Reuse the canonical cost-row shape and add the chart-only fields, so the
// cost columns can't drift from `AccountCostRow`.
export type AccountPerformanceRow = AccountCostRow & {
	requests: number;
	successRate: number;
};

/**
 * Range-scoped cost headlines shown atop the card (formerly the standalone Plan
 * Value / API Cost tiles). `planCostUsd` follows this card's range; the two
 * averages are server-computed over fixed 7-day / 30-day windows and do NOT
 * move with the selector. Cost / Value Ratio come from the payments summary.
 *
 * Every field is NULLABLE, and null renders as "—". A pending or failed
 * analytics read has no figure to show, and `?? 0` there would print "$0.00" —
 * indistinguishable from a range that genuinely cost nothing.
 */
export interface AccountPerformanceCostSummary {
	planCostUsd: number | null;
	avgDailyPlanCostUsd: number | null;
	avgWeeklyPlanCostUsd: number | null;
}

interface AccountPerformanceSectionProps {
	accountPerformance: AccountPerformanceRow[];
	loading: boolean;
	/**
	 * Set when the analytics read FAILED with nothing cached. Distinct from
	 * `loading` and from a genuinely empty range: bars with no series read as "no
	 * traffic in this range", a measurement claim a failed read never made.
	 */
	unavailable?: boolean;
	/** Selected time range (controlled); re-keys the parent's analytics query. */
	range: string;
	onRangeChange: (range: string) => void;
	costSummary: AccountPerformanceCostSummary;
	/** Payments-ledger summary for the same range; undefined while loading. */
	paymentsSummary?: PaymentsSummary;
}

/**
 * Account Performance card: a range-controlled bar chart, the per-account
 * cost-breakdown table, and the folded-in Plan Value / Cost / Value Ratio
 * summary band. Presentational — range state, the cost totals, and the
 * payments summary are supplied by the parent.
 */
export function AccountPerformanceSection({
	accountPerformance,
	loading,
	unavailable = false,
	range,
	onRangeChange,
	costSummary,
	paymentsSummary,
}: AccountPerformanceSectionProps) {
	const sortedAccountCostRows = useMemo(
		() => getSortedAccountCostRows(accountPerformance),
		[accountPerformance],
	);
	const accountCostTotals = useMemo(
		() => getAccountCostTotals(sortedAccountCostRows),
		[sortedAccountCostRows],
	);
	// Analytics rows only carry the account *name*, so the subscription join is
	// by accountName (names are unique per account in practice).
	const subMonthlyByName = useMemo(
		() => amortizedMonthlyByAccountName(paymentsSummary?.perAccount ?? []),
		[paymentsSummary],
	);

	// Fixed-window plan-value averages (7d / 30d) shown under the Plan Value
	// headline — these don't move with the range selector above.
	const planAvgRows = [
		{
			label: "Avg / day",
			title:
				"Average daily plan value over the last 7 days (fixed window, independent of the range above)",
			value: costSummary.avgDailyPlanCostUsd,
		},
		{
			label: "Avg / week",
			title:
				"Average weekly plan value, derived from the last 30 days (fixed window, independent of the range above)",
			value: costSummary.avgWeeklyPlanCostUsd,
		},
	];

	// The cost table foots up the rows it was handed, so an unread range would
	// total to $0.00 — a measured-looking zero. Table and totals wait for a
	// resolved read; precedence is `unavailable` -> `loading` -> resolved.
	const analyticsResolved = !unavailable && !loading;

	// Amortized subscription run rates shown under the Cost headline —
	// range-independent, derived from configured renewal prices.
	const costAmortizedRows = [
		{
			label: "Amortized / day",
			title:
				"Daily subscription run rate from configured renewal prices (independent of the range above)",
			value: paymentsSummary?.amortizedDailyUsd,
		},
		{
			label: "Amortized / week",
			title:
				"Weekly subscription run rate from configured renewal prices (independent of the range above)",
			value: paymentsSummary?.amortizedWeeklyUsd,
		},
	];

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between gap-group">
					<div>
						<CardTitle>Account Performance</CardTitle>
						<CardDescription>
							Request distribution, success rates, and cost by account
						</CardDescription>
					</div>
					<TimeRangeSelector value={range} onChange={onRangeChange} />
				</div>
			</CardHeader>
			<CardContent>
				{/* Range-scoped Plan Value / Cost / Value Ratio headlines (formerly
				    standalone tiles). The averages below Plan Value are fixed 7d/30d
				    windows and stay put when the range above changes; the amortized
				    rows under Cost are likewise range-independent run rates. */}
				<div className="mb-4 grid grid-cols-2 md:grid-cols-3 gap-group border-b pb-4">
					{/* Every figure in this card is a range AGGREGATE — hundreds to
					    tens of thousands of dollars — so they all take the money
					    formatter: two decimals, grouped. `formatCost`'s four decimals
					    exist for per-request token costs, where a sub-cent difference is
					    real; here they only produced "$16378.2839" sitting beside a
					    "$600.00" that came from the other formatter. */}
					<div>
						<p className="text-sm text-muted-foreground">Plan Value</p>
						<p className="figure-xl">
							{costSummary.planCostUsd != null
								? formatUsd(costSummary.planCostUsd)
								: "—"}
						</p>
						<div className="mt-2 space-y-tight text-xs">
							{planAvgRows.map((row) => (
								<div
									key={row.label}
									className="flex items-baseline justify-between"
								>
									<span className="text-muted-foreground" title={row.title}>
										{row.label}
									</span>
									<span className="font-medium tabular-nums">
										{row.value != null ? formatUsd(row.value) : "—"}
									</span>
								</div>
							))}
						</div>
					</div>
					<div>
						<p className="text-sm text-muted-foreground">Cost</p>
						<p
							className="figure-xl"
							title="Ledger payments (subscriptions + credits) plus token-billed cost in the selected range"
						>
							{paymentsSummary
								? formatUsd(paymentsSummary.range.totalUsd)
								: "—"}
						</p>
						<div className="mt-2 space-y-tight text-xs">
							{costAmortizedRows.map((row) => (
								<div
									key={row.label}
									className="flex items-baseline justify-between"
								>
									<span className="text-muted-foreground" title={row.title}>
										{row.label}
									</span>
									<span className="font-medium tabular-nums">
										{row.value != null ? formatUsd(row.value) : "—"}
									</span>
								</div>
							))}
						</div>
					</div>
					<div>
						<p className="text-sm text-muted-foreground">Value Ratio</p>
						<p className="figure-xl">
							{formatValueRatio(paymentsSummary?.range.valueRatio)}
						</p>
						<p className="mt-2 text-xs text-muted-foreground">
							plan value ÷ amortized spend
						</p>
					</div>
				</div>
				{unavailable ? (
					<div className="flex h-48 items-center justify-center gap-item text-xs text-warning-strong">
						<AlertCircle className="h-3.5 w-3.5 shrink-0" />
						Account performance data unavailable
					</div>
				) : (
					<BaseBarChart
						data={accountPerformance as unknown as ChartDataPoint[]}
						bars={[
							{ dataKey: "requests", yAxisId: "left", name: "Requests" },
							{
								dataKey: "successRate",
								yAxisId: "right",
								fill: CHART_TOKENS.success,
								name: "Success %",
							},
						]}
						xAxisKey="name"
						loading={loading}
						height="small"
						secondaryYAxis={true}
						showLegend={true}
					/>
				)}
				{!analyticsResolved && !unavailable && (
					<div className="mt-4 space-y-item">
						{[0, 1, 2].map((index) => (
							<Skeleton key={index} className="h-8 w-full" />
						))}
					</div>
				)}
				{analyticsResolved && (
					<div className="mt-4 border rounded-md overflow-hidden">
						<table
							aria-label="Account cost breakdown"
							className="w-full text-sm"
						>
							<thead className="bg-muted/50">
								<tr>
									<th scope="col" className="text-left px-3 py-2">
										Account
									</th>
									<th scope="col" className="text-right px-3 py-2">
										Plan Value
									</th>
									<th scope="col" className="text-right px-3 py-2">
										API Value
									</th>
									<th scope="col" className="text-right px-3 py-2">
										Total
									</th>
									<th scope="col" className="text-right px-3 py-2">
										Sub / mo
									</th>
								</tr>
							</thead>
							<tbody>
								{hasAnyAccountCostData(sortedAccountCostRows) ? (
									sortedAccountCostRows.map((row) => {
										const subMonthly = subMonthlyByName.get(row.name);
										return (
											<tr key={row.name} className="border-t">
												<td className="px-3 py-2 text-muted-foreground">
													{row.name}
												</td>
												<td className="px-3 py-2 text-right">
													{formatUsd(row.planCostUsd)}
												</td>
												<td className="px-3 py-2 text-right">
													{formatUsd(row.apiCostUsd)}
												</td>
												<td className="px-3 py-2 text-right font-medium">
													{formatUsd(row.totalCostUsd)}
												</td>
												<td className="px-3 py-2 text-right">
													{subMonthly != null ? formatUsd(subMonthly) : "—"}
												</td>
											</tr>
										);
									})
								) : (
									<tr className="border-t">
										<td className="px-3 py-3 text-muted-foreground" colSpan={5}>
											No cost data
										</td>
									</tr>
								)}
							</tbody>
							<tfoot className="bg-muted/30 border-t">
								<tr>
									<th scope="row" className="px-3 py-2 font-medium text-left">
										Total
									</th>
									<td className="px-3 py-2 text-right font-medium">
										{formatUsd(accountCostTotals.planCostUsd)}
									</td>
									<td className="px-3 py-2 text-right font-medium">
										{formatUsd(accountCostTotals.apiCostUsd)}
									</td>
									<td className="px-3 py-2 text-right font-medium">
										{formatUsd(accountCostTotals.totalCostUsd)}
									</td>
									<td className="px-3 py-2 text-right font-medium">
										{paymentsSummary
											? formatUsd(paymentsSummary.amortizedMonthlyUsd)
											: "—"}
									</td>
								</tr>
							</tfoot>
						</table>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
