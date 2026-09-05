/**
 * The month figures in the Payments card header.
 *
 * They moved here from a band on the Overview, and the move is only an
 * improvement if they keep saying exactly what they said: a total with the
 * breakdown that explains it, a run rate that is labelled as one, and — the
 * part a `?? 0` would quietly destroy — nothing at all while the read that
 * produces them has not resolved.
 */
import { describe, expect, it } from "bun:test";
import type { PaymentsSummary } from "@clankermux/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { PaymentsHistoryCard } from "./PaymentsHistoryCard";

type Summary = Pick<PaymentsSummary, "currentMonth" | "amortizedMonthlyUsd">;

function summary(over: Partial<Summary> = {}): Summary {
	return {
		amortizedMonthlyUsd: 600,
		currentMonth: {
			ledgerUsd: 400,
			subscriptionUsd: 300,
			creditsUsd: 100,
			tokenCostUsd: 0,
			totalUsd: 400,
		},
		...over,
	};
}

function render(props: Parameters<typeof PaymentsHistoryCard>[0]): string {
	// The delete button's mutation hook needs a client even though nothing here
	// fires it.
	return renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<PaymentsHistoryCard {...props} />
		</QueryClientProvider>,
	);
}

describe("PaymentsHistoryCard month figures", () => {
	it("states the month total with the breakdown that explains it", () => {
		const html = render({ payments: [], summary: summary() });

		expect(html).toContain("Spend this month");
		expect(html).toContain("$400.00");
		expect(html).toContain("subscriptions $300.00");
		expect(html).toContain("credits $100.00");
		expect(html).toContain("Amortized / month");
		expect(html).toContain("$600.00");
	});

	it("names token cost only when there is some", () => {
		expect(render({ payments: [], summary: summary() })).not.toContain(
			"token ",
		);

		const withTokens = render({
			payments: [],
			summary: summary({
				currentMonth: {
					ledgerUsd: 400,
					subscriptionUsd: 300,
					creditsUsd: 100,
					tokenCostUsd: 12.5,
					totalUsd: 412.5,
				},
			}),
		});
		expect(withTokens).toContain("token $12.50");
	});

	it("offers the configuration hint only when nothing is configured at all", () => {
		// Zero amortized AND an empty ledger is the unconfigured state. Either one
		// alone is a real reading and must not be explained away.
		const unconfigured = render({
			payments: [],
			summary: summary({
				amortizedMonthlyUsd: 0,
				currentMonth: {
					ledgerUsd: 0,
					subscriptionUsd: 0,
					creditsUsd: 0,
					tokenCostUsd: 0,
					totalUsd: 0,
				},
			}),
		});
		expect(unconfigured).toContain("Set a renewal price on an account");

		const spentButUnpriced = render({
			payments: [],
			summary: summary({ amortizedMonthlyUsd: 0 }),
		});
		expect(spentButUnpriced).not.toContain("Set a renewal price on an account");

		expect(render({ payments: [], summary: summary() })).not.toContain(
			"Set a renewal price on an account",
		);
	});

	it("states no figure at all while the summary has not arrived", () => {
		// "$0.00" for an unread payload is indistinguishable from a month with no
		// spend, which is the one claim a pending read is not entitled to make.
		const html = render({ payments: [], loading: true });

		expect(html).not.toContain("Spend this month");
		expect(html).not.toContain("Amortized / month");
		// The card itself is still there, in its skeleton state.
		expect(html).toContain("Payments");
		expect(html).toContain("animate-pulse");
	});

	it("states no figure when the read failed outright", () => {
		const html = render({
			payments: [],
			unavailableReason: "Payments data unavailable",
		});

		expect(html).toContain("Payments data unavailable");
		expect(html).not.toContain("Spend this month");
	});
});
