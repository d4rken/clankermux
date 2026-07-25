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
