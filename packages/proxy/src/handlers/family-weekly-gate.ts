import {
	getExhaustedFamilies,
	getModelFamily,
	isFamilyWeeklyExhaustedWithHeadroom,
	type ModelFamily,
} from "@clankermux/core";
import type { AnyUsageData } from "@clankermux/providers";
import type {
	Account,
	AnthropicUsageData,
	CapacitySignal,
} from "@clankermux/types";

/** Fallback Retry-After (seconds) when no usable family reset time is known. */
const RETRY_AFTER_FALLBACK_SECONDS = 60;

/**
 * Max age of cached usage data the family-weekly gate will trust (2× the 90s
 * default usage poll interval, matching `ensureUsageFreshForSelection`). Older
 * than this, `getFreshCapacity` returns null and the gate fails open. A plain
 * constant (not a config knob) keeps this off the request hot path and out of
 * every proxy test's ctx.config mock.
 */
export const FAMILY_WEEKLY_MAX_USAGE_AGE_MS = 180_000;

/**
 * An Anthropic account excluded from serving a request because the request's
 * model family has exhausted its weekly quota, while the account still has
 * unified (5h/7d) headroom for other families.
 */
export interface FamilyWeeklyExcludedAccount {
	account: Account;
	/** The requested model family that is weekly-exhausted on this account. */
	family: ModelFamily;
	/** Epoch ms at which the family's weekly window resets. */
	resetAt: number;
}

/**
 * Pure per-account decision for the proactive family-weekly gate.
 *
 * Returns an exclusion (carrying the family reset time) when the account's
 * requested model family is weekly-exhausted AND the account still has unified
 * headroom for other families; otherwise returns null (keep the account).
 *
 * Fails open: an unresolved family, or null/stale/malformed capacity, yields
 * null — this gate must never be the thing that sidelines an account on missing
 * evidence (the account-wide cooldown path remains the fallback). Non-Anthropic
 * usage data is handled safely because `getExhaustedFamilies` runs it through
 * `normalizeAnthropicUsage`, which returns an empty scoped list for any shape it
 * doesn't recognize — so the cast below is safe.
 */
export function resolveFamilyWeeklyExclusion(
	account: Account,
	modelForGate: string | null,
	usageData: AnyUsageData | null,
	capacity: CapacitySignal | null,
	now: number,
): FamilyWeeklyExcludedAccount | null {
	const family = modelForGate ? getModelFamily(modelForGate) : null;
	if (!family) return null;
	// `getExhaustedFamilies` normalizes any shape and yields [] for non-Anthropic
	// data, so this cast is safe — mirrors dashboard-web/src/lib/secondary-limits.ts.
	const data = (usageData ?? undefined) as AnthropicUsageData | undefined;
	if (!isFamilyWeeklyExhaustedWithHeadroom(data, capacity, family, now)) {
		return null;
	}
	// The predicate above guarantees a matching exhausted entry exists; fall back
	// defensively to `now` so a non-finite reset can never poison Retry-After.
	const match = getExhaustedFamilies(data, now).find(
		(e) => e.family === family,
	);
	return { account, family, resetAt: match?.resetsAtMs ?? now };
}

/**
 * A family-capable sibling that is temporarily rate-limited (transient cooldown),
 * passed to the terminal so `Retry-After` reflects its short recovery rather than
 * the multi-day family window. See {@link resolveTransientlyCooledFamilySibling}.
 */
export interface TransientSiblingCooldown {
	/** The cooling sibling's display name (for the human-readable message). */
	name: string;
	/** Epoch ms at which the sibling recovers. */
	availableAt: number;
}

/**
 * Build the fail-clean 429 returned when every candidate account's requested
 * model family is weekly-exhausted. `Retry-After` is derived from the soonest
 * family reset across the excluded accounts (falling back to a fixed default
 * when no finite future reset is known).
 *
 * When a `transientSibling` is supplied (a family-capable account momentarily
 * unavailable ONLY due to a short cooldown), its recovery — not the family
 * window — is the real wait: `Retry-After` and the message reflect the cooldown,
 * and the pool-status header is `family-weekly-sibling-cooldown`. Passing no
 * `transientSibling` preserves the original genuinely-exhausted behavior exactly.
 */
export function createFamilyWeeklyExhaustedResponse(
	excluded: FamilyWeeklyExcludedAccount[],
	family: ModelFamily,
	requestModel: string | null,
	now: number,
	transientSibling?: TransientSiblingCooldown | null,
): Response {
	const soonestReset = excluded.reduce(
		(min, e) => (e.resetAt < min ? e.resetAt : min),
		Number.POSITIVE_INFINITY,
	);
	const hasFutureReset = Number.isFinite(soonestReset) && soonestReset > now;
	const resetIso = hasFutureReset ? new Date(soonestReset).toISOString() : null;
	const names = excluded.map((e) => e.account.name).join(", ");

	// A family-capable sibling on a transient cooldown drives Retry-After (and the
	// message) when its recovery is a finite future time — otherwise fall through
	// to the family-window / default behavior.
	const siblingCooldownMs =
		transientSibling &&
		Number.isFinite(transientSibling.availableAt) &&
		transientSibling.availableAt > now
			? transientSibling.availableAt
			: null;

	let retryAfterSeconds: number;
	let message: string;
	let poolStatus: string;
	if (siblingCooldownMs !== null && transientSibling) {
		retryAfterSeconds = Math.max(
			1,
			Math.ceil((siblingCooldownMs - now) / 1000),
		);
		poolStatus = "family-weekly-sibling-cooldown";
		message =
			`The only account(s) with weekly "${family}" quota are temporarily ` +
			`rate-limited (e.g. "${transientSibling.name}"); retry in ` +
			`${retryAfterSeconds}s. Account(s) with this family's weekly quota ` +
			`exhausted: ${names}${resetIso ? ` (reset at ${resetIso})` : ""}.`;
	} else {
		retryAfterSeconds = hasFutureReset
			? Math.max(1, Math.ceil((soonestReset - now) / 1000))
			: RETRY_AFTER_FALLBACK_SECONDS;
		poolStatus = "family-weekly-exhausted";
		message =
			`All available accounts have exhausted their weekly "${family}" quota ` +
			`(account(s): ${names})${resetIso ? `; soonest reset at ${resetIso}` : ""}. ` +
			`Other model families on these accounts are unaffected.`;
	}

	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "rate_limit_error",
				message,
				request_model: requestModel,
				family,
				excluded_accounts: excluded.map((e) => ({
					name: e.account.name,
					resets_at: Number.isFinite(e.resetAt)
						? new Date(e.resetAt).toISOString()
						: null,
				})),
			},
		}),
		{
			status: 429,
			headers: {
				"Content-Type": "application/json",
				"Retry-After": String(retryAfterSeconds),
				"x-clankermux-pool-status": poolStatus,
			},
		},
	);
}

/**
 * A family-capable Anthropic account that is momentarily out of the candidate
 * pool ONLY because of a transient cooldown (a per-account 429 `rate_limited_until`
 * or a provider-wide 529 overload) — NOT because its own weekly quota for the
 * requested family is spent. When the family-weekly terminal is about to fire,
 * such a sibling means the real wait is its short cooldown, not the requested
 * family's multi-day reset.
 */
export interface TransientlyCooledFamilySibling {
	account: Account;
	/** The requested model family this sibling still has weekly quota for. */
	family: ModelFamily;
	/**
	 * Epoch ms at which the sibling becomes serveable again — the MAX of its two
	 * cooldown deadlines, since it is available only once BOTH have cleared.
	 */
	availableAt: number;
}

/**
 * Pure decision: is `account` a family-capable Anthropic sibling worth holding
 * for rather than returning a misleading family-weekly-exhausted 429?
 *
 * Returns the sibling (with its `availableAt`) when ALL hold:
 *  - it is a non-paused Anthropic account,
 *  - it is currently unavailable due to a transient cooldown (`rateLimitedUntil`
 *    and/or `providerOverloadUntil` in the future), and
 *  - it still HAS weekly quota for `family` (the family is NOT in its exhausted
 *    set — positive evidence of exhaustion is required to reject it).
 * Otherwise returns null.
 *
 * Fails toward holding: missing/stale usage data yields an empty exhausted set,
 * so the sibling is treated as capable — a brief bounded hold then re-checks on
 * retry, which is safer than surfacing a 5-day error for a 60-second blip. The
 * caller supplies `now` and both cooldown deadlines to keep this pure (no clock,
 * no provider-overload-module import). `getExhaustedFamilies` normalizes any
 * shape and yields [] for non-Anthropic data, so the cast below is safe.
 */
export function resolveTransientlyCooledFamilySibling(
	account: Account,
	family: ModelFamily,
	usageData: AnyUsageData | null,
	rateLimitedUntil: number | null | undefined,
	providerOverloadUntil: number | null,
	now: number,
): TransientlyCooledFamilySibling | null {
	if (account.provider !== "anthropic") return null;
	if (account.paused) return null;

	const rl =
		rateLimitedUntil != null && rateLimitedUntil > now ? rateLimitedUntil : 0;
	const ov =
		providerOverloadUntil != null && providerOverloadUntil > now
			? providerOverloadUntil
			: 0;
	const availableAt = Math.max(rl, ov);
	// Not on a transient cooldown — this account isn't the reason the pool emptied,
	// so there is nothing to hold for here.
	if (availableAt <= now) return null;

	const data = (usageData ?? undefined) as AnthropicUsageData | undefined;
	const familyExhausted = getExhaustedFamilies(data, now).some(
		(e) => e.family === family,
	);
	// The family's own weekly quota IS spent on this account — waiting for the
	// cooldown would just surface the family wall again; it is not a capable sibling.
	if (familyExhausted) return null;

	return { account, family, availableAt };
}
