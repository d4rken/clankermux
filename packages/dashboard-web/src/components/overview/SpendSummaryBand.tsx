import { formatUsd } from "@clankermux/ui-common";
import { usePaymentsSummary } from "../../hooks/queries";
import { Card, CardContent } from "../ui/card";
import { Skeleton } from "../ui/skeleton";

/**
 * Full-width spend summary band on the Overview tab: calendar-month ledger
 * spend (subscriptions + credits + token-billed cost) plus the amortized
 * day/week/month run rates derived from configured renewal prices. The
 * `currentMonth` and amortized fields are range-independent, so a fixed 30d
 * summary fetch is enough.
 */
export function SpendSummaryBand() {
	const { data: summary, isLoading } = usePaymentsSummary("30d");

	if (isLoading && !summary) {
		return (
			<Card>
				<CardContent className="p-6">
					<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
						{["month", "day", "week", "amortized-month"].map((key) => (
							<div key={key}>
								<Skeleton className="h-4 w-24 mb-2" />
								<Skeleton className="h-8 w-28" />
							</div>
						))}
					</div>
				</CardContent>
			</Card>
		);
	}

	if (!summary) return null;

	const { currentMonth } = summary;
	const showConfigHint =
		summary.amortizedMonthlyUsd === 0 && currentMonth.ledgerUsd === 0;

	const breakdownParts = [
		`subscriptions ${formatUsd(currentMonth.subscriptionUsd)}`,
		`credits ${formatUsd(currentMonth.creditsUsd)}`,
	];
	if (currentMonth.tokenCostUsd > 0) {
		breakdownParts.push(`token ${formatUsd(currentMonth.tokenCostUsd)}`);
	}

	const amortizedColumns = [
		{ label: "Amortized / day", value: summary.amortizedDailyUsd },
		{ label: "Amortized / week", value: summary.amortizedWeeklyUsd },
		{ label: "Amortized / month", value: summary.amortizedMonthlyUsd },
	];

	return (
		<Card>
			<CardContent className="p-6">
				<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
					<div>
						<p className="text-sm text-muted-foreground">Spend this month</p>
						<p className="text-2xl font-bold">
							{formatUsd(currentMonth.totalUsd)}
						</p>
						<p className="mt-1 text-xs text-muted-foreground">
							{breakdownParts.join(" · ")}
						</p>
					</div>
					{amortizedColumns.map((col) => (
						<div key={col.label}>
							<p className="text-sm text-muted-foreground">{col.label}</p>
							<p className="text-2xl font-bold">{formatUsd(col.value)}</p>
						</div>
					))}
				</div>
				{showConfigHint && (
					<p className="mt-3 text-xs text-muted-foreground">
						Set a renewal price on an account to track subscription spend.
					</p>
				)}
			</CardContent>
		</Card>
	);
}
