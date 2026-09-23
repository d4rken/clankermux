import { describe, expect, it } from "bun:test";
import type { AccountResponse } from "@clankermux/types";
import {
	type AccountPolicyKey,
	deriveAccountPolicies,
	describeAccountPolicy,
} from "./account-policies";

function makeAccount(
	overrides: Partial<AccountResponse> = {},
): AccountResponse {
	return {
		id: "a1",
		name: "acct",
		provider: "anthropic",
		requestCount: 0,
		totalRequests: 0,
		lastUsed: null,
		created: "2024-01-01T00:00:00Z",
		paused: false,
		tokenStatus: "valid",
		tokenExpiresAt: null,
		rateLimitStatus: "OK",
		rateLimitReset: null,
		rateLimitRemaining: null,
		rateLimitedUntil: null,
		rateLimitedReason: null,
		rateLimitedAt: null,
		sessionInfo: "No active session",
		priority: 0,
		autoFallbackEnabled: false,
		autoRefreshEnabled: false,
		customEndpoint: null,
		modelMappings: null,
		usageUtilization: null,
		usageWindow: null,
		usageData: null,
		usageRateLimitedUntil: null,
		usageThrottledUntil: null,
		usageThrottledWindows: [],
		hasRefreshToken: false,
		sessionStats: null,
		isPrimary: false,
		notes: null,
		billingType: null,
		...overrides,
	} as AccountResponse;
}

function keysFor(provider: string): AccountPolicyKey[] {
	return deriveAccountPolicies(makeAccount({ provider })).map((p) => p.key);
}

function policyOf(account: AccountResponse, key: AccountPolicyKey) {
	const found = deriveAccountPolicies(account).find((p) => p.key === key);
	if (!found) throw new Error(`policy ${key} not derived`);
	return found;
}

describe("deriveAccountPolicies — provider inventory", () => {
	it("gives a codex account all five of its flags, in table order", () => {
		expect(keysFor("codex")).toEqual([
			"autoFallback",
			"autoRefresh",
			"extraSpend",
			"autoApplyExpiry",
			"autoApplyWeekly",
		]);
	});

	it("gives an anthropic account three flags, in table order", () => {
		expect(keysFor("anthropic")).toEqual([
			"autoFallback",
			"autoRefresh",
			"extraSpend",
		]);
	});

	it("adds the two banked-reset flags on an Anthropic OAuth account only", () => {
		const oauth = makeAccount({
			provider: "anthropic",
			hasRefreshToken: true,
			autoApplyBankedResetsEnabled: true,
			autoApplyBankedResetOnWeeklyLimitEnabled: false,
		});
		expect(deriveAccountPolicies(oauth).map((p) => p.key)).toEqual([
			"autoFallback",
			"autoRefresh",
			"extraSpend",
			"autoApplyExpiry",
			"autoApplyWeekly",
		]);
		expect(policyOf(oauth, "autoApplyExpiry").enabled).toBe(true);
		expect(policyOf(oauth, "autoApplyWeekly").enabled).toBe(false);
		// The Codex toggles never stand in for Anthropic's.
		expect(
			policyOf(
				makeAccount({
					provider: "anthropic",
					hasRefreshToken: true,
					autoApplyResetCreditsEnabled: true,
				}),
				"autoApplyExpiry",
			).enabled,
		).toBe(false);
	});

	it("gives a zai account three flags, in table order", () => {
		expect(keysFor("zai")).toEqual([
			"autoFallback",
			"autoRefresh",
			"peakHoursPause",
		]);
	});

	it("gives each compatible-provider account only plan billing", () => {
		expect(keysFor("anthropic-compatible")).toEqual(["planBilling"]);
		expect(keysFor("openai-compatible")).toEqual(["planBilling"]);
	});

	it("gives providers without automation flags nothing at all", () => {
		expect(keysFor("openrouter")).toEqual([]);
		expect(keysFor("ollama")).toEqual([]);
		expect(keysFor("kilo")).toEqual([]);
		expect(keysFor("qwen")).toEqual([]);
	});
});

describe("deriveAccountPolicies — flag polarity", () => {
	it("reads the ordinary flags straight through", () => {
		const on = makeAccount({
			provider: "codex",
			autoFallbackEnabled: true,
			autoRefreshEnabled: true,
			autoApplyResetCreditsEnabled: true,
			autoApplyResetOnWeeklyLimitEnabled: true,
		});
		expect(policyOf(on, "autoFallback").enabled).toBe(true);
		expect(policyOf(on, "autoRefresh").enabled).toBe(true);
		expect(policyOf(on, "autoApplyExpiry").enabled).toBe(true);
		expect(policyOf(on, "autoApplyWeekly").enabled).toBe(true);

		const off = makeAccount({ provider: "codex" });
		expect(policyOf(off, "autoFallback").enabled).toBe(false);
		expect(policyOf(off, "autoRefresh").enabled).toBe(false);
		expect(policyOf(off, "autoApplyExpiry").enabled).toBe(false);
		expect(policyOf(off, "autoApplyWeekly").enabled).toBe(false);
	});

	it("enables peakHoursPause only when the zai flag is set", () => {
		expect(
			policyOf(
				makeAccount({ provider: "zai", peakHoursPauseEnabled: true }),
				"peakHoursPause",
			).enabled,
		).toBe(true);
		expect(
			policyOf(makeAccount({ provider: "zai" }), "peakHoursPause").enabled,
		).toBe(false);
	});

	it("inverts extraSpend: the stored flag is the PROTECTION, not the permission", () => {
		// `autoPauseOnOverageEnabled: true` means "pause rather than overspend",
		// so extra spend is NOT permitted and the chip reads off.
		expect(
			policyOf(
				makeAccount({ provider: "codex", autoPauseOnOverageEnabled: true }),
				"extraSpend",
			).enabled,
		).toBe(false);
		expect(
			policyOf(
				makeAccount({ provider: "codex", autoPauseOnOverageEnabled: false }),
				"extraSpend",
			).enabled,
		).toBe(true);
	});

	it("treats an absent autoPauseOnOverageEnabled as extra spend permitted", () => {
		// Matches the server's COALESCE(…, 0): unknown is un-protected.
		const account = makeAccount({ provider: "anthropic" });
		account.autoPauseOnOverageEnabled = undefined;
		expect(policyOf(account, "extraSpend").enabled).toBe(true);
	});

	it("marks extraSpend — and only extraSpend — as warning-emphasis", () => {
		const derived = deriveAccountPolicies(makeAccount({ provider: "codex" }));
		expect(
			derived.filter((p) => p.emphasis === "warning").map((p) => p.key),
		).toEqual(["extraSpend"]);
	});

	it("enables planBilling only for the literal 'plan' billing type", () => {
		const enabledFor = (billingType: string | null | undefined) => {
			const account = makeAccount({ provider: "openai-compatible" });
			account.billingType = billingType;
			return policyOf(account, "planBilling").enabled;
		};
		expect(enabledFor("plan")).toBe(true);
		expect(enabledFor("api")).toBe(false);
		expect(enabledFor(null)).toBe(false);
		expect(enabledFor(undefined)).toBe(false);
	});

	it("never throws when every optional boolean arrives undefined", () => {
		for (const provider of ["codex", "anthropic", "zai"]) {
			const account = makeAccount({ provider });
			account.autoPauseOnOverageEnabled = undefined;
			account.peakHoursPauseEnabled = undefined;
			account.autoApplyResetCreditsEnabled = undefined;
			account.autoApplyResetOnWeeklyLimitEnabled = undefined;
			const derived = deriveAccountPolicies(account);
			expect(derived.length).toBeGreaterThan(0);
			for (const entry of derived) {
				expect(typeof entry.enabled).toBe("boolean");
				expect(entry.label.length).toBeGreaterThan(0);
				expect(entry.description.length).toBeGreaterThan(0);
			}
		}
	});
});

describe("describeAccountPolicy — provider-dependent extraSpend copy", () => {
	it("resolves the codex wording on a codex account", () => {
		const descriptor = describeAccountPolicy("extraSpend", "codex");
		expect(descriptor.chipLabel).toBe("Credit spend");
		expect(descriptor.menuLabel).toBe("Allow credits past weekly limit");
	});

	it("resolves the anthropic wording on an anthropic account", () => {
		const descriptor = describeAccountPolicy("extraSpend", "anthropic");
		expect(descriptor.chipLabel).toBe("Overage spend");
		expect(descriptor.menuLabel).toBe("Allow overage spend");
	});

	it("keeps the two variants distinct in label and description", () => {
		const codex = describeAccountPolicy("extraSpend", "codex");
		const anthropic = describeAccountPolicy("extraSpend", "anthropic");
		expect(codex.chipLabel).not.toBe(anthropic.chipLabel);
		expect(codex.menuLabel).not.toBe(anthropic.menuLabel);
		expect(codex.description).not.toBe(anthropic.description);
	});

	it("carries the provider-resolved chip label into the derived policy", () => {
		expect(
			policyOf(makeAccount({ provider: "codex" }), "extraSpend").label,
		).toBe("Credit spend");
		expect(
			policyOf(makeAccount({ provider: "anthropic" }), "extraSpend").label,
		).toBe("Overage spend");
	});
});

/**
 * Pinned literals, not a cross-check against another consumer of the same
 * descriptor: comparing the chip tooltip to the menu tooltip would agree
 * perfectly on a description that was mis-copied out of `AccountListItem`.
 * Only a literal written out here can catch that.
 */
describe("describeAccountPolicy — descriptions pinned to the menu copy", () => {
	it("pins auto-fallback", () => {
		expect(describeAccountPolicy("autoFallback", "anthropic").description).toBe(
			"Automatically switch back to this account from lower-priority ones when its rate limit resets. Requires multiple accounts with different priorities.",
		);
	});

	it("pins auto-refresh", () => {
		expect(describeAccountPolicy("autoRefresh", "anthropic").description).toBe(
			"Automatically sends a minimal message when the usage window resets to avoid cold-start latency. Does not affect OAuth token refreshing.",
		);
	});

	it("pins the codex extra-spend copy", () => {
		expect(describeAccountPolicy("extraSpend", "codex").description).toBe(
			"When the weekly Codex limit is reached, allow this account to keep running on purchased credits. When OFF (default), the account pauses and traffic fails over to other accounts, then auto-resumes when the weekly window resets.",
		);
	});

	it("pins the anthropic extra-spend copy", () => {
		expect(describeAccountPolicy("extraSpend", "anthropic").description).toBe(
			"Allow this account to incur overage charges past its plan limit. When OFF (default), the account auto-pauses when overage usage is detected and resumes when the usage window resets. Note: detection relies on Anthropic reporting overage, so some overage may occur before pausing.",
		);
	});

	it("pins auto-apply on expiry", () => {
		expect(describeAccountPolicy("autoApplyExpiry", "codex").description).toBe(
			"Automatically apply the next banked reset shortly (~10 min) before it expires so it isn't wasted. Applies even while paused, unless the account needs re-authentication.",
		);
		expect(
			describeAccountPolicy("autoApplyExpiry", "anthropic").description,
		).toBe(
			"Automatically apply the next banked reset shortly (~10 min) before it expires so it isn't wasted. Only grants that clear a weekly limit are applied, and a grant usable only at a limit is applied only while one is reached. Applies even while paused, unless the account needs re-authentication.",
		);
	});

	it("pins auto-apply at the weekly limit", () => {
		expect(describeAccountPolicy("autoApplyWeekly", "codex").description).toBe(
			"Automatically apply the next banked reset when this account reaches 100% weekly usage, no other Codex account can serve, and the account's natural weekly reset is at least 12 hours away. An account whose usage is unknown counts as able to serve. Respects API-key account pins. Manual pauses conserve banked resets; an overage pause is lifted by the reset. At most one auto-apply per hour.",
		);
		expect(
			describeAccountPolicy("autoApplyWeekly", "anthropic").description,
		).toBe(
			"Automatically apply the next banked reset when this account reaches a weekly limit it clears, no other Claude account can serve the same models, and the account's natural weekly reset is at least 12 hours away; or when the banked reset would expire before that limit lifts. An account whose usage is unknown counts as able to serve. Respects API-key account pins. Manual pauses conserve banked resets; an overage pause is lifted by the reset. At most one auto-apply per hour.",
		);
	});

	it("pins peak-hours pause", () => {
		expect(describeAccountPolicy("peakHoursPause", "zai").description).toBe(
			"Automatically pause this account during Zai peak hours (14:00–18:00 SGT)",
		);
	});

	it("pins plan billing", () => {
		expect(
			describeAccountPolicy("planBilling", "openai-compatible").description,
		).toBe("Toggle plan billing for this account");
	});
});

it("offers Devin extra spend independently of session automation", () => {
	expect(keysFor("devin")).toEqual(["autoFallback", "extraSpend"]);
	const recovery = describeAccountPolicy("autoFallback", "devin");
	expect(recovery.menuLabel).toBe("Auto-recover quota");
	expect(recovery.description).toContain("metadata");
	expect(recovery.description).toContain("new or unpinned");
	expect(recovery.description).not.toContain("message");
	expect(
		policyOf(
			makeAccount({ provider: "devin", autoPauseOnOverageEnabled: undefined }),
			"extraSpend",
		).enabled,
	).toBe(false);
	const protectedAccount = makeAccount({
		provider: "devin",
		autoPauseOnOverageEnabled: true,
	});
	expect(policyOf(protectedAccount, "extraSpend").enabled).toBe(false);
	expect(
		policyOf(
			{ ...protectedAccount, autoPauseOnOverageEnabled: false },
			"extraSpend",
		).enabled,
	).toBe(true);
	const copy = describeAccountPolicy("extraSpend", "devin");
	expect(copy.menuLabel).toBe("Allow requests beyond verified included quota");
	expect(copy.description).toContain("unknown");
	expect(copy.description).toContain("prepaid credits");
	expect(copy.description).toContain("CLI, Desktop, and cloud");
	expect(copy.description).not.toContain("Anthropic");
	expect(copy.description).not.toContain("five-hour");
});

it("words the auto-apply flags for Anthropic banked resets", () => {
	const expiry = describeAccountPolicy("autoApplyExpiry", "anthropic");
	const weekly = describeAccountPolicy("autoApplyWeekly", "anthropic");
	expect(expiry.menuLabel).toBe("Auto-apply expiring banked resets");
	expect(weekly.menuLabel).toBe("Auto-apply banked reset at weekly limit");
	expect(expiry.chipLabel).toBe("Apply: expiry");
	expect(weekly.chipLabel).toBe("Apply: weekly");
	expect(expiry.description).not.toContain("Codex");
	expect(weekly.description).not.toContain("Codex");
	expect(weekly.description).toContain("no other Claude account can serve");
});

it("labels the auto-apply flags identically for Codex and Anthropic", () => {
	for (const key of ["autoApplyExpiry", "autoApplyWeekly"] as const) {
		const codex = describeAccountPolicy(key, "codex");
		const anthropic = describeAccountPolicy(key, "anthropic");
		expect(codex.menuLabel).toBe(anthropic.menuLabel);
		expect(codex.chipLabel).toBe(anthropic.chipLabel);
		// Only the rules differ.
		expect(codex.description).not.toBe(anthropic.description);
	}
	expect(describeAccountPolicy("autoApplyExpiry", "codex").menuLabel).toBe(
		"Auto-apply expiring banked resets",
	);
	expect(describeAccountPolicy("autoApplyWeekly", "codex").menuLabel).toBe(
		"Auto-apply banked reset at weekly limit",
	);
});

it("words the auto-apply copy in one vocabulary for both providers", () => {
	for (const provider of ["codex", "anthropic"]) {
		for (const key of ["autoApplyExpiry", "autoApplyWeekly"] as const) {
			const { menuLabel, description } = describeAccountPolicy(key, provider);
			expect(`${menuLabel} ${description}`).not.toMatch(
				/claim|consume|redeem|usage reset|reset credit/i,
			);
		}
		const weekly = describeAccountPolicy("autoApplyWeekly", provider);
		expect(weekly.description).toContain("at least 12 hours away");
		expect(weekly.description).toContain(
			"An account whose usage is unknown counts as able to serve.",
		);
		expect(weekly.description).toContain(
			"Manual pauses conserve banked resets",
		);
	}
});
