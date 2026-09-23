/**
 * The exact headers each Anthropic request ClankerMux originates puts on the
 * wire, captured at the fetch boundary: lower-cased name and value, sorted.
 * A change here changes the identity Anthropic sees, so it must be deliberate.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { trackClientVersion } from "@clankermux/core";
import { makeAccount, mockFetch } from "@clankermux/test-support";
import {
	claimAnthropicBankedReset,
	fetchAnthropicBankedResetStatus,
} from "../providers/anthropic/banked-resets";
import { AnthropicOAuthProvider } from "../providers/anthropic/oauth";
import { fetchAnthropicProfile } from "../providers/anthropic/profile";
import { AnthropicProvider } from "../providers/anthropic/provider";
import { fetchUsageData } from "../usage-fetcher";

const ORG = "5d1c2a9e-3b7f-4c21-8e6a-0f4b9d7c2e18";

let calls: Array<[string, RequestInit | undefined]> = [];
let fetchSpy: ReturnType<typeof spyOn> | null = null;

function stubFetch(body: unknown): void {
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		mockFetch(async (input, init) => {
			calls.push([String(input), init]);
			return Response.json(body);
		}),
	);
}

function wireHeaders(index = 0): Array<[string, string]> {
	return Array.from(new Headers(calls[index]?.[1]?.headers).entries()).sort(
		([a], [b]) => a.localeCompare(b),
	);
}

beforeEach(() => {
	calls = [];
});

afterEach(() => {
	fetchSpy?.mockRestore();
	fetchSpy = null;
});

describe("Claude identity at the fetch boundary", () => {
	it("usage poll", async () => {
		stubFetch({});
		await fetchUsageData("tok");
		expect(calls[0]?.[0]).toBe("https://api.anthropic.com/api/oauth/usage");
		expect(wireHeaders()).toEqual([
			["accept", "application/json"],
			["anthropic-beta", "oauth-2025-04-20"],
			["authorization", "Bearer tok"],
			["content-type", "application/json"],
			["user-agent", "claude-code/2.1.280"],
		]);
	});

	it("profile read", async () => {
		stubFetch({});
		await fetchAnthropicProfile("tok");
		expect(calls[0]?.[0]).toBe("https://api.anthropic.com/api/oauth/profile");
		expect(wireHeaders()).toEqual([
			["anthropic-beta", "oauth-2025-04-20"],
			["authorization", "Bearer tok"],
			["content-type", "application/json"],
			["user-agent", "claude-code/2.1.280"],
		]);
	});

	describe("banked resets", () => {
		const olderClient: Array<[string, string]> = [
			["anthropic-beta", "oauth-2025-04-20"],
			["authorization", "Bearer tok"],
			["content-type", "application/json"],
			["user-agent", "claude-cli/2.1.280 (external, cli)"],
		];
		const newerClient: Array<[string, string]> = [
			["anthropic-beta", "oauth-2025-04-20"],
			["authorization", "Bearer tok"],
			["content-type", "application/json"],
			["user-agent", "claude-cli/2.1.999 (external, cli)"],
		];

		it("status read names the pinned version over an older client", async () => {
			trackClientVersion("claude-cli/2.1.63 (external, cli)");
			stubFetch({});
			await fetchAnthropicBankedResetStatus("tok");
			expect(wireHeaders()).toEqual(olderClient);
		});

		it("status read names a newer client over the pinned version", async () => {
			trackClientVersion("claude-cli/2.1.999 (external, cli)");
			stubFetch({});
			await fetchAnthropicBankedResetStatus("tok");
			expect(wireHeaders()).toEqual(newerClient);
		});

		it("claim names the pinned version over an older client", async () => {
			trackClientVersion("claude-cli/2.1.63 (external, cli)");
			stubFetch({ result: "reset" });
			await claimAnthropicBankedReset("tok", ORG, {
				grantId: "g_week_1",
				requestId: "req-1",
			});
			expect(wireHeaders()).toEqual(olderClient);
		});

		it("claim names a newer client over the pinned version", async () => {
			trackClientVersion("claude-cli/2.1.999 (external, cli)");
			stubFetch({ result: "reset" });
			await claimAnthropicBankedReset("tok", ORG, {
				grantId: "g_week_1",
				requestId: "req-1",
			});
			expect(wireHeaders()).toEqual(newerClient);
		});
	});

	it("token refresh", async () => {
		stubFetch({ access_token: "a", refresh_token: "r2", expires_in: 3600 });
		await new AnthropicProvider().refreshToken(
			makeAccount({ provider: "claude-oauth", refresh_token: "rt" }),
			"client-id",
		);
		expect(calls[0]?.[0]).toBe("https://platform.claude.com/v1/oauth/token");
		expect(wireHeaders()).toEqual([["content-type", "application/json"]]);
	});

	it("code exchange", async () => {
		stubFetch({ access_token: "a", refresh_token: "r", expires_in: 3600 });
		await new AnthropicOAuthProvider().exchangeCode("code#state", "verifier", {
			authorizeUrl: "https://platform.claude.com/oauth/authorize",
			scopes: ["user:inference"],
			clientId: "client-id",
			redirectUri: "https://platform.claude.com/oauth/code/callback",
			tokenUrl: "https://platform.claude.com/v1/oauth/token",
			mode: "claude-oauth",
		});
		expect(calls[0]?.[0]).toBe("https://platform.claude.com/v1/oauth/token");
		expect(wireHeaders()).toEqual([["content-type", "application/json"]]);
	});
});
