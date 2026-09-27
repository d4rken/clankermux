import {
	SDK_BRIDGE_HISTORY_MODES,
	SDK_BRIDGE_REBUILD_REASONS,
	SDK_BRIDGE_TURN_STATUSES,
	type SdkBridgeHealthFailure,
	type SdkBridgeHealthResponse,
	type SdkBridgeHealthSplit,
	type SdkBridgePercentiles,
} from "@clankermux/types";
import {
	formatCost,
	formatDuration,
	formatTokens,
} from "@clankermux/ui-common";
import { AlertCircle, Info } from "lucide-react";
import {
	SDK_BRIDGE_HISTORY_LABEL,
	SDK_BRIDGE_REBUILD_REASON_LABEL,
	SDK_BRIDGE_STATUS_LABEL,
} from "../../lib/sdk-bridge-labels";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { InsetPanel } from "../ui/inset-panel";
import { PanelEmptyState } from "../ui/panel-empty-state";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Skeleton } from "../ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableFrame,
	TableHead,
	TableHeader,
	TableRow,
} from "../ui/table";

interface SdkBridgeHealthCardProps {
	data: SdkBridgeHealthResponse | undefined;
	/** Set while the first read is in flight and nothing is cached. */
	loading?: boolean;
	/** Set when that read FAILED with nothing cached. Wins over `loading`. */
	unavailableReason?: string;
	staleNote?: string;
	/** Opens a turn by id; the failure rows are buttons only when it is set. */
	onOpenTurn?: (turnId: string) => void;
}

function percent(numerator: number, denominator: number): string {
	return denominator === 0
		? "—"
		: `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function percentileLine(
	p: SdkBridgePercentiles,
	format: (value: number) => string,
	unit: string,
): string {
	if (p.samples === 0 || p.p50 === null || p.p95 === null) return "no samples";
	return `p50 ${format(p.p50)} · p95 ${format(p.p95)} · ${p.samples} ${unit}`;
}

function errorText(f: SdkBridgeHealthFailure): string {
	const head = [f.httpStatus, f.errorType].filter((v) => v != null).join(" ");
	if (!f.errorMessage) return head || "—";
	return head ? `${head}: ${f.errorMessage}` : f.errorMessage;
}

function time(ms: number): string {
	return new Date(ms).toLocaleString([], { hour12: false, hourCycle: "h23" });
}

function SplitTable({
	label,
	heading,
	served,
	rows,
	name,
}: {
	label: string;
	heading: string;
	/** Model calls and cost belong to the account that served them. */
	served: boolean;
	rows: SdkBridgeHealthSplit[];
	name: (row: SdkBridgeHealthSplit) => string;
}) {
	return (
		<TableFrame>
			<Table density="compact" aria-label={label}>
				<TableHeader>
					<TableRow>
						<TableHead>{heading}</TableHead>
						<TableHead className="text-right">Total</TableHead>
						<TableHead className="text-right">Failed</TableHead>
						<TableHead className="text-right">Rejected</TableHead>
						<TableHead className="text-right">Failure rate</TableHead>
						<TableHead className="text-right">
							{served ? "Model calls served" : "Model calls"}
						</TableHead>
						<TableHead className="text-right">
							{served ? "Cost served" : "Cost"}
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => (
						<TableRow key={row.key ?? "\0none"}>
							<TableCell title={row.key ?? undefined}>{name(row)}</TableCell>
							<TableCell className="figure text-right">{row.total}</TableCell>
							<TableCell className="figure text-right">
								{row.failures}
							</TableCell>
							<TableCell className="figure text-right">
								{row.rejected}
							</TableCell>
							<TableCell className="figure text-right">
								{percent(row.failures, row.finished)}
							</TableCell>
							<TableCell className="figure text-right">
								{row.innerCalls}
							</TableCell>
							<TableCell className="figure text-right">
								{formatCost(row.costUsd)}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</TableFrame>
	);
}

/**
 * Agent SDK bridge turns in the analytics range. Same states as the Request
 * outcomes card: skeleton, unavailable, stale.
 */
export function SdkBridgeHealthCard({
	data,
	loading = false,
	unavailableReason,
	staleNote,
	onOpenTurn,
}: SdkBridgeHealthCardProps) {
	const pending = loading && !unavailableReason;
	const resolved = !pending && !unavailableReason && data != null;
	const rebuildReasons = resolved
		? SDK_BRIDGE_REBUILD_REASONS.filter((r) => data.byRebuildReason[r] > 0)
		: [];

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center gap-item">
					<CardTitle>Agent SDK bridge</CardTitle>
					<Popover>
						<PopoverTrigger asChild>
							<button
								type="button"
								aria-label="About the Agent SDK bridge card"
								className="rounded text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								<Info className="h-4 w-4" aria-hidden="true" />
							</button>
						</PopoverTrigger>
						<PopoverContent className="space-y-item text-xs">
							<p>
								Turns and side requests Claude Code ran for /wire/openai clients
								on official Anthropic accounts, by start time. The filters above
								do not apply.
							</p>
							<p>
								The failure rate is failed and timed-out turns over finished
								ones (completed, failed, timed out). Counted on their own:
								running turns, turns waiting for tool results, rejected turns
								(refused before Claude Code ran), aborted ones (the client left
								or started a new turn), expired ones (tool results never came)
								and turns a server shutdown ended. Timings and tool rounds cover
								finished turns only.
							</p>
							<p>
								Tokens and cost come from the turns' model calls that are still
								recorded. By account, a turn counts on the account routing chose
								for it, and a model call on the account that served it, so an
								account that took over after a failover shows calls without
								turns.
							</p>
						</PopoverContent>
					</Popover>
				</div>
			</CardHeader>
			<CardContent className="space-y-group">
				{unavailableReason ? (
					<p className="flex items-center gap-item text-xs text-warning-strong">
						<AlertCircle className="h-3.5 w-3.5 shrink-0" />
						{unavailableReason}
					</p>
				) : !resolved ? (
					<InsetPanel className="space-y-tight">
						<Skeleton className="h-5 w-48" />
						<Skeleton className="h-4 w-64" />
					</InsetPanel>
				) : data.total === 0 ? (
					<>
						{staleNote && (
							<p className="text-xs text-muted-foreground">{staleNote}</p>
						)}
						<PanelEmptyState>No Agent SDK turns in this range</PanelEmptyState>
					</>
				) : (
					<>
						<InsetPanel className="space-y-tight text-xs">
							<p className="text-sm font-medium">
								{data.failureRate.finished === 0
									? "No finished turns"
									: `${data.failureRate.failures} of ${data.failureRate.finished} finished turns and side requests failed (${percent(data.failureRate.failures, data.failureRate.finished)})`}
							</p>
							<p className="text-muted-foreground tabular-nums">
								{data.byKind.turn} turns · {data.byKind.side_request} side
								requests
							</p>
							<p className="tabular-nums">
								{SDK_BRIDGE_TURN_STATUSES.map(
									(s) => `${SDK_BRIDGE_STATUS_LABEL[s]} ${data.byStatus[s]}`,
								).join(" · ")}
							</p>
							{staleNote && (
								<p className="text-muted-foreground">{staleNote}</p>
							)}
						</InsetPanel>

						<dl className="grid grid-cols-1 gap-row text-xs sm:grid-cols-2">
							{(
								[
									["Start-up", data.timings.spawnMs],
									["First event", data.timings.firstEventMs],
									["Duration", data.timings.durationMs],
								] as const
							).map(([label, p]) => (
								<div key={label}>
									<dt className="text-muted-foreground">{label}</dt>
									<dd className="tabular-nums">
										{percentileLine(p, formatDuration, "samples")}
									</dd>
								</div>
							))}
							<div>
								<dt className="text-muted-foreground">Tool rounds per turn</dt>
								<dd className="tabular-nums">
									{percentileLine(data.toolRounds, String, "turns")}
								</dd>
							</div>
						</dl>

						<div className="space-y-tight text-xs text-muted-foreground">
							<p className="tabular-nums">
								{SDK_BRIDGE_HISTORY_MODES.map(
									(m) =>
										`${SDK_BRIDGE_HISTORY_LABEL[m]} ${data.byHistoryMode[m]}`,
								).join(" · ")}
							</p>
							{rebuildReasons.length > 0 && (
								<p className="tabular-nums">
									Rebuild reasons:{" "}
									{rebuildReasons
										.map(
											(r) =>
												`${SDK_BRIDGE_REBUILD_REASON_LABEL[r]} ${data.byRebuildReason[r]}`,
										)
										.join(" · ")}
								</p>
							)}
							<p className="tabular-nums">
								{data.inner.requestCount} model calls ·{" "}
								{formatTokens(data.inner.inputTokens)} in ·{" "}
								{formatTokens(data.inner.outputTokens)} out ·{" "}
								{formatTokens(data.inner.cacheReadInputTokens)} cache read ·{" "}
								{formatCost(data.inner.costUsd)}
							</p>
						</div>

						<SplitTable
							label="By client"
							heading="Client"
							served={false}
							rows={data.byHarness}
							name={(row) => row.key ?? "Unknown"}
						/>
						<SplitTable
							label="By account"
							heading="Account"
							served
							rows={data.byAccount}
							name={(row) => row.name ?? row.key ?? "None"}
						/>

						{data.errors.length > 0 && (
							<TableFrame>
								<Table density="compact" aria-label="Errors">
									<TableHeader>
										<TableRow>
											<TableHead>Status</TableHead>
											<TableHead>Error</TableHead>
											<TableHead>HTTP</TableHead>
											<TableHead className="text-right">Count</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{data.errors.map((e) => (
											<TableRow
												key={`${e.status}\0${e.errorType}\0${e.httpStatus}`}
											>
												<TableCell>
													{SDK_BRIDGE_STATUS_LABEL[e.status]}
												</TableCell>
												<TableCell>{e.errorType ?? "—"}</TableCell>
												<TableCell className="figure">
													{e.httpStatus ?? "—"}
												</TableCell>
												<TableCell className="figure text-right">
													{e.count}
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</TableFrame>
						)}

						{data.recentFailures.length > 0 && (
							<section className="space-y-item">
								<h3 className="label-caps">Recent failures</h3>
								<TableFrame>
									<Table density="compact" aria-label="Recent failures">
										<TableHeader>
											<TableRow>
												<TableHead>Started</TableHead>
												<TableHead>Status</TableHead>
												<TableHead>Client</TableHead>
												<TableHead>Error</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{data.recentFailures.map((f) => (
												<TableRow key={f.id}>
													<TableCell className="figure whitespace-nowrap">
														{onOpenTurn ? (
															<button
																type="button"
																title={f.id}
																className="rounded underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
																onClick={() => onOpenTurn(f.id)}
															>
																{time(f.startedAt)}
															</button>
														) : (
															<span title={f.id}>{time(f.startedAt)}</span>
														)}
													</TableCell>
													<TableCell>
														{SDK_BRIDGE_STATUS_LABEL[f.status]}
														{f.kind === "side_request" && (
															<span className="text-muted-foreground">
																{" "}
																· Side request
															</span>
														)}
													</TableCell>
													<TableCell>{f.clientHarness ?? "—"}</TableCell>
													<TableCell className="max-w-md whitespace-normal break-words">
														{errorText(f)}
													</TableCell>
												</TableRow>
											))}
										</TableBody>
									</Table>
								</TableFrame>
							</section>
						)}
					</>
				)}
			</CardContent>
		</Card>
	);
}
