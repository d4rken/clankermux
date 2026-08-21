import { useState } from "react";
import { useMemoryHistory } from "../hooks/queries";
import { MemoryUsageChart } from "./overview/MemoryUsageChart";
import { StorageIntegritySection } from "./overview/StorageIntegrity";
import { SystemStatus } from "./overview/SystemStatus";
import { RecentErrorsCard } from "./overview/system-status/RecentErrorsCard";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";

/**
 * System Health page: the detailed diagnostics that used to sit at the bottom
 * of the Overview. The Overview keeps only the one-row summary strip, which
 * links here.
 *
 * Renders no heading of its own — App renders `<h1>{currentRoute.title}</h1>`
 * for every route.
 *
 * Errors come second, not last: arriving from the Overview strip usually means
 * having just seen an error count there, and burying the list under a chart
 * would be a poor handoff. Storage integrity trails because it's the least
 * time-sensitive block — a background check plus two rarely-pressed buttons.
 * Note the status card above does NOT subsume it: the server's health rollup
 * deliberately excludes integrity (so corruption can't 503 `/health`), and
 * `statusSummary` only mentions it when the proxy is already unhealthy.
 */
export function SystemTab() {
	// 7d by default so the leak-trend view is the landing state.
	const [memoryRange, setMemoryRange] = useState("7d");
	const { data: memoryHistory, isLoading: memoryLoading } =
		useMemoryHistory(memoryRange);

	return (
		<div className="space-y-section">
			<SystemStatus />

			<RecentErrorsCard />

			<MemoryUsageChart
				memoryHistory={memoryHistory}
				loading={memoryLoading}
				range={memoryRange}
				onRangeChange={setMemoryRange}
			/>

			<Card>
				<CardHeader>
					<CardTitle>Storage Integrity</CardTitle>
					<CardDescription>
						Periodic SQLite integrity check (quick + full).
					</CardDescription>
				</CardHeader>
				<CardContent>
					<StorageIntegritySection />
				</CardContent>
			</Card>
		</div>
	);
}
