import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
	fetchOpenRouterMetadata,
	OPENROUTER_KEY_ENDPOINT,
	parseOpenRouterMetadata,
} from "./metadata";

let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => fetchSpy?.mockRestore());

describe("OpenRouter key metadata", () => {
	it("preserves zero budgets and omits unavailable identity instead of inventing an email", () => {
		expect(
			parseOpenRouterMetadata(
				{
					data: {
						label: "sk-or-v1-abc...xyz",
						creator_user_id: "user_123",
						is_free_tier: false,
						limit: 0,
						limit_remaining: 0,
						usage: 0,
					},
				},
				123,
			),
		).toMatchObject({
			label: "sk-or-v1-abc...xyz",
			creatorUserId: "user_123",
			isFreeTier: false,
			limitUsd: 0,
			limitRemainingUsd: 0,
			usageUsd: 0,
			fetchedAt: 123,
		});
	});
	it("keeps absent values unknown and rejects malformed payloads", () => {
		for (const body of [
			null,
			[],
			{ data: [] },
			{ data: {} },
			{ error: "bad key" },
		])
			expect(parseOpenRouterMetadata(body)).toBeNull();
		expect(
			parseOpenRouterMetadata({
				data: {
					label: {},
					limit: "100",
					usage: -1,
					is_free_tier: "false",
					expires_at: "invalid",
				},
			}),
		).toMatchObject({
			label: null,
			limitUsd: null,
			usageUsd: null,
			isFreeTier: null,
			expiresAt: null,
		});
	});
	it("uses the free current-key endpoint with a timeout and does not expose an echoed secret", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				data: { label: "secret-key", creator_user_id: "user_123", usage: 2 },
			}),
		);
		expect((await fetchOpenRouterMetadata("secret-key"))?.label).toBeNull();
		expect(fetchSpy).toHaveBeenCalledWith(
			OPENROUTER_KEY_ENDPOINT,
			expect.objectContaining({
				headers: {
					Authorization: "Bearer secret-key",
					Accept: "application/json",
				},
				signal: expect.any(AbortSignal),
				redirect: "error",
			}),
		);
	});
	it("fails open on HTTP, network, and JSON failures", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("denied", { status: 401 }),
		);
		expect(await fetchOpenRouterMetadata("secret-key")).toBeNull();
		fetchSpy.mockResolvedValue(new Response("not json"));
		expect(await fetchOpenRouterMetadata("secret-key")).toBeNull();
		fetchSpy.mockRejectedValue(new Error("network"));
		expect(await fetchOpenRouterMetadata("secret-key")).toBeNull();
	});
});
