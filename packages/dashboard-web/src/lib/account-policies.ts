import { type AccountResponse, PROVIDER_NAMES } from "@clankermux/types";
import {
	providerSupportsAutoFallback,
	providerSupportsAutoFeatures,
	providerSupportsCustomBilling,
} from "../utils/provider-utils";

/**
 * The per-account automation flags an operator can configure. One key per
 * toggle in the account overflow menu — `extraSpend` is a single key whose
 * wording reflects the provider’s quota and prepaid-credit behavior.
 */
export type AccountPolicyKey =
	| "autoFallback"
	| "autoRefresh"
	| "extraSpend"
	| "autoApplyExpiry"
	| "autoApplyWeekly"
	| "peakHoursPause"
	| "planBilling";

/**
 * The copy for one flag. `chipLabel` is the short form the status-chip row
 * shows; `menuLabel` and `description` are exactly what the overflow menu
 * renders, so the chip tooltip and the menu tooltip cannot drift apart.
 */
export interface AccountPolicyDescriptor {
	key: AccountPolicyKey;
	chipLabel: string;
	menuLabel: string;
	description: string;
}

/** One flag as it applies to a specific account. */
export interface AccountPolicyState {
	key: AccountPolicyKey;
	/** The descriptor's `chipLabel`, already resolved for the provider. */
	label: string;
	description: string;
	enabled: boolean;
	/**
	 * Set on flags whose ON state has money consequences, so the chip row can
	 * render them in the warning tone instead of the ordinary filled one.
	 */
	emphasis?: "warning";
}

/**
 * Each provider describes its own allowance and billing semantics. The stored
 * flag protects included usage; extra spend uses the inverse polarity.
 */
const EXTRA_SPEND_CODEX: AccountPolicyDescriptor = {
	key: "extraSpend",
	chipLabel: "Credit spend",
	menuLabel: "Allow credits past weekly limit",
	description:
		"When the weekly Codex limit is reached, allow this account to keep running on purchased credits. When OFF (default), the account pauses and traffic fails over to other accounts, then auto-resumes when the weekly window resets.",
};

const EXTRA_SPEND_DEVIN: AccountPolicyDescriptor = {
	key: "extraSpend",
	chipLabel: "Unverified spend",
	menuLabel: "Allow requests beyond verified included quota",
	description:
		"Allow Devin requests when included quota is exhausted or unknown. This may consume prepaid credits. When OFF (default), requests require reported included capacity. Usage is shared with Devin CLI, Desktop, and cloud, so concurrent usage can exceed the last reported allowance. Keep prepaid overage disabled in Devin to prevent credit spending.",
};

const EXTRA_SPEND_ANTHROPIC: AccountPolicyDescriptor = {
	key: "extraSpend",
	chipLabel: "Overage spend",
	menuLabel: "Allow overage spend",
	description:
		"Allow this account to incur overage charges past its plan limit. When OFF (default), the account auto-pauses when overage usage is detected and resumes when the usage window resets. Note: detection relies on Anthropic reporting overage, so some overage may occur before pausing.",
};

/**
 * Anthropic's banked resets (Claude Code grants) and Codex reset credits share
 * the two auto-apply keys and their labels; only each provider's rules differ.
 */
const AUTO_APPLY_EXPIRY_LABELS = {
	key: "autoApplyExpiry",
	chipLabel: "Apply: expiry",
	menuLabel: "Auto-apply expiring banked resets",
} as const;

const AUTO_APPLY_WEEKLY_LABELS = {
	key: "autoApplyWeekly",
	chipLabel: "Apply: weekly",
	menuLabel: "Auto-apply banked reset at weekly limit",
} as const;

const AUTO_APPLY_EXPIRY_ANTHROPIC: AccountPolicyDescriptor = {
	...AUTO_APPLY_EXPIRY_LABELS,
	description:
		"Automatically apply the next banked reset shortly (~10 min) before it expires so it isn't wasted. Only grants that clear a weekly limit are applied, and a grant usable only at a limit is applied only while one is reached. Applies even while paused, unless the account needs re-authentication.",
};

const AUTO_APPLY_WEEKLY_ANTHROPIC: AccountPolicyDescriptor = {
	...AUTO_APPLY_WEEKLY_LABELS,
	description:
		"Automatically apply the next banked reset when this account reaches a weekly limit it clears, no other Claude account can serve the same models, and the account's natural weekly reset is at least 72 hours away; or when the banked reset would expire before that limit lifts. An account whose usage is unknown counts as able to serve. Respects API-key account pins. Manual pauses conserve banked resets; an overage pause is lifted by the reset. At most one auto-apply per hour.",
};

const AUTO_APPLY_EXPIRY_CODEX: AccountPolicyDescriptor = {
	...AUTO_APPLY_EXPIRY_LABELS,
	description:
		"Automatically apply the next banked reset shortly (~10 min) before it expires so it isn't wasted. Applies even while paused, unless the account needs re-authentication.",
};

const AUTO_APPLY_WEEKLY_CODEX: AccountPolicyDescriptor = {
	...AUTO_APPLY_WEEKLY_LABELS,
	description:
		"Automatically apply the next banked reset when this account reaches 100% weekly usage, no other Codex account can serve, and the account's natural weekly reset is at least 12 hours away. An account whose usage is unknown counts as able to serve. Respects API-key account pins. Manual pauses conserve banked resets; an overage pause is lifted by the reset. At most one auto-apply per hour.",
};

const PROVIDER_INDEPENDENT_DESCRIPTORS: Record<
	Exclude<
		AccountPolicyKey,
		"extraSpend" | "autoApplyExpiry" | "autoApplyWeekly"
	>,
	AccountPolicyDescriptor
> = {
	autoFallback: {
		key: "autoFallback",
		chipLabel: "Fallback",
		menuLabel: "Auto-fallback",
		description:
			"Automatically switch back to this account from lower-priority ones when its rate limit resets. Requires multiple accounts with different priorities.",
	},
	autoRefresh: {
		key: "autoRefresh",
		chipLabel: "Prewarm",
		menuLabel: "Auto-refresh",
		description:
			"Automatically sends a minimal message when the usage window resets to avoid cold-start latency. Does not affect OAuth token refreshing.",
	},
	peakHoursPause: {
		key: "peakHoursPause",
		chipLabel: "Peak pause",
		menuLabel: "Peak hours pause",
		description:
			"Automatically pause this account during Zai peak hours (14:00–18:00 SGT)",
	},
	planBilling: {
		key: "planBilling",
		chipLabel: "Plan billing",
		menuLabel: "Plan billing",
		description: "Toggle plan billing for this account",
	},
};

/**
 * Copy for one flag on one provider. `extraSpend` and the two auto-apply keys
 * depend on the provider; everything else ignores `provider`.
 */
export function describeAccountPolicy(
	key: AccountPolicyKey,
	provider: string,
): AccountPolicyDescriptor {
	if (key === "autoFallback" && provider === PROVIDER_NAMES.DEVIN)
		return {
			key,
			chipLabel: "Auto-recover quota",
			menuLabel: "Auto-recover quota",
			description:
				"Use account metadata to pause when protected included quota is exhausted or unknown, and resume quota-paused accounts when capacity returns. Applies to new or unpinned requests; keeps manual and reconnect-required pauses. Does not send inference requests.",
		};
	if (key === "autoApplyExpiry") {
		return provider === PROVIDER_NAMES.ANTHROPIC
			? AUTO_APPLY_EXPIRY_ANTHROPIC
			: AUTO_APPLY_EXPIRY_CODEX;
	}
	if (key === "autoApplyWeekly") {
		return provider === PROVIDER_NAMES.ANTHROPIC
			? AUTO_APPLY_WEEKLY_ANTHROPIC
			: AUTO_APPLY_WEEKLY_CODEX;
	}
	if (key === "extraSpend") {
		if (provider === PROVIDER_NAMES.DEVIN) return EXTRA_SPEND_DEVIN;
		return provider === PROVIDER_NAMES.CODEX
			? EXTRA_SPEND_CODEX
			: EXTRA_SPEND_ANTHROPIC;
	}
	return PROVIDER_INDEPENDENT_DESCRIPTORS[key];
}

/**
 * Every automation flag the account's provider supports, on or off, in the
 * order the overflow menu lists them. Providers with no automation flags of
 * their own return an empty list.
 *
 * Provider support is decided by the same predicates the overflow menu uses
 * (`providerSupportsAutoFeatures`, `providerSupportsCustomBilling`) rather than
 * by a restated provider list, so the chips and the menu cannot diverge.
 */
export function deriveAccountPolicies(
	account: AccountResponse,
): ReadonlyArray<AccountPolicyState> {
	const { provider } = account;
	const policies: AccountPolicyState[] = [];

	const add = (
		key: AccountPolicyKey,
		enabled: boolean,
		emphasis?: "warning",
	) => {
		const descriptor = describeAccountPolicy(key, provider);
		policies.push({
			key,
			label: descriptor.chipLabel,
			description: descriptor.description,
			enabled,
			...(emphasis ? { emphasis } : {}),
		});
	};

	if (providerSupportsAutoFallback(provider)) {
		add("autoFallback", account.autoFallbackEnabled === true);
	}
	if (providerSupportsAutoFeatures(provider)) {
		add("autoRefresh", account.autoRefreshEnabled === true);
	}
	if (
		provider === PROVIDER_NAMES.ANTHROPIC ||
		provider === PROVIDER_NAMES.CODEX ||
		provider === PROVIDER_NAMES.DEVIN
	) {
		// Inverted polarity, matching the menu item and the routing readers: the
		// stored flag is the PROTECTION ("auto-pause rather than overspend"), so
		// extra spend is permitted exactly when it is off. Devin requires explicit
		// opt-out; older providers retain their existing absent-flag behavior.
		add(
			"extraSpend",
			provider === PROVIDER_NAMES.DEVIN
				? account.autoPauseOnOverageEnabled === false
				: !account.autoPauseOnOverageEnabled,
			"warning",
		);
	}
	if (provider === PROVIDER_NAMES.CODEX) {
		add("autoApplyExpiry", account.autoApplyResetCreditsEnabled === true);
		add("autoApplyWeekly", account.autoApplyResetOnWeeklyLimitEnabled === true);
	}
	// Banked resets are claimed with the account's OAuth token; an API-key
	// Anthropic account has none.
	if (provider === PROVIDER_NAMES.ANTHROPIC && account.hasRefreshToken) {
		add("autoApplyExpiry", account.autoApplyBankedResetsEnabled === true);
		add(
			"autoApplyWeekly",
			account.autoApplyBankedResetOnWeeklyLimitEnabled === true,
		);
	}
	if (provider === PROVIDER_NAMES.ZAI) {
		add("peakHoursPause", account.peakHoursPauseEnabled === true);
	}
	if (providerSupportsCustomBilling(provider)) {
		add("planBilling", account.billingType === "plan");
	}

	return policies;
}
