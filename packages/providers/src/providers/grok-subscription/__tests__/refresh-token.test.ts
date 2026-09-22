import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { OAuthRefreshTokenError } from "@clankermux/core";
import type { Account } from "@clankermux/types";
import { XAI_CLIENT_ID, XAI_TOKEN_ENDPOINT } from "../device-oauth";
import { GrokSubscriptionProvider } from "../provider";

const account = (overrides: Record<string, unknown> = {}) =>
	({
		id: "grok-sub-1",
		name: "supergrok",
		provider: "grok-subscription",
		refresh_token: "rt-old",
		...overrides,
	}) as unknown as Account;

function idToken(claims: Record<string, unknown>): string {
	const encode = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "ES256" })}.${encode(claims)}.signature`;
}

function mockToken(body: unknown, status: number) {
	return spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(typeof body === "string" ? body : JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		}),
	);
}

describe("GrokSubscriptionProvider.refreshToken", () => {
	afterEach(() => {
		spyOn(globalThis, "fetch").mockRestore();
	});

	it("exchanges the refresh token against the xAI token endpoint", async () => {
		const fetchMock = mockToken(
			{ access_token: "at-new", refresh_token: "rt-new", expires_in: 21600 },
			200,
		);

		const before = Date.now();
		const result = await new GrokSubscriptionProvider().refreshToken(
			account(),
			"cid",
		);

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(XAI_TOKEN_ENDPOINT);
		const form = new URLSearchParams(String(init.body));
		expect(form.get("grant_type")).toBe("refresh_token");
		expect(form.get("client_id")).toBe(XAI_CLIENT_ID);
		expect(form.get("refresh_token")).toBe("rt-old");
		expect(result.accessToken).toBe("at-new");
		expect(result.expiresAt).toBeGreaterThanOrEqual(before + 21600 * 1000);
	});

	it("persists the rotated refresh token xAI returns", async () => {
		mockToken(
			{ access_token: "at-new", refresh_token: "rt-new", expires_in: 21600 },
			200,
		);
		const result = await new GrokSubscriptionProvider().refreshToken(
			account(),
			"cid",
		);
		expect(result.refreshToken).toBe("rt-new");
	});

	it("keeps the previous refresh token and claims when the response omits both", async () => {
		mockToken({ access_token: "at-new", expires_in: 21600 }, 200);

		const result = await new GrokSubscriptionProvider().refreshToken(
			account(),
			"cid",
		);

		expect(result.refreshToken).toBe("rt-old");
		// Null, not an empty identity: the token write COALESCE-merges, so null is
		// what preserves the previously captured claims.
		expect(result.identity ?? null).toBeNull();
	});

	it("captures identity from an id_token when the refresh carries one", async () => {
		mockToken(
			{
				access_token: "at-new",
				refresh_token: "rt-new",
				expires_in: 21600,
				id_token: idToken({ sub: "user-123", email: "person@example.test" }),
			},
			200,
		);

		const result = await new GrokSubscriptionProvider().refreshToken(
			account(),
			"cid",
		);

		expect(result.identity?.externalAccountId).toBe("user-123");
		expect(result.identity?.email).toBe("person@example.test");
	});

	it("throws OAuthRefreshTokenError on invalid_grant so the account is paused for reauth", async () => {
		mockToken(
			{ error: "invalid_grant", error_description: "refresh token revoked" },
			400,
		);
		await expect(
			new GrokSubscriptionProvider().refreshToken(account(), "cid"),
		).rejects.toBeInstanceOf(OAuthRefreshTokenError);
	});

	it("throws OAuthRefreshTokenError on a non-JSON body carrying invalid_grant", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("error: invalid_grant", { status: 400 }),
		);
		await expect(
			new GrokSubscriptionProvider().refreshToken(account(), "cid"),
		).rejects.toBeInstanceOf(OAuthRefreshTokenError);
	});

	for (const code of ["invalid_client", "unauthorized_client"]) {
		it(`treats ${code} as transient, because it describes the shared Grok CLI client`, async () => {
			// Every grok-subscription account authorizes through one client id, so a
			// terminal classification here would pause all of them behind a reauth
			// prompt that reauth cannot fix.
			mockToken({ error: code }, 400);
			const error = await new GrokSubscriptionProvider()
				.refreshToken(account(), "cid")
				.catch((e: unknown) => e);
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(OAuthRefreshTokenError);
		});
	}

	it("treats a 503 with no JSON body as transient", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("Service Unavailable", { status: 503 }),
		);
		const error = await new GrokSubscriptionProvider()
			.refreshToken(account(), "cid")
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(OAuthRefreshTokenError);
	});

	it("refuses to echo credentials for an account with no refresh token", async () => {
		const fetchMock = mockToken({}, 200);
		await expect(
			new GrokSubscriptionProvider().refreshToken(
				account({ refresh_token: null, api_key: "not-an-oauth-credential" }),
				"cid",
			),
		).rejects.toThrow(/no refresh token/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects a 200 that carries no access token", async () => {
		mockToken({ refresh_token: "rt-new", expires_in: 21600 }, 200);
		const error = await new GrokSubscriptionProvider()
			.refreshToken(account(), "cid")
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(OAuthRefreshTokenError);
	});
});
