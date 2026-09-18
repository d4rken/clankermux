import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { ANTHROPIC_PROFILE_ENDPOINT, fetchAnthropicProfile } from "./profile";

afterEach(() => {
	spyOn(globalThis, "fetch").mockRestore();
});

describe("fetchAnthropicProfile", () => {
	it("returns the extracted identity on a 200 with a valid body", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					account: { uuid: "acct-1", email_address: "User@Example.com" },
					organization: {
						name: "Acme",
						organization_type: "claude_pro",
						rate_limit_tier: "default_claude_max_5x",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		await expect(fetchAnthropicProfile("tok")).resolves.toEqual({
			externalAccountId: "acct-1",
			email: "user@example.com",
			organizationName: "Acme",
			planTier: "pro",
			rateLimitTier: "5x",
			subscriptionStatus: null,
			subscriptionStartedAt: null,
		});
	});

	it("sends the anthropic-beta and claude-code user-agent headers", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ account: { uuid: "x" } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await fetchAnthropicProfile("secret-token");

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(ANTHROPIC_PROFILE_ENDPOINT);
		const headers = new Headers(init.headers);
		expect(headers.get("Authorization")).toBe("Bearer secret-token");
		expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
		expect(headers.get("User-Agent")).toMatch(/^claude-code\//);
	});

	it("returns null on a non-2xx status without throwing", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("nope", { status: 401 }),
		);
		await expect(fetchAnthropicProfile("tok")).resolves.toBeNull();
	});

	it("returns null when fetch throws (network error)", async () => {
		spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
		await expect(fetchAnthropicProfile("tok")).resolves.toBeNull();
	});

	it("returns null on a non-JSON body", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("<html>not json</html>", {
				status: 200,
				headers: { "Content-Type": "text/html" },
			}),
		);
		await expect(fetchAnthropicProfile("tok")).resolves.toBeNull();
	});
});

describe("Anthropic profile Retry-After", () => {
	it.each([
		["120", 120_000],
		[new Date(Date.UTC(2000, 0, 1) + 120_000).toUTCString(), 120_000],
		["invalid", 60_000],
	])("respects %s before another profile read", async (retryAfter, delayMs) => {
		let now = Date.UTC(2000, 0, 1);
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const fetchSpy = spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response("throttled", {
					status: 429,
					headers: { "retry-after": String(retryAfter) },
				}),
			)
			.mockResolvedValue(
				Response.json({ organization: { subscription_status: "active" } }),
			);
		try {
			expect(await fetchAnthropicProfile("first-token")).toBeNull();
			now += Number(delayMs) - 1;
			expect(await fetchAnthropicProfile("second-token")).toBeNull();
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			now += 1;
			expect(await fetchAnthropicProfile("second-token")).toMatchObject({
				subscriptionStatus: "active",
			});
			expect(fetchSpy).toHaveBeenCalledTimes(2);
		} finally {
			clock.mockRestore();
		}
	});
});
