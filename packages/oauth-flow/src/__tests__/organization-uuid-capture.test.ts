import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Config } from "@clankermux/config";
import { DatabaseFactory, type DatabaseOperations } from "@clankermux/database";
import type { OAuthProviderConfig, OAuthTokens } from "@clankermux/providers";
import { mockFetch, tempDbTracker } from "@clankermux/test-support";
import type { AccountIdentity } from "@clankermux/types";
import { OAuthFlow } from "../index";

const tmpDb = tempDbTracker("test-oauth-organization-uuid");

const TOKEN_URL = "https://example.test/oauth/token";
const PROFILE_PATH = "/api/oauth/profile";

const testOauthConfig: OAuthProviderConfig = {
	clientId: "test-client-id",
	authorizeUrl: "https://example.test/oauth/authorize",
	tokenUrl: TOKEN_URL,
	redirectUri: "http://localhost/callback",
	scopes: ["openid"],
};

const testFlowData = {
	sessionId: "00000000-0000-0000-0000-0000000000e1",
	authUrl: "",
	pkce: { verifier: "test-verifier", challenge: "test-challenge" },
	oauthConfig: testOauthConfig,
	mode: "claude-oauth" as const,
};

function makeConfig(): Config {
	return {
		getRuntime: () => ({ clientId: "test-client-id" }),
	} as unknown as Config;
}

function urlOf(input: URL | RequestInfo): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

describe("OAuth flow persists the Anthropic organization uuid", () => {
	let dbOps: DatabaseOperations;
	let fetchSpy: ReturnType<typeof spyOn>;

	function install(
		profileOrganization: Record<string, unknown>,
		exchangeOrganization: Record<string, unknown> | undefined,
	): void {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			mockFetch(async (input) => {
				const url = urlOf(input);
				if (url.includes(PROFILE_PATH)) {
					return Response.json({
						account: { uuid: "acct-e1", email_address: "e1@example.com" },
						organization: profileOrganization,
					});
				}
				if (url === TOKEN_URL) {
					return Response.json({
						refresh_token: "e1-refresh-token",
						access_token: "e1-access-token",
						expires_in: 3600,
						...(exchangeOrganization
							? { organization: exchangeOrganization }
							: {}),
					});
				}
				return new Response("unexpected request", { status: 500 });
			}),
		);
	}

	beforeEach(() => {
		DatabaseFactory.initialize(tmpDb.next());
		dbOps = DatabaseFactory.getInstance();
	});

	afterEach(() => {
		fetchSpy?.mockRestore();
		try {
			DatabaseFactory.reset();
		} finally {
			tmpDb.cleanup();
		}
	});

	async function createdUuid(): Promise<string | null> {
		const created = await new OAuthFlow(dbOps, makeConfig()).complete(
			{ sessionId: "e1-create", code: "auth-code", name: "e1-created" },
			testFlowData,
		);
		return (
			(await dbOps.getAccount(created.id))?.identity_organization_uuid ?? null
		);
	}

	it("takes the profile's uuid when the profile reports one", async () => {
		install({ uuid: "org-from-profile" }, { uuid: "org-from-exchange" });
		expect(await createdUuid()).toBe("org-from-profile");
	});

	// Driven through the resolver rather than `complete()`: another suite's
	// process-wide mock of `getOAuthProvider` replaces the real code exchange,
	// so only the token envelope handed in here is under this test's control.
	it("falls back to the code exchange's uuid when the profile lacks it", async () => {
		install({ name: "Org" }, undefined);
		const flow = new OAuthFlow(dbOps, makeConfig()) as unknown as {
			resolveAnthropicIdentity(
				tokens: OAuthTokens,
			): Promise<{ identity: AccountIdentity }>;
		};
		const resolved = await flow.resolveAnthropicIdentity({
			accessToken: "e1-access-token",
			refreshToken: "e1-refresh-token",
			expiresAt: Date.now() + 3_600_000,
			identity: {
				externalAccountId: null,
				email: null,
				organizationName: null,
				organizationUuid: "org-from-exchange",
				planTier: null,
				rateLimitTier: null,
			},
		});
		expect(resolved.identity.organizationUuid).toBe("org-from-exchange");
	});
});
