import type { AccountPayment, PaymentsSummary } from "@clankermux/types";
import { formatUsd } from "@clankermux/ui-common";
import { AlertCircle, Trash2 } from "lucide-react";
import { useState } from "react";
import { useDeletePayment } from "../../hooks/queries";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Skeleton } from "../ui/skeleton";

interface PaymentsHistoryCardProps {
	/** Most recent ledger entries (the summary endpoint returns up to 20). */
	payments: AccountPayment[];
	/**
	 * Calendar-month spend and the amortized run rate, for the header figures.
	 *
	 * Handed down rather than fetched: this page already loads the payments
	 * summary for the Account Performance card, and a second `usePaymentsSummary`
	 * here would be a second read of the same payload — with its own refresh
	 * clock, so the two cards could state different months' totals side by side.
	 */
	summary?: Pick<PaymentsSummary, "currentMonth" | "amortizedMonthlyUsd">;
	/**
	 * Set while the first payments-summary fetch is in flight and nothing is
	 * cached. An unread ledger renders the empty state otherwise, which says no
	 * payment has ever been recorded.
	 */
	loading?: boolean;
	/**
	 * Set when that read FAILED with nothing cached. Precedence is
	 * `unavailableReason` -> `loading` -> resolved.
	 */
	unavailableReason?: string;
}

/**
 * What the pool costs this month, over the ledger entries that make it up.
 *
 * The month figures used to sit in a band of their own on the Overview, which
 * put a spend claim on a page about pool capacity and left the ledger that
 * explains it two pages away. They belong on top of the rows they summarize.
 *
 * Amortized / day and / week are deliberately not repeated here: they already
 * sit under Account Performance › Cost on this same page.
 */
export function PaymentsHistoryCard({
	payments,
	summary,
	loading = false,
	unavailableReason,
}: PaymentsHistoryCardProps) {
	const pending = loading && unavailableReason == null;
	const currentMonth = summary?.currentMonth;
	// A breakdown of what the month's total is made of. Token cost only appears
	// when there is some: a "· token $0.00" tail on every plan-only month is
	// noise that reads as a measurement.
	const breakdownParts = currentMonth
		? [
				`subscriptions ${formatUsd(currentMonth.subscriptionUsd)}`,
				`credits ${formatUsd(currentMonth.creditsUsd)}`,
				...(currentMonth.tokenCostUsd > 0
					? [`token ${formatUsd(currentMonth.tokenCostUsd)}`]
					: []),
			]
		: [];
	// Nothing amortized and nothing on the ledger is the unconfigured state, not
	// a month of zero spend, and it is fixable in one place.
	const showConfigHint =
		summary != null &&
		summary.amortizedMonthlyUsd === 0 &&
		summary.currentMonth.ledgerUsd === 0;
	const deletePayment = useDeletePayment();
	const [confirmTarget, setConfirmTarget] = useState<AccountPayment | null>(
		null,
	);

	const handleConfirmDelete = async () => {
		if (!confirmTarget) return;
		try {
			await deletePayment.mutateAsync(confirmTarget.id);
			setConfirmTarget(null);
		} catch (error) {
			console.error("Failed to delete payment:", error);
		}
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle>Payments</CardTitle>
				<CardDescription>
					Recent subscription renewals and credit purchases
				</CardDescription>
				{/* Same headline markup as Account Performance's Plan Value / Cost
				    figures, so the two cards on this page read as one scale. Rendered
				    only once the summary has resolved: an unread payload has no month
				    total, and "$0.00" would be a claim it never made. */}
				{summary && currentMonth && (
					<div className="mt-row grid grid-cols-2 gap-group border-t pt-group">
						<div>
							<p className="text-sm text-muted-foreground">Spend this month</p>
							<p className="figure-xl">{formatUsd(currentMonth.totalUsd)}</p>
							<p className="mt-tight text-xs text-muted-foreground">
								{breakdownParts.join(" · ")}
							</p>
						</div>
						<div>
							<p className="text-sm text-muted-foreground">Amortized / month</p>
							<p
								className="figure-xl"
								title="Monthly subscription run rate from configured renewal prices"
							>
								{formatUsd(summary.amortizedMonthlyUsd)}
							</p>
						</div>
					</div>
				)}
				{showConfigHint && (
					<p className="mt-row text-xs text-muted-foreground">
						Set a renewal price on an account to track subscription spend.
					</p>
				)}
			</CardHeader>
			<CardContent>
				{unavailableReason != null ? (
					<p className="flex items-center gap-item text-sm text-warning-strong">
						<AlertCircle className="h-3.5 w-3.5 shrink-0" />
						{unavailableReason}
					</p>
				) : pending ? (
					<div className="divide-y">
						{[0, 1, 2].map((index) => (
							<div key={index} className="py-item">
								<Skeleton className="h-5 w-full" />
							</div>
						))}
					</div>
				) : payments.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No payments recorded yet. Subscription renewals are recorded
						automatically once an account has a renewal price; use "Record
						Payment" on an account to add credit purchases.
					</p>
				) : (
					<div className="divide-y">
						{payments.map((payment) => (
							<div
								key={payment.id}
								className="flex items-center gap-row py-item text-sm"
								title={payment.notes ?? undefined}
							>
								<span className="text-muted-foreground tabular-nums shrink-0">
									{payment.paidDate}
								</span>
								<span className="truncate min-w-0 flex-1">
									{payment.accountName}
								</span>
								<Badge
									variant={
										payment.kind === "subscription" ? "secondary" : "outline"
									}
								>
									{payment.kind === "subscription" ? "Subscription" : "Credits"}
								</Badge>
								{payment.source !== "manual" && (
									<span className="text-xs text-muted-foreground shrink-0">
										{payment.source}
									</span>
								)}
								<span className="font-medium tabular-nums shrink-0">
									{formatUsd(payment.amountUsd)}
								</span>
								<Button
									variant="ghost"
									size="sm"
									className="h-7 w-7 p-0 shrink-0"
									title="Delete payment"
									onClick={() => setConfirmTarget(payment)}
								>
									<Trash2 className="h-3.5 w-3.5" />
								</Button>
							</div>
						))}
					</div>
				)}
			</CardContent>
			<Dialog
				open={confirmTarget !== null}
				onOpenChange={(open) => {
					if (!open) setConfirmTarget(null);
				}}
			>
				<DialogContent className="sm:max-w-[425px]">
					<DialogHeader>
						<DialogTitle>Delete payment?</DialogTitle>
						<DialogDescription>
							{confirmTarget
								? `Remove the ${confirmTarget.kind} payment of ${formatUsd(
										confirmTarget.amountUsd,
									)} for ${confirmTarget.accountName} (${confirmTarget.paidDate}) from the ledger.`
								: ""}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setConfirmTarget(null)}
						>
							Cancel
						</Button>
						<Button
							type="button"
							variant="destructive"
							onClick={handleConfirmDelete}
							disabled={deletePayment.isPending}
						>
							{deletePayment.isPending ? "Deleting..." : "Delete"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</Card>
	);
}
