import { describe, expect, it } from "bun:test";
import {
	ACCOUNT_UTILIZATION_SORT_MODES,
	type AccountUtilizationSortMode,
	accountToUsageCardSource,
	maxUtilization,
	parseAccountUtilizationSortMode,
	type SortableUtilizationAccount,
	soonestResetMs,
	sortAccountsByUtilization,
} from "./account-utilization-sort";

const NOW = Date.UTC(2026, 7, 25, 12, 0, 0);

function at(offsetMs: number): string {
	return new Date(NOW + offsetMs).toISOString();
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function account(
	overrides: Partial<SortableUtilizationAccount> &
		Pick<SortableUtilizationAccount, "id" | "name">,
): SortableUtilizationAccount {
	return {
		provider: "anthropic",
		priority: 0,
		rateLimitReset: null,
		usageUtilization: null,
		usageWindow: null,
		usageData: null,
		staleUsage: null,
		usageRateLimitedUntil: null,
		...overrides,
	};
}

/** Anthropic-shaped live payload with the given 5h/weekly percentages. */
function anthropicUsage(
	fivePct: number | null,
	sevenPct: number | null,
	options: { fiveResetIso?: string | null; sevenResetIso?: string | null } = {},
) {
	return {
		five_hour: {
			utilization: fivePct,
			resets_at: options.fiveResetIso ?? null,
		},
		seven_day: {
			utilization: sevenPct,
			resets_at: options.sevenResetIso ?? null,
		},
	};
}

function names(accounts: readonly SortableUtilizationAccount[]): string[] {
	return accounts.map((entry) => entry.name);
}

function ids(accounts: readonly SortableUtilizationAccount[]): string[] {
	return accounts.map((entry) => entry.id);
}

describe("parseAccountUtilizationSortMode", () => {
	it("falls back to the utilization-desc default for null and unknown values", () => {
		expect(parseAccountUtilizationSortMode(null)).toBe("utilization-desc");
		expect(parseAccountUtilizationSortMode("")).toBe("utilization-desc");
		expect(parseAccountUtilizationSortMode("nonsense")).toBe(
			"utilization-desc",
		);
		expect(parseAccountUtilizationSortMode("Utilization-Desc")).toBe(
			"utilization-desc",
		);
	});

	it("round-trips every mode the Select offers", () => {
		for (const mode of ACCOUNT_UTILIZATION_SORT_MODES) {
			expect(parseAccountUtilizationSortMode(mode)).toBe(mode);
		}
	});
});

describe("maxUtilization", () => {
	it("takes the higher of the 5h and weekly windows", () => {
		expect(maxUtilization({ usageData: anthropicUsage(12, 70) })).toBe(70);
		expect(maxUtilization({ usageData: anthropicUsage(88, 3) })).toBe(88);
	});

	it("returns the -1 sentinel with no usage data and with an empty reading", () => {
		expect(maxUtilization({ usageData: null })).toBe(-1);
		expect(maxUtilization({ usageData: anthropicUsage(null, null) })).toBe(-1);
	});
});

describe("accountToUsageCardSource", () => {
	it("derives showWeekly from the provider", () => {
		expect(
			accountToUsageCardSource(account({ id: "a", name: "a" })).showWeekly,
		).toBe(true);
		expect(
			accountToUsageCardSource(
				account({ id: "b", name: "b", provider: "codex" }),
			).showWeekly,
		).toBe(true);
		expect(
			accountToUsageCardSource(
				account({ id: "c", name: "c", provider: "openrouter" }),
			).showWeekly,
		).toBe(false);
	});

	it("carries the classification inputs across unchanged", () => {
		const source = accountToUsageCardSource(
			account({
				id: "d",
				name: "d",
				rateLimitReset: at(HOUR),
				usageUtilization: 42,
				usageWindow: "five_hour",
				usageRateLimitedUntil: NOW + HOUR,
			}),
		);
		expect(source.resetIso).toBe(at(HOUR));
		expect(source.usageUtilization).toBe(42);
		expect(source.usageWindow).toBe("five_hour");
		expect(source.usageRateLimitedUntil).toBe(NOW + HOUR);
	});
});

describe("soonestResetMs", () => {
	it("takes the minimum across the rendered windows", () => {
		const value = soonestResetMs(
			account({
				id: "a",
				name: "a",
				usageData: anthropicUsage(10, 20, {
					fiveResetIso: at(3 * HOUR),
					sevenResetIso: at(HOUR),
				}),
			}),
			NOW,
		);
		expect(value).toBe(NOW + HOUR);
	});

	it("ignores a reset that is already in the past", () => {
		const value = soonestResetMs(
			account({
				id: "a",
				name: "a",
				usageData: anthropicUsage(10, 20, {
					fiveResetIso: at(-HOUR),
					sevenResetIso: at(2 * HOUR),
				}),
			}),
			NOW,
		);
		expect(value).toBe(NOW + 2 * HOUR);
	});

	it("ignores an unparseable reset timestamp", () => {
		const value = soonestResetMs(
			account({
				id: "a",
				name: "a",
				usageData: anthropicUsage(10, 20, {
					fiveResetIso: "not-a-date",
					sevenResetIso: at(2 * HOUR),
				}),
			}),
			NOW,
		);
		expect(value).toBe(NOW + 2 * HOUR);
	});

	it("returns Infinity when every window reset is in the past", () => {
		const value = soonestResetMs(
			account({
				id: "a",
				name: "a",
				usageData: anthropicUsage(10, 20, {
					fiveResetIso: at(-HOUR),
					sevenResetIso: at(-2 * HOUR),
				}),
			}),
			NOW,
		);
		expect(value).toBe(Number.POSITIVE_INFINITY);
	});

	it("uses the stale snapshot's 5h and weekly resets", () => {
		const value = soonestResetMs(
			account({
				id: "a",
				name: "a",
				staleUsage: {
					fiveHour: { utilization: 40, resetIso: at(4 * HOUR) },
					sevenDay: { utilization: 55, resetIso: at(30 * MINUTE) },
					asOfIso: at(-2 * HOUR),
				},
			}),
			NOW,
		);
		expect(value).toBe(NOW + 30 * MINUTE);
	});

	it("uses retryAfterMs for a rate-limited account", () => {
		const value = soonestResetMs(
			account({
				id: "a",
				name: "a",
				usageRateLimitedUntil: NOW + 15 * MINUTE,
			}),
			NOW,
		);
		expect(value).toBe(NOW + 15 * MINUTE);
	});

	it("returns Infinity for a rate-limited account whose retry deadline passed", () => {
		const value = soonestResetMs(
			account({
				id: "a",
				name: "a",
				usageRateLimitedUntil: NOW - MINUTE,
			}),
			NOW,
		);
		expect(value).toBe(Number.POSITIVE_INFINITY);
	});

	it("returns Infinity for a credits account and for one with nothing to show", () => {
		const credits = soonestResetMs(
			account({
				id: "a",
				name: "a",
				provider: "kilo",
				usageData: {
					remainingUsd: 12,
					microdollarsUsed: 3_000_000,
					totalMicrodollarsAcquired: 5_000_000,
					utilizationPercent: 60,
				},
			}),
			NOW,
		);
		expect(credits).toBe(Number.POSITIVE_INFINITY);

		const none = soonestResetMs(account({ id: "b", name: "b" }), NOW);
		expect(none).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("sortAccountsByUtilization", () => {
	const busy = account({
		id: "busy",
		name: "busy",
		usageData: anthropicUsage(20, 90, { fiveResetIso: at(6 * HOUR) }),
		provider: "codex",
		priority: 5,
	});
	const middling = account({
		id: "middling",
		name: "middling",
		usageData: anthropicUsage(50, 10, { fiveResetIso: at(2 * HOUR) }),
		provider: "anthropic",
		priority: 1,
	});
	const idle = account({
		id: "idle",
		name: "idle",
		usageData: anthropicUsage(4, 1, { fiveResetIso: at(30 * MINUTE) }),
		provider: "zai",
		priority: 3,
	});
	const unknown = account({
		id: "unknown",
		name: "unknown",
		usageRateLimitedUntil: NOW + 10 * HOUR,
		provider: "anthropic",
		priority: 2,
	});
	const fixtures = [busy, middling, idle, unknown];

	it("orders utilization high to low, with no-usage accounts last", () => {
		expect(
			names(sortAccountsByUtilization(fixtures, "utilization-desc", NOW)),
		).toEqual(["busy", "middling", "idle", "unknown"]);
	});

	it("orders utilization low to high, still with no-usage accounts last", () => {
		expect(
			names(sortAccountsByUtilization(fixtures, "utilization-asc", NOW)),
		).toEqual(["idle", "middling", "busy", "unknown"]);
	});

	it("orders by the soonest still-future reset", () => {
		expect(names(sortAccountsByUtilization(fixtures, "reset", NOW))).toEqual([
			"idle",
			"middling",
			"busy",
			"unknown",
		]);
	});

	it("orders by name A-Z", () => {
		expect(names(sortAccountsByUtilization(fixtures, "name", NOW))).toEqual([
			"busy",
			"idle",
			"middling",
			"unknown",
		]);
	});

	it("orders by the DISPLAYED provider label, not the raw key", () => {
		// codex renders as "OpenAI" and zai as "z.ai": raw-key order would be
		// anthropic, codex, zai — the label order is Anthropic, OpenAI, z.ai.
		expect(
			sortAccountsByUtilization(fixtures, "provider", NOW).map(
				(entry) => entry.provider,
			),
		).toEqual(["anthropic", "anthropic", "codex", "zai"]);
	});

	it("orders by routing priority ascending (lower number = preferred)", () => {
		expect(names(sortAccountsByUtilization(fixtures, "priority", NOW))).toEqual(
			["middling", "unknown", "idle", "busy"],
		);
	});

	it("breaks ties on equal primary keys with a case-insensitive name", () => {
		const tied = [
			account({ id: "3", name: "charlie", usageData: anthropicUsage(50, 50) }),
			account({ id: "1", name: "Bravo", usageData: anthropicUsage(50, 50) }),
			account({ id: "2", name: "alpha", usageData: anthropicUsage(50, 50) }),
		];
		expect(
			names(sortAccountsByUtilization(tied, "utilization-desc", NOW)),
		).toEqual(["alpha", "Bravo", "charlie"]);
	});

	it("falls through to the exact name when two names differ only in case", () => {
		const tied = [
			account({
				id: "upper",
				name: "Alpha",
				usageData: anthropicUsage(50, 50),
			}),
			account({
				id: "lower",
				name: "alpha",
				usageData: anthropicUsage(50, 50),
			}),
		];
		// "Alpha".localeCompare("alpha") > 0, so the lowercase name leads.
		expect(
			ids(sortAccountsByUtilization(tied, "utilization-desc", NOW)),
		).toEqual(["lower", "upper"]);
		// Same answer regardless of input order — the chain is total, not stable-by-luck.
		expect(
			ids(sortAccountsByUtilization([...tied].reverse(), "name", NOW)),
		).toEqual(["lower", "upper"]);
	});

	it("falls through to the id when the names are identical", () => {
		const tied = [
			account({ id: "id-b", name: "same", usageData: anthropicUsage(50, 50) }),
			account({ id: "id-a", name: "same", usageData: anthropicUsage(50, 50) }),
		];
		expect(ids(sortAccountsByUtilization(tied, "name", NOW))).toEqual([
			"id-a",
			"id-b",
		]);
		expect(
			ids(sortAccountsByUtilization([...tied].reverse(), "name", NOW)),
		).toEqual(["id-a", "id-b"]);
	});

	it("keeps accounts reporting no usage last in BOTH utilization directions", () => {
		const mixed = [
			account({ id: "n1", name: "no-data-1" }),
			account({ id: "u1", name: "used", usageData: anthropicUsage(30, 5) }),
			account({
				id: "n2",
				name: "no-data-2",
				usageData: anthropicUsage(null, null),
			}),
			account({ id: "u2", name: "quiet", usageData: anthropicUsage(1, 0) }),
		];
		expect(
			names(sortAccountsByUtilization(mixed, "utilization-desc", NOW)),
		).toEqual(["used", "quiet", "no-data-1", "no-data-2"]);
		expect(
			names(sortAccountsByUtilization(mixed, "utilization-asc", NOW)),
		).toEqual(["quiet", "used", "no-data-1", "no-data-2"]);
	});

	it("does not mutate its input", () => {
		const input = [...fixtures];
		const before = names(input);
		for (const mode of ACCOUNT_UTILIZATION_SORT_MODES) {
			const sorted = sortAccountsByUtilization(
				input,
				mode as AccountUtilizationSortMode,
				NOW,
			);
			expect(sorted).not.toBe(input);
		}
		expect(names(input)).toEqual(before);
	});
});
