// Guards against a credential leak: the OAuth token-refresh path must never
// pass the *full* plaintext refresh token to the logger. A truncated preview is
// fine for debugging, but the whole `sk-ant-ort01-…` value landing in journald
// (which is persistent and group-readable) is a live-credential leak. See
// packages/providers/src/providers/anthropic/provider.ts.
//
// We spy on the Logger methods directly and capture every argument they're
// called with — regardless of the configured log level or test ordering — so
// the guard holds even when the module-level logger was constructed at INFO by
// an earlier test file. (Asserting via `logBus` would be level-gated and go
// vacuously silent in that case.)
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Logger } from "@clankermux/logger";
import type { Account } from "@clankermux/types";
import { AnthropicProvider } from "../provider";

const SECRET =
	"sk-ant-ort01-THISISAVERYLONGSECRETREFRESHTOKENVALUE-0123456789abcdefABCDEF";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "test-id",
		name: "test-anthropic-account",
		provider: "claude-oauth",
		refresh_token: SECRET,
		access_token: "test-access-token",
		expires_at: null,
		api_key: null,
		custom_endpoint: null,
		rate_limited_until: null,
		rate_limit_status: null,
		rate_limit_reset: null,
		rate_limit_remaining: null,
		created_at: Date.now(),
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

describe("AnthropicProvider.refreshToken — refresh-token redaction", () => {
	const origFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = origFetch;
	});

	it("never passes the full plaintext refresh_token to the logger during a successful refresh", async () => {
		const logged: string[] = [];
		const levels = ["debug", "info", "warn", "error"] as const;
		const spies = levels.map((level) =>
			spyOn(Logger.prototype, level).mockImplementation(
				(message: string, data?: unknown) => {
					logged.push(
						`${message} ${data === undefined ? "" : JSON.stringify(data)}`,
					);
				},
			),
		);

		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					access_token: "new-access-token",
					expires_in: 3600,
					refresh_token: "sk-ant-ort01-NEWLY-ROTATED-REFRESH-TOKEN",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			)) as unknown as typeof fetch;

		try {
			await new AnthropicProvider().refreshToken(makeAccount(), "client-id");
		} finally {
			for (const spy of spies) spy.mockRestore();
		}

		const all = logged.join("\n");

		// Sanity: the refresh path did log (so the guard below isn't vacuous), and
		// the truncated preview is still emitted for debugging.
		expect(all).toContain("Token refresh attempt");
		expect(all).toContain(SECRET.substring(0, 30));

		// The actual guard: the FULL secret must never be handed to the logger.
		expect(all).not.toContain(SECRET);
	});
});
