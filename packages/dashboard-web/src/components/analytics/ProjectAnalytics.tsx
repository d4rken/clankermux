import type { AnalyticsResponse } from "@clankermux/types";
import {
	formatCost,
	formatNumber,
	formatPercentage,
	formatTokens,
} from "@clankermux/ui-common";
import { FolderOpen } from "lucide-react";
import { useMemo } from "react";
import { formatCompactNumber } from "../../lib/chart-utils";
import { BaseBarChart } from "../charts";
import type { ChartDataPoint } from "../charts/types";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";

type ProjectBreakdownRow = NonNullable<
	AnalyticsResponse["projectBreakdown"]
>[number];

// Display label only — the API keeps the NULL bucket as `project: null`, never
// as a sentinel string, so a project literally named "no-project" can't collide.
const NO_PROJECT_LABEL = "(no project)";

function projectLabel(project: string | null): string {
	return project ?? NO_PROJECT_LABEL;
}

// Stable identity for keys — distinct from any real project name, so a project
// literally named "(no project)" can't collide with the NULL bucket.
const NULL_PROJECT_KEY = "__null_project__";

function projectKey(project: string | null): string {
	return project ?? NULL_PROJECT_KEY;
}

interface ProjectAnalyticsProps {
	projectBreakdown: ProjectBreakdownRow[];
	loading?: boolean;
}

/**
 * Project Breakdown — per-project token volume (bar chart) plus a table with
 * requests, tokens, plan/api cost split, and success rate. Rows arrive from
 * the server already ordered by total tokens.
 */
export function ProjectAnalytics({
	projectBreakdown,
	loading = false,
}: ProjectAnalyticsProps) {
	const chartData = useMemo(
		() =>
			projectBreakdown.map((row) => ({
				name: projectLabel(row.project),
				tokens: row.totalTokens,
			})),
		[projectBreakdown],
	);

	if (projectBreakdown.length === 0) {
		return (
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<FolderOpen className="h-5 w-5" />
						Project Breakdown
					</CardTitle>
					<CardDescription>
						Requests, tokens, and cost by project
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="flex min-h-40 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
						{loading
							? "Loading project analytics..."
							: "No requests in this range"}
					</div>
				</CardContent>
			</Card>
		);
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<FolderOpen className="h-5 w-5" />
					Project Breakdown
				</CardTitle>
				<CardDescription>Requests, tokens, and cost by project</CardDescription>
			</CardHeader>
			<CardContent>
				<BaseBarChart
					data={chartData as unknown as ChartDataPoint[]}
					bars={{ dataKey: "tokens", radius: [0, 4, 4, 0], name: "Tokens" }}
					xAxisKey="name"
					loading={loading}
					height="medium"
					layout="vertical"
					yAxisWidth={140}
					xAxisTickFormatter={(value) => formatCompactNumber(Number(value))}
					tooltipFormatter={(value) => [formatTokens(Number(value)), "Tokens"]}
				/>
				<div className="mt-4 border rounded-md overflow-hidden">
					<table aria-label="Project breakdown" className="w-full text-sm">
						<thead className="bg-muted/50">
							<tr>
								<th scope="col" className="text-left px-3 py-2">
									Project
								</th>
								<th scope="col" className="text-right px-3 py-2">
									Requests
								</th>
								<th scope="col" className="text-right px-3 py-2">
									Tokens
								</th>
								<th scope="col" className="text-right px-3 py-2">
									Plan Value
								</th>
								<th scope="col" className="text-right px-3 py-2">
									API Cost
								</th>
								<th scope="col" className="text-right px-3 py-2">
									Success
								</th>
							</tr>
						</thead>
						<tbody>
							{projectBreakdown.map((row) => (
								<tr key={projectKey(row.project)} className="border-t">
									<td
										className={`px-3 py-2 ${
											row.project == null
												? "text-muted-foreground italic"
												: "text-muted-foreground"
										}`}
									>
										{projectLabel(row.project)}
									</td>
									<td className="px-3 py-2 text-right">
										{formatNumber(row.requests)}
									</td>
									<td className="px-3 py-2 text-right">
										{formatTokens(row.totalTokens)}
									</td>
									<td className="px-3 py-2 text-right">
										{formatCost(row.planCostUsd)}
									</td>
									<td className="px-3 py-2 text-right">
										{formatCost(row.apiCostUsd)}
									</td>
									<td className="px-3 py-2 text-right">
										{formatPercentage(row.successRate, 0)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</CardContent>
		</Card>
	);
}
