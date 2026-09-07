import { describe, expect, it } from "bun:test";
import { type FamilyRow, listFamilyRows } from "@clankermux/core";
import type { AccountResponse } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { buildQuotaSummary } from "../../lib/quota-summary";
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

/**
 * Like {@link scopedAccount} but with the account-wide windows the "has not used
 * this family" classification needs: the week the missing entry would belong to
 * has to still be running for its absence to mean anything.
 */
function windowedAccount(
	name: string,
	entries: ReturnType<typeof scopedEntry>[],
	over: Partial<AccountResponse> = {},
): AccountResponse {
	return scopedAccount(name, entries, {
		usageData: {
			five_hour: { utilization: 10, resets_at: null },
			seven_day: {
				utilization: 20,
				resets_at: new Date(NOW + 3 * DAY).toISOString(),
			},
			limits: entries,
		},
		...over,
	} as unknown as Partial<AccountResponse>);
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
	it("discloses an account whose family burn is not measured yet", () => {
		// 1% used 623 s after the scoped window opened extrapolates to a run-out
		// inside the week. Withheld from `atRiskCount` and said out loud here, so
		// the card does not read as "nothing is projected to hit the cap".
		const rows = rowsFor([
			scopedAccount("alpha", [
				scopedEntry("Claude Fable 5", 1, NOW - 623_000 + 7 * DAY),
			]),
		]);
		const html = render(rows);

		expect(html).toContain("1 not yet projectable");
		expect(html).not.toContain("projected to hit the cap before reset");
	});

	it("states average quota used, its bars and its reset", () => {
		const html = render(
			rowsFor([
				scopedAccount("acct-a", [scopedEntry("Fable", 45)]),
				scopedAccount("acct-b", [scopedEntry("Fable", 20, NOW + DAY)]),
			]),
		);

		expect(html).toContain("Model limits");
		expect(html).toContain("Fable");
		// Average the quota used without naming one account as the headline.
		expect(html).toContain("32% used");
		expect(html).toContain("average across 2 accounts");
		expect(html).not.toContain("lowest ·");
		expect(html).toContain("acct-a");
		expect(html).toContain("2 of 2 reporting");
		// The reset named is the soonest one across the accounts.
		expect(html).toContain("resets in 1d · acct-b");
		expect(html).toContain('aria-valuenow="45"');
		expect(html).toContain('aria-valuenow="20"');
		// Name order stays fixed as the readings change.
		expect(html.indexOf('aria-valuenow="45"')).toBeLessThan(
			html.indexOf('aria-valuenow="20"'),
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

	it("floors utilization consistently in the headline and bars", () => {
		const html = render(
			rowsFor([scopedAccount("a", [scopedEntry("Fable", 79.6)])]),
		);

		expect(html).toContain("79% used");
		expect(html).toContain("On pace");
		expect(html).not.toContain("lowest ·");
	});

	it("says who cannot report rather than hiding the family", () => {
		const html = render(
			rowsFor([
				scopedAccount("paused", [scopedEntry("Fable", 45)], { paused: true }),
			]),
		);

		expect(html).toContain("Unavailable");
		expect(html).toContain("45% used");
		expect(html).toContain("1 unavailable");
		expect(html).toContain('aria-valuetext="paused: 45% used · paused"');
		expect(html).not.toContain("lowest ·");
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

	it("counts accounts that have not used the family this week", () => {
		// The sibling can serve Fable and simply has not touched it, so it is
		// neither a reporter nor unavailable. Leaving it out of the denominator
		// made "1 of 1 reporting" describe a two-account pool.
		const html = render(
			rowsFor([
				windowedAccount("reporter", [scopedEntry("Fable", 45)]),
				windowedAccount("untouched", []),
			]),
		);

		expect(html).toContain("1 of 2 reporting · 1 not used this week");
		expect(html).not.toContain("unavailable");
	});

	for (const idle of [false, true]) {
		it(`includes ${idle ? "idle" : "omitted"} zero-use accounts in the headline, bars and exhaustion count`, () => {
			const entries = idle
				? [{ ...scopedEntry("Fable", 0), resets_at: null, is_active: false }]
				: [];
			const html = render(
				rowsFor([
					windowedAccount("Claude-2", [scopedEntry("Fable", 73)]),
					windowedAccount("Claude-3", [scopedEntry("Fable", 99)]),
					windowedAccount("Claude-4", [scopedEntry("Fable", 40)]),
					windowedAccount("Claude-5", [scopedEntry("Fable", 100)]),
					windowedAccount(
						"Claude-1",
						entries as ReturnType<typeof scopedEntry>[],
					),
				]),
			);

			expect(html).toContain('class="figure-xl text-success-strong">62% used');
			expect(html).toContain("average across 5 accounts");
			expect(html).toContain("Exhausted on 1 of 5");
			expect(html).toContain("4 of 5 reporting · 1 not used this week");
			expect(html).toContain('aria-valuetext="Claude-1: 0% used"');
			expect(html.match(/role="progressbar"/g)).toHaveLength(5);
			expect(html.indexOf('aria-valuenow="0"')).toBeLessThan(
				html.indexOf('aria-valuenow="40"'),
			);
		});
	}

	it("shows unused capacity when nobody who reports can serve", () => {
		// Weekly exhaustion affects availability, while both scoped readings
		// still contribute to average usage model quota.
		const html = render(
			rowsFor([
				windowedAccount("spent-reporter", [scopedEntry("Fable", 45)], {
					usageData: {
						five_hour: { utilization: 10, resets_at: null },
						seven_day: {
							utilization: 100,
							resets_at: new Date(NOW + 3 * DAY).toISOString(),
						},
						limits: [scopedEntry("Fable", 45)],
					},
				} as unknown as Partial<AccountResponse>),
				windowedAccount("untouched", []),
			]),
		);

		expect(html).toContain("Unused capacity");
		expect(html).toContain("22% used");
		expect(html).toContain("average across 2 accounts");
		expect(html).toContain(
			"0 of 2 reporting · 1 not used this week · 1 unavailable",
		);
		expect(html).not.toContain("resets in");
		expect(html).not.toContain("projected");
	});

	for (const percent of [0, 30]) {
		it(`keeps Claud1 visible at ${percent}% during a five-hour block and after recovery`, () => {
			const entries = percent === 0 ? [] : [scopedEntry("Fable", percent)];
			const active = windowedAccount("Claud1", entries);
			const blocked = {
				...active,
				usageData: {
					...active.usageData,
					five_hour: {
						utilization: 100,
						resets_at: new Date(NOW + HOUR).toISOString(),
					},
				},
			} as AccountResponse;
			const sibling = windowedAccount("Claud2", [scopedEntry("Fable", 45)]);
			const html = render(rowsFor([sibling, blocked]));
			expect(html).toContain(
				`aria-valuetext="Claud1: ${percent}% used · 5h spent"`,
			);
			expect(html).toContain("bg-muted-foreground/30");
			expect(html).toContain(`${Math.floor((percent + 45) / 2)}% used`);
			expect(html).toContain("1 of 2 reporting · 1 unavailable");
			expect(html.match(/role="progressbar"/g)).toHaveLength(2);

			const recovered = render(rowsFor([sibling, active]));
			expect(recovered).toContain(`aria-valuetext="Claud1: ${percent}% used"`);
			expect(recovered).not.toContain("5h spent");
			expect(recovered).toContain(`${Math.floor((percent + 45) / 2)}% used`);
			expect(recovered.match(/role="progressbar"/g)).toHaveLength(2);
			const summaryBlocked = render(rowsFor([sibling, blocked]), {
				summaryRows: buildQuotaSummary([sibling, blocked], NOW),
			});
			const summaryRecovered = render(rowsFor([sibling, active]), {
				summaryRows: buildQuotaSummary([sibling, active], NOW),
			});
			expect(summaryBlocked).toContain(
				`aria-valuetext="Claud1: ${percent}% used · 5h limit reached"`,
			);
			expect(summaryBlocked).toContain(
				`${Math.floor((percent + 45) / 2)}% used`,
			);
			expect(summaryRecovered).toContain(
				`${Math.floor((percent + 45) / 2)}% used`,
			);
			expect(summaryBlocked.indexOf("Claud1")).toBeLessThan(
				summaryBlocked.indexOf("Claud2"),
			);
			expect(summaryRecovered.indexOf("Claud1")).toBeLessThan(
				summaryRecovered.indexOf("Claud2"),
			);
		});
	}

	it("shows every blocked row when no account can serve", () => {
		const html = render(
			rowsFor([
				windowedAccount("reporter", [scopedEntry("Fable", 45)], {
					rateLimitedUntil: NOW + HOUR,
				}),
				windowedAccount("untouched", [], { paused: true }),
			]),
		);
		expect(html).toContain("22% used");
		expect(html).toContain("2 unavailable");
		expect(html).toContain(
			'aria-valuetext="reporter: 45% used · cooling down"',
		);
		expect(html).toContain('aria-valuetext="untouched: 0% used · paused"');
		expect(html).not.toContain("lowest ·");
		expect(html).not.toContain("Unused capacity");
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

describe("FamilyWeeklyCard configured model membership", () => {
	it("includes paused accounts in the average and keeps their reading gray", () => {
		const accounts = [
			windowedAccount("Claud2", [scopedEntry("Fable", 80)]),
			windowedAccount("Claud1", [scopedEntry("Fable", 20)], { paused: true }),
		];
		const html = render(rowsFor(accounts), {
			summaryRows: buildQuotaSummary(accounts, NOW),
		});
		expect(html).toContain("50% used");
		expect(html).toContain("average across 2 accounts");
		expect(html).toContain('aria-valuetext="Claud1: 20% used · Paused"');
		expect(html).toContain("bg-muted-foreground/30");
		expect(html.indexOf("Claud1")).toBeLessThan(html.indexOf("Claud2"));
	});
	it("retains history-only models and unknown accounts without shrinking the average", () => {
		const accounts = [
			windowedAccount("Claud1", []),
			scopedAccount("Claud2", [], { usageData: null }),
		];
		const history = {
			families: [
				{
					family: "fable",
					displayName: "Fable",
					series: [{ accountId: "Claud1", points: [] }],
				},
			],
		} as unknown as Parameters<typeof buildQuotaSummary>[2];
		const html = render([], {
			summaryRows: buildQuotaSummary(accounts, NOW, history),
		});
		expect(html).toContain("Fable");
		expect(html).toContain("1 of 2 quota readings");
		expect(html).toContain("Claud2");
		expect(html).not.toContain('class="figure-xl text-success-strong">0% used');
		expect(html.match(/role="progressbar"/g)).toHaveLength(2);
	});
});
