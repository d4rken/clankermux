/**
 * Boundary tests for handleProxy's INGRESS prologue — the stretch between the
 * function entry and account selection. These regions had no direct coverage:
 * the §0 internal-endpoint short-circuit, the §3a `/v1/messages` body
 * validation (including the deliberate non-JSON fallthrough), and the
 * cache-TTL promotion WIRING (as opposed to the decision table, which
 * `cache-warming-injection.test.ts` covers against a verbatim copy of the
 * decision block rather than through handleProxy).
 *
 * They pin CURRENT behavior so a later refactor of the function can be proven
 * behavior-preserving.
 */

import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
} from "bun:test";
import { usageCache } from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import { cacheBodyStore } from "../cache-body-store";
import type { ProxyContext } from "../handlers";
import { setForcedAccount } from "../handlers";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { resetOverloadHoldSlots } from "../overload-hold";
import { clearProviderOverloadCooldown } from "../provider-overload-cooldown";
import { sessionPromotionTracker } from "../session-promotion";

const ACCOUNT_ID = "acc-ingress";

async function callHandleProxy(req: Request, url: URL, ctx: ProxyContext) {
	const { handleProxy } = await import("../proxy");
	return handleProxy(req, url, ctx);
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: ACCOUNT_ID,
		name: "Ingress-main",
		provider: "anthropic",
		api_key: "test-key",
		refresh_token: null,
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
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	} as Account;
}

type ConfigOverrides = {
	cacheWarmingEnabled?: boolean;
	cacheWarmingMinTokens?: number;
};

function makeContext(
	accounts: Account[],
	config: ConfigOverrides = {},
): ProxyContext {
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
			getAccount: mock(
				async (id: string) => accounts.find((a) => a.id === id) ?? null,
			),
			getActiveComboForFamily: mock(async () => null),
			markAccountRateLimited: mock(async () => 1),
			markAccountRateLimitedDeadlineOnly: mock(async () => {}),
			saveRequest: mock(async () => {}),
			updateAccountUsage: mock(async () => {}),
			updateAccountRateLimitMeta: mock(async () => {}),
			resetConsecutiveRateLimits: mock(async () => {}),
			updateRequestUsage: mock(async () => {}),
			getAdapter: mock(() => ({
				run: mock(async () => {}),
				get: mock(async () => null),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getCacheWarmingEnabled: () => config.cacheWarmingEnabled === true,
			getCacheWarmingMinTokens: () => config.cacheWarmingMinTokens ?? 100_000,
			getStorePayloads: () => false,
		} as never,
		provider: {
			name: "anthropic",
			canHandle: () => true,
			buildUrl: () => "https://api.anthropic.com/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		} as never,
		requestRecorder: {
			begin: mock(() => {}),
			captureResponseChunk: mock(() => {}),
			finishTransport: mock(() => {}),
			attachUsageSummary: mock(() => {}),
			markUsageUnavailable: mock(() => {}),
			recordSynthetic: mock(() => {}),
			sweep: mock(() => {}),
			dispose: mock(() => {}),
		} as never,
	};
}

/**
 * Capture of one upstream (api.anthropic.com) request. Unrelated background
 * fetches — the models.dev pricing-catalog refresh fired by the usage
 * finalizer — are shunted to a 500 and never recorded here, so call counts and
 * body assertions stay order-independent across the suite (same rationale as
 * `upstreamOnlyFetch` in overload-hold.test.ts).
 */
type UpstreamCall = { url: string; body: Uint8Array; apiKey: string | null };

function upstreamOnlyFetch(
	calls: UpstreamCall[],
	handler: (call: UpstreamCall) => Response | Promise<Response>,
): typeof globalThis.fetch {
	return mock(async (input: Request | string | URL, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		if (!url.includes("api.anthropic.com")) {
			return new Response("unavailable", { status: 500 });
		}
		let bytes = new Uint8Array(0);
		let apiKey: string | null = null;
		if (input instanceof Request) {
			apiKey = input.headers.get("x-api-key");
			bytes = new Uint8Array(await input.arrayBuffer());
		} else if (init?.body) {
			bytes = new Uint8Array(
				await new Response(init.body as BodyInit).arrayBuffer(),
			);
		}
		const call: UpstreamCall = { url, body: bytes, apiKey };
		calls.push(call);
		return handler(call);
	}) as never;
}

function ok200(model: string) {
	return new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			model,
			stop_reason: "end_turn",
			usage: { input_tokens: 10, output_tokens: 5 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

const MODEL = "claude-sonnet-4-5";

describe("handleProxy ingress boundary", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeAll(async () => {
		await import("../proxy");
	});

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		setForcedAccount(null);
		cacheBodyStore.setEnabled(false);
		sessionPromotionTracker.setMode("off");
		sessionPromotionTracker.clear();
		clearProviderOverloadCooldown();
		resetOverloadHoldSlots();
		resetRateLimitProbeGatesForTests();
		usageCache.delete(ACCOUNT_ID);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		setForcedAccount(null);
		cacheBodyStore.setEnabled(false);
		sessionPromotionTracker.setMode("off");
		sessionPromotionTracker.clear();
		clearProviderOverloadCooldown();
		resetOverloadHoldSlots();
		resetRateLimitProbeGatesForTests();
		usageCache.delete(ACCOUNT_ID);
	});

	describe("§0 internal-endpoint short-circuit", () => {
		for (const pathname of [
			"/api/event_logging/batch",
			"/api/system/package-manager",
		]) {
			it(`answers ${pathname} locally with 200 {success:true}, no upstream, no recorder`, async () => {
				const calls: UpstreamCall[] = [];
				globalThis.fetch = upstreamOnlyFetch(calls, () => ok200(MODEL));

				const ctx = makeContext([makeAccount()]);
				const recorder = ctx.requestRecorder as unknown as Record<
					string,
					ReturnType<typeof mock>
				>;

				const res = await callHandleProxy(
					new Request(`https://proxy.local${pathname}`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ events: [{ name: "x" }] }),
					}),
					new URL(`https://proxy.local${pathname}`),
					ctx,
				);

				expect(res.status).toBe(200);
				expect(res.headers.get("Content-Type")).toBe("application/json");
				expect(await res.json()).toEqual({ success: true });
				expect(calls).toHaveLength(0);
				expect(recorder.begin).not.toHaveBeenCalled();
				expect(recorder.recordSynthetic).not.toHaveBeenCalled();
				expect(recorder.finishTransport).not.toHaveBeenCalled();
			});
		}
	});

	describe("§3a /v1/messages body validation", () => {
		it("rejects a parseable body without `messages` with a 400 invalid_request_error", async () => {
			const calls: UpstreamCall[] = [];
			globalThis.fetch = upstreamOnlyFetch(calls, () => ok200(MODEL));

			const res = await callHandleProxy(
				new Request("https://proxy.local/v1/messages", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						model: MODEL,
						event_type: "tengu_api_query",
						event_data: { event_name: "startup" },
					}),
				}),
				new URL("https://proxy.local/v1/messages"),
				makeContext([makeAccount()]),
			);

			expect(res.status).toBe(400);
			expect(res.headers.get("Content-Type")).toBe("application/json");
			const body = (await res.json()) as {
				type: string;
				error: { type: string; message: string };
			};
			expect(body.type).toBe("error");
			expect(body.error.type).toBe("invalid_request_error");
			expect(body.error.message).toContain("messages: Field required");
			expect(calls).toHaveLength(0);
		});

		it("rejects a `messages` field that is present but not an array", async () => {
			const calls: UpstreamCall[] = [];
			globalThis.fetch = upstreamOnlyFetch(calls, () => ok200(MODEL));

			const res = await callHandleProxy(
				new Request("https://proxy.local/v1/messages", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ model: MODEL, messages: "hello" }),
				}),
				new URL("https://proxy.local/v1/messages"),
				makeContext([makeAccount()]),
			);

			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: { type: string } };
			expect(body.error.type).toBe("invalid_request_error");
			expect(calls).toHaveLength(0);
		});

		it("lets an UNPARSEABLE body fall through to normal routing, byte-identical", async () => {
			// A non-400 status alone would prove nothing (many paths return 200), so
			// the oracle is: exactly ONE upstream attempt happened AND it carried the
			// original bytes verbatim — i.e. the validator did not reject it and no
			// transform touched it.
			const raw = "this-is-not-json{{{";
			const calls: UpstreamCall[] = [];
			globalThis.fetch = upstreamOnlyFetch(calls, () => ok200(MODEL));

			const res = await callHandleProxy(
				new Request("https://proxy.local/v1/messages", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: raw,
				}),
				new URL("https://proxy.local/v1/messages"),
				makeContext([makeAccount()]),
			);

			expect(res.status).toBe(200);
			expect(calls).toHaveLength(1);
			expect(new TextDecoder().decode(calls[0].body)).toBe(raw);
		});
	});

	describe("§3b cache-TTL promotion wiring", () => {
		function sessionRequest(sessionId: string): Request {
			return new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-claude-code-session-id": sessionId,
				},
				body: JSON.stringify({
					model: MODEL,
					system: [
						{
							type: "text",
							text: "you are helpful",
							cache_control: { type: "ephemeral" },
						},
					],
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text: "hello there",
									cache_control: { type: "ephemeral" },
								},
							],
						},
					],
					max_tokens: 16,
				}),
			});
		}

		it('injects ttl:"1h" into the upstream body once the tracker promotes the session', async () => {
			// The tracker defaults to OFF; dynamic mode is the production mode that
			// promotes by turn count (PROMOTE_AFTER_TURNS = 3).
			sessionPromotionTracker.setMode("dynamic");
			const calls: UpstreamCall[] = [];
			globalThis.fetch = upstreamOnlyFetch(calls, () => ok200(MODEL));

			const ctx = makeContext([makeAccount()], {
				cacheWarmingEnabled: true,
				cacheWarmingMinTokens: 0,
			});
			const sessionId = "session-promotion-wiring";

			for (let turn = 0; turn < 3; turn++) {
				const res = await callHandleProxy(
					sessionRequest(sessionId),
					new URL("https://proxy.local/v1/messages"),
					ctx,
				);
				expect(res.status).toBe(200);
			}

			expect(calls).toHaveLength(3);
			const bodies = calls.map((c) => new TextDecoder().decode(c.body));
			// Turns 1 and 2 are below the promotion threshold — no injection.
			expect(bodies[0]).not.toContain('"ttl":"1h"');
			expect(bodies[1]).not.toContain('"ttl":"1h"');
			// Turn 3 promotes the session, so the body forwarded upstream carries the
			// 1h breakpoints (both the system block and the message block).
			expect(bodies[2]).toContain('"ttl":"1h"');
			const parsed = JSON.parse(bodies[2]) as {
				system: Array<{ cache_control: { ttl?: string } }>;
				messages: Array<{
					content: Array<{ cache_control: { ttl?: string } }>;
				}>;
			};
			expect(parsed.system[0].cache_control.ttl).toBe("1h");
			expect(parsed.messages[0].content[0].cache_control.ttl).toBe("1h");
			expect(sessionPromotionTracker.isPromoted(sessionId)).toBe(true);
		});

		it("does NOT inject when the cache-warming feature is disabled", async () => {
			sessionPromotionTracker.setMode("dynamic");
			const calls: UpstreamCall[] = [];
			globalThis.fetch = upstreamOnlyFetch(calls, () => ok200(MODEL));

			const ctx = makeContext([makeAccount()], {
				cacheWarmingEnabled: false,
				cacheWarmingMinTokens: 0,
			});
			const sessionId = "session-promotion-disabled";

			for (let turn = 0; turn < 3; turn++) {
				const res = await callHandleProxy(
					sessionRequest(sessionId),
					new URL("https://proxy.local/v1/messages"),
					ctx,
				);
				expect(res.status).toBe(200);
			}

			expect(calls).toHaveLength(3);
			for (const call of calls) {
				expect(new TextDecoder().decode(call.body)).not.toContain('"ttl":"1h"');
			}
			// The tracker was never even observed — the feature switch gates it.
			expect(sessionPromotionTracker.isPromoted(sessionId)).toBe(false);
		});
	});
});
