import { getModelShortName } from "@clankermux/core";
import type { SpeedTimePoint } from "@clankermux/types";
import { format } from "date-fns";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TimeRange } from "../../constants";
import { MultiModelChart } from "../charts";
import { Button } from "../ui/button";

interface SpeedOverTimeChartProps {
	/** Per-model median output-speed points (already artifact-filtered upstream). */
	speedTimeSeries: SpeedTimePoint[];
	timeRange: TimeRange;
	loading?: boolean;
	height?: number;
}

/**
 * Output speed over time, one line per model, with a model multi-select so you
 * can isolate "is <model> getting slower over time?" — the question the old
 * single all-models-averaged line couldn't answer. Values are per-bucket
 * medians (p50), so a few fast requests don't yank a line around.
 *
 * Pivots the flat {ts, model, medianTps}[] series into the
 * {time, [model]: value}[] shape MultiModelChart expects and reuses that chart
 * (its tokensPerSecond metric path) rather than introducing a new chart type.
 */
export function SpeedOverTimeChart({
	speedTimeSeries,
	timeRange,
	loading = false,
	height = 320,
}: SpeedOverTimeChartProps) {
	// Every model present in the series, sorted for a stable chip/legend order.
	const allModels = useMemo(() => {
		const set = new Set<string>();
		for (const point of speedTimeSeries) set.add(point.model);
		return Array.from(set).sort();
	}, [speedTimeSeries]);

	// Selected models. `null` is the "all" sentinel (the default and the state
	// we collapse back to when every model is re-selected) so the selection
	// stays sensible as new models appear across refetches.
	const [selected, setSelected] = useState<string[] | null>(null);
	const activeModels = selected ?? allModels;

	// Mirror allModels into a ref so the setSelected updater reads the current
	// list, not the one captured when toggleModel was created — otherwise a
	// refetch that adds/removes a model between click and state-flush would
	// compare against a stale length and collapse the sentinel incorrectly.
	const allModelsRef = useRef(allModels);
	useEffect(() => {
		allModelsRef.current = allModels;
	}, [allModels]);

	const chartData = useMemo<
		Array<{ time: string; [model: string]: string | number }>
	>(() => {
		const formatter =
			timeRange === "30d"
				? (date: Date) => format(date, "MMM d")
				: (date: Date) => format(date, "HH:mm");

		const byTs = new Map<
			number,
			{ time: string; [model: string]: string | number }
		>();
		for (const point of speedTimeSeries) {
			let row = byTs.get(point.ts);
			if (!row) {
				row = { time: formatter(new Date(point.ts)) };
				byTs.set(point.ts, row);
			}
			row[point.model] = point.medianTps;
		}
		return Array.from(byTs.entries())
			.sort(([a], [b]) => a - b)
			.map(([, row]) => row);
	}, [speedTimeSeries, timeRange]);

	const toggleModel = (model: string) => {
		setSelected((prev) => {
			const all = allModelsRef.current;
			const base = prev ?? all;
			const next = base.includes(model)
				? base.filter((m) => m !== model)
				: [...base, model];
			// Both "everything selected" and "nothing selected" collapse to the
			// "all" sentinel — re-selecting all returns to the default, and
			// deselecting the last model shows all rather than a blank chart.
			return next.length === 0 || next.length === all.length ? null : next;
		});
	};

	return (
		<div className="space-y-3">
			{allModels.length > 1 && (
				<div className="flex flex-wrap gap-2">
					{allModels.map((model) => (
						<Button
							key={model}
							type="button"
							size="sm"
							variant={activeModels.includes(model) ? "default" : "outline"}
							onClick={() => toggleModel(model)}
						>
							{getModelShortName(model)}
						</Button>
					))}
				</div>
			)}
			<MultiModelChart
				data={chartData}
				models={activeModels}
				metric="tokensPerSecond"
				loading={loading}
				height={height}
			/>
		</div>
	);
}
