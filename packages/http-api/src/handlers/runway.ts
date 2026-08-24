import { worstKeyRunway } from "@clankermux/core";
import type { DatabaseOperations } from "@clankermux/database";
import { jsonResponse } from "@clankermux/http-common";
import type { RunwayResponse } from "@clankermux/types";
import { computeRunwayScan } from "../services/runway-scan";

/**
 * `GET /api/runway` — the quota runway per API key, plus the account evidence it
 * was computed from.
 *
 * The scan itself lives in `services/runway-scan.ts`, because `GET
 * /public/v1/runway` serves a de-identified projection of the SAME scan and a
 * second implementation is how a widget comes to disagree with the dashboard
 * about when the quota runs out. Everything this handler still owns is what
 * only the MANAGEMENT surface may say: the per-key rows in full (`keyName`,
 * `pin`, `eligibleAccountIds`) and which key is worst.
 *
 * QUOTA, not availability: pauses, rate-limit cooldowns, usage throttling and
 * the provider-overload breaker are deliberately not read. Copy built on this
 * must say "quota", never "available".
 *
 * Runs INLINE rather than through a dashboard read worker: the worker exists
 * for multi-second `requests` scans and cannot see `usageCache`, which is
 * main-thread-only. There is deliberately no response TTL cache.
 *
 * Authentication is out of scope — `/api/*` is unauthenticated for all methods
 * by design, and this exposes nothing `/api/accounts` does not already expose.
 */
export function createRunwayHandler(
	dbOps: DatabaseOperations,
): () => Promise<Response> {
	return async (): Promise<Response> => {
		const scan = await computeRunwayScan(dbOps);
		const worst = worstKeyRunway(scan.keys, scan.generatedAt);

		const response: RunwayResponse = {
			generatedAt: scan.generatedAt,
			horizonMs: scan.horizonMs,
			worstKeyId: worst?.keyId ?? null,
			keys: scan.keys,
			accounts: scan.accounts,
		};

		return jsonResponse(response);
	};
}
