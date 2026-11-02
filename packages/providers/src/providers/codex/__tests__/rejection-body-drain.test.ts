import { afterEach, describe, expect, it } from "bun:test";
import { mockFetch } from "@clankermux/test-support";
import { pollCodexForToken } from "../device-oauth";
import { fetchCodexModelCatalog } from "../models-catalog";
import {
	codexRateLimitResetCreditsCache,
	consumeCodexRateLimitResetCredit,
	fetchCodexRateLimitResetCredits,
} from "../rate-limit-reset-credits";
import { fetchCodexSubscription } from "../subscription";
import { fetchCodexUsageStatus } from "../usage-status";

// Every rejection exit must hand its unread body to discardUpstreamBody.
// `body.locked` is the observable handoff: the drain takes a reader before its
// first await and never releases it. This proves the handoff, not that the
// drain reached EOF; response-body-disposal.test.ts covers that.

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	codexRateLimitResetCreditsCache.clear();
});

function rejection(status: number): Response {
	return new Response('{"detail":"nope"}', {
		status,
		headers: { "content-type": "application/json" },
	});
}

const stubFetch = (response: Response): typeof fetch =>
	(async () => response) as unknown as typeof fetch;

describe("Codex side fetches drain rejected bodies", () => {
	it("model catalogue on a non-200", async () => {
		const response = rejection(500);
		const result = await fetchCodexModelCatalog({
			accessToken: "token",
			chatgptAccountId: null,
			fetchImpl: stubFetch(response),
		});
		expect(result.ok).toBe(false);
		expect(response.body?.locked).toBe(true);
	});

	it("usage status on a non-200", async () => {
		const response = rejection(503);
		const result = await fetchCodexUsageStatus({
			accessToken: "token",
			chatgptAccountId: null,
			fetchImpl: stubFetch(response),
		});
		expect(result.ok).toBe(false);
		expect(response.body?.locked).toBe(true);
	});

	for (const status of [404, 500]) {
		it(`subscription on a ${status}`, async () => {
			const response = rejection(status);
			const result = await fetchCodexSubscription({
				accessToken: "token",
				chatgptAccountId: "acct-1",
				fetchImpl: stubFetch(response),
			});
			expect(result.ok).toBe(false);
			expect(response.body?.locked).toBe(true);
		});

		it(`reset-credit list on a ${status}`, async () => {
			const response = rejection(status);
			globalThis.fetch = mockFetch(async () => response);
			const result = await fetchCodexRateLimitResetCredits("token");
			expect(result.summary).toBeNull();
			expect(response.body?.locked).toBe(true);
		});
	}

	it("device-login poll on each pending 403/404, through timeout", async () => {
		const responses = [rejection(403), rejection(404)];
		let call = 0;
		globalThis.fetch = mockFetch(async () => responses[call++] as Response);
		await expect(pollCodexForToken("dev-1", "ABCD", 0, 2)).rejects.toThrow(
			"Timed out",
		);
		expect(responses.map((r) => r.body?.locked)).toEqual([true, true]);
	});

	it("reset-credit consume on a non-200 still throws", async () => {
		const response = rejection(409);
		globalThis.fetch = mockFetch(async () => response);
		await expect(
			consumeCodexRateLimitResetCredit("token", { idempotencyKey: "key-1" }),
		).rejects.toThrow("returned 409");
		expect(response.body?.locked).toBe(true);
	});
});
