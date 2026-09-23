import type { DatabaseOperations } from "@clankermux/database";
import { jsonResponse } from "@clankermux/http-common";
import {
	SDK_BRIDGE_TURN_VIEW_MAX_INNER,
	type SdkBridgeTurnView,
} from "@clankermux/types";

/**
 * `GET /api/sdk-bridge-turns/:id`. `id` is a turn id, or a leg id: the
 * request id a client got for an outer request, which has no `requests` row.
 */
export function createSdkBridgeTurnHandler(dbOps: DatabaseOperations) {
	return async (id: string): Promise<Response> => {
		const turns = dbOps.sdkBridgeTurns;
		let matchedLegId: string | null = null;
		let detail = await turns.getTurnWithLegs(id);
		if (!detail) {
			const turnId = await turns.findTurnIdByLeg(id);
			if (turnId) {
				detail = await turns.getTurnWithLegs(turnId);
				matchedLegId = id;
			}
		}
		if (!detail)
			return jsonResponse({ error: "SDK bridge turn not found" }, 404);
		const [innerRequests, account] = await Promise.all([
			turns.listInnerRequests(detail.turn.id, SDK_BRIDGE_TURN_VIEW_MAX_INNER),
			detail.turn.accountId
				? dbOps.getAccount(detail.turn.accountId)
				: Promise.resolve(null),
		]);
		const view: SdkBridgeTurnView = {
			...detail,
			accountName: account?.name ?? null,
			innerRequests,
			prunedInnerCalls: Math.max(
				0,
				detail.turn.innerCallCount - detail.inner.requestCount,
			),
			matchedLegId,
		};
		return jsonResponse(view);
	};
}
