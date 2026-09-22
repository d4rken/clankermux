/**
 * The live-dashboard announce/retract pair that brackets `handleProxy`.
 *
 * `start` only fires once the upstream has produced response headers, so
 * between arrival and first byte a request used to be invisible — the Overview
 * activity lanes would read as idle during exactly the wait an operator wants
 * to see. `ingress` announces the request at ingestion; `ingress-end` retracts
 * the announcement for requests that never reach `forwardToClient` and so will
 * never be summarized.
 *
 * The invariant these tests defend: **the live view shows exactly what Request
 * History will show.** Every announced request is eventually either summarized
 * or retracted, and nothing the recorder filters out leaves a mark behind.
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
import {
	getActiveRequests,
	type RequestEvt,
	requestEvents,
	resetRequestEventRegistry,
} from "@clankermux/core";
import { usageCache } from "@clankermux/providers";
import { mockFetch } from "@clankermux/test-support";
import type { Account, RequestMeta } from "@clankermux/types";
import { cacheBodyStore } from "../cache-body-store";
import type { ProxyContext } from "../handlers";
import { setForcedAccount } from "../handlers";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { resetOverloadHoldSlots } from "../overload-hold";
import { clearProviderOverloadCooldown } from "../provider-overload-cooldown";
import { sessionPromotionTracker } from "../session-promotion";

const ACCOUNT_ID = "acc-ingress-evt";
const MODEL = "claude-sonnet-4-5";
const API_KEY_ID = "key-desk-widget";
const API_KEY_NAME = "Desk widget";
/** A key that exists and names no destination of its own. */
const UNPINNED_KEY = {
	pinnedAccountId: null,
	pinnedProviders: null,
	excludedProviders: null,
	malformed: false,
};

async function callHandleProxy(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	isInternal = false,
	apiKeyId: string | null = null,
	apiKeyName: string | null = null,
) {
	const { handleProxy } = await import("./fixtures/routing-harness");
	return handleProxy(req, url, ctx, apiKeyId, apiKeyName, isInternal);
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: ACCOUNT_ID,
		name: "Ingress-evt-main",
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
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	} as Account;
}

/**
 * `apiKeyPin` is what the key's row says about its destinations. Routing is
 * fail-closed on it: a request that presents a key whose row is missing is
 * refused with a 403 before an account is picked, so a test that exercises
 * keyed traffic has to hand over an (unpinned) row for the request to reach
 * the upstream at all.
 */
function makeContext(
	accounts: Account[],
	apiKeyPin: {
		pinnedAccountId: string | null;
		pinnedProviders: string[] | null;
		excludedProviders: string[] | null;
		malformed: boolean;
	} | null = null,
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
			saveInternalDispatchSpend: mock(async () => {}),
			getApiKeyPin: mock(async () => apiKeyPin),
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

/** Shunt every non-Anthropic fetch (e.g. the pricing-catalog refresh) to a 500. */
function upstreamOnlyFetch(
	handler: () => Response | Promise<Response>,
): typeof globalThis.fetch {
	return mock(async (input: Request | string | URL) => {
		const url = input instanceof Request ? input.url : String(input);
		if (!url.includes("api.anthropic.com")) {
			return new Response("unavailable", { status: 500 });
		}
		if (input instanceof Request) await input.arrayBuffer();
		return handler();
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

function messagesRequest(
	body: Record<string, unknown> = {
		model: MODEL,
		messages: [{ role: "user", content: "hi" }],
	},
	headers: Record<string, string> = {},
) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

describe("handleProxy live-dashboard ingress events", () => {
	let originalFetch: typeof globalThis.fetch;
	let events: RequestEvt[];
	let capture: (evt: RequestEvt) => void;

	beforeAll(async () => {
		await import("./fixtures/routing-harness");
	});

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		events = [];
		capture = (evt) => {
			events.push(evt);
		};
		requestEvents.on("event", capture);
		resetRequestEventRegistry();
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
		requestEvents.off("event", capture);
		resetRequestEventRegistry();
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

	const ofType = <T extends RequestEvt["type"]>(type: T) =>
		events.filter((e) => e.type === type) as Extract<RequestEvt, { type: T }>[];

	it.each([
		200, 400,
	])("retracts a local OpenRouter count with status %s without recording it", async (status) => {
		const fetchMock = mock(async () => {
			throw new Error("local count reached upstream");
		});
		globalThis.fetch = mockFetch(fetchMock);
		const ctx = makeContext([
			makeAccount({ provider: "openrouter", api_key: null }),
		]);
		const req = new Request("https://proxy.local/v1/messages/count_tokens", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: MODEL,
				messages: status === 200 ? [{ role: "user", content: "hi" }] : null,
			}),
		});
		const response = await callHandleProxy(req, new URL(req.url), ctx);
		expect(response.status).toBe(status);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(ctx.requestRecorder.begin).not.toHaveBeenCalled();
		expect(ctx.dbOps.saveRequest).not.toHaveBeenCalled();
		expect(ofType("start")).toHaveLength(0);
		expect(ofType("ingress")).toHaveLength(1);
		expect(ofType("ingress-end")).toHaveLength(1);
		expect(ofType("ingress-end")[0].id).toBe(ofType("ingress")[0].id);
	});

	it("announces the request at ingestion, before the upstream is called", async () => {
		globalThis.fetch = upstreamOnlyFetch(() => ok200());

		await callHandleProxy(
			messagesRequest(),
			new URL("https://proxy.local/v1/messages"),
			makeContext([makeAccount()]),
		);

		const [ingress] = ofType("ingress");
		expect(ingress).toBeDefined();
		expect(ingress.method).toBe("POST");
		expect(ingress.path).toBe("/v1/messages");
		expect(ingress.model).toBe(MODEL);
		expect(typeof ingress.timestamp).toBe("number");

		// The announcement must come first — that is the whole point of it.
		expect(events[0].type).toBe("ingress");
	});

	it("carries the resolved project so the request lands in a lane immediately", async () => {
		globalThis.fetch = upstreamOnlyFetch(() => ok200());

		await callHandleProxy(
			messagesRequest({
				model: MODEL,
				messages: [{ role: "user", content: "hi" }],
				system: [
					{
						type: "text",
						text: "<env>\nWorking directory: /home/darken/clankermux\n</env>",
					},
				],
			}),
			new URL("https://proxy.local/v1/messages"),
			makeContext([makeAccount()]),
		);

		const [ingress] = ofType("ingress");
		expect(ingress.project).toBe("clankermux");

		// The start event repeats it, so a client that connected mid-request can
		// still attribute the work without having seen the ingress.
		const [start] = ofType("start");
		expect(start.project).toBe("clankermux");
		expect(start.model).toBe(MODEL);
	});

	it("does NOT retract a request that reached the upstream", async () => {
		globalThis.fetch = upstreamOnlyFetch(() => ok200());

		await callHandleProxy(
			messagesRequest(),
			new URL("https://proxy.local/v1/messages"),
			makeContext([makeAccount()]),
		);

		expect(ofType("start")).toHaveLength(1);
		// A retraction here would erase a real, recorded request from the live
		// view — and for a streaming response it would do so mid-flight, since
		// the retraction point runs when the Response object is returned, not
		// when its body ends.
		expect(ofType("ingress-end")).toHaveLength(0);
	});

	it("uses ONE id for the announcement and the start, so failover does not double-draw", async () => {
		globalThis.fetch = upstreamOnlyFetch(() => ok200());

		await callHandleProxy(
			messagesRequest(),
			new URL("https://proxy.local/v1/messages"),
			makeContext([makeAccount()]),
		);

		const [ingress] = ofType("ingress");
		const starts = ofType("start");
		expect(starts.length).toBeGreaterThanOrEqual(1);
		// Every attempt reuses requestMeta.id, so N attempts update one mark
		// rather than drawing N.
		for (const start of starts) expect(start.id).toBe(ingress.id);
	});

	it("retracts a request that never reached the upstream", async () => {
		globalThis.fetch = upstreamOnlyFetch(() => ok200());

		// No usable account: handleProxy throws its all-accounts-failed terminal
		// without ever calling forwardToClient, so nothing will ever summarize
		// this request. Left un-retracted it would sit in the lanes as a
		// permanently-pending mark.
		const ctx = makeContext([makeAccount({ paused: true })]);
		const url = new URL("https://proxy.local/v1/messages");

		await callHandleProxy(messagesRequest(), url, ctx).catch(() => undefined);

		const [ingress] = ofType("ingress");
		expect(ingress).toBeDefined();
		const ends = ofType("ingress-end");
		expect(ends).toHaveLength(1);
		expect(ends[0].id).toBe(ingress.id);
		expect(ofType("start")).toHaveLength(0);
	});

	it("announces nothing for an internal probe", async () => {
		globalThis.fetch = upstreamOnlyFetch(() => ok200());

		await callHandleProxy(
			messagesRequest(undefined, { "x-clankermux-auto-refresh": "true" }),
			new URL("https://proxy.local/v1/messages"),
			makeContext([makeAccount()]),
			true,
		).catch(() => undefined);

		// The recorder filters these out, so the live view must not show them
		// either — announcing and then retracting would flicker a mark for
		// traffic Request History has no row for.
		expect(ofType("ingress")).toHaveLength(0);
		expect(ofType("ingress-end")).toHaveLength(0);
	});

	it("announces nothing for a .well-known probe", async () => {
		globalThis.fetch = upstreamOnlyFetch(() => ok200());

		await callHandleProxy(
			new Request("https://proxy.local/.well-known/oauth-protected-resource", {
				method: "GET",
			}),
			new URL("https://proxy.local/.well-known/oauth-protected-resource"),
			makeContext([makeAccount()]),
		).catch(() => undefined);

		expect(ofType("ingress")).toHaveLength(0);
	});

	/**
	 * Client identity on the IN-FLIGHT events.
	 *
	 * The summary event has always named the API key, but it only fires once a
	 * request is over — so a client lane fed from it alone stays empty for exactly
	 * the period the live view exists to show. These tests drive the real
	 * `handleProxy`/`forwardToClient` producers rather than hand-built events: a
	 * fixture round-tripped through the registry would pass unchanged if a
	 * producer stopped populating the field, which is the only failure worth
	 * catching here.
	 */
	describe("client identity on the live-dashboard events", () => {
		async function waitFor(predicate: () => boolean): Promise<void> {
			const deadline = Date.now() + 5_000;
			while (!predicate()) {
				if (Date.now() > deadline) throw new Error("timed out waiting");
				await Bun.sleep(1);
			}
		}

		it("names the client while the request is still PENDING", async () => {
			// Hold the upstream open so the assertions run in the window between
			// ingress and response headers — the window that has no `start` event and
			// therefore nothing but the ingress event to attribute the request with.
			let release = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			globalThis.fetch = upstreamOnlyFetch(async () => {
				await gate;
				return ok200();
			});

			const inFlight = callHandleProxy(
				messagesRequest(),
				new URL("https://proxy.local/v1/messages"),
				makeContext([makeAccount()], UNPINNED_KEY),
				false,
				API_KEY_ID,
				API_KEY_NAME,
			);
			await waitFor(() => ofType("ingress").length === 1);

			const [ingress] = ofType("ingress");
			expect(ingress.apiKeyId).toBe(API_KEY_ID);
			expect(ingress.apiKeyName).toBe(API_KEY_NAME);
			expect(ofType("start")).toHaveLength(0);

			const [entry] = getActiveRequests();
			expect(entry.phase).toBe("pending");
			expect(entry.apiKeyId).toBe(API_KEY_ID);
			expect(entry.apiKeyName).toBe(API_KEY_NAME);

			release();
			await inFlight;
		});

		it("repeats the client on start, for a dashboard that missed the ingress", async () => {
			globalThis.fetch = upstreamOnlyFetch(() => ok200());

			await callHandleProxy(
				messagesRequest(),
				new URL("https://proxy.local/v1/messages"),
				makeContext([makeAccount()], UNPINNED_KEY),
				false,
				API_KEY_ID,
				API_KEY_NAME,
			);

			const [start] = ofType("start");
			expect(start.apiKeyId).toBe(API_KEY_ID);
			expect(start.apiKeyName).toBe(API_KEY_NAME);

			const [entry] = getActiveRequests();
			expect(entry.phase).toBe("streaming");
			expect(entry.apiKeyId).toBe(API_KEY_ID);
			expect(entry.apiKeyName).toBe(API_KEY_NAME);
		});

		it("names the client on a start that had no ingress to establish it", async () => {
			globalThis.fetch = upstreamOnlyFetch(() => ok200());

			// An attempt dispatched in-process goes straight at an account, so the
			// announcement `handleProxy` makes never happens and the start event is
			// the only thing that can attribute the request. The registry has to
			// take the identity from it rather than only from an ingress.
			const { proxyWithAccount } = await import("./fixtures/routing-harness");
			const account = makeAccount();
			const req = messagesRequest();
			const meta: RequestMeta = {
				id: "start-without-ingress",
				method: "POST",
				path: "/v1/messages",
				timestamp: Date.now(),
				requestedModel: MODEL,
				headers: req.headers,
			};

			await proxyWithAccount(
				req,
				new URL(req.url),
				account,
				meta,
				await req.clone().arrayBuffer(),
				() => undefined,
				0,
				makeContext([account], UNPINNED_KEY),
				null,
				API_KEY_ID,
				API_KEY_NAME,
			);

			expect(ofType("ingress")).toHaveLength(0);
			const [start] = ofType("start");
			expect(start).toBeDefined();
			expect(start.apiKeyId).toBe(API_KEY_ID);
			expect(start.apiKeyName).toBe(API_KEY_NAME);

			const [entry] = getActiveRequests();
			expect(entry.phase).toBe("streaming");
			expect(entry.apiKeyId).toBe(API_KEY_ID);
			expect(entry.apiKeyName).toBe(API_KEY_NAME);
		});

		it("reports null for keyless traffic", async () => {
			globalThis.fetch = upstreamOnlyFetch(() => ok200());

			// Unprotected mode admits requests that carry no key. `toBeNull` rather
			// than a falsy check: an unpopulated field arrives as `undefined`, and
			// "no key" has to stay distinguishable from "never plumbed".
			await callHandleProxy(
				messagesRequest(),
				new URL("https://proxy.local/v1/messages"),
				makeContext([makeAccount()]),
			);

			const [ingress] = ofType("ingress");
			expect(ingress.apiKeyId).toBeNull();
			expect(ingress.apiKeyName).toBeNull();

			const [start] = ofType("start");
			expect(start.apiKeyId).toBeNull();
			expect(start.apiKeyName).toBeNull();

			const [entry] = getActiveRequests();
			expect(entry.apiKeyId).toBeNull();
			expect(entry.apiKeyName).toBeNull();
		});

		it("normalizes a blank key to null so no lane keys on an empty string", async () => {
			globalThis.fetch = upstreamOnlyFetch(() => ok200());

			await callHandleProxy(
				messagesRequest(),
				new URL("https://proxy.local/v1/messages"),
				makeContext([makeAccount()], UNPINNED_KEY),
				false,
				"",
				"",
			);

			const [ingress] = ofType("ingress");
			expect(ingress.apiKeyId).toBeNull();
			expect(ingress.apiKeyName).toBeNull();
			const [start] = ofType("start");
			expect(start.apiKeyId).toBeNull();
			expect(start.apiKeyName).toBeNull();
			const [entry] = getActiveRequests();
			expect(entry.apiKeyId).toBeNull();
			expect(entry.apiKeyName).toBeNull();
		});
	});
});
