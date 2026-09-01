import { getModelShortName } from "@clankermux/core";
import { formatTokensPerSecond } from "@clankermux/ui-common";
import { useMemo, useState } from "react";
import { CHART_TOKENS } from "../../constants";
import {
	Table,
	TableBody,
	TableCell,
	TableFrame,
	TableHead,
	TableHeader,
	TableRow,
} from "../ui/table";
import { type SortDir, SortHeaderButton } from "./sort-header";

/** One model's row in the performance table. */
export interface ModelPerformanceRow {
	model: string;
	medianTps: number | null;
	p95Tps: number | null;
	speedSampleCount: number;
	avgResponseTimeMs: number;
	p95ResponseTimeMs: number;
	errorRate: number; // 0-100
	costPer1kTokens: number | null;
	/** medianTps per dollar (tok/s/$); null when cost is unknown. */
	efficiency: number | null;
}

interface ModelPerformanceTableProps {
	rows: ModelPerformanceRow[];
	loading?: boolean;
}

// Below this many samples a median/p95 is more noise than signal — we still
// show the row but flag the count so it isn't read as authoritative.
const LOW_SAMPLE_THRESHOLD = 5;

type MetricKey = Exclude<
	keyof ModelPerformanceRow,
	"model" | "speedSampleCount"
>;

interface MetricColumn {
	key: MetricKey;
	label: string;
	color: string;
	format: (value: number) => string;
}

// Each column's inline bar is normalized to ITS OWN column max, so a fast
// provider's speed can't squash everyone else's bar (the linear-axis skew that
// made the old shared-axis chart unreadable). Bars encode magnitude within a
// column only — compare across columns by reading the numbers.
const METRIC_COLUMNS: MetricColumn[] = [
	{
		key: "medianTps",
		label: "Median tok/s",
		color: CHART_TOKENS.purple,
		format: (v) => formatTokensPerSecond(v),
	},
	{
		key: "p95Tps",
		label: "P95 tok/s",
		color: CHART_TOKENS.indigo,
		format: (v) => formatTokensPerSecond(v),
	},
	{
		key: "avgResponseTimeMs",
		label: "Avg resp",
		color: CHART_TOKENS.blue,
		format: (v) => `${Math.round(v)} ms`,
	},
	{
		key: "p95ResponseTimeMs",
		label: "P95 resp",
		color: CHART_TOKENS.cyan,
		format: (v) => `${Math.round(v)} ms`,
	},
	{
		key: "errorRate",
		label: "Error %",
		color: CHART_TOKENS.error,
		format: (v) => `${v.toFixed(1)}%`,
	},
	{
		key: "costPer1kTokens",
		label: "Cost / 1K",
		color: CHART_TOKENS.warning,
		format: (v) => `$${v.toFixed(4)}`,
	},
	{
		key: "efficiency",
		label: "Efficiency",
		color: CHART_TOKENS.success,
		format: (v) => `${Math.round(v).toLocaleString()} tok/s/$`,
	},
];

type SortKey = "model" | MetricKey;

export function ModelPerformanceTable({
	rows,
	loading = false,
}: ModelPerformanceTableProps) {
	const [sortKey, setSortKey] = useState<SortKey>("medianTps");
	const [sortDir, setSortDir] = useState<SortDir>("desc");

	// Column maxes for bar normalization (ignoring nulls).
	const maxByColumn = useMemo(() => {
		const maxes = {} as Record<MetricKey, number>;
		for (const col of METRIC_COLUMNS) {
			let max = 0;
			for (const row of rows) {
				const value = row[col.key];
				if (value != null && value > max) max = value;
			}
			maxes[col.key] = max;
		}
		return maxes;
	}, [rows]);

	const sortedRows = useMemo(() => {
		const copy = [...rows];
		copy.sort((a, b) => {
			if (sortKey === "model") {
				const cmp = a.model.localeCompare(b.model);
				return sortDir === "asc" ? cmp : -cmp;
			}
			const av = a[sortKey];
			const bv = b[sortKey];
			// Nulls always sink to the bottom regardless of direction.
			if (av == null && bv == null) return 0;
			if (av == null) return 1;
			if (bv == null) return -1;
			return sortDir === "asc" ? av - bv : bv - av;
		});
		return copy;
	}, [rows, sortKey, sortDir]);

	const handleSort = (key: SortKey) => {
		if (key === sortKey) {
			setSortDir((d) => (d === "asc" ? "desc" : "asc"));
		} else {
			setSortKey(key);
			// Text sorts ascending by default; metrics descending (best first).
			setSortDir(key === "model" ? "asc" : "desc");
		}
	};

	if (loading) {
		return (
			<div className="flex items-center justify-center h-48">
				<div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
			</div>
		);
	}

	if (rows.length === 0) {
		return (
			<div className="flex items-center justify-center h-48 text-muted-foreground">
				No model performance data available
			</div>
		);
	}

	return (
		<TableFrame>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>
							<SortHeaderButton
								label="Model"
								active={sortKey === "model"}
								dir={sortDir}
								onClick={() => handleSort("model")}
							/>
						</TableHead>
						{METRIC_COLUMNS.map((col) => (
							<TableHead key={col.key} className="text-right">
								<SortHeaderButton
									label={col.label}
									active={sortKey === col.key}
									dir={sortDir}
									onClick={() => handleSort(col.key)}
								/>
							</TableHead>
						))}
					</TableRow>
				</TableHeader>
				<TableBody>
					{sortedRows.map((row) => {
						const lowSample = row.speedSampleCount < LOW_SAMPLE_THRESHOLD;
						return (
							<TableRow key={row.model} className="hover:bg-muted/40">
								<TableCell className="align-top">
									<div className="font-medium">
										{getModelShortName(row.model)}
									</div>
									<div className="text-xs text-muted-foreground">
										n={row.speedSampleCount.toLocaleString()}
										{lowSample && row.speedSampleCount > 0 && (
											<span
												className="text-warning-strong"
												title="Few speed samples"
											>
												{" "}
												· low sample
											</span>
										)}
									</div>
								</TableCell>
								{METRIC_COLUMNS.map((col) => {
									const value = row[col.key];
									const max = maxByColumn[col.key];
									// A genuine zero (e.g. a 0% error rate) gets no bar — the
									// 2% floor is only to keep small-but-nonzero values visible.
									const pct =
										value != null && value > 0 && max > 0
											? Math.max(2, (value / max) * 100)
											: 0;
									return (
										<TableCell key={col.key} className="align-top">
											<div className="figure text-right">
												{value != null ? col.format(value) : "—"}
											</div>
											<div className="mt-1 h-1 w-full bg-muted rounded-full overflow-hidden">
												{/* Width is computed per row against this column's
												    cross-row max, so it cannot be a class. */}
												<div
													className="h-full rounded-full transition-all"
													style={{
														width: `${pct}%`,
														backgroundColor: col.color,
													}}
												/>
											</div>
										</TableCell>
									);
								})}
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</TableFrame>
	);
}
