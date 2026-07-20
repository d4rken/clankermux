import type { AccountResponse } from "@clankermux/types";
import { AccountPresenter } from "@clankermux/ui-common";
import { isAnthropicPeakHour, isZaiPeakHour } from "../utils/provider-utils";
import { computeRenewal, type RenewalUrgency } from "./renewal";

/**
 * Only these hard-limit statuses mean the account is actually blocked; soft
 * warnings like "allowed_warning" / "queueing_soft" mean it is still usable.
 */
const HARD_LIMIT_PREFIXES = [
	"rate_limited",
	"blocked",
	"queueing_hard",
	"payment_required",
];

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
	/** Unified rate-limit status string, e.g. "rate_limited (30m)" or "OK". */
	rateLimitStatus: string;
	/** Whether to render the colored RateLimitStatusChip (non-paused, non-OK). */
	showRateLimitChip: boolean;
	/** DB rate-limit lock is set but usage data shows capacity (< 100%). */
	staleLockDetected: boolean;
	/** Proactive usage throttling is delaying requests right now. */
	isUsageThrottled: boolean;
	/** Provider-overload cooldown end (ms epoch) if active, else null. */
	providerOverloadedUntil: number | null;
	/** Whole minutes left on the provider-overload cooldown (min 1), else null. */
	providerOverloadMinutes: number | null;
	/** Provider has peak / off-peak windows (zai, anthropic). */
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
	const rateLimitStatus = presenter.rateLimitStatus;

	const isHardLimited = HARD_LIMIT_PREFIXES.some((prefix) =>
		rateLimitStatus.toLowerCase().startsWith(prefix),
	);
	// Also show Force Reset when rateLimitedUntil is in the future even if the
	// status is soft/OK — the selector still skips the account.
	const isBlockedByLegacyLock =
		typeof account.rateLimitedUntil === "number" &&
		account.rateLimitedUntil > now;
	const showForceReset = (isHardLimited || isBlockedByLegacyLock) && !isPaused;
	// staleLockDetected only fires when numeric usage data exists (Anthropic
	// accounts); Zai accounts have usageUtilization === null and are excluded.
	const staleLockDetected =
		showForceReset &&
		typeof account.usageUtilization === "number" &&
		account.usageUtilization < 100;
	const isUsageThrottled =
		typeof account.usageThrottledUntil === "number" &&
		account.usageThrottledUntil > now;
	const providerOverloadedUntil =
		typeof account.providerOverloadedUntil === "number" &&
		account.providerOverloadedUntil > now
			? account.providerOverloadedUntil
			: null;
	const providerOverloadMinutes = providerOverloadedUntil
		? Math.max(1, Math.ceil((providerOverloadedUntil - now) / 60000))
		: null;

	// Peak / off-peak status. Only zai and anthropic have peak-hour windows.
	const isZaiPeak = account.provider === "zai" && isZaiPeakHour(now);
	const isAnthropicPeak =
		account.provider === "anthropic" && isAnthropicPeakHour(now);
	const showPeakChip =
		account.provider === "zai" || account.provider === "anthropic";
	const isPeak = isZaiPeak || isAnthropicPeak;
	const peakChipLabel = isPeak
		? account.provider === "zai"
			? "Peak hours (14:00–18:00 SGT)"
			: "Peak hours (5–11am PT, weekdays)"
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
		rateLimitStatus,
		showRateLimitChip: !isPaused && rateLimitStatus !== "OK",
		staleLockDetected,
		isUsageThrottled,
		providerOverloadedUntil,
		providerOverloadMinutes,
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
	};
}
