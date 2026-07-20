import { afterEach, describe, expect, it } from "bun:test";
import {
	CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_ENDPOINT,
	CODEX_RATE_LIMIT_RESET_CREDITS_ENDPOINT,
	CODEX_RESET_CREDITS_RETRY_MS,
	codexRateLimitResetCreditsCache,
	consumeCodexRateLimitResetCredit,
	fetchCodexRateLimitResetCredits,
	parseCodexRateLimitResetCreditConsumeResult,
	parseCodexRateLimitResetCredits,
} from "./rate-limit-reset-credits";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	codexRateLimitResetCreditsCache.clear();
});

describe("parseCodexRateLimitResetCredits", () => {
	it("parses the backend snake_case shape", () => {
		expect(
			parseCodexRateLimitResetCredits({
				available_count: 3,
				credits: [
					{
						id: "credit-1",
						reset_type: "codex_rate_limits",
						status: "available",
						granted_at: 1_782_935_292,
						expires_at: 1_785_527_292,
						title: "Full reset",
						description: "One free reset.",
					},
				],
			}),
		).toEqual({
			availableCount: 3,
			credits: [
				{
					id: "credit-1",
					resetType: "codexRateLimits",
					status: "available",
					grantedAt: 1_782_935_292,
					expiresAt: 1_785_527_292,
					title: "Full reset",
					description: "One free reset.",
				},
			],
		});
	});

	it("parses the app-server camelCase wrapper", () => {
		expect(
			parseCodexRateLimitResetCredits({
				rateLimitResetCredits: {
					availableCount: 2,
					credits: null,
				},
			}),
		).toEqual({ availableCount: 2, credits: null });
	});

	it("keeps the authoritative count when malformed detail rows are dropped", () => {
		expect(
			parseCodexRateLimitResetCredits({
				available_count: 4,
				credits: [{ id: "missing-granted-at" }],
			}),
		).toEqual({ availableCount: 4, credits: [] });
	});

	it("rejects missing or invalid available counts", () => {
		expect(parseCodexRateLimitResetCredits({ credits: [] })).toBeNull();
		expect(
			parseCodexRateLimitResetCredits({ available_count: -1, credits: [] }),
		).toBeNull();
	});
});

describe("fetchCodexRateLimitResetCredits", () => {
	it("performs only a GET and returns normalized reset metadata", async () => {
		let seenUrl = "";
		let seenInit: RequestInit | undefined;
		globalThis.fetch = (async (input, init) => {
			seenUrl = String(input);
			seenInit = init;
			return Response.json({ available_count: 1, credits: [] });
		}) as typeof fetch;

		const result = await fetchCodexRateLimitResetCredits("secret-token");

		expect(result).toEqual({ availableCount: 1, credits: [] });
		expect(seenUrl).toBe(CODEX_RATE_LIMIT_RESET_CREDITS_ENDPOINT);
		expect(seenInit?.method).toBe("GET");
		expect(new Headers(seenInit?.headers).get("authorization")).toBe(
			"Bearer secret-token",
		);
		expect(seenInit?.body).toBeUndefined();
	});

	it("forwards the ChatGPT workspace account id from the OAuth token", async () => {
		let seenHeaders = new Headers();
		globalThis.fetch = (async (_input, init) => {
			seenHeaders = new Headers(init?.headers);
			return Response.json({ available_count: 0, credits: [] });
		}) as typeof fetch;
		const payload = Buffer.from(
			JSON.stringify({
				"https://api.openai.com/auth": {
					chatgpt_account_id: "workspace-123",
				},
			}),
		).toString("base64url");

		await fetchCodexRateLimitResetCredits(`header.${payload}.signature`);

		expect(seenHeaders.get("chatgpt-account-id")).toBe("workspace-123");
	});

	it("returns null on a non-success response", async () => {
		globalThis.fetch = (async () =>
			new Response("nope", { status: 404 })) as typeof fetch;

		await expect(fetchCodexRateLimitResetCredits("token")).resolves.toBeNull();
	});
});

describe("parseCodexRateLimitResetCreditConsumeResult", () => {
	it("normalizes every backend outcome", () => {
		expect(
			parseCodexRateLimitResetCreditConsumeResult({
				code: "reset",
				windows_reset: 2,
			}),
		).toEqual({ outcome: "reset", windowsReset: 2 });
		expect(
			parseCodexRateLimitResetCreditConsumeResult({
				code: "nothing_to_reset",
			}),
		).toEqual({ outcome: "nothingToReset", windowsReset: 0 });
		expect(
			parseCodexRateLimitResetCreditConsumeResult({ code: "no_credit" }),
		).toEqual({ outcome: "noCredit", windowsReset: 0 });
		expect(
			parseCodexRateLimitResetCreditConsumeResult({
				code: "already_redeemed",
			}),
		).toEqual({ outcome: "alreadyRedeemed", windowsReset: 0 });
	});

	it("also accepts the normalized app-server response", () => {
		expect(
			parseCodexRateLimitResetCreditConsumeResult({
				outcome: "alreadyRedeemed",
				windowsReset: 0,
			}),
		).toEqual({ outcome: "alreadyRedeemed", windowsReset: 0 });
	});

	it("rejects unknown outcomes and invalid window counts", () => {
		expect(
			parseCodexRateLimitResetCreditConsumeResult({ code: "future_code" }),
		).toBeNull();
		expect(
			parseCodexRateLimitResetCreditConsumeResult({
				code: "reset",
				windows_reset: -1,
			}),
		).toBeNull();
	});
});

describe("consumeCodexRateLimitResetCredit", () => {
	it("posts the official payload and selected credit id", async () => {
		let seenUrl = "";
		let seenInit: RequestInit | undefined;
		globalThis.fetch = (async (input, init) => {
			seenUrl = String(input);
			seenInit = init;
			return Response.json({ code: "reset", windows_reset: 2 });
		}) as typeof fetch;

		const result = await consumeCodexRateLimitResetCredit("token", {
			idempotencyKey: "redeem-123",
			creditId: "credit-456",
		});

		expect(result).toEqual({ outcome: "reset", windowsReset: 2 });
		expect(seenUrl).toBe(CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_ENDPOINT);
		expect(seenInit?.method).toBe("POST");
		expect(new Headers(seenInit?.headers).get("authorization")).toBe(
			"Bearer token",
		);
		expect(new Headers(seenInit?.headers).get("content-type")).toBe(
			"application/json",
		);
		expect(JSON.parse(String(seenInit?.body))).toEqual({
			redeem_request_id: "redeem-123",
			credit_id: "credit-456",
		});
	});

	it("omits credit_id so OpenAI can select the next available reset", async () => {
		let seenBody = "";
		globalThis.fetch = (async (_input, init) => {
			seenBody = String(init?.body);
			return Response.json({ code: "nothing_to_reset", windows_reset: 0 });
		}) as typeof fetch;

		await expect(
			consumeCodexRateLimitResetCredit("token", {
				idempotencyKey: "redeem-next",
			}),
		).resolves.toEqual({ outcome: "nothingToReset", windowsReset: 0 });
		expect(JSON.parse(seenBody)).toEqual({
			redeem_request_id: "redeem-next",
		});
	});

	it("throws on transport and contract failures instead of inventing an outcome", async () => {
		globalThis.fetch = (async () =>
			new Response("unavailable", { status: 503 })) as typeof fetch;
		await expect(
			consumeCodexRateLimitResetCredit("token", {
				idempotencyKey: "redeem-failure",
			}),
		).rejects.toThrow("503");

		globalThis.fetch = (async () =>
			Response.json({ code: "unexpected" })) as typeof fetch;
		await expect(
			consumeCodexRateLimitResetCredit("token", {
				idempotencyKey: "redeem-contract",
			}),
		).rejects.toThrow("unrecognized payload");
	});
});

describe("codexRateLimitResetCreditsCache", () => {
	it("refreshes immediately once the next known credit expires", () => {
		const now = 1_800_000_000_000;
		codexRateLimitResetCreditsCache.set(
			"account",
			{
				availableCount: 1,
				credits: [
					{
						id: "credit",
						resetType: "codexRateLimits",
						status: "available",
						grantedAt: now / 1_000 - 60,
						expiresAt: now / 1_000 + 10,
						title: null,
						description: null,
					},
				],
			},
			now,
		);

		expect(
			codexRateLimitResetCreditsCache.needsRefresh("account", now + 9_000),
		).toBe(false);
		expect(
			codexRateLimitResetCreditsCache.needsRefresh("account", now + 10_000),
		).toBe(true);
	});

	it("backs off failed attempts when no cached value exists", () => {
		const now = 1_800_000_000_000;
		codexRateLimitResetCreditsCache.markAttempt("account", now);

		expect(
			codexRateLimitResetCreditsCache.needsRefresh("account", now + 1),
		).toBe(false);
		expect(
			codexRateLimitResetCreditsCache.needsRefresh(
				"account",
				now + CODEX_RESET_CREDITS_RETRY_MS,
			),
		).toBe(true);
	});
});
