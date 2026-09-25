import type { DatabaseOperations } from "@clankermux/database";
import { jsonResponse } from "@clankermux/http-common";
import type { APIContext } from "../types";
import { createIsolatedStatsHandler } from "./analytics-runner";

/**
 * Create a stats handler.
 *
 * Dispatches through the shared read-only dashboard worker (kind "stats")
 * so the synchronous bun:sqlite stats queries never block the main event
 * loop. The actual query logic lives in stats-direct.ts.
 */
export function createStatsHandler(context: APIContext) {
	const isolatedHandler = createIsolatedStatsHandler(context);

	return (url: URL): Promise<Response> => {
		return isolatedHandler(url.searchParams);
	};
}

/**
 * Create a stats reset handler
 */
export function createStatsResetHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		const adapter = dbOps.getAdapter();
		// Clear request history
		await adapter.run("DELETE FROM requests");
		// SDK bridge turns are request history too; their legs cascade. Open
		// turns and those a released park owns are live state, not history.
		await adapter.run(
			`DELETE FROM sdk_bridge_turns WHERE status NOT IN ('running','released')
			AND NOT EXISTS (SELECT 1 FROM sdk_bridge_released_parks p
				WHERE p.turn_id = sdk_bridge_turns.id)`,
		);
		// Reset account statistics
		await adapter.run(
			"UPDATE accounts SET request_count = 0, session_request_count = 0",
		);

		return jsonResponse({
			success: true,
			message: "Statistics reset successfully",
		});
	};
}
