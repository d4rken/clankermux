import type { RoutingAnalytics } from "@clankermux/types";
import { formatNumber, formatPercentage } from "@clankermux/ui-common";
import { Route } from "lucide-react";
import { CHART_COLORS } from "../../constants";
import { Badge } from "../ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";

const DECISION_LABELS: Record<string, string> = {
	affinity_hit: "Affinity hit",
	affinity_hold: "Affinity hold",
	affinity_miss: "Affinity miss",
	affinity_reassigned: "Affinity reassigned",
	auto_fallback: "Auto fallback",
	combo: "Routing Chain",
	force_account_global: "Forced (global)",
	forced_account: "Forced account",
	global_session: "Global session",
	least_used: "Least used",
	priority_utilization: "Priority + usage",
	untracked: "Untracked",
};

function labelDecision(decision: string): string {
	return DECISION_LABELS[decision] ?? decision.replaceAll("_", " ");
}

interface RoutingSummaryCardProps {
	routing?: RoutingAnalytics;
}

export function RoutingSummaryCard({ routing }: RoutingSummaryCardProps) {
	const total = routing?.totalRequests ?? 0;

	return (
		<Card>
			<CardHeader>
				<div className="flex items-start justify-between gap-3">
					<div>
						<CardTitle className="flex items-center gap-2">
							<Route className="h-5 w-5" />
							Account Routing
						</CardTitle>
						<CardDescription>
							Selected accounts and routing reasons in this range
						</CardDescription>
					</div>
					<Badge variant="secondary">{formatNumber(total)} routed</Badge>
				</div>
			</CardHeader>
			<CardContent>
				{!routing || total === 0 ? (
					<div className="flex min-h-32 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
						No routing telemetry in this range
					</div>
				) : (
					<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
						<div className="space-y-3">
							<div className="text-sm font-medium">Routing Split</div>
							{routing.accountSplit.slice(0, 5).map((account, index) => (
								<div key={account.accountId} className="space-y-1.5">
									<div className="flex items-center justify-between gap-3 text-sm">
										<div className="min-w-0">
											<div className="truncate font-medium">
												{account.accountName}
											</div>
											<div className="text-xs text-muted-foreground">
												{account.topDecision
													? `mostly ${labelDecision(account.topDecision)}`
													: "mixed routing"}
											</div>
										</div>
										<div className="shrink-0 text-right">
											<div className="font-medium">
												{formatPercentage(account.percentage, 0)}
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
													CHART_COLORS[index % CHART_COLORS.length],
											}}
										/>
									</div>
								</div>
							))}
						</div>

						<div className="space-y-3">
							<div className="text-sm font-medium">Top Selection Reasons</div>
							{routing.decisionBreakdown.slice(0, 5).map((reason, index) => (
								<div
									key={`${reason.strategy}-${reason.decision}`}
									className="space-y-1.5"
								>
									<div className="flex items-center justify-between gap-3 text-sm">
										<div className="min-w-0 truncate font-medium">
											{labelDecision(reason.decision)}
										</div>
										<div className="shrink-0 text-right">
											<div className="font-medium">
												{formatPercentage(reason.percentage, 0)}
											</div>
											<div className="text-xs text-muted-foreground">
												{formatNumber(reason.requests)}
											</div>
										</div>
									</div>
									<div className="h-2 rounded-full bg-muted">
										<div
											className="h-2 rounded-full"
											style={{
												width: `${Math.max(2, reason.percentage)}%`,
												backgroundColor:
													CHART_COLORS[(index + 2) % CHART_COLORS.length],
											}}
										/>
									</div>
								</div>
							))}
						</div>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
