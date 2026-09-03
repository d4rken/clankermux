import { describe, expect, it } from "bun:test";
import type { AccountResponse } from "@clankermux/types";
import { compareServableClasses, servableClassFor } from "../pool-classes";
import { computePoolUsage, scopeResultToClass } from "../pool-usage";

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);
const HOUR = 60 * 60_000;

function account(over: Partial<AccountResponse> = {}): AccountResponse {
	return {
		id: `acc-${Math.random().toString(36).slice(2, 8)}`,
		name: "acct",
		provider: "anthropic",
		paused: false,
		rateLimitedUntil: null,
		tokenExpiresAt: null,
		hasRefreshToken: false,
		usageRateLimitedUntil: null,
		usageData: {
			five_hour: {
				utilization: 10,
				resets_at: new Date(NOW + HOUR).toISOString(),
			},
			seven_day: {
				utilization: 10,
				resets_at: new Date(NOW + 48 * HOUR).toISOString(),
			},
		},
		...over,
	} as unknown as AccountResponse;
}

function withUsage(
	name: string,
	provider: string,
	pct: number,
): AccountResponse {
	return account({
		id: `id-${name}`,
		name,
		provider,
		usageData: {
			five_hour: {
				utilization: pct,
				resets_at: new Date(NOW + HOUR).toISOString(),
			},
			seven_day: {
				utilization: pct,
				resets_at: new Date(NOW + 48 * HOUR).toISOString(),
			},
		},
	} as Partial<AccountResponse>);
}

describe("servableClassFor", () => {
	it("groups providers that can cover for each other", () => {
		expect(servableClassFor("anthropic").classId).toBe("anthropic");
		expect(servableClassFor("anthropic-compatible").classId).toBe("anthropic");
		expect(servableClassFor("codex").classId).toBe("codex");
	});

	it("gives an unknown provider its own class rather than a shared bucket", () => {
		// Folding unknowns together would recreate the exact error this module
		// exists to remove: claiming failover between accounts that cannot cover
		// for each other.
		const first = servableClassFor("brand-new-thing");
		const second = servableClassFor("other-new-thing");
		expect(first.classId).not.toBe(second.classId);
		expect(first.label).toBe("Brand New Thing");
	});

	it("orders known classes ahead of unknown ones", () => {
		expect(compareServableClasses("anthropic", "codex")).toBeLessThan(0);
		expect(compareServableClasses("anthropic", "zzz-unknown")).toBeLessThan(0);
	});
});

describe("computePoolUsage servable classes", () => {
	it("keeps providers that cannot cover for each other in separate pools", () => {
		const result = computePoolUsage(
			[
				withUsage("claude-a", "anthropic", 60),
				withUsage("claude-b", "anthropic", 20),
				withUsage("codex-1", "codex", 80),
			],
			"five_hour",
			NOW,
		);

		expect(result.classes.map((c) => c.classId)).toEqual([
			"anthropic",
			"codex",
		]);
		expect(result.classes[0].accounts).toHaveLength(2);
		expect(result.classes[1].accounts).toHaveLength(1);
	});

	it("reports the least-used account per class, not the mean", () => {
		const result = computePoolUsage(
			[
				withUsage("claude-a", "anthropic", 60),
				withUsage("claude-b", "anthropic", 20),
			],
			"five_hour",
			NOW,
		);

		// The mean is 40. What matters is that one account has 80% headroom,
		// because routing picks one account.
		expect(result.classes[0].leastUsed?.name).toBe("claude-b");
		expect(result.classes[0].leastUsed?.pct).toBe(20);
		expect(result.classes[0].worst?.pct).toBe(60);
	});

	it("binds on the tightest class, never the most optimistic one", () => {
		// The production shape: a comfortable Claude pool beside a single busy
		// Codex account. A global minimum would report 20% and be useless.
		const result = computePoolUsage(
			[
				withUsage("claude-a", "anthropic", 20),
				withUsage("claude-b", "anthropic", 25),
				withUsage("codex-1", "codex", 85),
			],
			"five_hour",
			NOW,
		);

		expect(result.bindingClass?.classId).toBe("codex");
		expect(result.bindingClass?.leastUsed?.pct).toBe(85);
	});

	it("flags a class with no failover", () => {
		const result = computePoolUsage(
			[
				withUsage("claude-a", "anthropic", 20),
				withUsage("claude-b", "anthropic", 25),
				withUsage("codex-1", "codex", 10),
			],
			"five_hour",
			NOW,
		);

		const anthropic = result.classes.find((c) => c.classId === "anthropic");
		const codex = result.classes.find((c) => c.classId === "codex");
		expect(anthropic?.singlePointOfFailure).toBe(false);
		expect(codex?.singlePointOfFailure).toBe(true);
	});

	it("does not claim a single point of failure for an empty class", () => {
		const result = computePoolUsage([], "five_hour", NOW);
		expect(result.classes).toEqual([]);
		expect(result.bindingClass).toBeNull();
	});

	it("sorts unknown-reading accounts last instead of treating them as 0%", () => {
		// A null reading drawn as an empty bar would read as "untouched", which is
		// the opposite of the truth and the more reassuring of the two.
		const result = computePoolUsage(
			[
				withUsage("reporting", "anthropic", 50),
				account({ id: "id-silent", name: "silent", usageData: null }),
			],
			"five_hour",
			NOW,
		);

		const bars = result.classes[0].accounts;
		expect(bars[bars.length - 1].name).toBe("silent");
		expect(bars[bars.length - 1].pct).toBeNull();
		expect(bars[bars.length - 1].state).toBe("unknown");
		// An account with no reading is not capacity, so it cannot make the class
		// look like it has failover.
		expect(result.classes[0].capacityCount).toBe(1);
		expect(result.classes[0].singlePointOfFailure).toBe(true);
	});

	it("lets a spent account take the worst slot", () => {
		const result = computePoolUsage(
			[
				withUsage("busy", "anthropic", 80),
				account({ id: "id-dead", name: "dead", paused: true }),
			],
			"five_hour",
			NOW,
		);

		expect(result.classes[0].worst?.name).toBe("dead");
		expect(result.classes[0].worst?.pct).toBe(100);
		// And it is still counted as capacity: it can serve once it recovers.
		expect(result.classes[0].capacityCount).toBe(2);
		expect(result.classes[0].singlePointOfFailure).toBe(false);
	});
});

describe("scopeResultToClass", () => {
	it("drops a model family none of the class's accounts reports", () => {
		// The defect this exists for, seen live: every per-class card was handed
		// the pool-wide result, so the GPT card announced "Fable weekly exhausted"
		// — a Claude model family — about a single Codex account.
		const result = computePoolUsage(
			[
				withUsage("claude-a", "anthropic", 30),
				withUsage("codex-1", "codex", 50),
			],
			"seven_day",
			NOW,
		);
		const withFable: typeof result = {
			...result,
			familyWeekly: [
				{
					family: "fable",
					label: "Fable",
					worstPct: 100,
					worstAccountName: "claude-a",
					earliestResetMs: NOW + 48 * HOUR,
					elevated: true,
					exhaustedCount: 1,
					elevatedCount: 1,
					atRiskCount: 0,
					soonestExhaustsAtMs: null,
					accounts: [
						{
							name: "claude-a",
							pct: 100,
							resetMs: NOW + 48 * HOUR,
							exhaustsAtMs: null,
						},
					],
				},
			],
		};

		const codexClass = result.classes.find((c) => c.classId === "codex");
		const anthropicClass = result.classes.find(
			(c) => c.classId === "anthropic",
		);
		if (!codexClass || !anthropicClass) throw new Error("missing class");

		expect(scopeResultToClass(withFable, codexClass).familyWeekly).toEqual([]);
		expect(
			scopeResultToClass(withFable, anthropicClass).familyWeekly,
		).toHaveLength(1);
	});

	it("narrows the breakdown to the class's own accounts", () => {
		// A one-account card's popover listed all six accounts.
		const result = computePoolUsage(
			[
				withUsage("claude-a", "anthropic", 30),
				withUsage("claude-b", "anthropic", 40),
				withUsage("codex-1", "codex", 50),
			],
			"seven_day",
			NOW,
		);
		const codexClass = result.classes.find((c) => c.classId === "codex");
		if (!codexClass) throw new Error("missing class");

		const scoped = scopeResultToClass(result, codexClass);
		expect(scoped.contributing.map((c) => c.name)).toEqual(["codex-1"]);
	});
});
