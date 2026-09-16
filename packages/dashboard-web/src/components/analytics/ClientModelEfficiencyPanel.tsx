import { getModelShortName } from "@clankermux/core";
import type { ClientModelEfficiencyRow } from "@clankermux/types";
import { formatNumber, formatTokens, formatUsd } from "@clankermux/ui-common";
import { Scale } from "lucide-react";
import { useMemo } from "react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { PanelEmptyState } from "../ui/panel-empty-state";
import {
	Table,
	TableBody,
	TableCell,
	TableFrame,
	TableHead,
	TableHeader,
	TableRow,
} from "../ui/table";
import { cacheHitRate, costPerRequest } from "./client-efficiency-rollup";

interface ClientModelEfficiencyPanelProps {
	rows: readonly ClientModelEfficiencyRow[];
	/** The server's request floor, restated in the caption. */
	minRequests: number;
	loading?: boolean;
}

/**
 * Per-client efficiency WITHIN one model.
 *
 * The comparison the headline table cannot make: two clients with different
 * model mixes differ in cost per request for reasons that have nothing to do
 * with how they use the cache. Holding the model fixed removes that.
 */
export function ClientModelEfficiencyPanel({
	rows,
	minRequests,
	loading = false,
}: ClientModelEfficiencyPanelProps) {
	const byModel = useMemo(() => {
		const groups = new Map<string, ClientModelEfficiencyRow[]>();
		for (const row of rows) {
			const existing = groups.get(row.model);
			if (existing) existing.push(row);
			else groups.set(row.model, [row]);
		}
		// Models with a single client have nothing to compare; they stay, because
		// their numbers are still the only per-model read this tab offers.
		return [...groups.entries()].map(([model, modelRows]) => ({
			model,
			rows: [...modelRows].sort((a, b) => b.requests - a.requests),
		}));
	}, [rows]);

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-item">
					<Scale className="h-5 w-5" />
					Same model, different clients
				</CardTitle>
				<CardDescription>
					Cache and cost per client on one model, so a difference in model mix
					cannot explain the gap. Pairs with fewer than {minRequests} requests
					in range are left out.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-group">
				{loading ? (
					<PanelEmptyState>Loading per-model comparison…</PanelEmptyState>
				) : byModel.length === 0 ? (
					<PanelEmptyState>
						No client reached {minRequests} requests on a single model in this
						range
					</PanelEmptyState>
				) : (
					byModel.map((group) => (
						<div key={group.model} className="space-y-item">
							<h4 className="text-sm font-medium">
								{getModelShortName(group.model)}
							</h4>
							<TableFrame>
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Client</TableHead>
											<TableHead className="text-right">Requests</TableHead>
											<TableHead className="text-right">Cache hit</TableHead>
											<TableHead className="text-right">Tokens in</TableHead>
											<TableHead className="text-right">Tokens out</TableHead>
											<TableHead className="text-right">Cost / req</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{group.rows.map((row) => {
											const hitRate = cacheHitRate(row);
											const perRequest = costPerRequest(row);
											return (
												<TableRow
													key={`${row.apiKeyId ?? ""}:${row.model}`}
													className="hover:bg-muted/40"
												>
													<TableCell className="align-top">
														<div className="font-medium">{row.apiKey}</div>
														{row.unpricedRequests > 0 && (
															<div className="text-xs text-muted-foreground">
																{formatNumber(row.unpricedRequests)} unpriced
															</div>
														)}
													</TableCell>
													<TableCell className="figure text-right align-top">
														{formatNumber(row.requests)}
													</TableCell>
													<TableCell className="figure text-right align-top">
														{hitRate == null ? "—" : `${hitRate.toFixed(1)}%`}
													</TableCell>
													<TableCell className="figure text-right align-top">
														{formatTokens(row.inputTokens)}
													</TableCell>
													<TableCell className="figure text-right align-top">
														{formatTokens(row.outputTokens)}
													</TableCell>
													<TableCell className="figure text-right align-top">
														{perRequest == null ? "—" : formatUsd(perRequest)}
													</TableCell>
												</TableRow>
											);
										})}
									</TableBody>
								</Table>
							</TableFrame>
						</div>
					))
				)}
			</CardContent>
		</Card>
	);
}
