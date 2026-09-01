import { formatNumber, formatTokens, formatUsd } from "@clankermux/ui-common";
import { Gauge } from "lucide-react";
import type { TimeRange } from "../../constants";
import { useCacheEffectiveness } from "../../hooks/queries";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableFooter,
	TableFrame,
	TableHead,
	TableHeader,
	TableRow,
} from "../ui/table";

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
 * Analytics-tab cache-keepalive "Effectiveness" panel. A per-range summary that
 * answers "did keeping caches warm actually reduce quota pressure?". The headline
 * figures are the HONEST (conservative, 5m-counterfactual) savings; the optimistic
 * (1h-rate) figures are shown muted for comparison. The `range` is supplied by the
 * enclosing CacheKeepaliveSection, which owns the shared window selector.
 */
export function CacheEffectivenessPanel({ range }: { range: TimeRange }) {
	const { data, isLoading } = useCacheEffectiveness(range);

	const netConservative = data?.netUsdConservative ?? 0;
	const accounts = data?.accounts ?? [];

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-item">
					<Gauge className="h-5 w-5" />
					Effectiveness
				</CardTitle>
				<CardDescription className="text-xs">
					Measures whether keeping caches warm actually reduced quota pressure
					over the window. Headline figures are the honest (conservative,
					5-minute counterfactual) numbers — what the bridge saved versus Claude
					Code's native behaviour with no bridge.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-group">
				{/* Honest headline tiles. */}
				<div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-row">
					<StatTile
						label="Net (honest)"
						value={isLoading ? "—" : formatUsd(netConservative)}
						valueClassName={
							netConservative >= 0
								? "text-success-strong"
								: "text-destructive-strong"
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
				<TableFrame>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Account</TableHead>
								<TableHead className="text-right">Peak 5h</TableHead>
								<TableHead className="text-right">Peak 7d</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{accounts.length === 0 ? (
								<TableRow>
									<TableCell className="text-muted-foreground" colSpan={3}>
										{isLoading
											? "Loading…"
											: "No quota samples in this window."}
									</TableCell>
								</TableRow>
							) : (
								accounts.map((a) => (
									<TableRow key={a.accountId}>
										<TableCell>{a.name}</TableCell>
										<TableCell className="figure text-right">
											{a.peakFiveHourPct.toFixed(1)}%
										</TableCell>
										<TableCell className="figure text-right">
											{a.peakSevenDayPct.toFixed(1)}%
										</TableCell>
									</TableRow>
								))
							)}
						</TableBody>
						<TableFooter>
							<TableRow>
								<TableHead scope="row">Pool peak</TableHead>
								<TableCell className="figure text-right font-medium">
									{isLoading
										? "—"
										: `${(data?.poolPeakFiveHourPct ?? 0).toFixed(1)}%`}
								</TableCell>
								<TableCell className="figure text-right font-medium">
									{isLoading
										? "—"
										: `${(data?.poolPeakSevenDayPct ?? 0).toFixed(1)}%`}
								</TableCell>
							</TableRow>
						</TableFooter>
					</Table>
				</TableFrame>
			</CardContent>
		</Card>
	);
}
