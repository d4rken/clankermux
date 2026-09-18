import type { ClientEfficiencyRow } from "@clankermux/types";
import { formatTokens, formatUsd } from "@clankermux/ui-common";
import { ArrowDown, ArrowUp, Gauge, Minus } from "lucide-react";
import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { PanelEmptyState } from "../ui/panel-empty-state";
import {
	cacheHitRate,
	costPerRequest,
	hasInferredRows,
	rollUpClientEfficiency,
	tokensPerRequest,
} from "./client-efficiency-rollup";

interface ClientEfficiencySummaryProps {
	rows: readonly ClientEfficiencyRow[];
	truncated?: boolean;
	loading?: boolean;
}

function label(harness: string): string {
	return harness === "claude-code" ? "Claude Code" : harness;
}

function ComparisonIcon({ delta }: { delta: number | null }) {
	if (delta === null || Math.abs(delta) < 0.005) {
		return <Minus className="h-4 w-4" />;
	}
	return delta < 0 ? (
		<ArrowDown className="h-4 w-4 text-success-strong" />
	) : (
		<ArrowUp className="h-4 w-4 text-warning-strong" />
	);
}

/**
 * Decision summary for the two agent harnesses. The denominator is requests,
 * and the card says so explicitly: gateway traffic can measure consumption,
 * but it cannot prove that two requests solved the same task.
 */
export function ClientEfficiencySummary({
	rows,
	truncated = false,
	loading = false,
}: ClientEfficiencySummaryProps) {
	const groups = useMemo(() => rollUpClientEfficiency(rows, "harness"), [rows]);
	const displayGroups = useMemo(
		() =>
			[...groups]
				.sort((a, b) => {
					const priority = (label: string) =>
						label === "claude-code" ? 0 : label === "pi" ? 1 : 2;
					return (
						priority(a.label) - priority(b.label) || b.requests - a.requests
					);
				})
				.slice(0, 4),
		[groups],
	);
	const comparison = useMemo(() => {
		const claude = groups.find((group) => group.label === "claude-code");
		const pi = groups.find((group) => group.label === "pi");
		if (!claude || !pi) return null;
		const claudeTokens = tokensPerRequest(claude);
		const piTokens = tokensPerRequest(pi);
		if (claudeTokens === null || piTokens === null || claudeTokens <= 0)
			return null;
		return {
			claude,
			pi,
			claudeTokens,
			piTokens,
			delta: (piTokens - claudeTokens) / claudeTokens,
		};
	}, [groups]);
	const hasInferred = displayGroups.some(hasInferredRows);

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-item">
					<Gauge className="h-5 w-5" />
					Token efficiency
				</CardTitle>
				<p className="max-w-prose text-sm text-muted-foreground">
					Tokens consumed per attempted gateway request. Lower means less
					context and generation; compare cost per request for price.
				</p>
			</CardHeader>
			<CardContent className="space-y-group">
				{loading ? (
					<PanelEmptyState>Loading client efficiency…</PanelEmptyState>
				) : groups.length === 0 ? (
					<PanelEmptyState>No client activity in this range</PanelEmptyState>
				) : (
					<>
						{truncated && (
							<p className="text-xs text-warning-strong">
								The server limited this comparison to the busiest client rows in
								the selected range.
							</p>
						)}
						{hasInferred && (
							<p className="text-xs text-muted-foreground">
								Some harness labels are inferred from session or client
								configuration.
							</p>
						)}
						<div className="grid gap-group sm:grid-cols-2 lg:grid-cols-4">
							{displayGroups.map((group) => {
								const perRequest = tokensPerRequest(group);
								const hitRate = cacheHitRate(group);
								return (
									<div
										key={group.key}
										className="rounded-md border bg-muted/20 p-group"
									>
										<div className="text-sm font-medium">
											{label(group.label)}
										</div>
										<div className="figure-xl mt-tight">
											{perRequest === null
												? "—"
												: formatTokens(Math.round(perRequest))}
										</div>
										<div className="mt-tight text-xs text-muted-foreground">
											avg tokens / request
										</div>
										<div className="mt-group grid grid-cols-2 gap-x-group gap-y-tight text-xs">
											<div>
												<span className="text-muted-foreground">Requests</span>
												<div className="figure">
													{group.requests.toLocaleString()}
												</div>
											</div>
											<div>
												<span className="text-muted-foreground">Cache hit</span>
												<div className="figure">
													{hitRate === null ? "—" : `${hitRate.toFixed(1)}%`}
												</div>
											</div>
											<div>
												<span className="text-muted-foreground">
													Output / req
												</span>
												<div className="figure">
													{group.requests > 0
														? formatTokens(
																Math.round(group.outputTokens / group.requests),
															)
														: "—"}
												</div>
											</div>
											<div>
												<span className="text-muted-foreground">
													Cost / req
												</span>
												<div className="figure">
													{costPerRequest(group) === null
														? "—"
														: formatUsd(costPerRequest(group) ?? 0)}
												</div>
											</div>
										</div>
									</div>
								);
							})}
						</div>
						{comparison && (
							<div className="flex items-center gap-item rounded-md border border-dashed px-group py-item text-sm">
								<ComparisonIcon delta={comparison.delta} />
								<span>
									{label(comparison.pi.label)} uses{" "}
									{Math.abs(comparison.delta * 100).toFixed(1)}%{" "}
									{comparison.delta < 0 ? "fewer" : "more"} tokens per request
									than {label(comparison.claude.label)} in this range.
								</span>
							</div>
						)}
					</>
				)}
			</CardContent>
		</Card>
	);
}
