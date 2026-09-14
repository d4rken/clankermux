import { beforeEach, describe, expect, it } from "bun:test";
import type { DatabaseOperations } from "@clankermux/database";
import {
	clearCodexPayloadScanMemo,
	getCachedOrPersistedCodexUsage,
} from "../resolve-codex-usage";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * A stored `request_payloads` row, shaped the way the legacy recovery scan
 * reads it: the response headers of one retained request plus its status.
 */
function payloadRow(
	headers: Record<string, string>,
	status: number,
	timestampMs: number,
): { json: string; timestamp: number } {
	return {
		json: JSON.stringify({
			response: { headers, status },
			meta: { timestamp: timestampMs },
		}),
		timestamp: timestampMs,
	};
}

function makeDb(
	rows: Array<{ json: string; timestamp: number }>,
): ReturnType<DatabaseOperations["getAdapter"]> {
	return {
		query: async () => rows,
		get: async () => null,
	} as unknown as ReturnType<DatabaseOperations["getAdapter"]>;
}

/**
 * A read-only resolution with no live cache entry and no persisted column, so
 * the stored-payload scan is the only channel that can answer. `seedCache:
 * false` keeps the shared `usageCache` singleton out of these tests entirely.
 */
function resolveFromPayloads(
	accountId: string,
	rows: Array<{ json: string; timestamp: number }>,
) {
	return getCachedOrPersistedCodexUsage(
		makeDb(rows),
		accountId,
		"codex-account",
		null,
		null,
		null,
		Date.now(),
		{ seedCache: false },
	);
}

describe("getCachedOrPersistedCodexUsage — stored-payload recovery", () => {
	beforeEach(() => {
		clearCodexPayloadScanMemo();
	});

	it("recovers nothing from a 200 payload whose window reports no used-percent", async () => {
		const resetSec = Math.floor((Date.now() + 3 * DAY_MS) / 1000);
		const recovered = await resolveFromPayloads("codex-no-percent", [
			payloadRow(
				{
					"content-type": "application/json",
					"x-codex-primary-window-minutes": "10080",
					"x-codex-primary-reset-at": String(resetSec),
				},
				200,
				Date.now() - HOUR_MS,
			),
		]);

		// Identical to a payload that carries no Codex headers at all: a reset
		// without a percentage is not a reading.
		const control = await resolveFromPayloads("codex-no-headers", [
			payloadRow(
				{ "content-type": "application/json" },
				200,
				Date.now() - HOUR_MS,
			),
		]);

		expect(recovered).toEqual(control);
		expect(recovered.data).toBeNull();
		expect(recovered.source).toBeNull();
	});

	it("recovers a 100% weekly window from a stored 429 payload with the same headers", async () => {
		const resetSec = Math.floor((Date.now() + 3 * DAY_MS) / 1000);
		const recovered = await resolveFromPayloads("codex-429", [
			payloadRow(
				{
					"content-type": "application/json",
					"x-codex-primary-window-minutes": "10080",
					"x-codex-primary-reset-at": String(resetSec),
				},
				429,
				Date.now() - HOUR_MS,
			),
		]);

		expect(recovered.source).toBe("payload");
		const data = recovered.data;
		if (data === null || !("seven_day" in data)) {
			throw new Error(
				`expected Anthropic-shaped usage data with a weekly window, got ${JSON.stringify(data)}`,
			);
		}
		expect(data.seven_day?.utilization).toBe(100);
		expect(data.seven_day?.resets_at).toBe(
			new Date(resetSec * 1000).toISOString(),
		);
	});
});
