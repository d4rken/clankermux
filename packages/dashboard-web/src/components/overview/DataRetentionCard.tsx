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
	const [payloadDays, setPayloadDays] = useState<number>(
		data?.payloadDays ?? 3,
	);
	const [requestDays, setRequestDays] = useState<number>(
		data?.requestDays ?? 90,
	);
	const [usageSnapshotDays, setUsageSnapshotDays] = useState<number>(
		data?.usageSnapshotDays ?? 90,
	);
	const [memorySnapshotDays, setMemorySnapshotDays] = useState<number>(
		data?.memorySnapshotDays ?? 14,
	);

	useEffect(() => {
		if (typeof data?.payloadDays === "number") setPayloadDays(data.payloadDays);
		if (typeof data?.requestDays === "number") setRequestDays(data.requestDays);
		if (typeof data?.usageSnapshotDays === "number")
			setUsageSnapshotDays(data.usageSnapshotDays);
		if (typeof data?.memorySnapshotDays === "number")
			setMemorySnapshotDays(data.memorySnapshotDays);
	}, [
		data?.payloadDays,
		data?.requestDays,
		data?.usageSnapshotDays,
		data?.memorySnapshotDays,
	]);

	const disabled = isLoading || setRetention.isPending;
	const validPayload =
		Number.isFinite(payloadDays) && payloadDays >= 1 && payloadDays <= 365;
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
			<CardContent className="space-y-3">
				<div>
					<div className="flex items-center gap-2">
						<div className="flex items-center gap-2">
							<span className="text-sm font-medium w-28">Payloads</span>
							<Input
								type="number"
								min={1}
								max={365}
								value={payloadDays}
								onChange={(e) =>
									setPayloadDays(parseInt(e.target.value || "0", 10))
								}
								className="w-24"
							/>
							<span className="text-sm text-muted-foreground">days</span>
						</div>
						<Button
							size="sm"
							disabled={disabled || !validPayload}
							onClick={() => setRetention.mutate({ payloadDays })}
						>
							Save
						</Button>
					</div>
					{usageHint("payloads")}
				</div>

				<div className="pt-2">
					<div className="flex items-center gap-2">
						<div className="flex items-center gap-2">
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
					<div className="flex items-center gap-2">
						<div className="flex items-center gap-2">
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
					<div className="flex items-center gap-2">
						<div className="flex items-center gap-2">
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
						How long process memory history (RSS + heap) is kept for the
						Overview Memory Usage graph.
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
						<p className="text-xs text-amber-500 mt-0.5">
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

				<div className="pt-1 flex items-center gap-2">
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
					<p className="text-xs text-destructive">
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
