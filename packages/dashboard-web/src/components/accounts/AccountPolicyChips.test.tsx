import { describe, expect, it } from "bun:test";
import type { AccountResponse } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountPolicyChips } from "./AccountPolicyChips";

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

function render(account: AccountResponse): string {
	return renderToStaticMarkup(<AccountPolicyChips account={account} />);
}

/**
 * The rendered chips, one markup slice each. `AccountPolicyChips` returns a
 * fragment so the chips are siblings of the status pills rather than one
 * indivisible block, which means there is no wrapper element to slice on — each
 * chip is instead cut at the next chip's opening tag.
 */
function chips(html: string): string[] {
	const marker = '<span class="inline-flex';
	return html
		.split(marker)
		.slice(1)
		.map((part) => `${marker}${part}`);
}

function chipFor(html: string, label: string): string {
	const found = chips(html).filter((chip) => chip.includes(`${label}</span>`));
	if (found.length !== 1) {
		throw new Error(
			`expected exactly one chip labelled "${label}", found ${found.length}`,
		);
	}
	return found[0] as string;
}

function labelsOf(html: string): string[] {
	return chips(html).map((chip) => {
		const match = chip.match(/<\/svg>(.*?)<\/span>/);
		if (!match) throw new Error(`chip has no label: ${chip}`);
		return match[1] as string;
	});
}

describe("AccountPolicyChips — enabled flags only", () => {
	it("renders every codex flag when all five are on", () => {
		expect(
			labelsOf(
				render(
					makeAccount({
						provider: "codex",
						autoFallbackEnabled: true,
						autoRefreshEnabled: true,
						autoPauseOnOverageEnabled: false,
						autoApplyResetCreditsEnabled: true,
						autoApplyResetOnWeeklyLimitEnabled: true,
					}),
				),
			),
		).toEqual([
			"Fallback",
			"Prewarm",
			"Credit spend",
			"Apply: expiry",
			"Apply: weekly",
		]);
	});

	it("omits disabled flags and keeps the enabled ones in menu order", () => {
		expect(
			labelsOf(
				render(
					makeAccount({
						provider: "codex",
						autoFallbackEnabled: false,
						autoRefreshEnabled: true,
						autoPauseOnOverageEnabled: true,
						autoApplyResetCreditsEnabled: false,
						autoApplyResetOnWeeklyLimitEnabled: true,
					}),
				),
			),
		).toEqual(["Prewarm", "Apply: weekly"]);
	});

	it("renders the enabled anthropic flags with their chip labels", () => {
		expect(
			labelsOf(
				render(
					makeAccount({
						provider: "anthropic",
						autoFallbackEnabled: true,
						autoRefreshEnabled: true,
						autoPauseOnOverageEnabled: false,
					}),
				),
			),
		).toEqual(["Fallback", "Prewarm", "Overage spend"]);
	});

	it("renders an enabled zai peak-hours pause", () => {
		expect(
			labelsOf(
				render(makeAccount({ provider: "zai", peakHoursPauseEnabled: true })),
			),
		).toEqual(["Peak pause"]);
	});

	it("renders the plan-billing chip only when plan billing is on", () => {
		expect(
			labelsOf(
				render(
					makeAccount({ provider: "openai-compatible", billingType: "plan" }),
				),
			),
		).toEqual(["Plan billing"]);
		expect(render(makeAccount({ provider: "openai-compatible" }))).toBe("");
	});

	it("renders nothing when every supported flag is off", () => {
		expect(
			render(
				makeAccount({
					provider: "anthropic",
					autoPauseOnOverageEnabled: true,
				}),
			),
		).toBe("");
	});

	it("renders nothing at all for a provider with no automation flags", () => {
		expect(render(makeAccount({ provider: "openrouter" }))).toBe("");
	});
});

describe("AccountPolicyChips — tone", () => {
	it("fills an enabled ordinary flag", () => {
		const chip = chipFor(
			render(makeAccount({ provider: "anthropic", autoFallbackEnabled: true })),
			"Fallback",
		);
		expect(chip).toContain("bg-secondary");
		expect(chip).not.toContain("border");
	});

	it("gives permitted extra spend the warning tone", () => {
		const chip = chipFor(
			render(
				makeAccount({ provider: "codex", autoPauseOnOverageEnabled: false }),
			),
			"Credit spend",
		);
		expect(chip).toContain("bg-warning/15");
		expect(chip).toContain("text-warning-strong");
	});

	it("hides blocked extra spend", () => {
		const html = render(
			makeAccount({
				provider: "codex",
				autoFallbackEnabled: true,
				autoPauseOnOverageEnabled: true,
			}),
		);
		expect(html).not.toContain("Credit spend");
	});
});

describe("AccountPolicyChips — accessible state", () => {
	it("prefixes the tooltip with the On state and the menu explanation", () => {
		const html = render(
			makeAccount({
				provider: "codex",
				autoFallbackEnabled: true,
				autoPauseOnOverageEnabled: false,
			}),
		);
		expect(chipFor(html, "Fallback")).toContain(
			'title="On — Automatically switch back to this account from lower-priority ones',
		);
		expect(chipFor(html, "Credit spend")).toContain(
			'title="On — When the weekly Codex limit is reached',
		);
	});

	it("hides the decorative icon from assistive technology", () => {
		const chip = chipFor(
			render(
				makeAccount({ provider: "openai-compatible", billingType: "plan" }),
			),
			"Plan billing",
		);
		expect(chip).toContain('aria-hidden="true"');
	});
});
