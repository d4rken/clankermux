/**
 * Per-claim parsing of Anthropic's unified rate-limit headers.
 *
 * A 429 carries a SUMMARY set (`anthropic-ratelimit-unified-status/-reset`,
 * `retry-after`) plus PER-CLAIM lines
 * (`anthropic-ratelimit-unified-<claim>-status/-utilization/-reset`) where the
 * claim token is `5h`/`7d` (account-wide) or a scoped window like `7d_oi`
 * (`seven_day_overage_included` — e.g. one model family's weekly bucket).
 *
 * On a MODEL-FAMILY-SCOPED rejection the summary asserts the whole account is
 * rejected until the scoped claim's reset (observed: `retry-after` of 4.5
 * days), while the per-claim lines show the account-wide pair with headroom.
 * Code that trusts the summary without checking claim scope turns one family's
 * exhaustion into an account-wide verdict — the bug class behind both
 * 2026-08-02 incidents. These helpers are the ONE place that derives claim
 * scope; consumers decide trust (official-upstream gating) themselves.
 *
 * Every predicate is conservative-AND (measured over 1,145 production 429s —
 * see the rate-limiting skill's 429-signals reference):
 *  - A per-IP burst carries NO unified headers at all (973/973 measured), so
 *    every helper yields null/false for it.
 *  - A genuine account-wide 429 rejects `5h` or `7d` themselves, which fails
 *    the headroom predicate.
 *  - The `overage` axis is a billing state, not a window: its token does not
 *    match the scoped-window shape and never counts as scoped evidence.
 */
import { REJECTING_STATUSES, SOFT_WARNING_STATUSES } from "./rate-limit-status";

const UNIFIED_STATUS_HEADER_RE = /^anthropic-ratelimit-unified-(.+)-status$/;
const SCOPED_WINDOW_TOKEN_RE = /^(?:5h|7d)_[a-z0-9_]+$/;
/** Full-string non-negative decimal — parseFloat's prefix tolerance ("0.94x",
 *  "0x1", comma-combined duplicates) must not manufacture headroom. */
const STRICT_DECIMAL_RE = /^\d+(?:\.\d+)?$/;

/**
 * Account-wide window statuses that positively assert HEADROOM. Whitelist, not
 * a `!== "rejected"` check: a hard status (`rate_limited`, `blocked`, …), an
 * empty value, or an unknown future status must all fail the predicate — only
 * an explicit non-blocking vocabulary entry counts as evidence of headroom.
 */
const HEADROOM_STATUSES: ReadonlySet<string> = new Set([
	"allowed",
	...SOFT_WARNING_STATUSES,
]);

export function parseStrictDecimal(value: string | null): number | null {
	if (value === null || !STRICT_DECIMAL_RE.test(value)) return null;
	return Number.parseFloat(value);
}

/** One account-wide claim's per-claim header values. */
export interface UnifiedClaimReading {
	status: string;
	utilization: number;
	/** Epoch ms from the claim's own `-reset` line; null when unparseable. */
	resetMs: number | null;
}

/** The account-wide `5h`/`7d` pair, present only when BOTH assert headroom. */
export interface AccountWideClaimHeadroom {
	fiveHour: UnifiedClaimReading;
	sevenDay: UnifiedClaimReading;
}

/**
 * True when the ACCOUNT-WIDE `5h` or `7d` claim itself reports a rejecting
 * status. Live account-wide evidence outranks every scoped verdict — including
 * one derived from a fresh-looking usage cache that simply lags the
 * exhaustion. A burst 429 carries no unified headers, so this is false for it.
 */
export function hasAccountWideUnifiedRejection(headers: Headers): boolean {
	for (const win of ["5h", "7d"]) {
		const status = headers.get(`anthropic-ratelimit-unified-${win}-status`);
		if (status !== null && REJECTING_STATUSES.has(status)) return true;
	}
	return false;
}

/**
 * The account-wide `5h`/`7d` pair — non-null only when BOTH claims are
 * present, carry a whitelisted headroom status, AND parse to a strict-decimal
 * utilization < 1. Any contradiction, unknown value, or absence yields null:
 * missing evidence must read as "no headroom proven", never as headroom.
 */
export function getAccountWideClaimHeadroom(
	headers: Headers,
): AccountWideClaimHeadroom | null {
	const readings: UnifiedClaimReading[] = [];
	for (const win of ["5h", "7d"]) {
		const status = headers.get(`anthropic-ratelimit-unified-${win}-status`);
		if (status === null || !HEADROOM_STATUSES.has(status)) return null;
		const utilization = parseStrictDecimal(
			headers.get(`anthropic-ratelimit-unified-${win}-utilization`),
		);
		if (utilization === null || utilization >= 1) return null;
		const resetSec = parseStrictDecimal(
			headers.get(`anthropic-ratelimit-unified-${win}-reset`),
		);
		readings.push({
			status,
			utilization,
			resetMs: resetSec !== null ? resetSec * 1000 : null,
		});
	}
	return { fiveHour: readings[0], sevenDay: readings[1] };
}

/** A rejected scoped-window claim, with the soonest finite FUTURE reset among
 *  all rejected scoped claims (null when none of their resets parse/are future). */
export interface ScopedClaimRejection {
	soonestResetMs: number | null;
}

/**
 * The scoped-window rejection on this response, if any: at least one
 * `5h_*`/`7d_*` claim (e.g. `7d_oi`) reporting `rejected`. The `overage` axis
 * never matches the token shape. Null when no scoped claim rejects.
 */
export function getScopedClaimRejection(
	headers: Headers,
	now: number,
): ScopedClaimRejection | null {
	let sawScopedRejection = false;
	let soonestResetMs = Number.POSITIVE_INFINITY;
	headers.forEach((value, name) => {
		const token = UNIFIED_STATUS_HEADER_RE.exec(name)?.[1];
		if (!token || !SCOPED_WINDOW_TOKEN_RE.test(token)) return;
		if (value !== "rejected") return;
		sawScopedRejection = true;
		const resetSec = parseStrictDecimal(
			headers.get(`anthropic-ratelimit-unified-${token}-reset`),
		);
		if (resetSec !== null && resetSec * 1000 > now) {
			soonestResetMs = Math.min(soonestResetMs, resetSec * 1000);
		}
	});
	if (!sawScopedRejection) return null;
	return {
		soonestResetMs: Number.isFinite(soonestResetMs) ? soonestResetMs : null,
	};
}

/**
 * The incident signature: the SUMMARY status says `rejected`, but the
 * account-wide pair proves headroom and at least one scoped claim is the
 * actual rejecter. On this shape the summary's reset/`retry-after` describe
 * the SCOPED claim (observed: multi-day) and must not be applied account-wide.
 */
export function isScopedOnlyUnifiedRejection(headers: Headers): boolean {
	if (headers.get("anthropic-ratelimit-unified-status") !== "rejected") {
		return false;
	}
	if (getAccountWideClaimHeadroom(headers) === null) return false;
	return getScopedClaimRejection(headers, 0) !== null;
}
