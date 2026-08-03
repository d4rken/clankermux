import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import type { DrainReport } from "@clankermux/core/response-body-disposal";
import { Logger } from "@clankermux/logger";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../handlers";
import {
	EVENT_ABANDONED_BODY_COMPLETION_MARKER,
	EVENT_ABANDONED_BODY_OVERSIZE_NO_MARKER,
	reportAbandonedRateLimitedBody,
} from "../handlers/proxy-operations";

/**
 * Guard B: what the rate-limited failover throws away.
 *
 * The inline usage collector only ever sees bodies that are FORWARDED, so a
 * body abandoned on this path is usage nothing accounts for. Production says
 * the path carries error envelopes exclusively — this guard proves that stays
 * true, and is log-only: it observes the drain and changes nothing.
 *
 * The completion/usage MARKER is the primary signal. A size threshold alone
 * would be the wrong guard: `{"type":"message","usage":{…}}` is ~70 bytes, far
 * below any error-payload threshold, and is precisely the case worth catching.
 * "Large with no marker" is a separate, secondary alarm.
 */

const CTX = {
	requestId: "req-guard",
	accountName: "acct-name",
	accountId: "acct-1",
	provider: "anthropic",
	status: 429,
};

function makeReport(overrides: Partial<DrainReport> = {}): DrainReport {
	return {
		bytesRead: 128,
		reachedEof: true,
		stopReason: "eof",
		marker: null,
		...overrides,
	};
}

function captureWarnings(): { lines: string[]; restore: () => void } {
	const lines: string[] = [];
	const spy = spyOn(Logger.prototype, "warn").mockImplementation(
		(message: string) => {
			lines.push(message);
		},
	);
	return { lines, restore: () => spy.mockRestore() };
}

function withWarnings(run: () => void): string[] {
	const capture = captureWarnings();
	try {
		run();
	} finally {
		capture.restore();
	}
	return capture.lines;
}

describe("Guard B — reporting an abandoned rate-limited body", () => {
	afterEach(() => {
		mock.restore();
	});

	it("stays silent for an ordinary small error body", () => {
		const lines = withWarnings(() =>
			reportAbandonedRateLimitedBody(makeReport({ bytesRead: 412 }), CTX),
		);
		expect(lines).toEqual([]);
	});

	it("warns on a completion marker even at ~70 bytes", () => {
		const lines = withWarnings(() =>
			reportAbandonedRateLimitedBody(
				makeReport({ bytesRead: 70, marker: "anthropic-message-usage" }),
				CTX,
			),
		);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(
			`event=${EVENT_ABANDONED_BODY_COMPLETION_MARKER}`,
		);
		expect(lines[0]).toContain("marker=anthropic-message-usage");
		expect(lines[0]).toContain("requestId=req-guard");
		expect(lines[0]).toContain("account=acct-name");
		expect(lines[0]).toContain("provider=anthropic");
		expect(lines[0]).toContain("status=429");
		expect(lines[0]).toContain("bytes=70");
	});

	it("warns on an SSE marker too", () => {
		const lines = withWarnings(() =>
			reportAbandonedRateLimitedBody(
				makeReport({ bytesRead: 900, marker: "sse-message-delta" }),
				CTX,
			),
		);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("marker=sse-message-delta");
	});

	it("raises the size alarm for a large body with no marker", () => {
		const lines = withWarnings(() =>
			reportAbandonedRateLimitedBody(makeReport({ bytesRead: 64 * 1024 }), CTX),
		);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(
			`event=${EVENT_ABANDONED_BODY_OVERSIZE_NO_MARKER}`,
		);
		expect(lines[0]).toContain("bytes=65536");
	});

	it("does not double-report: a large body WITH a marker is the marker event only", () => {
		const lines = withWarnings(() =>
			reportAbandonedRateLimitedBody(
				makeReport({ bytesRead: 64 * 1024, marker: "sse-message-start" }),
				CTX,
			),
		);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(
			`event=${EVENT_ABANDONED_BODY_COMPLETION_MARKER}`,
		);
	});

	it("carries the partial byte count of a budget-stopped drain", () => {
		const lines = withWarnings(() =>
			reportAbandonedRateLimitedBody(
				makeReport({
					bytesRead: 8 * 1024 * 1024,
					reachedEof: false,
					stopReason: "byte-budget",
				}),
				CTX,
			),
		);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("bytes=8388608");
		expect(lines[0]).toContain("stopReason=byte-budget");
		expect(lines[0]).toContain("reachedEof=false");
	});
});

// ---------------------------------------------------------------------------
// The observer must never be on the failover's critical path.
// ---------------------------------------------------------------------------

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "test-provider" as Account["provider"],
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

function makeContext(accounts: Account[], provider: unknown): ProxyContext {
	return {
		strategy: { select: mock((all: Account[]) => all) },
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => null),
			updateAccountUsage: mock(async () => undefined),
			updateAccountRateLimitMeta: mock(async () => undefined),
			updateAccountTokens: mock(async () => true),
			updateRequestUsage: mock(async () => undefined),
			resetAccountSession: mock(async () => undefined),
			markAccountRateLimited: mock(async () => 1),
			markAccountRateLimitedDeadlineOnly: mock(async () => {}),
			saveRequest: mock(async () => undefined),
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
			getStorePayloads: () => false,
		} as never,
		provider: provider as never,
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
	} as unknown as ProxyContext;
}

const STUB_PROVIDER = {
	name: "test-provider",
	canHandle: () => true,
	buildUrl: () => "https://upstream.local/v1/messages",
	prepareHeaders: () => new Headers(),
	transformRequestBody: null,
	processResponse: async (r: Response) => r,
	parseRateLimit: (r: Response) => {
		const statusHeader = r.headers.get("anthropic-ratelimit-unified-status");
		return {
			isRateLimited: statusHeader === "rate_limited" || r.status === 429,
			resetTime: undefined,
			statusHeader: statusHeader ?? undefined,
			remaining: undefined,
		};
	},
	isStreamingResponse: () => false,
};

describe("Guard B — the observer does not delay the failover", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		mock.restore();
	});

	it("fail() returns while the abandoned body is still stalled mid-drain", async () => {
		// The body never completes until the test releases it. If the observer (or
		// the drain it hangs off) were on the critical path, handleProxy could not
		// settle before `release()` — which is the regression this pins.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let bodyFinished = false;
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				await gate;
				controller.enqueue(
					new TextEncoder().encode(
						'{"type":"message","usage":{"input_tokens":10,"output_tokens":2}}',
					),
				);
				controller.close();
				bodyFinished = true;
			},
		});
		const response = new Response(body, {
			status: 200,
			headers: {
				"content-type": "application/json",
				"anthropic-ratelimit-unified-status": "rate_limited",
			},
		});

		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request =
				input instanceof Request ? input : new Request(String(input));
			if (request.url.includes("models.dev")) {
				return new Response("{}", {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return response;
		}) as never;

		const capture = captureWarnings();
		const { handleProxy } = await import("../proxy");
		const ctx = makeContext([makeAccount()], STUB_PROVIDER);

		try {
			await handleProxy(
				new Request("https://proxy.local/v1/messages", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						model: "claude-sonnet-4-5",
						messages: [{ role: "user", content: "hello" }],
						max_tokens: 16,
					}),
				}),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);
		} catch {
			// Expected: every attempted account failed over → ServiceUnavailableError.
		}

		// handleProxy has settled and the body has NOT been read at all.
		expect(bodyFinished).toBe(false);
		expect(
			capture.lines.filter((l) =>
				l.startsWith(`event=${EVENT_ABANDONED_BODY_COMPLETION_MARKER}`),
			),
		).toEqual([]);

		// Release the body; only now can the drain finish and the observer report.
		release();
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			if (
				capture.lines.some((l) =>
					l.startsWith(`event=${EVENT_ABANDONED_BODY_COMPLETION_MARKER}`),
				)
			) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		capture.restore();

		const marked = capture.lines.filter((l) =>
			l.startsWith(`event=${EVENT_ABANDONED_BODY_COMPLETION_MARKER}`),
		);
		expect(marked).toHaveLength(1);
		expect(marked[0]).toContain("marker=anthropic-message-usage");
		expect(marked[0]).toContain("account=test-account");
	});
});
