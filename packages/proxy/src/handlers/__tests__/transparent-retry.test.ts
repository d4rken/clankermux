import { describe, expect, it } from "bun:test";
import type { Account } from "@clankermux/types";
import {
	type Burst429Classification,
	classify429Transient,
} from "../transparent-retry";

// Minimal Account fixture. Defaults to a healthy OAuth-Anthropic account
// (provider "anthropic" + non-empty refresh_token) so individual tests only
// override the field under test.
function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-oauth-anthropic",
		name: "oauth-test",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt-token",
		access_token: "at-token",
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		consecutive_rate_limits: 0,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	};
}

function makeResponse(headers: Record<string, string> = {}): Response {
	return new Response(null, { status: 429, headers });
}

// Plain-stub capacity lookups (no usageCache import).
const freshHeadroom =
	(minHeadroom: number) =>
	(_id: string): { minHeadroom: number } | null => ({ minHeadroom });
const noCapacity = (_id: string): { minHeadroom: number } | null => null;

const NOW = 1_700_000_000_000;

function classify(args: {
	response?: Response;
	account?: Account;
	getCapacity?: (id: string) => { minHeadroom: number } | null;
}): Burst429Classification {
	return classify429Transient({
		response: args.response ?? makeResponse(),
		account: args.account ?? makeAccount(),
		now: NOW,
		getCapacity: args.getCapacity ?? noCapacity,
	});
}

describe("classify429Transient", () => {
	it("OAuth-Anthropic + fresh headroom > 0 ⇒ fresh_headroom", () => {
		const result = classify({ getCapacity: freshHeadroom(40) });
		expect(result).toEqual({ retryable: true, confidence: "fresh_headroom" });
	});

	it("OAuth-Anthropic + stale/absent capacity + x-should-retry:true ⇒ stale_should_retry", () => {
		const result = classify({
			response: makeResponse({ "x-should-retry": "true" }),
			getCapacity: noCapacity,
		});
		expect(result).toEqual({
			retryable: true,
			confidence: "stale_should_retry",
		});
	});

	it("stale/absent + x-should-retry:false ⇒ not retryable", () => {
		const result = classify({
			response: makeResponse({ "x-should-retry": "false" }),
			getCapacity: noCapacity,
		});
		expect(result).toEqual({
			retryable: false,
			reason: "no_headroom_no_retry_hint",
		});
	});

	it("stale/absent + x-should-retry header absent ⇒ not retryable", () => {
		const result = classify({
			response: makeResponse(),
			getCapacity: noCapacity,
		});
		expect(result).toEqual({
			retryable: false,
			reason: "no_headroom_no_retry_hint",
		});
	});

	it("hard-limit unified-status (even WITH x-should-retry:true) ⇒ not retryable", () => {
		const result = classify({
			response: makeResponse({
				"anthropic-ratelimit-unified-status": "rate_limited",
				"x-should-retry": "true",
			}),
			// fresh headroom present too — hard status still wins
			getCapacity: freshHeadroom(50),
		});
		expect(result).toEqual({ retryable: false, reason: "hard_limit_status" });
	});

	it("headroom === 0 ⇒ not retryable when no retry hint (strict > 0)", () => {
		const result = classify({
			response: makeResponse(),
			getCapacity: freshHeadroom(0),
		});
		expect(result).toEqual({
			retryable: false,
			reason: "no_headroom_no_retry_hint",
		});
	});

	it("headroom === 0 + x-should-retry:true ⇒ stale_should_retry (single probe)", () => {
		const result = classify({
			response: makeResponse({ "x-should-retry": "true" }),
			getCapacity: freshHeadroom(0),
		});
		expect(result).toEqual({
			retryable: true,
			confidence: "stale_should_retry",
		});
	});

	it("non-OAuth Anthropic (console/API-key, no refresh token) ⇒ not retryable", () => {
		const result = classify({
			account: makeAccount({
				provider: "claude-console-api",
				api_key: "sk-ant-...",
				refresh_token: "",
				access_token: null,
			}),
			getCapacity: freshHeadroom(80),
		});
		expect(result).toEqual({ retryable: false, reason: "not_oauth_anthropic" });
	});

	it("anthropic provider but empty refresh token ⇒ not retryable", () => {
		const result = classify({
			account: makeAccount({ refresh_token: "" }),
			getCapacity: freshHeadroom(80),
		});
		expect(result).toEqual({ retryable: false, reason: "not_oauth_anthropic" });
	});

	it("non-Anthropic provider (codex) ⇒ not retryable", () => {
		const result = classify({
			account: makeAccount({ provider: "codex", refresh_token: "rt" }),
			response: makeResponse({ "x-should-retry": "true" }),
			getCapacity: freshHeadroom(80),
		});
		expect(result).toEqual({ retryable: false, reason: "not_oauth_anthropic" });
	});
});
