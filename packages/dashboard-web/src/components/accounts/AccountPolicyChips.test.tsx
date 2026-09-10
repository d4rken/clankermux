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
 * chip is instead cut at the next chip's opening tag. The nested `sr-only`
 * span cannot start a slice: only `StatusChip`'s own base classes do.
 */
function chips(html: string): string[] {
	const marker = '<span class="inline-flex';
	return html
		.split(marker)
		.slice(1)
		.map((part) => `${marker}${part}`);
}

function chipFor(html: string, label: string): string {
	const found = chips(html).filter((chip) => chip.includes(`${label}<span`));
	if (found.length !== 1) {
		throw new Error(
			`expected exactly one chip labelled "${label}", found ${found.length}`,
		);
	}
	return found[0] as string;
}

function labelsOf(html: string): string[] {
	return chips(html).map((chip) => {
		const match = chip.match(/<\/svg>(.*?)<span class="sr-only"/);
		if (!match) throw new Error(`chip has no label: ${chip}`);
		return match[1] as string;
	});
}

describe("AccountPolicyChips — provider inventory", () => {
	it("renders all five codex flags with their chip labels", () => {
		expect(labelsOf(render(makeAccount({ provider: "codex" })))).toEqual([
			"Auto-fallback",
			"Auto-refresh",
			"Credits past weekly",
			"Auto-apply: expiry",
			"Auto-apply: weekly",
		]);
	});

	it("renders the three anthropic flags with their chip labels", () => {
		expect(labelsOf(render(makeAccount({ provider: "anthropic" })))).toEqual([
			"Auto-fallback",
			"Auto-refresh",
			"Overage spend",
		]);
	});

	it("renders the three zai flags, including peak-hours pause", () => {
		expect(labelsOf(render(makeAccount({ provider: "zai" })))).toEqual([
			"Auto-fallback",
			"Auto-refresh",
			"Peak hours pause",
		]);
	});

	it("renders only the plan-billing chip for a compatible provider", () => {
		expect(
			labelsOf(render(makeAccount({ provider: "openai-compatible" }))),
		).toEqual(["Plan billing"]);
	});

	it("renders nothing at all for a provider with no automation flags", () => {
		expect(render(makeAccount({ provider: "openrouter" }))).toBe("");
	});
});

describe("AccountPolicyChips — polarity tone", () => {
	it("fills an enabled ordinary flag and keeps its border transparent", () => {
		const chip = chipFor(
			render(makeAccount({ provider: "anthropic", autoFallbackEnabled: true })),
			"Auto-fallback",
		);
		expect(chip).toContain("bg-secondary");
		expect(chip).toContain("border-transparent");
		expect(chip).not.toContain("border-border");
	});

	it("outlines a disabled flag with no fill", () => {
		const chip = chipFor(
			render(
				makeAccount({ provider: "anthropic", autoFallbackEnabled: false }),
			),
			"Auto-fallback",
		);
		expect(chip).toContain("border-border");
		expect(chip).toContain("text-muted-foreground");
		expect(chip).not.toContain("bg-secondary");
	});

	it("gives permitted extra spend the warning tone", () => {
		const chip = chipFor(
			render(
				makeAccount({ provider: "codex", autoPauseOnOverageEnabled: false }),
			),
			"Credits past weekly",
		);
		expect(chip).toContain("bg-warning/15");
		expect(chip).toContain("text-warning-strong");
		expect(chip).toContain("border-transparent");
	});

	it("gives blocked extra spend the ordinary off tone, not the warning tone", () => {
		const chip = chipFor(
			render(
				makeAccount({ provider: "codex", autoPauseOnOverageEnabled: true }),
			),
			"Credits past weekly",
		);
		expect(chip).toContain("border-border");
		expect(chip).toContain("text-muted-foreground");
		expect(chip).not.toContain("bg-warning/15");
		expect(chip).not.toContain("text-warning-strong");
	});

	it("carries a border in both states so the two are the same size", () => {
		const html = render(
			makeAccount({
				provider: "codex",
				autoFallbackEnabled: true,
				autoRefreshEnabled: false,
			}),
		);
		for (const chip of chips(html)) {
			expect(chip).toContain("border ");
		}
	});
});

describe("AccountPolicyChips — accessible state", () => {
	it("prefixes every tooltip with the state word and the menu explanation", () => {
		const html = render(
			makeAccount({
				provider: "codex",
				autoFallbackEnabled: true,
				autoPauseOnOverageEnabled: true,
			}),
		);
		for (const chip of chips(html)) {
			const match = chip.match(/title="(On|Off) — [^"]+"/);
			expect(match).not.toBeNull();
		}
		expect(chipFor(html, "Auto-fallback")).toContain(
			'title="On — Automatically switch back to this account from lower-priority ones',
		);
		expect(chipFor(html, "Credits past weekly")).toContain(
			'title="Off — When the weekly Codex limit is reached',
		);
	});

	it("names the state in an sr-only span that matches the tone", () => {
		const html = render(
			makeAccount({
				provider: "codex",
				autoFallbackEnabled: true,
				autoRefreshEnabled: false,
				autoPauseOnOverageEnabled: true,
			}),
		);
		for (const chip of chips(html)) {
			const isOn = chip.includes('<span class="sr-only">On</span>');
			const isOff = chip.includes('<span class="sr-only">Off</span>');
			expect(isOn || isOff).toBe(true);
			if (isOn) {
				expect(chip).toContain("border-transparent");
			} else {
				expect(chip).toContain("border-border");
			}
		}
	});

	it("hides the decorative icon from assistive technology", () => {
		const chip = chipFor(
			render(makeAccount({ provider: "openai-compatible" })),
			"Plan billing",
		);
		expect(chip).toContain('aria-hidden="true"');
	});
});
