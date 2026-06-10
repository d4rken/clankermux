import type { ToolErrorMessage, ToolErrorTimePoint } from "@clankermux/types";

/**
 * Pure transforms for the Tool Errors panel (Analytics tab). Kept out of the
 * component so the grouping logic is unit-testable, mirroring lib/cumulative.ts.
 */

/** One chart row: a bucket timestamp plus per-tool error-rate % keyed by toolKey. */
export interface ToolErrorTrendRow {
	ts: number;
	[toolKey: string]: number;
}

export interface ToolErrorTrendSeries {
	/** Stable, collision-safe dataKey for the chart (see toolKey()). */
	key: string;
	/** Human-readable tool name for the legend/tooltip. */
	label: string;
}

export interface ToolErrorTrend {
	rows: ToolErrorTrendRow[];
	/** Ordered by total errors desc so colors stay stable between refreshes. */
	series: ToolErrorTrendSeries[];
}

/**
 * Stable identity for chart series keys. Prefixed so no tool name (arbitrary,
 * client-supplied) can collide with row fields like `ts` or `time` — the same
 * pattern ContextCompositionPanel uses for project keys.
 */
export function toolKey(toolName: string): string {
	return `tool:${toolName}`;
}

/**
 * Pivot the per-(bucket, tool) time series into one chart row per bucket with
 * each tool's error-rate % (errors / calls × 100) under its toolKey. Buckets
 * where a tool made no calls simply omit that tool's key (recharts renders a
 * gap). Rows come back sorted by ts asc; series by total errors desc.
 */
export function buildToolErrorTrend(
	timeSeries: ToolErrorTimePoint[],
): ToolErrorTrend {
	const errorsByTool = new Map<string, number>();
	const byTs = new Map<number, ToolErrorTrendRow>();

	for (const point of timeSeries) {
		// Zero-call points contribute neither a chart value nor series ordering
		// weight — skip them entirely before any accumulation.
		if (point.calls <= 0) continue;
		errorsByTool.set(
			point.toolName,
			(errorsByTool.get(point.toolName) ?? 0) + point.errors,
		);
		let row = byTs.get(point.ts);
		if (!row) {
			row = { ts: point.ts };
			byTs.set(point.ts, row);
		}
		row[toolKey(point.toolName)] = (point.errors / point.calls) * 100;
	}

	const series = Array.from(errorsByTool.entries())
		.sort((a, b) => b[1] - a[1])
		.map(([toolName]) => ({ key: toolKey(toolName), label: toolName }));

	const rows = Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);
	return { rows, series };
}

export interface ToolMessageGroup {
	toolName: string;
	/** Sum of occurrences across ALL of the tool's messages (pre-cap). */
	totalOccurrences: number;
	/** Top messages by occurrences, capped at MAX_MESSAGES_PER_TOOL. */
	messages: ToolErrorMessage[];
}

/** Cap per-tool message lists so one chatty tool can't swamp the section. */
export const MAX_MESSAGES_PER_TOOL = 5;

/**
 * Group the flat top-message rows by tool, ordered by each tool's total
 * occurrences desc; within a tool, messages keep occurrences-desc order and
 * are capped at MAX_MESSAGES_PER_TOOL (totalOccurrences still counts them all).
 */
export function groupToolMessages(
	topMessages: ToolErrorMessage[],
): ToolMessageGroup[] {
	const byTool = new Map<string, ToolErrorMessage[]>();
	for (const message of topMessages) {
		const list = byTool.get(message.toolName);
		if (list) {
			list.push(message);
		} else {
			byTool.set(message.toolName, [message]);
		}
	}

	return Array.from(byTool.entries())
		.map(([toolName, messages]) => {
			// Defensive per-tool re-sort: the server orders rows by GLOBAL
			// occurrences desc, which happens to keep each tool's rows in order
			// today, but the cap below must survive any future ordering change.
			const sorted = [...messages].sort(
				(a, b) => b.occurrences - a.occurrences,
			);
			return {
				toolName,
				// Order-independent: summed over ALL of the tool's rows, not the
				// capped/sorted slice.
				totalOccurrences: messages.reduce((sum, m) => sum + m.occurrences, 0),
				messages: sorted.slice(0, MAX_MESSAGES_PER_TOOL),
			};
		})
		.sort((a, b) => b.totalOccurrences - a.totalOccurrences);
}
