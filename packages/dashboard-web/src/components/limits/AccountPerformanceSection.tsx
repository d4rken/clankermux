import { formatCost } from "@clankermux/ui-common";
import { useMemo } from "react";
import { COLORS } from "../../constants";
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

// Reuse the canonical cost-row shape and add the chart-only fields, so the
// cost columns can't drift from `AccountCostRow`.
export type AccountPerformanceRow = AccountCostRow & {
	requests: number;
	successRate: number;
};

/**
 * Range-scoped cost headlines shown atop the card (formerly the standalone Plan
 * Value / API Cost tiles). `planCostUsd`/`apiCostUsd` follow this card's range;
 * the two averages are server-computed over fixed 7-day / 30-day windows and do
 * NOT move with the selector.
 */
export interface AccountPerformanceCostSummary {
	planCostUsd: number;
	apiCostUsd: number;
	avgDailyPlanCostUsd: number;
	avgWeeklyPlanCostUsd: number;
}

interface AccountPerformanceSectionProps {
	accountPerformance: AccountPerformanceRow[];
	loading: boolean;
	/** Selected time range (controlled); re-keys the parent's analytics query. */
	range: string;
	onRangeChange: (range: string) => void;
	costSummary: AccountPerformanceCostSummary;
}

/**
 * Account Performance card: a range-controlled bar chart, the per-account
 * cost-breakdown table, and the folded-in Plan Value / API Cost summary band.
 * Presentational — range state and the cost totals are supplied by the parent.
 */
export function AccountPerformanceSection({
	accountPerformance,
	loading,
	range,
	onRangeChange,
	costSummary,
}: AccountPerformanceSectionProps) {
	const sortedAccountCostRows = useMemo(
		() => getSortedAccountCostRows(accountPerformance),
		[accountPerformance],
	);
	const accountCostTotals = useMemo(
		() => getAccountCostTotals(sortedAccountCostRows),
		[sortedAccountCostRows],
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

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between gap-4">
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
				{/* Range-scoped Plan Value / API Cost headlines (formerly standalone
				    tiles). The two averages below Plan Value are fixed 7d/30d windows
				    and stay put when the range above changes. */}
				<div className="mb-4 grid grid-cols-2 gap-4 border-b pb-4">
					<div>
						<p className="text-sm text-muted-foreground">Plan Value</p>
						<p className="text-2xl font-bold">
							{formatCost(costSummary.planCostUsd)}
						</p>
						<div className="mt-2 space-y-1 text-xs">
							{planAvgRows.map((row) => (
								<div
									key={row.label}
									className="flex items-baseline justify-between"
								>
									<span className="text-muted-foreground" title={row.title}>
										{row.label}
									</span>
									<span className="font-medium tabular-nums">
										{formatCost(row.value)}
									</span>
								</div>
							))}
						</div>
					</div>
					<div>
						<p className="text-sm text-muted-foreground">API Cost</p>
						<p className="text-2xl font-bold">
							{formatCost(costSummary.apiCostUsd)}
						</p>
					</div>
				</div>
				<BaseBarChart
					data={accountPerformance as unknown as ChartDataPoint[]}
					bars={[
						{ dataKey: "requests", yAxisId: "left", name: "Requests" },
						{
							dataKey: "successRate",
							yAxisId: "right",
							fill: COLORS.success,
							name: "Success %",
						},
					]}
					xAxisKey="name"
					loading={loading}
					height="small"
					secondaryYAxis={true}
					showLegend={true}
				/>
				<div className="mt-4 border rounded-md overflow-hidden">
					<table aria-label="Account cost breakdown" className="w-full text-sm">
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
							</tr>
						</thead>
						<tbody>
							{hasAnyAccountCostData(sortedAccountCostRows) ? (
								sortedAccountCostRows.map((row) => (
									<tr key={row.name} className="border-t">
										<td className="px-3 py-2 text-muted-foreground">
											{row.name}
										</td>
										<td className="px-3 py-2 text-right">
											{formatCost(row.planCostUsd)}
										</td>
										<td className="px-3 py-2 text-right">
											{formatCost(row.apiCostUsd)}
										</td>
										<td className="px-3 py-2 text-right font-medium">
											{formatCost(row.totalCostUsd)}
										</td>
									</tr>
								))
							) : (
								<tr className="border-t">
									<td className="px-3 py-3 text-muted-foreground" colSpan={4}>
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
									{formatCost(accountCostTotals.planCostUsd)}
								</td>
								<td className="px-3 py-2 text-right font-medium">
									{formatCost(accountCostTotals.apiCostUsd)}
								</td>
								<td className="px-3 py-2 text-right font-medium">
									{formatCost(accountCostTotals.totalCostUsd)}
								</td>
							</tr>
						</tfoot>
					</table>
				</div>
			</CardContent>
		</Card>
	);
}
