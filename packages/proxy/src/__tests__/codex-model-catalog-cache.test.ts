import { describe, expect, test } from "bun:test";
import type { Account } from "@clankermux/types";
import {
	CODEX_MODEL_CATALOG_LOOKUP_BUDGET_MS,
	CODEX_MODEL_CATALOG_MAX_ENTRIES,
	CODEX_MODEL_CATALOG_RETRY_AFTER_MS,
	CODEX_MODEL_CATALOG_TTL_MS,
	CodexModelCatalogCache,
} from "../codex-model-catalog-cache";

/** Let a background refresh run to completion without advancing the clock. */
async function flushMicrotasks(turns = 20): Promise<void> {
	for (let i = 0; i < turns; i++) await Promise.resolve();
}

function account(overrides: Partial<Account> = {}): Account {
	return {
		id: overrides.id ?? "codex-1",
		name: overrides.name ?? "Codex-1",
		provider: overrides.provider ?? "codex",
		paused: overrides.paused ?? false,
		...overrides,
	} as Account;
}

type Pin = {
	pinnedAccountId: string | null;
	pinnedProviders: string[] | null;
	malformed: boolean;
};

interface HarnessOptions {
	accounts?: Account[];
	getAccessToken?: (acct: Account) => Promise<string>;
	getApiKeyPin?: (apiKeyId: string) => Promise<Pin | null>;
	results?: Array<
		{ ok: true; bodyText: string; etag: string | null } | { ok: false }
	>;
	/** Simulated wall-clock cost of each upstream attempt, in ms. */
	fetchCostMs?: number;
}

function harness(options: HarnessOptions = {}) {
	const accounts = options.accounts ?? [account()];
	const results = options.results ?? [
		{ ok: true, bodyText: '{"models":[]}', etag: 'W/"1"' },
	];
	const fetchCalls: Array<{ token: string }> = [];
	let clock = 1_000;

	const cache = new CodexModelCatalogCache({
		listAccounts: async () => accounts,
		getApiKeyPin: options.getApiKeyPin ?? (async () => null),
		getAccessToken:
			options.getAccessToken ?? (async (acct: Account) => `token-${acct.id}`),
		fetchCatalog: async ({ accessToken }) => {
			fetchCalls.push({ token: accessToken });
			clock += options.fetchCostMs ?? 0;
			const next = results[Math.min(fetchCalls.length - 1, results.length - 1)];
			return next.ok
				? { ok: true as const, bodyText: next.bodyText, etag: next.etag }
				: { ok: false as const, status: 500 };
		},
		now: () => clock,
	});

	return {
		cache,
		fetchCalls,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

describe("CodexModelCatalogCache", () => {
	test("fetches once and serves the body verbatim", async () => {
		const { cache, fetchCalls } = harness({
			results: [
				{ ok: true, bodyText: '{"models":[{"slug":"x"}]}', etag: null },
			],
		});

		const result = await cache.get(null);
		expect(result?.bodyText).toBe('{"models":[{"slug":"x"}]}');
		expect(result?.etag).toBeNull();
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0].token).toBe("token-codex-1");
	});

	test("serves a second caller from cache within the TTL", async () => {
		const { cache, fetchCalls, advance } = harness();

		await cache.get(null);
		advance(CODEX_MODEL_CATALOG_TTL_MS - 1);
		expect(await cache.get(null)).not.toBeNull();
		expect(fetchCalls).toHaveLength(1);
	});

	// Blocking a client on a refresh would charge it the whole lookup budget to
	// receive a catalog we already hold.
	test("serves an expired copy immediately and refreshes behind it", async () => {
		const { cache, fetchCalls, advance } = harness({
			results: [
				{ ok: true, bodyText: '{"models":["first"]}', etag: null },
				{ ok: true, bodyText: '{"models":["second"]}', etag: null },
			],
		});

		await cache.get(null);
		advance(CODEX_MODEL_CATALOG_TTL_MS + 1);

		// The stale body comes back rather than the fresh one the refresh will
		// fetch — that difference is the proof it did not wait.
		expect((await cache.get(null))?.bodyText).toBe('{"models":["first"]}');

		// The refresh it kicked off then installs the new copy for the next caller.
		await flushMicrotasks();
		expect(fetchCalls).toHaveLength(2);
		expect((await cache.get(null))?.bodyText).toBe('{"models":["second"]}');
	});

	test("single-flights concurrent callers into one upstream call", async () => {
		const { cache, fetchCalls } = harness();

		const [a, b, c] = await Promise.all([
			cache.get(null),
			cache.get(null),
			cache.get(null),
		]);

		expect(fetchCalls).toHaveLength(1);
		expect(a?.bodyText).toBe(b?.bodyText);
		expect(b?.bodyText).toBe(c?.bodyText);
	});

	test("keeps the previous copy when a refresh fails", async () => {
		const { cache, advance } = harness({
			results: [
				{ ok: true, bodyText: '{"models":["fresh"]}', etag: null },
				{ ok: false },
			],
		});

		await cache.get(null);
		advance(CODEX_MODEL_CATALOG_TTL_MS + 1);
		expect((await cache.get(null))?.bodyText).toBe('{"models":["fresh"]}');
	});

	test("returns null when every Codex account fails", async () => {
		const { cache } = harness({ results: [{ ok: false }] });
		expect(await cache.get(null)).toBeNull();
	});

	test("returns null when there is no Codex account at all", async () => {
		const { cache, fetchCalls } = harness({ accounts: [] });
		expect(await cache.get(null)).toBeNull();
		expect(fetchCalls).toHaveLength(0);
	});

	test("skips paused accounts and non-Codex providers", async () => {
		const { cache, fetchCalls } = harness({
			accounts: [
				account({ id: "paused", paused: true }),
				account({ id: "anthropic-1", provider: "anthropic" }),
				account({ id: "live" }),
			],
		});

		await cache.get(null);
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0].token).toBe("token-live");
	});

	test("moves to the next account when one cannot produce a token", async () => {
		const { cache, fetchCalls } = harness({
			accounts: [account({ id: "broken" }), account({ id: "live" })],
			getAccessToken: async (acct: Account) => {
				if (acct.id === "broken") throw new Error("refresh failed");
				return `token-${acct.id}`;
			},
		});

		expect(await cache.get(null)).not.toBeNull();
		expect(fetchCalls.map((c) => c.token)).toEqual(["token-live"]);
	});

	test("moves to the next account when one returns an unusable catalog", async () => {
		const { cache, fetchCalls } = harness({
			accounts: [account({ id: "first" }), account({ id: "second" })],
			results: [
				{ ok: false },
				{ ok: true, bodyText: '{"models":["second"]}', etag: null },
			],
		});

		expect((await cache.get(null))?.bodyText).toBe('{"models":["second"]}');
		expect(fetchCalls.map((c) => c.token)).toEqual([
			"token-first",
			"token-second",
		]);
	});

	// The fetcher's timeout bounds ONE call. Without a budget over the loop, a
	// hanging backend costs that timeout per account before the caller gets the
	// 200 fallback it was promised — and Codex would give up first.
	test("stops trying accounts once the lookup budget is spent", async () => {
		const { cache, fetchCalls } = harness({
			accounts: Array.from({ length: 10 }, (_, i) =>
				account({ id: `codex-${i}` }),
			),
			results: [{ ok: false }],
			fetchCostMs: CODEX_MODEL_CATALOG_LOOKUP_BUDGET_MS / 2,
		});

		expect(await cache.get(null)).toBeNull();
		expect(fetchCalls.length).toBeLessThan(10);
	});

	// The real hazard is not a slow dependency but one that never settles:
	// getValidAccessToken refreshes OAuth over a fetch with no timeout. Without a
	// hard deadline the in-flight entry never clears and the scope is wedged for
	// the life of the process.
	test("gives up on a dependency that never settles, and recovers afterwards", async () => {
		let release: (() => void) | undefined;
		const cache = new CodexModelCatalogCache({
			listAccounts: async () => [account()],
			getApiKeyPin: async () => null,
			getAccessToken: () =>
				new Promise<string>((resolve) => {
					release = () => resolve("token");
				}),
			fetchCatalog: async () => ({
				ok: true,
				bodyText: '{"models":[]}',
				etag: null,
			}),
			// Real timers: the deadline is a setTimeout, so this asserts it fires
			// rather than that a fake clock was advanced past it. Shortened so the
			// test costs 50ms instead of the production budget.
			now: Date.now,
			lookupBudgetMs: 50,
		});

		const started = Date.now();
		expect(await cache.get(null)).toBeNull();
		// Returned on the deadline, not on the hung dependency.
		expect(Date.now() - started).toBeGreaterThanOrEqual(40);
		expect(Date.now() - started).toBeLessThan(2_000);

		// The abandoned attempt settling later must not corrupt anything.
		release?.();
		await flushMicrotasks();
	});

	// One unreachable backend must not turn every request into another
	// authenticated attempt.
	test("holds off after a failure instead of retrying on every request", async () => {
		const { cache, fetchCalls, advance } = harness({
			results: [{ ok: false }],
		});

		expect(await cache.get(null)).toBeNull();
		const afterFirst = fetchCalls.length;

		expect(await cache.get(null)).toBeNull();
		expect(await cache.get(null)).toBeNull();
		expect(fetchCalls.length).toBe(afterFirst);

		advance(CODEX_MODEL_CATALOG_RETRY_AFTER_MS + 1);
		await cache.get(null);
		expect(fetchCalls.length).toBeGreaterThan(afterFirst);
	});

	test("a throwing fetcher degrades to the next account, then to null", async () => {
		const attempted: string[] = [];
		const cache = new CodexModelCatalogCache({
			listAccounts: async () => [
				account({ id: "first" }),
				account({ id: "second" }),
			],
			getApiKeyPin: async () => null,
			getAccessToken: async (acct) => `token-${acct.id}`,
			fetchCatalog: async ({ accessToken }) => {
				attempted.push(accessToken);
				throw new Error("fetcher blew up");
			},
			now: () => 0,
		});

		expect(await cache.get(null)).toBeNull();
		expect(attempted).toEqual(["token-first", "token-second"]);
	});

	test("a listing failure degrades to null rather than throwing", async () => {
		const cache = new CodexModelCatalogCache({
			listAccounts: async () => {
				throw new Error("database is down");
			},
			getApiKeyPin: async () => null,
			getAccessToken: async () => "token",
			fetchCatalog: async () => ({ ok: true, bodyText: "{}", etag: null }),
			now: () => 0,
		});

		expect(await cache.get(null)).toBeNull();
	});

	describe("routing pins", () => {
		const pinned = (pin: Pin) => ({
			accounts: [account({ id: "a" }), account({ id: "b" })],
			getApiKeyPin: async () => pin,
		});

		// Entitlement is per-subscription, so a catalog from outside the pin can
		// advertise a model the request is then routed away from and fails on.
		test("reads the catalog only from the pinned account", async () => {
			const { cache, fetchCalls } = harness(
				pinned({
					pinnedAccountId: "b",
					pinnedProviders: null,
					malformed: false,
				}),
			);

			await cache.get("key-1");
			expect(fetchCalls.map((c) => c.token)).toEqual(["token-b"]);
		});

		test("honours a provider-class pin", async () => {
			const { cache, fetchCalls } = harness({
				accounts: [
					account({ id: "anthropic-1", provider: "anthropic" }),
					account({ id: "codex-a" }),
				],
				getApiKeyPin: async () => ({
					pinnedAccountId: null,
					pinnedProviders: ["codex"],
					malformed: false,
				}),
			});

			await cache.get("key-1");
			expect(fetchCalls.map((c) => c.token)).toEqual(["token-codex-a"]);
		});

		test("returns null when the pin excludes every Codex account", async () => {
			const { cache, fetchCalls } = harness({
				accounts: [account({ id: "codex-a" })],
				getApiKeyPin: async () => ({
					pinnedAccountId: "not-in-pool",
					pinnedProviders: null,
					malformed: false,
				}),
			});

			expect(await cache.get("key-1")).toBeNull();
			expect(fetchCalls).toHaveLength(0);
		});

		// The routing layer fails closed on a corrupt pin; serving a pooled
		// catalog here would be the same mistake one step earlier.
		// Which account serves an ambiguous scope must not depend on row order or
		// on who answers first, or the models Codex sees can change with no
		// configuration change behind it.
		test("picks deterministically when several accounts are eligible", async () => {
			const run = async (accounts: Account[]) => {
				const { cache, fetchCalls } = harness({
					accounts,
					getApiKeyPin: async () => ({
						pinnedAccountId: null,
						pinnedProviders: ["codex"],
						malformed: false,
					}),
				});
				await cache.get("key-1");
				return fetchCalls[0].token;
			};

			const forward = await run([
				account({ id: "aaa" }),
				account({ id: "bbb" }),
				account({ id: "ccc" }),
			]);
			const reversed = await run([
				account({ id: "ccc" }),
				account({ id: "bbb" }),
				account({ id: "aaa" }),
			]);

			expect(forward).toBe("token-aaa");
			expect(reversed).toBe(forward);
		});

		// A null row means the key does not exist, not that it is unpinned. An
		// unpinned key returns an object of nulls.
		test("fails closed when the key row has vanished", async () => {
			const { cache, fetchCalls } = harness({ getApiKeyPin: async () => null });

			expect(await cache.get("deleted-key")).toBeNull();
			expect(fetchCalls).toHaveLength(0);
		});

		test("fails closed on a provider pin naming an unknown provider", async () => {
			const { cache, fetchCalls } = harness({
				getApiKeyPin: async () => ({
					pinnedAccountId: null,
					// What a comma-joined key would have collapsed into two providers.
					pinnedProviders: ["anthropic,codex"],
					malformed: false,
				}),
			});

			expect(await cache.get("key-1")).toBeNull();
			expect(fetchCalls).toHaveLength(0);
		});

		test("fails closed on a malformed pin", async () => {
			const { cache, fetchCalls } = harness(
				pinned({
					pinnedAccountId: null,
					pinnedProviders: null,
					malformed: true,
				}),
			);

			expect(await cache.get("key-1")).toBeNull();
			expect(fetchCalls).toHaveLength(0);
		});

		test("fails closed when the pin cannot be read at all", async () => {
			const { cache, fetchCalls } = harness({
				getApiKeyPin: async () => {
					throw new Error("database is down");
				},
			});

			expect(await cache.get("key-1")).toBeNull();
			expect(fetchCalls).toHaveLength(0);
		});

		test("does not share a cache entry between differently pinned keys", async () => {
			const pins: Record<string, Pin> = {
				"key-a": {
					pinnedAccountId: "a",
					pinnedProviders: null,
					malformed: false,
				},
				"key-b": {
					pinnedAccountId: "b",
					pinnedProviders: null,
					malformed: false,
				},
			};
			const { cache, fetchCalls } = harness({
				accounts: [account({ id: "a" }), account({ id: "b" })],
				getApiKeyPin: async (id) => pins[id] ?? null,
			});

			await cache.get("key-a");
			await cache.get("key-b");
			await cache.get("key-a");

			expect(fetchCalls.map((c) => c.token)).toEqual(["token-a", "token-b"]);
		});

		test("unpinned keys share the pool-wide entry", async () => {
			const { cache, fetchCalls } = harness({
				getApiKeyPin: async () => ({
					pinnedAccountId: null,
					pinnedProviders: [],
					malformed: false,
				}),
			});

			await cache.get("key-a");
			await cache.get("key-b");
			await cache.get(null);

			expect(fetchCalls).toHaveLength(1);
		});

		test("bounds cached pin scopes, evicting least recently written", async () => {
			const pins: Record<string, Pin> = {};
			const { cache, fetchCalls, advance } = harness({
				accounts: Array.from(
					{ length: CODEX_MODEL_CATALOG_MAX_ENTRIES + 3 },
					(_, i) => account({ id: `codex-${i}` }),
				),
				getApiKeyPin: async (id) => pins[id] ?? null,
			});

			for (let i = 0; i < CODEX_MODEL_CATALOG_MAX_ENTRIES + 3; i++) {
				pins[`key-${i}`] = {
					pinnedAccountId: `codex-${i}`,
					pinnedProviders: null,
					malformed: false,
				};
				await cache.get(`key-${i}`);
				advance(1);
			}
			const afterFill = fetchCalls.length;

			// The oldest scope was evicted, so it misses and refetches...
			await cache.get("key-0");
			expect(fetchCalls.length).toBe(afterFill + 1);

			// ...while a recent one is still resident and costs nothing.
			await cache.get(`key-${CODEX_MODEL_CATALOG_MAX_ENTRIES + 2}`);
			expect(fetchCalls.length).toBe(afterFill + 1);
		});
	});
});
