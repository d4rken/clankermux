import { describe, expect, it } from "bun:test";
import type { FullUsageData } from "@clankermux/types";
import {
	getExhaustedScopedFamilies,
	getScopedWeeklyLimits,
} from "./secondary-limits";

const ISO = "2024-01-03T12:00:00.000Z";

const sessionEntry = {
	kind: "session",
	group: "session",
	percent: 0,
	resets_at: ISO,
	scope: null,
	is_active: false,
};

const weeklyAllEntry = {
	kind: "weekly_all",
	group: "weekly",
	percent: 41,
	resets_at: ISO,
	scope: null,
	is_active: false,
};

function scopedEntry(overrides: Record<string, unknown> = {}) {
	return {
		kind: "weekly_scoped",
		group: "weekly",
		percent: 69,
		resets_at: ISO,
		scope: { model: { id: null, display_name: "Fable" }, surface: null },
		is_active: true,
		...overrides,
	};
}

describe("getScopedWeeklyLimits", () => {
	it("returns the scoped weekly window with correct key/label/utilization/resetsAt", () => {
		expect(
			getScopedWeeklyLimits({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
				limits: [scopedEntry()],
			} as unknown as FullUsageData),
		).toEqual([
			{ key: "Fable", label: "Fable", utilization: 69, resetsAt: ISO },
		]);
	});

	it("prefers scope.model.id as the key when present", () => {
		expect(
			getScopedWeeklyLimits({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
				limits: [
					scopedEntry({
						scope: {
							model: { id: "model-fable", display_name: "Fable" },
							surface: null,
						},
					}),
				],
			} as unknown as FullUsageData),
		).toEqual([
			{
				key: "model-fable",
				label: "Fable",
				utilization: 69,
				resetsAt: ISO,
			},
		]);
	});

	it("returns multiple scoped entries", () => {
		expect(
			getScopedWeeklyLimits({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
				limits: [
					scopedEntry({
						percent: 30,
						scope: { model: { id: null, display_name: "Opus" }, surface: null },
					}),
					scopedEntry({
						percent: 5,
						scope: {
							model: { id: null, display_name: "Sonnet" },
							surface: null,
						},
					}),
				],
			} as unknown as FullUsageData),
		).toEqual([
			{ key: "Opus", label: "Opus", utilization: 30, resetsAt: ISO },
			{ key: "Sonnet", label: "Sonnet", utilization: 5, resetsAt: ISO },
		]);
	});

	it("excludes entries with missing or null percent", () => {
		expect(
			getScopedWeeklyLimits({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
				limits: [scopedEntry({ percent: null })],
			} as unknown as FullUsageData),
		).toEqual([]);
	});

	it("excludes entries with missing or null resets_at", () => {
		expect(
			getScopedWeeklyLimits({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
				limits: [scopedEntry({ resets_at: null })],
			} as unknown as FullUsageData),
		).toEqual([]);
	});

	it("excludes entries with a missing scope", () => {
		expect(
			getScopedWeeklyLimits({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
				limits: [scopedEntry({ scope: null })],
			} as unknown as FullUsageData),
		).toEqual([]);
	});

	it("excludes entries with a missing scope.model", () => {
		expect(
			getScopedWeeklyLimits({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
				limits: [scopedEntry({ scope: { model: null, surface: null } })],
			} as unknown as FullUsageData),
		).toEqual([]);
	});

	it("excludes entries with a missing scope.model.display_name", () => {
		expect(
			getScopedWeeklyLimits({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
				limits: [
					scopedEntry({
						scope: { model: { id: "x", display_name: null }, surface: null },
					}),
				],
			} as unknown as FullUsageData),
		).toEqual([]);
	});

	it("ignores non-weekly_scoped kinds (session, weekly_all present but not returned)", () => {
		expect(
			getScopedWeeklyLimits({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
				limits: [sessionEntry, weeklyAllEntry, scopedEntry()],
			} as unknown as FullUsageData),
		).toEqual([
			{ key: "Fable", label: "Fable", utilization: 69, resetsAt: ISO },
		]);
	});

	it("still renders a scoped entry with is_active: false (no filtering on is_active)", () => {
		expect(
			getScopedWeeklyLimits({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
				limits: [scopedEntry({ is_active: false })],
			} as unknown as FullUsageData),
		).toEqual([
			{ key: "Fable", label: "Fable", utilization: 69, resetsAt: ISO },
		]);
	});

	it("returns [] for non-Anthropic-shaped data", () => {
		expect(
			getScopedWeeklyLimits({
				tokens_limit: {
					used: 0,
					remaining: 0,
					percentage: 0,
					resetAt: null,
					type: "tokens",
				},
				time_limit: null,
			} as unknown as FullUsageData),
		).toEqual([]);
	});

	it("returns [] for null and undefined usageData", () => {
		expect(getScopedWeeklyLimits(null)).toEqual([]);
		expect(getScopedWeeklyLimits(undefined)).toEqual([]);
	});

	it("surfaces scoped windows from a limits[]-only payload (no flat keys)", () => {
		expect(
			getScopedWeeklyLimits({
				limits: [scopedEntry()],
			} as unknown as FullUsageData),
		).toEqual([
			{ key: "Fable", label: "Fable", utilization: 69, resetsAt: ISO },
		]);
	});

	it("returns the Codex Spark scoped weekly entry (provider-agnostic path)", () => {
		// Codex-shaped payload: a dead 5-hour placeholder plus a live weekly and a
		// per-model scoped weekly. The extractor keys on data shape, not provider,
		// so the Spark window surfaces exactly like Anthropic's scoped windows.
		expect(
			getScopedWeeklyLimits({
				five_hour: { utilization: 0, resets_at: null },
				seven_day: { utilization: 21, resets_at: ISO },
				limits: [
					scopedEntry({
						group: "codex",
						percent: 0,
						scope: {
							model: {
								id: "GPT-5.3-Codex-Spark",
								display_name: "GPT-5.3-Codex-Spark",
							},
							surface: null,
						},
					}),
				],
			} as unknown as FullUsageData),
		).toEqual([
			{
				key: "GPT-5.3-Codex-Spark",
				label: "GPT-5.3-Codex-Spark",
				utilization: 0,
				resetsAt: ISO,
			},
		]);
	});

	it("returns [] for a non-Anthropic shape even if a scoped-looking entry sneaks in", () => {
		// No flat keys and no `limits[]` → not Anthropic-shaped → [].
		expect(
			getScopedWeeklyLimits({
				tokens_limit: {
					used: 0,
					remaining: 0,
					percentage: 0,
					resetAt: null,
					type: "tokens",
				},
				time_limit: null,
			} as unknown as FullUsageData),
		).toEqual([]);
	});
});

describe("getExhaustedScopedFamilies", () => {
	// The ISO fixture above (2024-01-03T12:00Z) is the reset; run "now" two days
	// earlier so the reset is in the future.
	const NOW = Date.UTC(2024, 0, 1, 12, 0, 0);
	const RESET_MS = Date.parse(ISO);

	function usage(limits: unknown[]): FullUsageData {
		return { limits } as unknown as FullUsageData;
	}

	it("returns an exhausted scoped family with a resolved family key", () => {
		expect(
			getExhaustedScopedFamilies(usage([scopedEntry({ percent: 100 })]), NOW),
		).toEqual([
			{
				familyKey: "fable",
				label: "Fable",
				resetsAtMs: RESET_MS,
				percent: 100,
			},
		]);
	});

	it("excludes entries below the exhaustion threshold", () => {
		expect(
			getExhaustedScopedFamilies(usage([scopedEntry({ percent: 99 })]), NOW),
		).toEqual([]);
	});

	it("excludes entries whose reset is already past", () => {
		const afterReset = Date.parse(ISO) + 60_000;
		expect(
			getExhaustedScopedFamilies(
				usage([scopedEntry({ percent: 100 })]),
				afterReset,
			),
		).toEqual([]);
	});

	it("collapses duplicate entries of one family — highest percent wins", () => {
		// Mythos and Fable both resolve to the `fable` family. Exactly ONE chip
		// may result (stable React key), labeled by the worse entry.
		const result = getExhaustedScopedFamilies(
			usage([
				scopedEntry({
					percent: 100,
					scope: { model: { id: null, display_name: "Mythos" }, surface: null },
				}),
				scopedEntry({ percent: 101 }),
			]),
			NOW,
		);
		expect(result).toEqual([
			{
				familyKey: "fable",
				label: "Fable",
				resetsAtMs: RESET_MS,
				percent: 101,
			},
		]);
	});

	it("breaks a duplicate-family percent tie by the sooner reset", () => {
		const soonerIso = "2024-01-02T12:00:00.000Z";
		const result = getExhaustedScopedFamilies(
			usage([
				scopedEntry({ percent: 100 }),
				scopedEntry({
					percent: 100,
					resets_at: soonerIso,
					scope: { model: { id: null, display_name: "Mythos" }, surface: null },
				}),
			]),
			NOW,
		);
		expect(result).toEqual([
			{
				familyKey: "fable",
				label: "Mythos",
				resetsAtMs: Date.parse(soonerIso),
				percent: 100,
			},
		]);
	});

	it("keeps a Codex scoped entry under its own key when no family resolves", () => {
		expect(
			getExhaustedScopedFamilies(
				usage([
					scopedEntry({
						percent: 100,
						group: "codex",
						scope: {
							model: {
								id: "GPT-5.3-Codex-Spark",
								display_name: "GPT-5.3-Codex-Spark",
							},
							surface: null,
						},
					}),
				]),
				NOW,
			),
		).toEqual([
			{
				familyKey: "GPT-5.3-Codex-Spark",
				label: "GPT-5.3-Codex-Spark",
				resetsAtMs: RESET_MS,
				percent: 100,
			},
		]);
	});

	it("returns [] for null usage data", () => {
		expect(getExhaustedScopedFamilies(null, NOW)).toEqual([]);
	});
});
