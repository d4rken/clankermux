import { formatBytes } from "@clankermux/ui-common";
import { useEffect, useState } from "react";
import {
	useCleanupNow,
	useRetention,
	useSetRetention,
	useStorageUsage,
} from "../../hooks/queries";
import { Button } from "../ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Input } from "../ui/input";
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
	const usageByKey = new Map((usage?.types ?? []).map((t) => [t.key, t]));
	const usageHint = (
		key: "payloads" | "requests" | "usage_snapshots" | "memory_snapshots",
	) => {
		if (!usage?.available) return null;
		const t = usageByKey.get(key);
		if (!t) return null;
		return (
			<p className="text-xs text-muted-foreground tabular-nums mt-1">
				~{formatBytes(t.approxBytes)} · {t.rowCount.toLocaleString()} rows
			</p>
		);
	};

	return (
		<Card className="card-hover">
			<CardHeader>
				<CardTitle>Payload Retention</CardTitle>
				<CardDescription>
					Automatically delete request/response payloads older than this window.
					Analytics remain intact.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-row">
				<div>
					<div className="flex items-center gap-item">
						<div className="flex items-center gap-item">
							<span className="text-sm font-medium w-28">Payloads</span>
							<Input
								type="number"
								min={1}
								max={8760}
								value={payloadHours}
								onChange={(e) =>
									setPayloadHours(parseInt(e.target.value || "0", 10))
								}
								className="w-24"
							/>
							<span className="text-sm text-muted-foreground">hours</span>
						</div>
						<Button
							size="sm"
							disabled={disabled || !validPayload}
							onClick={() => setRetention.mutate({ payloadHours })}
						>
							Save
						</Button>
					</div>
					{usageHint("payloads")}
					<p className="text-xs text-muted-foreground mt-1">
						Payloads are by far the largest table — this is the main lever on
						database size.
					</p>
				</div>

				<div className="pt-2">
					<div className="flex items-center gap-item">
						<div className="flex items-center gap-item">
							<span className="text-sm font-medium w-28">Payload size cap</span>
							<Input
								type="number"
								min={0}
								max={1024}
								step={0.5}
								value={payloadMaxGb}
								onChange={(e) =>
									setPayloadMaxGb(parseFloat(e.target.value || "0"))
								}
								className="w-24"
							/>
							<span className="text-sm text-muted-foreground">
								GB{payloadMaxGb === 0 ? " (off)" : ""}
							</span>
						</div>
						<Button
							size="sm"
							disabled={disabled || !validPayloadMax}
							onClick={() =>
								setRetention.mutate({
									payloadMaxMb: Math.round(payloadMaxGb * 1024),
								})
							}
						>
							Save
						</Button>
					</div>
					<p className="text-xs text-muted-foreground mt-1">
						Second limit on top of the window above: once stored payloads exceed
						this, the oldest are deleted until they fit. 0 disables it. Counts
						payload content bytes, <strong>not the database file size</strong> —
						the file stays larger and only shrinks as the vacuum returns freed
						pages to disk.
					</p>
				</div>

				<div className="pt-2">
					<div className="flex items-center gap-item">
						<div className="flex items-center gap-item">
							<span className="text-sm font-medium w-28">Requests</span>
							<Input
								type="number"
								min={1}
								max={3650}
								value={requestDays}
								onChange={(e) =>
									setRequestDays(parseInt(e.target.value || "0", 10))
								}
								className="w-24"
							/>
							<span className="text-sm text-muted-foreground">days</span>
						</div>
						<Button
							size="sm"
							disabled={disabled || !validRequests}
							onClick={() => setRetention.mutate({ requestDays })}
						>
							Save
						</Button>
					</div>
					{usageHint("requests")}
				</div>

				<div className="pt-2">
					<div className="flex items-center gap-item">
						<div className="flex items-center gap-item">
							<span className="text-sm font-medium w-28">Usage snapshots</span>
							<Input
								type="number"
								min={1}
								max={3650}
								value={usageSnapshotDays}
								onChange={(e) =>
									setUsageSnapshotDays(parseInt(e.target.value || "0", 10))
								}
								className="w-24"
							/>
							<span className="text-sm text-muted-foreground">days</span>
						</div>
						<Button
							size="sm"
							disabled={disabled || !validUsageSnapshots}
							onClick={() => setRetention.mutate({ usageSnapshotDays })}
						>
							Save
						</Button>
					</div>
					{usageHint("usage_snapshots")}
					<p className="text-xs text-muted-foreground mt-1">
						How long per-account limit-usage history is kept for the Limits
						graph.
					</p>
				</div>

				<div className="pt-2">
					<div className="flex items-center gap-item">
						<div className="flex items-center gap-item">
							<span className="text-sm font-medium w-28">Memory history</span>
							<Input
								type="number"
								min={1}
								max={3650}
								value={memorySnapshotDays}
								onChange={(e) =>
									setMemorySnapshotDays(parseInt(e.target.value || "0", 10))
								}
								className="w-24"
							/>
							<span className="text-sm text-muted-foreground">days</span>
						</div>
						<Button
							size="sm"
							disabled={disabled || !validMemorySnapshots}
							onClick={() => setRetention.mutate({ memorySnapshotDays })}
						>
							Save
						</Button>
					</div>
					{usageHint("memory_snapshots")}
					<p className="text-xs text-muted-foreground mt-1">
						How long process memory history (RSS + heap) is kept for the System
						Health Memory Usage graph.
					</p>
				</div>

				<div className="pt-2">
					<div className="flex items-center gap-item">
						<div className="flex items-center gap-item">
							<span className="text-sm font-medium w-28">
								Cache keep-alive snapshots
							</span>
							<Input
								type="number"
								min={1}
								max={3650}
								value={cacheKeepaliveSnapshotDays}
								onChange={(e) =>
									setCacheKeepaliveSnapshotDays(
										parseInt(e.target.value || "0", 10),
									)
								}
								className="w-24"
							/>
							<span className="text-sm text-muted-foreground">days</span>
						</div>
						<Button
							size="sm"
							disabled={disabled || !validCacheKeepaliveSnapshots}
							onClick={() =>
								setRetention.mutate({ cacheKeepaliveSnapshotDays })
							}
						>
							Save
						</Button>
					</div>
					<p className="text-xs text-muted-foreground mt-1">
						How long cache keep-alive history is kept for the Analytics Cache
						Keep-Alive graph.
					</p>
				</div>

				{usage?.available && (
					<p className="text-xs text-muted-foreground pt-1">
						Sizes are approximate (stored content, excluding index/page
						overhead) and won't sum to the file size. Database file is{" "}
						{formatBytes(usage.dbBytes)}
						{usage.walBytes > 0 ? ` (+${formatBytes(usage.walBytes)} WAL)` : ""}{" "}
						on disk · measured {new Date(usage.measuredAt).toLocaleTimeString()}
						.
					</p>
				)}

				<div className="flex items-center justify-between pt-2 pb-1">
					<div>
						<p className="text-sm font-medium">Store message payloads</p>
						<p className="text-xs text-muted-foreground">
							Stores full request/response bodies (conversation text, images) in
							the database. Disable to reduce database size and lower memory
							pressure — token counts, costs, and analytics are always saved
							regardless.
						</p>
						<p className="text-xs text-warning-strong mt-0.5">
							Warning: storing payloads can significantly grow the database size
							over time.
						</p>
					</div>
					<Switch
						checked={data?.storePayloads ?? true}
						disabled={isLoading || setRetention.isPending}
						onCheckedChange={(checked) =>
							setRetention.mutate({ storePayloads: checked })
						}
					/>
				</div>

				<div className="pt-1 flex items-center gap-item">
					<Button
						variant="secondary"
						size="sm"
						onClick={() => cleanupNow.mutate()}
						disabled={cleanupNow.isPending}
					>
						{cleanupNow.isPending ? "Cleaning up…" : "Clean up now"}
					</Button>
				</div>

				{cleanupNow.isError && (
					<p className="text-xs text-destructive-strong">
						Operation timed out — for large databases this may take several
						minutes. Check server logs.
					</p>
				)}

				{cleanupNow.data && (
					<p className="text-xs text-muted-foreground">
						Removed {cleanupNow.data.removedPayloads} payloads (
						{cleanupNow.data.payloadCutoffIso ? (
							<>
								older than{" "}
								{new Date(cleanupNow.data.payloadCutoffIso).toLocaleString()}
							</>
						) : (
							<>all — storage disabled</>
						)}
						) and {cleanupNow.data.removedRequests} requests (older than{" "}
						{new Date(cleanupNow.data.requestCutoffIso).toLocaleString()}). The
						sizes above refresh automatically.
					</p>
				)}
			</CardContent>
		</Card>
	);
}
