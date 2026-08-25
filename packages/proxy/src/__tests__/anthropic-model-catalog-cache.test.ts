/**
 * The live Anthropic model listing behind `GET /wire/anthropic/v1/models`.
 *
 * Every dependency is injected — fetch, token acquisition, the clock — because
 * the properties worth testing are all about WHEN an upstream call happens:
 * once per TTL, never during a backoff window, never twice concurrently, and
 * never for longer than the lookup budget even when token acquisition hangs
 * forever (the one failure mode that could wedge the cache permanently).
 *
 * The bundled registry is the floor: a caller always gets a list, so a Claude
 * Code startup can never be blocked by our inability to read the catalogue.
 */

import { describe, expect, test } from "bun:test";
import { CLAUDE_MODEL_IDS } from "@clankermux/core";
import type { Account } from "@clankermux/types";
import {
	ANTHROPIC_MODEL_CATALOG_LOOKUP_BUDGET_MS,
	ANTHROPIC_MODEL_CATALOG_RETRY_AFTER_MS,
	ANTHROPIC_MODEL_CATALOG_TTL_MS,
	AnthropicModelCatalogCache,
} from "../anthropic-model-catalog-cache";

/** Let a background refresh run to completion without advancing the clock. */
async function flushMicrotasks(turns = 20): Promise<void> {
	for (let i = 0; i < turns; i++) await Promise.resolve();
}

function account(overrides: Partial<Account> = {}): Account {
	return {
		id: overrides.id ?? "anthropic-1",
		name: overrides.name ?? "Claude-1",
		provider: overrides.provider ?? "anthropic",
		paused: overrides.paused ?? false,
		...overrides,
	} as Account;
}

function body(
	models: Array<Record<string, unknown>>,
	extra: Record<string, unknown> = {},
): string {
	return JSON.stringify({ data: models, ...extra });
}

const ONE_MODEL = body([
	{
		type: "model",
		id: "claude-opus-9",
		display_name: "Claude Opus 9",
		created_at: "2026-08-01T00:00:00Z",
	},
]);

interface HarnessOptions {
	accounts?: Account[];
	/** Replaces the plain listing when a test needs it to cost time or throw. */
	listAccounts?: () => Promise<readonly Account[]>;
	getAccessToken?: (acct: Account) => Promise<string>;
	/** One entry per attempt; the last is reused once exhausted. */
	responses?: Array<
		{ status: number; body: string } | { throws: string } | "never-settles"
	>;
	/** Simulated wall-clock cost of each upstream attempt, in ms. */
	fetchCostMs?: number;
	lookupBudgetMs?: number;
}

function harness(options: HarnessOptions = {}) {
	const accounts = options.accounts ?? [account()];
	const responses = options.responses ?? [{ status: 200, body: ONE_MODEL }];
	const fetchCalls: Array<{ url: string; headers: Headers }> = [];
	const tokenCalls: string[] = [];
	let clock = 1_000;

	const cache = new AnthropicModelCatalogCache({
		listAccounts: options.listAccounts ?? (async () => accounts),
		getAccessToken: async (acct: Account) => {
			tokenCalls.push(acct.id);
			return options.getAccessToken
				? await options.getAccessToken(acct)
				: `token-${acct.id}`;
		},
		fetchImpl: (async (input: string, init?: RequestInit) => {
			fetchCalls.push({
				url: String(input),
				headers: new Headers(init?.headers),
			});
			clock += options.fetchCostMs ?? 0;
			const next =
				responses[Math.min(fetchCalls.length - 1, responses.length - 1)];
			if (next === "never-settles") return new Promise<Response>(() => {});
			if ("throws" in next) throw new Error(next.throws);
			return new Response(next.body, { status: next.status });
		}) as unknown as typeof fetch,
		now: () => clock,
		...(options.lookupBudgetMs !== undefined
			? { lookupBudgetMs: options.lookupBudgetMs }
			: {}),
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

describe("AnthropicModelCatalogCache", () => {
	test("fetches once and reports the upstream entries", async () => {
		const { cache, fetchCalls } = harness();

		const snapshot = await cache.get();

		expect(snapshot.source).toBe("upstream");
		expect(snapshot.fetchedAt).toBe(1_000);
		expect(snapshot.models).toEqual([
			{
				id: "claude-opus-9",
				displayName: "Claude Opus 9",
				createdAt: "2026-08-01T00:00:00Z",
			},
		]);
		expect(fetchCalls).toHaveLength(1);
	});

	// The bearer has exactly one valid destination and the beta header is what
	// makes an OAuth token acceptable on this endpoint at all.
	test("sends the OAuth headers and asks for the whole list", async () => {
		const { cache, fetchCalls } = harness();

		await cache.get();

		const call = fetchCalls[0];
		expect(call.url).toBe("https://api.anthropic.com/v1/models?limit=1000");
		expect(call.headers.get("authorization")).toBe("Bearer token-anthropic-1");
		expect(call.headers.get("anthropic-version")).toBe("2023-06-01");
		expect(call.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
		expect(call.headers.get("accept")).toBe("application/json");
	});

	test("serves a second caller from cache within the TTL", async () => {
		const { cache, fetchCalls, advance } = harness();

		await cache.get();
		advance(ANTHROPIC_MODEL_CATALOG_TTL_MS - 1);
		expect((await cache.get()).source).toBe("upstream");
		expect(fetchCalls).toHaveLength(1);
	});

	// Blocking a client on a refresh would charge it the whole lookup budget to
	// receive a list we already hold.
	test("serves an expired copy immediately and refreshes behind it", async () => {
		const { cache, fetchCalls, advance } = harness({
			responses: [
				{ status: 200, body: body([{ id: "first" }]) },
				{ status: 200, body: body([{ id: "second" }]) },
			],
		});

		await cache.get();
		advance(ANTHROPIC_MODEL_CATALOG_TTL_MS + 1);

		// The stale entry comes back rather than the fresh one the refresh will
		// fetch — that difference is the proof it did not wait.
		expect((await cache.get()).models[0]?.id).toBe("first");

		await flushMicrotasks();
		expect(fetchCalls).toHaveLength(2);
		expect((await cache.get()).models[0]?.id).toBe("second");
	});

	test("collapses concurrent cold callers onto one upstream call", async () => {
		const { cache, fetchCalls } = harness();

		const [a, b, c] = await Promise.all([
			cache.get(),
			cache.get(),
			cache.get(),
		]);

		expect(fetchCalls).toHaveLength(1);
		for (const snapshot of [a, b, c]) expect(snapshot.source).toBe("upstream");
	});

	test("falls back to the bundled registry when no account can answer", async () => {
		const { cache } = harness({ accounts: [] });

		const snapshot = await cache.get();

		expect(snapshot.source).toBe("bundled");
		expect(snapshot.fetchedAt).toBeNull();
		expect(snapshot.models.map((m) => m.id)).toContain(CLAUDE_MODEL_IDS.OPUS_5);
		expect(
			snapshot.models.find((m) => m.id === CLAUDE_MODEL_IDS.OPUS_5)
				?.displayName,
		).toBe("Claude Opus 5");
	});

	test("skips paused accounts and non-Anthropic providers", async () => {
		const { cache, fetchCalls } = harness({
			accounts: [
				account({ id: "codex-1", provider: "codex" }),
				account({ id: "paused-1", paused: true }),
			],
		});

		expect((await cache.get()).source).toBe("bundled");
		expect(fetchCalls).toHaveLength(0);
	});

	// Determinism: which account answers must not depend on database row order.
	test("tries accounts in id order", async () => {
		const { cache, fetchCalls } = harness({
			accounts: [account({ id: "zz" }), account({ id: "aa" })],
		});

		await cache.get();

		expect(fetchCalls[0].headers.get("authorization")).toBe("Bearer token-aa");
	});

	test("moves to the next account when one has no usable token", async () => {
		const { cache, fetchCalls } = harness({
			accounts: [account({ id: "aa" }), account({ id: "bb" })],
			getAccessToken: async (acct) => {
				if (acct.id === "aa") throw new Error("paused for reauth");
				return `token-${acct.id}`;
			},
		});

		expect((await cache.get()).source).toBe("upstream");
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0].headers.get("authorization")).toBe("Bearer token-bb");
	});

	for (const [label, malformed] of [
		["a non-JSON body", "not json at all"],
		["a body with no data array", JSON.stringify({ models: [] })],
		["an empty data array", body([])],
		["entries with no string id", body([{ display_name: "nameless" }])],
	] as const) {
		test(`treats ${label} as a failed fetch`, async () => {
			const { cache } = harness({
				responses: [{ status: 200, body: malformed }],
			});

			expect((await cache.get()).source).toBe("bundled");
		});
	}

	test("normalises entries whose optional fields are missing", async () => {
		const { cache } = harness({
			responses: [
				{
					status: 200,
					body: body([{ id: "claude-x", display_name: 42, created_at: null }]),
				},
			],
		});

		const snapshot = await cache.get();
		expect(snapshot.models).toEqual([
			{
				id: "claude-x",
				displayName: "claude-x",
				createdAt: "2025-01-01T00:00:00Z",
			},
		]);
	});

	test("treats a non-200 as a failed fetch", async () => {
		const { cache } = harness({
			responses: [{ status: 500, body: "boom" }],
		});

		expect((await cache.get()).source).toBe("bundled");
	});

	test("treats a network throw as a failed fetch", async () => {
		const { cache } = harness({ responses: [{ throws: "ECONNRESET" }] });

		expect((await cache.get()).source).toBe("bundled");
	});

	// One unreachable endpoint must not become a stream of authenticated calls.
	test("holds off on further attempts for the backoff window", async () => {
		const { cache, fetchCalls, advance } = harness({
			responses: [
				{ status: 500, body: "boom" },
				{ status: 200, body: ONE_MODEL },
			],
		});

		expect((await cache.get()).source).toBe("bundled");
		expect(fetchCalls).toHaveLength(1);

		advance(ANTHROPIC_MODEL_CATALOG_RETRY_AFTER_MS - 1);
		expect((await cache.get()).source).toBe("bundled");
		expect(fetchCalls).toHaveLength(1);

		advance(2);
		expect((await cache.get()).source).toBe("upstream");
		expect(fetchCalls).toHaveLength(2);
	});

	// An hours-old upstream list still describes the models correctly, including
	// ones this build has never heard of; the bundled list does not.
	test("keeps the previous copy when a refresh fails", async () => {
		const { cache, fetchCalls, advance } = harness({
			responses: [
				{ status: 200, body: body([{ id: "first" }]) },
				{ status: 500, body: "boom" },
			],
		});

		await cache.get();
		advance(ANTHROPIC_MODEL_CATALOG_TTL_MS + 1);

		// Stale-while-revalidate hands back the old copy, and the refresh behind it
		// fails without replacing it.
		expect((await cache.get()).models[0]?.id).toBe("first");
		await flushMicrotasks();
		expect(fetchCalls).toHaveLength(2);

		const after = await cache.get();
		expect(after.source).toBe("upstream");
		expect(after.models[0]?.id).toBe("first");
	});

	// The failure mode the deadline race exists for: getAccessToken accepts no
	// abort signal, so only the race can stop a hang there from wedging the cache.
	test("bounds a token acquisition that never settles", async () => {
		const { cache, fetchCalls } = harness({
			getAccessToken: () => new Promise<string>(() => {}),
			lookupBudgetMs: 5,
		});

		expect((await cache.get()).source).toBe("bundled");
		expect(fetchCalls).toHaveLength(0);

		// And the cache is still usable afterwards rather than stuck on the
		// abandoned attempt — the in-flight entry settled with the deadline.
		expect((await cache.get()).source).toBe("bundled");
	});

	test("bounds a request whose body never arrives", async () => {
		const { cache } = harness({
			responses: ["never-settles"],
			lookupBudgetMs: 5,
		});

		expect((await cache.get()).source).toBe("bundled");
	});

	// The budget starts when the lookup does, not when the account list arrives.
	// A database read that outlives it has already lost the outer race, so every
	// step after it — a token refresh, a bearer-authenticated call to Anthropic —
	// would be spent producing an answer nobody is waiting for.
	test("drops the attempt when listing accounts outlives the budget", async () => {
		let advance: (ms: number) => void = () => {};
		const h = harness({
			lookupBudgetMs: 5_000,
			listAccounts: async () => {
				advance(6_000);
				return [account()];
			},
		});
		advance = h.advance;

		const snapshot = await h.cache.get();

		expect(snapshot.source).toBe("bundled");
		expect(h.tokenCalls).toEqual([]);
		expect(h.fetchCalls).toHaveLength(0);
	});

	// The per-attempt loop needs its own ceiling: N accounts each returning at
	// their own timeout would otherwise cost N times the budget.
	test("stops trying accounts once the budget is spent", async () => {
		const { cache, fetchCalls } = harness({
			accounts: [
				account({ id: "a" }),
				account({ id: "b" }),
				account({ id: "c" }),
			],
			responses: [{ status: 500, body: "boom" }],
			fetchCostMs: ANTHROPIC_MODEL_CATALOG_LOOKUP_BUDGET_MS,
		});

		expect((await cache.get()).source).toBe("bundled");
		expect(fetchCalls).toHaveLength(1);
	});
});
