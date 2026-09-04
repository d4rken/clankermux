import type { Config } from "@clankermux/config";
import {
	computePacingFromAccounts,
	type PacingSnapshot,
} from "@clankermux/core";
import type { DatabaseOperations } from "@clankermux/database";
import type { LoadBalancingStrategy } from "@clankermux/types";
import { listAccountResponses } from "../handlers/accounts";

/**
 * The database half of the pacing scan.
 *
 * Everything that decides a FIGURE lives in `@clankermux/core/pacing-scan`,
 * because the dashboard computes nothing of its own any more but still needs
 * the types, and it cannot import this package. What is left here is the one
 * part that genuinely cannot move: reading the accounts.
 *
 * The read is the FULL account array `/api/accounts` serves — session stats,
 * snapshots, prediction regressions, duplicate detection and all — so the
 * pacing figures describe exactly the bars drawn beside them. The scan reads
 * about a dozen of those ~40 fields and pays for every one. Deliberate: a
 * narrowed second read would reintroduce drift in exactly the subtle places
 * (when a reading may carry a prediction, how `usageAsOfIso` is stamped, which
 * tier a Codex reading resolves from), which is what this whole change set
 * exists to remove. The public reader's TTL memo is what stops an anonymous
 * poll loop deciding how often it is paid for.
 */
export async function computePacingScan(
	dbOps: DatabaseOperations,
	config: Config,
	getStrategy?: () => LoadBalancingStrategy | null,
	now: number = Date.now(),
): Promise<PacingSnapshot> {
	const accounts = await listAccountResponses(dbOps, config, getStrategy);
	return computePacingFromAccounts(accounts, now);
}
