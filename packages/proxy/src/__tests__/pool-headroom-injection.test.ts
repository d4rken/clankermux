/**
 * The pooled figures must reach the CLIENT and must never reach our own records.
 *
 * The tempting place to inject them is `withSanitizedProxyHeaders`, the one
 * object all three client exits derive their headers from. That would also feed
 * them to `captureUnifiedClaimObservations` and to the `response_headers` blob
 * persisted in Request History — so every forecast, backtest and stored
 * observation would be built on figures the proxy invented rather than on what
 * the provider said. Injecting in the `forwardToClient` wrapper, after recording,
 * is what keeps those apart, and the recorder assertion below is the regression
 * that pins it.
 *
 * The rest of this file pins the bail-outs. Each one is a path with no pool
 * behind it, where the only honest thing to send is what upstream sent.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { usageCache } from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import type { RecordMeta } from "../request-recorder";
import { forwardToClient } from "../response-handler";

const enc = new TextEncoder();
const NOW = Date.now();
const HOUR_MS = 3_600_000;
const WEEK_OUT = NOW + 72 * HOUR_MS;

const seeded: string[] = [];

afterEach(() => {
	for (const id of seeded.splice(0)) usageCache.delete(id);
});

/**
 * The usage cache is a process-wide singleton shared with every other suite in
 * this run, so every id here is namespaced against another file's fixtures.
 */
const key = (id: string): string => `phi-${id}`;

function makeAccount(id: string, provider = "anthropic"): Account {
	return {
		id: key(id),
		name: id,
		provider,
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: NOW + HOUR_MS,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: NOW,
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
		notes: null,
		refresh_token_issued_at: null,
	} as Account;
}

/** Seed one Anthropic-shaped weekly window into the shared usage cache. */
function seedWeekly(id: string, pct: number): void {
	seeded.push(key(id));
	usageCache.set(key(id), {
		five_hour: null,
		seven_day: {
			utilization: pct,
			resets_at: new Date(WEEK_OUT).toISOString(),
		},
	} as never);
}

function makeCtx(begins: RecordMeta[], isStream: boolean) {
	return {
		strategy: {},
		dbOps: {
			markAccountRateLimited: async () => 1,
			markAccountRateLimitedDeadlineOnly: async () => {},
			updateAccountUsage: () => {},
			updateAccountRateLimitMeta: () => {},
			updateRequestUsage: async () => {},
			// These fixtures deliberately carry unified claim headers, so unlike
			// most proxy tests they reach the observation-capture path.
			saveUnifiedClaimObservations: () => {},
			saveUnifiedSummaryObservation: () => {},
			getAdapter: () => ({
				get: async () => ({ rate_limited_until: null }),
				run: async () => {},
			}),
		},
		runtime: { port: 8080, tlsEnabled: false },
		config: { getStorePayloads: () => false },
		provider: { name: "anthropic", isStreamingResponse: () => isStream },
		refreshInFlight: new Map<string, Promise<string>>(),
		asyncWriter: {
			enqueue: (job: () => void | Promise<void>) => {
				void job();
				return Promise.resolve();
			},
		},
		requestRecorder: {
			begin: (meta: RecordMeta) => {
				begins.push(meta);
			},
			captureResponseChunk: () => {},
			finishTransport: () => {},
			attachUsageSummary: () => {},
			markUsageUnavailable: () => {},
		},
	} as never;
}

/**
 * The serving account reports a spent weekly window; a sibling in the same
 * class has plenty of room. Before this change the client saw 0.9; it should
 * now see the sibling's 0.2.
 */
const UPSTREAM_UNIFIED = {
	"anthropic-ratelimit-unified-status": "allowed",
	"anthropic-ratelimit-unified-7d-status": "allowed",
	"anthropic-ratelimit-unified-7d-utilization": "0.9",
	"anthropic-ratelimit-unified-7d-reset": String(Math.floor(WEEK_OUT / 1000)),
};

function sseBody(): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(
				enc.encode(
					'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":5}}}\n\n',
				),
			);
			controller.enqueue(
				enc.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'),
			);
			controller.close();
		},
	});
}

async function forward(
	options: {
		poolCandidates?: readonly Account[] | null;
		account?: Account | null;
		internal?: boolean;
		headers?: Record<string, string>;
		body?: "stream" | "json" | "none";
	} = {},
): Promise<{ response: Response; begins: RecordMeta[] }> {
	const begins: RecordMeta[] = [];
	const shape = options.body ?? "stream";
	const isStream = shape === "stream";
	const account =
		options.account === undefined ? makeAccount("serving") : options.account;

	const response = await forwardToClient(
		{
			requestId: `req-${Math.random()}`,
			method: "POST",
			path: "/v1/messages",
			account,
			poolCandidates: options.poolCandidates,
			internal: options.internal,
			requestHeaders: new Headers({ "content-type": "application/json" }),
			requestBody: enc.encode("{}").buffer as ArrayBuffer,
			response: new Response(
				shape === "stream"
					? sseBody()
					: shape === "json"
						? '{"ok":true}'
						: null,
				{
					status: shape === "none" ? 204 : 200,
					headers: {
						"content-type": isStream ? "text/event-stream" : "application/json",
						...(options.headers ?? UPSTREAM_UNIFIED),
					},
				},
			),
			timestamp: NOW,
			retryAttempt: 0,
			failoverAttempts: 0,
		},
		makeCtx(begins, isStream),
	);

	// Drain so the single-reader passthrough runs its inline analytics.
	if (response.body) await response.text();
	return { response, begins };
}

describe("pool headroom header injection", () => {
	it("restates the client's figure from the pool on the streaming exit", async () => {
		seedWeekly("serving", 90);
		seedWeekly("sibling", 20);

		const { response } = await forward({
			poolCandidates: [makeAccount("serving"), makeAccount("sibling")],
		});

		expect(
			response.headers.get("anthropic-ratelimit-unified-7d-utilization"),
		).toBe("0.2");
	});

	it("restates it on the buffered exit too", async () => {
		seedWeekly("serving", 90);
		seedWeekly("sibling", 20);

		const { response } = await forward({
			body: "json",
			poolCandidates: [makeAccount("serving"), makeAccount("sibling")],
		});

		expect(
			response.headers.get("anthropic-ratelimit-unified-7d-utilization"),
		).toBe("0.2");
	});

	it("restates it on a response with no body", async () => {
		seedWeekly("serving", 90);
		seedWeekly("sibling", 20);

		const { response } = await forward({
			body: "none",
			poolCandidates: [makeAccount("serving"), makeAccount("sibling")],
		});

		expect(
			response.headers.get("anthropic-ratelimit-unified-7d-utilization"),
		).toBe("0.2");
	});

	it("records the UPSTREAM figure, never the pooled one", async () => {
		// Request History, the unified-claim observations and every forecast built
		// on them must keep seeing what the provider actually said about the
		// account that served the request.
		seedWeekly("serving", 90);
		seedWeekly("sibling", 20);

		const { response, begins } = await forward({
			poolCandidates: [makeAccount("serving"), makeAccount("sibling")],
		});

		expect(begins).toHaveLength(1);
		expect(
			begins[0]?.responseHeaders?.[
				"anthropic-ratelimit-unified-7d-utilization"
			],
		).toBe("0.9");
		// ...while the client got the pooled figure from the same call.
		expect(
			response.headers.get("anthropic-ratelimit-unified-7d-utilization"),
		).toBe("0.2");
	});

	it("leaves headers untouched when no candidate list was stashed", async () => {
		// The forced-account and unauthenticated paths never run selection, so they
		// never stash one. Omission is what makes them inert.
		seedWeekly("serving", 90);

		const { response } = await forward({ poolCandidates: undefined });

		expect(
			response.headers.get("anthropic-ratelimit-unified-7d-utilization"),
		).toBe("0.9");
	});

	it("leaves headers untouched for an internal dispatch", async () => {
		// Auto-refresh probes and keepalive replays are the proxy's own traffic;
		// nothing there is reading a usage meter.
		seedWeekly("serving", 90);
		seedWeekly("sibling", 20);

		const { response } = await forward({
			internal: true,
			poolCandidates: [makeAccount("serving"), makeAccount("sibling")],
		});

		expect(
			response.headers.get("anthropic-ratelimit-unified-7d-utilization"),
		).toBe("0.9");
	});

	it("leaves headers untouched when there is no serving account", async () => {
		const { response } = await forward({
			account: null,
			poolCandidates: [makeAccount("sibling")],
		});

		expect(
			response.headers.get("anthropic-ratelimit-unified-7d-utilization"),
		).toBe("0.9");
	});

	it("adds nothing to a response that carried no rate-limit headers", async () => {
		// A window that never arrived must not be manufactured: with both
		// account-wide readings missing, the client falls back to its own persisted
		// figure, and inventing one here would silently override that.
		seedWeekly("serving", 90);
		seedWeekly("sibling", 20);

		const { response } = await forward({
			headers: { "x-request-id": "abc" },
			poolCandidates: [makeAccount("serving"), makeAccount("sibling")],
		});

		expect(
			response.headers.has("anthropic-ratelimit-unified-7d-utilization"),
		).toBe(false);
		expect(response.headers.has("x-codex-primary-used-percent")).toBe(false);
	});

	it("forwards the response unchanged when the pooled figure cannot be built", async () => {
		// Nothing about a display figure justifies failing a request, so a throw
		// inside the snapshot degrades to the serving account's own numbers.
		// The hostile object is a CANDIDATE, not the serving account: the serving
		// account is read by the forwarding path itself, so breaking that would
		// test the wrong failure.
		seedWeekly("serving", 90);
		const hostile = makeAccount("hostile");
		Object.defineProperty(hostile, "provider", {
			get() {
				throw new Error("provider blew up");
			},
		});

		const { response } = await forward({
			poolCandidates: [hostile],
		});

		expect(response.status).toBe(200);
		expect(
			response.headers.get("anthropic-ratelimit-unified-7d-utilization"),
		).toBe("0.9");
	});
});
