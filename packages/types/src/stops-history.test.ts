/**
 * `classifyStopCause` turns `requests.error_message` — a mixed vocabulary of
 * proxy terminals, per-attempt rate-limit reasons and free-form upstream text —
 * into a closed set of causes.
 *
 * The tests below use the exact strings observed in a 45-day production sample,
 * because the whole risk of this function is that it looks correct against
 * invented inputs and silently mis-buckets the real ones.
 */

import { describe, expect, it } from "bun:test";
import {
	classifyStopCause,
	STOP_CAUSES,
	type StopCause,
} from "./stops-history";

describe("classifyStopCause", () => {
	it("maps the pool-exhaustion terminals", () => {
		expect(classifyStopCause("all_accounts_failed", 503)).toBe(
			"pool_quota_exhausted",
		);
		expect(classifyStopCause("pool_exhausted", 503)).toBe(
			"pool_quota_exhausted",
		);
		expect(classifyStopCause("weekly_exhausted_429", 429)).toBe(
			"pool_quota_exhausted",
		);
		expect(classifyStopCause("session_exhausted_429", 429)).toBe(
			"pool_quota_exhausted",
		);
	});

	it("separates family-weekly exhaustion from pool exhaustion", () => {
		// These are the 125 production blocks that were all one model family
		// while the accounts had account-wide headroom. Folding them into
		// pool exhaustion would make a per-family limit look like a dry pool.
		expect(classifyStopCause("family_weekly_exhausted", 503)).toBe(
			"family_weekly_exhausted",
		);
		expect(classifyStopCause("family_weekly_exhausted_429", 429)).toBe(
			"family_weekly_exhausted",
		);
	});

	it("maps the model-not-served terminal to its own cause", () => {
		expect(classifyStopCause("model_not_served", 400)).toBe("model_not_served");
	});

	it("classifies free-form upstream text by its leading status code", () => {
		// RequestRecorder builds these as "<status> <provider message>". The
		// message half is provider-authored and changes without notice, so the
		// rule matches the SHAPE, never the wording.
		expect(classifyStopCause("429 rate_limit_error: Rate limited", 429)).toBe(
			"upstream_error",
		);
		expect(classifyStopCause("500 api_error: Internal server error", 500)).toBe(
			"upstream_error",
		);
		expect(
			classifyStopCause(
				"400 invalid_request_error: prompt is too long: 1002161 tokens",
				400,
			),
		).toBe("upstream_error");
	});

	it("treats an unrecognised label on a failed status as an upstream failure", () => {
		expect(classifyStopCause("stream error", 502)).toBe("upstream_error");
	});

	it("falls back to `other` only when there is nothing to go on", () => {
		// The bucket has to exist and has to be reachable: a proxy that grows a
		// new terminal tomorrow must land here visibly rather than being absorbed
		// into a neighbouring cause by a loose prefix rule.
		expect(classifyStopCause("some_future_terminal", null)).toBe("other");
		expect(classifyStopCause("some_future_terminal", 200)).toBe("other");
		expect(classifyStopCause(null, 503)).toBe("other");
		expect(classifyStopCause("", 503)).toBe("other");
		expect(classifyStopCause("   ", 503)).toBe("other");
	});

	it("tolerates surrounding whitespace on a known label", () => {
		expect(classifyStopCause("  all_accounts_failed  ", 503)).toBe(
			"pool_quota_exhausted",
		);
	});

	it("only ever returns a member of the published set", () => {
		// The public widget API republishes this value to a device that lights a
		// warning on an unknown one, so an unlisted return value is a wire break,
		// not a cosmetic slip.
		const samples: Array<[string | null, number | null]> = [
			["all_accounts_failed", 503],
			["family_weekly_exhausted_429", 429],
			["model_not_served", 400],
			["oauth_tokens_expired", 503],
			["pinned_no_available_account", 503],
			["provider_overloaded", 529],
			["burst_retry_exhausted", 429],
			["context_window_exceeded", 400],
			["503 Service Unavailable", 503],
			["totally unknown", null],
			[null, null],
		];
		const published = new Set<StopCause>(STOP_CAUSES);
		for (const [message, status] of samples) {
			expect(published.has(classifyStopCause(message, status))).toBe(true);
		}
	});
});
