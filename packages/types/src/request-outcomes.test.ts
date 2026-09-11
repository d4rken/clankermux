import { describe, expect, it } from "bun:test";
import {
	classifyRequestOutcomeCause,
	classifyStopCause,
	isLegacyAttemptAudit,
	outcomeForCause,
	STOP_CAUSES,
} from "./stops-history";

describe("recorded request outcomes", () => {
	it.each([
		["client disconnected", 200, "client_disconnected", "disconnected"],
		["request timed out", 200, "request_timed_out", "failed"],
		["stream error", 200, "stream_failed", "failed"],
		["upstream_stream_error", 200, "stream_failed", "failed"],
		["stream_truncated_mid_content", 200, "stream_failed", "failed"],
		["native_responses_stream_failed", 200, "stream_failed", "failed"],
		["native_responses_no_terminal", 200, "stream_failed", "failed"],
		["rate_limit_error", 200, "stream_limited", "failed"],
		["overloaded_error", 200, "stream_limited", "failed"],
		["provider_overloaded", 529, "provider_overloaded", "blocked"],
		["pool_exhausted", 503, "pool_quota_exhausted", "blocked"],
		["all_accounts_failed", 503, "all_accounts_failed", "failed"],
		["429 rate_limit_error: exhausted", 429, "upstream_error", "failed"],
		["future_terminal", 200, "other", "unclassified"],
		[null, 503, "other", "unclassified"],
		["__proto__", 200, "other", "unclassified"],
	] as const)("classifies %s by recorded reason", (message, status, cause, outcome) => {
		expect(classifyRequestOutcomeCause(message, status)).toBe(cause);
		expect(STOP_CAUSES).toContain(classifyRequestOutcomeCause(message, status));
		expect(outcomeForCause(cause)).toBe(outcome);
	});
	it.each([
		"anthropic_excluded_no_account",
		"pinned_account_missing",
		"pinned_account_unavailable",
		"pinned_header_rejected",
		"pinned_resolution_error",
	])("recognizes local refusal %s", (message) => {
		expect(classifyRequestOutcomeCause(message, 503)).toBe(
			"pinned_target_unavailable",
		);
	});
	it("preserves the legacy classification consumed by public events", () => {
		expect(classifyStopCause("all_accounts_failed", 503)).toBe(
			"pool_quota_exhausted",
		);
		expect(classifyStopCause("pinned_account_missing", 503)).toBe(
			"upstream_error",
		);
		expect(classifyStopCause("client disconnected", 200)).toBe("other");
	});
	it("assigns every history cause an outcome", () => {
		for (const cause of STOP_CAUSES)
			expect(["blocked", "failed", "disconnected", "unclassified"]).toContain(
				outcomeForCause(cause),
			);
	});
	it.each([
		"weekly_exhausted_429",
		"session_exhausted_429",
		"family_weekly_exhausted_429",
		"model_fallback_429",
	])("excludes only the verified audit pair %s / 429", (message) => {
		expect(isLegacyAttemptAudit(message, 429)).toBe(true);
		expect(isLegacyAttemptAudit(message, 503)).toBe(false);
		expect(isLegacyAttemptAudit(message, null)).toBe(false);
	});
	it.each([
		"out_of_credits",
		"all_models_exhausted_429",
		"scoped_quota_rejected_429",
		"family_weekly_exhausted",
		"future_429",
		null,
	])("keeps unproven and client terminal labels %s", (message) => {
		expect(isLegacyAttemptAudit(message, 429)).toBe(false);
	});
});
