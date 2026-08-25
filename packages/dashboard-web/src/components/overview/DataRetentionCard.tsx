import { formatBytes } from "@clankermux/ui-common";
import { AlertCircle } from "lucide-react";
import { useEffect, useState } from "react";
import {
	useCleanupNow,
	useRetention,
	useSetRetention,
	useStorageUsage,
} from "../../hooks/queries";
import {
	SettingFigure,
	SettingNumberControl,
	SettingRow,
} from "../settings/SettingRow";
import { Button } from "../ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Switch } from "../ui/switch";

export function DataRetentionCard() {
	const { data, isLoading } = useRetention();
	const setRetention = useSetRetention();
	const cleanupNow = useCleanupNow();
	const { data: usage } = useStorageUsage();
	const [payloadHours, setPayloadHours] = useState<number>(
		data?.payloadHours ?? 24,
	);
	// Edited in GB (the settable range spans 0–1024 GB); the API speaks MB.
	const [payloadMaxGb, setPayloadMaxGb] = useState<number>(
		(data?.payloadMaxMb ?? 0) / 1024,
	);
	const [requestDays, setRequestDays] = useState<number>(
		data?.requestDays ?? 3650,
	);
	const [usageSnapshotDays, setUsageSnapshotDays] = useState<number>(
		// Matches the server default (getUsageSnapshotRetentionDays = 90); avoids
		// the UI briefly flashing the old 3650 before the config query resolves.
		data?.usageSnapshotDays ?? 3650,
	);
	const [memorySnapshotDays, setMemorySnapshotDays] = useState<number>(
		data?.memorySnapshotDays ?? 14,
	);
	const [cacheKeepaliveSnapshotDays, setCacheKeepaliveSnapshotDays] =
		useState<number>(data?.cacheKeepaliveSnapshotDays ?? 30);

	useEffect(() => {
		if (typeof data?.payloadHours === "number")
			setPayloadHours(data.payloadHours);
		if (typeof data?.payloadMaxMb === "number")
			setPayloadMaxGb(data.payloadMaxMb / 1024);
		if (typeof data?.requestDays === "number") setRequestDays(data.requestDays);
		if (typeof data?.usageSnapshotDays === "number")
			setUsageSnapshotDays(data.usageSnapshotDays);
		if (typeof data?.memorySnapshotDays === "number")
			setMemorySnapshotDays(data.memorySnapshotDays);
		if (typeof data?.cacheKeepaliveSnapshotDays === "number")
			setCacheKeepaliveSnapshotDays(data.cacheKeepaliveSnapshotDays);
	}, [
		data?.payloadHours,
		data?.payloadMaxMb,
		data?.requestDays,
		data?.usageSnapshotDays,
		data?.memorySnapshotDays,
		data?.cacheKeepaliveSnapshotDays,
	]);

	const disabled = isLoading || setRetention.isPending;
	const validPayload =
		Number.isFinite(payloadHours) && payloadHours >= 1 && payloadHours <= 8760;
	// 0 is valid and means "no byte budget"; the server cap is 1048576 MB.
	const validPayloadMax =
		Number.isFinite(payloadMaxGb) && payloadMaxGb >= 0 && payloadMaxGb <= 1024;
	const validRequests =
		Number.isFinite(requestDays) && requestDays >= 1 && requestDays <= 3650;
	const validUsageSnapshots =
		Number.isFinite(usageSnapshotDays) &&
		usageSnapshotDays >= 1 &&
		usageSnapshotDays <= 3650;
	const validMemorySnapshots =
		Number.isFinite(memorySnapshotDays) &&
		memorySnapshotDays >= 1 &&
		memorySnapshotDays <= 3650;
	const validCacheKeepaliveSnapshots =
		Number.isFinite(cacheKeepaliveSnapshotDays) &&
		cacheKeepaliveSnapshotDays >= 1 &&
		cacheKeepaliveSnapshotDays <= 3650;

	// Per-data-type storage usage, keyed for inline lookup next to each control.
	// A control may govern more than one table (the usage-snapshot retention
	// prunes both the account-wide and the per-family series on one cutoff), so
	// this takes a key LIST and reports the total: a key nothing renders is a
	// figure the user never sees.
	const usageByKey = new Map((usage?.types ?? []).map((t) => [t.key, t]));
	const usageFigure = (
		...keys: Array<
			| "payloads"
			| "requests"
			| "usage_snapshots"
			| "usage_scoped_snapshots"
			| "unified_claim_observations"
			| "memory_snapshots"
		>
	) => {
		if (!usage?.available) return undefined;
		const present = keys
			.map((k) => usageByKey.get(k))
			.filter((t): t is NonNullable<typeof t> => t != null);
		if (present.length === 0) return undefined;
		const approxBytes = present.reduce((sum, t) => sum + t.approxBytes, 0);
		const rowCount = present.reduce((sum, t) => sum + t.rowCount, 0);
		return (
			<SettingFigure
				figure={`~${formatBytes(approxBytes)}`}
				note={`${rowCount.toLocaleString()} rows`}
			/>
		);
	};

	return (
		<Card className="card-hover">
			<CardHeader>
				<CardTitle>Payload Retention</CardTitle>
				<CardDescription>
					How long each kind of stored data is kept. Analytics remain intact
					when payloads are pruned.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-section">
				{/* Two columns from `lg` up. The card is full-width on the settings
				    page, so a single column left half the row empty and pushed the
				    footer far below the fold. */}
				<div className="grid grid-cols-1 gap-x-section gap-y-row lg:grid-cols-2">
					<SettingRow
						label="Payloads"
						control={
							<SettingNumberControl
								value={payloadHours}
								unit="hours"
								min={1}
								max={8760}
								disabled={disabled}
								canSave={validPayload}
								onChange={(raw) => setPayloadHours(parseInt(raw || "0", 10))}
								onSave={() => setRetention.mutate({ payloadHours })}
							/>
						}
						value={usageFigure("payloads")}
						summary="Request and response bodies. By far the largest table."
						detail="This is the main lever on database size — every other retention setting below moves a rounding error by comparison."
					/>

					<SettingRow
						label="Payload size cap"
						control={
							<SettingNumberControl
								value={payloadMaxGb}
								unit={payloadMaxGb === 0 ? "GB (off)" : "GB"}
								min={0}
								max={1024}
								step={0.5}
								disabled={disabled}
								canSave={validPayloadMax}
								onChange={(raw) => setPayloadMaxGb(parseFloat(raw || "0"))}
								onSave={() =>
									setRetention.mutate({
										payloadMaxMb: Math.round(payloadMaxGb * 1024),
									})
								}
							/>
						}
						summary="A second limit on top of the window: oldest payloads go first. 0 disables it."
						detail="Counts payload content bytes, not the database file size. The file stays larger than this number and only shrinks as the vacuum returns freed pages to disk."
					/>

					<SettingRow
						label="Requests"
						control={
							<SettingNumberControl
								value={requestDays}
								unit="days"
								min={1}
								max={3650}
								disabled={disabled}
								canSave={validRequests}
								onChange={(raw) => setRequestDays(parseInt(raw || "0", 10))}
								onSave={() => setRetention.mutate({ requestDays })}
							/>
						}
						value={usageFigure("requests")}
						summary="Per-request metadata: tokens, cost, timing, account used."
						detail="This is what every analytics chart and the cost accounting read from. Pruning it removes history from those views permanently."
					/>

					<SettingRow
						label="Usage snapshots"
						control={
							<SettingNumberControl
								value={usageSnapshotDays}
								unit="days"
								min={1}
								max={3650}
								disabled={disabled}
								canSave={validUsageSnapshots}
								onChange={(raw) =>
									setUsageSnapshotDays(parseInt(raw || "0", 10))
								}
								onSave={() => setRetention.mutate({ usageSnapshotDays })}
							/>
						}
						value={usageFigure(
							"usage_snapshots",
							"usage_scoped_snapshots",
							"unified_claim_observations",
						)}
						summary="Per-account limit-usage history behind the Limits graph."
						detail="Covers both the account-wide windows and the per-model-family weekly windows recorded alongside them. The size shown also includes the per-request limit readings, which are kept 90 days regardless of this setting."
					/>

					<SettingRow
						label="Memory history"
						control={
							<SettingNumberControl
								value={memorySnapshotDays}
								unit="days"
								min={1}
								max={3650}
								disabled={disabled}
								canSave={validMemorySnapshots}
								onChange={(raw) =>
									setMemorySnapshotDays(parseInt(raw || "0", 10))
								}
								onSave={() => setRetention.mutate({ memorySnapshotDays })}
							/>
						}
						value={usageFigure("memory_snapshots")}
						summary="Process memory history (RSS + heap) for the System Health graph."
					/>

					<SettingRow
						label="Cache keep-alive"
						control={
							<SettingNumberControl
								value={cacheKeepaliveSnapshotDays}
								unit="days"
								min={1}
								max={3650}
								disabled={disabled}
								canSave={validCacheKeepaliveSnapshots}
								onChange={(raw) =>
									setCacheKeepaliveSnapshotDays(parseInt(raw || "0", 10))
								}
								onSave={() =>
									setRetention.mutate({ cacheKeepaliveSnapshotDays })
								}
							/>
						}
						summary="Keep-alive history for the Analytics Cache Keep-Alive graph."
					/>
				</div>

				<StorageSummary usage={usage} />

				<div className="border-t pt-row">
					<SettingRow
						label="Store payloads"
						control={
							<Switch
								checked={data?.storePayloads ?? true}
								disabled={isLoading || setRetention.isPending}
								onCheckedChange={(checked) =>
									setRetention.mutate({ storePayloads: checked })
								}
							/>
						}
						summary="Save full request/response bodies (conversation text, images)."
						detail="Turning this off reduces database size and memory pressure; token counts, costs and analytics are recorded either way. Left on, payloads can grow the database substantially over time — the two limits above are what bound it."
					/>
				</div>

				<div className="flex flex-wrap items-center gap-item border-t pt-row">
					<Button
						variant="secondary"
						size="sm"
						onClick={() => cleanupNow.mutate()}
						disabled={cleanupNow.isPending}
					>
						{cleanupNow.isPending ? "Cleaning up…" : "Clean up now"}
					</Button>
					{cleanupNow.isError && (
						<p className="flex items-center gap-tight text-xs text-destructive-strong">
							<AlertCircle className="h-3.5 w-3.5 shrink-0" />
							Timed out — on a large database this can take several minutes.
							Check server logs.
						</p>
					)}
					{cleanupNow.data && (
						<p className="text-xs text-muted-foreground">
							Removed{" "}
							<span className="font-medium tabular-nums text-foreground">
								{cleanupNow.data.removedPayloads.toLocaleString()}
							</span>{" "}
							payloads (
							{cleanupNow.data.payloadCutoffIso ? (
								<>
									older than{" "}
									{new Date(cleanupNow.data.payloadCutoffIso).toLocaleString()}
								</>
							) : (
								<>all — storage disabled</>
							)}
							) and{" "}
							<span className="font-medium tabular-nums text-foreground">
								{cleanupNow.data.removedRequests.toLocaleString()}
							</span>{" "}
							requests (older than{" "}
							{new Date(cleanupNow.data.requestCutoffIso).toLocaleString()}).
							The sizes above refresh automatically.
						</p>
					)}
				</div>
			</CardContent>
		</Card>
	);
}

/**
 * Whole-file totals and the state of the measurement behind every figure above.
 *
 * Three distinct states, and they must stay distinct: a scan still running, a
 * scan that failed, and a completed one. The failed case used to render nothing
 * at all, which left the sizes silently absent with no reason given — visually
 * identical to a feature that had broken.
 */
function StorageSummary({
	usage,
}: {
	usage: ReturnType<typeof useStorageUsage>["data"];
}) {
	if (!usage) {
		// No data = the first scan is in flight, or a request hit the 60s client
		// timeout and the poll in `useStorageUsage` is still going. The server
		// keeps scanning across both, so "measuring" is honest here.
		return (
			<p className="text-xs text-muted-foreground">
				Measuring storage usage… the first measurement after a restart scans the
				whole database and can take a couple of minutes.
			</p>
		);
	}
	if (!usage.available) {
		return (
			<p className="flex items-center gap-tight text-xs text-warning-strong">
				<AlertCircle className="h-3.5 w-3.5 shrink-0" />
				Storage measurement unavailable — the scan could not complete. Check
				server logs.
			</p>
		);
	}
	return (
		<div className="flex flex-wrap items-baseline gap-x-group gap-y-tight">
			<div className="flex items-baseline gap-item">
				<span className="text-xs text-muted-foreground">Database file</span>
				<span className="figure-lg">{formatBytes(usage.dbBytes)}</span>
				{usage.walBytes > 0 && (
					<span className="text-xs tabular-nums text-muted-foreground">
						+{formatBytes(usage.walBytes)} WAL
					</span>
				)}
			</div>
			<p className="text-xs text-muted-foreground">
				Sizes are approximate (stored content, excluding index/page overhead)
				and won't sum to the file size · measured{" "}
				{new Date(usage.measuredAt).toLocaleTimeString()}
			</p>
		</div>
	);
}
