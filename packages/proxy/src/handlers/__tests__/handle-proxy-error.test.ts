import { describe, expect, it } from "bun:test";
import type { Logger } from "@clankermux/logger";
import type { Account } from "@clankermux/types";
import { handleProxyError } from "../response-processor";

/**
 * A minimal logger stub recording which level each message went to. handleProxyError
 * takes its logger by parameter (not a module singleton), so a plain object with the
 * relevant methods is enough to assert routing without a real Logger or spyOn.
 */
function makeLoggerSpy() {
	const errorCalls: string[] = [];
	const debugCalls: string[] = [];
	const logger = {
		error: (msg: string) => {
			errorCalls.push(msg);
		},
		debug: (msg: string) => {
			debugCalls.push(msg);
		},
		warn: () => {},
		info: () => {},
	} as unknown as Logger;
	return { logger, errorCalls, debugCalls };
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "TestAccount",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
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
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	} as Account;
}

describe("handleProxyError — intentional aborts logged at DEBUG, not ERROR", () => {
	it("an AbortError (Error) is logged at DEBUG and emits NO ERROR lines", () => {
		const { logger, errorCalls, debugCalls } = makeLoggerSpy();
		const err = new Error("The operation was aborted");
		err.name = "AbortError";

		handleProxyError(err, makeAccount({ name: "Acct" }), logger);

		expect(errorCalls).toHaveLength(0);
		expect(debugCalls).toHaveLength(1);
		expect(debugCalls[0]).toContain("aborted");
		expect(debugCalls[0]).toContain("Acct");
	});

	it("an AbortError DOMException is logged at DEBUG, not ERROR", () => {
		const { logger, errorCalls, debugCalls } = makeLoggerSpy();
		const err = new DOMException("Aborted", "AbortError");

		handleProxyError(err, makeAccount({ name: "Acct" }), logger);

		expect(errorCalls).toHaveLength(0);
		expect(debugCalls).toHaveLength(1);
		expect(debugCalls[0]).toContain("aborted");
	});

	it("an abort with a null account still logs DEBUG (account name (none))", () => {
		const { logger, errorCalls, debugCalls } = makeLoggerSpy();
		const err = new Error("aborted");
		err.name = "AbortError";

		handleProxyError(err, null, logger);

		expect(errorCalls).toHaveLength(0);
		expect(debugCalls).toHaveLength(1);
		expect(debugCalls[0]).toContain("(none)");
	});

	it("a normal Error is STILL logged at ERROR (unchanged), not DEBUG", () => {
		const { logger, errorCalls, debugCalls } = makeLoggerSpy();
		const err = new Error("connection reset");

		handleProxyError(err, makeAccount({ name: "Acct" }), logger);

		// logError emits one ERROR line; the "Failed to proxy request with account"
		// line emits a second — two ERROR lines total, zero DEBUG.
		expect(debugCalls).toHaveLength(0);
		expect(errorCalls.length).toBeGreaterThanOrEqual(1);
		expect(
			errorCalls.some((m) =>
				m.includes("Failed to proxy request with account"),
			),
		).toBe(true);
	});

	it("a non-abort error with a null account still logs the generic ERROR line", () => {
		const { logger, errorCalls, debugCalls } = makeLoggerSpy();
		handleProxyError(new Error("boom"), null, logger);

		expect(debugCalls).toHaveLength(0);
		expect(errorCalls.some((m) => m === "Failed to proxy request")).toBe(true);
	});
});
