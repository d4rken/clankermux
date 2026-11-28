/**
 * End-to-end seam between the two halves of the fallback-credit correlation:
 * the refusal is observed on the RESPONSE of one request, and the credit is
 * redeemed on the BODY of the next one. Nothing links them but the registry, so
 * the two modules are exercised together here rather than only in isolation.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { makeAccount } from "@clankermux/test-support";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../handlers";
import { refusalFallbackRegistry } from "../refusal-fallback-registry";
import { ingestProxyRequest } from "../request-ingress";
import type { SlimUsageSummary } from "../request-recorder";
import { forwardToClient } from "../response-handler";
import { sessionProjectCache } from "../session-project-cache";
import { sessionPromotionTracker } from "../session-promotion";

const REFUSED_MODEL = "claude-fable-5-1";
const CREDIT_TOKEN = "fbc_opaque_credit_token";

function toArrayBuffer(text: string): ArrayBuffer {
	const bytes = new TextEncoder().encode(text);
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

function sse(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The wire shape of a refusal that issues a fallback credit. */
function refusalStream(): string {
	return [
		sse("message_start", {
			type: "message_start",
			message: {
				model: REFUSED_MODEL,
				usage: { input_tokens: 42, output_tokens: 1 },
			},
		}),
		sse("message_delta", {
			type: "message_delta",
			delta: {
				stop_reason: "refusal",
				stop_details: {
					type: "refusal",
					category: "cyber",
					explanation: null,
					fallback_credit_token: CREDIT_TOKEN,
					fallback_has_prefill_claim: null,
					recommended_model: "claude-opus-4-8",
				},
			},
			usage: { output_tokens: 3 },
		}),
		sse("message_stop", { type: "message_stop" }),
	].join("");
}

function createStreamingCtx(summaries: SlimUsageSummary[]): ProxyContext {
	return {
		strategy: {},
		dbOps: {},
		runtime: { port: 8080, tlsEnabled: false },
		config: { getStorePayloads: () => false },
		provider: { name: "anthropic", isStreamingResponse: () => true },
		refreshInFlight: new Map<string, Promise<string>>(),
		asyncWriter: {},
		requestRecorder: {
			begin: mock(() => {}),
			captureResponseChunk: mock(() => {}),
			finishTransport: mock(() => {}),
			attachUsageSummary: mock((_id: string, summary: SlimUsageSummary) => {
				summaries.push(summary);
			}),
			markUsageUnavailable: mock(() => {}),
			recordSynthetic: mock(() => {}),
			sweep: mock(() => {}),
			dispose: mock(() => {}),
		},
	} as unknown as ProxyContext;
}

function ingressCtx(): ProxyContext {
	return {
		provider: { name: "anthropic", canHandle: () => true } as never,
		config: {
			getCacheWarmingEnabled: () => false,
			getCacheWarmingMinTokens: () => 100_000,
		} as never,
		server: { timeout: mock(() => {}) } as never,
		// Required by `ProxyContext`; the ingress path under test reads none of
		// them.
		strategy: {} as never,
		dbOps: {} as never,
		runtime: {} as never,
		refreshInFlight: new Map<string, Promise<string>>(),
		asyncWriter: {} as never,
		requestRecorder: {} as never,
	} as ProxyContext;
}

function resetSingletons(): void {
	refusalFallbackRegistry.reset();
	sessionPromotionTracker.setMode("off");
	sessionPromotionTracker.clear();
	sessionProjectCache.clear();
}

describe("refusal → fallback-credit retry", () => {
	beforeEach(resetSingletons);
	afterEach(() => {
		resetSingletons();
		mock.restore();
	});

	/** Serve the refusal on `account` and drain it the way the client would. */
	async function serveRefusal(
		account: Account | null,
		summaries: SlimUsageSummary[],
	): Promise<void> {
		const forwarded = await forwardToClient(
			{
				requestId: "req-refusal",
				method: "POST",
				path: "/v1/messages",
				account,
				requestHeaders: new Headers({ "content-type": "application/json" }),
				requestBody: toArrayBuffer("{}"),
				requestedModel: REFUSED_MODEL,
				response: new Response(refusalStream(), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			createStreamingCtx(summaries),
		);
		// Drain what the client would read, then let the finalize IIFE settle.
		await forwarded.text();
		for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 2));
	}

	/**
	 * Claude Code re-sends the conversation to the fallback model, carrying the
	 * credit token the refusal issued.
	 */
	async function ingestRetry() {
		const retry = await ingestProxyRequest(
			new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "claude-opus-4-8",
					messages: [{ role: "user", content: "same conversation" }],
					max_tokens: 64,
					fallback_credit_token: CREDIT_TOKEN,
				}),
			}),
			new URL("https://proxy.local/v1/messages"),
			ingressCtx(),
			null,
			false,
		);
		if (retry.kind !== "context") throw new Error("expected a context");
		return retry.context;
	}

	it("attributes the retry to the model that refused it", async () => {
		const summaries: SlimUsageSummary[] = [];
		await serveRefusal(null, summaries);

		// The refusal itself is recorded on the summary the recorder receives.
		const summary = summaries.at(-1);
		expect(summary?.stopReason).toBe("refusal");
		expect(summary?.refusalCategory).toBe("cyber");

		const retry = await ingestRetry();
		expect(retry.requestMeta.fallbackCreditClaimed).toBe(true);
		expect(retry.requestMeta.fallbackFromModel).toBe(REFUSED_MODEL);
		expect(retry.requestMeta.requestedModel).toBe("claude-opus-4-8");
		expect(retry.requestMeta.fallbackCreditIssuer).toEqual({
			accountId: null,
			identityExternalId: null,
		});
	});

	it("names the account that issued the credit, once", async () => {
		const issuer = makeAccount({
			id: "acc-issuer",
			name: "issuer",
			identity_external_id: "org-issuer",
		});
		await serveRefusal(issuer, []);

		const retry = await ingestRetry();
		expect(retry.requestMeta.fallbackCreditIssuer).toEqual({
			accountId: "acc-issuer",
			identityExternalId: "org-issuer",
		});

		// The credit is redeemed once: a replay resolves no issuer.
		const replay = await ingestRetry();
		expect(replay.requestMeta.fallbackCreditClaimed).toBe(true);
		expect(replay.requestMeta.fallbackCreditIssuer).toBeNull();
	});
});
