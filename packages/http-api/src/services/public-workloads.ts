import { computeWeeklyWorkloads } from "@clankermux/core";
import type { DatabaseOperations } from "@clankermux/database";
import { createPublicReadMemo } from "./public-read-memo";
import { computeRunwayScan } from "./runway-scan";

/** Weekly scan is independent from the 5-second availability cache. No provider I/O. */
export function createPublicWeeklyReader(dbOps: DatabaseOperations) {
	return createPublicReadMemo(
		async () => {
			const scan = await computeRunwayScan(dbOps);
			return {
				computedAtMs: scan.generatedAt,
				workloads: computeWeeklyWorkloads(scan.sources, scan.generatedAt),
			};
		},
		{ computedAtMs: (s) => s.computedAtMs },
	);
}
