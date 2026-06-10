/**
 * Shared fixtures for the dashboard handler tests (analytics/stats worker
 * isolation, range=all). Deliberately NOT named *.test.ts so bun's runner
 * doesn't pick it up as a suite.
 */
import type { DatabaseOperations } from "@clankermux/database";
import type { APIContext } from "../../types";

/** Minimal APIContext around a DatabaseOperations instance. */
export function makeContext(dbOps: DatabaseOperations): APIContext {
	return {
		db: dbOps.getAdapter(),
		config: {} as APIContext["config"],
		dbOps,
	};
}

export interface InsertRequestOptions {
	success?: boolean;
	errorMessage?: string | null;
}

/**
 * Insert a canonical request row (account-1, claude-test, 10 tokens, 5 tok/s).
 * Failures (success: false) get status 500 plus the optional error message.
 */
export async function insertRequest(
	dbOps: DatabaseOperations,
	id: string,
	timestamp: number,
	opts: InsertRequestOptions = {},
): Promise<void> {
	const success = opts.success ?? true;
	await dbOps.getAdapter().run(
		`INSERT INTO requests (
			id, timestamp, method, path, account_used, status_code, success,
			error_message, response_time_ms, failover_attempts, model,
			total_tokens, cost_usd, output_tokens_per_second, input_tokens,
			cache_read_input_tokens, cache_creation_input_tokens, output_tokens,
			billing_type
		) VALUES (?, ?, 'POST', '/v1/messages', 'account-1', ?, ?, ?,
			100, 0, 'claude-test', 10, 0.01, 5, 1, 7, 1, 1, 'plan')`,
		[id, timestamp, success ? 200 : 500, success, opts.errorMessage ?? null],
	);
}
