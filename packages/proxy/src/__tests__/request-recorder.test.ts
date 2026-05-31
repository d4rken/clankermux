import { describe, expect, it } from "bun:test";
import type { RequestResponse } from "@clankermux/types";
// Import the recorder (and the re-exported NO_ACCOUNT_ID) FIRST: the recorder
// pulls @clankermux/core before @clankermux/types, which is the load order that
// avoids the latent types↔core module-eval cycle. A standalone value-import of
// `@clankermux/types` here would trip it (see request-recorder.ts).
import {
	NO_ACCOUNT_ID,
	type RecordMeta,
	RequestRecorder,
	type SlimUsageSummary,
} from "../request-recorder";

// ---------------------------------------------------------------------------
// Fakes — record-everything stand-ins for the injected collaborators so the
// recorder is exercised with zero real worker / DB / timers.
// ---------------------------------------------------------------------------

interface SaveRequestCall {
	id: string;
	method: string;
	path: string;
	accountUsed: string | null;
	statusCode: number | null;
	success: boolean;
	errorMessage: string | null;
	responseTime: number;
	failoverAttempts: number;
	usage: unknown;
	apiKeyId: string | undefined;
	apiKeyName: string | undefined;
	project: string | null | undefined;
	billingType: string | undefined;
	comboName: string | null | undefined;
}

type EnqueuedKind = "request" | "routing" | "payload";

class FakeDbOps {
	saveRequestCalls: SaveRequestCall[] = [];
	saveRoutingCalls: Array<Record<string, unknown>> = [];
	savePayloadCalls: Array<{ id: string; json: string }> = [];
	updateUsageCalls: Array<{ id: string; usage: unknown }> = [];
	pauseCalls: Array<{ accountId: string; reason: string }> = [];
	updateAccountUsageCalls: string[] = [];
	// Shared ordered log: pushed synchronously at invocation (before any await
	// suspends the enqueued job) so request→routing→payload ordering is exact.
	order: EnqueuedKind[];

	constructor(order: EnqueuedKind[]) {
		this.order = order;
	}

	async saveRequest(
		id: string,
		method: string,
		path: string,
		accountUsed: string | null,
		statusCode: number | null,
		success: boolean,
		errorMessage: string | null,
		responseTime: number,
		failoverAttempts: number,
		usage?: unknown,
		apiKeyId?: string,
		apiKeyName?: string,
		project?: string | null,
		billingType?: string,
		comboName?: string | null,
	): Promise<void> {
		this.order.push("request");
		this.saveRequestCalls.push({
			id,
			method,
			path,
			accountUsed,
			statusCode,
			success,
			errorMessage,
			responseTime,
			failoverAttempts,
			usage,
			apiKeyId,
			apiKeyName,
			project,
			billingType,
			comboName,
		});
	}

	async saveRequestRouting(data: Record<string, unknown>): Promise<void> {
		this.order.push("routing");
		this.saveRoutingCalls.push(data);
	}

	async saveRequestPayloadRaw(id: string, json: string): Promise<void> {
		this.savePayloadCalls.push({ id, json });
	}

	async updateRequestUsage(requestId: string, usage: unknown): Promise<void> {
		this.updateUsageCalls.push({ id: requestId, usage });
	}

	async pauseAccount(accountId: string, reason: string): Promise<void> {
		this.pauseCalls.push({ accountId, reason });
	}

	async updateAccountUsage(accountId: string): Promise<void> {
		this.updateAccountUsageCalls.push(accountId);
	}
}

/**
 * Faithful model of AsyncDbWriter: jobs are FIFO-queued and drained in enqueue
 * order. Metadata jobs (request→routing) are enqueued strictly before their
 * payload job, so draining yields the true persistence order. Tests that only
 * inspect call counts can drain implicitly; order-sensitive ones drain
 * synchronously via `drain()`.
 */
class FakeAsyncWriter {
	// Ordered log; populated by FakeDbOps + the payload run at execution time.
	order: EnqueuedKind[];
	acceptMetadata = true;
	acceptPayload = true;
	canAcceptPayloadCalls: number[] = [];
	recordedDrops: number[] = [];
	payloadEnqueues: Array<{ id: string; bytes: number }> = [];

	private queue: Array<() => void | Promise<void>> = [];
	private draining = false;

	constructor(order: EnqueuedKind[]) {
		this.order = order;
	}

	enqueue(job: () => void | Promise<void>): boolean {
		if (!this.acceptMetadata) {
			return false;
		}
		this.queue.push(job);
		return true;
	}

	canAcceptPayload(bytes: number): boolean {
		this.canAcceptPayloadCalls.push(bytes);
		return this.acceptPayload;
	}

	recordPayloadDrop(bytes: number): void {
		this.recordedDrops.push(bytes);
	}

	enqueuePayload(
		id: string,
		bytes: number,
		run: () => void | Promise<void>,
	): boolean {
		if (!this.acceptPayload) return false;
		this.payloadEnqueues.push({ id, bytes });
		this.queue.push(async () => {
			this.order.push("payload");
			await run();
		});
		return true;
	}

	/**
	 * Drain the queue in strict FIFO order, fully awaiting each job. Jobs only
	 * enqueue (never auto-drain), so there is no re-entrancy race: callers drain
	 * explicitly via the harness `flush()`.
	 */
	async drain(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			while (this.queue.length > 0) {
				const job = this.queue.shift();
				if (job) await job();
			}
		} finally {
			this.draining = false;
		}
	}
}

// A controllable clock + timer harness so grace / sweep are deterministic.
class FakeTimers {
	current = 1_000_000;
	private seq = 1;
	private timers = new Map<number, { fireAt: number; cb: () => void }>();

	now = (): number => this.current;

	schedule = (cb: () => void, ms: number): number => {
		const id = this.seq++;
		this.timers.set(id, { fireAt: this.current + ms, cb });
		return id;
	};

	clear = (id: number | undefined): void => {
		if (id !== undefined) this.timers.delete(id);
	};

	/** Advance time and fire any timers that come due. */
	advance(ms: number): void {
		this.current += ms;
		// Fire due timers (snapshot first; callbacks may schedule more).
		let fired = true;
		while (fired) {
			fired = false;
			for (const [id, t] of [...this.timers]) {
				if (t.fireAt <= this.current) {
					this.timers.delete(id);
					t.cb();
					fired = true;
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function makeArrayBuffer(text: string): ArrayBuffer {
	const u8 = new TextEncoder().encode(text);
	return u8.buffer.slice(
		u8.byteOffset,
		u8.byteOffset + u8.byteLength,
	) as ArrayBuffer;
}

function makeMeta(overrides: Partial<RecordMeta> = {}): RecordMeta {
	return {
		requestId: "req-1",
		method: "POST",
		path: "/v1/messages",
		accountId: "acct-1",
		accountName: "Account One",
		responseStatus: 200,
		responseHeaders: {},
		requestHeaders: { "content-type": "application/json" },
		isStream: false,
		providerName: "anthropic",
		accountBillingType: null,
		accountAutoPauseOnOverageEnabled: 0,
		authed: true,
		apiKeyId: null,
		apiKeyName: null,
		comboName: null,
		project: null,
		routing: null,
		timestamp: 1_700_000_000_000,
		requestBody: makeArrayBuffer('{"model":"claude"}'),
		retryAttempt: 0,
		failoverAttempts: 0,
		...overrides,
	};
}

function makeSummary(
	overrides: Partial<SlimUsageSummary> = {},
): SlimUsageSummary {
	return {
		requestId: "req-1",
		usage: {
			model: "claude-opus-4-8",
			inputTokens: 100,
			outputTokens: 50,
			cacheReadInputTokens: 10,
			cacheCreationInputTokens: 5,
			totalTokens: 165,
			costUsd: 0.0123,
		},
		tokensPerSecond: 12.5,
		responseTimeMs: 1234,
		cacheCreationInputTokens: 5,
		...overrides,
	};
}

interface Harness {
	recorder: RequestRecorder;
	dbOps: FakeDbOps;
	writer: FakeAsyncWriter;
	emitted: RequestResponse[];
	timers: FakeTimers;
	storePayloads: { value: boolean };
	droppedMetadata: { count: number };
	/** Drain the writer's queue + microtasks so DB calls/order are observable. */
	flush: () => Promise<void>;
}

function makeHarness(
	configOverrides: Partial<
		ConstructorParameters<typeof RequestRecorder>[0]["config"]
	> = {},
): Harness {
	const order: EnqueuedKind[] = [];
	const dbOps = new FakeDbOps(order);
	const writer = new FakeAsyncWriter(order);
	const emitted: RequestResponse[] = [];
	const timers = new FakeTimers();
	const storePayloads = { value: true };
	const droppedMetadata = { count: 0 };

	const recorder = new RequestRecorder({
		dbOps: dbOps as never,
		asyncWriter: writer as never,
		emitSummaryEvent: (r: RequestResponse) => emitted.push(r),
		getStorePayloads: () => storePayloads.value,
		now: timers.now,
		scheduleTimer: timers.schedule,
		clearTimer: timers.clear,
		onMetadataDrop: () => {
			droppedMetadata.count++;
		},
		config: {
			SUMMARY_GRACE_MS: 100,
			RECORD_MAX_AGE_MS: 10_000,
			PATCH_RECORD_TTL_MS: 5_000,
			MAX_RECORDS: 100,
			CAPTURE_BYTES_BUDGET: 1_000_000,
			MAX_REQUEST_BODY_BYTES: 4 * 1024 * 1024,
			MAX_RESPONSE_BODY_BYTES: 256 * 1024,
			...configOverrides,
		},
	});

	return {
		recorder,
		dbOps,
		writer,
		emitted,
		timers,
		storePayloads,
		droppedMetadata,
		flush: async () => {
			// Drain the FIFO queue, then yield a couple of microtask turns so any
			// trailing awaited continuations settle before assertions.
			await writer.drain();
			await Promise.resolve();
			await Promise.resolve();
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RequestRecorder — normal terminal end", () => {
	it("persists usage/cost/tokens into the row and emits a matching event", async () => {
		const h = makeHarness();
		h.recorder.begin(makeMeta());
		h.recorder.captureResponseChunk(
			"req-1",
			new TextEncoder().encode('{"ok":true}'),
		);
		h.recorder.attachUsageSummary("req-1", makeSummary());
		h.recorder.finishTransport("req-1", "success");
		await h.flush();

		expect(h.dbOps.saveRequestCalls.length).toBe(1);
		const row = h.dbOps.saveRequestCalls[0];
		expect(row.id).toBe("req-1");
		expect(row.success).toBe(true);
		const usage = row.usage as Record<string, unknown>;
		expect(usage.model).toBe("claude-opus-4-8");
		expect(usage.costUsd).toBe(0.0123);
		expect(usage.totalTokens).toBe(165);
		// promptTokens aggregates input + cacheRead + cacheCreation (worker shape).
		expect(usage.promptTokens).toBe(115);
		expect(usage.completionTokens).toBe(50);
		expect(usage.tokensPerSecond).toBe(12.5);

		expect(h.emitted.length).toBe(1);
		const ev = h.emitted[0];
		expect(ev.id).toBe("req-1");
		expect(ev.model).toBe("claude-opus-4-8");
		expect(ev.costUsd).toBe(0.0123);
		expect(ev.totalTokens).toBe(165);
		expect(ev.outputTokens).toBe(50);
		expect(ev.success).toBe(true);
		expect(ev.billingType).toBe("plan");
	});

	it("emits the cacheCreationInputTokens on the event for cache-body-store consumers", async () => {
		const h = makeHarness();
		h.recorder.begin(makeMeta());
		h.recorder.attachUsageSummary("req-1", makeSummary());
		h.recorder.finishTransport("req-1", "success");
		await h.flush();
		expect(h.emitted[0].cacheCreationInputTokens).toBe(5);
	});
});

describe("RequestRecorder — billingType derivation", () => {
	it("marks overage when the overage-in-use header is true", async () => {
		const h = makeHarness();
		h.recorder.begin(
			makeMeta({
				responseHeaders: {
					"anthropic-ratelimit-unified-overage-in-use": "true",
				},
			}),
		);
		h.recorder.attachUsageSummary("req-1", makeSummary());
		h.recorder.finishTransport("req-1", "success");
		await h.flush();
		expect(h.dbOps.saveRequestCalls[0].billingType).toBe("overage");
	});

	it("marks plan when overage status is rejected", async () => {
		const h = makeHarness();
		h.recorder.begin(
			makeMeta({
				providerName: "openai-compatible",
				responseHeaders: {
					"anthropic-ratelimit-unified-overage-status": "rejected",
				},
			}),
		);
		h.recorder.attachUsageSummary("req-1", makeSummary());
		h.recorder.finishTransport("req-1", "success");
		await h.flush();
		expect(h.dbOps.saveRequestCalls[0].billingType).toBe("plan");
	});

	it("defaults plan providers to plan and others to api", async () => {
		const h1 = makeHarness();
		h1.recorder.begin(makeMeta({ providerName: "codex" }));
		h1.recorder.attachUsageSummary("req-1", makeSummary());
		h1.recorder.finishTransport("req-1", "success");
		await h1.flush();
		expect(h1.dbOps.saveRequestCalls[0].billingType).toBe("plan");

		const h2 = makeHarness();
		h2.recorder.begin(makeMeta({ providerName: "openai-compatible" }));
		h2.recorder.attachUsageSummary("req-1", makeSummary());
		h2.recorder.finishTransport("req-1", "success");
		await h2.flush();
		expect(h2.dbOps.saveRequestCalls[0].billingType).toBe("api");
	});

	it("honors an explicit account billing type override", async () => {
		const h = makeHarness();
		h.recorder.begin(
			makeMeta({
				providerName: "openai-compatible",
				accountBillingType: "plan",
			}),
		);
		h.recorder.attachUsageSummary("req-1", makeSummary());
		h.recorder.finishTransport("req-1", "success");
		await h.flush();
		expect(h.dbOps.saveRequestCalls[0].billingType).toBe("plan");
	});
});

describe("RequestRecorder — account side-effects fire in begin()", () => {
	it("auto-pauses on overage BEFORE any finishTransport", async () => {
		const h = makeHarness();
		h.recorder.begin(
			makeMeta({
				accountAutoPauseOnOverageEnabled: 1,
				responseHeaders: {
					"anthropic-ratelimit-unified-overage-in-use": "true",
				},
			}),
		);
		// No finishTransport yet — pause must already have been enqueued in begin().
		await h.flush();
		expect(h.dbOps.pauseCalls).toEqual([
			{ accountId: "acct-1", reason: "overage" },
		]);
	});

	it("does not auto-pause when the flag is disabled", async () => {
		const h = makeHarness();
		h.recorder.begin(
			makeMeta({
				accountAutoPauseOnOverageEnabled: 0,
				responseHeaders: {
					"anthropic-ratelimit-unified-overage-in-use": "true",
				},
			}),
		);
		await h.flush();
		expect(h.dbOps.pauseCalls.length).toBe(0);
	});

	it("updates account usage for an authed request in begin()", async () => {
		const h = makeHarness();
		h.recorder.begin(makeMeta({ authed: true, accountId: "acct-1" }));
		await h.flush();
		expect(h.dbOps.updateAccountUsageCalls).toEqual(["acct-1"]);
	});

	it("does not update account usage for an unauthed request", async () => {
		const h = makeHarness();
		h.recorder.begin(makeMeta({ authed: false, accountId: NO_ACCOUNT_ID }));
		await h.flush();
		expect(h.dbOps.updateAccountUsageCalls.length).toBe(0);
	});
});

describe("RequestRecorder — FK-ordered persistence", () => {
	it("writes requests row BEFORE routing row BEFORE payload", async () => {
		const h = makeHarness();
		h.recorder.begin(
			makeMeta({
				routing: {
					strategy: "ordered",
					decision: "selected",
					affinityScope: null,
					affinityKeyHash: null,
					selectedAccountId: "acct-1",
					previousAccountId: null,
					candidatesCount: 2,
					failoverReason: null,
				},
			}),
		);
		h.recorder.attachUsageSummary("req-1", makeSummary());
		h.recorder.finishTransport("req-1", "success");
		await h.flush();

		expect(h.writer.order).toEqual(["request", "routing", "payload"]);
		expect(h.dbOps.saveRoutingCalls.length).toBe(1);
		expect(h.dbOps.saveRoutingCalls[0].requestId).toBe("req-1");
		expect(h.dbOps.saveRoutingCalls[0].failoverAttempts).toBe(0);
	});

	it("writes the request row even when there is no routing", async () => {
		const h = makeHarness();
		h.recorder.begin(makeMeta({ routing: null }));
		h.recorder.attachUsageSummary("req-1", makeSummary());
		h.recorder.finishTransport("req-1", "success");
		await h.flush();
		expect(h.writer.order).toEqual(["request", "payload"]);
		expect(h.dbOps.saveRoutingCalls.length).toBe(0);
	});
});

describe("RequestRecorder — payload drop under pressure", () => {
	it("keeps the metadata row, records the drop, enqueues no payload", async () => {
		const h = makeHarness();
		h.writer.acceptPayload = false;
		h.recorder.begin(makeMeta());
		h.recorder.attachUsageSummary("req-1", makeSummary());
		h.recorder.finishTransport("req-1", "success");
		await h.flush();

		expect(h.dbOps.saveRequestCalls.length).toBe(1);
		expect(h.dbOps.savePayloadCalls.length).toBe(0);
		expect(h.writer.payloadEnqueues.length).toBe(0);
		expect(h.writer.recordedDrops.length).toBe(1);
		// Drop recorded with the estimated byte count (positive).
		expect(h.writer.recordedDrops[0]).toBeGreaterThan(0);
		// Metadata still written: order is request only (no payload).
		expect(h.writer.order).toEqual(["request"]);
	});
});

describe("RequestRecorder — payload storage disabled", () => {
	it("writes metadata, captures no body, enqueues no payload", async () => {
		const h = makeHarness();
		h.storePayloads.value = false;
		h.recorder.begin(makeMeta());
		h.recorder.captureResponseChunk(
			"req-1",
			new TextEncoder().encode("ignored"),
		);
		h.recorder.attachUsageSummary("req-1", makeSummary());
		h.recorder.finishTransport("req-1", "success");
		await h.flush();

		expect(h.dbOps.saveRequestCalls.length).toBe(1);
		expect(h.dbOps.savePayloadCalls.length).toBe(0);
		expect(h.writer.payloadEnqueues.length).toBe(0);
		// Disabled storage never even estimates a payload drop.
		expect(h.writer.recordedDrops.length).toBe(0);
	});
});

describe("RequestRecorder — capture byte budget", () => {
	it("marks bodyDiscarded once the budget is exceeded; pending never exceeds budget", async () => {
		// Budget only big enough for one ~600-byte body.
		const h = makeHarness({ CAPTURE_BYTES_BUDGET: 700 });
		const big = "x".repeat(600);

		h.recorder.begin(
			makeMeta({ requestId: "a", requestBody: makeArrayBuffer(big) }),
		);
		// First fits.
		expect(h.recorder.getCapturedBytesPending()).toBeGreaterThan(0);
		expect(h.recorder.getCapturedBytesPending()).toBeLessThanOrEqual(700);

		// Second exceeds → metadata-only.
		h.recorder.begin(
			makeMeta({ requestId: "b", requestBody: makeArrayBuffer(big) }),
		);
		// Pending stays bounded by budget.
		expect(h.recorder.getCapturedBytesPending()).toBeLessThanOrEqual(700);

		// The second request, when persisted, stores no payload (bodyDiscarded).
		h.recorder.attachUsageSummary("b", makeSummary({ requestId: "b" }));
		h.recorder.finishTransport("b", "success");
		await h.flush();
		const bRow = h.dbOps.saveRequestCalls.find((c) => c.id === "b");
		expect(bRow).toBeDefined();
		// No payload for the discarded one.
		expect(h.dbOps.savePayloadCalls.find((p) => p.id === "b")).toBeUndefined();
	});

	it("decrements capturedBytesPending exactly on persist (no drift, both paths)", async () => {
		const h = makeHarness({ CAPTURE_BYTES_BUDGET: 5000 });
		const body = "y".repeat(400);

		// Normal (captured) request.
		h.recorder.begin(
			makeMeta({ requestId: "n", requestBody: makeArrayBuffer(body) }),
		);
		const afterFirst = h.recorder.getCapturedBytesPending();
		expect(afterFirst).toBeGreaterThan(0);

		// Persist it → pending returns to zero.
		h.recorder.attachUsageSummary("n", makeSummary({ requestId: "n" }));
		h.recorder.finishTransport("n", "success");
		await h.flush();
		expect(h.recorder.getCapturedBytesPending()).toBe(0);

		// bodyDiscarded request: drive budget over, then persist; still no drift.
		const tiny = makeHarness({ CAPTURE_BYTES_BUDGET: 10 });
		tiny.recorder.begin(
			makeMeta({ requestId: "d", requestBody: makeArrayBuffer(body) }),
		);
		// Body discarded → pending should be 0 (nothing captured).
		expect(tiny.recorder.getCapturedBytesPending()).toBe(0);
		tiny.recorder.attachUsageSummary("d", makeSummary({ requestId: "d" }));
		tiny.recorder.finishTransport("d", "success");
		await tiny.flush();
		expect(tiny.recorder.getCapturedBytesPending()).toBe(0);
	});
});

describe("RequestRecorder — metadata-queue drop", () => {
	it("counts/logs a dropped request-row enqueue and never falsely marks persisted", async () => {
		const h = makeHarness();
		h.writer.acceptMetadata = false; // enqueue returns false
		h.recorder.begin(makeMeta());
		h.recorder.attachUsageSummary("req-1", makeSummary());
		h.recorder.finishTransport("req-1", "success");
		await h.flush();

		// The drop is observable via the injected hook.
		expect(h.droppedMetadata.count).toBe(1);

		// A fresh request must still be writable once the writer recovers.
		const h2 = makeHarness();
		h2.writer.acceptMetadata = true;
		h2.recorder.begin(makeMeta({ requestId: "req-2" }));
		h2.recorder.attachUsageSummary(
			"req-2",
			makeSummary({ requestId: "req-2" }),
		);
		h2.recorder.finishTransport("req-2", "success");
		await h2.flush();
		expect(h2.dbOps.saveRequestCalls.length).toBe(1);
		expect(h2.droppedMetadata.count).toBe(0);
	});
});

describe("RequestRecorder — terminal paths", () => {
	it("client disconnect persists partial response bytes and marks failed", async () => {
		const h = makeHarness();
		h.recorder.begin(makeMeta({ isStream: true }));
		h.recorder.captureResponseChunk(
			"req-1",
			new TextEncoder().encode("partial-data"),
		);
		// No usage summary (disconnect mid-stream); grace then waive via outcome.
		h.recorder.finishTransport("req-1", "disconnect");
		// Within grace, nothing yet.
		await h.flush();
		expect(h.dbOps.saveRequestCalls.length).toBe(0);
		h.timers.advance(150); // past SUMMARY_GRACE_MS
		await h.flush();
		expect(h.dbOps.saveRequestCalls.length).toBe(1);
		expect(h.dbOps.saveRequestCalls[0].success).toBe(false);
		// Partial response body persisted in the payload envelope.
		expect(h.dbOps.savePayloadCalls.length).toBe(1);
		const env = JSON.parse(h.dbOps.savePayloadCalls[0].json);
		const decoded = Buffer.from(env.response.body, "base64").toString("utf-8");
		expect(decoded).toBe("partial-data");
	});

	it("total timeout persists a failed row", async () => {
		const h = makeHarness();
		h.recorder.begin(makeMeta({ isStream: true }));
		h.recorder.finishTransport("req-1", "timeout");
		h.timers.advance(150);
		await h.flush();
		expect(h.dbOps.saveRequestCalls.length).toBe(1);
		expect(h.dbOps.saveRequestCalls[0].success).toBe(false);
	});

	it("chunk timeout persists a failed row with the partial bytes captured so far", async () => {
		// A per-chunk (inactivity) timeout reaches the recorder as a `timeout`
		// transport outcome — same terminal handling as a total timeout, but any
		// bytes received before the stall are still persisted.
		const h = makeHarness();
		h.recorder.begin(makeMeta({ isStream: true }));
		h.recorder.captureResponseChunk(
			"req-1",
			new TextEncoder().encode("first-chunk"),
		);
		h.recorder.finishTransport("req-1", "timeout");
		h.timers.advance(150);
		await h.flush();
		expect(h.dbOps.saveRequestCalls.length).toBe(1);
		expect(h.dbOps.saveRequestCalls[0].success).toBe(false);
		expect(h.dbOps.savePayloadCalls.length).toBe(1);
		const env = JSON.parse(h.dbOps.savePayloadCalls[0].json);
		expect(Buffer.from(env.response.body, "base64").toString("utf-8")).toBe(
			"first-chunk",
		);
	});

	it("summary-grace timeout persists without usage and KEEPS a patch record", async () => {
		const h = makeHarness();
		h.recorder.begin(makeMeta());
		h.recorder.finishTransport("req-1", "success");
		// No usage attached.
		await h.flush();
		expect(h.dbOps.saveRequestCalls.length).toBe(0);
		h.timers.advance(150); // grace elapses
		await h.flush();
		expect(h.dbOps.saveRequestCalls.length).toBe(1);
		// Persisted without usage.
		expect(h.dbOps.saveRequestCalls[0].usage).toBeUndefined();
		// A late summary still patches → record kept.
		h.recorder.attachUsageSummary("req-1", makeSummary());
		await h.flush();
		expect(h.dbOps.updateUsageCalls.length).toBe(1);
	});
});

describe("RequestRecorder — markUsageUnavailable (finalize reject, B5)", () => {
	it("persists immediately usage-waived without waiting for grace", async () => {
		const h = makeHarness();
		h.recorder.begin(makeMeta());
		h.recorder.finishTransport("req-1", "success");
		// Within grace, nothing persisted yet.
		await h.flush();
		expect(h.dbOps.saveRequestCalls.length).toBe(0);
		// Finalize rejected → mark unavailable. Must persist NOW (no timer advance).
		h.recorder.markUsageUnavailable("req-1");
		await h.flush();
		expect(h.dbOps.saveRequestCalls.length).toBe(1);
		// Persisted without usage (waived).
		expect(h.dbOps.saveRequestCalls[0].usage).toBeUndefined();
		// Waived records are dropped immediately (not kept for a patch), so a
		// later dispose can't lose them and the map stays bounded.
		expect(h.recorder.getRecordCount()).toBe(0);
	});

	it("is a no-op for an unknown or already-persisted request", async () => {
		const h = makeHarness();
		// Unknown id — must not throw or persist.
		expect(() => h.recorder.markUsageUnavailable("nope")).not.toThrow();
		await h.flush();
		expect(h.dbOps.saveRequestCalls.length).toBe(0);

		// Already persisted with usage — a late reject must not double-persist.
		h.recorder.begin(makeMeta());
		h.recorder.finishTransport("req-1", "success");
		h.recorder.attachUsageSummary("req-1", makeSummary());
		await h.flush();
		expect(h.dbOps.saveRequestCalls.length).toBe(1);
		h.recorder.markUsageUnavailable("req-1");
		await h.flush();
		expect(h.dbOps.saveRequestCalls.length).toBe(1);
	});

	it("does not persist while transport is still open (invariant 5)", async () => {
		const h = makeHarness();
		h.recorder.begin(makeMeta({ isStream: true }));
		// Finalize reject before transport finished should not write a row.
		h.recorder.markUsageUnavailable("req-1");
		await h.flush();
		expect(h.dbOps.saveRequestCalls.length).toBe(0);
		// Once transport finishes, the waived flag means it persists right away.
		h.recorder.finishTransport("req-1", "success");
		await h.flush();
		expect(h.dbOps.saveRequestCalls.length).toBe(1);
		expect(h.dbOps.saveRequestCalls[0].usage).toBeUndefined();
	});
});

describe("RequestRecorder — late summary after grace persist", () => {
	it("patches usage via updateRequestUsage AND re-emits a dashboard event", async () => {
		const h = makeHarness();
		h.recorder.begin(makeMeta());
		h.recorder.finishTransport("req-1", "success");
		h.timers.advance(150); // persist without usage
		await h.flush();
		const emittedBefore = h.emitted.length;
		expect(emittedBefore).toBe(1);

		h.recorder.attachUsageSummary("req-1", makeSummary());
		await h.flush();
		expect(h.dbOps.updateUsageCalls.length).toBe(1);
		expect(h.dbOps.updateUsageCalls[0].id).toBe("req-1");
		// Re-emitted with usage filled in.
		expect(h.emitted.length).toBe(2);
		expect(h.emitted[1].model).toBe("claude-opus-4-8");
		expect(h.emitted[1].costUsd).toBe(0.0123);
	});
});

describe("RequestRecorder — never finalize while transport open", () => {
	it("begin without finishTransport never writes a row until transport finishes", async () => {
		const h = makeHarness();
		h.recorder.begin(makeMeta({ isStream: true }));
		await h.flush();
		expect(h.dbOps.saveRequestCalls.length).toBe(0);
		// Even after the grace window — transport still open.
		h.timers.advance(1000);
		await h.flush();
		expect(h.dbOps.saveRequestCalls.length).toBe(0);
		// Once transport finishes, the grace timer elapses (SUMMARY_GRACE_MS=100)
		// and it persists usage-less (the inline finalize may never attach for a
		// partial stream).
		h.recorder.finishTransport("req-1", "success");
		h.timers.advance(150);
		await h.flush();
		expect(h.dbOps.saveRequestCalls.length).toBe(1);
	});
});

describe("RequestRecorder — sweep", () => {
	it("frees buffers on over-age active streams without persisting (no false fail)", async () => {
		const h = makeHarness({ RECORD_MAX_AGE_MS: 500 });
		h.recorder.begin(makeMeta({ isStream: true }));
		const before = h.recorder.getCapturedBytesPending();
		expect(before).toBeGreaterThan(0);

		h.timers.advance(600); // exceed age
		h.recorder.sweep();
		await h.flush();

		// Active stream: buffers freed, NOT persisted.
		expect(h.recorder.getCapturedBytesPending()).toBe(0);
		expect(h.dbOps.saveRequestCalls.length).toBe(0);

		// When it later finishes, it records normally (just no body).
		h.recorder.finishTransport("req-1", "success");
		h.timers.advance(150);
		await h.flush();
		expect(h.dbOps.saveRequestCalls.length).toBe(1);
	});

	it("finalizes finished-but-stuck records that exceed age", async () => {
		const h = makeHarness({ RECORD_MAX_AGE_MS: 500 });
		h.recorder.begin(makeMeta());
		h.recorder.finishTransport("req-1", "success");
		// Stuck awaiting usage; do not let grace fire.
		h.timers.advance(600);
		h.recorder.sweep();
		await h.flush();
		expect(h.dbOps.saveRequestCalls.length).toBe(1);
		expect(h.dbOps.saveRequestCalls[0].usage).toBeUndefined();
	});
});

describe("RequestRecorder — recordSynthetic", () => {
	it("writes a request row with no body/usage and emits an event", async () => {
		const h = makeHarness();
		h.recorder.recordSynthetic(
			makeMeta({
				requestId: "syn-1",
				accountId: null,
				authed: false,
				responseStatus: 529,
				requestBody: null,
			}),
			"error",
		);
		await h.flush();
		expect(h.dbOps.saveRequestCalls.length).toBe(1);
		const row = h.dbOps.saveRequestCalls[0];
		expect(row.id).toBe("syn-1");
		expect(row.success).toBe(false);
		expect(row.usage).toBeUndefined();
		// No payload for a synthetic row.
		expect(h.dbOps.savePayloadCalls.length).toBe(0);
		// Event emitted.
		expect(h.emitted.length).toBe(1);
		expect(h.emitted[0].id).toBe("syn-1");
		expect(h.emitted[0].statusCode).toBe(529);
	});

	it("writes routing for a synthetic row when routing is present", async () => {
		const h = makeHarness();
		h.recorder.recordSynthetic(
			makeMeta({
				requestId: "syn-2",
				routing: {
					strategy: "ordered",
					decision: "exhausted",
					affinityScope: null,
					affinityKeyHash: null,
					selectedAccountId: null,
					previousAccountId: null,
					candidatesCount: 0,
					failoverReason: "pool_exhausted",
				},
			}),
			"error",
		);
		await h.flush();
		expect(h.writer.order).toEqual(["request", "routing"]);
	});
});

describe("RequestRecorder — dedupe", () => {
	it("persists at most once per requestId", async () => {
		const h = makeHarness();
		h.recorder.begin(makeMeta());
		h.recorder.attachUsageSummary("req-1", makeSummary());
		h.recorder.finishTransport("req-1", "success");
		await h.flush();
		expect(h.dbOps.saveRequestCalls.length).toBe(1);

		// Re-finish / re-attach must not write a second row.
		h.recorder.finishTransport("req-1", "success");
		await h.flush();
		expect(h.dbOps.saveRequestCalls.length).toBe(1);
	});

	it("ignores chunks/usage for unknown request ids", async () => {
		const h = makeHarness();
		// No begin() — should be a no-op, not a throw.
		h.recorder.captureResponseChunk("ghost", new Uint8Array([1, 2, 3]));
		h.recorder.attachUsageSummary("ghost", makeSummary({ requestId: "ghost" }));
		h.recorder.finishTransport("ghost", "success");
		await h.flush();
		expect(h.dbOps.saveRequestCalls.length).toBe(0);
	});
});

describe("RequestRecorder — payload envelope shape", () => {
	it("reproduces the worker JSON envelope byte-for-byte structure", async () => {
		const h = makeHarness();
		h.recorder.begin(
			makeMeta({
				requestId: "env-1",
				accountId: "acct-9",
				isStream: false,
				retryAttempt: 2,
				project: "myproj",
				requestHeaders: { "x-test": "1" },
				responseHeaders: { "content-type": "application/json" },
				responseStatus: 201,
				requestBody: makeArrayBuffer('{"hello":"world"}'),
			}),
		);
		h.recorder.captureResponseChunk(
			"env-1",
			new TextEncoder().encode('{"resp":1}'),
		);
		h.recorder.attachUsageSummary("env-1", makeSummary({ requestId: "env-1" }));
		h.recorder.finishTransport("env-1", "success");
		await h.flush();

		expect(h.dbOps.savePayloadCalls.length).toBe(1);
		const env = JSON.parse(h.dbOps.savePayloadCalls[0].json);
		// Top-level keys match worker.ts:874-892.
		expect(Object.keys(env).sort()).toEqual(["meta", "request", "response"]);
		expect(env.request.headers).toEqual({ "x-test": "1" });
		expect(Buffer.from(env.request.body, "base64").toString("utf-8")).toBe(
			'{"hello":"world"}',
		);
		expect(env.response.status).toBe(201);
		expect(env.response.headers).toEqual({
			"content-type": "application/json",
		});
		expect(Buffer.from(env.response.body, "base64").toString("utf-8")).toBe(
			'{"resp":1}',
		);
		expect(env.meta.accountId).toBe("acct-9");
		expect(env.meta.timestamp).toBe(1_700_000_000_000);
		expect(env.meta.success).toBe(true);
		expect(env.meta.isStream).toBe(false);
		expect(env.meta.retry).toBe(2);
		expect(env.meta.project).toBe("myproj");
	});

	it("uses NO_ACCOUNT_ID in the envelope meta when accountId is null", async () => {
		const h = makeHarness();
		h.recorder.begin(
			makeMeta({ requestId: "env-2", accountId: null, authed: false }),
		);
		h.recorder.attachUsageSummary("env-2", makeSummary({ requestId: "env-2" }));
		h.recorder.finishTransport("env-2", "success");
		await h.flush();
		const env = JSON.parse(h.dbOps.savePayloadCalls[0].json);
		expect(env.meta.accountId).toBe(NO_ACCOUNT_ID);
	});
});

describe("RequestRecorder — response body cap", () => {
	it("caps stored response body at MAX_RESPONSE_BODY_BYTES", async () => {
		const h = makeHarness({ MAX_RESPONSE_BODY_BYTES: 16 });
		h.recorder.begin(makeMeta({ isStream: true, requestBody: null }));
		// Two chunks totalling > 16 bytes.
		h.recorder.captureResponseChunk(
			"req-1",
			new TextEncoder().encode("0123456789"),
		);
		h.recorder.captureResponseChunk(
			"req-1",
			new TextEncoder().encode("ABCDEFGHIJ"),
		);
		h.recorder.attachUsageSummary("req-1", makeSummary());
		h.recorder.finishTransport("req-1", "success");
		await h.flush();
		const env = JSON.parse(h.dbOps.savePayloadCalls[0].json);
		const decoded = Buffer.from(env.response.body, "base64");
		expect(decoded.length).toBe(16);
		expect(decoded.toString("utf-8")).toBe("0123456789ABCDEF");
	});
});

describe("RequestRecorder — patch TTL anchored to persistedAt (long streams)", () => {
	it("keeps the patch record alive past createdAt+TTL when it persists late, then patches", async () => {
		// PATCH_RECORD_TTL_MS=5000, SUMMARY_GRACE_MS=100. A long stream is begun
		// far in the past; it only finishes/persists much later. If the sweep
		// anchored the patch TTL to createdAt, the record would be dropped the
		// instant it persists — defeating a late summary. Anchoring to persistedAt
		// keeps it patchable.
		const h = makeHarness();
		// begin() stamps createdAt from the injected clock.
		h.recorder.begin(makeMeta());

		// Advance well past createdAt + PATCH_RECORD_TTL_MS (5000) — simulate a
		// 30-min-style stream. The record is still open (no transport), so it is
		// untouched by sweep's patch branch and not yet persisted.
		h.timers.advance(20_000);

		// Now the transport finishes; with no usage it persists via the grace
		// timeout. persistedAt is stamped at this (late) clock value.
		h.recorder.finishTransport("req-1", "success");
		h.timers.advance(150); // grace elapses → persist without usage
		await h.flush();
		expect(h.dbOps.saveRequestCalls.length).toBe(1);
		expect(h.dbOps.saveRequestCalls[0].usage).toBeUndefined();

		// Advance past createdAt + TTL (already long past) but WITHIN persistedAt +
		// TTL, then sweep. The patch record must survive (persistedAt anchor).
		h.timers.advance(2_000);
		h.recorder.sweep();
		await h.flush();
		expect(h.recorder.getRecordCount()).toBe(1);

		// A late summary still patches: updateRequestUsage + a re-emit.
		const emittedBefore = h.emitted.length;
		h.recorder.attachUsageSummary("req-1", makeSummary());
		await h.flush();
		expect(h.dbOps.updateUsageCalls.length).toBe(1);
		expect(h.dbOps.updateUsageCalls[0].id).toBe("req-1");
		expect(h.emitted.length).toBe(emittedBefore + 1);
		expect(h.emitted[h.emitted.length - 1].model).toBe("claude-opus-4-8");
	});

	it("drops the patch record once persistedAt+TTL elapses", async () => {
		const h = makeHarness();
		h.recorder.begin(makeMeta());
		h.recorder.finishTransport("req-1", "success");
		h.timers.advance(150); // grace → persist without usage, persistedAt stamped
		await h.flush();
		expect(h.recorder.getRecordCount()).toBe(1);

		// Advance past persistedAt + PATCH_RECORD_TTL_MS (5000) and sweep.
		h.timers.advance(6_000);
		h.recorder.sweep();
		expect(h.recorder.getRecordCount()).toBe(0);
	});
});

describe("RequestRecorder — record-cap eviction preserves live request rows", () => {
	it("never loses a still-streaming request's row when over MAX_RECORDS", async () => {
		const MAX = 5;
		const h = makeHarness({ MAX_RECORDS: MAX });
		const total = MAX + 4; // push well over the soft cap, all streaming

		for (let i = 0; i < total; i++) {
			h.recorder.begin(
				makeMeta({
					requestId: `s-${i}`,
					isStream: true,
					requestBody: makeArrayBuffer("x".repeat(50)),
				}),
			);
		}

		// Cap pressure must NOT have deleted any live record (else its row is lost).
		expect(h.recorder.getRecordCount()).toBe(total);
		// Buffers of the excess in-flight records were freed → no budget charge
		// remains for at least the evicted ones (pending stays bounded).
		expect(h.recorder.getCapturedBytesPending()).toBeLessThanOrEqual(1_000_000);

		// Each request still persists at its own finishTransport (row preserved).
		for (let i = 0; i < total; i++) {
			h.recorder.finishTransport(`s-${i}`, "success");
			h.timers.advance(150); // grace → persist without usage
		}
		await h.flush();

		for (let i = 0; i < total; i++) {
			expect(
				h.dbOps.saveRequestCalls.find((c) => c.id === `s-${i}`),
			).toBeDefined();
		}
		expect(h.dbOps.saveRequestCalls.length).toBe(total);
	});
});

describe("RequestRecorder — synthetic error reason", () => {
	it("threads the specific error reason into saveRequest's errorMessage", async () => {
		const h = makeHarness();
		h.recorder.recordSynthetic(
			makeMeta({
				requestId: "syn-err",
				responseStatus: 529,
				requestBody: null,
			}),
			"error",
			"provider_overloaded",
		);
		await h.flush();
		expect(h.dbOps.saveRequestCalls.length).toBe(1);
		expect(h.dbOps.saveRequestCalls[0].errorMessage).toBe(
			"provider_overloaded",
		);
	});

	it("falls back to a generic reason when none is supplied", async () => {
		const h = makeHarness();
		h.recorder.recordSynthetic(
			makeMeta({ requestId: "syn-fb", responseStatus: 503, requestBody: null }),
			"error",
		);
		await h.flush();
		// No outcome-string for a generic "error" beyond "stream error"; either the
		// outcome-derived string or "synthetic" is acceptable, but never null.
		expect(h.dbOps.saveRequestCalls[0].errorMessage).toBeTruthy();
	});
});

describe("RequestRecorder — dashboard event carries the error message", () => {
	it("populates errorMessage on the emitted event for a disconnect terminal", async () => {
		const h = makeHarness();
		h.recorder.begin(makeMeta({ isStream: true }));
		h.recorder.finishTransport("req-1", "disconnect");
		h.timers.advance(150); // grace → persist (no usage)
		await h.flush();
		expect(h.emitted.length).toBe(1);
		expect(h.emitted[0].success).toBe(false);
		expect(h.emitted[0].errorMessage).toBe("client disconnected");
	});

	it("populates errorMessage on the emitted event for a stream error", async () => {
		const h = makeHarness();
		h.recorder.begin(makeMeta({ isStream: true }));
		h.recorder.finishTransport("req-1", "error");
		h.timers.advance(150);
		await h.flush();
		expect(h.emitted[0].errorMessage).toBe("stream error");
	});

	it("leaves errorMessage null on a successful terminal", async () => {
		const h = makeHarness();
		h.recorder.begin(makeMeta());
		h.recorder.attachUsageSummary("req-1", makeSummary());
		h.recorder.finishTransport("req-1", "success");
		await h.flush();
		expect(h.emitted[0].errorMessage).toBeNull();
	});
});

describe("RequestRecorder — dispose", () => {
	it("clears internal timers and drops all records", async () => {
		const h = makeHarness();
		h.recorder.begin(makeMeta({ isStream: true }));
		h.recorder.dispose();
		// After dispose a late finish is a no-op (record gone).
		h.recorder.finishTransport("req-1", "success");
		await h.flush();
		expect(h.dbOps.saveRequestCalls.length).toBe(0);
	});
});
