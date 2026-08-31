/**
 * Boundary tests for the WIRING inside handleProxy's request-ingest prologue —
 * the stretch between the function entry and account selection that
 * `proxy-ingress-boundary.test.ts` does not already pin.
 *
 * Each region below is covered through `handleProxy` itself (never by calling
 * the helpers directly), so the assertions survive a refactor that moves the
 * code out of the function:
 *
 *   - §3c tier-4 seed ORDERING: the session→project cache is seeded only
 *     AFTER the §3a validation gate, so a 400-rejected body cannot poison it.
 *   - the `bumpIdleTimeout` closure: it must call `ctx.server.timeout` with
 *     THIS request and NETWORK.SERVER_IDLE_TIMEOUT_SECONDS, and it must fire
 *     when a hold parks the connection.
 *   - §1 `trackClientVersion`: fed from the user-agent of proxied requests,
 *     and NOT reached by the §0 internal-endpoint short-circuit above it.
 *   - §4 reasoning-effort derivation: body value, native-Responses fallback,
 *     precedence between them, and the absent case.
 *   - the POST-and-/v1/messages guard around `computeContextAndToolStats`.
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
import { getClientVersion, NETWORK } from "@clankermux/core";
import { usageCache } from "@clankermux/providers";
import {
	type Account,
	setNativeResponsesRequestContext,
} from "@clankermux/types";
import { cacheBodyStore } from "../cache-body-store";
import type { ProxyContext } from "../handlers";
import { setForcedAccount } from "../handlers";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { resetOverloadHoldSlots } from "../overload-hold";
import {
	applyProviderOverloadCooldown,
	clearProviderOverloadCooldown,
} from "../provider-overload-cooldown";
import type { RecordMeta } from "../request-recorder";
import { sessionProjectCache } from "../session-project-cache";
import { sessionPromotionTracker } from "../session-promotion";

const ACCOUNT_ID = "acc-prologue";
const MODEL = "claude-sonnet-4-5";

/** Unique per test so no singleton state leaks between cases. */
let idCounter = 0;
function uniqueId(prefix: string): string {
	idCounter++;
	return `${prefix}-${idCounter}`;
}

async function callHandleProxy(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	apiKeyId?: string | null,
) {
	const { handleProxy } = await import("../proxy");
	return handleProxy(req, url, ctx, apiKeyId);
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: ACCOUNT_ID,
		name: "Prologue-main",
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

/** A ProxyContext plus the test-side handles its stubs write into. */
interface Harness {
	ctx: ProxyContext;
	/** Every RecordMeta handed to requestRecorder.begin, in order. */
	recorded: RecordMeta[];
	/** Every (req, seconds) pair passed to ctx.server.timeout, in order. */
	idleBumps: Array<[unknown, unknown]>;
}

function makeHarness(accounts: Account[]): Harness {
	const recorded: RecordMeta[] = [];
	const idleBumps: Array<[unknown, unknown]> = [];

	const ctx: ProxyContext = {
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
			// Unpinned key: without this the pin resolution fails closed with a 503.
			getApiKeyPin: mock(async () => null),
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
			getCacheWarmingEnabled: () => false,
			getCacheWarmingMinTokens: () => 100_000,
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
			begin: mock((meta: RecordMeta) => {
				recorded.push(meta);
			}),
			captureResponseChunk: mock(() => {}),
			finishTransport: mock(() => {}),
			attachUsageSummary: mock(() => {}),
			markUsageUnavailable: mock(() => {}),
			recordSynthetic: mock(() => {}),
			sweep: mock(() => {}),
			dispose: mock(() => {}),
		} as never,
		server: {
			timeout: mock((r: unknown, seconds: unknown) => {
				idleBumps.push([r, seconds]);
			}),
		} as never,
	};

	return { ctx, recorded, idleBumps };
}

/**
 * Shunt every non-upstream fetch (the models.dev pricing-catalog refresh fired
 * by the usage finalizer) to a 500 so call ORDER and counts stay
 * order-independent across the suite — same rationale as `upstreamOnlyFetch`
 * in overload-hold.test.ts.
 */
function upstreamOnlyFetch(
	onUpstream: () => void = () => {},
): typeof globalThis.fetch {
	return mock(async (input: Request | string | URL) => {
		const url = input instanceof Request ? input.url : String(input);
		if (!url.includes("api.anthropic.com")) {
			return new Response("unavailable", { status: 500 });
		}
		onUpstream();
		return ok200();
	}) as never;
}

function ok200() {
	return new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			model: MODEL,
			stop_reason: "end_turn",
			usage: { input_tokens: 10, output_tokens: 5 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

/** Claude Code's session id lives inside a JSON-encoded `metadata.user_id`. */
function metadataForSession(sessionId: string): Record<string, unknown> {
	return {
		user_id: JSON.stringify({
			device_id: "device-1",
			account_uuid: "",
			session_id: sessionId,
		}),
	};
}

function jsonRequest(
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
): Request {
	return new Request(`https://proxy.local${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

function resetSingletons(): void {
	setForcedAccount(null);
	cacheBodyStore.setEnabled(false);
	sessionPromotionTracker.setMode("off");
	sessionPromotionTracker.clear();
	sessionProjectCache.clear();
	clearProviderOverloadCooldown();
	resetOverloadHoldSlots();
	resetRateLimitProbeGatesForTests();
	usageCache.delete(ACCOUNT_ID);
}

describe("handleProxy prologue wiring", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeAll(async () => {
		await import("../proxy");
	});

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		resetSingletons();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		resetSingletons();
	});

	describe("§3c tier-4 seed ordering", () => {
		const WORKING_DIR = "/home/tester/seedproj";
		const PROJECT = "seedproj";

		function anchoredBody(
			sessionId: string,
			extra: Record<string, unknown>,
		): Record<string, unknown> {
			return {
				model: MODEL,
				system: [
					{ type: "text", text: `Primary working directory: ${WORKING_DIR}` },
				],
				metadata: metadataForSession(sessionId),
				max_tokens: 16,
				...extra,
			};
		}

		it("does NOT seed the session cache when §3a rejects the body", async () => {
			globalThis.fetch = upstreamOnlyFetch();
			const { ctx } = makeHarness([makeAccount()]);
			const apiKeyId = uniqueId("key");
			const sessionId = uniqueId("session");
			const cacheKey = `${apiKeyId}:${sessionId}`;

			// Anchored project signal + session id, but NO `messages` field — the
			// §3a validator 400s it, so the seed at §3c must never run.
			const res = await callHandleProxy(
				jsonRequest("/v1/messages", anchoredBody(sessionId, {})),
				new URL("https://proxy.local/v1/messages"),
				ctx,
				apiKeyId,
			);

			expect(res.status).toBe(400);
			expect(sessionProjectCache.lookup(cacheKey)).toEqual({
				project: null,
				ambiguous: false,
			});
			expect(sessionProjectCache.size()).toBe(0);
		});

		it("seeds the session cache once the same request passes validation", async () => {
			globalThis.fetch = upstreamOnlyFetch();
			const { ctx } = makeHarness([makeAccount()]);
			const apiKeyId = uniqueId("key");
			const sessionId = uniqueId("session");
			const cacheKey = `${apiKeyId}:${sessionId}`;

			const res = await callHandleProxy(
				jsonRequest(
					"/v1/messages",
					anchoredBody(sessionId, {
						messages: [{ role: "user", content: "hello" }],
					}),
				),
				new URL("https://proxy.local/v1/messages"),
				ctx,
				apiKeyId,
			);

			expect(res.status).toBe(200);
			expect(sessionProjectCache.lookup(cacheKey)).toEqual({
				project: PROJECT,
				ambiguous: false,
			});
		});

		it("attributes the anchored project on the request that seeded it", async () => {
			globalThis.fetch = upstreamOnlyFetch();
			const { ctx, recorded } = makeHarness([makeAccount()]);
			const apiKeyId = uniqueId("key");
			const sessionId = uniqueId("session");

			const res = await callHandleProxy(
				jsonRequest(
					"/v1/messages",
					anchoredBody(sessionId, {
						messages: [{ role: "user", content: "hello" }],
					}),
				),
				new URL("https://proxy.local/v1/messages"),
				ctx,
				apiKeyId,
			);

			expect(res.status).toBe(200);
			expect(recorded).toHaveLength(1);
			expect(recorded[0].project).toBe(PROJECT);
			expect(recorded[0].projectAttributionSource).toBe("wd_primary");
		});
	});

	describe("bumpIdleTimeout wiring", () => {
		// The haiku family bucket is what the overload hold parks on.
		const HOLD_MODEL = "claude-haiku-4-5";

		it("re-arms the connection idle timer with THIS request while an overload hold parks it", async () => {
			// One ordered log for both signals so the bump can be placed relative to
			// the upstream attempt.
			const events: string[] = [];
			globalThis.fetch = upstreamOnlyFetch(() => {
				events.push("upstream");
			});

			const { ctx, idleBumps } = makeHarness([makeAccount()]);
			(ctx.server as unknown as { timeout: ReturnType<typeof mock> }).timeout =
				mock((r: unknown, seconds: unknown) => {
					events.push("bump");
					idleBumps.push([r, seconds]);
				});
			// Open for ~400ms: within the hold budget, so the request parks in the
			// overload hold (which re-arms the idle timer) and is served on wake.
			applyProviderOverloadCooldown("anthropic", Date.now() + 400, HOLD_MODEL);

			const req = jsonRequest("/v1/messages", {
				model: HOLD_MODEL,
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 16,
			});
			const res = await callHandleProxy(
				req,
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);

			expect(res.status).toBe(200);
			// The bump fired, and EVERY call carried this exact request object plus
			// the shared idle-timeout constant (an argument-loose assertion would
			// also pass on proxy-operations' look-alike streaming closure).
			expect(idleBumps.length).toBeGreaterThan(0);
			for (const [bumpedReq, seconds] of idleBumps) {
				expect(bumpedReq).toBe(req);
				expect(seconds).toBe(NETWORK.SERVER_IDLE_TIMEOUT_SECONDS);
			}
			// It came from the HOLD, not from a downstream streaming re-arm: the
			// first bump happened before any upstream attempt was made.
			expect(events[0]).toBe("bump");
			expect(events).toContain("upstream");
		}, 15_000);

		it("is a no-op-safe closure when the server rejects the timeout call", async () => {
			globalThis.fetch = upstreamOnlyFetch();
			const { ctx } = makeHarness([makeAccount()]);
			(ctx.server as unknown as { timeout: ReturnType<typeof mock> }).timeout =
				mock(() => {
					throw new Error("not a tracked connection");
				});
			applyProviderOverloadCooldown("anthropic", Date.now() + 400, HOLD_MODEL);

			const res = await callHandleProxy(
				jsonRequest("/v1/messages", {
					model: HOLD_MODEL,
					messages: [{ role: "user", content: "hello" }],
					max_tokens: 16,
				}),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);

			expect(res.status).toBe(200);
		}, 15_000);
	});

	describe("§1 trackClientVersion wiring", () => {
		it("records the proxied request's user-agent, and the §0 short-circuit does not", async () => {
			globalThis.fetch = upstreamOnlyFetch();
			const { ctx } = makeHarness([makeAccount()]);

			// A normal proxied request feeds the tracker …
			const proxied = await callHandleProxy(
				jsonRequest(
					"/v1/messages",
					{
						model: MODEL,
						messages: [{ role: "user", content: "hello" }],
						max_tokens: 16,
					},
					{ "user-agent": "claude-cli/9.9.91 (external, cli)" },
				),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);
			expect(proxied.status).toBe(200);
			expect(getClientVersion()).toBe("9.9.91");

			// … while the §0 internal-endpoint short-circuit returns above §1, so a
			// NEWER version on that request is never observed.
			const shortCircuited = await callHandleProxy(
				jsonRequest(
					"/api/event_logging/batch",
					{ events: [{ name: "x" }] },
					{ "user-agent": "claude-cli/9.9.92 (external, cli)" },
				),
				new URL("https://proxy.local/api/event_logging/batch"),
				ctx,
			);
			expect(shortCircuited.status).toBe(200);
			expect(getClientVersion()).toBe("9.9.91");
		});
	});

	describe("§4 reasoning-effort derivation", () => {
		function nativeContext(effort: string | null) {
			return {
				nativeBody: JSON.stringify({ model: MODEL, input: [] }),
				reasoningEffort: effort,
			};
		}

		async function runWithBody(
			body: Record<string, unknown>,
			attachNative: ((req: Request) => void) | null,
		): Promise<RecordMeta> {
			globalThis.fetch = upstreamOnlyFetch();
			const { ctx, recorded } = makeHarness([makeAccount()]);
			const req = jsonRequest("/v1/messages", body);
			attachNative?.(req);

			const res = await callHandleProxy(
				req,
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);
			expect(res.status).toBe(200);
			expect(recorded).toHaveLength(1);
			return recorded[0];
		}

		const baseBody = {
			model: MODEL,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		};

		it("uses the value parsed from the request body", async () => {
			const meta = await runWithBody(
				{ ...baseBody, thinking: { type: "enabled", budget_tokens: 4096 } },
				null,
			);
			expect(meta.reasoningEffort).toBe("thinking:4096");
		});

		it("falls back to the native-Responses context when the body has none", async () => {
			const meta = await runWithBody(baseBody, (req) => {
				setNativeResponsesRequestContext(req, nativeContext("high"));
			});
			expect(meta.reasoningEffort).toBe("high");
		});

		it("prefers the body value over the native-Responses context", async () => {
			const meta = await runWithBody(
				{ ...baseBody, thinking: { type: "enabled", budget_tokens: 1234 } },
				(req) => {
					setNativeResponsesRequestContext(req, nativeContext("high"));
				},
			);
			expect(meta.reasoningEffort).toBe("thinking:1234");
		});

		it("is null when neither source supplies one", async () => {
			const meta = await runWithBody(baseBody, null);
			expect(meta.reasoningEffort).toBeNull();
		});
	});

	describe("context/tool-stats POST-and-/v1/messages guard", () => {
		const SYSTEM_TEXT = "You are helpful.";
		const TOOLS = [
			{ name: "Bash", description: "run a command", input_schema: {} },
		];
		const TOOL_USE = {
			type: "tool_use",
			id: "tu_1",
			name: "Bash",
			input: { command: "ls" },
		};
		const TOOL_RESULT = {
			type: "tool_result",
			tool_use_id: "tu_1",
			is_error: true,
			content: "boom",
		};
		const USER_TEXT = "please run ls";
		const MESSAGES = [
			{ role: "user", content: USER_TEXT },
			{ role: "assistant", content: [TOOL_USE] },
			{ role: "user", content: [TOOL_RESULT] },
		];
		const TOOL_BODY = {
			model: MODEL,
			system: [{ type: "text", text: SYSTEM_TEXT }],
			tools: TOOLS,
			messages: MESSAGES,
			max_tokens: 16,
		};

		it("leaves both null for a POST to a path other than /v1/messages", async () => {
			globalThis.fetch = upstreamOnlyFetch();
			const { ctx, recorded } = makeHarness([makeAccount()]);

			const res = await callHandleProxy(
				jsonRequest("/v1/complete", TOOL_BODY),
				new URL("https://proxy.local/v1/complete"),
				ctx,
			);

			expect(res.status).toBe(200);
			expect(recorded).toHaveLength(1);
			expect(recorded[0].path).toBe("/v1/complete");
			expect(recorded[0].contextComposition).toBeNull();
			expect(recorded[0].toolCallStats).toBeNull();
		});

		it("populates both for the same body on POST /v1/messages", async () => {
			globalThis.fetch = upstreamOnlyFetch();
			const { ctx, recorded } = makeHarness([makeAccount()]);

			const res = await callHandleProxy(
				jsonRequest("/v1/messages", TOOL_BODY),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);

			expect(res.status).toBe(200);
			expect(recorded).toHaveLength(1);
			const toolUseChars = JSON.stringify(TOOL_USE).length;
			const toolResultChars = JSON.stringify(TOOL_RESULT).length;
			expect(recorded[0].contextComposition).toEqual({
				systemChars: SYSTEM_TEXT.length,
				toolsChars: JSON.stringify(TOOLS).length,
				toolCount: 1,
				messagesChars: USER_TEXT.length + toolUseChars + toolResultChars,
				messageCount: 3,
				toolResultChars,
				largestToolResultChars: toolResultChars,
				largestToolName: "Bash",
				imageCount: 0,
				imagePayloadChars: 0,
				documentPayloadChars: 0,
			});
			expect(recorded[0].toolCallStats).toEqual([
				{
					toolName: "Bash",
					callCount: 1,
					errorCount: 1,
					errorSamples: ["boom"],
				},
			]);
		});
	});

	describe("cache-measurement capture", () => {
		const SESSION_ID = "11111111-2222-3333-4444-555555555555";
		const CAPTURE_BODY = {
			model: MODEL,
			system: [
				{ type: "text", text: "You are a test assistant." },
				{
					type: "text",
					text: "cached tail",
					cache_control: { type: "ephemeral" },
				},
			],
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
			metadata: {
				user_id: JSON.stringify({
					device_id: "device-1",
					account_uuid: "",
					session_id: SESSION_ID,
				}),
			},
		};

		it("threads sessionKey and cachePrefixHashes to the recorded row", async () => {
			globalThis.fetch = upstreamOnlyFetch();
			const { ctx, recorded } = makeHarness([makeAccount()]);

			const res = await callHandleProxy(
				jsonRequest("/v1/messages", CAPTURE_BODY),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);

			expect(res.status).toBe(200);
			expect(recorded).toHaveLength(1);
			expect(recorded[0].sessionKey).toBe(`anon:${SESSION_ID}`);
			expect(recorded[0].cachePrefixHashes?.v).toBe(2);
			expect(recorded[0].cachePrefixHashes?.bp).toHaveLength(1);
			expect(recorded[0].cachePrefixHashes?.bp[0]).toMatch(/^[0-9a-f]{16}$/);
			expect(recorded[0].cachePrefixHashes?.n).toBe(1);
		});

		it("records null hashes for a non-/v1/messages path", async () => {
			globalThis.fetch = upstreamOnlyFetch();
			const { ctx, recorded } = makeHarness([makeAccount()]);

			const res = await callHandleProxy(
				jsonRequest("/v1/complete", CAPTURE_BODY),
				new URL("https://proxy.local/v1/complete"),
				ctx,
			);

			expect(res.status).toBe(200);
			expect(recorded).toHaveLength(1);
			expect(recorded[0].cachePrefixHashes).toBeNull();
		});
	});
});
