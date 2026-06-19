import { formatNumber, formatTokens, formatUsd } from "@clankermux/ui-common";
import { Gauge } from "lucide-react";
import { useState } from "react";
import { useCacheEffectiveness } from "../../hooks/queries";
import { TimeRangeSelector } from "../overview/TimeRangeSelector";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

/**
 * Small headline tile. Mirrors the compact stat-card idiom used by
 * CacheKeepalivePanel's StatTile.
 */
function StatTile({
	label,
	value,
	sub,
	valueClassName,
}: {
	label: string;
	value: string;
	sub?: string;
	valueClassName?: string;
}) {
	return (
		<div className="rounded-lg border bg-card p-3">
			<p className="text-xs text-muted-foreground">{label}</p>
			<p className={`text-xl font-bold ${valueClassName ?? ""}`}>{value}</p>
			{sub ? (
				<p className="text-xs text-muted-foreground mt-0.5">{sub}</p>
			) : null}
		</div>
	);
}

/**
 * Analytics-tab "Cache Keep-Alive Effectiveness" panel. A per-range summary that
 * answers "did keeping caches warm actually reduce quota pressure?". The headline
 * figures are the HONEST (conservative, 5m-counterfactual) savings; the optimistic
 * (1h-rate) figures are shown muted for comparison. Self-contained: owns its range
 * state and the useCacheEffectiveness hook, mirroring CacheKeepalivePanel.
 */
export function CacheEffectivenessPanel() {
	const [range, setRange] = useState<string>("7d");
	const { data, isLoading } = useCacheEffectiveness(range);

	const netConservative = data?.netUsdConservative ?? 0;
	const accounts = data?.accounts ?? [];

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between gap-4">
					<div>
						<CardTitle className="flex items-center gap-2">
							<Gauge className="h-5 w-5" />
							Cache Keep-Alive Effectiveness
						</CardTitle>
						<p className="text-xs text-muted-foreground mt-1 max-w-prose">
							Measures whether keeping caches warm actually reduced quota
							pressure over the window. Headline figures are the honest
							(conservative, 5-minute counterfactual) numbers — what the bridge
							saved versus Claude Code's native behaviour with no bridge.
						</p>
					</div>
					<TimeRangeSelector value={range} onChange={setRange} />
				</div>
			</CardHeader>
			<CardContent className="space-y-4">
				{/* Honest headline tiles. */}
				<div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
					<StatTile
						label="Net (honest)"
						value={isLoading ? "—" : formatUsd(netConservative)}
						valueClassName={
							netConservative >= 0 ? "text-green-600" : "text-destructive"
						}
					/>
					<StatTile
						label="Saved (honest)"
						value={isLoading ? "—" : formatUsd(data?.savedUsdConservative ?? 0)}
					/>
					<StatTile
						label="Spent"
						value={isLoading ? "—" : formatUsd(data?.spentUsd ?? 0)}
					/>
					<StatTile
						label="Warm resumes"
						value={isLoading ? "—" : formatNumber(data?.warmResumes ?? 0)}
					/>
					<StatTile
						label="Hit rate"
						value={
							isLoading ? "—" : `${((data?.hitRate ?? 0) * 100).toFixed(1)}%`
						}
					/>
				</div>

				{/* Optimistic comparison line. */}
				<p className="text-xs text-muted-foreground">
					Optimistic (1h-rate) for comparison: net{" "}
					<span className="font-medium">
						{isLoading ? "—" : formatUsd(data?.netUsd ?? 0)}
					</span>{" "}
					· saved{" "}
					<span className="font-medium">
						{isLoading ? "—" : formatUsd(data?.savedUsd ?? 0)}
					</span>
				</p>

				{/* Work in window. */}
				<p className="text-sm">
					<span className="text-muted-foreground">Work in window: </span>
					<span className="font-medium">
						{isLoading ? "—" : formatNumber(data?.totalRequests ?? 0)}
					</span>{" "}
					requests ·{" "}
					<span className="font-medium">
						{isLoading ? "—" : formatTokens(data?.totalPromptTokens ?? 0)}
					</span>{" "}
					prompt tokens
				</p>

				{/* Workload-normalized quota pressure (de-confounds volume). */}
				<div className="rounded-lg border bg-card p-3">
					<p className="text-xs text-muted-foreground">
						7-day quota peak per 1M tokens
					</p>
					<p className="text-xl font-bold">
						{isLoading
							? "—"
							: `${(data?.sevenDayPeakPer1MTokens ?? 0).toFixed(2)}%`}
					</p>
					<p className="text-xs text-muted-foreground mt-0.5 max-w-prose">
						Pool 7-day peak utilization % per 1M prompt tokens of real work —
						de-confounds workload, so you can compare quota pressure across
						weeks of different volume.
					</p>
				</div>

				{/* Per-account quota peaks over the window. */}
				<div className="overflow-x-auto">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b text-left text-xs text-muted-foreground">
								<th className="py-2 pr-4 font-medium">Account</th>
								<th className="py-2 pr-4 font-medium text-right">Peak 5h</th>
								<th className="py-2 font-medium text-right">Peak 7d</th>
							</tr>
						</thead>
						<tbody>
							{accounts.length === 0 ? (
								<tr>
									<td className="py-2 text-muted-foreground" colSpan={3}>
										{isLoading
											? "Loading…"
											: "No quota samples in this window."}
									</td>
								</tr>
							) : (
								accounts.map((a) => (
									<tr key={a.accountId} className="border-b last:border-0">
										<td className="py-2 pr-4">{a.name}</td>
										<td className="py-2 pr-4 text-right tabular-nums">
											{a.peakFiveHourPct.toFixed(1)}%
										</td>
										<td className="py-2 text-right tabular-nums">
											{a.peakSevenDayPct.toFixed(1)}%
										</td>
									</tr>
								))
							)}
						</tbody>
						<tfoot>
							<tr className="border-t font-medium">
								<td className="py-2 pr-4">Pool peak</td>
								<td className="py-2 pr-4 text-right tabular-nums">
									{isLoading
										? "—"
										: `${(data?.poolPeakFiveHourPct ?? 0).toFixed(1)}%`}
								</td>
								<td className="py-2 text-right tabular-nums">
									{isLoading
										? "—"
										: `${(data?.poolPeakSevenDayPct ?? 0).toFixed(1)}%`}
								</td>
							</tr>
						</tfoot>
					</table>
				</div>
			</CardContent>
		</Card>
	);
}
