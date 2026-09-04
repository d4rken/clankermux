import type { Config } from "@clankermux/config";
import type { PacingSnapshot } from "@clankermux/core";
import type { DatabaseOperations } from "@clankermux/database";
import { jsonResponse } from "@clankermux/http-common";
import type { LoadBalancingStrategy } from "@clankermux/types";
import { computePacingScan } from "../services/pacing-scan";

/**
 * `GET /api/pacing` — how fast the pool is spending its weekly budget, and what
 * the 5-hour limit is holding back right now.
 *
 * The scan itself lives in `services/pacing-scan.ts`, because
 * `GET /public/v1/pacing` serves a de-identified projection of the SAME scan and
 * a second implementation is how a widget comes to disagree with the dashboard
 * about whether a pace is sustainable. Everything this handler adds is what only
 * the MANAGEMENT surface may say: account names beside every figure.
 *
 * NOT the answer to "should I run more work" on its own. The per-class burn
 * ratio here is a per-account reading — a pool of staggered accounts with
 * failover routinely shows several accounts over pace while the pool as a whole
 * has room. The signed pool-level figure is `/api/runway`'s pace headroom, and
 * it deliberately is not duplicated onto this resource.
 *
 * Runs INLINE and with no response cache, matching `/api/runway`: the dashboard
 * read worker cannot see `usageCache`, which is main-thread-only.
 *
 * Authentication is out of scope — `/api/*` is unauthenticated for all methods
 * by design, and this exposes nothing `/api/accounts` does not already expose.
 */
export function createPacingHandler(
	dbOps: DatabaseOperations,
	config: Config,
	getStrategy?: () => LoadBalancingStrategy | null,
): () => Promise<Response> {
	return async (): Promise<Response> => {
		const response: PacingSnapshot = await computePacingScan(
			dbOps,
			config,
			getStrategy,
		);
		return jsonResponse(response);
	};
}
