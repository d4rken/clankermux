import type { AccountPayment, PaymentsSummary } from "@clankermux/types";
import { formatUsd } from "@clankermux/ui-common";
import { AlertCircle, Trash2 } from "lucide-react";
import { useState } from "react";
import { useDeletePayment } from "../../hooks/queries";
import { useApiError } from "../../hooks/useApiError";
import { CostCoverageNote, formatKnownCost } from "../CostCoverage";
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
	// Payments and usage are separate: prepaid credits must not be counted twice.
	const breakdownParts = currentMonth
		? [
				`subscriptions ${formatUsd(currentMonth.subscriptionUsd)}`,
				`credits ${formatUsd(currentMonth.creditsUsd)}`,
			]
		: [];
	// Nothing amortized and nothing on the ledger is the unconfigured state, not
	// a month of zero spend, and it is fixable in one place.
	const showConfigHint =
		summary != null &&
		summary.amortizedMonthlyUsd === 0 &&
		summary.currentMonth.ledgerUsd === 0;
	const deletePayment = useDeletePayment();
	// Target and error in ONE piece of state: they must move together, or a
	// confirm opened for a different payment inherits the previous failure.
	const [confirm, setConfirm] = useState<{
		target: AccountPayment;
		error: string | null;
	} | null>(null);

	const { formatError } = useApiError();

	const handleConfirmDelete = async () => {
		if (!confirm) return;
		// Captured because Cancel and Escape stay live while the request is in
		// flight. Without it, a rejection landing after the operator dismissed
		// this confirm and opened another would publish its message against the
		// wrong payment, and a late success would close the wrong one. Every
		// settlement below is applied only if this is still the open target.
		const target = confirm.target.id;
		setConfirm((current) => (current ? { ...current, error: null } : current));
		try {
			await deletePayment.mutateAsync(target);
			setConfirm((current) => (current?.target.id === target ? null : current));
		} catch (error) {
			// The confirm stays open and says why. Previously it just sat there
			// looking inert, which reads as "nothing happened" rather than "that
			// failed".
			const message = formatError(error);
			setConfirm((current) =>
				current?.target.id === target
					? { ...current, error: message }
					: current,
			);
		}
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle>Payments</CardTitle>
				<CardDescription>
					Recorded subscription renewals and credit purchases. Automatic entries
					follow the renewal schedule and do not confirm payment.
				</CardDescription>
				{/* Same headline markup as Account Performance's Plan Value / Cost
				    figures, so the two cards on this page read as one scale. Rendered
				    only once the summary has resolved: an unread payload has no month
				    total, and "$0.00" would be a claim it never made. */}
				{summary && currentMonth && (
					<div className="mt-row grid grid-cols-1 sm:grid-cols-3 gap-group border-t pt-group">
						<div>
							<p className="text-sm text-muted-foreground">
								Recorded payments this month
							</p>
							<p className="figure-xl">{formatUsd(currentMonth.ledgerUsd)}</p>
							<p className="mt-tight text-xs text-muted-foreground">
								{breakdownParts.join(" · ")}
							</p>
						</div>
						<div>
							<p className="text-sm text-muted-foreground">
								API usage cost this month
							</p>
							<p className="figure-xl">
								{formatKnownCost(
									currentMonth.tokenCostUsd,
									currentMonth.apiCostCoverage,
								)}
							</p>
							<p className="mt-tight text-xs text-muted-foreground">
								<CostCoverageNote coverage={currentMonth.apiCostCoverage} />
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
										{payment.source === "auto" ? "scheduled" : payment.source}
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
									onClick={() => setConfirm({ target: payment, error: null })}
								>
									<Trash2 className="h-3.5 w-3.5" />
								</Button>
							</div>
						))}
					</div>
				)}
			</CardContent>
			<Dialog
				open={confirm !== null}
				onOpenChange={(open) => {
					if (!open) setConfirm(null);
				}}
			>
				<DialogContent className="sm:max-w-[425px]">
					<DialogHeader>
						<DialogTitle>Delete payment?</DialogTitle>
						<DialogDescription>
							{confirm
								? `Remove the ${confirm.target.kind} payment of ${formatUsd(
										confirm.target.amountUsd,
									)} for ${confirm.target.accountName} (${confirm.target.paidDate}) from the ledger.`
								: ""}
						</DialogDescription>
					</DialogHeader>
					{confirm?.error && (
						<p role="alert" className="text-sm text-destructive-strong">
							{confirm.error}
						</p>
					)}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setConfirm(null)}
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
