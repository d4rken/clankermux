import type { RateLimitReason } from "@clankermux/types";

export type ErrorSeverity = "warning" | "error";

export interface ErrorMeta {
	title: string;
	description: string;
	suggestion: string;
	severity: ErrorSeverity;
}

export interface ErrorContext {
	provider?: string | null;
	otherAccountsAvailable?: boolean;
}

const KNOWN_ERROR_META: Record<
	Exclude<RateLimitReason, "model_fallback_429">,
	ErrorMeta
> = {
	upstream_429_with_reset: {
		title: "Provider rate limit",
		description: "The upstream provider returned 429 with a known reset time.",
		suggestion: "The account will recover automatically at the reset time.",
		severity: "warning",
	},
	upstream_429_no_reset_probe_cooldown: {
		title: "Provider rate limit (no reset)",
		description:
			"The upstream provider returned 429 without a reset header; entering probe cooldown.",
		suggestion:
			"The account enters a short probe cooldown (about 60s), then the next request re-probes it automatically.",
		severity: "warning",
	},
	upstream_429_no_reset_default_5h: {
		title: "Provider rate limit (legacy 5h ban)",
		description:
			"Legacy ban from ccflare ≤ v3.5.x. No longer emitted by current code.",
		suggestion: "Historical record — no action needed.",
		severity: "warning",
	},
	all_models_exhausted_429: {
		title: "All fallback models rate-limited",
		description: "Every fallback model also returned 429.",
		suggestion: "Wait for cooldown, or add more diverse fallback models.",
		severity: "error",
	},
	// Both 529 entries are now LEGACY on every live Anthropic path. Since
	// 2026-07-21 an Anthropic 529 — HTTP status or mid-stream overloaded_error —
	// trips the family-scoped provider-overload breaker and applies NO per-account
	// cooldown, so neither reason is written for it any more. They survive for
	// rows recorded before that change, and for a 529 from a non-Anthropic
	// provider, which still takes the per-account path.
	upstream_529_overloaded_with_reset: {
		title: "Provider overload (legacy per-account cooldown)",
		description:
			"The upstream provider returned 529 (overloaded) with a Retry-After header, and the account was cooled down until that time. Current builds route Anthropic 529s to the family-scoped provider-overload breaker with no per-account cooldown, so this reason now appears only on rows written before 2026-07-21 or on a 529 from a non-Anthropic provider.",
		suggestion:
			"No action needed — the account recovers automatically at the provider's reset time, and traffic shifts to other configured accounts in the meantime.",
		severity: "warning",
	},
	upstream_529_overloaded_no_reset: {
		title: "Provider overload (legacy, no Retry-After)",
		description:
			"The upstream provider returned 529 (overloaded) without a Retry-After header, and the account entered a probe cooldown. Current builds route Anthropic 529s to the family-scoped provider-overload breaker with no per-account cooldown, so this reason now appears only on rows written before 2026-07-21 or on a 529 from a non-Anthropic provider.",
		suggestion:
			"No action needed — the account enters an escalating probe cooldown (starting around 30s) and the next request re-probes it automatically.",
		severity: "warning",
	},
	out_of_credits: {
		title: "Account out of credits",
		description:
			"Anthropic returned 429 with `overage-disabled-reason: out_of_credits` — the account's credits/overage allowance is depleted. A long cooldown (≥1h, or until the usage-window reset) is applied so fallback providers take over instead of storming the depleted account.",
		suggestion:
			"Top up the account's credits or increase its overage allowance. Until then, traffic shifts to other configured accounts automatically.",
		severity: "error",
	},
	weekly_exhausted_429: {
		title: "Weekly usage limit reached",
		description:
			"Anthropic returned 429 while this account's account-wide weekly window was already at 100% (confirmed by fresh usage data). The account is cooled down until the provider's reset time and traffic shifts to other accounts; the transparent burst-retry hold is skipped because re-probing the same spent window would only burn latency.",
		suggestion:
			"No action needed — the account recovers automatically when its weekly window resets, or earlier if usage polling sees the window recover before then. Add or prioritize another account if the whole pool is exhausted.",
		severity: "warning",
	},
	session_exhausted_429: {
		title: "5-hour usage limit reached",
		description:
			"Anthropic returned 429 while this account's 5-hour session window was already at 100% (confirmed by fresh usage data). The account is cooled down and traffic shifts to other accounts; the transparent burst-retry hold is skipped because re-probing the same spent window would only burn latency.",
		suggestion:
			"No action needed — the account recovers automatically when its 5-hour window resets, or earlier if usage polling sees the window recover before then.",
		severity: "warning",
	},
	family_weekly_exhausted_429: {
		title: "Model family weekly limit reached",
		description:
			"Anthropic returned 429 for a model family whose weekly quota is exhausted, while the account still has unified 5h/7d headroom. The request was failed over WITHOUT an account-wide cooldown, so the account stays available for other model families until this family's weekly window resets.",
		suggestion:
			"No action needed — other families on this account keep serving, and this family recovers at its weekly reset. Traffic for this family shifts to other accounts meanwhile.",
		severity: "warning",
	},
};

/**
 * Give-up terminals written by `handleProxy` when no account produced a
 * response. These are NOT `RateLimitReason` values — they are request-level
 * verdicts, one per request, whereas a `RateLimitReason` describes a single
 * attempt — so they need their own table rather than a widened one.
 *
 * They are here because the terminal label is the only durable record of WHY a
 * request was refused, and the two that look alike are the ones worth telling
 * apart: `all_accounts_failed` means the pool had nothing left, while
 * `model_not_served` means the pool was fine and the model was not.
 */
const KNOWN_TERMINAL_META: Record<string, ErrorMeta> = {
	model_not_served: {
		title: "Model rejected by every account attempted",
		description:
			"Each account the proxy reached rejected this model as outside its plan entitlement, and none of them was short of quota. Accounts that were unavailable at the time (paused, cooling down) were not attempted, so this does not prove the model is unserveable everywhere — only that nothing reachable would serve it.",
		suggestion:
			"Stop sending this model, or add an account on a plan that serves it. Retrying will not help while the same accounts are reachable.",
		severity: "error",
	},
	all_accounts_failed: {
		title: "No account could serve the request",
		description:
			"Every candidate account was attempted and none produced a response. Causes vary — rate limits, auth failures, upstream errors — and each attempt is recorded separately in Request History.",
		suggestion:
			"Check the individual attempt rows for this request to see what each account returned.",
		severity: "error",
	},
	pool_exhausted: {
		title: "Pool exhausted",
		description:
			"No account had quota left to serve the request at the moment it arrived.",
		suggestion:
			"Wait for the earliest window reset, or add capacity to the pool.",
		severity: "error",
	},
	oauth_tokens_expired: {
		title: "OAuth re-authentication likely needed",
		description:
			"The request failed with one or more OAuth accounts whose refresh token is past its maximum age. That age check is a heuristic, not a refresh attempt, so it names the likely cause rather than a confirmed one.",
		suggestion:
			"Re-authenticate the named accounts from the Accounts tab. An expired refresh token does not resolve on its own.",
		severity: "error",
	},
	pinned_target_unavailable: {
		title: "Pinned account unavailable",
		description:
			"The request was pinned to a specific account or class, and that target could not serve it. Pinning deliberately forbids failover, so no other account was tried.",
		suggestion:
			"Wait for the pinned account to recover, or remove the pin if any account will do.",
		severity: "error",
	},
	provider_overloaded: {
		title: "Provider overloaded",
		description:
			"The upstream provider is returning overload errors across the pool, and the shared cooldown was still open when this request arrived.",
		suggestion:
			"No action needed — the breaker half-opens and probes for recovery automatically.",
		severity: "warning",
	},
};

function getModelFallbackMeta(context?: ErrorContext): ErrorMeta {
	const provider = context?.provider ?? null;
	const otherAccountsAvailable = context?.otherAccountsAvailable;

	const isOAuthOnlyProvider = provider === "anthropic" || provider === "codex";

	const suggestion = isOAuthOnlyProvider
		? "No action needed — Claude/Codex accounts only serve their native models, so the proxy will use the next account until this one recovers."
		: 'To retry on the same account before failing over, open this account\'s More actions → Model Mappings and add comma-separated alternates (e.g. "primary, fallback-1").';

	const baseDescription =
		"This account hit a 429 with only one model configured, so the proxy failed over to the next account in priority order.";

	if (otherAccountsAvailable === false) {
		return {
			title: "Account rate-limited — no in-account fallback",
			description: `No other accounts are available — requests will fail until this account recovers. ${baseDescription}`,
			suggestion,
			severity: "error",
		};
	}

	return {
		title: "Account rate-limited — no in-account fallback",
		description: baseDescription,
		suggestion,
		severity: "warning",
	};
}

export function getErrorMeta(code: string, context?: ErrorContext): ErrorMeta {
	if (code === "model_fallback_429") {
		return getModelFallbackMeta(context);
	}
	if (code in KNOWN_ERROR_META) {
		return KNOWN_ERROR_META[code as keyof typeof KNOWN_ERROR_META];
	}
	const terminal = KNOWN_TERMINAL_META[code];
	if (terminal) return terminal;
	return {
		title: code || "Unknown error",
		description: "No additional context is available for this error code.",
		suggestion: "Check the server logs or the original request for details.",
		severity: "error",
	};
}
