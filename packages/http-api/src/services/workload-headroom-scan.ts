import {
	computeWorkloadHeadroom,
	type WorkloadHeadroomRow,
} from "@clankermux/core";
import type { DatabaseOperations } from "@clankermux/database";
import { computeRunwayScan } from "./runway-scan";

/**
 * Per-workload headroom: how much more (or less) load each servable class and
 * each scoped model family can take.
 *
 * THE SAME SCAN as `/api/runway` and `/public/v1/runway`, viewed along a
 * different axis. `computeRunwayScan` already resolves every account's usage
 * through the freshness tiers, restores Codex readings, regresses the
 * predictions and assembles the credit banks; this reuses the `sources` it
 * produced rather than repeating any of it. Two scans of the same pool at the
 * same instant that disagree is the failure mode the runway service exists to
 * prevent, and adding an axis must not reintroduce it.
 *
 * The pool-level figure stays where it is computed, on the runway resource.
 * This resource never restates it — the rows here are per class and per family,
 * which are different measurements, not a second copy of that one.
 */
export interface WorkloadHeadroomSnapshot {
	/** The instant the whole scan describes. */
	generatedAtMs: number;
	/** The horizon the scan modelled, so no consumer hardcodes 14 days. */
	horizonMs: number;
	rows: WorkloadHeadroomRow[];
}

export async function computeWorkloadHeadroomScan(
	dbOps: DatabaseOperations,
): Promise<WorkloadHeadroomSnapshot> {
	const scan = await computeRunwayScan(dbOps);
	return {
		generatedAtMs: scan.generatedAt,
		horizonMs: scan.horizonMs,
		// `scan.generatedAt` rather than a fresh clock read: every row must be
		// projected from the instant the readings were resolved at, or a row could
		// state a runway measured against a different "now" than the one the
		// response is stamped with.
		rows: computeWorkloadHeadroom(
			scan.sources,
			scan.generatedAt,
			scan.horizonMs,
		),
	};
}
