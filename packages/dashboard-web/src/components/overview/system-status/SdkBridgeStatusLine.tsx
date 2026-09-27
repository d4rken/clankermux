import type { SdkBridgeStatus } from "@clankermux/types";
import { formatBytes } from "@clankermux/ui-common";
import { Bot } from "lucide-react";

function availabilityText(status: SdkBridgeStatus): string {
	const { availability } = status;
	if (availability.state === "available") return "Available";
	if (availability.state === "shutting_down") return "Shutting down";
	return `Unavailable: ${availability.reason}`;
}

/** The process's own counters, which start at zero on every restart. */
function sinceRestart(status: SdkBridgeStatus): string | null {
	const { counters } = status;
	const rejected = Object.values(counters.rejected).reduce((n, c) => n + c, 0);
	const any = counters.turnsFailed + rejected + counters.rebuilds > 0;
	if (status.availability.state !== "available" && !any) return null;
	return `Since restart: ${counters.turnsFailed} not completed · ${rejected} rejected · ${counters.rebuilds} rebuilds`;
}

/**
 * One line for the Claude Agent SDK bridge, which serves /wire/openai clients
 * on official Anthropic accounts.
 */
export function SdkBridgeStatusLine({ status }: { status: SdkBridgeStatus }) {
	const available = status.availability.state === "available";
	const parts = available
		? [
				`${status.live} live`,
				`${status.parked} parked`,
				...(status.releasedParks > 0
					? [`${status.releasedParks} released`]
					: []),
				`cap ${status.cap}`,
				...(status.peakRssBytes != null
					? [`peak ${formatBytes(status.peakRssBytes)}`]
					: []),
			]
		: [];
	const counts = sinceRestart(status);
	return (
		<div
			className="flex flex-wrap items-center gap-item text-sm"
			data-slot="sdk-bridge-status"
		>
			<span className="flex items-center gap-item text-muted-foreground">
				<Bot className="h-4 w-4" />
				Agent SDK bridge
			</span>
			<span
				className={
					available ? "font-medium" : "font-medium text-warning-strong"
				}
			>
				{availabilityText(status)}
			</span>
			{parts.length > 0 && (
				<span className="text-muted-foreground tabular-nums">
					{parts.join(" · ")}
				</span>
			)}
			{counts && (
				<span className="text-muted-foreground tabular-nums">{counts}</span>
			)}
			{available && status.releaseBlocked && (
				<span className="text-warning-strong">
					Not releasing parked turns: {status.releaseBlocked}
				</span>
			)}
		</div>
	);
}
