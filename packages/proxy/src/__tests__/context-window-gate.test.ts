import { describe, expect, it, mock } from "bun:test";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../handlers";
import { configureLiteralRoute } from "./fixtures/routing-harness";

mock.module("../inline-worker", () => ({
	EMBEDDED_WORKER_CODE: "",
}));

async function callHandleProxy(req: Request, url: URL, ctx: ProxyContext) {
	const { handleProxy } = await import("./fixtures/routing-harness");
	return handleProxy(req, url, ctx);
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "codex",
		api_key: null,
		refresh_token: null,
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	};
}

function makeContext(accounts: Account[]): ProxyContext {
	return {
		strategy: {
			select: (accs: Account[]) => {
				const now = Date.now();
				return accs.filter(
					(acc) =>
						!acc.paused &&
						(!acc.rate_limited_until || acc.rate_limited_until <= now),
				);
			},
		} as never,
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => null),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getCacheWarmingEnabled: () => false,
			getCacheWarmingMinTokens: () => 100_000,
		} as never,
		provider: {
			name: "codex",
			canHandle: () => true,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		requestRecorder: { recordSynthetic: mock(() => {}) } as never,
	};
}

/**
 * Create a request body whose JSON.stringify().length / 3.0 + max_tokens
 * exceeds the given window * SAFETY_MARGIN.
 */
function makeLargeRequest(targetEstimate: number): Request {
	// We need JSON.stringify(body).length / 3.0 + max_tokens >= targetEstimate.
	// Use max_tokens=0 and pad the content.
	// JSON overhead for the wrapper is small; pad the content string.
	const overhead = JSON.stringify({
		model: "claude-opus-4-7",
		messages: [{ role: "user", content: "" }],
		max_tokens: 16,
	}).length;
	// charCount / 3.0 >= targetEstimate - 16 (max_tokens)
	const neededChars = Math.ceil((targetEstimate - 16) * 3.0) - overhead + 10;
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "claude-opus-4-7",
			messages: [
				{ role: "user", content: "x".repeat(Math.max(0, neededChars)) },
			],
			max_tokens: 16,
		}),
	});
}

function makeSmallRequest(): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "claude-opus-4-7",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

describe("context-window gate", () => {
	it("reports Astra's 872K maximum when a request exceeds it", async () => {
		const account = makeAccount({
			model_mappings: JSON.stringify({ opus: "gpt-6-astra" }),
		});
		const ctx = makeContext([account]);
		await configureLiteralRoute(
			ctx,
			"claude-opus-4-7",
			account.id,
			"gpt-6-astra",
		);
		const response = await callHandleProxy(
			makeLargeRequest(900_000),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.error.type).toBe("context_window_exceeded");
		expect(body.error.message).toContain("gpt-6-astra caps at 872000");
		expect(body.error.excluded_backends[0].max_context_window).toBe(872_000);
	});

	it("returns 400 context_window_exceeded when request exceeds codex model window and no other backend available", async () => {
		// gpt-5.6-sol window = 272K, threshold = floor(272K * 0.97) = 263840
		const codexAccount = makeAccount({
			id: "codex-me",
			name: "Codex-me",
			provider: "codex",
		});

		const ctx = makeContext([codexAccount]);
		await configureLiteralRoute(
			ctx,
			"claude-opus-4-7",
			codexAccount.id,
			"gpt-5.6-sol",
		);
		// Request estimated above the 263840 threshold
		const req = makeLargeRequest(350_000);
		const response = await callHandleProxy(
			req,
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(400);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.type).toBe("error");
		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("context_window_exceeded");
		expect(typeof error.message).toBe("string");
		expect(error.message as string).toContain("gpt-5.6-sol");
		expect(error.estimated_tokens).toBeGreaterThan(0);
		expect(Array.isArray(error.excluded_backends)).toBe(true);
	});

	it("gates on the model actually sent, and cannot gate an unknown window", async () => {
		// The gate scores the target the route froze. With a literal rule to
		// gpt-5.6-sol (272K, threshold 263840) an oversized request is excluded —
		// sized past the FULL window so even the unmargined last resort rejects it.
		// With no rule the Codex account sends the Claude ID, whose window is not in
		// MODEL_CONTEXT_WINDOWS, and an unknown window may never exclude an account.
		const codexAccount = makeAccount({
			id: "codex-default",
			name: "Codex-default",
			provider: "codex",
		});

		const routed = makeContext([codexAccount]);
		await configureLiteralRoute(
			routed,
			"claude-opus-4-7",
			codexAccount.id,
			"gpt-5.6-sol",
		);
		const response = await callHandleProxy(
			makeLargeRequest(500_000),
			new URL("https://proxy.local/v1/messages"),
			routed,
		);

		expect(response.status).toBe(400);
		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("context_window_exceeded");
		expect(error.message as string).toContain("gpt-5.6-sol");

		// With no rule the account sends the Claude ID, whose window is unknown.
		// The request then fails for its own reasons (this account has no
		// credentials), and HOW it fails is not the claim — the claim is that the
		// gate was not what stopped it. Both shapes of ending, a response and a
		// throw, are folded into one string so the assertion is unconditional: an
		// unrelated failure can no longer skip it.
		const unrouted = makeContext([codexAccount]);
		const outcome = await callHandleProxy(
			makeLargeRequest(500_000),
			new URL("https://proxy.local/v1/messages"),
			unrouted,
		).then(
			async (response) =>
				[
					response.status,
					response.headers.get("x-clankermux-pool-status") ?? "",
					await response.text(),
				].join(" "),
			(error: unknown) => String((error as Error)?.message ?? error),
		);

		expect(outcome).not.toContain("context_window_exceeded");
		expect(outcome).not.toContain("context-window-exceeded");
	});

	it("returns x-clankermux-pool-status: context-window-exceeded header", async () => {
		const codexAccount = makeAccount({
			id: "codex-me",
			name: "Codex-me",
			provider: "codex",
		});

		const ctx = makeContext([codexAccount]);
		await configureLiteralRoute(
			ctx,
			"claude-opus-4-7",
			codexAccount.id,
			"gpt-5.5",
		);
		const req = makeLargeRequest(350_000);
		const response = await callHandleProxy(
			req,
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(400);
		expect(response.headers.get("x-clankermux-pool-status")).toBe(
			"context-window-exceeded",
		);
	});

	it("returns 503 pool_exhausted (not 400) when pool is empty for availability reasons, not size", async () => {
		// Paused account with a small request — pool is empty due to paused, not size
		const pausedAccount = makeAccount({
			id: "acc-paused",
			name: "paused-codex",
			provider: "codex",
			paused: true,
			pause_reason: "manual",
			model_mappings: JSON.stringify({ opus: "gpt-5.5" }),
		});

		const ctx = makeContext([pausedAccount]);
		const req = makeSmallRequest();
		const response = await callHandleProxy(
			req,
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(503);
		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("pool_exhausted");
	});

	it("does not gate non-codex accounts regardless of request size", async () => {
		// An anthropic-compatible account should never be excluded by the gate.
		// It will pass through the gate, attempt to proxy, and fail (no real
		// backend), throwing ServiceUnavailableError — that's fine, the point
		// is that we never get a 400 context_window_exceeded Response.
		const anthropicAccount = makeAccount({
			id: "anthropic-1",
			name: "anthropic-account",
			provider: "anthropic-compatible",
			model_mappings: null,
		});

		const ctx = makeContext([anthropicAccount]);
		const req = makeLargeRequest(999_999);

		let caughtError: unknown;
		let response: Response | null = null;
		try {
			response = await callHandleProxy(
				req,
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);
		} catch (err) {
			caughtError = err;
		}

		// Either it returns a non-400 response or throws a downstream error
		// — never a context_window_exceeded 400 from the gate.
		if (response) {
			expect(response.status).not.toBe(400);
		} else {
			// ServiceUnavailableError (or similar) from attempting to proxy
			expect(caughtError).toBeDefined();
			expect((caughtError as Error).message).not.toContain(
				"context_window_exceeded",
			);
		}
	});

	it("force-route header does NOT bypass the context-window gate", async () => {
		// Force-route to a codex account with oversized request
		const codexAccount = makeAccount({
			id: "codex-forced",
			name: "Codex-forced",
			provider: "codex",
		});

		const ctx = makeContext([codexAccount]);
		await configureLiteralRoute(
			ctx,
			"claude-opus-4-7",
			codexAccount.id,
			"gpt-5.5",
		);
		const largeReq = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-clankermux-account-id": "codex-forced",
			},
			body: JSON.stringify({
				model: "claude-opus-4-7",
				messages: [{ role: "user", content: "x".repeat(1_200_000) }],
				max_tokens: 16,
			}),
		});

		const response = await callHandleProxy(
			largeReq,
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// Should return 400 context_window_exceeded, NOT an upstream 400
		expect(response.status).toBe(400);
		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("context_window_exceeded");
	});

	it("gates a rule-routed codex account on the resolved literal target (not the family default)", async () => {
		// Account default mapping: opus→gpt-5.5 (272K, threshold 263840).
		// Combo slot overrides model to gpt-5.3-codex-spark (128K, threshold 124160).
		// A request estimated between 124160 and 263840 passes the family-default
		// gate but must be excluded by the literal route's smaller-window model.
		const codexAccount = makeAccount({
			id: "codex-combo",
			name: "Codex-combo",
			provider: "codex",
			model_mappings: JSON.stringify({ opus: "gpt-5.5" }),
		});

		const ctx = makeContext([codexAccount]);
		// Combo returns one slot overriding the model to gpt-5.3-codex-spark
		await configureLiteralRoute(
			ctx,
			"claude-opus-4-7",
			codexAccount.id,
			"gpt-5.3-codex-spark",
		);

		// Estimate ~150K (above 124160 threshold for gpt-5.3-codex-spark,
		// below 263840 threshold for gpt-5.5)
		const req = makeLargeRequest(150_000);
		const response = await callHandleProxy(
			req,
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// The literal route's gpt-5.3-codex-spark (128K) excludes the account → 400
		expect(response.status).toBe(400);
		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("context_window_exceeded");
		expect(error.message as string).toContain("gpt-5.3-codex-spark");
		const excluded = error.excluded_backends as Array<Record<string, unknown>>;
		expect(excluded[0]?.model).toBe("gpt-5.3-codex-spark");
	});

	it("does not gate a codex account when request is small enough", async () => {
		// gpt-5.5 window = 272K, threshold = 263840
		// A small request passes the gate, then attempts to proxy and fails
		// downstream (no real backend) — that's expected. The point is that
		// we never see a 400 context_window_exceeded from the gate.
		const codexAccount = makeAccount({
			id: "codex-me",
			name: "Codex-me",
			provider: "codex",
			model_mappings: JSON.stringify({ opus: "gpt-5.5" }),
		});

		const ctx = makeContext([codexAccount]);
		const req = makeSmallRequest();

		let caughtError: unknown;
		let response: Response | null = null;
		try {
			response = await callHandleProxy(
				req,
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);
		} catch (err) {
			caughtError = err;
		}

		if (response) {
			// If a response is returned, it must not be our gate error
			if (response.status === 400) {
				const body = (await response.json()) as Record<string, unknown>;
				const error = body.error as Record<string, unknown>;
				expect(error.type).not.toBe("context_window_exceeded");
			}
		} else {
			// Downstream failure is acceptable — we just confirm it's not gate-related
			expect(caughtError).toBeDefined();
			expect((caughtError as Error).message).not.toContain(
				"context_window_exceeded",
			);
		}
	});
});
