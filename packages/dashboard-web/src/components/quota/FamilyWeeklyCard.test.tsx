import { describe, expect, it } from "bun:test";
import type { AccountResponse } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { type FamilyRow, listFamilyRows } from "../../lib/pool-usage";
import { FamilyWeeklyCard } from "./FamilyWeeklyCard";

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function scopedEntry(
	displayName: string,
	percent: number,
	resetMs: number = NOW + 3 * DAY,
) {
	return {
		kind: "weekly_scoped",
		group: "weekly",
		percent,
		resets_at: new Date(resetMs).toISOString(),
		scope: {
			model: {
				id: displayName.toLowerCase().replace(/\s+/g, "-"),
				display_name: displayName,
			},
		},
		is_active: true,
	};
}

function scopedAccount(
	name: string,
	entries: ReturnType<typeof scopedEntry>[],
	over: Partial<AccountResponse> = {},
): AccountResponse {
	return {
		id: name,
		name,
		provider: "anthropic",
		paused: false,
		rateLimitedUntil: null,
		tokenExpiresAt: null,
		hasRefreshToken: false,
		usageRateLimitedUntil: null,
		usageData: { limits: entries },
		...over,
	} as unknown as AccountResponse;
}

function render(rows: FamilyRow[], props: Record<string, unknown> = {}) {
	return renderToStaticMarkup(
		<FamilyWeeklyCard rows={rows} now={NOW} {...props} />,
	);
}

function rowsFor(accounts: AccountResponse[]) {
	return listFamilyRows(accounts, NOW);
}

describe("FamilyWeeklyCard", () => {
	it("states the least-used account's reading, its bars and its reset", () => {
		const html = render(
			rowsFor([
				scopedAccount("acct-a", [scopedEntry("Fable", 45)]),
				scopedAccount("acct-b", [scopedEntry("Fable", 20, NOW + DAY)]),
			]),
		);

		expect(html).toContain("Model limits");
		expect(html).toContain("Fable");
		// Routing picks ONE account, so the account with room is what decides
		// whether the next Fable request goes through — not the worst one.
		expect(html).toContain("20% used");
		expect(html).toContain("lowest · acct-b");
		expect(html).toContain("acct-a");
		expect(html).toContain("2 of 2 reporting");
		// The reset named is the SOONEST one, which here happens to be the same
		// account the headline names; the two are computed separately.
		expect(html).toContain("resets in 1d · acct-b");
		expect(html).toContain('aria-valuenow="45"');
		expect(html).toContain('aria-valuenow="20"');
		// Ascending, so the headline account is the first bar — as on the
		// servable-class cards.
		expect(html.indexOf('aria-valuenow="20"')).toBeLessThan(
			html.indexOf('aria-valuenow="45"'),
		);
	});

	it("says a family is spent rather than merely elevated", () => {
		const html = render(
			rowsFor([scopedAccount("a", [scopedEntry("Fable", 100)])]),
		);

		expect(html).toContain("Exhausted on 1 of 1");
	});

	it("names the percentage on an elevated family", () => {
		const html = render(
			rowsFor([scopedAccount("a", [scopedEntry("Fable", 92)])]),
		);

		expect(html).toContain("At 92%");
	});

	it("calls a family with room on pace", () => {
		const html = render(
			rowsFor([scopedAccount("a", [scopedEntry("Fable", 20)])]),
		);

		expect(html).toContain("On pace");
	});

	it("quantises the headline the way the chip thresholds do", () => {
		// 79.6%: the chip's threshold is a hard 80, so a rounded headline printed
		// "80% used" directly above a chip saying "On pace".
		const html = render(
			rowsFor([scopedAccount("a", [scopedEntry("Fable", 79.6)])]),
		);

		expect(html).toContain("79% used");
		expect(html).toContain("On pace");
		expect(html).not.toContain("80% used");
	});

	it("says who cannot report rather than hiding the family", () => {
		const html = render(
			rowsFor([
				scopedAccount("paused", [scopedEntry("Fable", 45)], { paused: true }),
			]),
		);

		expect(html).toContain("No reading");
		expect(html).toContain(
			"Reported only by 1 account that cannot serve right now",
		);
		expect(html).not.toContain("% used");
	});

	it("counts both sides of a mixed family", () => {
		const html = render(
			rowsFor([
				scopedAccount("live", [scopedEntry("Fable", 45)]),
				scopedAccount("paused", [scopedEntry("Fable", 90)], { paused: true }),
			]),
		);

		expect(html).toContain("1 of 2 reporting · 1 unavailable");
	});

	it("renders nothing at all when no family reports a cap", () => {
		expect(render([])).toBe("");
	});

	it("says nothing measured while the accounts read is in flight", () => {
		const html = render([], { loading: true });

		expect(html).toContain("Model limits");
		expect(html).not.toContain("% used");
	});

	it("reports a failed accounts read as unavailable", () => {
		const html = render([], { unavailableReason: "Account data unavailable" });

		expect(html).toContain("Account data unavailable");
	});
});
