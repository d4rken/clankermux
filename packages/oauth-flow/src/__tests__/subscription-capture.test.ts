import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Config } from "@clankermux/config";
import { DatabaseFactory, type DatabaseOperations } from "@clankermux/database";
import type { OAuthProviderConfig } from "@clankermux/providers";
import { mockFetch, tempDbTracker } from "@clankermux/test-support";
import { OAuthFlow } from "../index";

const tmpDb = tempDbTracker("test-oauth-subscription-capture");

const TOKEN_URL = "https://example.test/oauth/token";
/** Path of `ANTHROPIC_PROFILE_ENDPOINT`, which the providers barrel does not re-export. */
const PROFILE_PATH = "/api/oauth/profile";

const testOauthConfig: OAuthProviderConfig = {
	clientId: "test-client-id",
	authorizeUrl: "https://example.test/oauth/authorize",
	tokenUrl: TOKEN_URL,
	redirectUri: "http://localhost/callback",
	scopes: ["openid"],
};

const testFlowData = {
	sessionId: "00000000-0000-0000-0000-0000000000d7",
	authUrl: "",
	pkce: { verifier: "test-verifier", challenge: "test-challenge" },
	oauthConfig: testOauthConfig,
	mode: "claude-oauth" as const,
};

/**
 * The profile body the Anthropic OAuth profile endpoint returns for a live
 * subscription. Both billing fields are present, so the real
 * `extractAnthropicIdentity` yields an `AccountIdentity` carrying
 * `subscriptionStatus: "active"` and a non-null `subscriptionStartedAt`.
 */
const PROFILE_BODY = {
	account: { uuid: "acct-d7", email_address: "d7@example.com" },
	organization: {
		name: "D7 Org",
		organization_type: "claude_max",
		rate_limit_tier: "default_claude_max_20x",
		subscription_status: "active",
		subscription_created_at: "2026-04-10T15:53:44.244879Z",
	},
};

const EXPECTED_SUBSCRIPTION_STARTED_AT = Date.parse(
	PROFILE_BODY.organization.subscription_created_at,
);

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

describe("D7: OAuth flow persists the captured Anthropic subscription", () => {
	let dbOps: DatabaseOperations;
	let fetchSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		// Mocked at the fetch layer rather than by stubbing `fetchAnthropicProfile`:
		// the real profile fetch and the real identity extractor then run, so the
		// identity under test is the one production builds. Nothing reaches the
		// network — an unrouted URL is a 500, never a passthrough.
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			mockFetch(async (input) => {
				const url = urlOf(input);
				if (url.includes(PROFILE_PATH)) {
					return new Response(JSON.stringify(PROFILE_BODY), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url === TOKEN_URL) {
					return new Response(
						JSON.stringify({
							refresh_token: "d7-refresh-token",
							access_token: "d7-access-token",
							expires_in: 3600,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("unexpected request", { status: 500 });
			}),
		);
		DatabaseFactory.initialize(tmpDb.next());
		dbOps = DatabaseFactory.getInstance();
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		try {
			DatabaseFactory.reset();
		} finally {
			tmpDb.cleanup();
		}
	});

	function subscriptionColumns(accountId: string) {
		return dbOps
			.getAdapter()
			.getSQLiteDb()
			.query<
				{
					identity_email: string | null;
					identity_subscription_status: string | null;
					identity_subscription_started_at: number | null;
				},
				[string]
			>(
				`SELECT identity_email,
				        identity_subscription_status,
				        identity_subscription_started_at
				 FROM accounts WHERE id = ?`,
			)
			.get(accountId);
	}

	it("D7: writes subscription status and start on account creation", async () => {
		const flow = new OAuthFlow(dbOps, makeConfig());

		const created = await flow.complete(
			{ sessionId: "d7-create", code: "auth-code", name: "d7-created" },
			testFlowData,
		);

		const row = subscriptionColumns(created.id);
		// Sanity: the profile fetch really did reach the identity write path.
		expect(row?.identity_email).toBe("d7@example.com");
		expect(row?.identity_subscription_status).toBe("active");
		expect(row?.identity_subscription_started_at).toBe(
			EXPECTED_SUBSCRIPTION_STARTED_AT,
		);
	});

	it("D7: writes subscription status and start on re-authentication", async () => {
		const accountId = "d7d7d7d7-0000-0000-0000-000000000001";
		await dbOps.getAdapter().run(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token,
				                       expires_at, created_at, request_count,
				                       total_requests, priority)
				 VALUES (?, ?, 'anthropic', 'old-refresh', 'old-access', ?, ?, 0, 0, 0)`,
			[accountId, "d7-reauth", Date.now() + 3_600_000, Date.now()],
		);

		const flow = new OAuthFlow(dbOps, makeConfig());
		await flow.completeReauth(
			{
				sessionId: "d7-reauth",
				code: "auth-code",
				name: "d7-reauth",
				id: accountId,
			},
			testFlowData,
		);

		const row = subscriptionColumns(accountId);
		// Sanity: the profile fetch really did reach the identity write path.
		expect(row?.identity_email).toBe("d7@example.com");
		expect(row?.identity_subscription_status).toBe("active");
		expect(row?.identity_subscription_started_at).toBe(
			EXPECTED_SUBSCRIPTION_STARTED_AT,
		);
	});
});
