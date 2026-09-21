import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account } from "../../api";
import { AccountAccessNotice } from "./AccountAccessNotice";

const CHECKED = Date.UTC(2026, 8, 18, 9, 2);
const account = {
	provider: "anthropic",
	paused: true,
	pauseReason: "subscription_expired",
	identitySubscriptionCheckedAt: CHECKED,
	identityProfileFetchedAt: CHECKED,
} as Account;

function render(overrides: Partial<Account> = {}, checking = false) {
	return renderToStaticMarkup(
		<AccountAccessNotice
			account={{ ...account, ...overrides }}
			isChecking={checking}
			onRecheck={() => {}}
		/>,
	);
}

describe("AccountAccessNotice", () => {
	it("explains confirmed expiry, the pause, and recovery on the account", () => {
		const html = render();
		expect(html).toContain("Subscription expired · Paused");
		expect(html).toContain("Subscription access has ended");
		expect(html).toContain("Renew your subscription");
		expect(html).toContain("Last check attempted:");
		expect(html).toContain(new Date(CHECKED).toISOString());
		expect(html).toContain("Recheck access");
	});

	it("does not present an unexplained denial as expiry", () => {
		const html = render({ pauseReason: "usage_permission_denied" });
		expect(html).toContain("Access denied · Paused");
		expect(html).toContain("cause is unconfirmed");
		expect(html).not.toContain("Subscription expired");
	});

	it("identifies an unsuccessful profile check without presenting stale status as fresh", () => {
		const html = render({ identityProfileFetchedAt: CHECKED - 60_000 });
		expect(html).toContain(
			"Latest subscription check has not completed successfully",
		);
		expect(html).toContain("Last successful check:");
		expect(html).toContain(new Date(CHECKED - 60_000).toISOString());
	});

	it("does not invent a check timestamp", () => {
		const html = render({ identitySubscriptionCheckedAt: null });
		expect(html).not.toContain("Last check attempted:");
	});

	it("leaves manual pauses, active accounts, and other providers alone", () => {
		for (const overrides of [
			{ pauseReason: "manual" },
			{ paused: false },
			{ provider: "codex" },
		]) {
			expect(render(overrides)).toBe("");
		}
	});

	// The button's class list carries `disabled:` Tailwind variants whatever its
	// state, so only the attribute itself distinguishes one from the other.
	it("disables rechecking while a request is pending", () => {
		const html = render({}, true);
		expect(html).toContain('disabled=""');
		expect(html).toContain("Checking access…");
	});

	it("names the retry time and blocks rechecking while the usage endpoint is rate limited", () => {
		const until = Date.now() + 30 * 60_000;
		const html = render({ usageRateLimitedUntil: until });
		expect(html).toContain("Usage endpoint rate limited");
		expect(html).toContain(
			new Date(until).toLocaleTimeString(undefined, {
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			}),
		);
		expect(html).toContain('disabled=""');
	});

	it("allows rechecking once the retry time has passed", () => {
		const html = render({ usageRateLimitedUntil: Date.now() - 1000 });
		expect(html).not.toContain("Usage endpoint rate limited");
		expect(html).not.toContain('disabled=""');
	});
});
