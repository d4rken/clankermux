import type {
	AnthropicUsageData,
	FullUsageData,
	GrokSubscriptionUsageData,
	UsageExhaustionBinding,
	ZaiUsageData,
} from "@clankermux/types";
import { normalizeAnthropicUsage } from "./usage-normalizer";
import { extractFiveHour, extractSevenDay } from "./usage-window-extract";

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

/**
 * Which class of account-wide window is responsible for the exhaustion. Alias of
 * the API-facing {@link UsageExhaustionBinding} (which lives in
 * `@clankermux/types`, the leaf dependency) so the verdict this helper computes
 * and the value `/api/accounts` serializes are the same type by construction.
 */
export type AccountWideExhaustionBinding = UsageExhaustionBinding;

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
 * `weeklyExhaustion` is retained as the WEEKLY-CLASS PRIMITIVE this helper
 * delegates to (and keeps its own test file); it is no longer the display
 * surfaces' entry point. `/health`, `/api/accounts` and the proxy's 429
 * classification all call THIS helper, so a session-exhausted account reports
 * the cause (a spent window) rather than the mechanism (a cooldown lock).
 */
export function accountWideExhaustion(
	usage: AnthropicUsageData | null | undefined,
	now: number,
	/**
	 * Optional NARROWER/FRESHER view consulted for the fast-moving 5h session
	 * window only. Defaults to `usage`, so every existing caller is unchanged.
	 * Exists because `/api/accounts` renders weekly from a 30-minute UI horizon
	 * that is too generous for a 5h window — see accounts.ts's "TWO VIEWS" note.
	 */
	sessionUsage: AnthropicUsageData | null | undefined = usage,
): {
	exhausted: boolean;
	binding: AccountWideExhaustionBinding | null;
	resetMs: number | null;
} {
	const weekly = weeklyExhaustion(usage, now);
	if (weekly.exhausted) {
		return { exhausted: true, binding: "weekly", resetMs: weekly.resetMs };
	}
	const session = normalizeAnthropicUsage(sessionUsage, now).session;
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

/** The verdict shape every account-wide exhaustion helper here returns. */
export interface AccountWideExhaustionVerdict {
	exhausted: boolean;
	binding: AccountWideExhaustionBinding | null;
	resetMs: number | null;
}

const NOT_EXHAUSTED: AccountWideExhaustionVerdict = {
	exhausted: false,
	binding: null,
	resetMs: null,
};

/** A window counts as spent only at >=100% with a KNOWN FUTURE reset. */
function spentWindow(
	window: { pct: number | null; resetMs: number | null } | null,
	now: number,
): number | null {
	if (!window || window.pct === null || window.pct < 100) return null;
	if (window.resetMs === null || window.resetMs <= now) return null;
	return window.resetMs;
}

/**
 * {@link accountWideExhaustion} for a Zai reading, which reports the same two
 * account-wide classes under its own window names and has neither the
 * `seven_day_oauth_apps` window nor any family-scoped one.
 *
 * A sibling rather than a branch inside `accountWideExhaustion`: that function
 * is typed to the Anthropic payload and delegates the weekly class to
 * `weeklyExhaustion`, and neither reads anything a Zai payload carries.
 * Precedence and the spent-window rule are identical — weekly outranks session,
 * and a past/absent reset is stale rather than exhausted, because we never
 * sideline an account on ambiguous evidence.
 */
export function zaiAccountWideExhaustion(
	usage: ZaiUsageData | null | undefined,
	now: number,
	/**
	 * Optional NARROWER/FRESHER view consulted for the five-hour window only,
	 * mirroring {@link accountWideExhaustion}'s parameter of the same name.
	 */
	sessionUsage: ZaiUsageData | null | undefined = usage,
): AccountWideExhaustionVerdict {
	if (!usage) return NOT_EXHAUSTED;
	const weeklyReset = spentWindow(extractSevenDay(usage), now);
	if (weeklyReset !== null) {
		return { exhausted: true, binding: "weekly", resetMs: weeklyReset };
	}
	const sessionReset = sessionUsage
		? spentWindow(extractFiveHour(sessionUsage), now)
		: null;
	if (sessionReset !== null) {
		return { exhausted: true, binding: "session", resetMs: sessionReset };
	}
	return NOT_EXHAUSTED;
}

/**
 * {@link accountWideExhaustion} for a grok-subscription reading, which has ONE
 * account-wide window: the weekly pool every Grok surface draws from. There is
 * no session class to rank against it, so the precedence the two helpers above
 * implement has nothing to decide here.
 *
 * An unknown `weeklyUtilization` reads as `{ pct: null }`, which `spentWindow`
 * rejects — so an account whose percentage the billing endpoint omitted is
 * reported as no-evidence rather than as either spent or healthy.
 */
export function grokSubscriptionAccountWideExhaustion(
	usage: GrokSubscriptionUsageData | null | undefined,
	now: number,
): AccountWideExhaustionVerdict {
	if (!usage) return NOT_EXHAUSTED;
	const weeklyReset = spentWindow(extractSevenDay(usage), now);
	if (weeklyReset === null) return NOT_EXHAUSTED;
	return { exhausted: true, binding: "weekly", resetMs: weeklyReset };
}

/**
 * The account-wide exhaustion verdict for ONE account, dispatched on its
 * provider, so the four surfaces that report it — `/api/accounts`, `/health`,
 * the public snapshot and the proxy's 429 classification — cannot disagree
 * about which helper a provider's payload belongs to.
 *
 * A provider with no helper here is reported as not exhausted: it either has no
 * account-wide window at all, or its payload has not been verified against this
 * verdict. Both are "no evidence", which is not evidence of exhaustion.
 */
export function accountWideExhaustionFor(
	provider: string,
	usage: FullUsageData | null | undefined,
	now: number,
	sessionUsage: FullUsageData | null | undefined = usage,
): AccountWideExhaustionVerdict {
	if (provider === "anthropic" || provider === "codex") {
		return accountWideExhaustion(
			usage as AnthropicUsageData | null | undefined,
			now,
			sessionUsage as AnthropicUsageData | null | undefined,
		);
	}
	if (provider === "zai") {
		return zaiAccountWideExhaustion(
			usage as ZaiUsageData | null | undefined,
			now,
			sessionUsage as ZaiUsageData | null | undefined,
		);
	}
	if (provider === "grok-subscription") {
		// No `sessionUsage`: the fresh-view parameter exists for the fast-moving
		// 5h window, and this provider has none.
		return grokSubscriptionAccountWideExhaustion(
			usage as GrokSubscriptionUsageData | null | undefined,
			now,
		);
	}
	return NOT_EXHAUSTED;
}
