/**
 * Tests for the single unified-claim capture site in response-handler.ts.
 *
 * The capture sits OUTSIDE the Request-History gate on purpose: cache-keepalive
 * replays and auto-refresh probes consume real quota and carry real claim
 * headers, so their readings belong in the series even though their rows are
 * deliberately kept out of Request History.
 */
import { describe, expect, it, mock, spyOn } from "bun:test";
import { Logger } from "@clankermux/logger";
import type { Account, UnifiedClaimObservationRow } from "@clankermux/types";
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
	begin: ReturnType<typeof mock>;
	/** Rows handed to dbOps, after the enqueued job has been run. */
	saved: UnifiedClaimObservationRow[][];
	enqueueCalls: number;
}

function makeHarness(opts: { enqueueAccepts?: boolean } = {}): Harness {
	const accepts = opts.enqueueAccepts ?? true;
	const saved: UnifiedClaimObservationRow[][] = [];
	const harness: Harness = {
		begin: mock(() => {}),
		saved,
		enqueueCalls: 0,
		ctx: undefined as unknown as ProxyContext,
	};
	harness.ctx = {
		provider: { name: "anthropic", isStreamingResponse: () => false },
		config: { getStorePayloads: () => false },
		dbOps: {
			saveUnifiedClaimObservations: mock(
				async (rows: UnifiedClaimObservationRow[]) => {
					saved.push(rows);
				},
			),
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
			begin: harness.begin,
			captureResponseChunk: mock(() => {}),
			finishTransport: mock(() => {}),
			attachUsageSummary: mock(() => {}),
			markUsageUnavailable: mock(() => {}),
		},
	} as unknown as ProxyContext;
	return harness;
}

/** A 200 carrying the per-claim headers of a healthy Anthropic response. */
function claimResponse(status = 200): Response {
	return new Response(JSON.stringify({ type: "message" }), {
		status,
		headers: {
			"Content-Type": "application/json",
			"anthropic-ratelimit-unified-5h-status": "allowed",
			"anthropic-ratelimit-unified-5h-utilization": "0.12",
			"anthropic-ratelimit-unified-5h-reset": "1785685200",
			"anthropic-ratelimit-unified-7d-status": "allowed_warning",
			"anthropic-ratelimit-unified-7d-utilization": "0.94",
			"anthropic-ratelimit-unified-7d-reset": "1785736800",
		},
	});
}

async function forward(
	harness: Harness,
	opts: {
		account: Account | null;
		requestHeaders?: Headers;
		internal?: boolean;
		response?: Response;
		timestamp?: number;
		requestId?: string;
	},
): Promise<void> {
	await forwardToClient(
		{
			requestId: opts.requestId ?? "req-1",
			method: "POST",
			path: "/v1/messages",
			account: opts.account,
			requestHeaders: opts.requestHeaders ?? new Headers(),
			requestBody: null,
			internal: opts.internal,
			response: opts.response ?? claimResponse(),
			timestamp: opts.timestamp ?? 1_700_000_000_000,
			retryAttempt: 0,
			failoverAttempts: 0,
		},
		harness.ctx,
	);
	// The write is enqueued synchronously; let the queued job's promise settle.
	await Promise.resolve();
	await Promise.resolve();
}

describe("response-handler — unified claim capture", () => {
	it("records every claim of an OAuth Anthropic response", async () => {
		const h = makeHarness();
		await forward(h, { account: makeAccount(), timestamp: 1_700_000_000_000 });

		expect(h.saved).toHaveLength(1);
		const rows = h.saved[0];
		expect(rows.map((r) => r.claim)).toEqual(["5h", "7d"]);
		expect(rows[0]).toEqual({
			requestId: "req-1",
			accountId: "acc-1",
			source: "client",
			requestStartedAt: 1_700_000_000_000,
			// Headers-arrival time, taken at capture — only its ordering relative to
			// the request start is asserted (see below).
			observedAt: rows[0].observedAt,
			httpStatus: 200,
			claim: "5h",
			status: "allowed",
			utilization: 0.12,
			resetAt: 1_785_685_200_000,
		});
		expect(rows[0].observedAt).toBeGreaterThan(1_700_000_000_000);
		expect(rows[1].utilization).toBe(0.94);
	});

	it("records a delivered 429 — it carries real claim state", async () => {
		const h = makeHarness();
		await forward(h, {
			account: makeAccount(),
			response: claimResponse(429),
		});
		expect(h.saved[0][0].httpStatus).toBe(429);
	});

	it("records a keepalive replay, which Request History deliberately skips", async () => {
		const h = makeHarness();
		await forward(h, {
			account: makeAccount(),
			requestHeaders: new Headers({ "x-clankermux-keepalive": "true" }),
			internal: true,
		});

		expect(h.saved[0].every((r) => r.source === "keepalive")).toBe(true);
		expect(h.begin).not.toHaveBeenCalled();
	});

	it("records an auto-refresh probe, which Request History deliberately skips", async () => {
		const h = makeHarness();
		await forward(h, {
			account: makeAccount(),
			requestHeaders: new Headers({ "x-clankermux-auto-refresh": "true" }),
			internal: true,
		});

		expect(h.saved[0].every((r) => r.source === "auto-refresh")).toBe(true);
		expect(h.begin).not.toHaveBeenCalled();
	});

	it("SPOOF GUARD: a probe marker without an internal dispatch is client traffic", async () => {
		const h = makeHarness();
		await forward(h, {
			account: makeAccount(),
			requestHeaders: new Headers({ "x-clankermux-keepalive": "true" }),
			// internal omitted → untrusted.
		});

		expect(h.saved[0].every((r) => r.source === "client")).toBe(true);
		expect(h.begin).toHaveBeenCalled();
	});

	it("does not record for a custom-endpoint account", async () => {
		const h = makeHarness();
		await forward(h, {
			account: makeAccount({ custom_endpoint: "https://proxy.example" }),
		});
		expect(h.enqueueCalls).toBe(0);
		expect(h.saved).toHaveLength(0);
	});

	it("does not record for a non-Anthropic account", async () => {
		const h = makeHarness();
		await forward(h, { account: makeAccount({ provider: "codex" }) });
		expect(h.enqueueCalls).toBe(0);
		expect(h.saved).toHaveLength(0);
	});

	it("does not record for an unauthenticated request", async () => {
		const h = makeHarness();
		await forward(h, { account: null });
		expect(h.enqueueCalls).toBe(0);
	});

	it("does not record when the response carries no claim headers", async () => {
		const h = makeHarness();
		await forward(h, {
			account: makeAccount(),
			response: new Response(JSON.stringify({ type: "message" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		});
		expect(h.enqueueCalls).toBe(0);
		expect(h.saved).toHaveLength(0);
	});

	it("warns once when the writer queue rejects the job", async () => {
		const lines: string[] = [];
		const spy = spyOn(Logger.prototype, "warn").mockImplementation(
			(message: string) => {
				lines.push(message);
			},
		);
		try {
			const h = makeHarness({ enqueueAccepts: false });
			await forward(h, { account: makeAccount() });
			expect(h.enqueueCalls).toBe(1);
			expect(h.saved).toHaveLength(0);
			const dropped = lines.filter((l) => l.includes("claim observation"));
			expect(dropped).toHaveLength(1);
			expect(dropped[0]).toContain("req-1");
		} finally {
			spy.mockRestore();
		}
	});
});
