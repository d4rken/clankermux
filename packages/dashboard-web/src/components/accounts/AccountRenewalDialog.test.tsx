import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account } from "../../api";
import { SubscriptionStatusSummary } from "./AccountRenewalDialog";

const CHECKED = Date.UTC(2026, 8, 18, 9, 2);

function render(overrides: Partial<Account> = {}) {
	return renderToStaticMarkup(
		<SubscriptionStatusSummary
			account={
				{
					provider: "anthropic",
					identitySubscriptionStatus: "active",
					identitySubscriptionCheckedAt: CHECKED,
					identityProfileFetchedAt: CHECKED,
					...overrides,
				} as Account
			}
		/>,
	);
}

describe("SubscriptionStatusSummary", () => {
	it("dates the last known provider status", () => {
		const html = render();
		expect(html).toContain("Last known subscription status: active");
		expect(html).toContain("Last successful check:");
		expect(html).toContain(new Date(CHECKED).toISOString());
		expect(html).not.toContain("has not completed successfully");
	});

	it("distinguishes a failed newer check from stale active metadata", () => {
		const html = render({ identityProfileFetchedAt: CHECKED - 60_000 });
		expect(html).toContain("Last known subscription status: active");
		expect(html).toContain(
			"Latest subscription check has not completed successfully",
		);
	});

	it("reports missing status as unknown even after a successful profile fetch", () => {
		const html = render({ identitySubscriptionStatus: null });
		expect(html).toContain("Subscription status: unknown");
		expect(html).not.toContain("active");
	});

	it("does not change other providers", () => {
		expect(render({ provider: "codex" })).toBe("");
	});
});
