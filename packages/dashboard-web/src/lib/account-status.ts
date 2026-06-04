import type { AccountResponse } from "@clankermux/types";
import { AccountPresenter } from "@clankermux/ui-common";
import { isAnthropicPeakHour, isZaiPeakHour } from "../utils/provider-utils";

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

	return {
		isPrimary: account.isPrimary,
		priority: account.priority,
		hasRefreshToken: account.hasRefreshToken,
		isRateLimited: presenter.isRateLimited,
		isPaused,
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
	};
}
