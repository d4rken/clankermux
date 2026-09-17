import type {
	AnthropicUsageData,
	DevinUsageData,
	FullUsageData,
	ZaiUsageData,
} from "@clankermux/types";
import {
	isAnthropicUsageShape,
	normalizeAnthropicUsage,
} from "./usage-normalizer";

/**
 * Read the ACCOUNT-WIDE quota windows (rolling 5-hour, rolling weekly, calendar
 * daily) out of whatever shape a provider's usage payload happens to have.
 *
 * These used to live in the dashboard (`lib/pool-usage.ts`), which was fine
 * while the only consumer was the browser. `GET /api/runway` computes the same
 * projection server-side and `@clankermux/http-api` cannot import from
 * `dashboard-web`, so they live here: everything they need is
 * `@clankermux/types` plus core's own Anthropic usage normalizer.
 *
 * Both extractors return `null` when the payload is a shape they do not
 * recognise (the caller decides whether that is "unmetered" or "unreadable"),
 * and `{ pct: null }` when the shape IS recognised but carries no percentage.
 * Those two are deliberately different answers.
 */

/**
 * Providers whose accounts report an account-wide 5-hour quota window. A
 * provider in NEITHER set has no account-wide quota window at all and must not
 * be treated as an unreadable account.
 */
export const FIVE_HOUR_ELIGIBLE_PROVIDERS: ReadonlySet<string> = new Set([
	"anthropic",
	"codex",
	"alibaba-coding-plan",
	"zai",
]);

/** Providers whose accounts report an account-wide weekly quota window. */
export const SEVEN_DAY_ELIGIBLE_PROVIDERS: ReadonlySet<string> = new Set([
	"zai",
	"anthropic",
	"codex",
	"alibaba-coding-plan",
	"devin",
]);

/**
 * Providers whose accounts report an account-wide DAILY quota window.
 *
 * Its own set rather than a third membership in the two above, because a daily
 * window is not a slower 5-hour one: it is a separate allowance with its own
 * reset, and an account can be spent on it while both other windows have room.
 * Only Devin reports one, which is also why it has no 5-hour entry — daily is
 * the short window it paces you with.
 */
export const DAILY_ELIGIBLE_PROVIDERS: ReadonlySet<string> = new Set(["devin"]);

/**
 * Providers whose account-wide readings are RECORDED into `usage_snapshots` and
 * derived from afterwards: the history series, the exhaustion regression, the
 * revision-anchor registry and the weekly burn slopes all read that one series,
 * so they must agree on who is in it.
 *
 * Deliberately narrower than the two sets above. Reporting a window is not the
 * same as having had the derivation layer verified against it — a provider
 * joins this set when someone has checked what the snapshots, the regression
 * and the anchors do with its payload, not merely because a percentage can be
 * read out of it.
 */
export const USAGE_HISTORY_PROVIDERS: ReadonlySet<string> = new Set([
	"anthropic",
	"codex",
	"zai",
]);

export function normalizeResetMs(
	value: string | number | null | undefined,
): number | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

export function isAlibabaShape(
	usageData: FullUsageData | null | undefined,
): boolean {
	return usageData != null && "five_hour" in usageData && "weekly" in usageData;
}

export function isZaiShape(
	usageData: FullUsageData | null | undefined,
): boolean {
	return (
		usageData != null &&
		("time_limit" in usageData || "tokens_limit" in usageData)
	);
}

/**
 * Devin's payload carries an explicit `kind` discriminant, so this asks for that
 * rather than sniffing `daily`/`weekly` key names — which another provider could
 * plausibly reuse, and which would then be read with Devin's field semantics.
 */
export function isDevinShape(
	usageData: FullUsageData | null | undefined,
): usageData is DevinUsageData {
	return (
		usageData != null && (usageData as { kind?: unknown }).kind === "devin"
	);
}

export function isAnthropicStyleShape(
	usageData: FullUsageData | null | undefined,
): boolean {
	if (usageData == null) return false;
	if (isAlibabaShape(usageData)) return false;
	if (isZaiShape(usageData)) return false;
	if (isDevinShape(usageData)) return false;
	// Flat five_hour/seven_day OR a non-empty `limits[]` (upstream is dropping the
	// flat keys). Alibaba/Zai were already excluded above, so a bare `limits[]`
	// array here is unambiguously an Anthropic-style payload.
	return isAnthropicUsageShape(usageData as AnthropicUsageData);
}

export interface ExtractedValue {
	pct: number | null;
	resetMs: number | null;
}

export function extractFiveHour(
	usageData: FullUsageData,
): ExtractedValue | null {
	// Devin runs calendar daily and weekly windows and no 5-hour one. Null, not
	// `{ pct: null }`: there is no window here to be waiting on a reading from.
	if (isDevinShape(usageData)) return null;
	if (isAlibabaShape(usageData)) {
		const data = usageData as {
			five_hour: { percentUsed: number | null; resetAt: number | null };
		};
		return {
			pct: data.five_hour?.percentUsed ?? null,
			resetMs: normalizeResetMs(data.five_hour?.resetAt ?? null),
		};
	}
	if (isZaiShape(usageData)) {
		const data = usageData as {
			tokens_limit?: {
				percentage: number | null;
				resetAt: number | null;
			} | null;
		};
		const tokens = data.tokens_limit;
		if (!tokens) {
			return { pct: null, resetMs: null };
		}
		return {
			pct: tokens.percentage ?? null,
			resetMs: normalizeResetMs(tokens.resetAt ?? null),
		};
	}
	if (isAnthropicStyleShape(usageData)) {
		// Read the session (5h) window via the normalizer so a `limits[]`-only
		// payload resolves too. For a flat payload this reads the same
		// five_hour.utilization / resets_at the direct field access did. `now`
		// only gates scoped windows (unused here), so a constant is fine.
		const session = normalizeAnthropicUsage(
			usageData as AnthropicUsageData,
			Date.now(),
		).session;
		return {
			pct: session?.utilization ?? null,
			resetMs: session?.resetMs ?? null,
		};
	}
	return null;
}

export function extractSevenDay(
	usageData: FullUsageData,
): ExtractedValue | null {
	if (isDevinShape(usageData)) return devinWindow(usageData.weekly);
	if (isAlibabaShape(usageData)) {
		const data = usageData as {
			weekly: { percentUsed: number | null; resetAt: number | null };
		};
		return {
			pct: data.weekly?.percentUsed ?? null,
			resetMs: normalizeResetMs(data.weekly?.resetAt ?? null),
		};
	}
	if (isZaiShape(usageData)) {
		const weekly = (usageData as ZaiUsageData).tokens_limit_weekly;
		return weekly
			? {
					pct: weekly.percentage ?? null,
					resetMs: normalizeResetMs(weekly.resetAt),
				}
			: null;
	}
	if (isAnthropicStyleShape(usageData)) {
		// Read the account-wide weekly window via the normalizer so a `limits[]`-only
		// payload resolves too. For a flat payload this reads the same
		// seven_day.utilization / resets_at (model-scoped opus/sonnet windows are
		// deliberately NOT counted, matching the old behavior). `now` only gates
		// scoped windows (unused here), so a constant is fine.
		const weeklyAll = normalizeAnthropicUsage(
			usageData as AnthropicUsageData,
			Date.now(),
		).weeklyAll;
		return {
			pct: weeklyAll?.utilization ?? null,
			resetMs: weeklyAll?.resetMs ?? null,
		};
	}
	return null;
}

/**
 * One Devin window as an {@link ExtractedValue}.
 *
 * A null window reads `{ pct: null }` — "this window exists, we have no
 * percentage for it" — and NOT `null`, which would say the account runs no such
 * window at all.
 *
 * Devin nulls a window for several reasons at once and does not say which: an
 * allowance the upstream marks hidden, a plan billed on credits rather than
 * quota, a percentage that arrived unreadable, and a response carrying no plan
 * status. The first two are genuine absence, the last two are failures to read,
 * and `normalizeDevinUsage` collapses all four. With the two indistinguishable,
 * `{ pct: null }` is the claim we can defend: an account of unknown standing is
 * excluded from the pool's capacity, where `null` would announce an account
 * that quota never constrains.
 */
function devinWindow(
	window: DevinUsageData["daily"] | DevinUsageData["weekly"],
): ExtractedValue {
	if (!window) return { pct: null, resetMs: null };
	return {
		pct: window.utilization ?? null,
		resetMs: normalizeResetMs(window.resetAt),
	};
}

/**
 * The account-wide DAILY window, for the providers that run one.
 *
 * Null for every other shape, exactly as the other two extractors are null for
 * a shape they do not recognise: a provider without a daily allowance is not an
 * account whose daily reading failed to arrive.
 */
export function extractDaily(usageData: FullUsageData): ExtractedValue | null {
	if (isDevinShape(usageData)) return devinWindow(usageData.daily);
	return null;
}
