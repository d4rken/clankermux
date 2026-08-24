import { QuotaDriftResultRepository } from "@clankermux/database";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import type { QuotaDriftResponse } from "@clankermux/types";
import type { APIContext } from "../types";

const log = new Logger("QuotaDriftHandler");

/**
 * Direct (in-process) `/api/analytics/quota-drift` implementation.
 *
 * A single-row read: the analysis itself is precomputed by the scheduler (see
 * apps/server/src/quota-drift-scheduler.ts) and stored as one JSON blob, so
 * this handler only picks the newest row and hands it over verbatim. Nothing
 * here re-derives or re-shapes the payload — the wire contract is written by
 * the pass that produced it.
 */
export interface QuotaDriftSources {
	getLatest(): Promise<{ computedAt: number; payload: string } | null>;
}

/**
 * The answer when no pass has completed yet.
 *
 * EXPLICIT rather than an empty `ready` payload: a panel handed
 * `{cohorts: []}` renders a blank chart, which reads as "measured, and nothing
 * is drifting" — the opposite of "we have not measured yet". The scheduler runs
 * shortly after boot, so this is what the first minute of a fresh deployment
 * (or a database whose results were pruned) legitimately looks like.
 */
export const COMPUTING_RESPONSE: QuotaDriftResponse = {
	status: "computing",
	computedAt: null,
	computeMs: null,
	cohorts: [],
};

export function createQuotaDriftHandler(context: APIContext) {
	const repo = new QuotaDriftResultRepository(context.dbOps.getAdapter());
	return createQuotaDriftHandlerFromSources({
		getLatest: () => repo.getLatest(),
	});
}

export function createQuotaDriftHandlerFromSources(sources: QuotaDriftSources) {
	return async (_params: URLSearchParams): Promise<Response> => {
		try {
			const row = await sources.getLatest();
			if (!row) return jsonResponse(COMPUTING_RESPONSE);

			let payload: QuotaDriftResponse;
			try {
				payload = JSON.parse(row.payload) as QuotaDriftResponse;
			} catch (error) {
				// A corrupt blob is not a server fault the user can act on, and it
				// self-heals on the next pass. Report it as "computing" rather than
				// 500-ing a dashboard panel over a cache row.
				log.warn(`Discarding unreadable quota-drift payload: ${error}`);
				return jsonResponse(COMPUTING_RESPONSE);
			}

			// The stored blob owns `computedAt`, but the row's key is the
			// authoritative one — they are written together, and trusting the key
			// keeps a hand-inserted or half-migrated blob from claiming a time.
			return jsonResponse({
				...payload,
				status: "ready",
				computedAt: row.computedAt,
			} satisfies QuotaDriftResponse);
		} catch (error) {
			log.error("Failed to read quota-drift result:", error);
			return errorResponse(
				InternalServerError("Failed to fetch quota drift data"),
			);
		}
	};
}
