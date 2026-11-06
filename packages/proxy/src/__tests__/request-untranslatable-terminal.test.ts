/**
 * The give-up path when every attempted account's provider refused to
 * translate the request body (a `ValidationError` from `transformRequestBody`,
 * e.g. an image with a `file:` url, or an image on an assistant turn).
 *
 * Nothing reached upstream, and retrying the same body cannot succeed, so the
 * client gets the translator's own 400 instead of a retryable 503
 * `all_accounts_failed`.
 */

import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	spyOn,
} from "bun:test";
import { ValidationError } from "@clankermux/core";
import { getProvider, usageCache } from "@clankermux/providers";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { resetOverloadHoldSlots } from "../overload-hold";
import { clearProviderOverloadCooldown } from "../provider-overload-cooldown";
import {
	callHandleProxy,
	makeAccount,
	makeContext,
	syntheticCall,
	upstreamOnlyFetch,
} from "./fixtures/proxy-terminal-harness";

const REFUSAL = "unsupported image source url scheme: file";

function makeRequest(): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "claude-haiku-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

function unauthorized(): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "authentication_error", message: "bad token" },
		}),
		{ status: 401, headers: { "content-type": "application/json" } },
	);
}

describe("request-untranslatable terminal", () => {
	let originalFetch: typeof globalThis.fetch;
	let restoreTransform: (() => void) | null = null;

	/** Make the anthropic provider's translator refuse its first `refusals` calls. */
	function refuseTranslation(refusals = Number.POSITIVE_INFINITY): void {
		const provider = getProvider("anthropic");
		if (!provider) throw new Error("anthropic provider not registered");
		const original = provider.transformRequestBody?.bind(provider);
		let calls = 0;
		const spy = spyOn(provider, "transformRequestBody").mockImplementation(
			async (request, account) => {
				calls++;
				if (calls <= refusals) throw new ValidationError(REFUSAL);
				return original ? original(request, account) : request;
			},
		);
		restoreTransform = () => spy.mockRestore();
	}

	beforeAll(async () => {
		await import("./fixtures/routing-harness");
	});

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
		resetOverloadHoldSlots();
		resetRateLimitProbeGatesForTests();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		restoreTransform?.();
		restoreTransform = null;
		clearProviderOverloadCooldown();
		resetOverloadHoldSlots();
		resetRateLimitProbeGatesForTests();
	});

	it("answers 400 with the translator's message when every attempt refused", async () => {
		refuseTranslation();
		const fetchMock = upstreamOnlyFetch(async () => unauthorized());
		globalThis.fetch = fetchMock;
		const first = makeAccount({ name: "First" });
		const second = makeAccount({ name: "Second" });
		for (const a of [first, second]) usageCache.delete(a.id);
		const ctx = makeContext([first, second]);

		const error = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		).then(
			() => {
				throw new Error("expected the request to be refused");
			},
			(e: unknown) => e as Error & { statusCode?: number },
		);

		expect(error).toBeInstanceOf(Error);
		expect(error.statusCode).toBe(400);
		expect(error.message).toContain(REFUSAL);
		const { meta, label } = syntheticCall(ctx.recorder);
		expect(label).toBe("request_untranslatable");
		expect(meta.responseStatus).toBe(400);
		expect(meta.failoverAttempts).toBe(2);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reaches the client as a 400 invalid_request_error carrying the reason", async () => {
		// Through the dispatcher: the terminal is thrown in handleProxy and only
		// becomes a status and a body there.
		refuseTranslation();
		globalThis.fetch = upstreamOnlyFetch(async () => unauthorized());
		const account = makeAccount();
		usageCache.delete(account.id);
		const ctx = makeContext([account]);
		const { asClaudeCodeClient, provisionRouting } = await import(
			"./fixtures/routing-harness"
		);
		const { dispatchProxyRequest } = await import("../dispatch");
		const req = makeRequest();
		await provisionRouting(ctx, "claude-haiku-4-5", [account]);

		const res = await dispatchProxyRequest(
			req,
			new URL(req.url),
			ctx,
			asClaudeCodeClient(ctx, req),
			null,
			false,
		);

		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { type: string; message: string };
		};
		expect(body.error.type).toBe("invalid_request_error");
		expect(body.error.message).toContain(REFUSAL);
	});

	it("keeps the broad 503 when a candidate was never attempted", async () => {
		// Probe-suppressed: another request holds this account's probe lease, so
		// the loop skips it without an attempt. It might have taken the body.
		refuseTranslation();
		globalThis.fetch = upstreamOnlyFetch(async () => unauthorized());
		const first = makeAccount({ name: "First" });
		const skipped = makeAccount({ name: "Skipped" });
		for (const a of [first, skipped]) usageCache.delete(a.id);
		const ctx = makeContext([first, skipped]);
		const gate = await import("../handlers/rate-limit-cooldown");
		const admit = spyOn(gate, "getRateLimitProbeAdmission").mockImplementation(
			(account) =>
				account.id === skipped.id
					? ({ decision: "suppressed" } as never)
					: { decision: "not_required" },
		);
		try {
			await expect(
				callHandleProxy(
					makeRequest(),
					new URL("https://proxy.local/v1/messages"),
					ctx,
				),
			).rejects.toThrow(/All accounts failed/);
		} finally {
			admit.mockRestore();
		}
		expect(syntheticCall(ctx.recorder).label).toBe("all_accounts_failed");
	});

	it("serves from a later candidate whose provider takes the body", async () => {
		refuseTranslation(1);
		globalThis.fetch = upstreamOnlyFetch(
			async () =>
				new Response(
					JSON.stringify({
						id: "msg_1",
						type: "message",
						role: "assistant",
						content: [{ type: "text", text: "hi" }],
						model: "claude-haiku-4-5",
						stop_reason: "end_turn",
						usage: { input_tokens: 1, output_tokens: 1 },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		const first = makeAccount({ name: "First" });
		const second = makeAccount({ name: "Second" });
		for (const a of [first, second]) usageCache.delete(a.id);
		const ctx = makeContext([first, second]);

		const res = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		expect(res.status).toBe(200);
	});

	it("keeps the broad 503 when another attempt failed for a different reason", async () => {
		refuseTranslation(1);
		globalThis.fetch = upstreamOnlyFetch(async () => unauthorized());
		const first = makeAccount({ name: "First" });
		const second = makeAccount({ name: "Second" });
		for (const a of [first, second]) usageCache.delete(a.id);
		const ctx = makeContext([first, second]);

		await expect(
			callHandleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			),
		).rejects.toThrow(/All accounts failed/);

		const { meta, label } = syntheticCall(ctx.recorder);
		expect(label).toBe("all_accounts_failed");
		expect(meta.responseStatus).toBe(503);
	});
});
