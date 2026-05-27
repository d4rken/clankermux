import type {
	RoutingAnalytics as RoutingAnalyticsData,
	RoutingFlowPoint,
} from "@clankermux/types";
import { formatNumber, formatPercentage } from "@clankermux/ui-common";
import { format } from "date-fns";
import { GitBranch, Route, Shuffle } from "lucide-react";
import { useMemo } from "react";
import {
	Area,
	AreaChart,
	CartesianGrid,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { CHART_COLORS, COLORS, type TimeRange } from "../../constants";
import { ChartTooltip } from "../charts";
import { Badge } from "../ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";

const OUTCOME_COLORS: Record<RoutingFlowPoint["outcome"], string> = {
	success: COLORS.success,
	rate_limited: COLORS.warning,
	error: COLORS.error,
};

const DECISION_LABELS: Record<string, string> = {
	affinity_hit: "Affinity hit",
	affinity_hold: "Affinity hold",
	affinity_miss: "Affinity miss",
	affinity_reassigned: "Affinity reassigned",
	auto_fallback: "Auto fallback",
	combo: "Combo",
	forced_account: "Forced account",
	global_session: "Global session",
	least_used: "Least used",
	priority_utilization: "Priority + usage",
	untracked: "Untracked",
};

const DECISION_EXPLANATIONS: Record<string, string> = {
	affinity_hit: "A project or thread was already pinned to this account.",
	affinity_hold: "Affinity was held while the original account recovered.",
	affinity_miss: "No existing affinity was found, so a new account was pinned.",
	affinity_reassigned:
		"Affinity moved because priority changed or the prior account was durably unavailable.",
	auto_fallback:
		"A higher-priority fallback account became usable after its window reset.",
	combo: "An active model-family combo selected the account slot.",
	forced_account: "A request header explicitly selected this account.",
	global_session: "The current provider session was continued.",
	least_used: "The lowest effective utilization account was selected.",
	priority_utilization:
		"Accounts were sorted by priority, then upstream utilization.",
	untracked: "This request was logged before routing telemetry was recorded.",
};

function labelDecision(decision: string): string {
	return DECISION_LABELS[decision] ?? decision.replaceAll("_", " ");
}

function shortLabel(value: string, max = 24): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max - 1)}...`;
}

function percent(value: number): string {
	return formatPercentage(value, 0);
}

function EmptyRoutingState({ loading }: { loading: boolean }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Account Routing</CardTitle>
				<CardDescription>
					Selection reasons and account usage from routing telemetry
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="flex min-h-40 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
					{loading
						? "Loading routing analytics..."
						: "No routing telemetry in this range"}
				</div>
			</CardContent>
		</Card>
	);
}

function RoutingFlowGraph({ flow }: { flow: RoutingFlowPoint[] }) {
	const graph = useMemo(() => {
		const topDecisionTotals = new Map<string, number>();
		const topAccountTotals = new Map<string, number>();
		const outcomeTotals = new Map<string, number>();

		for (const row of flow) {
			topDecisionTotals.set(
				row.decision,
				(topDecisionTotals.get(row.decision) ?? 0) + row.requests,
			);
			topAccountTotals.set(
				row.accountName,
				(topAccountTotals.get(row.accountName) ?? 0) + row.requests,
			);
			outcomeTotals.set(
				row.outcome,
				(outcomeTotals.get(row.outcome) ?? 0) + row.requests,
			);
		}

		const decisions = Array.from(topDecisionTotals.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 8);
		const accounts = Array.from(topAccountTotals.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 8);
		const outcomes = Array.from(outcomeTotals.entries()).sort(
			(a, b) => b[1] - a[1],
		);

		const decisionSet = new Set(decisions.map(([name]) => name));
		const accountSet = new Set(accounts.map(([name]) => name));
		const visibleFlows = flow.filter(
			(row) => decisionSet.has(row.decision) && accountSet.has(row.accountName),
		);
		const maxRequests = Math.max(1, ...visibleFlows.map((row) => row.requests));
		const height = Math.max(
			280,
			Math.max(decisions.length, accounts.length, outcomes.length) * 52 + 48,
		);

		return {
			decisions,
			accounts,
			outcomes,
			visibleFlows,
			maxRequests,
			height,
		};
	}, [flow]);

	const nodeY = (index: number, count: number) => {
		if (count <= 1) return graph.height / 2;
		const top = 40;
		const bottom = graph.height - 40;
		return top + (index * (bottom - top)) / (count - 1);
	};

	const decisionY = new Map(
		graph.decisions.map(([name], index) => [
			name,
			nodeY(index, graph.decisions.length),
		]),
	);
	const accountY = new Map(
		graph.accounts.map(([name], index) => [
			name,
			nodeY(index, graph.accounts.length),
		]),
	);
	const outcomeY = new Map(
		graph.outcomes.map(([name], index) => [
			name,
			nodeY(index, graph.outcomes.length),
		]),
	);

	const leftX = 44;
	const midX = 412;
	const rightX = 760;
	const nodeWidth = 190;

	return (
		<div className="overflow-x-auto">
			<svg
				viewBox={`0 0 980 ${graph.height}`}
				className="h-auto min-w-[760px] w-full"
				role="img"
				aria-label="Routing decision flow graph"
			>
				<title>Routing decision flow</title>
				{graph.visibleFlows.map((row) => {
					const y1 = decisionY.get(row.decision) ?? graph.height / 2;
					const y2 = accountY.get(row.accountName) ?? graph.height / 2;
					const y3 = outcomeY.get(row.outcome) ?? graph.height / 2;
					const strokeWidth =
						2 + Math.sqrt(row.requests / graph.maxRequests) * 14;
					const color = OUTCOME_COLORS[row.outcome] ?? COLORS.primary;
					const key = `${row.strategy}-${row.decision}-${row.accountId}-${row.outcome}`;

					return (
						<g key={key}>
							<title>
								{`${labelDecision(row.decision)} -> ${row.accountName} -> ${row.outcome}: ${row.requests} requests`}
							</title>
							<path
								d={`M ${leftX + nodeWidth} ${y1} C 300 ${y1}, 300 ${y2}, ${midX} ${y2}`}
								fill="none"
								stroke={color}
								strokeLinecap="round"
								strokeOpacity="0.32"
								strokeWidth={strokeWidth}
							/>
							<path
								d={`M ${midX + nodeWidth} ${y2} C 660 ${y2}, 660 ${y3}, ${rightX} ${y3}`}
								fill="none"
								stroke={color}
								strokeLinecap="round"
								strokeOpacity="0.26"
								strokeWidth={strokeWidth}
							/>
						</g>
					);
				})}

				{graph.decisions.map(([name, requests], index) => {
					const y = nodeY(index, graph.decisions.length);
					return (
						<g key={name} transform={`translate(${leftX} ${y - 19})`}>
							<title>
								{DECISION_EXPLANATIONS[name] ?? labelDecision(name)}
							</title>
							<rect
								width={nodeWidth}
								height="38"
								rx="6"
								fill="var(--card)"
								stroke="var(--border)"
							/>
							<text
								x="12"
								y="17"
								fill="var(--foreground)"
								fontSize="12"
								fontWeight="600"
							>
								{shortLabel(labelDecision(name), 22)}
							</text>
							<text
								x="12"
								y="31"
								fill="var(--muted-foreground)"
								fontSize="11"
							>
								{formatNumber(requests)} req
							</text>
						</g>
					);
				})}

				{graph.accounts.map(([name, requests], index) => {
					const y = nodeY(index, graph.accounts.length);
					return (
						<g key={name} transform={`translate(${midX} ${y - 19})`}>
							<rect
								width={nodeWidth}
								height="38"
								rx="6"
								fill="var(--card)"
								stroke="var(--border)"
							/>
							<text
								x="12"
								y="17"
								fill="var(--foreground)"
								fontSize="12"
								fontWeight="600"
							>
								{shortLabel(name, 22)}
							</text>
							<text
								x="12"
								y="31"
								fill="var(--muted-foreground)"
								fontSize="11"
							>
								{formatNumber(requests)} req
							</text>
						</g>
					);
				})}

				{graph.outcomes.map(([name, requests], index) => {
					const y = nodeY(index, graph.outcomes.length);
					const outcome = name as RoutingFlowPoint["outcome"];
					return (
						<g key={name} transform={`translate(${rightX} ${y - 19})`}>
							<rect
								width="160"
								height="38"
								rx="6"
								fill="var(--card)"
								stroke={OUTCOME_COLORS[outcome] ?? "var(--border)"}
							/>
							<text
								x="12"
								y="17"
								fill="var(--foreground)"
								fontSize="12"
								fontWeight="600"
							>
								{name.replaceAll("_", " ")}
							</text>
							<text
								x="12"
								y="31"
								fill="var(--muted-foreground)"
								fontSize="11"
							>
								{formatNumber(requests)} req
							</text>
						</g>
					);
				})}
			</svg>
		</div>
	);
}

interface RoutingAnalyticsPanelProps {
	routing?: RoutingAnalyticsData;
	loading: boolean;
	timeRange: TimeRange;
}

export function RoutingAnalyticsPanel({
	routing,
	loading,
	timeRange,
}: RoutingAnalyticsPanelProps) {
	const timeline = useMemo(() => {
		if (!routing?.timeline.length)
			return { data: [], accounts: [] as string[] };

		const topAccounts = routing.accountSplit
			.slice(0, 6)
			.map((account) => account.accountName);
		const topAccountSet = new Set(topAccounts);
		const rows = new Map<number, Record<string, string | number>>();

		for (const point of routing.timeline) {
			const accountName = topAccountSet.has(point.accountName)
				? point.accountName
				: "Other";
			const row =
				rows.get(point.ts) ??
				({
					ts: point.ts,
					time:
						timeRange === "30d"
							? format(new Date(point.ts), "MMM d")
							: format(new Date(point.ts), "HH:mm"),
				} as Record<string, string | number>);
			row[accountName] = Number(row[accountName] ?? 0) + point.requests;
			rows.set(point.ts, row);
		}

		const accounts = [...topAccounts];
		if (
			routing.timeline.some((point) => !topAccountSet.has(point.accountName))
		) {
			accounts.push("Other");
		}

		return {
			data: Array.from(rows.values()).sort(
				(a, b) => Number(a.ts) - Number(b.ts),
			),
			accounts,
		};
	}, [routing, timeRange]);

	if (!routing || routing.totalRequests === 0) {
		return <EmptyRoutingState loading={loading} />;
	}

	const topDecision = routing.decisionBreakdown[0];

	return (
		<div className="space-y-6">
			<Card>
				<CardHeader>
					<div className="flex flex-wrap items-start justify-between gap-3">
						<div>
							<CardTitle className="flex items-center gap-2">
								<Route className="h-5 w-5" />
								Routing Flow
							</CardTitle>
							<CardDescription>
								Selection reason to account to outcome
							</CardDescription>
						</div>
						<div className="flex flex-wrap items-center gap-2">
							<Badge variant="secondary">
								{formatNumber(routing.totalRequests)} routed requests
							</Badge>
							{topDecision && (
								<Badge variant="outline">
									Top reason: {labelDecision(topDecision.decision)}
								</Badge>
							)}
						</div>
					</div>
				</CardHeader>
				<CardContent>
					<RoutingFlowGraph flow={routing.flow} />
				</CardContent>
			</Card>

			<div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)] gap-6">
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<GitBranch className="h-5 w-5" />
							Account Routing Timeline
						</CardTitle>
						<CardDescription>
							Request volume by selected account over time
						</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="h-80">
							<ResponsiveContainer width="100%" height="100%">
								<AreaChart
									data={timeline.data}
									margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
								>
									<CartesianGrid
										strokeDasharray="3 3"
										className="stroke-muted"
									/>
									<XAxis dataKey="time" fontSize={12} tickLine={false} />
									<YAxis fontSize={12} tickLine={false} allowDecimals={false} />
									<Tooltip
										content={
											<ChartTooltip
												formatters={{
													default: (value) => formatNumber(Number(value)),
												}}
											/>
										}
									/>
									{timeline.accounts.map((account, index) => (
										<Area
											key={account}
											type="monotone"
											dataKey={account}
											stackId="accounts"
											stroke={CHART_COLORS[index % CHART_COLORS.length]}
											fill={CHART_COLORS[index % CHART_COLORS.length]}
											fillOpacity={0.72}
										/>
									))}
								</AreaChart>
							</ResponsiveContainer>
						</div>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<Shuffle className="h-5 w-5" />
							Selection Reasons
						</CardTitle>
						<CardDescription>Why accounts were selected</CardDescription>
					</CardHeader>
					<CardContent className="space-y-5">
						<div className="space-y-3">
							{routing.decisionBreakdown.slice(0, 7).map((row, index) => (
								<div
									key={`${row.strategy}-${row.decision}`}
									className="space-y-1.5"
								>
									<div className="flex items-center justify-between gap-3 text-sm">
										<div className="min-w-0">
											<div className="truncate font-medium">
												{labelDecision(row.decision)}
											</div>
											<div className="truncate text-xs text-muted-foreground">
												{DECISION_EXPLANATIONS[row.decision] ?? row.strategy}
											</div>
										</div>
										<div className="shrink-0 text-right">
											<div className="font-medium">
												{percent(row.percentage)}
											</div>
											<div className="text-xs text-muted-foreground">
												{formatNumber(row.requests)}
											</div>
										</div>
									</div>
									<div className="h-2 rounded-full bg-muted">
										<div
											className="h-2 rounded-full"
											style={{
												width: `${Math.max(2, row.percentage)}%`,
												backgroundColor:
													CHART_COLORS[index % CHART_COLORS.length],
											}}
										/>
									</div>
								</div>
							))}
						</div>

						<div className="space-y-3 border-t pt-4">
							<div className="text-sm font-medium">Account Split</div>
							{routing.accountSplit.slice(0, 5).map((account, index) => (
								<div key={account.accountId} className="space-y-1.5">
									<div className="flex items-center justify-between gap-3 text-sm">
										<div className="min-w-0">
											<div className="truncate font-medium">
												{account.accountName}
											</div>
											<div className="text-xs text-muted-foreground">
												{account.topDecision
													? labelDecision(account.topDecision)
													: "No dominant reason"}
											</div>
										</div>
										<div className="shrink-0 text-right">
											<div className="font-medium">
												{percent(account.percentage)}
											</div>
											<div className="text-xs text-muted-foreground">
												{formatNumber(account.requests)}
											</div>
										</div>
									</div>
									<div className="h-2 rounded-full bg-muted">
										<div
											className="h-2 rounded-full"
											style={{
												width: `${Math.max(2, account.percentage)}%`,
												backgroundColor:
													CHART_COLORS[(index + 3) % CHART_COLORS.length],
											}}
										/>
									</div>
								</div>
							))}
						</div>
					</CardContent>
				</Card>
			</div>
		</div>
	);
}
