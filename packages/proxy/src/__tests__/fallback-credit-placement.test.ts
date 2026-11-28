/**
 * A fallback-credit retry through handleProxy's main gate chain: the credit is
 * redeemable only on the account whose refusal issued it, so the retry has to
 * go there first even when the strategy ranks another account ahead of it.
 * The gate-level rules live in admission-gates.test.ts; this pins that the
 * main path applies them.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Account } from "@clankermux/types";
import { resetFamilyWeeklyMemoForTests } from "../family-weekly-memo";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { clearProviderOverloadCooldown } from "../provider-overload-cooldown";
import {
	hashCreditToken,
	refusalFallbackRegistry,
} from "../refusal-fallback-registry";
import {
	callHandleProxy,
	makeAccount,
	makeContext,
} from "./fixtures/proxy-terminal-harness";

const CREDIT_TOKEN = "fbc_main_path_credit";
const URL_MESSAGES = new URL("https://proxy.local/v1/messages");

function ok200(model: string) {
	return new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			model,
			stop_reason: "end_turn",
			usage: { input_tokens: 10, output_tokens: 5 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function request(creditToken?: string): Request {
	return new Request(URL_MESSAGES, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "same conversation" }],
			max_tokens: 16,
			...(creditToken ? { fallback_credit_token: creditToken } : {}),
		}),
	});
}

describe("fallback-credit retry on the main path", () => {
	let originalFetch: typeof globalThis.fetch;
	/** Which account each upstream call was authenticated as. */
	let hits: string[];

	const reset = () => {
		clearProviderOverloadCooldown();
		resetRateLimitProbeGatesForTests();
		resetFamilyWeeklyMemoForTests();
		refusalFallbackRegistry.reset();
	};

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		hits = [];
		reset();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		reset();
	});

	/** Upstream that answers 200 as whichever account's key it was called with. */
	function installUpstream(accounts: Account[]) {
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const asRequest = input instanceof Request ? input : null;
			const url = asRequest ? asRequest.url : String(input);
			const headers = asRequest
				? asRequest.headers
				: new Headers(init?.headers as HeadersInit);
			if (!url.includes("/v1/messages")) {
				return new Response("{}", { status: 200 });
			}
			const key =
				headers.get("x-api-key") ??
				headers.get("authorization")?.replace(/^Bearer /, "") ??
				"";
			const account = accounts.find((a) => a.api_key === key);
			hits.push(account?.id ?? `unknown:${key}`);
			const rawBody = asRequest
				? await asRequest.clone().text()
				: String(init?.body ?? "{}");
			const body = JSON.parse(rawBody || "{}") as { model?: string };
			return ok200(body.model ?? "claude-sonnet-4-5");
		}) as typeof globalThis.fetch;
	}

	it("sends the retry to the issuing account ahead of the strategy's pick", async () => {
		const accounts = [
			makeAccount({
				id: "acc-first",
				name: "first",
				api_key: "key-first",
				priority: 0,
			}),
			makeAccount({
				id: "acc-issuer",
				name: "issuer",
				api_key: "key-issuer",
				priority: 1,
				identity_external_id: "org-issuer",
			}),
		];
		installUpstream(accounts);
		const ctx = makeContext(accounts);

		// Without a credit the strategy's order holds.
		const plain = await callHandleProxy(request(), URL_MESSAGES, ctx);
		expect(plain.status).toBe(200);
		expect(hits).toEqual(["acc-first"]);

		hits = [];
		refusalFallbackRegistry.noteRefusal(hashCreditToken(CREDIT_TOKEN), {
			model: "claude-fable-5-1",
			category: "cyber",
			at: Date.now(),
			accountId: "acc-issuer",
			identityExternalId: "org-issuer",
		});
		const retry = await callHandleProxy(
			request(CREDIT_TOKEN),
			URL_MESSAGES,
			ctx,
		);
		expect(retry.status).toBe(200);
		expect(hits).toEqual(["acc-issuer"]);
	});
});
