import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { getProvider } from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../handlers";
import {
	applyProviderOverloadCooldown,
	clearProviderOverloadCooldown,
	completeProviderOverloadProbe,
	getProviderOverloadSnapshot,
	getProviderOverloadUntil,
	inspectProviderOverload,
	isProviderOverloaded,
	type OverloadProbeToken,
	PROBE_LEASE_SAFETY_TTL_MS,
	tryAcquireProviderOverloadProbe,
} from "../provider-overload-cooldown";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "anthropic",
		api_key: "test-key",
		refresh_token: "",
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		consecutive_rate_limits: 0,
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
		peak_hours_pause_enabled: false,
		codex_auto_apply_reset_credits_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	};
}

function makeRequest(headers: Record<string, string> = {}): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

function makeContext(accounts: Account[]): ProxyContext {
	return {
		strategy: {
			select: mock((allAccounts: Account[]) => allAccounts),
		},
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => null),
			updateAccountUsage: mock(async () => undefined),
			updateAccountRateLimitMeta: mock(async () => undefined),
			updateAccountTokens: mock(async () => undefined),
			updateRequestUsage: mock(async () => undefined),
			resetAccountSession: mock(async () => undefined),
			markAccountRateLimited: mock(async () => 1),
			markAccountRateLimitedDeadlineOnly: mock(async () => {}),
			getAdapter: mock(() => ({
				run: mock(async () => undefined),
				get: mock(async () => null),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getCacheWarmingEnabled: () => false,
			getCacheWarmingMinTokens: () => 100_000,
			getStorePayloads: () => true,
		} as never,
		provider: getProvider("anthropic") as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => undefined) } as never,
		requestRecorder: {
			begin: mock(() => undefined),
			captureResponseChunk: mock(() => undefined),
			finishTransport: mock(() => undefined),
			attachUsageSummary: mock(() => undefined),
			markUsageUnavailable: mock(() => undefined),
			recordSynthetic: mock(() => undefined),
			sweep: mock(() => undefined),
			dispose: mock(() => undefined),
		} as never,
	};
}

describe("provider overload cooldown", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearProviderOverloadCooldown();
	});

	it("skips remaining Anthropic accounts after official Anthropic 529 and falls back cross-provider", async () => {
		const anthropicA = makeAccount({
			id: "anthropic-a",
			name: "Anthropic A",
			provider: "anthropic",
			api_key: "anthropic-key-a",
		});
		const anthropicB = makeAccount({
			id: "anthropic-b",
			name: "Anthropic B",
			provider: "anthropic",
			api_key: "anthropic-key-b",
		});
		const consoleAccount = makeAccount({
			id: "console-a",
			name: "Console A",
			provider: "claude-console-api",
			api_key: "console-key",
		});
		const fallback = makeAccount({
			id: "openai-fallback",
			name: "OpenAI fallback",
			provider: "openai-compatible",
			api_key: "fallback-key",
			custom_endpoint: "https://fallback.example/v1",
			model_mappings: JSON.stringify({ sonnet: "gpt-4o" }),
		});
		const calls: string[] = [];

		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request =
				input instanceof Request ? input : new Request(String(input));

			// Usage cost is now computed inline on the main thread (the worker was
			// retired), so estimateCostUSD's pricing-catalogue fetch (models.dev)
			// goes through this mock. Stub it WITHOUT counting it so `calls` still
			// reflects only the proxied upstream-provider attempts.
			if (request.url.includes("models.dev")) {
				return new Response("{}", {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}

			calls.push(request.url);

			if (request.url.includes("api.anthropic.com")) {
				return new Response(
					'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
					{
						status: 529,
						headers: {
							"content-type": "application/json",
							"retry-after": "60",
						},
					},
				);
			}

			return new Response(
				JSON.stringify({
					id: "chatcmpl_1",
					object: "chat.completion",
					model: "gpt-4o",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: "fallback ok" },
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});

		const ctx = makeContext([anthropicA, anthropicB, consoleAccount, fallback]);
		const { handleProxy } = await import("../proxy");
		const response = await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(200);
		expect(calls).toHaveLength(2);
		expect(calls[0]).toContain("api.anthropic.com");
		expect(calls[1]).toContain("fallback.example");
		expect(isProviderOverloaded("anthropic")).toBe(true);
		expect(isProviderOverloaded("claude-console-api")).toBe(true);
		expect(anthropicA.rate_limited_until).toBeNull();
		expect(anthropicB.rate_limited_until).toBeNull();
		expect(consoleAccount.rate_limited_until).toBeNull();
	});

	it("forwards the first 529 without trying another same-upstream Anthropic account when no cross-provider fallback exists", async () => {
		const anthropicA = makeAccount({
			id: "anthropic-a",
			name: "Anthropic A",
			provider: "anthropic",
			api_key: "anthropic-key-a",
		});
		const anthropicB = makeAccount({
			id: "anthropic-b",
			name: "Anthropic B",
			provider: "anthropic",
			api_key: "anthropic-key-b",
		});
		const calls: string[] = [];

		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request =
				input instanceof Request ? input : new Request(String(input));
			calls.push(request.url);
			return new Response(
				'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
				{
					status: 529,
					headers: {
						"content-type": "application/json",
						"retry-after": "60",
					},
				},
			);
		});

		const ctx = makeContext([anthropicA, anthropicB]);
		const { handleProxy } = await import("../proxy");
		const response = await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(529);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("api.anthropic.com");
		expect(isProviderOverloaded("anthropic")).toBe(true);
		expect(anthropicA.rate_limited_until).toBeNull();
		expect(anthropicB.rate_limited_until).toBeNull();
	});

	it("returns and records 529 during an active official Anthropic cooldown when no cross-provider account remains", async () => {
		const now = Date.UTC(2026, 4, 29, 12, 0, 0);
		const originalDateNow = Date.now;
		const calls: string[] = [];

		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request =
				input instanceof Request ? input : new Request(String(input));
			calls.push(request.url);
			return new Response("unexpected", { status: 500 });
		});

		Date.now = () => now;
		try {
			// Beyond the 120s transparent-hold budget → the immediate 529 terminal
			// (a within-budget cooldown would hold the connection instead — Stage D).
			applyProviderOverloadCooldown("anthropic", now + 200_000);
			const ctx = makeContext([
				makeAccount({ id: "anthropic-a", provider: "anthropic" }),
				makeAccount({ id: "console-a", provider: "claude-console-api" }),
			]);
			const recordSynthetic = (
				ctx.requestRecorder as { recordSynthetic: ReturnType<typeof mock> }
			).recordSynthetic;
			const { handleProxy } = await import("../proxy");
			const response = await handleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);

			expect(response.status).toBe(529);
			expect(response.headers.get("Retry-After")).toBe("200");
			const body = (await response.json()) as {
				error: { type: string; providers: string[] };
			};
			expect(body.error.type).toBe("overloaded_error");
			expect(body.error.providers).toEqual(["anthropic"]);
			expect(calls).toHaveLength(0);
			// Synthetic 529 rows are now persisted via the main-thread recorder
			// (recordSynthetic), not by posting start/end to the slim worker (B1).
			expect(recordSynthetic).toHaveBeenCalledTimes(1);
			expect(recordSynthetic.mock.calls[0][0]).toMatchObject({
				accountId: null,
				responseStatus: 529,
				providerName: "anthropic",
			});
			expect(recordSynthetic.mock.calls[0][1]).toBe("error");
		} finally {
			Date.now = originalDateNow;
		}
	});

	it("does not record synthetic provider-overload 529s for auto-refresh probes", async () => {
		const now = Date.UTC(2026, 4, 29, 12, 0, 0);
		const originalDateNow = Date.now;

		Date.now = () => now;
		try {
			applyProviderOverloadCooldown("anthropic", now + 60_000);
			const ctx = makeContext([
				makeAccount({ id: "anthropic-a", provider: "anthropic" }),
			]);
			const recordSynthetic = (
				ctx.requestRecorder as { recordSynthetic: ReturnType<typeof mock> }
			).recordSynthetic;
			const { handleProxy } = await import("../proxy");
			const response = await handleProxy(
				makeRequest({ "x-clankermux-auto-refresh": "true" }),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);

			expect(response.status).toBe(529);
			expect(recordSynthetic).not.toHaveBeenCalled();
		} finally {
			Date.now = originalDateNow;
		}
	});

	it("caps long overload reset headers, extends cooldowns, and expires the shared Anthropic group", () => {
		let now = Date.UTC(2026, 4, 29, 12, 0, 0);
		const originalDateNow = Date.now;

		Date.now = () => now;
		try {
			const cappedUntil = applyProviderOverloadCooldown(
				"anthropic",
				now + 60 * 60_000,
			);
			expect(cappedUntil).toBe(now + 5 * 60_000);
			expect(getProviderOverloadUntil("claude-console-api")).toBe(cappedUntil);

			const shorterUntil = applyProviderOverloadCooldown(
				"claude-console-api",
				now + 60_000,
			);
			expect(shorterUntil).toBe(cappedUntil);

			now = cappedUntil + 1;
			expect(isProviderOverloaded("anthropic")).toBe(false);
			expect(getProviderOverloadUntil("claude-console-api")).toBeNull();
		} finally {
			Date.now = originalDateNow;
		}
	});
});

describe("family-scoped overload breaker", () => {
	const BASE = Date.UTC(2026, 6, 21, 12, 0, 0);
	let now: number;
	const originalDateNow = Date.now;

	beforeEach(() => {
		now = BASE;
		Date.now = () => now;
		clearProviderOverloadCooldown();
	});

	afterEach(() => {
		Date.now = originalDateNow;
		clearProviderOverloadCooldown();
	});

	function expectAdmitted(
		admission: ReturnType<typeof tryAcquireProviderOverloadProbe>,
	): OverloadProbeToken | null {
		expect(admission.admitted).toBe(true);
		if (!admission.admitted) throw new Error("unreachable");
		return admission.token;
	}

	describe("family keying", () => {
		it("haiku trip gates haiku but not sonnet/opus/fable on the same provider", () => {
			const until = applyProviderOverloadCooldown(
				"anthropic",
				now + 60_000,
				"claude-haiku-4-5",
			);
			expect(
				getProviderOverloadUntil("anthropic", now, "claude-haiku-4-5"),
			).toBe(until);
			expect(
				getProviderOverloadUntil("anthropic", now, "claude-sonnet-4-5"),
			).toBeNull();
			expect(
				getProviderOverloadUntil("anthropic", now, "claude-opus-4-8"),
			).toBeNull();
			expect(
				getProviderOverloadUntil("anthropic", now, "claude-fable-5"),
			).toBeNull();
			expect(isProviderOverloaded("anthropic", now, "claude-haiku-4-5")).toBe(
				true,
			);
			expect(isProviderOverloaded("anthropic", now, "claude-sonnet-4-5")).toBe(
				false,
			);
		});

		it("all official Anthropic aliases share the same family buckets", () => {
			const until = applyProviderOverloadCooldown(
				"anthropic",
				now + 60_000,
				"claude-haiku-4-5",
			);
			for (const alias of ["anthropic", "claude-console-api", "claude-oauth"]) {
				expect(getProviderOverloadUntil(alias, now, "claude-3-5-haiku")).toBe(
					until,
				);
				expect(
					getProviderOverloadUntil(alias, now, "claude-sonnet-4-5"),
				).toBeNull();
			}
		});
	});

	describe("provider-wide fallback bucket", () => {
		it("null/unresolvable model trips gate every family read", () => {
			const until = applyProviderOverloadCooldown("anthropic", now + 60_000);
			expect(
				getProviderOverloadUntil("anthropic", now, "claude-haiku-4-5"),
			).toBe(until);
			expect(
				getProviderOverloadUntil("anthropic", now, "claude-sonnet-4-5"),
			).toBe(until);
			expect(getProviderOverloadUntil("anthropic", now)).toBe(until);

			clearProviderOverloadCooldown();
			const until2 = applyProviderOverloadCooldown(
				"anthropic",
				now + 60_000,
				"gpt-4o", // no Claude family resolves — falls back to provider-wide
			);
			expect(getProviderOverloadUntil("anthropic", now, "claude-fable-5")).toBe(
				until2,
			);
		});
	});

	describe("read max semantics", () => {
		it("family read = max(family bucket, provider-wide bucket)", () => {
			const familyUntil = applyProviderOverloadCooldown(
				"anthropic",
				now + 240_000,
				"claude-haiku-4-5",
			);
			const wideUntil = applyProviderOverloadCooldown(
				"anthropic",
				now + 90_000,
			);
			expect(familyUntil).toBeGreaterThan(wideUntil);
			expect(
				getProviderOverloadUntil("anthropic", now, "claude-haiku-4-5"),
			).toBe(familyUntil);
			// Sonnet has no family bucket — only the provider-wide one applies.
			expect(
				getProviderOverloadUntil("anthropic", now, "claude-sonnet-4-5"),
			).toBe(wideUntil);
		});

		it("no-model read = max across all open buckets", () => {
			applyProviderOverloadCooldown(
				"anthropic",
				now + 90_000,
				"claude-sonnet-4-5",
			);
			const haikuUntil = applyProviderOverloadCooldown(
				"anthropic",
				now + 240_000,
				"claude-haiku-4-5",
			);
			expect(getProviderOverloadUntil("anthropic", now)).toBe(haikuUntil);
			expect(isProviderOverloaded("anthropic", now)).toBe(true);
		});
	});

	describe("provider-wide trip does not absorb family deadlines", () => {
		it("keeps the provider-wide bucket's own deadline shorter than an existing family deadline", () => {
			const haikuUntil = applyProviderOverloadCooldown(
				"anthropic",
				now + 5 * 60_000,
				"claude-haiku-4-5",
			);
			// Provider-wide trip with no reset hint → 60s default, NOT promoted
			// to the longer haiku deadline.
			const wideUntil = applyProviderOverloadCooldown("anthropic");
			expect(wideUntil).toBe(now + 60_000);
			expect(
				getProviderOverloadUntil("anthropic", now, "claude-sonnet-4-5"),
			).toBe(wideUntil);
			expect(
				getProviderOverloadUntil("anthropic", now, "claude-haiku-4-5"),
			).toBe(haikuUntil);
		});
	});

	describe("extend-never-shorten, cap, default", () => {
		it("re-trip with a shorter reset never shortens the same bucket", () => {
			const first = applyProviderOverloadCooldown(
				"anthropic",
				now + 120_000,
				"claude-haiku-4-5",
			);
			const second = applyProviderOverloadCooldown(
				"anthropic",
				now + 60_000,
				"claude-haiku-4-5",
			);
			expect(second).toBe(first);
		});

		it("caps at 5 minutes and defaults to 60s per family bucket", () => {
			const capped = applyProviderOverloadCooldown(
				"anthropic",
				now + 60 * 60_000,
				"claude-haiku-4-5",
			);
			expect(capped).toBe(now + 5 * 60_000);
			const defaulted = applyProviderOverloadCooldown(
				"anthropic",
				undefined,
				"claude-sonnet-4-5",
			);
			expect(defaulted).toBe(now + 60_000);
		});
	});

	describe("half-open transition", () => {
		it("entry persists past expiry: until reads null, inspect says half-open", () => {
			const until = applyProviderOverloadCooldown(
				"anthropic",
				now + 60_000,
				"claude-haiku-4-5",
			);
			expect(
				inspectProviderOverload("anthropic", "claude-haiku-4-5", now),
			).toEqual({ state: "open", until, probeActive: false });

			now = until + 1;
			expect(
				getProviderOverloadUntil("anthropic", now, "claude-haiku-4-5"),
			).toBeNull();
			expect(isProviderOverloaded("anthropic", now, "claude-haiku-4-5")).toBe(
				false,
			);
			// Inspect is pure — repeated calls neither consume nor mutate.
			for (let i = 0; i < 3; i++) {
				expect(
					inspectProviderOverload("anthropic", "claude-haiku-4-5", now),
				).toEqual({ state: "half-open", until: null, probeActive: false });
			}
			// Untripped families stay closed.
			expect(
				inspectProviderOverload("anthropic", "claude-sonnet-4-5", now),
			).toEqual({ state: "closed", until: null, probeActive: false });
		});
	});

	describe("single-flight probe admission", () => {
		it("closed bucket admits without a token", () => {
			const admission = tryAcquireProviderOverloadProbe(
				"anthropic",
				"claude-haiku-4-5",
				now,
			);
			expect(admission).toEqual({ admitted: true, token: null });
		});

		it("open bucket refuses admission with reason open", () => {
			const until = applyProviderOverloadCooldown(
				"anthropic",
				now + 60_000,
				"claude-haiku-4-5",
			);
			const admission = tryAcquireProviderOverloadProbe(
				"anthropic",
				"claude-haiku-4-5",
				now,
			);
			expect(admission).toEqual({ admitted: false, reason: "open", until });
		});

		it("half-open admits exactly one probe; second is probe-active; abandoned frees it", () => {
			const until = applyProviderOverloadCooldown(
				"anthropic",
				now + 60_000,
				"claude-haiku-4-5",
			);
			now = until + 1;

			const token = expectAdmitted(
				tryAcquireProviderOverloadProbe("anthropic", "claude-haiku-4-5", now),
			);
			expect(token).not.toBeNull();
			expect(
				inspectProviderOverload("anthropic", "claude-haiku-4-5", now)
					.probeActive,
			).toBe(true);

			const second = tryAcquireProviderOverloadProbe(
				"anthropic",
				"claude-haiku-4-5",
				now,
			);
			expect(second).toEqual({
				admitted: false,
				reason: "probe-active",
				until: null,
			});

			completeProviderOverloadProbe(token, "abandoned");
			const third = tryAcquireProviderOverloadProbe(
				"anthropic",
				"claude-haiku-4-5",
				now,
			);
			expect(third.admitted).toBe(true);
		});

		it("probe on one family does not block probes on a sibling family", () => {
			applyProviderOverloadCooldown(
				"anthropic",
				now + 60_000,
				"claude-haiku-4-5",
			);
			applyProviderOverloadCooldown(
				"anthropic",
				now + 60_000,
				"claude-sonnet-4-5",
			);
			now += 61_000;

			const haikuToken = expectAdmitted(
				tryAcquireProviderOverloadProbe("anthropic", "claude-haiku-4-5", now),
			);
			expect(haikuToken).not.toBeNull();
			const sonnetAdmission = tryAcquireProviderOverloadProbe(
				"anthropic",
				"claude-sonnet-4-5",
				now,
			);
			expect(sonnetAdmission.admitted).toBe(true);
		});

		it("half-open provider-wide bucket gates a family probe via a composite token", () => {
			applyProviderOverloadCooldown("anthropic", now + 60_000); // provider-wide
			applyProviderOverloadCooldown(
				"anthropic",
				now + 60_000,
				"claude-haiku-4-5",
			);
			now += 61_000;

			const token = expectAdmitted(
				tryAcquireProviderOverloadProbe("anthropic", "claude-haiku-4-5", now),
			);
			expect(token).not.toBeNull();
			// The provider-wide lease is held by the haiku probe, so a sonnet
			// probe (whose relevant set includes the provider-wide bucket) waits.
			const sonnetAdmission = tryAcquireProviderOverloadProbe(
				"anthropic",
				"claude-sonnet-4-5",
				now,
			);
			expect(sonnetAdmission).toEqual({
				admitted: false,
				reason: "probe-active",
				until: null,
			});

			// Success clears both leased buckets.
			completeProviderOverloadProbe(token, "recovered");
			expect(
				inspectProviderOverload("anthropic", "claude-haiku-4-5", now).state,
			).toBe("closed");
			expect(inspectProviderOverload("anthropic", undefined, now).state).toBe(
				"closed",
			);
		});
	});

	describe("probe completion outcomes", () => {
		it("recovered deletes the bucket", () => {
			applyProviderOverloadCooldown(
				"anthropic",
				now + 60_000,
				"claude-haiku-4-5",
			);
			now += 61_000;
			const token = expectAdmitted(
				tryAcquireProviderOverloadProbe("anthropic", "claude-haiku-4-5", now),
			);
			completeProviderOverloadProbe(token, "recovered");
			expect(
				inspectProviderOverload("anthropic", "claude-haiku-4-5", now),
			).toEqual({ state: "closed", until: null, probeActive: false });
			// Idempotent — completing again must not throw.
			completeProviderOverloadProbe(token, "recovered");
		});

		it("late recovered after a re-trip is a no-op (generation bump)", () => {
			applyProviderOverloadCooldown(
				"anthropic",
				now + 60_000,
				"claude-haiku-4-5",
			);
			now += 61_000;
			const staleToken = expectAdmitted(
				tryAcquireProviderOverloadProbe("anthropic", "claude-haiku-4-5", now),
			);

			// Re-trip while the probe is in flight — bumps the generation and
			// clears the lease.
			const until = applyProviderOverloadCooldown(
				"anthropic",
				now + 60_000,
				"claude-haiku-4-5",
			);
			completeProviderOverloadProbe(staleToken, "recovered");
			// Bucket stays open — the stale success must not clear it.
			expect(
				getProviderOverloadUntil("anthropic", now, "claude-haiku-4-5"),
			).toBe(until);

			// And once half-open again, a fresh probe can be acquired.
			now = until + 1;
			expect(
				tryAcquireProviderOverloadProbe("anthropic", "claude-haiku-4-5", now)
					.admitted,
			).toBe(true);
		});

		it("reopened releases the lease and leaves the bucket state alone", () => {
			applyProviderOverloadCooldown(
				"anthropic",
				now + 60_000,
				"claude-haiku-4-5",
			);
			now += 61_000;
			const token = expectAdmitted(
				tryAcquireProviderOverloadProbe("anthropic", "claude-haiku-4-5", now),
			);
			// The failure site re-trips separately; "reopened" itself only
			// releases the lease.
			completeProviderOverloadProbe(token, "reopened");
			expect(
				inspectProviderOverload("anthropic", "claude-haiku-4-5", now),
			).toEqual({ state: "half-open", until: null, probeActive: false });
		});
	});

	describe("clear invalidates outstanding tokens", () => {
		it("late completion after clear no-ops safely", () => {
			applyProviderOverloadCooldown(
				"anthropic",
				now + 60_000,
				"claude-haiku-4-5",
			);
			now += 61_000;
			const staleToken = expectAdmitted(
				tryAcquireProviderOverloadProbe("anthropic", "claude-haiku-4-5", now),
			);
			clearProviderOverloadCooldown("anthropic");
			expect(() =>
				completeProviderOverloadProbe(staleToken, "recovered"),
			).not.toThrow();

			// A fresh trip after the clear must not be deleted by the stale token.
			const until = applyProviderOverloadCooldown(
				"anthropic",
				now + 60_000,
				"claude-haiku-4-5",
			);
			completeProviderOverloadProbe(staleToken, "recovered");
			expect(
				getProviderOverloadUntil("anthropic", now, "claude-haiku-4-5"),
			).toBe(until);
		});

		it("provider clear removes family and provider-wide buckets for all aliases", () => {
			applyProviderOverloadCooldown(
				"anthropic",
				now + 60_000,
				"claude-haiku-4-5",
			);
			applyProviderOverloadCooldown("claude-console-api", now + 60_000);
			clearProviderOverloadCooldown("claude-oauth");
			expect(getProviderOverloadUntil("anthropic", now)).toBeNull();
			expect(getProviderOverloadSnapshot("anthropic", now)).toEqual([]);
		});
	});

	describe("probe lease safety TTL", () => {
		it("an expired lease frees the bucket for a new probe; stale completion no-ops", () => {
			applyProviderOverloadCooldown(
				"anthropic",
				now + 60_000,
				"claude-haiku-4-5",
			);
			now += 61_000;
			const staleToken = expectAdmitted(
				tryAcquireProviderOverloadProbe("anthropic", "claude-haiku-4-5", now),
			);

			// Owner dies without completing; past the TTL the lease is
			// treated as released.
			now += PROBE_LEASE_SAFETY_TTL_MS + 1;
			expect(
				inspectProviderOverload("anthropic", "claude-haiku-4-5", now)
					.probeActive,
			).toBe(false);
			const freshToken = expectAdmitted(
				tryAcquireProviderOverloadProbe("anthropic", "claude-haiku-4-5", now),
			);
			expect(freshToken).not.toBeNull();

			// The stale token was superseded — its completion must not clear
			// the bucket out from under the fresh probe.
			completeProviderOverloadProbe(staleToken, "recovered");
			expect(
				inspectProviderOverload("anthropic", "claude-haiku-4-5", now).state,
			).toBe("half-open");

			completeProviderOverloadProbe(freshToken, "recovered");
			expect(
				inspectProviderOverload("anthropic", "claude-haiku-4-5", now).state,
			).toBe("closed");
		});
	});

	describe("snapshot", () => {
		it("reports open and half-open buckets with family attribution", () => {
			const haikuUntil = applyProviderOverloadCooldown(
				"anthropic",
				now + 240_000,
				"claude-haiku-4-5",
			);
			applyProviderOverloadCooldown(
				"anthropic",
				now + 30_000,
				"claude-sonnet-4-5",
			);
			applyProviderOverloadCooldown("anthropic", now + 30_000);
			now += 31_000; // sonnet + provider-wide are now half-open, haiku still open

			const snapshot = getProviderOverloadSnapshot("anthropic", now);
			expect(snapshot).toHaveLength(3);
			const byFamily = new Map(snapshot.map((s) => [s.family, s]));
			expect(byFamily.get("haiku")).toEqual({
				family: "haiku",
				state: "open",
				until: haikuUntil,
				probeActive: false,
			});
			expect(byFamily.get("sonnet")).toEqual({
				family: "sonnet",
				state: "half-open",
				until: null,
				probeActive: false,
			});
			expect(byFamily.get(null)).toEqual({
				family: null,
				state: "half-open",
				until: null,
				probeActive: false,
			});
		});
	});
});
