import { describe, expect, it } from "bun:test";
import { accountWideExhaustion } from "@clankermux/core";
import type { AnthropicUsageData } from "@clankermux/types";
import {
	presentRateLimitStatus,
	resolveRateLimitPresentation,
} from "../accounts";

const NOW = 1_750_000_000_000;
const MIN = 60_000;

/** The base "no live lock / no stored status" fields → would read "OK". */
const OK_FIELDS = {
	rate_limit_status: null,
	rate_limit_reset: null,
	rate_limited: 0,
	rate_limited_until: null,
} as const;

/** Run the exhaustion derivation exactly as the accounts handler does. */
function statusForUsage(usage: AnthropicUsageData, now: number): string {
	const { exhausted, resetMs, binding } = accountWideExhaustion(usage, now);
	return presentRateLimitStatus(
		OK_FIELDS,
		now,
		exhausted && binding !== null ? { resetMs, binding } : null,
	);
}

describe("presentRateLimitStatus", () => {
	it("overrides a stale soft status with rate_limited (Nm) when an active lock exists", () => {
		// Backup2-darken scenario: stored status is allowed_warning but the
		// proxy's model_fallback_429 cooldown locked the account.
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "allowed_warning",
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: NOW + 7 * MIN,
			},
			NOW,
		);
		expect(status).toBe("rate_limited (7m)");
	});

	it("rounds active-lock minutes up (ceil)", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "allowed_warning",
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: NOW + 6 * MIN + 1,
			},
			NOW,
		);
		expect(status).toBe("rate_limited (7m)");
	});

	it("overrides a stale soft status even when legacy rate_limited flag is unset", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "queueing_soft",
				rate_limit_reset: null,
				rate_limited: 0,
				rate_limited_until: NOW + 3 * MIN,
			},
			NOW,
		);
		expect(status).toBe("rate_limited (3m)");
	});

	it("keeps a hard stored status untouched during an active lock (with reset minutes)", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "rate_limited",
				rate_limit_reset: NOW + 12 * MIN,
				rate_limited: 1,
				rate_limited_until: NOW + 12 * MIN,
			},
			NOW,
		);
		expect(status).toBe("rate_limited (12m)");
	});

	it("falls back to the lock countdown for a hard status during an active lock (no reset set)", () => {
		// Hard stored status + active lock, but the provider never sent a usable
		// rate_limit_reset — surface the lock-based countdown instead of a bare
		// status with no ETA.
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "blocked",
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: NOW + 5 * MIN,
			},
			NOW,
		);
		expect(status).toBe("blocked (5m)");
	});

	it("hard status + active lock + null reset shows the lock-based countdown", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "rate_limited",
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: NOW + 8 * MIN,
			},
			NOW,
		);
		expect(status).toBe("rate_limited (8m)");
	});

	it("hard status + active lock + past reset falls back to the lock countdown", () => {
		// The provider reset is stale (already elapsed) — the lock is the only
		// live signal, so its countdown wins.
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "rate_limited",
				rate_limit_reset: NOW - MIN,
				rate_limited: 1,
				rate_limited_until: NOW + 10 * MIN,
			},
			NOW,
		);
		expect(status).toBe("rate_limited (10m)");
	});

	it("hard status + active lock + future reset uses the reset-based countdown (reset wins)", () => {
		// Provider reset and lock disagree — the provider reset takes precedence.
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "rate_limited",
				rate_limit_reset: NOW + 12 * MIN,
				rate_limited: 1,
				rate_limited_until: NOW + 30 * MIN,
			},
			NOW,
		);
		expect(status).toBe("rate_limited (12m)");
	});

	it("hard status with no active lock and no reset stays bare", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "rate_limited",
				rate_limit_reset: null,
				rate_limited: 0,
				rate_limited_until: NOW - MIN,
			},
			NOW,
		);
		expect(status).toBe("rate_limited");
	});

	it("treats every hard prefix as hard, case-insensitively (no soft override, lock countdown shown)", () => {
		for (const stored of [
			"rate_limited",
			"Rate_Limited",
			"blocked",
			"queueing_hard",
			"payment_required",
		]) {
			const status = presentRateLimitStatus(
				{
					rate_limit_status: stored,
					rate_limit_reset: null,
					rate_limited: 1,
					rate_limited_until: NOW + 5 * MIN,
				},
				NOW,
			);
			// Hard statuses are never rewritten to the normalized `rate_limited`
			// base; with an active lock and no reset they carry the lock countdown.
			expect(status).toBe(`${stored} (5m)`);
		}
	});

	it("shows soft status unchanged when there is no active lock", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "allowed_warning",
				rate_limit_reset: null,
				rate_limited: 0,
				rate_limited_until: null,
			},
			NOW,
		);
		expect(status).toBe("allowed_warning");
	});

	it("shows soft status with reset minutes when there is no active lock", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "allowed_warning",
				rate_limit_reset: NOW + 9 * MIN,
				rate_limited: 0,
				rate_limited_until: null,
			},
			NOW,
		);
		expect(status).toBe("allowed_warning (9m)");
	});

	it("treats an expired rate_limited_until as no lock", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "allowed_warning",
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: NOW - MIN,
			},
			NOW,
		);
		expect(status).toBe("allowed_warning");
	});

	it("falls back to legacy 'Rate limited (Nm)' when stored status is null", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: null,
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: NOW + 4 * MIN,
			},
			NOW,
		);
		expect(status).toBe("Rate limited (4m)");
	});

	it("returns OK when stored status is null and the legacy lock has expired", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: null,
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: NOW - MIN,
			},
			NOW,
		);
		expect(status).toBe("OK");
	});

	it("returns OK when nothing is set", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: null,
				rate_limit_reset: null,
				rate_limited: 0,
				rate_limited_until: null,
			},
			NOW,
		);
		expect(status).toBe("OK");
	});

	it("surfaces usage_exhausted (Nm) instead of OK when the weekly window is spent", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: null,
				rate_limit_reset: null,
				rate_limited: 0,
				rate_limited_until: null,
			},
			NOW,
			{ resetMs: NOW + 15 * MIN, binding: "weekly" },
		);
		expect(status).toBe("usage_exhausted (15m)");
	});

	it("shows a bare usage_exhausted when the weekly reset is unknown/null", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: null,
				rate_limit_reset: null,
				rate_limited: 0,
				rate_limited_until: null,
			},
			NOW,
			{ resetMs: null, binding: "weekly" },
		);
		expect(status).toBe("usage_exhausted");
	});

	it("prefers weekly exhaustion over an active rate-limit lock (cause wins)", () => {
		// PRECEDENCE INTENTIONALLY REVERSED (was: "prefers an active rate-limit lock
		// over weekly exhaustion", expecting "Rate limited (4m)"). The cooldown lock
		// is the MECHANISM; a spent weekly window is the CAUSE, and the cause is what
		// the operator needs to see. The countdown is the later of the two deadlines.
		const status = presentRateLimitStatus(
			{
				rate_limit_status: null,
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: NOW + 4 * MIN,
			},
			NOW,
			{ resetMs: NOW + 15 * MIN, binding: "weekly" },
		);
		expect(status).toBe("usage_exhausted (15m)");
	});

	it("does not override an OK-returning path when weeklyExhausted is null", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: null,
				rate_limit_reset: null,
				rate_limited: 0,
				rate_limited_until: null,
			},
			NOW,
			null,
		);
		expect(status).toBe("OK");
	});

	it("reflects a spent seven_day_oauth_apps window (binding), not just seven_day", () => {
		// seven_day below 100 but the OAuth-apps weekly quota is spent → non-OK.
		const usage: AnthropicUsageData = {
			five_hour: {
				utilization: 10,
				resets_at: new Date(NOW + 30 * MIN).toISOString(),
			},
			seven_day: {
				utilization: 50,
				resets_at: new Date(NOW + 20 * MIN).toISOString(),
			},
			seven_day_oauth_apps: {
				utilization: 100,
				resets_at: new Date(NOW + 15 * MIN).toISOString(),
			},
		};
		expect(statusForUsage(usage, NOW)).toBe("usage_exhausted (15m)");
	});

	it("does not flag a spent seven_day_oauth_apps whose reset is already past (stale) — stays OK", () => {
		const usage: AnthropicUsageData = {
			five_hour: { utilization: 10, resets_at: null },
			seven_day: { utilization: 50, resets_at: null },
			seven_day_oauth_apps: {
				utilization: 100,
				resets_at: new Date(NOW - MIN).toISOString(),
			},
		};
		expect(statusForUsage(usage, NOW)).toBe("OK");
	});

	it("overrides a no-lock SOFT stored status with usage_exhausted when weekly is spent", () => {
		// allowed_warning is a soft (non-blocking) status; with no active lock and a
		// spent weekly window, the account IS blocked account-wide → usage_exhausted.
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "allowed_warning",
				rate_limit_reset: null,
				rate_limited: 0,
				rate_limited_until: null,
			},
			NOW,
			{ resetMs: NOW + 12 * MIN, binding: "weekly" },
		);
		expect(status).toBe("usage_exhausted (12m)");
	});

	it("overrides a HARD `rate_limited` stored status with usage_exhausted (cause wins)", () => {
		// PRECEDENCE INTENTIONALLY REVERSED (was: "does NOT override a HARD stored
		// status with usage_exhausted", expecting "rate_limited"). `rate_limited`
		// (like `queueing_hard` / `rejected`) is a throttle MECHANISM; the spent
		// weekly window is the CAUSE that explains it. Administrative/billing blocks
		// — `payment_required` / `blocked` — are NOT explained by a spent quota and
		// keep their own label (see the sibling test below).
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "rate_limited",
				rate_limit_reset: null,
				rate_limited: 0,
				rate_limited_until: NOW - MIN, // no active lock
			},
			NOW,
			{ resetMs: NOW + 12 * MIN, binding: "weekly" },
		);
		expect(status).toBe("usage_exhausted (12m)");
	});

	it("keeps `payment_required` / `blocked` over usage_exhausted (independent blocks)", () => {
		for (const stored of ["payment_required", "blocked"]) {
			const status = presentRateLimitStatus(
				{
					rate_limit_status: stored,
					rate_limit_reset: null,
					rate_limited: 0,
					rate_limited_until: NOW - MIN,
				},
				NOW,
				{ resetMs: NOW + 12 * MIN, binding: "weekly" },
			);
			expect(status).toBe(stored);
		}
	});

	it("keeps an out_of_credits reason over usage_exhausted (billing, not quota)", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "allowed_warning",
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: NOW + 5 * MIN,
				rate_limited_reason: "out_of_credits",
			},
			NOW,
			{ resetMs: NOW + 12 * MIN, binding: "weekly" },
		);
		expect(status).toBe("rate_limited (5m)");
	});

	it("overrides a soft status + active lock with usage_exhausted (cause wins)", () => {
		// PRECEDENCE INTENTIONALLY REVERSED (was: "does NOT override a soft status
		// when there is an active lock", expecting "rate_limited (5m)"). Same
		// mechanism-vs-cause reversal as above.
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "allowed_warning",
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: NOW + 5 * MIN,
			},
			NOW,
			{ resetMs: NOW + 12 * MIN, binding: "weekly" },
		);
		expect(status).toBe("usage_exhausted (12m)");
	});

	it("uses the LATER of the lock and the weekly reset for the countdown", () => {
		// A lock that outlives the quota window keeps the countdown honest: the
		// account is still not routable when the weekly window rolls.
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "rate_limited",
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: NOW + 40 * MIN,
			},
			NOW,
			{ resetMs: NOW + 12 * MIN, binding: "weekly" },
		);
		expect(status).toBe("usage_exhausted (40m)");
	});

	it("keeps today's behavior when the weekly reset is unknown but a lock is active", () => {
		// `resetMs: null` is ambiguous evidence — it must NOT outrank a live lock.
		const status = presentRateLimitStatus(
			{
				rate_limit_status: null,
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: NOW + 4 * MIN,
			},
			NOW,
			{ resetMs: null, binding: "weekly" },
		);
		expect(status).toBe("Rate limited (4m)");
	});

	it("labels a short 529-era cooldown on a 100%-weekly account as usage_exhausted", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "allowed",
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: NOW + 60_000, // 1-minute overload cooldown
			},
			NOW,
			{ resetMs: NOW + 2760 * MIN, binding: "weekly" },
		);
		expect(status).toBe("usage_exhausted (2760m)");
	});
});

/**
 * The three live Anthropic accounts that motivated this change. All three are in
 * the IDENTICAL real state (weekly at 100%, future reset); only the presence of
 * a still-ticking proxy cooldown differed, and that made two of them read
 * "rate_limited" while the third read "usage_exhausted". Field values are the
 * ones captured from the live DB / `/api/accounts`.
 */
describe("resolveRateLimitPresentation — captured live accounts", () => {
	const WEEKLY_RESET = NOW + 1380 * MIN;

	it("Claude-Main: `rejected` + lock 30 ms before the weekly reset ⇒ usage_exhausted", () => {
		const presentation = resolveRateLimitPresentation(
			{
				rate_limit_status: "rejected",
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: WEEKLY_RESET - 30,
			},
			NOW,
			{ resetMs: WEEKLY_RESET, binding: "weekly" },
		);
		expect(presentation.cause).toBe("usage_exhausted");
		expect(presentation.resetMs).toBe(WEEKLY_RESET);
		// The raw provider value is preserved for diagnostics.
		expect(presentation.providerStatus).toBe("rejected");
		expect(presentation.status).toBe("usage_exhausted (1380m)");
	});

	it("Claude-Backup-1: `rejected` + lock 872 ms before the weekly reset ⇒ usage_exhausted", () => {
		const weeklyReset = NOW + 4020 * MIN;
		const presentation = resolveRateLimitPresentation(
			{
				rate_limit_status: "rejected",
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: weeklyReset - 872,
			},
			NOW,
			{ resetMs: weeklyReset, binding: "weekly" },
		);
		expect(presentation.cause).toBe("usage_exhausted");
		expect(presentation.status).toBe("usage_exhausted (4020m)");
	});

	it("Claude-Backup-2: `allowed_warning`, expired lock ⇒ usage_exhausted (unchanged)", () => {
		const weeklyReset = NOW + 2760 * MIN;
		const presentation = resolveRateLimitPresentation(
			{
				rate_limit_status: "allowed_warning",
				rate_limit_reset: null,
				rate_limited: 0,
				rate_limited_until: NOW - 5 * MIN,
			},
			NOW,
			{ resetMs: weeklyReset, binding: "weekly" },
		);
		expect(presentation.cause).toBe("usage_exhausted");
		expect(presentation.resetMs).toBe(weeklyReset);
		expect(presentation.status).toBe("usage_exhausted (2760m)");
	});

	/**
	 * Claude-Backup-3 (`4b3a18eb-…`), captured verbatim from `/api/accounts` on
	 * the live deployment at 2026-07-26T15:27:20Z. Its 5-HOUR session window was
	 * fully spent while weekly sat at 79%, and every display surface read
	 * "rate_limited (12m)" — the MECHANISM — because they all called the
	 * weekly-only helper. The proxy's own classifier had it right
	 * (`rate_limited_reason: "session_exhausted_429"`), which is what proved the
	 * defect was display-only.
	 */
	describe("Claude-Backup-3 — session spent, weekly at 79%", () => {
		const B3_NOW = 1_785_079_640_000; // 2026-07-26T15:27:20Z
		const B3_LOCK = 1_785_080_399_401;
		const SESSION_RESET_ISO = "2026-07-26T15:40:00.335173+00:00";
		const WEEKLY_RESET_ISO = "2026-07-28T09:00:00.335198+00:00";

		const usage = {
			five_hour: { utilization: 100, resets_at: SESSION_RESET_ISO },
			seven_day: { utilization: 79, resets_at: WEEKLY_RESET_ISO },
			seven_day_oauth_apps: null,
			limits: [
				{
					kind: "session",
					group: "session",
					percent: 100,
					resets_at: SESSION_RESET_ISO,
					scope: null,
				},
				{
					kind: "weekly_all",
					group: "weekly",
					percent: 79,
					resets_at: WEEKLY_RESET_ISO,
					scope: null,
				},
				{
					kind: "weekly_scoped",
					group: "weekly",
					percent: 41,
					resets_at: "2026-07-28T09:00:00.335494+00:00",
					scope: { model: { display_name: "Fable" } },
				},
			],
			extra_usage: { is_enabled: false },
		} as unknown as AnthropicUsageData;

		it("reports usage_exhausted bound to the SESSION window, not rate_limited", () => {
			const { exhausted, resetMs, binding } = accountWideExhaustion(
				usage,
				B3_NOW,
			);
			expect(exhausted).toBe(true);
			expect(binding).toBe("session");

			const presentation = resolveRateLimitPresentation(
				{
					rate_limit_status: "rejected",
					rate_limit_reset: null,
					rate_limited: 1,
					rate_limited_until: B3_LOCK,
					rate_limited_reason: "session_exhausted_429",
				},
				B3_NOW,
				binding !== null ? { resetMs, binding } : null,
			);
			expect(presentation.cause).toBe("usage_exhausted");
			expect(presentation.binding).toBe("session");
			expect(presentation.providerStatus).toBe("rejected");
			// The session reset (15:40:00.335Z) outlives the lock, so it is the
			// countdown: 12m40s → 13m.
			expect(presentation.status).toBe("usage_exhausted (13m)");
		});
	});
});

describe("resolveRateLimitPresentation — structured fields", () => {
	it("reports cause `ok` with no reset for a healthy account", () => {
		expect(resolveRateLimitPresentation(OK_FIELDS, NOW)).toEqual({
			cause: "ok",
			resetMs: null,
			binding: null,
			providerStatus: null,
			status: "OK",
		});
	});

	it("normalizes `rejected` to the rate_limited cause, preserving the raw value", () => {
		const presentation = resolveRateLimitPresentation(
			{
				rate_limit_status: "rejected",
				rate_limit_reset: NOW + 9 * MIN,
				rate_limited: 0,
				rate_limited_until: null,
			},
			NOW,
		);
		expect(presentation.cause).toBe("rate_limited");
		expect(presentation.providerStatus).toBe("rejected");
		expect(presentation.resetMs).toBe(NOW + 9 * MIN);
		expect(presentation.status).toBe("rejected (9m)");
	});

	it("keeps the lock countdown for `rejected` under an active lock (not in the hard set)", () => {
		// `rejected` is deliberately NOT promoted to ACCOUNT_WIDE_HARD_STATUSES, so
		// the stale-status-under-lock branch still rewrites it — unchanged behavior.
		const presentation = resolveRateLimitPresentation(
			{
				rate_limit_status: "rejected",
				rate_limit_reset: NOW + 9 * MIN,
				rate_limited: 1,
				rate_limited_until: NOW + 3 * MIN,
			},
			NOW,
		);
		expect(presentation.cause).toBe("rate_limited");
		expect(presentation.resetMs).toBe(NOW + 3 * MIN);
		expect(presentation.status).toBe("rate_limited (3m)");
	});

	it("reports the lock deadline as the reset when a stale soft status is overridden", () => {
		const presentation = resolveRateLimitPresentation(
			{
				rate_limit_status: "allowed_warning",
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: NOW + 7 * MIN,
			},
			NOW,
		);
		expect(presentation.cause).toBe("rate_limited");
		expect(presentation.resetMs).toBe(NOW + 7 * MIN);
		expect(presentation.providerStatus).toBe("allowed_warning");
		expect(presentation.status).toBe("rate_limited (7m)");
	});

	it("maps soft statuses to their own causes", () => {
		expect(
			resolveRateLimitPresentation(
				{ ...OK_FIELDS, rate_limit_status: "allowed" },
				NOW,
			).cause,
		).toBe("allowed");
		expect(
			resolveRateLimitPresentation(
				{ ...OK_FIELDS, rate_limit_status: "queueing_soft" },
				NOW,
			).cause,
		).toBe("queueing_soft");
	});

	it("reports an unrecognized provider status as `unknown` and passes it through", () => {
		const presentation = resolveRateLimitPresentation(
			{ ...OK_FIELDS, rate_limit_status: "some_new_status" },
			NOW,
		);
		// A status the vocabulary has not been taught must NOT read as fine — that
		// is exactly how `rejected` went unnoticed — but it is not evidence of a
		// hard block either, hence its own cause in neither set.
		expect(presentation.cause).toBe("unknown");
		expect(presentation.providerStatus).toBe("some_new_status");
		// COMPATIBILITY CONTRACT: the back-compat string still carries the raw
		// value verbatim, so the chip keeps humanizing it exactly as before.
		expect(presentation.status).toBe("some_new_status");
	});

	it("keeps the raw countdown formatting for an unrecognized status", () => {
		const presentation = resolveRateLimitPresentation(
			{
				...OK_FIELDS,
				rate_limit_status: "some_new_status",
				rate_limit_reset: NOW + 5 * MIN,
			},
			NOW,
		);
		expect(presentation.cause).toBe("unknown");
		expect(presentation.status).toBe("some_new_status (5m)");
	});

	it("reports the legacy lock as a rate_limited cause", () => {
		const presentation = resolveRateLimitPresentation(
			{
				rate_limit_status: null,
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: NOW + 4 * MIN,
			},
			NOW,
		);
		expect(presentation.cause).toBe("rate_limited");
		expect(presentation.resetMs).toBe(NOW + 4 * MIN);
		expect(presentation.status).toBe("Rate limited (4m)");
	});

	it("reports usage_exhausted with a null reset when the weekly reset is unknown", () => {
		const presentation = resolveRateLimitPresentation(OK_FIELDS, NOW, {
			resetMs: null,
			binding: "weekly",
		});
		expect(presentation.cause).toBe("usage_exhausted");
		expect(presentation.resetMs).toBeNull();
		expect(presentation.status).toBe("usage_exhausted");
	});

	it("reports a null binding for a plain rate_limited result", () => {
		const presentation = resolveRateLimitPresentation(
			{
				rate_limit_status: "allowed_warning",
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: NOW + 7 * MIN,
			},
			NOW,
		);
		expect(presentation.cause).toBe("rate_limited");
		expect(presentation.binding).toBeNull();
	});
});

/**
 * The 5-hour session class of `usage_exhausted`. Every case here would have read
 * "rate_limited" (or "OK") before the display surfaces moved from the
 * weekly-only helper to `accountWideExhaustion`.
 */
describe("resolveRateLimitPresentation — session-class exhaustion", () => {
	/** A payload whose only spent account-wide window is the 5h session. */
	function sessionSpent(
		sessionResetsAt: string | null,
		percent = 100,
	): AnthropicUsageData {
		return {
			five_hour: { utilization: percent, resets_at: sessionResetsAt },
			seven_day: {
				utilization: 40,
				resets_at: new Date(NOW + 3 * 24 * 60 * MIN).toISOString(),
			},
		} as AnthropicUsageData;
	}

	it("binds to WEEKLY (and the weekly reset) when both classes are spent", () => {
		// Wholesale delegation: never a max across classes, even though the
		// session window here resets LATER than the weekly one.
		const usage = {
			five_hour: {
				utilization: 100,
				resets_at: new Date(NOW + 5 * 24 * 60 * MIN).toISOString(),
			},
			seven_day: {
				utilization: 100,
				resets_at: new Date(NOW + 2 * 24 * 60 * MIN).toISOString(),
			},
		} as AnthropicUsageData;
		const { exhausted, resetMs, binding } = accountWideExhaustion(usage, NOW);
		expect(exhausted).toBe(true);
		expect(binding).toBe("weekly");
		const presentation = resolveRateLimitPresentation(
			OK_FIELDS,
			NOW,
			binding !== null ? { resetMs, binding } : null,
		);
		expect(presentation.binding).toBe("weekly");
		expect(presentation.resetMs).toBe(NOW + 2 * 24 * 60 * MIN);
	});

	it("ignores a spent session whose reset is already PAST (stale evidence)", () => {
		expect(
			statusForUsage(
				sessionSpent(new Date(NOW - MIN).toISOString()),
				NOW,
			),
		).toBe("OK");
	});

	it("ignores a spent session with an ABSENT reset (unknown evidence)", () => {
		expect(statusForUsage(sessionSpent(null), NOW)).toBe("OK");
	});

	it("does not flag a session at 99.9%", () => {
		expect(
			statusForUsage(
				sessionSpent(new Date(NOW + 30 * MIN).toISOString(), 99.9),
				NOW,
			),
		).toBe("OK");
	});

	it("keeps an out_of_credits cooldown over a spent session (billing, not quota)", () => {
		const presentation = resolveRateLimitPresentation(
			{
				rate_limit_status: "allowed_warning",
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: NOW + 5 * MIN,
				rate_limited_reason: "out_of_credits",
			},
			NOW,
			{ resetMs: NOW + 12 * MIN, binding: "session" },
		);
		expect(presentation.cause).toBe("rate_limited");
		expect(presentation.binding).toBeNull();
		expect(presentation.status).toBe("rate_limited (5m)");
	});

	it("keeps `payment_required` / `blocked` over a spent session (independent blocks)", () => {
		for (const stored of ["payment_required", "blocked"]) {
			const presentation = resolveRateLimitPresentation(
				{
					rate_limit_status: stored,
					rate_limit_reset: null,
					rate_limited: 0,
					rate_limited_until: NOW - MIN,
				},
				NOW,
				{ resetMs: NOW + 12 * MIN, binding: "session" },
			);
			expect(presentation.status).toBe(stored);
			expect(presentation.binding).toBeNull();
		}
	});
});
