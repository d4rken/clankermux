/**
 * Tests for the single unified-claim capture site in response-handler.ts.
 *
 * The capture sits OUTSIDE the Request-History gate on purpose: cache-keepalive
 * replays and auto-refresh probes consume real quota and carry real claim
 * headers, so their readings belong in the series even though their rows are
 * deliberately kept out of Request History.
 */
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Logger } from "@clankermux/logger";
import { usageCache } from "@clankermux/providers";
import { makeAccount as canonicalAccount } from "@clankermux/test-support";
import type {
	Account,
	UnifiedClaimObservationRow,
	UnifiedSummaryObservationRow,
} from "@clankermux/types";
import type { ProxyContext } from "../handlers";
import { forwardToClient } from "../response-handler";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return canonicalAccount({
		refresh_token: "",
		created_at: Date.now(),
		...overrides,
	});
}

interface Harness {
	ctx: ProxyContext;
	begin: ReturnType<typeof mock>;
	/** Rows handed to dbOps, after the enqueued job has been run. */
	saved: UnifiedClaimObservationRow[][];
	/** Summary rows handed to dbOps, after the enqueued job has been run. */
	savedSummaries: UnifiedSummaryObservationRow[];
	enqueueCalls: number;
}

function makeHarness(opts: { enqueueAccepts?: boolean } = {}): Harness {
	const accepts = opts.enqueueAccepts ?? true;
	const saved: UnifiedClaimObservationRow[][] = [];
	const savedSummaries: UnifiedSummaryObservationRow[] = [];
	const harness: Harness = {
		begin: mock(() => {}),
		saved,
		savedSummaries,
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
			saveUnifiedSummaryObservation: mock(
				async (row: UnifiedSummaryObservationRow) => {
					savedSummaries.push(row);
				},
			),
			saveInternalDispatchSpend: mock(async () => {}),
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
			surpassedThreshold: null,
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

describe("response-handler — unified summary capture", () => {
	it("records the summary block alongside the claim rows, in ONE job", async () => {
		const h = makeHarness();
		const response = new Response(JSON.stringify({ type: "error" }), {
			status: 429,
			headers: {
				"Content-Type": "application/json",
				"anthropic-ratelimit-unified-5h-status": "allowed",
				"anthropic-ratelimit-unified-5h-utilization": "0.12",
				"anthropic-ratelimit-unified-status": "rejected",
				"anthropic-ratelimit-unified-reset": "1785736800",
				"anthropic-ratelimit-unified-representative-claim":
					"seven_day_overage_included",
				"retry-after": "51811",
			},
		});
		await forward(h, {
			account: makeAccount(),
			response,
			timestamp: 1_700_000_000_000,
		});

		// One enqueue for both sides — a queue rejection can never half-record a
		// response.
		expect(h.enqueueCalls).toBe(1);
		expect(h.saved).toHaveLength(1);
		expect(h.savedSummaries).toHaveLength(1);
		const summary = h.savedSummaries[0];
		expect(summary.requestId).toBe("req-1");
		expect(summary.status).toBe("rejected");
		expect(summary.representativeClaim).toBe("seven_day_overage_included");
		expect(summary.retryAfter).toBe("51811");
		expect(summary.httpStatus).toBe(429);
		// Both sides share ONE observed_at, so a joined read never reconciles two
		// clocks for one response.
		expect(summary.observedAt).toBe(h.saved[0][0].observedAt);
		expect(summary.source).toBe("client");
	});

	it("records a summary-only burst 429 that carries no claim lines at all", async () => {
		const h = makeHarness();
		await forward(h, {
			account: makeAccount(),
			response: new Response(JSON.stringify({ type: "error" }), {
				status: 429,
				headers: {
					"Content-Type": "application/json",
					"retry-after": "5",
				},
			}),
		});

		// The claim extractor yields nothing here; the summary must not be gated
		// behind it, or the burst shape would go unrecorded entirely.
		expect(h.saved).toHaveLength(0);
		expect(h.savedSummaries).toHaveLength(1);
		expect(h.savedSummaries[0].retryAfter).toBe("5");
		expect(h.savedSummaries[0].status).toBeNull();
	});

	it("labels an internal probe's summary with the probe source", async () => {
		const h = makeHarness();
		await forward(h, {
			account: makeAccount(),
			requestHeaders: new Headers({ "x-clankermux-keepalive": "true" }),
			internal: true,
			response: new Response(JSON.stringify({ type: "error" }), {
				status: 429,
				headers: {
					"Content-Type": "application/json",
					"anthropic-ratelimit-unified-status": "rejected",
					"retry-after": "60",
				},
			}),
		});
		expect(h.savedSummaries).toHaveLength(1);
		expect(h.savedSummaries[0].source).toBe("keepalive");
	});
});

describe("response-handler — usage header store", () => {
	const HOUR = 3_600_000;
	let counter = 0;
	const registered: string[] = [];
	afterEach(() => {
		for (const id of registered.splice(0)) {
			usageCache.stopPolling(id);
			usageCache.delete(id);
		}
	});

	/** An Anthropic account with a registered poller that never fetches. */
	function polledAccount(overrides: Partial<Account> = {}): Account {
		const id = `hdr-capture-${Date.now()}-${counter++}`;
		registered.push(id);
		usageCache.startPolling(
			id,
			async () => "token",
			"anthropic",
			90_000,
			null,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ initialDelayMs: 10 * HOUR },
		);
		usageCache.set(id, {
			five_hour: {
				utilization: 10,
				resets_at: new Date(fiveResetS * 1000).toISOString(),
			},
			seven_day: {
				utilization: 20,
				resets_at: new Date(weekResetS * 1000).toISOString(),
			},
		});
		return makeAccount({ id, provider: "anthropic", ...overrides });
	}

	const fiveResetS = Math.floor((Date.now() + 2 * HOUR) / 1000);
	const weekResetS = Math.floor((Date.now() + 90 * HOUR) / 1000);

	function liveClaims(fiveStatus = "allowed", status = 200): Response {
		return new Response(JSON.stringify({ type: "message" }), {
			status,
			headers: {
				"Content-Type": "application/json",
				"anthropic-ratelimit-unified-5h-status": fiveStatus,
				"anthropic-ratelimit-unified-5h-utilization": "0.45",
				"anthropic-ratelimit-unified-5h-reset": String(fiveResetS),
				"anthropic-ratelimit-unified-7d-status": "allowed",
				"anthropic-ratelimit-unified-7d-utilization": "0.35",
				"anthropic-ratelimit-unified-7d-reset": String(weekResetS),
			},
		});
	}

	async function forwardWithEpoch(
		account: Account,
		epoch: number | null,
		response: Response,
	): Promise<void> {
		await forwardToClient(
			{
				requestId: "req-hdr",
				method: "POST",
				path: "/v1/messages",
				account,
				requestHeaders: new Headers(),
				requestBody: null,
				response,
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
				usageHeaderEpoch: epoch,
			},
			makeHarness().ctx,
		);
	}

	function windowsOf(id: string) {
		const data = usageCache.peekUsageView(id, "anthropic")?.data as {
			five_hour?: { utilization: number };
			seven_day?: { utilization: number };
		};
		return {
			fiveHour: data?.five_hour?.utilization,
			sevenDay: data?.seven_day?.utilization,
		};
	}

	it("feeds the 5h/7d readings of a response sent under the live epoch", async () => {
		const account = polledAccount();
		await forwardWithEpoch(
			account,
			usageCache.usageHeaderEpoch(account.id),
			liveClaims(),
		);
		expect(windowsOf(account.id)).toEqual({ fiveHour: 45, sevenDay: 35 });
	});

	it("drops a response sent before the poller restarted", async () => {
		const account = polledAccount();
		const epoch = usageCache.usageHeaderEpoch(account.id);
		usageCache.stopPolling(account.id);
		polledAccountRestart(account.id);
		await forwardWithEpoch(account, epoch, liveClaims());
		expect(windowsOf(account.id)).toEqual({ fiveHour: 10, sevenDay: 20 });
	});

	it("never feeds a custom-endpoint account", async () => {
		const account = polledAccount({ custom_endpoint: "https://example.test" });
		await forwardWithEpoch(
			account,
			usageCache.usageHeaderEpoch(account.id),
			liveClaims(),
		);
		expect(windowsOf(account.id)).toEqual({ fiveHour: 10, sevenDay: 20 });
	});

	it("feeds a delivered 429's allowed claims but not its rejected one", async () => {
		const account = polledAccount();
		await forwardWithEpoch(
			account,
			usageCache.usageHeaderEpoch(account.id),
			liveClaims("rejected", 429),
		);
		expect(windowsOf(account.id)).toEqual({ fiveHour: 10, sevenDay: 35 });
	});

	function polledAccountRestart(id: string): void {
		usageCache.startPolling(
			id,
			async () => "token",
			"anthropic",
			90_000,
			null,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ initialDelayMs: 10 * HOUR },
		);
		usageCache.set(id, {
			five_hour: {
				utilization: 10,
				resets_at: new Date(fiveResetS * 1000).toISOString(),
			},
			seven_day: {
				utilization: 20,
				resets_at: new Date(weekResetS * 1000).toISOString(),
			},
		});
	}
});
