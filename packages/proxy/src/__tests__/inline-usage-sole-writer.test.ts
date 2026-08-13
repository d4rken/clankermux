import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { getProvider } from "@clankermux/providers";
import type { Account, RequestResponse } from "@clankermux/types";
import type { ProxyContext } from "../handlers";
// Import the recorder FIRST: it pulls @clankermux/core before
// @clankermux/types, which is the load order that avoids the latent
// types↔core module-eval cycle (see request-recorder.ts).
import { RequestRecorder } from "../request-recorder";
import { drainPendingUsageFinalizers } from "../response-handler";

/**
 * The inline usage collector is the SOLE writer of per-request token usage.
 *
 * WHAT THIS PINS
 * --------------
 * That a normal, timely request persists its usage through the PRODUCTION
 * path: the collector feeds off the very bytes forwarded to the client,
 * `finalizeUsage` resolves a summary, `RequestRecorder.attachUsageSummary`
 * lands it BEFORE the record is written, and the row commits through
 * `saveRequest(..., usage)` in a single write.
 *
 * `updateRequestUsage` must NOT be called. That is the recorder's LATE-PATCH
 * path — it only runs when a summary arrives after the grace timer already
 * persisted the row usage-less. Asserting on it would pass even if the row had
 * committed with no usage at all, which is exactly the failure this file
 * exists to catch. It is asserted here as a negative for the same reason: it
 * was also the entry point of the deleted provider-extractor pipeline, so a
 * call to it would mean a second usage writer came back.
 *
 * Both response shapes this deployment actually runs are covered: an Anthropic
 * SSE stream (authoritative usage in the final `message_delta`) and a
 * non-streaming Anthropic JSON body.
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface SavedRow {
	id: string;
	usage: Record<string, unknown> | undefined;
}

class FakeDbOps {
	saveRequestCalls: SavedRow[] = [];
	updateUsageCalls: Array<{ id: string; usage: unknown }> = [];

	constructor(private readonly accounts: Account[]) {}

	async getAllAccounts(): Promise<Account[]> {
		return this.accounts;
	}
	async getActiveComboForFamily(): Promise<null> {
		return null;
	}
	async saveRequest(data: { id: string; usage?: unknown }): Promise<void> {
		this.saveRequestCalls.push({
			id: data.id,
			usage: data.usage as Record<string, unknown> | undefined,
		});
	}
	async saveRequestRouting(): Promise<void> {}
	async saveRequestToolCalls(): Promise<void> {}
	async encryptPayloadForStorage(json: string): Promise<string> {
		return json;
	}
	/** The LATE-PATCH path. Every test here asserts it never runs. */
	async updateRequestUsage(requestId: string, usage: unknown): Promise<void> {
		this.updateUsageCalls.push({ id: requestId, usage });
	}
	async pauseAccount(): Promise<void> {}
	async updateAccountUsage(): Promise<void> {}
	async updateAccountRateLimitMeta(): Promise<void> {}
	async updateAccountTokens(): Promise<boolean> {
		return true;
	}
	async resetAccountSession(): Promise<void> {}
	async markAccountRateLimited(): Promise<number> {
		return 1;
	}
	async markAccountRateLimitedDeadlineOnly(): Promise<void> {}
	async resetConsecutiveRateLimits(): Promise<void> {}
	getAdapter() {
		return {
			run: async () => undefined,
			get: async () => null,
		};
	}
}

/** FIFO stand-in for AsyncDbWriter: jobs queue and are drained on demand. */
class FakeAsyncWriter {
	private queue: Array<() => void | Promise<void>> = [];

	enqueue(job: () => void | Promise<void>): boolean {
		this.queue.push(job);
		return true;
	}
	canAcceptPayload(): boolean {
		return true;
	}
	recordPayloadDrop(): void {}
	reservePayload(bytes: number) {
		return { reservedBytes: bytes, release: () => {} };
	}
	enqueuePayload(): boolean {
		return true;
	}

	async drain(): Promise<void> {
		while (this.queue.length > 0) {
			const job = this.queue.shift();
			if (job) await job();
		}
		await Promise.resolve();
		await Promise.resolve();
	}
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acct-1",
		name: "inline-usage-account",
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

interface Harness {
	ctx: ProxyContext;
	dbOps: FakeDbOps;
	writer: FakeAsyncWriter;
	/** Flips when the recorder is handed a finalized summary. */
	attached: { value: boolean };
}

function makeHarness(): Harness {
	const account = makeAccount();
	const dbOps = new FakeDbOps([account]);
	const writer = new FakeAsyncWriter();
	const emitted: RequestResponse[] = [];
	const attached = { value: false };

	const recorder = new RequestRecorder({
		dbOps: dbOps as never,
		asyncWriter: writer as never,
		emitSummaryEvent: (r) => emitted.push(r),
		getStorePayloads: () => false,
	});
	// Observe the REAL attach (delegating, not replacing) so the test can wait
	// for the finalize to land instead of polling on a timer.
	const realAttach = recorder.attachUsageSummary.bind(recorder);
	recorder.attachUsageSummary = ((id: string, summary: never) => {
		attached.value = true;
		realAttach(id, summary);
	}) as typeof recorder.attachUsageSummary;

	const ctx = {
		strategy: { select: mock((all: Account[]) => all) },
		dbOps: dbOps as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getCacheWarmingEnabled: () => false,
			getCacheWarmingMinTokens: () => 100_000,
			getStorePayloads: () => false,
		} as never,
		provider: getProvider("anthropic") as never,
		refreshInFlight: new Map(),
		asyncWriter: writer as never,
		requestRecorder: recorder,
	} as unknown as ProxyContext;

	return { ctx, dbOps, writer, attached };
}

function makeRequest(): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			// Native-SDK marker: keeps the Anthropic provider's OpenAI
			// finish_reason transform out of the way so the stream the collector
			// sees is byte-identical to the upstream one.
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 64,
		}),
	});
}

/** Route every upstream fetch to `upstream`, stubbing the pricing catalogue. */
function stubFetch(upstream: () => Response): void {
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const request =
			input instanceof Request ? input : new Request(String(input));
		if (request.url.includes("models.dev")) {
			return new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return upstream();
	}) as never;
}

async function waitFor(
	predicate: () => boolean,
	label: string,
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

/**
 * Run one request end-to-end through `handleProxy` and settle every stage the
 * usage row depends on: forward the stream to completion (which is what fires
 * the transport finish), let the tracked finalizer resolve, then drain the
 * writer queue that carries `saveRequest`.
 */
async function runAndSettle(h: Harness): Promise<void> {
	const { handleProxy } = await import("../proxy");
	const response = await handleProxy(
		makeRequest(),
		new URL("https://proxy.local/v1/messages"),
		h.ctx,
	);
	// Draining the client body is what drives the analytics passthrough to EOF.
	await response.text();
	await waitFor(
		() => h.attached.value,
		"the recorder to be handed a finalized usage summary",
	);
	await drainPendingUsageFinalizers();
	await h.writer.drain();
}

const SSE_BODY = [
	"event: message_start",
	`data: ${JSON.stringify({
		type: "message_start",
		message: {
			model: "claude-sonnet-4-5",
			usage: {
				input_tokens: 100,
				output_tokens: 1,
				cache_creation_input_tokens: 10,
				cache_read_input_tokens: 5,
			},
		},
	})}`,
	"",
	"event: content_block_delta",
	`data: ${JSON.stringify({
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text: "hi" },
	})}`,
	"",
	"event: message_delta",
	`data: ${JSON.stringify({
		type: "message_delta",
		delta: { stop_reason: "end_turn" },
		// The authoritative final count — message_start's output_tokens is a
		// placeholder the collector deliberately ignores.
		usage: { output_tokens: 50 },
	})}`,
	"",
	"event: message_stop",
	`data: ${JSON.stringify({ type: "message_stop" })}`,
	"",
].join("\n");

const JSON_BODY = JSON.stringify({
	id: "msg_nonstream",
	type: "message",
	model: "claude-sonnet-4-5",
	content: [{ type: "text", text: "hi" }],
	usage: {
		input_tokens: 200,
		output_tokens: 25,
		cache_creation_input_tokens: 3,
		cache_read_input_tokens: 7,
	},
});

describe("inline usage is persisted by saveRequest, not by a late patch", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("persists the final message_delta usage of an Anthropic SSE stream", async () => {
		stubFetch(
			() =>
				new Response(SSE_BODY, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);

		const h = makeHarness();
		await runAndSettle(h);

		expect(h.dbOps.saveRequestCalls).toHaveLength(1);
		const usage = h.dbOps.saveRequestCalls[0].usage;
		expect(usage).toBeDefined();
		expect(usage?.model).toBe("claude-sonnet-4-5");
		expect(usage?.inputTokens).toBe(100);
		expect(usage?.cacheReadInputTokens).toBe(5);
		expect(usage?.cacheCreationInputTokens).toBe(10);
		// message_delta's 50 wins over message_start's placeholder 1.
		expect(usage?.outputTokens).toBe(50);
		expect(usage?.completionTokens).toBe(50);
		// promptTokens aggregates input + cacheRead + cacheCreation.
		expect(usage?.promptTokens).toBe(115);
		expect(usage?.totalTokens).toBe(165);

		// The row committed WITH its usage in one write — no late patch.
		expect(h.dbOps.updateUsageCalls).toEqual([]);
	});

	it("persists the usage object of a non-streaming Anthropic JSON body", async () => {
		stubFetch(
			() =>
				new Response(JSON_BODY, {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);

		const h = makeHarness();
		await runAndSettle(h);

		expect(h.dbOps.saveRequestCalls).toHaveLength(1);
		const usage = h.dbOps.saveRequestCalls[0].usage;
		expect(usage).toBeDefined();
		expect(usage?.model).toBe("claude-sonnet-4-5");
		expect(usage?.inputTokens).toBe(200);
		expect(usage?.cacheReadInputTokens).toBe(7);
		expect(usage?.cacheCreationInputTokens).toBe(3);
		expect(usage?.outputTokens).toBe(25);
		expect(usage?.completionTokens).toBe(25);
		expect(usage?.promptTokens).toBe(210);
		expect(usage?.totalTokens).toBe(235);

		expect(h.dbOps.updateUsageCalls).toEqual([]);
	});
});
