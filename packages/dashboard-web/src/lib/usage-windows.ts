import {
	classifyScopedFamilyEvidence,
	getModelFamily,
	type LiveScopedFamily,
	normalizeAnthropicUsage,
	servableClassFor,
} from "@clankermux/core";
import type {
	AnthropicUsageData,
	FullUsageData,
	StaleUsageInfo,
} from "@clankermux/types";
import {
	providerShowsCreditsBalance,
	providerShowsWeeklyUsage,
} from "../utils/provider-utils";
import { getScopedWeeklyLimits } from "./secondary-limits";

const WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours in milliseconds

/** One usage window as a rate-limit card renders it. */
export interface UsageDisplay {
	utilization: number | null;
	window: string | null;
	resetTime: string | null;
	label?: string;
	/**
	 * `"unopened"`: a labelled scoped-weekly row for a family this account has
	 * not used this window — its payload carries no window for the family, or an
	 * idle one (0%, no reset). Anthropic states an untouched family's entry
	 * either way until its first use, so there is no reading to show.
	 *
	 * `utilization` and `resetTime` are null BY CONTRACT on such a row and must
	 * never be rendered as a bar, a percentage or a countdown — a 0% bar claims a
	 * measurement nobody made, and the generic "Usage data unavailable" copy
	 * blames the proxy for a fact about the account.
	 */
	state?: "unopened";
}

/**
 * The account fields a rate-limit card reads. A subset of `AccountResponse`, so
 * both the card and the cross-account aggregation below can be handed an
 * account directly.
 */
export interface UsageCardSource {
	resetIso: string | null;
	usageUtilization?: number | null;
	usageWindow?: string | null;
	usageData?: FullUsageData | null;
	staleUsage?: StaleUsageInfo | null;
	usageRateLimitedUntil?: number | null;
	provider: string;
	showWeekly?: boolean;
	/**
	 * Families some UNPAUSED account in THIS account's servable class reports
	 * live, from `listLiveScopedFamiliesByClass` over the unpaused accounts.
	 *
	 * Supplied by list-level callers and omitted when the card renders alone: a
	 * single card cannot know whether a family it does not report even exists in
	 * the pool, and without that it could only guess at the difference between
	 * "not used yet" and "no such limit for this provider".
	 */
	poolScopedFamilies?: readonly LiveScopedFamily[];
}

/**
 * What a rate-limit card shows for one account. Four of the five variants are
 * standalone message blocks with no per-window countdown; only `windows`
 * renders the grid of progress cards.
 */
export type UsageCard =
	| { kind: "none" }
	| { kind: "rate-limited"; retryAfterMs: number }
	| { kind: "stale"; staleUsage: StaleUsageInfo }
	| { kind: "credits"; remainingUsd: number; hasCredits: boolean }
	| { kind: "windows"; usages: UsageDisplay[] };

/**
 * Decide which of the five card shapes an account gets, and for the window grid
 * derive the windows themselves.
 *
 * This is the single place the branch conditions live. The card component
 * switches on the result rather than re-testing them, so the cross-account
 * "soonest reset" aggregation cannot disagree with what actually renders — a
 * window that wins the comparison here is a window the user can see.
 */
export function classifyUsageCard(
	source: UsageCardSource,
	now: number,
): UsageCard {
	const {
		resetIso,
		usageUtilization,
		usageWindow,
		usageData,
		staleUsage,
		usageRateLimitedUntil,
		provider,
		showWeekly = false,
		poolScopedFamilies,
	} = source;

	// Allow a null resetIso for providers that show usage data (e.g. PayG mode)
	// but render nothing when there is no reset AND no usage data to show.
	if (!resetIso && !usageData && !staleUsage && !usageRateLimitedUntil)
		return { kind: "none" };

	// Explicit rate-limited state when the Anthropic usage API returned 429 and
	// we have NOTHING else to show. A persisted stale snapshot takes precedence
	// over this bare note (it falls through to the stale branch below, which
	// carries its own "usage API rate limited" line), so the last-known reading
	// is never hidden by the rate-limited branch.
	if (
		usageRateLimitedUntil != null &&
		!usageData &&
		!staleUsage &&
		(provider === "anthropic" || provider === "codex")
	) {
		return { kind: "rate-limited", retryAfterMs: usageRateLimitedUntil };
	}

	// Live usage data is gone (e.g. right after a restart before the poller warms
	// the cache, or usage polling fails because the subscription lapsed) but a
	// persisted snapshot still knows the last-sampled state.
	if (!usageData && staleUsage) return { kind: "stale", staleUsage };

	// Kilo Gateway: a credit balance in USD instead of a utilization window.
	if (providerShowsCreditsBalance(provider) && usageData) {
		const kiloData = usageData as {
			remainingUsd?: number;
			totalMicrodollarsAcquired?: number;
		};
		if (typeof kiloData.remainingUsd === "number") {
			return {
				kind: "credits",
				remainingUsd: kiloData.remainingUsd,
				hasCredits: (kiloData.totalMicrodollarsAcquired ?? 0) > 0,
			};
		}
	}

	const resetTime = resetIso ? new Date(resetIso).getTime() : now;
	const usages: UsageDisplay[] = [];

	// Zai usage data has 'time_limit' and 'tokens_limit' properties.
	const isZaiData =
		usageData && ("time_limit" in usageData || "tokens_limit" in usageData);

	// Alibaba Coding Plan usage data.
	const isAlibabaData =
		usageData && "five_hour" in usageData && "weekly" in usageData;

	// Anthropic-style quota data is shared by Anthropic and Codex; detect by shape, not provider name.
	const hasAnthropicStyleData =
		usageData &&
		"five_hour" in usageData &&
		"seven_day" in usageData &&
		!isAlibabaData &&
		!isZaiData;

	if (isAlibabaData && showWeekly) {
		const alibabaData = usageData as {
			five_hour: { percentUsed: number; resetAt: number | null };
			weekly: { percentUsed: number; resetAt: number | null };
			monthly: { percentUsed: number; resetAt: number | null };
		};
		usages.push({
			utilization: alibabaData.five_hour.percentUsed,
			window: "five_hour",
			resetTime: alibabaData.five_hour.resetAt
				? new Date(alibabaData.five_hour.resetAt).toISOString()
				: null,
		});
		usages.push({
			utilization: alibabaData.weekly.percentUsed,
			window: "weekly",
			resetTime: alibabaData.weekly.resetAt
				? new Date(alibabaData.weekly.resetAt).toISOString()
				: null,
		});
		usages.push({
			utilization: alibabaData.monthly.percentUsed,
			window: "monthly",
			resetTime: alibabaData.monthly.resetAt
				? new Date(alibabaData.monthly.resetAt).toISOString()
				: null,
		});
	} else if (isZaiData && showWeekly) {
		// Zai usage data - show tokens_limit (5-hour token quota) and time_limit (peak-hour limit)
		const zaiData = usageData as {
			time_limit?: { percentage: number; resetAt: number } | null;
			tokens_limit?: { percentage: number; resetAt: number } | null;
		};

		// Tokens limit usage (5-hour token quota)
		if (zaiData.tokens_limit) {
			usages.push({
				utilization: zaiData.tokens_limit.percentage,
				window: "tokens_limit",
				resetTime: zaiData.tokens_limit.resetAt
					? new Date(zaiData.tokens_limit.resetAt).toISOString()
					: null,
			});
		}

		// Time limit usage (peak-hour quota)
		if (zaiData.time_limit) {
			usages.push({
				utilization: zaiData.time_limit.percentage,
				window: "time_limit",
				resetTime: zaiData.time_limit.resetAt
					? new Date(zaiData.time_limit.resetAt).toISOString()
					: null,
			});
		}
	} else if (hasAnthropicStyleData && showWeekly) {
		// Anthropic usage data - show 5-hour and weekly usage
		const anthropicData = usageData as {
			five_hour?: {
				utilization: number | null;
				resets_at: string | null;
			} | null;
			seven_day?: { utilization: number | null; resets_at: string | null };
			seven_day_opus?: { utilization: number | null; resets_at: string | null };
			seven_day_sonnet?: {
				utilization: number | null;
				resets_at: string | null;
			};
		};
		// 5-hour card contract (0 vs null): a truthy `five_hour` object is a REAL
		// window and always renders — even at 0% with a null reset (Anthropic emits
		// exactly that for an idle-but-live 5h window). An explicit `null` means the
		// window does not exist (Codex retired its 5h window) → render nothing. Only
		// an omitted key falls back to the legacy most-restrictive-window display.
		if (anthropicData?.five_hour) {
			usages.push({
				utilization: anthropicData.five_hour.utilization,
				window: "five_hour",
				resetTime: anthropicData.five_hour.resets_at,
			});
		} else if (anthropicData?.five_hour === undefined) {
			// Legacy fallback: key omitted → use the most restrictive window data.
			usages.push({
				utilization: usageUtilization ?? null,
				window: "five_hour",
				resetTime: resetIso,
			});
		}
		// else five_hour === null → Codex retired window, push nothing.

		// Check if seven_day data exists and has valid utilization
		if (
			anthropicData?.seven_day &&
			anthropicData.seven_day.utilization !== null &&
			anthropicData.seven_day.utilization !== undefined
		) {
			usages.push({
				utilization: anthropicData.seven_day.utilization,
				window: "seven_day",
				resetTime: anthropicData.seven_day.resets_at,
			});
		} else {
			// Add weekly usage as placeholder if data is not available
			usages.push({
				utilization: null,
				window: "seven_day",
				resetTime: null,
			});
		}

		// Model-specific weekly windows (e.g. "Fable") always render as their own
		// secondary cards when the payload carries them.
		for (const limit of getScopedWeeklyLimits(usageData)) {
			usages.push({
				utilization: limit.utilization,
				window: "seven_day_scoped",
				resetTime: limit.resetsAt,
				label: limit.label,
			});
		}

		// Families the pool reports that THIS account's payload names no window
		// for, or names only an idle one (0%, no reset): Anthropic states an
		// untouched family either way until its first use in the week, so this is
		// a fact about the account rather than a gap.
		//
		// Availability (paused, cooling down) is deliberately NOT a condition: the
		// row states what this account's own reading says, and a paused account
		// already renders all its other windows. The family-card COUNT uses the
		// serving rule instead, because it answers a different question.
		const normalized = normalizeAnthropicUsage(
			usageData as AnthropicUsageData,
			now,
		);
		const classId = servableClassFor(provider).classId;
		for (const family of poolScopedFamilies ?? []) {
			// `weeklyScopedPresent` covers every entry that resolves to a family,
			// including ones `getScopedWeeklyLimits` kept and the normalizer dropped
			// (an unparseable `resets_at`). Those classify as unreadable, so the
			// ordinary percent card and this row can never render together for one
			// family. `weeklyScopedIdle` is the narrower set whose entry states no
			// usage this week (0%, no reset); `getScopedWeeklyLimits` drops those
			// for want of a reset, so the unopened row is the only one they emit.
			const evidence = classifyScopedFamilyEvidence({
				readings: normalized.weeklyScoped,
				presentFamilies: new Set(normalized.weeklyScopedPresent),
				idleFamilies: new Set(normalized.weeklyScopedIdle),
				family: family.family,
				accountWideWeeklyResetMs: normalized.weeklyAll?.resetMs ?? null,
				classId,
				// The caller supplies only the families this account's own class
				// reports, so reaching this loop is itself the class evidence.
				reportingClasses: new Set([classId]),
				now,
			});
			if (evidence !== "unopened") continue;
			usages.push({
				utilization: null,
				window: "seven_day_scoped",
				resetTime: null,
				label: family.displayName,
				state: "unopened",
			});
		}
	} else if (
		providerShowsWeeklyUsage(provider) &&
		usageUtilization !== null &&
		usageUtilization !== undefined &&
		usageWindow
	) {
		// Fallback: show only the most restrictive window
		usages.push({
			utilization: usageUtilization,
			window: usageWindow,
			resetTime: resetIso,
		});
	} else {
		// Use time-based percentage for non-Anthropic or when no usage data is available
		const percentage = Math.min(
			100,
			Math.max(0, ((now - (resetTime - WINDOW_MS)) / WINDOW_MS) * 100),
		);
		usages.push({
			utilization: percentage as number | null,
			window: null,
			resetTime: resetIso,
		});
	}

	return { kind: "windows", usages };
}

/** Heading a usage window renders under. */
export function usageWindowLabel(usage: UsageDisplay): string {
	if (usage.label != null) return usage.label;
	if (!usage.window) return "Rate limit";
	switch (usage.window) {
		case "five_hour":
			return "5-hour";
		case "seven_day":
			return "Weekly";
		case "seven_day_opus":
			return "Opus (Weekly)";
		case "seven_day_sonnet":
			return "Sonnet (Weekly)";
		case "seven_day_scoped":
			return "Weekly";
		case "daily":
			return "Daily";
		case "weekly":
			return "Weekly";
		case "monthly":
			return "Monthly";
		case "time_limit":
			return "Time Quota";
		case "tokens_limit":
			return "5-hour";
		default:
			return usage.window.replace("_", " ");
	}
}

/**
 * Identity of the reset *category* a window belongs to, for comparing the same
 * kind of window across accounts ("which account's 5-hour window resets next?").
 *
 * Keyed off the rendered HEADING, not the raw window name, because several
 * provider-specific names render as one heading — Anthropic's `five_hour` and
 * Zai's `tokens_limit` both read "5-hour", Alibaba's `weekly` and Anthropic's
 * `seven_day` both read "Weekly". Keying on the raw name would put two cards
 * the user sees as the same window into two categories of one each, and a
 * category of one is never marked, so the comparison would silently do nothing
 * on exactly the mixed-provider pool it exists for.
 *
 * Scoped weekly windows are the one exception: they carry their own display
 * name, and are grouped by model family so an account reporting "Fable" and one
 * reporting a sibling name of the same family land in one category. A name that
 * resolves to no known family (Codex's synthetic per-model windows) keeps its
 * own label as the key.
 */
export function usageWindowCategoryKey(usage: UsageDisplay): string {
	if (usage.label != null)
		return `scoped:${getModelFamily(usage.label) ?? usage.label.toLowerCase()}`;
	return `window:${usageWindowLabel(usage).toLowerCase()}`;
}

export interface WindowResetExtremes {
	/** Earliest still-future reset in each cross-account window category. */
	earliest: Map<string, number>;
	/** Latest still-future reset in each cross-account window category. */
	latest: Map<string, number>;
}

/**
 * For each reset category, the earliest and latest still-future resets across
 * the given accounts — but only where at least two accounts have one. A
 * category only one account reports has no useful cross-account comparison;
 * highlighting its sole card would make every singleton look exceptional.
 *
 * Keys are {@link usageWindowCategoryKey} values, values are epoch ms. Pass the
 * accounts that actually render, in the same shape they render with (notably
 * the same `showWeekly`), or an endpoint may belong to a window nobody can see.
 */
export function computeWindowResetExtremes(
	sources: readonly UsageCardSource[],
	now: number,
): WindowResetExtremes {
	const earliest = new Map<string, number>();
	const latest = new Map<string, number>();
	const counts = new Map<string, number>();
	for (const source of sources) {
		const card = classifyUsageCard(source, now);
		if (card.kind !== "windows") continue;
		// One account can only hold one candidate per category. Anthropic's
		// scoped-weekly list can legitimately carry two entries of the same family
		// (e.g. a renamed sibling model), and counting both would fake a
		// cross-account comparison out of a single account's payload.
		const seenHere = new Set<string>();
		for (const usage of card.usages) {
			if (!usage.resetTime) continue;
			const resetMs = new Date(usage.resetTime).getTime();
			if (!Number.isFinite(resetMs) || resetMs <= now) continue;
			const key = usageWindowCategoryKey(usage);
			if (!seenHere.has(key)) {
				seenHere.add(key);
				counts.set(key, (counts.get(key) ?? 0) + 1);
			}
			const currentEarliest = earliest.get(key);
			if (currentEarliest === undefined || resetMs < currentEarliest) {
				earliest.set(key, resetMs);
			}
			const currentLatest = latest.get(key);
			if (currentLatest === undefined || resetMs > currentLatest) {
				latest.set(key, resetMs);
			}
		}
	}
	for (const [key, count] of counts) {
		if (count < 2) {
			earliest.delete(key);
			latest.delete(key);
		}
	}
	return { earliest, latest };
}

/**
 * Backwards-compatible convenience for consumers that only need the first
 * reset. New comparison UIs should use {@link computeWindowResetExtremes} so
 * the first and last endpoints are derived from the exact same candidate set.
 */
export function computeSoonestWindowResets(
	sources: readonly UsageCardSource[],
	now: number,
): Map<string, number> {
	return computeWindowResetExtremes(sources, now).earliest;
}
