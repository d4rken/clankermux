// Anthropic is the only provider that reports when the *refresh* token itself
// dies (`refresh_token_expires_in`, on both the code exchange and every
// refresh). Losing that value is what made an expiry invisible until the
// refresh failed and the account auto-paused mid-rotation, so these tests pin
// down two things: the value survives the parse into an absolute deadline, and
// a response without it yields null rather than a fabricated date.
import { afterEach, describe, expect, it } from "bun:test";
import type { Account } from "@clankermux/types";
import { AnthropicOAuthProvider } from "../oauth";
import { AnthropicProvider } from "../provider";
import { resolveRefreshTokenExpiresAt } from "../refresh-token-expiry";

const NOW = 1_760_000_000_000;
const NINETY_DAYS_SEC = 90 * 24 * 60 * 60;

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "test-id",
		name: "test-anthropic-account",
		provider: "claude-oauth",
		refresh_token: "sk-ant-ort01-EXISTING",
		access_token: "test-access-token",
		expires_at: null,
		api_key: null,
		custom_endpoint: null,
		rate_limited_until: null,
		rate_limit_status: null,
		rate_limit_reset: null,
		rate_limit_remaining: null,
		created_at: NOW,
		last_used: null,
		request_count: 0,
		total_requests: 0,
		session_start: null,
		session_request_count: 0,
		paused: false,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		...overrides,
	};
}

function jsonFetch(body: Record<string, unknown>): typeof fetch {
	return (async () =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		})) as unknown as typeof fetch;
}

describe("resolveRefreshTokenExpiresAt", () => {
	it("converts the reported seconds into an absolute deadline", () => {
		expect(
			resolveRefreshTokenExpiresAt(
				{ refresh_token_expires_in: NINETY_DAYS_SEC },
				NOW,
			),
		).toBe(NOW + NINETY_DAYS_SEC * 1000);
	});

	it("returns null when the provider reports no refresh-token lifetime", () => {
		// Codex's real token response shape: it rotates a refresh token but never
		// says when that token dies, so the deadline must stay unknown rather than
		// inheriting a neighbouring field such as expires_in.
		const codexResponse: Record<string, unknown> = {
			access_token: "a",
			expires_in: 864_000,
			refresh_token: "r",
			earliest_refresh_at: 1,
		};
		expect(resolveRefreshTokenExpiresAt(codexResponse, NOW)).toBeNull();
	});

	it("rejects a duration whose deadline falls outside the Date range", () => {
		// Finite input, unrepresentable result: `new Date(x).toISOString()` throws
		// a RangeError past ±8.64e15, and this value reaches the accounts API,
		// where one malformed token response would take out the whole list.
		expect(
			resolveRefreshTokenExpiresAt(
				{ refresh_token_expires_in: Number.MAX_VALUE },
				NOW,
			),
		).toBeNull();
		expect(
			resolveRefreshTokenExpiresAt({ refresh_token_expires_in: 1e13 }, NOW),
		).toBeNull();
		// The boundary itself stays usable.
		const justInside = Math.floor((8.64e15 - NOW) / 1000) - 1;
		const resolved = resolveRefreshTokenExpiresAt(
			{ refresh_token_expires_in: justInside },
			NOW,
		);
		expect(resolved).not.toBeNull();
		expect(() => new Date(resolved as number).toISOString()).not.toThrow();
	});

	it("rejects unusable durations instead of minting a past deadline", () => {
		// A past deadline would render as a permanent "re-auth overdue" warning on
		// an account that is working fine.
		for (const bad of [
			0,
			-1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			"90d",
			null,
		]) {
			expect(
				resolveRefreshTokenExpiresAt({ refresh_token_expires_in: bad }, NOW),
			).toBeNull();
		}
	});
});

describe("AnthropicProvider.refreshToken — refresh-token deadline", () => {
	const origFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = origFetch;
	});

	it("carries the refresh-token deadline out of a rotation", async () => {
		globalThis.fetch = jsonFetch({
			access_token: "new-access-token",
			expires_in: 28_800,
			refresh_token: "sk-ant-ort01-ROTATED",
			refresh_token_expires_in: NINETY_DAYS_SEC,
		});

		const before = Date.now();
		const result = await new AnthropicProvider().refreshToken(
			makeAccount(),
			"client-id",
		);
		const after = Date.now();

		expect(result.refreshToken).toBe("sk-ant-ort01-ROTATED");
		// The deadline is stamped from the wall clock at parse time, so pin it to
		// the interval the call actually spanned rather than an exact instant.
		expect(result.refreshTokenExpiresAt).toBeGreaterThanOrEqual(
			before + NINETY_DAYS_SEC * 1000,
		);
		expect(result.refreshTokenExpiresAt).toBeLessThanOrEqual(
			after + NINETY_DAYS_SEC * 1000,
		);
		// The access token's own expiry is a different, much shorter clock.
		expect(result.expiresAt).toBeLessThan(
			(result.refreshTokenExpiresAt as number) - 1000,
		);
	});

	it("reports a null deadline when the response omits the field", async () => {
		globalThis.fetch = jsonFetch({
			access_token: "new-access-token",
			expires_in: 28_800,
			refresh_token: "sk-ant-ort01-ROTATED",
		});

		const result = await new AnthropicProvider().refreshToken(
			makeAccount(),
			"client-id",
		);

		expect(result.refreshTokenExpiresAt).toBeNull();
	});

	it("reports a deadline for the existing token when the response rotates nothing", async () => {
		// No `refresh_token` in the response means the stored token is unchanged.
		// A deadline alongside it describes THAT token, and is the only report we
		// get for an account whose deadline is not yet recorded — so it must not
		// be gated on rotation.
		globalThis.fetch = jsonFetch({
			access_token: "new-access-token",
			expires_in: 28_800,
			refresh_token_expires_in: NINETY_DAYS_SEC,
		});

		const before = Date.now();
		const result = await new AnthropicProvider().refreshToken(
			makeAccount(),
			"client-id",
		);

		expect(result.refreshToken).toBe("sk-ant-ort01-EXISTING");
		expect(result.refreshTokenExpiresAt).toBeGreaterThanOrEqual(
			before + NINETY_DAYS_SEC * 1000,
		);
	});

	it("asserts no deadline when the response neither rotates nor reports one", async () => {
		globalThis.fetch = jsonFetch({
			access_token: "new-access-token",
			expires_in: 28_800,
		});

		const result = await new AnthropicProvider().refreshToken(
			makeAccount(),
			"client-id",
		);

		expect(result.refreshToken).toBe("sk-ant-ort01-EXISTING");
		expect(result.refreshTokenExpiresAt).toBeNull();
	});
});

describe("AnthropicOAuthProvider.exchangeCode — refresh-token deadline", () => {
	const origFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = origFetch;
	});

	it("stamps the deadline at re-auth so a fresh account starts with a known date", async () => {
		globalThis.fetch = jsonFetch({
			access_token: "exchanged-access-token",
			refresh_token: "sk-ant-ort01-FRESH",
			expires_in: 28_800,
			refresh_token_expires_in: NINETY_DAYS_SEC,
		});

		const before = Date.now();
		const result = await new AnthropicOAuthProvider().exchangeCode(
			"code#state",
			"verifier",
			new AnthropicOAuthProvider().getOAuthConfig("claude-oauth"),
		);

		expect(result.refreshTokenExpiresAt).toBeGreaterThanOrEqual(
			before + NINETY_DAYS_SEC * 1000,
		);
	});
});
