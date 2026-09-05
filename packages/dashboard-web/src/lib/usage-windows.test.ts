import { describe, expect, it } from "bun:test";
import type { FullUsageData } from "@clankermux/types";
import {
	classifyUsageCard,
	computeSoonestWindowResets,
	computeWindowResetExtremes,
	type UsageCardSource,
	usageWindowCategoryKey,
	usageWindowLabel,
} from "./usage-windows";

const NOW = Date.parse("2026-08-21T12:00:00.000Z");
const inHours = (hours: number) =>
	new Date(NOW + hours * 60 * 60 * 1000).toISOString();

/** What a list-level caller supplies: the families this account's class reports. */
const FABLE = [{ family: "fable", displayName: "Fable" }] as const;

function scopedEntry(displayName: string, resetsAt: string, percent = 42) {
	return {
		kind: "weekly_scoped",
		group: "weekly",
		percent,
		resets_at: resetsAt,
		scope: { model: { id: null, display_name: displayName }, surface: null },
		is_active: true,
	};
}

function anthropicAccount(
	overrides: Partial<UsageCardSource> & {
		fiveHourResetsAt?: string | null;
		sevenDayResetsAt?: string | null;
		scoped?: ReturnType<typeof scopedEntry>[];
	} = {},
): UsageCardSource {
	const {
		fiveHourResetsAt = inHours(2),
		sevenDayResetsAt = inHours(48),
		scoped = [],
		...rest
	} = overrides;
	return {
		resetIso: null,
		provider: "anthropic",
		showWeekly: true,
		usageData: {
			five_hour: { utilization: 30, resets_at: fiveHourResetsAt },
			seven_day: { utilization: 55, resets_at: sevenDayResetsAt },
			limits: scoped,
		} as unknown as FullUsageData,
		...rest,
	};
}

describe("classifyUsageCard", () => {
	it("renders nothing when there is no reset and no usage data", () => {
		expect(
			classifyUsageCard({ resetIso: null, provider: "anthropic" }, NOW),
		).toEqual({ kind: "none" });
	});

	it("reports the usage-API 429 note when nothing else is known", () => {
		expect(
			classifyUsageCard(
				{
					resetIso: null,
					provider: "anthropic",
					usageRateLimitedUntil: NOW + 60_000,
				},
				NOW,
			),
		).toEqual({ kind: "rate-limited", retryAfterMs: NOW + 60_000 });
	});

	it("prefers the last-known snapshot over the 429 note", () => {
		const staleUsage = {
			asOfIso: inHours(-1),
			fiveHour: null,
			sevenDay: { utilization: 12, resetIso: inHours(20) },
		} as UsageCardSource["staleUsage"];
		const card = classifyUsageCard(
			{
				resetIso: null,
				provider: "anthropic",
				usageRateLimitedUntil: NOW + 60_000,
				staleUsage,
			},
			NOW,
		);
		expect(card.kind).toBe("stale");
	});

	it("reports a Kilo credit balance instead of windows", () => {
		const card = classifyUsageCard(
			{
				resetIso: null,
				provider: "kilo",
				usageData: {
					remainingUsd: 4.5,
					totalMicrodollarsAcquired: 10_000_000,
				} as unknown as FullUsageData,
			},
			NOW,
		);
		expect(card).toEqual({
			kind: "credits",
			remainingUsd: 4.5,
			hasCredits: true,
		});
	});

	it("derives the 5-hour, weekly and scoped-weekly windows", () => {
		const card = classifyUsageCard(
			anthropicAccount({ scoped: [scopedEntry("Fable", inHours(72))] }),
			NOW,
		);
		if (card.kind !== "windows")
			throw new Error(`expected windows: ${card.kind}`);
		expect(card.usages.map((u) => u.window)).toEqual([
			"five_hour",
			"seven_day",
			"seven_day_scoped",
		]);
		expect(card.usages[2]?.label).toBe("Fable");
	});
});

describe("usageWindowCategoryKey", () => {
	it("keys unlabelled windows by the heading they render under", () => {
		expect(
			usageWindowCategoryKey({
				utilization: 1,
				window: "five_hour",
				resetTime: null,
			}),
		).toBe("window:5-hour");
	});

	it("groups provider-specific names that render as one heading", () => {
		const anthropicFiveHour = usageWindowCategoryKey({
			utilization: 1,
			window: "five_hour",
			resetTime: null,
		});
		// Zai calls its 5-hour token quota `tokens_limit`; the card labels both
		// "5-hour", so the user sees one category and must get one winner.
		const zaiFiveHour = usageWindowCategoryKey({
			utilization: 1,
			window: "tokens_limit",
			resetTime: null,
		});
		expect(zaiFiveHour).toBe(anthropicFiveHour);
		expect(
			usageWindowCategoryKey({
				utilization: 1,
				window: "weekly",
				resetTime: null,
			}),
		).toBe(
			usageWindowCategoryKey({
				utilization: 1,
				window: "seven_day",
				resetTime: null,
			}),
		);
	});

	it("keeps windows with different headings apart", () => {
		expect(
			usageWindowCategoryKey({
				utilization: 1,
				window: "five_hour",
				resetTime: null,
			}),
		).not.toBe(
			usageWindowCategoryKey({
				utilization: 1,
				window: "seven_day",
				resetTime: null,
			}),
		);
	});

	it("groups scoped weekly windows of one model family together", () => {
		const fable = usageWindowCategoryKey({
			utilization: 1,
			window: "seven_day_scoped",
			resetTime: null,
			label: "Fable",
		});
		const alsoFable = usageWindowCategoryKey({
			utilization: 1,
			window: "seven_day_scoped",
			resetTime: null,
			label: "Claude Fable 5",
		});
		expect(fable).toBe(alsoFable);
		// And never collides with the unscoped weekly window it sits beside.
		expect(fable).not.toBe(
			usageWindowCategoryKey({
				utilization: 1,
				window: "seven_day",
				resetTime: null,
			}),
		);
	});

	it("keeps a name that resolves to no family under its own key", () => {
		expect(
			usageWindowCategoryKey({
				utilization: 1,
				window: "seven_day_scoped",
				resetTime: null,
				label: "gpt-5.6",
			}),
		).toBe("scoped:gpt-5.6");
	});
});

describe("usageWindowLabel", () => {
	it("prefers a provider-supplied label", () => {
		expect(
			usageWindowLabel({
				utilization: 1,
				window: "seven_day_scoped",
				resetTime: null,
				label: "Fable",
			}),
		).toBe("Fable");
	});

	it("falls back to a generic heading for an unnamed window", () => {
		expect(
			usageWindowLabel({ utilization: 1, window: null, resetTime: null }),
		).toBe("Rate limit");
	});
});

describe("computeSoonestWindowResets", () => {
	it("picks the earliest reset per category", () => {
		const soonest = computeSoonestWindowResets(
			[
				anthropicAccount({
					fiveHourResetsAt: inHours(4),
					sevenDayResetsAt: inHours(20),
				}),
				anthropicAccount({
					fiveHourResetsAt: inHours(1),
					sevenDayResetsAt: inHours(44),
				}),
			],
			NOW,
		);
		expect(soonest.get("window:5-hour")).toBe(Date.parse(inHours(1)));
		expect(soonest.get("window:weekly")).toBe(Date.parse(inHours(20)));
	});

	it("marks nothing when only one account reports a category", () => {
		const soonest = computeSoonestWindowResets(
			[anthropicAccount({ scoped: [scopedEntry("Fable", inHours(30))] })],
			NOW,
		);
		expect(soonest.size).toBe(0);
	});

	it("compares scoped weekly windows within one model family", () => {
		const soonest = computeSoonestWindowResets(
			[
				anthropicAccount({ scoped: [scopedEntry("Fable", inHours(30))] }),
				anthropicAccount({ scoped: [scopedEntry("Fable", inHours(9))] }),
			],
			NOW,
		);
		expect(soonest.get("scoped:fable")).toBe(Date.parse(inHours(9)));
	});

	it("does not let one account's duplicate family entries fake a comparison", () => {
		const soonest = computeSoonestWindowResets(
			[
				anthropicAccount({
					scoped: [
						scopedEntry("Fable", inHours(30)),
						scopedEntry("Claude Fable 5", inHours(9)),
					],
				}),
			],
			NOW,
		);
		expect(soonest.has("scoped:fable")).toBe(false);
	});

	it("ignores resets that have already passed", () => {
		const soonest = computeSoonestWindowResets(
			[
				anthropicAccount({ fiveHourResetsAt: inHours(-1) }),
				anthropicAccount({ fiveHourResetsAt: inHours(3) }),
				anthropicAccount({ fiveHourResetsAt: inHours(5) }),
			],
			NOW,
		);
		expect(soonest.get("window:5-hour")).toBe(Date.parse(inHours(3)));
	});

	it("ignores accounts whose card shows no countdown at all", () => {
		// The last-known-snapshot card renders its reset as a bare stamp with no
		// countdown, so its earlier 5-hour reset must not win the category and
		// leave the two live cards unmarked.
		const soonest = computeSoonestWindowResets(
			[
				anthropicAccount({ fiveHourResetsAt: inHours(3) }),
				anthropicAccount({ fiveHourResetsAt: inHours(5) }),
				{
					resetIso: null,
					provider: "anthropic",
					usageData: null,
					staleUsage: {
						asOfIso: inHours(-1),
						fiveHour: { utilization: 80, resetIso: inHours(1) },
						sevenDay: null,
					} as UsageCardSource["staleUsage"],
				},
			],
			NOW,
		);
		expect(soonest.get("window:5-hour")).toBe(Date.parse(inHours(3)));
	});
});

describe("computeWindowResetExtremes", () => {
	it("picks both reset endpoints per category", () => {
		const extremes = computeWindowResetExtremes(
			[
				anthropicAccount({
					fiveHourResetsAt: inHours(4),
					sevenDayResetsAt: inHours(20),
				}),
				anthropicAccount({
					fiveHourResetsAt: inHours(1),
					sevenDayResetsAt: inHours(44),
				}),
			],
			NOW,
		);

		expect(extremes.earliest.get("window:5-hour")).toBe(Date.parse(inHours(1)));
		expect(extremes.latest.get("window:5-hour")).toBe(Date.parse(inHours(4)));
		expect(extremes.earliest.get("window:weekly")).toBe(
			Date.parse(inHours(20)),
		);
		expect(extremes.latest.get("window:weekly")).toBe(Date.parse(inHours(44)));
	});

	it("omits both endpoints when only one account reports a category", () => {
		const extremes = computeWindowResetExtremes(
			[anthropicAccount({ scoped: [scopedEntry("Fable", inHours(30))] })],
			NOW,
		);

		expect(extremes.earliest.has("scoped:fable")).toBe(false);
		expect(extremes.latest.has("scoped:fable")).toBe(false);
	});

	it("never lets an unopened row define a reset endpoint", () => {
		// The row carries no reset BY CONTRACT, so there is nothing to compare —
		// and inventing one would put a countdown on a window that has not
		// started.
		const extremes = computeWindowResetExtremes(
			[
				anthropicAccount({ poolScopedFamilies: FABLE }),
				anthropicAccount({ poolScopedFamilies: FABLE }),
			],
			NOW,
		);

		expect(extremes.earliest.has("scoped:fable")).toBe(false);
		expect(extremes.latest.has("scoped:fable")).toBe(false);
	});
});

describe("classifyUsageCard — families this account has not used", () => {
	it("emits a labelled row with no utilization and no reset", () => {
		const card = classifyUsageCard(
			anthropicAccount({ poolScopedFamilies: FABLE }),
			NOW,
		);
		if (card.kind !== "windows")
			throw new Error(`expected windows: ${card.kind}`);

		const unopened = card.usages.filter((u) => u.state === "unopened");
		expect(unopened).toEqual([
			{
				utilization: null,
				window: "seven_day_scoped",
				resetTime: null,
				label: "Fable",
				state: "unopened",
			},
		]);
	});

	it("does not emit one for a family the payload already reports", () => {
		const card = classifyUsageCard(
			anthropicAccount({
				scoped: [scopedEntry("Fable", inHours(72))],
				poolScopedFamilies: FABLE,
			}),
			NOW,
		);
		if (card.kind !== "windows")
			throw new Error(`expected windows: ${card.kind}`);

		expect(card.usages.some((u) => u.state === "unopened")).toBe(false);
		// The ordinary percent card is what renders instead.
		expect(
			card.usages.filter((u) => u.window === "seven_day_scoped"),
		).toHaveLength(1);
	});

	it("does not emit one beside a percent card built from an unparseable reset", () => {
		// `getScopedWeeklyLimits` keeps an entry with any non-null `resets_at`
		// while the normalizer drops it, so the family is PRESENT but unreadable.
		// Emitting the unopened row too would put "42%" and "not used this week"
		// on the same family in one card.
		const card = classifyUsageCard(
			anthropicAccount({
				scoped: [scopedEntry("Fable", "not-a-date")],
				poolScopedFamilies: FABLE,
			}),
			NOW,
		);
		if (card.kind !== "windows")
			throw new Error(`expected windows: ${card.kind}`);

		expect(card.usages.some((u) => u.state === "unopened")).toBe(false);
		expect(
			card.usages.filter((u) => u.window === "seven_day_scoped"),
		).toHaveLength(1);
	});

	it("emits nothing at all for a family whose only entry has no reset", () => {
		// Dropped by both readers, so the family renders no row of any kind —
		// never an unopened one, which would claim the entry was not there.
		const card = classifyUsageCard(
			anthropicAccount({
				scoped: [{ ...scopedEntry("Fable", inHours(72)), resets_at: null }],
				poolScopedFamilies: FABLE,
			}),
			NOW,
		);
		if (card.kind !== "windows")
			throw new Error(`expected windows: ${card.kind}`);

		expect(
			card.usages.filter((u) => u.window === "seven_day_scoped"),
		).toHaveLength(0);
	});

	it("does not emit one once the account-wide week has rolled over", () => {
		const card = classifyUsageCard(
			anthropicAccount({
				sevenDayResetsAt: inHours(-1),
				poolScopedFamilies: FABLE,
			}),
			NOW,
		);
		if (card.kind !== "windows")
			throw new Error(`expected windows: ${card.kind}`);

		expect(card.usages.some((u) => u.state === "unopened")).toBe(false);
	});

	it("emits nothing when the caller supplies no pool families", () => {
		const card = classifyUsageCard(anthropicAccount(), NOW);
		if (card.kind !== "windows")
			throw new Error(`expected windows: ${card.kind}`);

		expect(card.usages.some((u) => u.state === "unopened")).toBe(false);
	});
});
