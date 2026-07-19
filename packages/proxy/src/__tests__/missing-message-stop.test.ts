import { beforeEach, describe, expect, it } from "bun:test";
import { missingMessageStopStats } from "../missing-message-stop-stats";
import {
	createUsageState,
	detectMissingMessageStop,
	feedChunk,
	finalizeUsage,
} from "../usage-collector";

// A clean, terminated Anthropic streaming finalize context.
const ANTH_STREAM_CLEAN = {
	providerName: "anthropic",
	isStream: true,
	endedCleanly: true,
} as const;

describe("detectMissingMessageStop", () => {
	it("fires for an anthropic stream that reported output but saw no message_stop", () => {
		const state = createUsageState();
		state.providerReportedOutput = true;
		state.sawMessageStop = false;
		expect(detectMissingMessageStop(state, ANTH_STREAM_CLEAN)).toBe(true);
	});

	it("does not fire when message_stop was seen", () => {
		const state = createUsageState();
		state.providerReportedOutput = true;
		state.sawMessageStop = true;
		expect(detectMissingMessageStop(state, ANTH_STREAM_CLEAN)).toBe(false);
	});

	it("does not fire when the provider never reported an output count", () => {
		// A ping/keepalive stream (no message_delta) must never be flagged.
		const state = createUsageState();
		state.providerReportedOutput = false;
		state.sawMessageStop = false;
		expect(detectMissingMessageStop(state, ANTH_STREAM_CLEAN)).toBe(false);
	});

	it("does not fire for a non-streaming response", () => {
		const state = createUsageState();
		state.providerReportedOutput = true;
		state.sawMessageStop = false;
		expect(
			detectMissingMessageStop(state, {
				providerName: "anthropic",
				isStream: false,
				endedCleanly: true,
			}),
		).toBe(false);
	});

	it("does not fire when the stream did not end cleanly (disconnect/truncation)", () => {
		const state = createUsageState();
		state.providerReportedOutput = true;
		state.sawMessageStop = false;
		expect(
			detectMissingMessageStop(state, {
				providerName: "anthropic",
				isStream: true,
				endedCleanly: false,
			}),
		).toBe(false);
	});

	it("does not fire for non-anthropic providers (e.g. codex)", () => {
		// Codex's terminal response.completed sets providerReportedOutput AND
		// sawMessageStop together, so this state is unreachable on the Codex path;
		// the provider-name gate makes that guarantee explicit anyway.
		const state = createUsageState();
		state.providerReportedOutput = true;
		state.sawMessageStop = false;
		expect(
			detectMissingMessageStop(state, {
				providerName: "codex",
				isStream: true,
				endedCleanly: true,
			}),
		).toBe(false);
	});

	it("treats a missing endedCleanly flag as clean (back-compat default)", () => {
		const state = createUsageState();
		state.providerReportedOutput = true;
		state.sawMessageStop = false;
		expect(
			detectMissingMessageStop(state, {
				providerName: "anthropic",
				isStream: true,
			}),
		).toBe(true);
	});
});

describe("detectMissingMessageStop — end-to-end via SSE parsing", () => {
	const enc = new TextEncoder();
	const sse = (event: string, data: unknown): Uint8Array =>
		enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	// Deterministic, hermetic cost so finalize never touches the pricing catalogue.
	const deps = { estimateCostUSD: async () => 0 };

	it("fires when a real Anthropic stream omits the final message_stop", async () => {
		const state = createUsageState();
		feedChunk(
			state,
			sse("message_start", {
				type: "message_start",
				message: { model: "claude-opus-4-8", usage: { input_tokens: 10 } },
			}),
		);
		feedChunk(
			state,
			sse("message_delta", {
				type: "message_delta",
				usage: { output_tokens: 42 },
			}),
		);
		// NO message_stop — the anomaly under investigation.
		await finalizeUsage(
			state,
			{ ...ANTH_STREAM_CLEAN, responseTimeMs: 10 },
			deps,
		);
		expect(detectMissingMessageStop(state, ANTH_STREAM_CLEAN)).toBe(true);
	});

	it("does not fire when the stream includes message_stop", async () => {
		const state = createUsageState();
		feedChunk(
			state,
			sse("message_start", {
				type: "message_start",
				message: { model: "claude-opus-4-8", usage: { input_tokens: 10 } },
			}),
		);
		feedChunk(
			state,
			sse("message_delta", {
				type: "message_delta",
				usage: { output_tokens: 42 },
			}),
		);
		feedChunk(state, sse("message_stop", { type: "message_stop" }));
		await finalizeUsage(
			state,
			{ ...ANTH_STREAM_CLEAN, responseTimeMs: 10 },
			deps,
		);
		expect(detectMissingMessageStop(state, ANTH_STREAM_CLEAN)).toBe(false);
	});

	it("detects a message_stop delivered in an unterminated trailing line (post-flush)", async () => {
		// finalizeUsage flushes the trailing partial line; detection must run after
		// it so a message_stop with no closing newline is not a false positive.
		const state = createUsageState();
		feedChunk(
			state,
			sse("message_delta", {
				type: "message_delta",
				usage: { output_tokens: 7 },
			}),
		);
		// message_stop arrives WITHOUT a trailing "\n\n" (stream closed mid-line).
		feedChunk(
			state,
			enc.encode(`event: message_stop\ndata: {"type":"message_stop"}`),
		);
		await finalizeUsage(
			state,
			{ ...ANTH_STREAM_CLEAN, responseTimeMs: 10 },
			deps,
		);
		expect(detectMissingMessageStop(state, ANTH_STREAM_CLEAN)).toBe(false);
	});
});

describe("missingMessageStopStats", () => {
	beforeEach(() => missingMessageStopStats.reset());

	it("starts empty", () => {
		expect(missingMessageStopStats.snapshot()).toEqual({
			count: 0,
			lastModel: undefined,
			lastRequestId: undefined,
			lastAtMs: undefined,
		});
	});

	it("increments and records the latest occurrence, returning the running count", () => {
		expect(
			missingMessageStopStats.record("claude-opus-4-8", "req-1", 1000),
		).toBe(1);
		expect(
			missingMessageStopStats.record("claude-sonnet-5", "req-2", 2000),
		).toBe(2);
		expect(missingMessageStopStats.snapshot()).toEqual({
			count: 2,
			lastModel: "claude-sonnet-5",
			lastRequestId: "req-2",
			lastAtMs: 2000,
		});
	});

	it("reset zeroes all fields", () => {
		missingMessageStopStats.record("claude-opus-4-8", "req-1", 1000);
		missingMessageStopStats.reset();
		expect(missingMessageStopStats.snapshot().count).toBe(0);
	});
});
