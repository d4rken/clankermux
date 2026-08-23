import { describe, expect, test } from "bun:test";
import type { Account } from "@clankermux/types";
import {
	CODEX_MODEL_CATALOG_MAX_ENTRIES,
	CODEX_MODEL_CATALOG_TTL_MS,
	CodexModelCatalogCache,
} from "../codex-model-catalog-cache";

function account(overrides: Partial<Account> = {}): Account {
	return {
		id: overrides.id ?? "codex-1",
		name: overrides.name ?? "Codex-1",
		provider: overrides.provider ?? "codex",
		paused: overrides.paused ?? false,
		...overrides,
	} as Account;
}

interface HarnessOptions {
	accounts?: Account[];
	getAccessToken?: (acct: Account) => Promise<string>;
	results?: Array<
		{ ok: true; bodyText: string; etag: string | null } | { ok: false }
	>;
}

function harness(options: HarnessOptions = {}) {
	const accounts = options.accounts ?? [account()];
	const results = options.results ?? [
		{ ok: true, bodyText: '{"models":[]}', etag: 'W/"1"' },
	];
	const fetchCalls: Array<{ token: string; clientVersion: string | null }> = [];
	const tokenCalls: string[] = [];
	let clock = 1_000;

	const cache = new CodexModelCatalogCache({
		listCodexAccounts: async () => accounts,
		getAccessToken:
			options.getAccessToken ??
			(async (acct: Account) => {
				tokenCalls.push(acct.id);
				return `token-${acct.id}`;
			}),
		fetchCatalog: async ({ accessToken, clientVersion }) => {
			fetchCalls.push({ token: accessToken, clientVersion });
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
		tokenCalls,
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

		const result = await cache.get("0.149.0");
		expect(result).not.toBeNull();
		expect(result?.bodyText).toBe('{"models":[{"slug":"x"}]}');
		expect(result?.etag).toBeNull();
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0].token).toBe("token-codex-1");
		expect(fetchCalls[0].clientVersion).toBe("0.149.0");
	});

	test("serves a second caller from cache within the TTL", async () => {
		const { cache, fetchCalls, advance } = harness();

		await cache.get("0.149.0");
		advance(CODEX_MODEL_CATALOG_TTL_MS - 1);
		const second = await cache.get("0.149.0");

		expect(second).not.toBeNull();
		expect(fetchCalls).toHaveLength(1);
	});

	test("refetches once the TTL has elapsed", async () => {
		const { cache, fetchCalls, advance } = harness();

		await cache.get("0.149.0");
		advance(CODEX_MODEL_CATALOG_TTL_MS + 1);
		await cache.get("0.149.0");

		expect(fetchCalls).toHaveLength(2);
	});

	// The catalog is version-gated upstream (`minimal_client_version`), so two
	// client versions are two different documents and must not share an entry.
	test("caches per client version", async () => {
		const { cache, fetchCalls } = harness();

		await cache.get("0.149.0");
		await cache.get("0.150.0");
		await cache.get("0.149.0");

		expect(fetchCalls).toHaveLength(2);
		expect(fetchCalls.map((c) => c.clientVersion)).toEqual([
			"0.149.0",
			"0.150.0",
		]);
	});

	// Several Codex processes start at once on a shared proxy; they must not fan
	// out into one upstream call each.
	test("single-flights concurrent callers into one upstream call", async () => {
		const { cache, fetchCalls } = harness();

		const [a, b, c] = await Promise.all([
			cache.get("0.149.0"),
			cache.get("0.149.0"),
			cache.get("0.149.0"),
		]);

		expect(fetchCalls).toHaveLength(1);
		expect(a?.bodyText).toBe(b?.bodyText);
		expect(b?.bodyText).toBe(c?.bodyText);
	});

	test("serves the stale entry when a refresh fails", async () => {
		const { cache, advance } = harness({
			results: [
				{ ok: true, bodyText: '{"models":["fresh"]}', etag: null },
				{ ok: false },
			],
		});

		await cache.get("0.149.0");
		advance(CODEX_MODEL_CATALOG_TTL_MS + 1);
		const afterFailure = await cache.get("0.149.0");

		expect(afterFailure?.bodyText).toBe('{"models":["fresh"]}');
	});

	test("returns null when every Codex account fails", async () => {
		const { cache } = harness({ results: [{ ok: false }] });
		expect(await cache.get("0.149.0")).toBeNull();
	});

	test("returns null when there is no Codex account at all", async () => {
		const { cache, fetchCalls } = harness({ accounts: [] });
		expect(await cache.get("0.149.0")).toBeNull();
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

		await cache.get("0.149.0");
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

		const result = await cache.get("0.149.0");
		expect(result).not.toBeNull();
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0].token).toBe("token-live");
	});

	test("moves to the next account when one returns an unusable catalog", async () => {
		const { cache, fetchCalls } = harness({
			accounts: [account({ id: "first" }), account({ id: "second" })],
			results: [
				{ ok: false },
				{ ok: true, bodyText: '{"models":["second"]}', etag: null },
			],
		});

		const result = await cache.get("0.149.0");
		expect(result?.bodyText).toBe('{"models":["second"]}');
		expect(fetchCalls.map((c) => c.token)).toEqual([
			"token-first",
			"token-second",
		]);
	});

	// A failure must not be cached as an answer: the next caller retries rather
	// than inheriting a "no catalog" verdict for the rest of the TTL.
	test("does not cache a failure", async () => {
		const { cache, fetchCalls } = harness({
			results: [
				{ ok: false },
				{ ok: true, bodyText: '{"models":[]}', etag: null },
			],
		});

		expect(await cache.get("0.149.0")).toBeNull();
		expect(await cache.get("0.149.0")).not.toBeNull();
		expect(fetchCalls.length).toBeGreaterThanOrEqual(2);
	});

	// The key comes from a request parameter. A cache that only holds its bound
	// while its caller sanitizes does not hold its bound.
	test("bounds the number of cached versions, evicting the least recently written", async () => {
		const { cache, fetchCalls, advance } = harness();

		for (let i = 0; i < CODEX_MODEL_CATALOG_MAX_ENTRIES + 3; i++) {
			await cache.get(`0.${i}.0`);
			advance(1);
		}
		const fetchesAfterFill = fetchCalls.length;

		// The three oldest were evicted, so they miss and refetch...
		await cache.get("0.0.0");
		expect(fetchCalls.length).toBe(fetchesAfterFill + 1);

		// ...while a recent one is still resident and costs nothing.
		const recent = `0.${CODEX_MODEL_CATALOG_MAX_ENTRIES + 2}.0`;
		await cache.get(recent);
		expect(fetchCalls.length).toBe(fetchesAfterFill + 1);
	});

	// The class promises callers a value or null. It must keep that promise
	// itself rather than relying on the fetcher's own fail-clean discipline.
	test("a throwing fetcher degrades to the next account, then to null", async () => {
		const attempted: string[] = [];
		const cache = new CodexModelCatalogCache({
			listCodexAccounts: async () => [
				account({ id: "first" }),
				account({ id: "second" }),
			],
			getAccessToken: async (acct) => `token-${acct.id}`,
			fetchCatalog: async ({ accessToken }) => {
				attempted.push(accessToken);
				throw new Error("fetcher blew up");
			},
			now: () => 0,
		});

		expect(await cache.get("0.149.0")).toBeNull();
		expect(attempted).toEqual(["token-first", "token-second"]);
	});

	test("a listing failure degrades to null rather than throwing", async () => {
		const cache = new CodexModelCatalogCache({
			listCodexAccounts: async () => {
				throw new Error("database is down");
			},
			getAccessToken: async () => "token",
			fetchCatalog: async () => ({ ok: true, bodyText: "{}", etag: null }),
			now: () => 0,
		});

		expect(await cache.get("0.149.0")).toBeNull();
	});
});
