/**
 * Tests for the internal-dispatch spend sink in response-handler.ts.
 *
 * The proxy's own upstream traffic (cache-keepalive replays, auto-refresh
 * primes) is deliberately absent from `requests`, which also means it gets no
 * `usageState` — so its token spend was previously computed nowhere at all. This
 * sink is the only place that records it, and the two things it must never do
 * are record CLIENT traffic (already in `requests`, would double-count) and
 * fabricate a zero where the response reported nothing.
 */
import { describe, expect, it, mock, spyOn } from "bun:test";
import { Logger } from "@clankermux/logger";
import type { Account, InternalDispatchSpendRow } from "@clankermux/types";
import type { ProxyContext } from "../handlers";
import { forwardToClient } from "../response-handler";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "anthropic",
		api_key: null,
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
	};
}

interface Harness {
	ctx: ProxyContext;
	spend: InternalDispatchSpendRow[];
	enqueueCalls: number;
	isStream: boolean;
}

function makeHarness(
	opts: { enqueueAccepts?: boolean; isStream?: boolean } = {},
): Harness {
	const accepts = opts.enqueueAccepts ?? true;
	const spend: InternalDispatchSpendRow[] = [];
	const harness: Harness = {
		spend,
		enqueueCalls: 0,
		isStream: opts.isStream ?? false,
		ctx: undefined as unknown as ProxyContext,
	};
	harness.ctx = {
		provider: {
			name: "anthropic",
			isStreamingResponse: () => harness.isStream,
		},
		config: { getStorePayloads: () => false },
		dbOps: {
			saveUnifiedClaimObservations: mock(async () => {}),
			saveUnifiedSummaryObservation: mock(async () => {}),
			saveInternalDispatchSpend: mock(async (row: InternalDispatchSpendRow) => {
				spend.push(row);
			}),
		},
		asyncWriter: {
			enqueue: (job: () => Promise<void>) => {
				harness.enqueueCalls++;
				if (!accepts) return false;
				void job();
				return true;
			},
		},
		requestRecorder: {
			begin: mock(() => {}),
			captureResponseChunk: mock(() => {}),
			finishTransport: mock(() => {}),
			attachUsageSummary: mock(() => {}),
			markUsageUnavailable: mock(() => {}),
		},
	} as unknown as ProxyContext;
	return harness;
}

/** A non-streaming Anthropic `/v1/messages` reply carrying a usage object. */
function nonStreamKeepaliveResponse(): Response {
	return new Response(
		JSON.stringify({
			type: "message",
			model: "claude-sonnet-4-5",
			usage: {
				input_tokens: 4,
				output_tokens: 1,
				cache_read_input_tokens: 41_233,
				cache_creation_input_tokens: 0,
			},
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

/** The SSE form of the same reply, as a keepalive replay actually receives it. */
function sseKeepaliveResponse(): Response {
	const body =
		"event: message_start\n" +
		'data: {"type":"message_start","message":{"model":"claude-sonnet-4-5",' +
		'"usage":{"input_tokens":4,"output_tokens":1,' +
		'"cache_read_input_tokens":41233,"cache_creation_input_tokens":0}}}\n\n' +
		"event: message_delta\n" +
		'data: {"type":"message_delta","usage":{"output_tokens":7}}\n\n' +
		"event: message_stop\n" +
		'data: {"type":"message_stop"}\n\n';
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

async function forward(
	harness: Harness,
	opts: {
		account: Account | null;
		requestHeaders?: Headers;
		internal?: boolean;
		response: Response;
		timestamp?: number;
		requestId?: string;
	},
): Promise<void> {
	const response = await forwardToClient(
		{
			requestId: opts.requestId ?? "req-1",
			method: "POST",
			path: "/v1/messages",
			account: opts.account,
			requestHeaders: opts.requestHeaders ?? new Headers(),
			requestBody: null,
			internal: opts.internal,
			response: opts.response,
			timestamp: opts.timestamp ?? 1_700_000_000_000,
			retryAttempt: 0,
			failoverAttempts: 0,
		},
		harness.ctx,
	);
	// Drain the returned body so the streaming passthrough reaches its terminal
	// callback (and the non-stream tee's background read completes).
	await response.text();
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

const keepalive = new Headers({ "x-clankermux-keepalive": "true" });
const autoRefresh = new Headers({ "x-clankermux-auto-refresh": "true" });

describe("response-handler — internal dispatch spend", () => {
	it("extracts the token vector of a NON-SSE keepalive reply", async () => {
		const h = makeHarness();
		await forward(h, {
			account: makeAccount(),
			requestHeaders: keepalive,
			internal: true,
			response: nonStreamKeepaliveResponse(),
			timestamp: 1_700_000_000_000,
		});

		expect(h.spend).toHaveLength(1);
		const row = h.spend[0];
		expect(row.id).toBe("req-1");
		expect(row.accountId).toBe("acc-1");
		expect(row.source).toBe("keepalive");
		expect(row.model).toBe("claude-sonnet-4-5");
		expect(row.httpStatus).toBe(200);
		expect(row.startedAt).toBe(1_700_000_000_000);
		expect(row.inputTokens).toBe(4);
		expect(row.outputTokens).toBe(1);
		expect(row.cacheReadInputTokens).toBe(41_233);
		// A reported zero, not an absent reading.
		expect(row.cacheCreationInputTokens).toBe(0);
		expect(row.completedAt).not.toBeNull();
	});

	it("extracts the token vector of an SSE keepalive reply", async () => {
		const h = makeHarness({ isStream: true });
		await forward(h, {
			account: makeAccount(),
			requestHeaders: keepalive,
			internal: true,
			response: sseKeepaliveResponse(),
		});

		expect(h.spend).toHaveLength(1);
		const row = h.spend[0];
		expect(row.model).toBe("claude-sonnet-4-5");
		expect(row.inputTokens).toBe(4);
		expect(row.cacheReadInputTokens).toBe(41_233);
		// message_delta's cumulative count is the authoritative one.
		expect(row.outputTokens).toBe(7);
	});

	it("labels an auto-refresh prime with its own source", async () => {
		const h = makeHarness();
		await forward(h, {
			account: makeAccount(),
			requestHeaders: autoRefresh,
			internal: true,
			response: nonStreamKeepaliveResponse(),
		});
		expect(h.spend.map((r) => r.source)).toEqual(["auto-refresh"]);
	});

	it("NEVER writes a row for client traffic", async () => {
		const h = makeHarness();
		await forward(h, {
			account: makeAccount(),
			response: nonStreamKeepaliveResponse(),
		});
		expect(h.spend).toHaveLength(0);
	});

	it("SPOOF GUARD: a probe marker without an internal dispatch writes nothing", async () => {
		const h = makeHarness();
		await forward(h, {
			account: makeAccount(),
			requestHeaders: keepalive,
			// internal omitted → untrusted.
			response: nonStreamKeepaliveResponse(),
		});
		expect(h.spend).toHaveLength(0);
	});

	it("writes nothing for a probe with no account", async () => {
		const h = makeHarness();
		await forward(h, {
			account: null,
			requestHeaders: keepalive,
			internal: true,
			response: nonStreamKeepaliveResponse(),
		});
		expect(h.spend).toHaveLength(0);
	});

	it("records nulls, not zeros, when the response carried no usage", async () => {
		const h = makeHarness();
		await forward(h, {
			account: makeAccount(),
			requestHeaders: keepalive,
			internal: true,
			response: new Response(
				JSON.stringify({ type: "error", error: { type: "rate_limit_error" } }),
				{ status: 429, headers: { "Content-Type": "application/json" } },
			),
		});

		expect(h.spend).toHaveLength(1);
		const row = h.spend[0];
		expect(row.httpStatus).toBe(429);
		expect(row.inputTokens).toBeNull();
		expect(row.outputTokens).toBeNull();
		expect(row.cacheReadInputTokens).toBeNull();
		expect(row.cacheCreationInputTokens).toBeNull();
		expect(row.model).toBeNull();
	});

	it("records a probe whose response had no body at all", async () => {
		const h = makeHarness();
		await forward(h, {
			account: makeAccount(),
			requestHeaders: keepalive,
			internal: true,
			response: new Response(null, { status: 204 }),
		});
		expect(h.spend).toHaveLength(1);
		expect(h.spend[0].httpStatus).toBe(204);
		expect(h.spend[0].inputTokens).toBeNull();
	});

	it("writes exactly one row per dispatch, not one per terminal path", async () => {
		const h = makeHarness({ isStream: true });
		await forward(h, {
			account: makeAccount(),
			requestHeaders: keepalive,
			internal: true,
			response: sseKeepaliveResponse(),
		});
		expect(h.spend).toHaveLength(1);
	});

	it("warns when the writer queue rejects the job", async () => {
		const lines: string[] = [];
		const spy = spyOn(Logger.prototype, "warn").mockImplementation(
			(message: string) => {
				lines.push(message);
			},
		);
		try {
			const h = makeHarness({ enqueueAccepts: false });
			await forward(h, {
				account: makeAccount(),
				requestHeaders: keepalive,
				internal: true,
				response: nonStreamKeepaliveResponse(),
			});
			expect(h.spend).toHaveLength(0);
			const dropped = lines.filter((l) =>
				l.includes("internal dispatch spend"),
			);
			expect(dropped).toHaveLength(1);
			expect(dropped[0]).toContain("req-1");
		} finally {
			spy.mockRestore();
		}
	});
});
