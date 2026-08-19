import {
	ACCOUNT_WIDE_HARD_STATUSES,
	isReauthDueSoon as isReauthDueSoonShared,
} from "@clankermux/core";
import type {
	AccountResponse,
	RateLimitCause,
	UsageExhaustionBinding,
} from "@clankermux/types";
import { HARD_RATE_LIMIT_CAUSES } from "@clankermux/types";
import { AccountPresenter } from "@clankermux/ui-common";
import { isZaiPeakHour } from "../utils/provider-utils";
import { computeRenewal, type RenewalUrgency } from "./renewal";
import { getExhaustedScopedFamilies } from "./secondary-limits";

/**
 * Only these hard-limit statuses mean the account is actually blocked; soft
 * warnings like "allowed_warning" / "queueing_soft" mean it is still usable.
 * Shared vocabulary from `@clankermux/core`; matched as a prefix because the
 * API appends a `(Nm)` countdown to the status string.
 */
const HARD_LIMIT_PREFIXES = [...ACCOUNT_WIDE_HARD_STATUSES];

/** Urgency of the soonest-expiring available Codex usage-reset credit. */
export type ResetCreditUrgency = "none" | "soon" | "imminent";

/** Soonest available reset credit expires in under this → "imminent" (red). */
export const RESET_CREDIT_IMMINENT_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

/** Soonest available reset credit expires in under this → "soon" (amber). */
export const RESET_CREDIT_SOON_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Display-ready status flags derived from an account. This is the single source
 * of truth for the per-account status chips shown on both the Accounts page
 * (`AccountListItem`) and the Limits page (`AccountUtilizationCard`); both render
 * them via `AccountStatusChips`. Pure and side-effect free so it can be unit
 * tested with an injected `now`.
 */
export interface AccountStatus {
	/** True if the load balancer would pick this account next. */
	isPrimary: boolean;
	/** Routing priority (lower = higher priority). */
	priority: number;
	/** OAuth account — drives the token-health icon's visibility. */
	hasRefreshToken: boolean;
	/** Account is rate-limited right now (drives the bare warning icon). */
	isRateLimited: boolean;
	/** Account is paused. */
	isPaused: boolean;
	/** Auto-paused because the provider reports the subscription lapsed. */
	isSubscriptionExpired: boolean;
	/**
	 * Auto-paused because the OAuth refresh token was rejected (`invalid_grant`).
	 * Terminal — requires re-authentication; auto-resumes once reauth succeeds.
	 */
	isNeedsReauth: boolean;
	/**
	 * Epoch ms at which the OAuth refresh token expires and the account will
	 * need a human re-auth; null when the provider reports no deadline.
	 */
	reauthDeadlineMs: number | null;
	/**
	 * The refresh token expires soon enough to act on. Deliberately independent
	 * of {@link AccountStatus.isNeedsReauth}, which means the deadline has
	 * already been missed and the account is paused — this one is the warning
	 * that still leaves time to do something about it.
	 */
	isReauthDueSoon: boolean;
	/**
	 * Whole days until {@link AccountStatus.reauthDeadlineMs}, rounded UP so the
	 * last partial day still reads as a day left; 0 once the deadline is inside
	 * 24 hours, negative once it has passed, null when there is no deadline.
	 *
	 * Derived here rather than in the chip so the countdown and the warning that
	 * gates it read the same clock — a component formatting from `Date.now()`
	 * would silently ignore the `now` this function was given.
	 */
	reauthDaysRemaining: number | null;
	/** Unified rate-limit status string, e.g. "rate_limited (30m)" or "OK". */
	rateLimitStatus: string;
	/** Normalized rate-limit cause from the API; null on legacy payloads. */
	rateLimitCause: RateLimitCause | null;
	/** Epoch ms when the cause clears; null when unknown. */
	rateLimitCauseResetMs: number | null;
	/**
	 * Which account-wide window drove a `usage_exhausted` cause (a `weekly`
	 * window or the rolling 5-hour `session`); null for every other cause and on
	 * payloads from servers that predate the field.
	 */
	rateLimitCauseBinding: UsageExhaustionBinding | null;
	/** Raw provider status behind the cause (may be an unrecognized value). */
	rateLimitProviderStatus: string | null;
	/**
	 * An ACCOUNT-WIDE usage window is spent — a weekly one or the rolling 5-hour
	 * session (blocked, but self-healing). `rateLimitCauseBinding` says which.
	 */
	isUsageExhausted: boolean;
	/** Whether to render the colored RateLimitStatusChip (non-paused, non-OK). */
	showRateLimitChip: boolean;
	/** DB rate-limit lock is set but usage data shows capacity (< 100%). */
	staleLockDetected: boolean;
	/** Proactive usage throttling is delaying requests right now. */
	isUsageThrottled: boolean;
	/** Provider-wide overload cooldown end (ms epoch) if active, else null. */
	providerOverloadedUntil: number | null;
	/** Whole minutes left on the provider-wide overload cooldown (min 1), else null. */
	providerOverloadMinutes: number | null;
	/** Provider-wide breaker is half-open: cooldown elapsed, recovery probe pending/running. */
	isProviderProbing: boolean;
	/**
	 * Family-scoped OPEN overload buckets (e.g. a Haiku-only 529 storm), sorted
	 * by family name. Other families keep routing to the account, so these render
	 * as their own chips instead of the provider-wide one.
	 */
	overloadedFamilies: Array<{ family: string; until: number; minutes: number }>;
	/** Family-scoped half-open buckets: cooldown elapsed, recovery probe pending/running. */
	probingFamilies: string[];
	/**
	 * Model families whose SCOPED weekly quota is exhausted (e.g. Fable at 100%)
	 * while the account itself stays routable for other families — a warning
	 * chip, never a blocking state and never a Force Reset offer. Suppressed
	 * while the ACCOUNT-WIDE weekly-exhaustion chip already shows (no double
	 * chip); kept during a 5h session exhaustion, which is different
	 * information. Soonest reset first; `familyKey` is the stable dedup key.
	 */
	exhaustedScopedFamilies: Array<{
		familyKey: string;
		label: string;
		resetsAtMs: number;
		hoursLeft: number;
	}>;
	/** Provider has peak / off-peak windows (zai only). */
	showPeakChip: boolean;
	/** Currently within the provider's peak window. */
	isPeak: boolean;
	/** Label for the peak / off-peak chip. Only meaningful when `showPeakChip` is true. */
	peakChipLabel: string;
	/** Account is hard-limited by status (rate_limited / blocked / ...). */
	isHardLimited: boolean;
	/** Legacy `rateLimitedUntil` lock is still in the future. */
	isBlockedByLegacyLock: boolean;
	/** Whether to offer the Force Reset action (Accounts page only). */
	showForceReset: boolean;
	/** Next subscription renewal date (local), or null when no anchor is set. */
	renewalNextDate: Date | null;
	/** Whole local-calendar days until renewal; negative if past, null when unset. */
	renewalDaysLeft: number | null;
	/** Renewal urgency level driving the chip color. */
	renewalUrgency: RenewalUrgency;
	/**
	 * Whether to render the renewal chip. False when no anchor is set, and also
	 * suppressed while `isSubscriptionExpired` — real provider state (OAuth
	 * refused) dominates static, unverified renewal metadata, so we don't show a
	 * reassuring renewal chip next to the red "Subscription expired" badge.
	 */
	showRenewalChip: boolean;
	/** Codex account is on purchased credits past its weekly limit (real spend). */
	isOnCredits: boolean;
	/** Remaining credit balance (unverified units), null when unknown/unlimited. */
	creditsBalance: number | null;
	/** Codex plan tier, e.g. "prolite". Null when unknown. */
	creditsPlanType: string | null;
	/**
	 * Available (unredeemed, unexpired) Codex usage-reset credit expiries,
	 * soonest first. Empty when there are none or expiry detail is unavailable.
	 */
	resetCreditAvailableExpiries: Date[];
	/** Soonest available reset-credit expiry, or null when none. */
	resetCreditNextExpiry: Date | null;
	/** Urgency of the soonest available reset-credit expiry (drives chip color). */
	resetCreditUrgency: ResetCreditUrgency;
	/** Per-account auto-apply of expiring reset credits is enabled (opt-in). */
	resetCreditAutoApplyArmed: boolean;
	/** Per-account auto-apply of a reset credit at the weekly limit is enabled (opt-in). */
	resetCreditAutoApplyOnWeeklyLimitArmed: boolean;
	/** Account shares a provider identity (external id / email) with another account. */
	isDuplicateAccount: boolean;
	/** Ids of the other accounts this account duplicates (empty when not a duplicate). */
	duplicateAccountIds: string[];
}

/**
 * Derive the per-account status flags used to render the status chips. `now` is
 * injectable for deterministic tests; it defaults to the current time.
 */
export function deriveAccountStatus(
	account: AccountResponse,
	now: number = Date.now(),
): AccountStatus {
	const presenter = new AccountPresenter(account);
	const isPaused = presenter.isPaused;
	const isSubscriptionExpired =
		isPaused && account.pauseReason === "subscription_expired";
	const isNeedsReauth =
		isPaused && account.pauseReason === "oauth_invalid_grant";
	const parsedReauthDeadline = account.refreshTokenExpiresAt
		? Date.parse(account.refreshTokenExpiresAt)
		: Number.NaN;
	const reauthDeadlineMs = Number.isNaN(parsedReauthDeadline)
		? null
		: parsedReauthDeadline;
	// Suppressed once the account is already paused for reauth: at that point the
	// deadline has passed and the terminal chip is the accurate one, so showing
	// both would just be the same fact twice in two tenses.
	const isReauthDueSoon =
		!isNeedsReauth && isReauthDueSoonShared(reauthDeadlineMs, now);
	const reauthDaysRemaining =
		reauthDeadlineMs === null
			? null
			: Math.ceil((reauthDeadlineMs - now) / (24 * 60 * 60 * 1000));
	const rateLimitStatus = presenter.rateLimitStatus;

	// Prefer the API's structured cause; fall back to prefix-matching the display
	// string for legacy payloads that predate the structured fields.
	const rateLimitCause = account.rateLimitCause ?? null;
	const isUsageExhausted = rateLimitCause === "usage_exhausted";
	const isHardLimited = rateLimitCause
		? HARD_RATE_LIMIT_CAUSES.has(rateLimitCause)
		: HARD_LIMIT_PREFIXES.some((prefix) =>
				rateLimitStatus.toLowerCase().startsWith(prefix),
			);
	// Also show Force Reset when rateLimitedUntil is in the future even if the
	// status is soft/OK — the selector still skips the account.
	const isBlockedByLegacyLock =
		typeof account.rateLimitedUntil === "number" &&
		account.rateLimitedUntil > now;
	// A usage-exhausted account's lock is legitimate (whichever account-wide
	// window bound): force-resetting it only lets the router burn fresh 429s
	// against a window that is spent right now,
	// so the action is suppressed. (If the provider releases the window early,
	// usage polling observes it and clears the lock without an operator action.)
	const showForceReset =
		(isHardLimited || isBlockedByLegacyLock) && !isPaused && !isUsageExhausted;
	// staleLockDetected only fires when numeric usage data exists (Anthropic
	// accounts); Zai accounts have usageUtilization === null and are excluded.
	const staleLockDetected =
		showForceReset &&
		typeof account.usageUtilization === "number" &&
		account.usageUtilization < 100;
	const isUsageThrottled =
		typeof account.usageThrottledUntil === "number" &&
		account.usageThrottledUntil > now;
	// Overload breaker state. When the structured family-scoped field is present
	// (newer servers), the generic chip is driven by the PROVIDER-WIDE bucket
	// only and family buckets get their own chips; the legacy scalar (max across
	// all buckets) is the fallback for older servers that don't send the field.
	const overloadBuckets = account.providerOverload ?? null;
	let providerOverloadedUntil: number | null = null;
	let isProviderProbing = false;
	const overloadedFamilies: Array<{
		family: string;
		until: number;
		minutes: number;
	}> = [];
	const probingFamilies: string[] = [];
	if (overloadBuckets) {
		for (const bucket of overloadBuckets) {
			const isOpen =
				bucket.state === "open" &&
				typeof bucket.until === "number" &&
				bucket.until > now;
			if (bucket.family === null) {
				if (isOpen && bucket.until !== null) {
					providerOverloadedUntil = bucket.until;
				} else if (bucket.state === "half-open") {
					isProviderProbing = true;
				}
			} else if (isOpen && bucket.until !== null) {
				overloadedFamilies.push({
					family: bucket.family,
					until: bucket.until,
					minutes: Math.max(1, Math.ceil((bucket.until - now) / 60000)),
				});
			} else if (bucket.state === "half-open") {
				probingFamilies.push(bucket.family);
			}
		}
		overloadedFamilies.sort((a, b) => a.family.localeCompare(b.family));
		probingFamilies.sort((a, b) => a.localeCompare(b));
	} else {
		providerOverloadedUntil =
			typeof account.providerOverloadedUntil === "number" &&
			account.providerOverloadedUntil > now
				? account.providerOverloadedUntil
				: null;
	}
	const providerOverloadMinutes = providerOverloadedUntil
		? Math.max(1, Math.ceil((providerOverloadedUntil - now) / 60000))
		: null;

	// Family-weekly exhaustion chips. Suppressed while the account-wide
	// weekly-exhaustion chip is showing (binding "weekly", or legacy payloads
	// with no binding) — one exhaustion story at a time; a SESSION (5h) binding
	// is different information, so the scoped chips stay.
	const suppressScopedFamilies =
		isUsageExhausted && account.rateLimitCauseBinding !== "session";
	const exhaustedScopedFamilies = suppressScopedFamilies
		? []
		: getExhaustedScopedFamilies(account.usageData, now).map((entry) => ({
				familyKey: entry.familyKey,
				label: entry.label,
				resetsAtMs: entry.resetsAtMs,
				hoursLeft: Math.max(1, Math.ceil((entry.resetsAtMs - now) / 3_600_000)),
			}));

	// Peak / off-peak status. Only zai has a peak-hour window. Anthropic briefly
	// drained 5h sessions faster on weekdays 5–11am PT (announced ~2026-03-27),
	// but removed that reduction on 2026-05-06 alongside doubling the Claude Code
	// 5h limits — so anthropic accounts get no peak chip.
	const showPeakChip = account.provider === "zai";
	const isPeak = showPeakChip && isZaiPeakHour(now);
	const peakChipLabel = isPeak
		? "Peak hours (14:00–18:00 SGT)"
		: "Off-peak hours";

	const renewal = computeRenewal(
		account.renewalAnchor,
		account.renewalCadence,
		now,
	);

	// On-credits predicate — mirrors the server's exactly so the chip and the
	// pause/failover logic agree on when a codex account is drawing on purchased
	// credits past its weekly limit (real spend).
	const c = account.codexCredits;
	const isOnCredits =
		account.provider === "codex" &&
		!!c &&
		c.hasCredits &&
		!c.unlimited &&
		c.weeklyUsedPct !== null &&
		c.weeklyUsedPct >= 100;
	// Both only consumed by the chip, which renders only when isOnCredits — gate
	// them together so neither surfaces a stale value outside that state.
	const creditsBalance = isOnCredits ? (c?.balance ?? null) : null;
	const creditsPlanType = isOnCredits ? (c?.planType ?? null) : null;

	// Codex usage-reset credits: soonest available future expiry drives the
	// urgency coloring of the usage-reset chip. Expired or non-available
	// (redeeming/redeemed/unknown) credits never contribute.
	const resetCreditAvailableExpiries = (
		account.codexRateLimitResetCredits?.credits ?? []
	)
		.flatMap((credit) => {
			if (credit.status !== "available" || credit.expiresAt === null) {
				return [];
			}
			const date = new Date(credit.expiresAt);
			return date.getTime() > now ? [date] : [];
		})
		.sort((a, b) => a.getTime() - b.getTime());
	const resetCreditNextExpiry = resetCreditAvailableExpiries[0] ?? null;
	let resetCreditUrgency: ResetCreditUrgency = "none";
	if (resetCreditNextExpiry) {
		const msLeft = resetCreditNextExpiry.getTime() - now;
		if (msLeft < RESET_CREDIT_IMMINENT_THRESHOLD_MS) {
			resetCreditUrgency = "imminent";
		} else if (msLeft < RESET_CREDIT_SOON_THRESHOLD_MS) {
			resetCreditUrgency = "soon";
		}
	}
	const resetCreditAutoApplyArmed =
		account.autoApplyResetCreditsEnabled === true;
	const resetCreditAutoApplyOnWeeklyLimitArmed =
		account.autoApplyResetOnWeeklyLimitEnabled === true;

	return {
		isPrimary: account.isPrimary,
		priority: account.priority,
		hasRefreshToken: account.hasRefreshToken,
		isRateLimited: presenter.isRateLimited,
		isPaused,
		isSubscriptionExpired,
		isNeedsReauth,
		reauthDeadlineMs,
		isReauthDueSoon,
		reauthDaysRemaining,
		rateLimitStatus,
		rateLimitCause,
		rateLimitCauseResetMs: account.rateLimitCauseResetMs ?? null,
		rateLimitCauseBinding: account.rateLimitCauseBinding ?? null,
		rateLimitProviderStatus: account.rateLimitProviderStatus ?? null,
		isUsageExhausted,
		showRateLimitChip:
			!isPaused &&
			(rateLimitCause ? rateLimitCause !== "ok" : rateLimitStatus !== "OK"),
		staleLockDetected,
		isUsageThrottled,
		providerOverloadedUntil,
		providerOverloadMinutes,
		isProviderProbing,
		overloadedFamilies,
		probingFamilies,
		exhaustedScopedFamilies,
		showPeakChip,
		isPeak,
		peakChipLabel,
		isHardLimited,
		isBlockedByLegacyLock,
		showForceReset,
		renewalNextDate: renewal.nextDate,
		renewalDaysLeft: renewal.daysLeft,
		renewalUrgency: renewal.urgency,
		showRenewalChip: renewal.nextDate !== null && !isSubscriptionExpired,
		isOnCredits,
		creditsBalance,
		creditsPlanType,
		resetCreditAvailableExpiries,
		resetCreditNextExpiry,
		resetCreditUrgency,
		resetCreditAutoApplyArmed,
		resetCreditAutoApplyOnWeeklyLimitArmed,
		isDuplicateAccount: account.isDuplicateAccount,
		duplicateAccountIds: account.duplicateAccountIds ?? [],
	};
}
