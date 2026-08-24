/**
 * The read model behind `/public/v1/status` and `/public/v1/accounts`.
 *
 * Two rules are what this service exists for, and both are asserted directly:
 *
 *  - NO PROVIDER I/O. A widget GET must never cause an upstream call. The
 *    management accounts handler kicks off background refreshes and is
 *    therefore unusable here; the usage cache is read through a NON-EVICTING
 *    peek, so a widget polling every few seconds cannot perturb the cache the
 *    routing layer reads.
 *  - NO SECOND SET OF RULES. Exhaustion, rate-limit presentation and the
 *    routing prediction come from the same helpers `/api/accounts` and
 *    `/health` use. The tests below pin the OUTCOMES so a divergence shows up
 *    as a failure rather than as a device quietly disagreeing with the
 *    dashboard.
 *
 * The remaining cases are the reshaped contract's own decisions: one window
 * vocabulary instead of three representations, the aggregate counts that make
 * a mean interpretable, the EARLIEST reset rather than a mean of instants, and
 * the two orthogonal axes (availability, credential) that replaced a single
 * conflated health field.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@clankermux/config";
import type { DatabaseOperations } from "@clankermux/database";
import { BunSqlAdapter, ensureSchema } from "@clankermux/database";
import { USAGE_CACHE_TTL_MS, usageCache } from "@clankermux/providers";
import {
	applyProviderOverloadCooldown,
	clearProviderOverloadCooldown,
} from "@clankermux/proxy";
import type {
	Account,
	AnthropicUsageData,
	LoadBalancingStrategy,
} from "@clankermux/types";
import {
	clampPct,
	createPublicSnapshotReader,
	resolveCredentialState,
} from "../public-snapshot";

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

/** Only the two getters the routing prediction reads. */
const fakeConfig = {
	getUsageThrottlingFiveHourEnabled: () => false,
	getUsageThrottlingWeeklyEnabled: () => false,
} as unknown as Config;

/**
 * The simplest honest strategy: rank by priority, and drop nothing the proxy
 * would not drop. Ranking is not what these tests are about — that the count
 * and the candidate come from ONE evaluation is.
 */
function fakeStrategy(): LoadBalancingStrategy {
	return {
		name: "test",
		select: (accounts: Account[]) => accounts,
		peekRanked: (accounts: Account[]) =>
			accounts.filter(
				(a) =>
					!a.paused &&
					!(a.rate_limited_until != null && Number(a.rate_limited_until) > NOW),
			),
		peek: () => null,
		// biome-ignore lint/suspicious/noExplicitAny: narrow fake, not the real class
	} as any;
}

function insertAccount(
	over: Partial<{
		id: string;
		name: string;
		/** Nullable, as the column is: legacy rows predate the default. */
		provider: string | null;
		paused: 0 | 1;
		pause_reason: string | null;
		rate_limited_until: number | null;
		rate_limited_reason: string | null;
		rate_limit_reset: number | null;
		rate_limit_status: string | null;
		access_token: string | null;
		refresh_token: string;
		expires_at: number | null;
	}> = {},
): string {
	const row = {
		id: "acct-1",
		name: "primary",
		provider: "anthropic" as string | null,
		paused: 0 as 0 | 1,
		pause_reason: null,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limit_reset: null,
		rate_limit_status: null,
		access_token: "at",
		refresh_token: "rt",
		expires_at: NOW + 3_600_000,
		...over,
	};
	db.run(
		`INSERT INTO accounts (
			id, name, provider, api_key, refresh_token, access_token, expires_at,
			created_at, request_count, total_requests, paused, pause_reason,
			rate_limited_until, rate_limited_reason, rate_limit_reset, rate_limit_status
		) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`,
		[
			row.id,
			row.name,
			row.provider,
			row.refresh_token,
			row.access_token,
			row.expires_at,
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
	clearProviderOverloadCooldown();
});

afterEach(() => {
	usageCache.clear();
	clearProviderOverloadCooldown();
	db.close();
});

function read(strategy: LoadBalancingStrategy | null = fakeStrategy()) {
	return createPublicSnapshotReader(
		fakeDbOps(),
		fakeConfig,
		() => strategy,
	)(NOW);
}

/** The window of a given kind on the first account, or undefined. */
function windowOf(
	snapshot: Awaited<ReturnType<typeof read>>,
	kind: string,
	accountIndex = 0,
) {
	return snapshot.accounts[accountIndex]?.windows.find((w) => w.kind === kind);
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
		expect(windowOf(snapshot, "five_hour")?.utilizationPct).toBe(50);
		// …but labelled honestly.
		expect(snapshot.accounts[0]?.measurementState).toBe("stale");
	});
});

describe("measurementState replaces the boolean stale", () => {
	it("is fresh for a reading inside the routing freshness bar", async () => {
		insertAccount();
		usageCache.set("acct-1", anthropicUsage(50, 10));
		expect((await read()).accounts[0]?.measurementState).toBe("fresh");
	});

	it("is stale once the reading is past the routing TTL", async () => {
		insertAccount();
		usageCache.setWithAgeForTests(
			"acct-1",
			anthropicUsage(50, 10),
			USAGE_CACHE_TTL_MS + 1,
		);
		expect((await read()).accounts[0]?.measurementState).toBe("stale");
	});

	it("is missing when a metered account has no reading at all", async () => {
		insertAccount();
		const snapshot = await read();
		expect(snapshot.accounts[0]?.measurementState).toBe("missing");
		expect(snapshot.accounts[0]?.usageObservedAtMs).toBeNull();
	});

	it("is not_applicable for a provider that reports no window at all", async () => {
		// The old boolean called this "not stale", which reads as "we have a
		// current reading" — a provider with nothing to read is a third answer.
		insertAccount({ id: "ollama-1", provider: "ollama" });
		const snapshot = await read();
		expect(snapshot.accounts[0]?.measurementState).toBe("not_applicable");
		expect(snapshot.accounts[0]?.windows).toEqual([]);
	});

	it("stamps the observation instant, not the cache write time", async () => {
		insertAccount();
		usageCache.set("acct-1", anthropicUsage(50, 10));
		const snapshot = await read();
		const observedAtMs = snapshot.accounts[0]?.usageObservedAtMs;
		expect(typeof observedAtMs).toBe("number");
		// Every window of the account shares that ONE resolution.
		for (const window of snapshot.accounts[0]?.windows ?? []) {
			expect(window.observedAtMs).toBe(observedAtMs ?? null);
		}
	});
});

describe("windows replace three representations of one observation", () => {
	it("emits one entry per account-wide window, in one vocabulary", async () => {
		insertAccount();
		usageCache.set("acct-1", anthropicUsage(20, 30));
		const snapshot = await read();
		expect(snapshot.accounts[0]?.windows.map((w) => w.kind)).toEqual([
			"five_hour",
			"seven_day",
		]);
		expect(windowOf(snapshot, "five_hour")?.utilizationPct).toBe(20);
		expect(windowOf(snapshot, "seven_day")?.utilizationPct).toBe(30);
	});

	it("reads the generic limits[] form into the SAME vocabulary", async () => {
		// The flat keys and `limits[]` describe the same windows. The deployed
		// shape emitted both under different names; now there is one answer.
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
					kind: "weekly_all",
					group: "7d",
					percent: 44,
					resets_at: new Date(NOW + 2_000).toISOString(),
					scope: null,
					is_active: true,
				},
			],
		} as AnthropicUsageData);
		const snapshot = await read();
		expect(windowOf(snapshot, "five_hour")).toMatchObject({
			utilizationPct: 33,
			resetsAtMs: NOW + 1_000,
			scopeId: null,
		});
		expect(windowOf(snapshot, "seven_day")).toMatchObject({
			utilizationPct: 44,
			resetsAtMs: NOW + 2_000,
		});
	});

	it("emits a window the provider HAS but we could not read, with a null value", async () => {
		// An ABSENT window means "this provider has no such window". A present
		// one with a null utilization means "we could not read it". Those must
		// not be the same answer.
		insertAccount();
		const snapshot = await read();
		expect(snapshot.accounts[0]?.windows.map((w) => w.kind)).toEqual([
			"five_hour",
			"seven_day",
		]);
		expect(windowOf(snapshot, "five_hour")?.utilizationPct).toBeNull();
	});

	it("carries a scoped weekly window under a stable family key", async () => {
		insertAccount();
		usageCache.set("acct-1", {
			limits: [
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
		const scoped = windowOf(await read(), "weekly_scoped");
		expect(scoped?.scopeId).toBe("opus");
		expect(scoped?.label).toBe("Claude Opus 4.5");
		expect(scoped?.utilizationPct).toBe(12);
	});

	it("carries the Claude-Code weekly allowance under a scope, not a second seven_day", async () => {
		// A real window the public vocabulary has no name for. Emitting it as a
		// second `seven_day` would make the account-wide window ambiguous.
		insertAccount();
		usageCache.set(
			"acct-1",
			anthropicUsage(10, 20, {
				seven_day_oauth_apps: {
					utilization: 55,
					resets_at: new Date(NOW + 3_000).toISOString(),
				},
			} as Partial<AnthropicUsageData>),
		);
		const snapshot = await read();
		const kinds = snapshot.accounts[0]?.windows.map((w) => w.kind) ?? [];
		expect(kinds.filter((k) => k === "seven_day")).toHaveLength(1);
		const oauthApps = windowOf(snapshot, "seven_day_oauth_apps");
		expect(oauthApps?.scopeId).toBe("seven_day_oauth_apps");
		expect(oauthApps?.utilizationPct).toBe(55);
	});

	it("rolls utilizationPct up from the ACCOUNT-WIDE windows only", async () => {
		// One spent model family is not the account.
		insertAccount();
		usageCache.set("acct-1", {
			five_hour: {
				utilization: 20,
				resets_at: new Date(NOW + 1_000).toISOString(),
			},
			limits: [
				{
					kind: "weekly_scoped",
					group: "7d",
					percent: 99,
					resets_at: new Date(NOW + 2_000).toISOString(),
					scope: { model: { id: "opus", display_name: "Claude Opus 4.5" } },
					is_active: true,
				},
			],
		} as AnthropicUsageData);
		expect((await read()).accounts[0]?.utilizationPct).toBe(20);
	});

	it("serves no prediction where the estimator established no trend", async () => {
		insertAccount();
		usageCache.set("acct-1", anthropicUsage(20, 30));
		for (const window of (await read()).accounts[0]?.windows ?? []) {
			expect(window.prediction).toBeNull();
		}
	});
});

describe("availability and credential are orthogonal axes", () => {
	it("reports an account-wide spent window as usage_exhausted", async () => {
		insertAccount();
		usageCache.set("acct-1", anthropicUsage(10, 100));
		expect((await read()).accounts[0]?.cause).toBe("usage_exhausted");
	});

	it("reports an active cooldown as rate_limited with a lift instant", async () => {
		insertAccount({
			rate_limited_until: NOW + 60_000,
			rate_limit_status: "allowed_warning",
		});
		usageCache.set("acct-1", anthropicUsage(10, 10));
		const account = (await read()).accounts[0];
		expect(account?.cause).toBe("rate_limited");
		expect(account?.availableAtMs).toBe(NOW + 60_000);
	});

	it("keeps an administrative block distinct from a spent quota", async () => {
		insertAccount({
			rate_limit_status: "payment_required",
			rate_limited_until: NOW + 60_000,
		});
		usageCache.set("acct-1", anthropicUsage(10, 100));
		expect((await read()).accounts[0]?.cause).toBe("payment_required");
	});

	it("promises no lift instant for a pause, which has no scheduled end", async () => {
		// The stored rate-limit reset would otherwise be published as a recovery
		// time for a block that no clock lifts.
		insertAccount({
			paused: 1,
			pause_reason: "manual",
			rate_limited_until: NOW + 60_000,
		});
		const account = (await read()).accounts[0];
		expect(account?.paused).toBe(true);
		expect(account?.availableAtMs).toBeNull();
	});

	it("reports a valid OAuth credential beside a rate-limited account", async () => {
		// The whole point of the split: the credential is fine, the account is
		// not, and one `blocked` value could say neither.
		insertAccount({ rate_limited_until: NOW + 60_000 });
		const account = (await read()).accounts[0];
		expect(account?.cause).toBe("rate_limited");
		expect(account?.credentialState).toBe("valid");
	});

	it("reports an expired access token with a refresh token as refreshable", async () => {
		insertAccount({ expires_at: NOW - 1_000 });
		const account = (await read()).accounts[0];
		expect(account?.credentialState).toBe("refreshable");
		// …and it blocks nothing: the proxy renews it on the next request.
		expect(account?.cause).toBe("ok");
	});

	it("reports a rejected refresh token as invalid — that one needs a human", async () => {
		insertAccount({
			paused: 1,
			pause_reason: "oauth_invalid_grant",
			expires_at: NOW - 1_000,
		});
		expect((await read()).accounts[0]?.credentialState).toBe("invalid");
	});

	it("reports an API-key credential as not_applicable with no deadline", async () => {
		// API-key providers store the key in BOTH columns, so a far-future
		// placeholder expiry would otherwise render as a meaningless countdown.
		insertAccount({
			provider: "zai",
			access_token: "key",
			refresh_token: "key",
			expires_at: NOW + 10 * 365 * 86_400_000,
		});
		const account = (await read()).accounts[0];
		expect(account?.credentialState).toBe("not_applicable");
		expect(account?.credentialExpiresAtMs).toBeNull();
	});
});

describe("resolveCredentialState", () => {
	const base = {
		access_token: "at" as string | null,
		refresh_token: "rt" as string | null,
		expires_at: (NOW + 1_000) as number | null,
		paused: 0 as 0 | 1,
		pause_reason: null as string | null,
	};

	it("reports missing when nothing is stored", () => {
		expect(
			resolveCredentialState(
				{ ...base, access_token: null, refresh_token: null },
				NOW,
			),
		).toEqual({ state: "missing", expiresAtMs: null });
	});

	it("distinguishes an API key from an OAuth account with no refresh token", () => {
		// Both have "no usable refresh token", and they are not the same thing:
		// the first needs nothing, the second is one expiry from needing a human.
		expect(
			resolveCredentialState(
				{ ...base, access_token: "k", refresh_token: "k" },
				NOW,
			).state,
		).toBe("not_applicable");
		expect(
			resolveCredentialState(
				{ ...base, refresh_token: null, expires_at: NOW - 1 },
				NOW,
			).state,
		).toBe("expired");
	});

	it("lets a rejected refresh token outrank the access token's own expiry", () => {
		expect(
			resolveCredentialState(
				{
					...base,
					paused: 1,
					pause_reason: "oauth_invalid_grant",
					expires_at: NOW + 3_600_000,
				},
				NOW,
			).state,
		).toBe("invalid");
	});

	it("reports valid when no expiry was ever recorded", () => {
		// Nothing says the token stopped working, and claiming otherwise would
		// grey out a perfectly good account.
		expect(
			resolveCredentialState({ ...base, expires_at: null }, NOW).state,
		).toBe("valid");
	});
});

describe("pooled aggregates disclose what they are", () => {
	it("means over the accounts that HAVE the window, counting the rest as unknown", async () => {
		insertAccount({ id: "a", name: "a" });
		insertAccount({ id: "b", name: "b" });
		usageCache.set("a", anthropicUsage(80, 20));
		// No 5h reading at all — it must not drag the 5h mean toward zero, but it
		// must be counted so the mean is interpretable.
		usageCache.set("b", anthropicUsage(null, 40));
		const snapshot = await read();
		expect(snapshot.usage.fiveHour.meanUtilizationPct).toBe(80);
		expect(snapshot.usage.fiveHour.contributingAccountCount).toBe(1);
		expect(snapshot.usage.fiveHour.unknownAccountCount).toBe(1);
		expect(snapshot.usage.sevenDay.meanUtilizationPct).toBe(30);
		expect(snapshot.usage.sevenDay.contributingAccountCount).toBe(2);
	});

	it("accounts for EVERY account across the two counts", async () => {
		insertAccount({ id: "a", name: "a" });
		insertAccount({ id: "b", name: "b" });
		// A provider with no window at all, and one with a window but no reading.
		insertAccount({ id: "c", name: "c", provider: "ollama" });
		usageCache.set("a", anthropicUsage(80, 20));
		const snapshot = await read();
		for (const aggregate of [
			snapshot.usage.fiveHour,
			snapshot.usage.sevenDay,
		]) {
			expect(
				aggregate.contributingAccountCount + aggregate.unknownAccountCount,
			).toBe(snapshot.pool.configured);
		}
	});

	it("reports null, never 0, when no account supplies a window", async () => {
		insertAccount({ id: "a", name: "a" });
		const snapshot = await read();
		expect(snapshot.usage.fiveHour.meanUtilizationPct).toBeNull();
		expect(snapshot.usage.sevenDay.meanUtilizationPct).toBeNull();
		expect(snapshot.usage.worstAccountUtilizationPct).toBeNull();
	});

	it("takes the EARLIEST reset, never a mean of reset instants", async () => {
		// The mean of two reset times is an instant at which nothing happens.
		insertAccount({ id: "a", name: "a" });
		insertAccount({ id: "b", name: "b" });
		usageCache.set("a", {
			five_hour: {
				utilization: 10,
				resets_at: new Date(NOW + 1_000_000).toISOString(),
			},
		} as AnthropicUsageData);
		usageCache.set("b", {
			five_hour: {
				utilization: 20,
				resets_at: new Date(NOW + 3_000_000).toISOString(),
			},
		} as AnthropicUsageData);
		const snapshot = await read();
		expect(snapshot.usage.fiveHour.earliestResetsAtMs).toBe(NOW + 1_000_000);
		expect(snapshot.usage.fiveHour.earliestResetsAtMs).not.toBe(
			NOW + 2_000_000,
		);
	});

	it("reports the worst single account, not the mean", async () => {
		insertAccount({ id: "a", name: "a" });
		insertAccount({ id: "b", name: "b" });
		usageCache.set("a", anthropicUsage(90, 10));
		usageCache.set("b", anthropicUsage(10, 10));
		expect((await read()).usage.worstAccountUtilizationPct).toBe(90);
	});
});

describe("provider-level facts are homed on the provider", () => {
	it("emits one entry per provider present in the pool", async () => {
		insertAccount({ id: "a", name: "a", provider: "anthropic" });
		insertAccount({ id: "b", name: "b", provider: "codex" });
		insertAccount({ id: "c", name: "c", provider: "anthropic" });
		const snapshot = await read();
		expect(snapshot.providers.map((p) => p.provider)).toEqual([
			"anthropic",
			"codex",
		]);
	});

	it("reports a closed breaker rather than an unknown one when no bucket exists", async () => {
		insertAccount();
		const provider = (await read()).providers[0];
		expect(provider?.anyOverload).toEqual({
			state: "closed",
			untilMs: null,
			probeActive: false,
		});
		expect(provider?.providerWideOverload.state).toBe("closed");
	});

	it("pools each scoped limit across the provider's accounts", async () => {
		insertAccount({ id: "a", name: "a" });
		insertAccount({ id: "b", name: "b" });
		const scoped = (percent: number, resetOffsetMs: number) =>
			({
				limits: [
					{
						kind: "weekly_scoped",
						group: "7d",
						percent,
						resets_at: new Date(NOW + resetOffsetMs).toISOString(),
						scope: { model: { id: "opus", display_name: "Claude Opus 4.5" } },
						is_active: true,
					},
				],
			}) as AnthropicUsageData;
		usageCache.set("a", scoped(40, 3_000_000));
		usageCache.set("b", scoped(60, 1_000_000));
		const limits = (await read()).providers[0]?.scopedLimits ?? [];
		expect(limits).toHaveLength(1);
		expect(limits[0]).toMatchObject({
			scopeId: "opus",
			label: "Claude Opus 4.5",
			meanUtilizationPct: 50,
			contributingAccountCount: 2,
			unknownAccountCount: 0,
			// EARLIEST, not a mean.
			earliestResetsAtMs: NOW + 1_000_000,
		});
	});

	it("matches the per-account windows it aggregates, and counts the silent ones", async () => {
		insertAccount({ id: "a", name: "a" });
		insertAccount({ id: "b", name: "b" });
		usageCache.set("a", {
			limits: [
				{
					kind: "weekly_scoped",
					group: "7d",
					percent: 70,
					resets_at: new Date(NOW + 1_000_000).toISOString(),
					scope: { model: { id: "opus", display_name: "Claude Opus 4.5" } },
					is_active: true,
				},
			],
		} as AnthropicUsageData);
		// `b` reports nothing for that family.
		usageCache.set("b", anthropicUsage(5, 5));
		const snapshot = await read();
		const limit = snapshot.providers[0]?.scopedLimits[0];
		const perAccount = snapshot.accounts
			.flatMap((a) => a.windows)
			.filter((w) => w.scopeId === "opus");
		expect(perAccount).toHaveLength(1);
		expect(limit?.meanUtilizationPct).toBe(perAccount[0]?.utilizationPct ?? 0);
		expect(limit?.contributingAccountCount).toBe(1);
		expect(limit?.unknownAccountCount).toBe(1);
	});
});

describe("the routing prediction and the count it belongs to", () => {
	it("names one candidate and counts the pool it was chosen from", async () => {
		insertAccount({ id: "a", name: "a" });
		insertAccount({ id: "b", name: "b" });
		const snapshot = await read();
		expect(snapshot.routing.context).toBe("fresh_unpinned_nominal");
		expect(snapshot.pool.defaultRoutable).toBe(2);
		expect(snapshot.routing.defaultCandidateAccountId).toBe(
			snapshot.accounts.find((a) => a.isDefaultCandidate)?.id ?? null,
		);
	});

	it("flags exactly ONE account, never a set", async () => {
		insertAccount({ id: "a", name: "a" });
		insertAccount({ id: "b", name: "b" });
		const snapshot = await read();
		expect(snapshot.accounts.filter((a) => a.isDefaultCandidate)).toHaveLength(
			1,
		);
	});

	it("excludes a blocked account from BOTH the count and the candidate", async () => {
		// The count and the candidate answer the same question, so they cannot
		// disagree about which accounts are in scope.
		insertAccount({ id: "a", name: "a", paused: 1, pause_reason: "manual" });
		insertAccount({ id: "b", name: "b", rate_limited_until: NOW + 60_000 });
		const snapshot = await read();
		expect(snapshot.pool.defaultRoutable).toBe(0);
		expect(snapshot.routing.defaultCandidateAccountId).toBeNull();
		expect(snapshot.accounts.some((a) => a.isDefaultCandidate)).toBe(false);
	});

	it("reads a legacy null provider as anthropic, so a provider-wide overload still applies", async () => {
		// The column is nullable and the domain conversion maps null to
		// "anthropic", as does the account record this same response serves.
		// Reading it as an unnamed provider in the prediction inputs would leave
		// the row eligible through an Anthropic overload, and the published count
		// and candidate would then contradict real routing.
		insertAccount({ id: "legacy", name: "legacy", provider: null });
		applyProviderOverloadCooldown("anthropic");
		const snapshot = await read();
		expect(snapshot.accounts[0]?.provider).toBe("anthropic");
		expect(snapshot.pool.defaultRoutable).toBe(0);
		expect(snapshot.routing.defaultCandidateAccountId).toBeNull();
	});

	it("states nothing when the routing context cannot be evaluated", async () => {
		// Before startup wires the strategy there is no routing to predict, and
		// falling back to another notion of routable would contradict the
		// candidate beside it.
		insertAccount();
		const snapshot = await read(null);
		expect(snapshot.pool.defaultRoutable).toBe(0);
		expect(snapshot.routing.defaultCandidateAccountId).toBeNull();
	});
});

describe("pool rollup", () => {
	it("counts a paused account as paused and not routable", async () => {
		insertAccount({ paused: 1, pause_reason: "manual" });
		const snapshot = await read();
		expect(snapshot.pool).toMatchObject({
			configured: 1,
			paused: 1,
			defaultRoutable: 0,
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
	});

	it("reports the soonest recovery", async () => {
		insertAccount({ rate_limited_until: NOW + 120_000 });
		expect((await read()).pool.nextAvailableAtMs).toBe(NOW + 120_000);
	});

	it("reports null recovery when nothing is waiting on a clock", async () => {
		insertAccount();
		expect((await read()).pool.nextAvailableAtMs).toBeNull();
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
		const snapshot = await read();
		expect(windowOf(snapshot, "five_hour")?.utilizationPct).toBeNull();
		expect(windowOf(snapshot, "seven_day")?.utilizationPct).toBe(100);
	});
});

describe("the read model carries no API key data", () => {
	it("never reads api_keys — key identity cannot reach this surface", async () => {
		db.run(
			`INSERT INTO api_keys (id, name, hashed_key, prefix_last_8, created_at, is_active)
			 VALUES ('key-1', 'impatience (claude)', 'sha256$deadbeef', '12345678', ?, 1)`,
			[NOW - 1_000],
		);
		insertAccount();
		usageCache.set("acct-1", anthropicUsage(90, null));
		const wire = JSON.stringify(await read());
		expect(wire).not.toContain("impatience");
		for (const forbidden of [
			"keyId",
			"keyName",
			// Quoted, because "pin" is a substring of the routing context name.
			'"pin"',
			"eligibleAccountIds",
			"unprojectableAccountIds",
		]) {
			expect(wire).not.toContain(forbidden);
		}
	});

	it("carries no token material", async () => {
		insertAccount({ access_token: "at-secret", refresh_token: "rt-secret" });
		const wire = JSON.stringify(await read());
		expect(wire).not.toContain("at-secret");
		expect(wire).not.toContain("rt-secret");
	});
});
