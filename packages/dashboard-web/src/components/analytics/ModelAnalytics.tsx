import { BarChart3 } from "lucide-react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import {
	type ModelPerformanceRow,
	ModelPerformanceTable,
} from "./ModelPerformanceTable";

interface ModelAnalyticsProps {
	modelPerformance: Array<{
		model: string;
		avgResponseTime: number;
		p95ResponseTime: number;
		errorRate: number;
		medianTokensPerSecond: number | null;
		p95TokensPerSecond: number | null;
		speedSampleCount: number;
	}>;
	costByModel: Array<{
		model: string;
		costUsd: number;
		requests: number;
		totalTokens?: number;
	}>;
	loading?: boolean;
}

/**
 * Model Performance — a dense, sortable per-model table. Replaces the old
 * multi-metric comparison charts, whose shared linear axis made a single fast
 * provider (e.g. GPT) squash every other model's bar to nothing. Here each
 * column's bar is normalized to its own column, so the comparison stays legible
 * regardless of how the models' speeds differ; numbers carry the cross-model
 * comparison.
 */
export function ModelAnalytics({
	modelPerformance,
	costByModel,
	loading = false,
}: ModelAnalyticsProps) {
	const rows: ModelPerformanceRow[] = modelPerformance.map((perf) => {
		const cost = costByModel.find((c) => c.model === perf.model);
		const totalCost = cost?.costUsd ?? 0;
		const totalTokens = cost?.totalTokens ?? 0;
		// Cost per 1K tokens; null when we have no token volume to divide by.
		const costPer1kTokens =
			totalTokens > 0 ? (totalCost / totalTokens) * 1000 : null;
		const median = perf.medianTokensPerSecond;
		// Efficiency = typical speed per dollar; needs both a median and a cost.
		const efficiency =
			median != null && costPer1kTokens != null && costPer1kTokens > 0
				? median / costPer1kTokens
				: null;
		return {
			model: perf.model,
			medianTps: perf.medianTokensPerSecond,
			p95Tps: perf.p95TokensPerSecond,
			speedSampleCount: perf.speedSampleCount,
			avgResponseTimeMs: perf.avgResponseTime,
			p95ResponseTimeMs: perf.p95ResponseTime,
			errorRate: perf.errorRate,
			costPer1kTokens,
			efficiency,
		};
	});

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<BarChart3 className="h-5 w-5" />
					Model Performance
				</CardTitle>
				<CardDescription>
					Speed (median/p95), latency, reliability and cost per model. Bars are
					normalized per column, so a fast provider can't squash the others —
					click any column header to sort.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<ModelPerformanceTable rows={rows} loading={loading} />
			</CardContent>
		</Card>
	);
}
