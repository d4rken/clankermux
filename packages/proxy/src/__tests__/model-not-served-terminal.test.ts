/**
 * The "model not served" terminal — the give-up path taken when every account
 * that was actually attempted rejected the request because it could not serve
 * the requested MODEL, rather than because it was out of quota.
 *
 * Why it exists: `gpt-5.2-codex` was requested 306 times over six weeks in
 * production and succeeded zero times. Every one of those was answered with a
 * 503 labelled `all_accounts_failed` — the label that means "the pool ran dry"
 * — while the Codex account behind them sat at 11% of its weekly limit and 0%
 * of its 5-hour window. The pool had plenty. The model was the problem, and the
 * only surface that recorded the event said the opposite.
 *
 * The distinction is not cosmetic: `all_accounts_failed` is the input to every
 * "did I run out of quota" question asked of Request History, so a
 * model-entitlement failure filed under it permanently inflates the answer.
 *
 * These tests pin the BOUNDARY rather than the happy path, because the boundary
 * is where the label can lie, and it can lie in both directions. The terminal
 * fires only when every upstream attempt was a plan-entitlement rejection
 * specifically, no admission gate dropped a candidate, and at least one attempt
 * was actually made. A rate-limited account in the mix, or a model-fallback list
 * that merely ended on a 404, means the pool had a capacity problem too — and
 * relabelling that as a configuration problem would be this terminal's own
 * failure mode pointed the other way.
 */

import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { usageCache } from "@clankermux/providers";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import {
	resetOverloadHoldSlots,
	setOverloadHoldBudgetOverrideForTests,
} from "../overload-hold";
import { clearProviderOverloadCooldown } from "../provider-overload-cooldown";
import {
	callHandleProxy,
	makeAccount,
	makeContext,
	syntheticCall,
	upstreamOnlyFetch,
} from "./fixtures/proxy-terminal-harness";

const MODEL = "claude-haiku-4-5";

function makeRequest(model = MODEL): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

/**
 * The upstream body that drives `isCodexEntitlementModelError`: a top-level
 * `detail` string naming the model, "not supported", and ChatGPT. This is the
 * real shape the production 400s carried — the detector requires all three, so
 * a paraphrase here would test nothing.
 */
function entitlementRejection(model = MODEL): Response {
	return new Response(
		JSON.stringify({
			detail: `The '${model}' model is not supported when using Codex with a ChatGPT account.`,
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
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

describe("model-not-served terminal", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeAll(async () => {
		await import("../proxy");
	});

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
		resetOverloadHoldSlots();
		resetRateLimitProbeGatesForTests();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearProviderOverloadCooldown();
		resetOverloadHoldSlots();
		resetRateLimitProbeGatesForTests();
		setOverloadHoldBudgetOverrideForTests(null);
	});

	it("names the model when every attempted account rejected it", async () => {
		globalThis.fetch = upstreamOnlyFetch(async () => entitlementRejection());
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
		).rejects.toThrow(/rejected model .* as outside its plan entitlement/);

		const { meta, label } = syntheticCall(ctx.recorder);
		expect(label).toBe("model_not_served");
		// 400, not 503: this is a fact about the request, and a client that
		// retries 503s would otherwise retry forever. Production sent 306 of
		// these and every retry was waste.
		expect(meta.responseStatus).toBe(400);
		expect(meta.failoverAttempts).toBe(2);
	});

	it("states the model name in the message, not just the count", async () => {
		// The whole point of the terminal is that the operator can read WHICH
		// model is unserveable straight off the row. A count-only message would
		// leave them where `all_accounts_failed` left them.
		globalThis.fetch = upstreamOnlyFetch(async () =>
			entitlementRejection(MODEL),
		);
		const account = makeAccount();
		usageCache.delete(account.id);
		const ctx = makeContext([account]);

		const error = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		).catch((e: unknown) => e as Error);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(MODEL);
	});

	it("keeps the broad label when a model-fallback list ended on a model error", async () => {
		// The defect a review caught before this shipped. After cycling an
		// account's model-fallback list, proxy-operations classifies the whole
		// attempt from the LAST response's status alone — so a primary that 429s
		// followed by a fallback that 404s emits `model_not_found`. Counting that
		// as model evidence would relabel a real capacity failure as a
		// configuration problem, which is this terminal's own failure mode in
		// reverse. Only the narrow `model_not_entitled` outcome counts, so this
		// request must still land on the broad label.
		let call = 0;
		globalThis.fetch = upstreamOnlyFetch(async () => {
			call++;
			// Primary: rate-limited. Fallback: model not found.
			return call === 1
				? new Response(
						JSON.stringify({
							type: "error",
							error: { type: "rate_limit_error", message: "slow down" },
						}),
						{ status: 429, headers: { "content-type": "application/json" } },
					)
				: new Response(
						JSON.stringify({
							error: { code: "model_not_found", message: "no such model" },
						}),
						{ status: 404, headers: { "content-type": "application/json" } },
					);
		});
		const account = makeAccount({
			name: "WithFallbacks",
			model_mappings: JSON.stringify({
				haiku: [MODEL, "claude-haiku-fallback"],
			}),
		});
		usageCache.delete(account.id);
		const ctx = makeContext([account]);

		await expect(
			callHandleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			),
		).rejects.toThrow(/All accounts failed/);

		const { label } = syntheticCall(ctx.recorder);
		expect(label).toBe("all_accounts_failed");
	});

	it("keeps the broad label when only SOME attempts were model rejections", async () => {
		// The guard that keeps the new label honest. A pool where one account
		// rejected the model and another failed for an unrelated reason did have
		// a real availability problem, so the diagnosis is still the broad one.
		// Getting this backwards would move genuine outages out of the quota
		// history instead of moving non-outages out of it.
		let call = 0;
		globalThis.fetch = upstreamOnlyFetch(async () => {
			call++;
			return call === 1 ? entitlementRejection() : unauthorized();
		});
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

	it("keeps the broad label when nothing was attempted upstream", async () => {
		// No upstream attempt means no evidence about the model at all. The
		// terminal must not infer a model verdict from an empty sample — the
		// pool simply had nothing that could serve the path.
		globalThis.fetch = upstreamOnlyFetch(async () => entitlementRejection());
		const codex = makeAccount({
			name: "Codex",
			provider: "codex",
			api_key: null,
			access_token: "at",
			refresh_token: "rt",
			expires_at: Date.now() + 3_600_000,
		});
		usageCache.delete(codex.id);
		const ctx = makeContext([codex]);

		await expect(
			callHandleProxy(
				new Request("https://proxy.local/v1/chat/completions", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						model: MODEL,
						messages: [{ role: "user", content: "hello" }],
						max_tokens: 16,
					}),
				}),
				new URL("https://proxy.local/v1/chat/completions"),
				ctx,
			),
		).rejects.toThrow(/All accounts failed/);

		const { label } = syntheticCall(ctx.recorder);
		expect(label).toBe("all_accounts_failed");
	});

	it("writes NOTHING when a live record already exists for the request id", async () => {
		// Same collision guard the other terminals honour: `recordSynthetic`
		// bypasses the live-record map, so writing here would overwrite a real
		// completion or emit a second summary.
		globalThis.fetch = upstreamOnlyFetch(async () => entitlementRejection());
		const account = makeAccount();
		usageCache.delete(account.id);
		const ctx = makeContext([account], { hasRecord: () => true });

		await expect(
			callHandleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			),
		).rejects.toThrow(/rejected model .* as outside its plan entitlement/);

		expect(ctx.recorder.recordSynthetic).not.toHaveBeenCalled();
	});
});
