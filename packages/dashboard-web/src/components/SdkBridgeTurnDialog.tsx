import type {
	SdkBridgeHistoryMode,
	SdkBridgeLegErrorPhase,
	SdkBridgeTurnStatus,
	SdkBridgeTurnView,
} from "@clankermux/types";
import {
	formatCost,
	formatDuration,
	formatTimestamp,
	formatTokens,
} from "@clankermux/ui-common";
import type { ReactNode } from "react";
import { useSdkBridgeTurn } from "../hooks/queries";
import { cn } from "../lib/utils";
import { Badge, badgeVariants } from "./ui/badge";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "./ui/dialog";
import {
	Table,
	TableBody,
	TableCell,
	TableFrame,
	TableHead,
	TableHeader,
	TableRow,
} from "./ui/table";

/** The Request History chip on an inner call of an SDK bridge turn. */
export function SdkBridgeTurnChip({ onOpen }: { onOpen: () => void }) {
	return (
		<button
			type="button"
			className={cn(
				badgeVariants({ variant: "outline" }),
				"text-xs cursor-pointer hover:bg-accent",
			)}
			onClick={onOpen}
			title="Served through the Claude Agent SDK bridge. Open the turn."
		>
			Agent SDK
		</button>
	);
}

const STATUS_LABEL: Record<SdkBridgeTurnStatus, string> = {
	running: "Running",
	completed: "Completed",
	failed: "Failed",
	aborted: "Aborted",
	timed_out: "Timed out",
	shutdown: "Shut down",
	rejected: "Rejected",
};

const HISTORY_LABEL: Record<SdkBridgeHistoryMode, string> = {
	fresh: "Fresh session",
	resume: "Resumed session",
	rebuild_transcript: "Rebuilt from history",
	rebuild_flattened: "Rebuilt from history, flattened",
};

const PHASE_LABEL: Record<SdkBridgeLegErrorPhase, string> = {
	pre_head: "before response",
	mid_stream: "mid-stream",
};

function statusVariant(
	status: SdkBridgeTurnStatus,
): "success" | "warning" | "destructive" | "secondary" {
	if (status === "completed") return "success";
	if (status === "running") return "secondary";
	if (status === "aborted" || status === "shutdown") return "warning";
	return "destructive";
}

function time(ms: number): string {
	return new Date(ms).toLocaleTimeString([], {
		hour12: false,
		hourCycle: "h23",
	});
}

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div>
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="font-medium break-words">{children}</dd>
		</div>
	);
}

/** Everything the turn view shows, from data alone. */
export function SdkBridgeTurnDetails({ view }: { view: SdkBridgeTurnView }) {
	const { turn, legs, inner, innerRequests, prunedInnerCalls } = view;
	const history = turn.rebuildReason
		? `${HISTORY_LABEL[turn.historyMode]} (${turn.rebuildReason.replaceAll("_", " ")})`
		: HISTORY_LABEL[turn.historyMode];
	return (
		<div className="space-y-group text-sm">
			<div className="flex flex-wrap items-center gap-item">
				<Badge variant={statusVariant(turn.status)}>
					{STATUS_LABEL[turn.status]}
				</Badge>
				{turn.httpStatus != null && (
					<Badge variant="outline">{turn.httpStatus}</Badge>
				)}
				{turn.model && <Badge variant="secondary">{turn.model}</Badge>}
				{turn.stopReason && <Badge variant="outline">{turn.stopReason}</Badge>}
			</div>

			{turn.errorMessage && (
				<p className="text-destructive-strong break-words">
					{turn.errorType ? `${turn.errorType}: ` : ""}
					{turn.errorMessage}
				</p>
			)}

			<dl className="grid grid-cols-1 gap-row sm:grid-cols-2">
				<Field label="History">{history}</Field>
				<Field label="System prompt policy">{turn.systemPromptPolicy}</Field>
				<Field label="Ignored fields">
					{turn.ignoredFields?.length ? turn.ignoredFields.join(", ") : "None"}
				</Field>
				<Field label="Account">
					{view.accountName ?? turn.accountId ?? "None"}
				</Field>
				<Field label="Client">
					{[turn.apiKeyName, turn.clientHarness].filter(Boolean).join(" · ") ||
						"Unknown"}
				</Field>
				<Field label="Started">{formatTimestamp(turn.startedAt)}</Field>
				<Field label="Duration">
					{turn.durationMs != null ? formatDuration(turn.durationMs) : "—"}
					{turn.spawnMs != null
						? ` (start-up ${formatDuration(turn.spawnMs)})`
						: ""}
				</Field>
				<Field label="Tool rounds">{turn.toolRoundCount}</Field>
			</dl>

			<section className="space-y-item">
				<h3 className="label-caps">Legs</h3>
				<TableFrame>
					<Table density="compact" aria-label="Legs">
						<TableHeader>
							<TableRow>
								<TableHead>Request</TableHead>
								<TableHead>Kind</TableHead>
								<TableHead>Started</TableHead>
								<TableHead>Status</TableHead>
								<TableHead>Error</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{legs.map((leg) => (
								<TableRow
									key={leg.id}
									className={
										leg.id === view.matchedLegId ? "bg-accent/40" : undefined
									}
								>
									<TableCell className="figure" title={leg.id}>
										{leg.id.slice(0, 8)}
									</TableCell>
									<TableCell>{leg.kind}</TableCell>
									<TableCell className="figure">
										{time(leg.startedAt)}
									</TableCell>
									<TableCell className="figure">
										{leg.httpStatus ?? (leg.finishedAt ? "—" : "open")}
									</TableCell>
									<TableCell className="break-words">
										{leg.errorPhase
											? `${PHASE_LABEL[leg.errorPhase]}: ${leg.errorMessage ?? leg.errorType ?? "error"}`
											: (leg.stopReason ?? "")}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</TableFrame>
			</section>

			<section className="space-y-item">
				<h3 className="label-caps">Model calls</h3>
				<p className="text-muted-foreground">
					{inner.requestCount} recorded
					{prunedInnerCalls > 0 ? `, ${prunedInnerCalls} pruned` : ""} ·{" "}
					{formatTokens(inner.inputTokens)} in ·{" "}
					{formatTokens(inner.outputTokens)} out ·{" "}
					{formatTokens(inner.cacheReadInputTokens)} cache read ·{" "}
					{formatCost(inner.costUsd)}
				</p>
				{innerRequests.length > 0 && (
					<TableFrame>
						<Table density="compact" aria-label="Model calls">
							<TableHeader>
								<TableRow>
									<TableHead>Time</TableHead>
									<TableHead>Account</TableHead>
									<TableHead>Model</TableHead>
									<TableHead>Status</TableHead>
									<TableHead className="text-right">In</TableHead>
									<TableHead className="text-right">Out</TableHead>
									<TableHead className="text-right">Cache read</TableHead>
									<TableHead className="text-right">Cost</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{innerRequests.map((r) => (
									<TableRow key={r.id}>
										<TableCell className="figure" title={r.id}>
											{time(r.timestamp)}
										</TableCell>
										<TableCell>{r.accountName ?? r.accountId ?? "—"}</TableCell>
										<TableCell>{r.model ?? "—"}</TableCell>
										<TableCell
											className={cn(
												"figure",
												!r.success && "text-destructive-strong",
											)}
										>
											{r.statusCode ?? "—"}
										</TableCell>
										<TableCell className="figure text-right">
											{formatTokens(r.inputTokens ?? 0)}
										</TableCell>
										<TableCell className="figure text-right">
											{formatTokens(r.outputTokens ?? 0)}
										</TableCell>
										<TableCell className="figure text-right">
											{formatTokens(r.cacheReadInputTokens ?? 0)}
										</TableCell>
										<TableCell className="figure text-right">
											{r.costUsd != null ? formatCost(r.costUsd) : "—"}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</TableFrame>
				)}
			</section>
		</div>
	);
}

/**
 * An SDK bridge turn in a dialog. `lookupId` is the turn id, or the request
 * id of one of its legs.
 */
export function SdkBridgeTurnDialog({
	lookupId,
	onClose,
}: {
	lookupId: string;
	onClose: () => void;
}) {
	const { data, isLoading, error } = useSdkBridgeTurn(lookupId);
	let body: ReactNode;
	if (isLoading) body = <p className="text-muted-foreground">Loading…</p>;
	else if (error)
		body = (
			<p className="text-destructive-strong">
				Could not load the turn:{" "}
				{error instanceof Error ? error.message : String(error)}
			</p>
		);
	else if (!data)
		body = (
			<p className="text-muted-foreground">
				No SDK bridge turn is recorded under this id.
			</p>
		);
	else body = <SdkBridgeTurnDetails view={data} />;
	return (
		<Dialog open={true} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Agent SDK turn</DialogTitle>
					<DialogDescription className="font-mono text-xs">
						{data?.turn.id ?? lookupId}
					</DialogDescription>
				</DialogHeader>
				{body}
			</DialogContent>
		</Dialog>
	);
}
