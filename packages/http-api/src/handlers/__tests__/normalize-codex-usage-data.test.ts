import { describe, expect, it } from "bun:test";
import type { UsageData } from "@clankermux/providers";
import type { AnthropicLimitEntry } from "@clankermux/types";
import { normalizeCodexUsageData } from "../accounts";

const future = () =>
	new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const past = () => new Date(Date.now() - 60 * 1000).toISOString();

function scopedLimit(
	displayName: string,
	resets_at: string | null,
	percent = 0,
): AnthropicLimitEntry {
	return {
		kind: "weekly_scoped",
		group: "codex",
		percent,
		resets_at,
		scope: { model: { id: displayName, display_name: displayName } },
		is_active: true,
	};
}

describe("normalizeCodexUsageData limits handling", () => {
	it("drops limits entries with a past reset and keeps future ones", () => {
		const usage: UsageData = {
			five_hour: { utilization: 0, resets_at: null },
			seven_day: { utilization: 21, resets_at: future() },
			limits: [
				scopedLimit("Live-Model", future(), 5),
				scopedLimit("Spent-Model", past(), 100),
			],
		};

		const normalized = normalizeCodexUsageData(usage);

		expect(normalized).not.toBeNull();
		expect(normalized?.limits).toHaveLength(1);
		expect(normalized?.limits?.[0].scope?.model?.display_name).toBe(
			"Live-Model",
		);
	});

	it("passes a fully-future limits array through unchanged", () => {
		const reset = future();
		const usage: UsageData = {
			five_hour: { utilization: 0, resets_at: null },
			seven_day: { utilization: 21, resets_at: future() },
			limits: [scopedLimit("GPT-5.3-Codex-Spark", reset, 3)],
		};

		const normalized = normalizeCodexUsageData(usage);

		expect(normalized?.limits).toEqual([
			scopedLimit("GPT-5.3-Codex-Spark", reset, 3),
		]);
	});

	it("survives when both flat windows are stale but a scoped limit is still live", () => {
		// Codex's 5h window is permanently empty and the account-wide weekly reset
		// can lapse in a stale snapshot; a per-model (Spark) weekly with its own
		// future reset must keep the payload alive rather than collapsing to null.
		const reset = future();
		const usage: UsageData = {
			five_hour: { utilization: 0, resets_at: null },
			seven_day: { utilization: 0, resets_at: null },
			limits: [scopedLimit("GPT-5.3-Codex-Spark", reset, 4)],
		};

		const normalized = normalizeCodexUsageData(usage);

		expect(normalized).not.toBeNull();
		expect(normalized?.limits).toEqual([
			scopedLimit("GPT-5.3-Codex-Spark", reset, 4),
		]);
	});

	it("still returns null when both flat windows are stale and no live limit remains", () => {
		const usage: UsageData = {
			five_hour: { utilization: 0, resets_at: null },
			seven_day: { utilization: 0, resets_at: null },
			limits: [scopedLimit("Spent-Model", past(), 100)],
		};

		expect(normalizeCodexUsageData(usage)).toBeNull();
	});

	it("leaves limits absent when the source has none", () => {
		const usage: UsageData = {
			five_hour: { utilization: 0, resets_at: null },
			seven_day: { utilization: 21, resets_at: future() },
		};

		const normalized = normalizeCodexUsageData(usage);

		expect(normalized).not.toBeNull();
		expect(normalized?.limits).toBeUndefined();
	});
});
