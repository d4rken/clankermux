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

interface AccountPerformanceSectionProps {
	accountPerformance: AccountPerformanceRow[];
	loading: boolean;
}

/**
 * Account Performance bar chart + cost-breakdown table. Extracted verbatim from
 * the former Overview ChartsSection "Account Performance" block so it can live on
 * the Limits tab. Self-contained: derives the sorted cost rows and totals from
 * its own props.
 */
export function AccountPerformanceSection({
	accountPerformance,
	loading,
}: AccountPerformanceSectionProps) {
	const sortedAccountCostRows = useMemo(
		() => getSortedAccountCostRows(accountPerformance),
		[accountPerformance],
	);
	const accountCostTotals = useMemo(
		() => getAccountCostTotals(sortedAccountCostRows),
		[sortedAccountCostRows],
	);

	return (
		<Card>
			<CardHeader>
				<CardTitle>Account Performance</CardTitle>
				<CardDescription>
					Request distribution and success rates by account
				</CardDescription>
			</CardHeader>
			<CardContent>
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
