import { describe, expect, it, mock } from "bun:test";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../handlers";

mock.module("../inline-worker", () => ({
	EMBEDDED_WORKER_CODE: "",
}));

async function callHandleProxy(req: Request, url: URL, ctx: ProxyContext) {
	const { handleProxy } = await import("../proxy");
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
			getSystemPromptCacheTtl1h: () => false,
		} as never,
		provider: {
			name: "codex",
			canHandle: () => true,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		usageWorker: { postMessage: mock(() => {}) } as never,
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
	it("returns 400 context_window_exceeded when request exceeds codex model window and no other backend available", async () => {
		// gpt-5.5 window = 400K, threshold = floor(400K * 0.85) = 340000
		const codexAccount = makeAccount({
			id: "codex-me",
			name: "Codex-me",
			provider: "codex",
			model_mappings: JSON.stringify({ opus: "gpt-5.5" }),
		});

		const ctx = makeContext([codexAccount]);
		// Request estimated above 340K tokens
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
		expect(error.message as string).toContain("gpt-5.5");
		expect(error.estimated_tokens).toBeGreaterThan(0);
		expect(Array.isArray(error.excluded_backends)).toBe(true);
	});

	it("returns x-clankermux-pool-status: context-window-exceeded header", async () => {
		const codexAccount = makeAccount({
			id: "codex-me",
			name: "Codex-me",
			provider: "codex",
			model_mappings: JSON.stringify({ opus: "gpt-5.5" }),
		});

		const ctx = makeContext([codexAccount]);
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
			model_mappings: JSON.stringify({ opus: "gpt-5.5" }),
		});

		const ctx = makeContext([codexAccount]);
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

	it("gates a combo-routed codex account on the slot's model override (not the family default)", async () => {
		// Account default mapping: opus→gpt-5.5 (400K, threshold 340K).
		// Combo slot overrides model to gpt-5.3-codex (200K, threshold 170K).
		// A request estimated between 170K and 340K passes the family-default
		// gate but must be excluded by the combo slot's smaller-window model.
		const codexAccount = makeAccount({
			id: "codex-combo",
			name: "Codex-combo",
			provider: "codex",
			model_mappings: JSON.stringify({ opus: "gpt-5.5" }),
		});

		const ctx = makeContext([codexAccount]);
		// Combo returns one slot overriding the model to gpt-5.3-codex
		(
			ctx.dbOps as unknown as {
				getActiveComboForFamily: ReturnType<typeof mock>;
			}
		).getActiveComboForFamily = mock(async () => ({
			name: "test-combo",
			slots: [
				{
					account_id: "codex-combo",
					model: "gpt-5.3-codex",
					enabled: true,
				},
			],
		}));

		// Estimate ~250K (above 170K threshold for gpt-5.3-codex,
		// below 340K threshold for gpt-5.5)
		const req = makeLargeRequest(250_000);
		const response = await callHandleProxy(
			req,
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// The combo slot's gpt-5.3-codex (200K) excludes the account → 400
		expect(response.status).toBe(400);
		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("context_window_exceeded");
		expect(error.message as string).toContain("gpt-5.3-codex");
		const excluded = error.excluded_backends as Array<Record<string, unknown>>;
		expect(excluded[0]?.model).toBe("gpt-5.3-codex");
	});

	it("does not gate a codex account when request is small enough", async () => {
		// gpt-5.5 window = 400K, threshold = 340000
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
