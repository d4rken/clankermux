/**
 * An SDK bridge health payload with every section populated: released and
 * running turns, side requests, a deleted and a missing account, and a
 * percentile with no samples.
 *
 * Deliberately NOT named *.test.ts so bun's runner doesn't pick it up.
 */
import type { SdkBridgeHealthResponse } from "@clankermux/types";

function split(
	key: string | null,
	name: string | null,
	over: Partial<SdkBridgeHealthResponse["byHarness"][number]> = {},
) {
	return {
		key,
		name,
		total: 0,
		completed: 0,
		failures: 0,
		finished: 0,
		rejected: 0,
		aborted: 0,
		innerCalls: 0,
		costUsd: 0,
		...over,
	};
}

export function healthFixture(
	over: Partial<SdkBridgeHealthResponse> = {},
): SdkBridgeHealthResponse {
	return {
		range: "24h",
		windowStartsAt: 0,
		windowEndsAt: 1,
		total: 14,
		byStatus: {
			running: 1,
			released: 2,
			completed: 6,
			failed: 1,
			aborted: 1,
			timed_out: 1,
			expired: 1,
			shutdown: 0,
			rejected: 2,
		},
		byKind: { turn: 12, side_request: 2 },
		failureRate: { failures: 2, finished: 8, rate: 0.25 },
		errors: [
			{
				status: "rejected",
				errorType: "invalid_request_error",
				httpStatus: 400,
				count: 2,
			},
			{
				status: "failed",
				errorType: "overloaded_error",
				httpStatus: 529,
				count: 1,
			},
		],
		timings: {
			spawnMs: { samples: 9, p50: 1_200, p95: 3_400 },
			firstEventMs: { samples: 8, p50: 2_000, p95: 5_000 },
			durationMs: { samples: 0, p50: null, p95: null },
		},
		toolRounds: { samples: 7, p50: 2, p95: 6, total: 21 },
		byHistoryMode: {
			fresh: 5,
			resume: 4,
			resume_extended: 2,
			rebuild_transcript: 0,
			rebuild_flattened: 3,
		},
		byRebuildReason: {
			continuation: 2,
			compaction: 0,
			edit: 1,
			unknown: 0,
			account_change: 0,
			dead_continuation: 2,
		},
		byHarness: [
			split("pi", null, {
				total: 12,
				completed: 6,
				failures: 2,
				finished: 8,
				innerCalls: 31,
				costUsd: 1.5,
			}),
			split("codex", null, { total: 2, rejected: 2 }),
		],
		byAccount: [
			split("acct-a", "Claude-a", {
				total: 10,
				completed: 6,
				failures: 1,
				finished: 7,
				innerCalls: 25,
				costUsd: 1.25,
			}),
			split("acct-gone", null, { total: 2, failures: 1, finished: 1 }),
			split("acct-b", "Claude-b", { innerCalls: 6, costUsd: 0.25 }),
			split(null, null, { total: 2, rejected: 2 }),
		],
		inner: {
			requestCount: 31,
			inputTokens: 12_000,
			outputTokens: 3_400,
			cacheReadInputTokens: 250_000,
			cacheCreationInputTokens: 0,
			costUsd: 1.5,
		},
		recentFailures: [
			{
				id: "turn-rejected-1",
				kind: "turn",
				status: "rejected",
				startedAt: 1_700_000_000_000,
				httpStatus: 400,
				errorType: "invalid_request_error",
				errorMessage: "pi-head-v1: the forwarded system prompt was refused",
				clientHarness: "codex",
				model: "claude-opus-5-5",
			},
			{
				id: "turn-failed-1",
				kind: "side_request",
				status: "failed",
				startedAt: 1_699_999_000_000,
				httpStatus: 529,
				errorType: "overloaded_error",
				errorMessage: null,
				clientHarness: "pi",
				model: "claude-opus-5-5",
			},
		],
		...over,
	};
}
