/**
 * The read model behind `/public/v1/*`.
 *
 * Two rules are what this service exists for, and both are asserted directly:
 *
 *  - NO PROVIDER I/O. A widget GET must never cause an upstream call. The
 *    management accounts handler kicks off background refreshes and is
 *    therefore unusable here; the usage cache is read through a NON-EVICTING
 *    peek, so a widget polling every few seconds cannot perturb the cache the
 *    routing layer reads.
 *  - NO SECOND SET OF RULES. Exhaustion and rate-limit presentation come from
 *    the same helpers `/api/accounts` and `/health` use. The tests below pin
 *    the OUTCOMES so a divergence shows up as a failure rather than as a device
 *    quietly disagreeing with the dashboard.
 *
 * The remaining cases are the wire-contract decisions the plan required to be
 * pinned: the aggregate denominator when an account lacks a window, the
 * threshold behind `stale`, and clamping of NaN/Infinity/over-100 utilization.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@clankermux/config";
import { RUNWAY_HORIZON_MS } from "@clankermux/core";
import type { DatabaseOperations } from "@clankermux/database";
import { BunSqlAdapter, ensureSchema } from "@clankermux/database";
import { USAGE_CACHE_TTL_MS, usageCache } from "@clankermux/providers";
import type { AnthropicUsageData } from "@clankermux/types";
import { clampPct, createPublicSnapshotReader } from "../public-snapshot";

const NOW = 1_700_000_000_000;

let db: Database;
let adapter: BunSqlAdapter;

/** Only the two methods the snapshot reader touches. */
function fakeDbOps(): DatabaseOperations {
	return {
		getAdapter: () => adapter,
		// The prediction service reads stored usage snapshots; an empty result
		// means every account simply gets no prediction.
		getLatestUsageSnapshots: async () => [],
		getUsageSnapshotRepository: () => ({
			getSince: async () => [],
		}),
		// biome-ignore lint/suspicious/noExplicitAny: narrow fake, not the real class
	} as any;
}

const fakeConfig = {} as Config;

function insertAccount(
	over: Partial<{
		id: string;
		name: string;
		provider: string;
		paused: 0 | 1;
		pause_reason: string | null;
		rate_limited_until: number | null;
		rate_limited_reason: string | null;
		rate_limit_reset: number | null;
		rate_limit_status: string | null;
	}> = {},
): string {
	const row = {
		id: "acct-1",
		name: "primary",
		provider: "anthropic",
		paused: 0 as 0 | 1,
		pause_reason: null,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limit_reset: null,
		rate_limit_status: null,
		...over,
	};
	db.run(
		`INSERT INTO accounts (
			id, name, provider, api_key, refresh_token, access_token, expires_at,
			created_at, request_count, total_requests, paused, pause_reason,
			rate_limited_until, rate_limited_reason, rate_limit_reset, rate_limit_status
		) VALUES (?, ?, ?, NULL, 'rt', 'at', ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`,
		[
			row.id,
			row.name,
			row.provider,
			NOW + 3_600_000,
			NOW - 86_400_000,
			row.paused,
			row.pause_reason,
			row.rate_limited_until,
			row.rate_limited_reason,
			row.rate_limit_reset,
			row.rate_limit_status,
		],
	);
	return row.id;
}

function anthropicUsage(
	fiveHourPct: number | null,
	sevenDayPct: number | null,
	over: Partial<AnthropicUsageData> = {},
): AnthropicUsageData {
	return {
		five_hour:
			fiveHourPct === null
				? null
				: {
						utilization: fiveHourPct,
						resets_at: new Date(NOW + 3_600_000).toISOString(),
					},
		...(sevenDayPct === null
			? {}
			: {
					seven_day: {
						utilization: sevenDayPct,
						resets_at: new Date(NOW + 5 * 86_400_000).toISOString(),
					},
				}),
		...over,
	};
}

beforeEach(() => {
	db = new Database(":memory:");
	ensureSchema(db);
	adapter = new BunSqlAdapter(db);
	usageCache.clear();
});

afterEach(() => {
	usageCache.clear();
	db.close();
});

function read() {
	return createPublicSnapshotReader(fakeDbOps(), fakeConfig)(NOW);
}

describe("no provider I/O, no cache mutation", () => {
	it("leaves a stale cache entry in place — a widget poll must not evict it", async () => {
		insertAccount();
		// Past the routing TTL but inside the UI horizon: `peek()` would report
		// nothing and `get()` would DELETE it. Neither may happen here.
		usageCache.setWithAgeForTests(
			"acct-1",
			anthropicUsage(50, 10),
			USAGE_CACHE_TTL_MS + 60_000,
		);
		await read();
		await read();
		expect(usageCache.peekWithAge("acct-1")).not.toBeNull();
	});

	it("still serves the aged reading rather than reporting nothing", async () => {
		insertAccount();
		usageCache.setWithAgeForTests(
			"acct-1",
			anthropicUsage(50, 10),
			USAGE_CACHE_TTL_MS + 60_000,
		);
		const snapshot = await read();
		expect(snapshot.accounts[0]?.fiveHourPct).toBe(50);
		// …but labelled honestly.
		expect(snapshot.accounts[0]?.stale).toBe(true);
	});
});

describe("stale", () => {
	it("is false for a reading inside the routing freshness bar", async () => {
		insertAccount();
		usageCache.set("acct-1", anthropicUsage(50, 10));
		const snapshot = await read();
		expect(snapshot.accounts[0]?.stale).toBe(false);
		expect(snapshot.stale).toBe(false);
	});

	it("is true once the reading is past the routing TTL", async () => {
		insertAccount();
		usageCache.setWithAgeForTests(
			"acct-1",
			anthropicUsage(50, 10),
			USAGE_CACHE_TTL_MS + 1,
		);
		expect((await read()).accounts[0]?.stale).toBe(true);
	});

	it("is true when a windowed account has no reading at all", async () => {
		insertAccount();
		expect((await read()).accounts[0]?.stale).toBe(true);
	});

	it("is FALSE for a provider that never reports windows — nothing to be stale", async () => {
		insertAccount({ id: "ollama-1", provider: "ollama" });
		const snapshot = await read();
		expect(snapshot.accounts[0]?.stale).toBe(false);
		expect(snapshot.stale).toBe(false);
	});

	it("lifts to the top level when ANY account is stale", async () => {
		insertAccount({ id: "fresh", name: "fresh" });
		insertAccount({ id: "aged", name: "aged" });
		usageCache.set("fresh", anthropicUsage(10, 5));
		const snapshot = await read();
		expect(snapshot.stale).toBe(true);
	});
});

describe("aggregate denominator", () => {
	it("averages only the accounts that HAVE the window", async () => {
		insertAccount({ id: "a", name: "a" });
		insertAccount({ id: "b", name: "b" });
		usageCache.set("a", anthropicUsage(80, 20));
		// No 5h window at all (a Codex account, whose rolling 5h window was
		// retired) — it must not drag the 5h average toward zero.
		usageCache.set("b", anthropicUsage(null, 40));
		const snapshot = await read();
		expect(snapshot.usage.fiveHourPct).toBe(80);
		expect(snapshot.usage.sevenDayPct).toBe(30);
	});

	it("reports null, never 0, when no account supplies a window", async () => {
		insertAccount({ id: "a", name: "a" });
		const snapshot = await read();
		expect(snapshot.usage.fiveHourPct).toBeNull();
		expect(snapshot.usage.sevenDayPct).toBeNull();
		expect(snapshot.usage.worstAccountPct).toBeNull();
	});

	it("reports the worst single account, not the average", async () => {
		insertAccount({ id: "a", name: "a" });
		insertAccount({ id: "b", name: "b" });
		usageCache.set("a", anthropicUsage(90, 10));
		usageCache.set("b", anthropicUsage(10, 10));
		expect((await read()).usage.worstAccountPct).toBe(90);
	});
});

describe("utilization clamping", () => {
	it("collapses a non-finite value to null", () => {
		expect(clampPct(Number.NaN)).toBeNull();
		expect(clampPct(Number.POSITIVE_INFINITY)).toBeNull();
		expect(clampPct(Number.NEGATIVE_INFINITY)).toBeNull();
		expect(clampPct(null)).toBeNull();
		expect(clampPct(undefined)).toBeNull();
	});

	it("clamps over-100 rather than dropping it — 103% used is still full", () => {
		expect(clampPct(103)).toBe(100);
		expect(clampPct(-5)).toBe(0);
	});

	it("keeps one decimal", () => {
		expect(clampPct(42.44)).toBe(42.4);
		expect(clampPct(42.46)).toBe(42.5);
	});

	it("applies to a payload that reports a nonsense utilization", async () => {
		insertAccount();
		usageCache.set("acct-1", {
			five_hour: {
				utilization: Number.NaN,
				resets_at: new Date(NOW + 1000).toISOString(),
			},
			seven_day: {
				utilization: 140,
				resets_at: new Date(NOW + 1000).toISOString(),
			},
		} as AnthropicUsageData);
		const account = (await read()).accounts[0];
		expect(account?.fiveHourPct).toBeNull();
		expect(account?.sevenDayPct).toBe(100);
	});
});

describe("shared rules, not a second implementation", () => {
	it("reports a spent weekly window as usage_exhausted with no cooldown lock present", async () => {
		insertAccount();
		usageCache.set("acct-1", anthropicUsage(10, 100));
		const account = (await read()).accounts[0];
		expect(account?.cause).toBe("usage_exhausted");
	});

	it("reports an active cooldown as rate_limited", async () => {
		insertAccount({
			rate_limited_until: NOW + 60_000,
			rate_limit_status: "allowed_warning",
		});
		usageCache.set("acct-1", anthropicUsage(10, 10));
		const account = (await read()).accounts[0];
		expect(account?.cause).toBe("rate_limited");
		expect(account?.rateLimitResetAt).toBe(NOW + 60_000);
	});

	it("keeps an administrative block distinct from a spent quota", async () => {
		insertAccount({
			rate_limit_status: "payment_required",
			rate_limited_until: NOW + 60_000,
		});
		usageCache.set("acct-1", anthropicUsage(10, 100));
		expect((await read()).accounts[0]?.cause).toBe("payment_required");
	});
});

describe("pool rollup", () => {
	it("counts a paused account as paused and not routable", async () => {
		insertAccount({ paused: 1, pause_reason: "manual" });
		const snapshot = await read();
		expect(snapshot.pool).toMatchObject({
			configured: 1,
			paused: 1,
			routable: 0,
		});
	});

	it("counts an exhausted account separately from a rate-limited one", async () => {
		insertAccount({ id: "spent", name: "spent" });
		insertAccount({
			id: "locked",
			name: "locked",
			rate_limited_until: NOW + 60_000,
		});
		usageCache.set("spent", anthropicUsage(10, 100));
		usageCache.set("locked", anthropicUsage(10, 10));
		const snapshot = await read();
		expect(snapshot.pool.usageExhausted).toBe(1);
		expect(snapshot.pool.rateLimited).toBe(1);
		expect(snapshot.pool.routable).toBe(0);
	});

	it("reports the soonest recovery as epoch ms", async () => {
		insertAccount({ rate_limited_until: NOW + 120_000 });
		const snapshot = await read();
		expect(snapshot.pool.nextAvailableAt).toBe(NOW + 120_000);
	});

	it("reports null recovery when nothing is waiting on a clock", async () => {
		insertAccount();
		expect((await read()).pool.nextAvailableAt).toBeNull();
	});
});

describe("limits", () => {
	it("flattens the generic limits[] form", async () => {
		insertAccount();
		usageCache.set("acct-1", {
			limits: [
				{
					kind: "session",
					group: "5h",
					percent: 33,
					resets_at: new Date(NOW + 1_000).toISOString(),
					scope: null,
					is_active: true,
				},
				{
					kind: "weekly_scoped",
					group: "7d",
					percent: 12,
					resets_at: new Date(NOW + 2_000).toISOString(),
					scope: { model: { id: "opus", display_name: "Claude Opus 4.5" } },
					is_active: true,
				},
			],
		} as AnthropicUsageData);
		expect((await read()).accounts[0]?.limits).toEqual([
			{ kind: "session", pct: 33, resetsAt: NOW + 1_000, label: "5h" },
			{
				kind: "weekly_scoped",
				pct: 12,
				resetsAt: NOW + 2_000,
				label: "Claude Opus 4.5",
			},
		]);
	});

	it("maps an unrecognized window kind to other", async () => {
		insertAccount();
		usageCache.set("acct-1", {
			limits: [
				{
					kind: "some_future_window",
					group: "g",
					percent: 5,
					resets_at: null,
					scope: null,
					is_active: true,
				},
			],
		} as AnthropicUsageData);
		expect((await read()).accounts[0]?.limits[0]?.kind).toBe("other");
	});

	it("falls back to the flat windows when limits[] is absent", async () => {
		insertAccount();
		usageCache.set("acct-1", anthropicUsage(20, 30));
		const limits = (await read()).accounts[0]?.limits ?? [];
		expect(limits.map((l) => l.kind)).toEqual(["session", "weekly_all"]);
	});

	it("emits nothing for a provider with no usage windows", async () => {
		insertAccount({ id: "ollama-1", provider: "ollama" });
		expect((await read()).accounts[0]?.limits).toEqual([]);
	});
});

describe("quota runway", () => {
	/** 5-hour window only, so the test does not depend on the weekly estimator. */
	function fiveHourOnly(pct: number): AnthropicUsageData {
		return anthropicUsage(pct, null);
	}

	/**
	 * The 5-hour window in the fixture resets an hour from NOW, so it opened four
	 * hours ago. With no regression the lifetime average projects 100% at
	 * `NOW + ((100 - pct) / pct) * 4h`.
	 */
	const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
	const projected = (pct: number): number =>
		Math.round(NOW + ((100 - pct) / pct) * FOUR_HOURS_MS);

	it("projects a run-out inside the horizon from the shared capacity scan", async () => {
		insertAccount();
		usageCache.set("acct-1", fiveHourOnly(90));
		const snapshot = await read();
		expect(snapshot.accounts[0]?.runwayKind).toBe("runway");
		expect(snapshot.accounts[0]?.runwayExhaustsAtMs).toBe(projected(90));
		expect(snapshot.runway.kind).toBe("runway");
		expect(snapshot.runway.exhaustsAtMs).toBe(projected(90));
		expect(snapshot.runway.horizonMs).toBe(RUNWAY_HORIZON_MS);
	});

	it("rounds the projected instant to whole epoch milliseconds", async () => {
		// 95% four hours in lands on NOW + 757894.7368…, which a fixed-point
		// scanner on the device cannot read.
		insertAccount();
		usageCache.set("acct-1", fiveHourOnly(95));
		const snapshot = await read();
		const instant = snapshot.accounts[0]?.runwayExhaustsAtMs;
		expect(Number.isInteger(instant)).toBe(true);
		expect(Number.isInteger(snapshot.runway.exhaustsAtMs)).toBe(true);
	});

	it("reports unknown with a null instant when nothing is projectable", async () => {
		// A windowed account with no reading at all: the honest answer is that the
		// runway cannot be determined, never a fabricated instant.
		insertAccount();
		const snapshot = await read();
		expect(snapshot.accounts[0]?.runwayKind).toBe("unknown");
		expect(snapshot.accounts[0]?.runwayExhaustsAtMs).toBeNull();
		expect(snapshot.runway.kind).toBe("unknown");
		expect(snapshot.runway.exhaustsAtMs).toBeNull();
		// Nothing stateable, so the headline names no account rather than pointing
		// at the one whose own fields are null.
		expect(snapshot.runway.worstAccountId).toBeNull();
	});

	it("refuses to project from a reading past the routing bar", async () => {
		// The reading is still SERVED (fiveHourPct below) because an observation
		// with an age is data; a projection modelling "now" is not allowed to be
		// built on it.
		insertAccount();
		usageCache.setWithAgeForTests(
			"acct-1",
			fiveHourOnly(90),
			USAGE_CACHE_TTL_MS + 60_000,
		);
		const snapshot = await read();
		expect(snapshot.accounts[0]?.fiveHourPct).toBe(90);
		expect(snapshot.accounts[0]?.runwayKind).toBe("unknown");
		expect(snapshot.accounts[0]?.runwayExhaustsAtMs).toBeNull();
	});

	it("treats a provider with no quota window as never running out", async () => {
		// `unmetered`, which is positively known to be in quota — NOT unknown.
		insertAccount({ id: "ollama-1", provider: "ollama" });
		const snapshot = await read();
		expect(snapshot.accounts[0]?.runwayKind).toBe("beyond-horizon");
		expect(snapshot.accounts[0]?.runwayExhaustsAtMs).toBeNull();
	});

	it("reports no-accounts on an empty pool", async () => {
		expect((await read()).runway.kind).toBe("no-accounts");
	});

	it("names the worst account, and accounts[] agrees about it", async () => {
		insertAccount({ id: "hot", name: "hot" });
		insertAccount({ id: "warm", name: "warm" });
		usageCache.set("hot", fiveHourOnly(95));
		usageCache.set("warm", fiveHourOnly(90));
		const snapshot = await read();

		expect(snapshot.runway.worstAccountId).toBe("hot");
		const worst = snapshot.accounts.find(
			(a) => a.id === snapshot.runway.worstAccountId,
		);
		expect(worst?.runwayKind).toBe("runway");
		expect(worst?.runwayExhaustsAtMs).toBe(projected(95));
		// The pool runs out when BOTH are out, which is the later of the two — so
		// the pool figure is not the worst account's figure and must not be
		// mistaken for it.
		expect(snapshot.runway.exhaustsAtMs).toBe(projected(90));
	});

	it("still names a worst account when the pool as a whole never runs out", async () => {
		// `warm` is never projected to run out, so the pool is beyond the horizon
		// while one account inside it has a finite runway.
		insertAccount({ id: "hot", name: "hot" });
		insertAccount({ id: "warm", name: "warm" });
		usageCache.set("hot", fiveHourOnly(90));
		usageCache.set("warm", fiveHourOnly(60));
		const snapshot = await read();
		expect(snapshot.runway.kind).toBe("beyond-horizon");
		expect(snapshot.runway.exhaustsAtMs).toBeNull();
		expect(snapshot.runway.worstAccountId).toBe("hot");
	});

	it("skips an unreadable account when naming the worst one", async () => {
		// `unknown` outranks every finite outcome for RANKING, and is exactly wrong
		// for a single-figure headline: one cold account would otherwise take the
		// field and point a device at an account whose own runway fields are null.
		insertAccount({ id: "cold", name: "cold" });
		insertAccount({ id: "hot", name: "hot" });
		usageCache.set("hot", fiveHourOnly(90));
		const snapshot = await read();
		expect(snapshot.accounts.find((a) => a.id === "cold")?.runwayKind).toBe(
			"unknown",
		);
		expect(snapshot.runway.worstAccountId).toBe("hot");
	});

	it("carries no API key data — the per-key breakdown stays on /api/runway", async () => {
		// `/api/runway` reports a row per API KEY, carrying the key's NAME, its
		// routing pin and two further id arrays. None of that may reach an
		// unauthenticated surface, and the reader must not start reading api_keys
		// to compute a runway.
		db.run(
			`INSERT INTO api_keys (id, name, hashed_key, prefix_last_8, created_at, is_active)
			 VALUES ('key-1', 'impatience (claude)', 'sha256$deadbeef', '12345678', ?, 1)`,
			[NOW - 1_000],
		);
		insertAccount();
		usageCache.set("acct-1", fiveHourOnly(90));
		const wire = JSON.stringify(await read());
		expect(wire).not.toContain("impatience");
		for (const forbidden of [
			"keyName",
			"pin",
			"eligibleAccountIds",
			"unprojectableAccountIds",
			"causes",
		]) {
			expect(wire).not.toContain(forbidden);
		}
	});

	it("adds no array to an account record", async () => {
		// `accounts[]` + `limits[]` spends the device scanner's entire budget.
		insertAccount();
		usageCache.set("acct-1", anthropicUsage(90, 10));
		const account = (await read()).accounts[0];
		if (!account) throw new Error("expected an account");
		const arrayFields = Object.entries(account)
			.filter(([, value]) => Array.isArray(value))
			.map(([key]) => key);
		expect(arrayFields).toEqual(["limits"]);
	});
});
