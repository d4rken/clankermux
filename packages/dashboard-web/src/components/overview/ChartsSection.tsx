import { formatTokens } from "@clankermux/ui-common";
import { useMemo } from "react";
import { CHART_COLORS } from "../../constants";
import { formatCompactNumber } from "../../lib/chart-utils";
import {
	type ProjectTokensRow,
	toProjectDonutData,
} from "../../lib/project-donut";
import { BasePieChart, RequestVolumeSuccessChart } from "../charts";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";

interface ChartsSectionProps {
	timeSeriesData: Array<{
		ts: number;
		requests: number;
		successRate: number;
		responseTime: number;
		cost: string;
		planCost: number;
		apiCost: number;
	}>;
	/** Selected dashboard range — forwarded to the time-series chart for labelling. */
	timeRange: string;
	modelData: Array<{ name: string; value: number }>;
	accountModelUsageData: Array<{
		account: string;
		model: string;
		count: number;
	}>;
	projectBreakdownData: ProjectTokensRow[];
	loading: boolean;
}

export function ChartsSection({
	timeSeriesData,
	timeRange,
	modelData,
	accountModelUsageData,
	projectBreakdownData,
	loading,
}: ChartsSectionProps) {
	// Aggregate account-model usage into per-account totals for the donut chart
	const accountUsageDonutData = useMemo(() => {
		const totals = new Map<string, number>();
		for (const row of accountModelUsageData) {
			totals.set(row.account, (totals.get(row.account) ?? 0) + row.count);
		}
		return Array.from(totals.entries())
			.map(([name, value]) => ({ name, value }))
			.sort((a, b) => b.value - a.value);
	}, [accountModelUsageData]);

	// Build per-account model breakdown for tooltip
	const accountModelBreakdown = useMemo(() => {
		const breakdown = new Map<
			string,
			Array<{ model: string; count: number }>
		>();
		for (const row of accountModelUsageData) {
			if (!breakdown.has(row.account)) breakdown.set(row.account, []);
			breakdown.get(row.account)?.push({ model: row.model, count: row.count });
		}
		return breakdown;
	}, [accountModelUsageData]);

	// Prepare project donut data (total tokens per project)
	const projectDonutData = useMemo(
		() => toProjectDonutData(projectBreakdownData),
		[projectBreakdownData],
	);

	return (
		<>
			{/* Charts Row 1 — request volume + success rate, combined full width */}
			<Card>
				<CardHeader>
					<CardTitle>Request Volume &amp; Success Rate</CardTitle>
					<CardDescription>
						Requests per bucket (left axis) and success percentage (right axis)
						over time
					</CardDescription>
				</CardHeader>
				<CardContent>
					<RequestVolumeSuccessChart
						data={timeSeriesData}
						timeRange={timeRange}
						loading={loading}
						height="medium"
					/>
				</CardContent>
			</Card>

			{/* Charts Row 2 — three donut charts */}
			<div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
				{/* Model Distribution */}
				<Card>
					<CardHeader className="p-4">
						<CardTitle>Model Usage</CardTitle>
						<CardDescription>
							Distribution of API calls by model
						</CardDescription>
					</CardHeader>
					<CardContent className="p-4 pt-0">
						<BasePieChart
							data={modelData}
							loading={loading}
							height="compact"
							innerRadius={48}
							outerRadius={72}
							paddingAngle={5}
							tooltipStyle="success"
						/>
						<div className="mt-3 space-y-2">
							{modelData.map((model, index) => (
								<div
									key={model.name}
									className="flex items-center justify-between text-sm"
								>
									<div className="flex items-center gap-2">
										<div
											className="h-3 w-3 rounded-full"
											style={{
												backgroundColor:
													CHART_COLORS[index % CHART_COLORS.length],
											}}
										/>
										<span className="text-muted-foreground">{model.name}</span>
									</div>
									<span className="font-medium">{model.value}</span>
								</div>
							))}
						</div>
					</CardContent>
				</Card>

				{/* Usage by Account */}
				<Card>
					<CardHeader className="p-4">
						<CardTitle>Usage by Account</CardTitle>
						<CardDescription>
							Request distribution across accounts
						</CardDescription>
					</CardHeader>
					<CardContent className="p-4 pt-0">
						<BasePieChart
							data={accountUsageDonutData}
							loading={loading}
							height="compact"
							innerRadius={48}
							outerRadius={72}
							paddingAngle={5}
							tooltipStyle="success"
						/>
						<div className="mt-3 space-y-2">
							{accountUsageDonutData.map((account, index) => {
								const models = accountModelBreakdown.get(account.name) ?? [];
								return (
									<div key={account.name} className="space-y-1">
										<div className="flex items-center justify-between text-sm">
											<div className="flex items-center gap-2">
												<div
													className="h-3 w-3 rounded-full"
													style={{
														backgroundColor:
															CHART_COLORS[index % CHART_COLORS.length],
													}}
												/>
												<span className="text-muted-foreground font-medium">
													{account.name}
												</span>
											</div>
											<span className="font-medium">{account.value}</span>
										</div>
										{models.length > 1 && (
											<div className="pl-5 space-y-0.5">
												{models.map((m) => (
													<div
														key={m.model}
														className="flex items-center justify-between text-xs text-muted-foreground"
													>
														<span>{m.model}</span>
														<span>{m.count}</span>
													</div>
												))}
											</div>
										)}
									</div>
								);
							})}
						</div>
					</CardContent>
				</Card>

				{/* Usage by Project */}
				<Card>
					<CardHeader className="p-4">
						<CardTitle>Usage by Project</CardTitle>
						<CardDescription>
							Token usage distribution across projects
						</CardDescription>
					</CardHeader>
					<CardContent className="p-4 pt-0">
						<BasePieChart
							data={projectDonutData}
							loading={loading}
							height="compact"
							innerRadius={48}
							outerRadius={72}
							paddingAngle={5}
							tooltipStyle="success"
							tooltipFormatter={(value) => [
								formatTokens(Number(value)),
								"Tokens",
							]}
						/>
						<div className="mt-3 space-y-2">
							{projectDonutData.map((project, index) => (
								<div
									key={project.name}
									className="flex items-center justify-between text-sm"
								>
									<div className="flex items-center gap-2 min-w-0">
										<div
											className="h-3 w-3 shrink-0 rounded-full"
											style={{
												backgroundColor:
													CHART_COLORS[index % CHART_COLORS.length],
											}}
										/>
										<span className="text-muted-foreground truncate">
											{project.name}
										</span>
									</div>
									<span className="font-medium">
										{formatCompactNumber(project.value)}
									</span>
								</div>
							))}
						</div>
					</CardContent>
				</Card>
			</div>
		</>
	);
}
