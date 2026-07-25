import type { AnthropicUsageData } from "@clankermux/types";
import { normalizeAnthropicUsage } from "./usage-normalizer";

/** An account-level weekly window reduced to utilization + parsed reset ms. */
export interface WeeklyWindow {
	utilization: number;
	resetMs: number | null;
}

/**
 * The flat `seven_day_oauth_apps` window (Claude Code weekly quota) reduced to
 * {utilization, resetMs}, or null when absent / non-numeric. The normalizer's
 * account-wide `weeklyAll` deliberately does NOT capture this window, so it is
 * read directly here — mirroring the account-wide representative in
 * `getRepresentativeUtilization`.
 */
export function flatOauthAppsWindow(
	usage: AnthropicUsageData | null | undefined,
): WeeklyWindow | null {
	const w = usage?.seven_day_oauth_apps;
	if (
		!w ||
		typeof w.utilization !== "number" ||
		!Number.isFinite(w.utilization)
	)
		return null;
	const ms = w.resets_at ? Date.parse(w.resets_at) : null;
	return {
		utilization: w.utilization,
		resetMs: ms !== null && Number.isFinite(ms) ? ms : null,
	};
}

/**
 * Account-wide weekly exhaustion: EITHER the normalized `weeklyAll` window
 * (flat `seven_day` / limits `weekly_all`) OR the flat `seven_day_oauth_apps`
 * window (Claude Code weekly quota) is at/above 100% with a KNOWN FUTURE reset.
 * A past/absent reset is treated as stale/unknown (not exhausted) so we never
 * sideline an account on ambiguous evidence. When more than one window is spent,
 * `resetMs` is the LATEST future reset — the account stays exhausted until all
 * binding windows clear. Family-scoped windows are deliberately NOT considered
 * here (they are per-model, surfaced as detail only).
 *
 * Lives in core (beside `normalizeAnthropicUsage`, which it calls) so `/health`,
 * `/api/accounts` AND the proxy's 429 classification all read one definition.
 */
export function weeklyExhaustion(
	usage: AnthropicUsageData | null | undefined,
	now: number,
): { exhausted: boolean; resetMs: number | null } {
	const windows: WeeklyWindow[] = [];
	const weeklyAll = normalizeAnthropicUsage(usage, now).weeklyAll;
	if (weeklyAll) windows.push(weeklyAll);
	const oauth = flatOauthAppsWindow(usage);
	if (oauth) windows.push(oauth);

	let exhausted = false;
	let resetMs: number | null = null;
	for (const w of windows) {
		if (w.utilization >= 100 && w.resetMs !== null && w.resetMs > now) {
			exhausted = true;
			resetMs = resetMs === null ? w.resetMs : Math.max(resetMs, w.resetMs);
		}
	}
	return { exhausted, resetMs };
}

/**
 * The windows {@link accountWideExhaustion} considers. Each of them sidelines
 * the WHOLE account when spent: the rolling 5-hour `session`, the normalized
 * account-wide weekly (`weekly_all` — flat `seven_day` or the `limits[]` entry),
 * and the flat `seven_day_oauth_apps` (Claude Code weekly). Family-scoped
 * (`weekly_scoped`) windows and `extra_usage` are deliberately NOT in this set.
 */
export type AccountWideWindow =
	| "session"
	| "weekly_all"
	| "seven_day_oauth_apps";

/** Which class of account-wide window is responsible for the exhaustion. */
export type AccountWideExhaustionBinding = "weekly" | "session";

/**
 * Account-wide exhaustion across EVERY window that sidelines the whole account:
 * the 5h `session`, the normalized `weeklyAll`, and the flat
 * `seven_day_oauth_apps` (see {@link AccountWideWindow}). Family-scoped windows
 * are deliberately excluded (a single spent family is not the account) and so is
 * `extra_usage` (overage is the `out_of_credits` floor's business).
 *
 * A window counts as spent at `utilization >= 100` with a KNOWN FUTURE reset — a
 * past/absent reset is stale/unknown, and we never sideline an account on
 * ambiguous evidence. This mirrors {@link weeklyExhaustion} exactly.
 *
 * `binding` reports which class is responsible, weekly OUTRANKING session, so a
 * weekly-spent account keeps reporting weekly even when 5h is also spent. The
 * precedence delegates to {@link weeklyExhaustion} WHOLESALE rather than taking
 * a max reset across classes: "latest reset among all spent windows" would
 * return a session reset `T2` when weekly resets at `T1 < T2`, contradicting
 * `weeklyExhaustion` and making `binding: "weekly"` carry a session-derived
 * reset. A weekly window at 100% with a missing/past reset does NOT suppress a
 * validly-spent session window — in that case the session binds.
 *
 * `weeklyExhaustion` is left untouched and keeps its own callers (`/health` and
 * `/api/accounts` display); this helper is the wider verdict used to classify a
 * 429 against the account-wide windows the usage endpoint reports.
 */
export function accountWideExhaustion(
	usage: AnthropicUsageData | null | undefined,
	now: number,
): {
	exhausted: boolean;
	binding: AccountWideExhaustionBinding | null;
	resetMs: number | null;
} {
	const weekly = weeklyExhaustion(usage, now);
	if (weekly.exhausted) {
		return { exhausted: true, binding: "weekly", resetMs: weekly.resetMs };
	}
	const session = normalizeAnthropicUsage(usage, now).session;
	if (
		session &&
		session.utilization >= 100 &&
		session.resetMs !== null &&
		session.resetMs > now
	) {
		return { exhausted: true, binding: "session", resetMs: session.resetMs };
	}
	return { exhausted: false, binding: null, resetMs: null };
}
