import type { PaymentKind } from "@clankermux/types";
import { useEffect, useState } from "react";
import type { Account } from "../../api";
import { useCreatePayment } from "../../hooks/queries";
import { useApiError } from "../../hooks/useApiError";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";

interface RecordPaymentDialogProps {
	account: Account | null;
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
}

/** Local-calendar today as YYYY-MM-DD (en-CA renders without the UTC shift). */
function todayIso(): string {
	return new Date().toLocaleDateString("en-CA");
}

/**
 * Manual payments-ledger entry for an account: a subscription renewal or a
 * usage-credit purchase. Subscription entries for an already-recorded date
 * are upserted server-side; credits always insert a new row.
 */
export function RecordPaymentDialog({
	account,
	isOpen,
	onOpenChange,
}: RecordPaymentDialogProps) {
	const createPayment = useCreatePayment();
	const { formatError } = useApiError();
	const [kind, setKind] = useState<PaymentKind>("credits");
	const [paidDate, setPaidDate] = useState(todayIso);
	const [amount, setAmount] = useState("");
	const [notes, setNotes] = useState("");
	const [saveError, setSaveError] = useState<string | null>(null);

	// Reset fields when the account changes or the dialog reopens.
	useEffect(() => {
		if (account && isOpen) {
			setKind("credits");
			setPaidDate(todayIso());
			setAmount("");
			setNotes("");
			setSaveError(null);
		}
	}, [account, isOpen]);

	const amountUsd = Number.parseFloat(amount);
	const isValid =
		!!paidDate && Number.isFinite(amountUsd) && amountUsd > 0 && !!account;

	const handleSave = async () => {
		if (!isValid || !account) return;
		// Cleared on every attempt so a retry that succeeds cannot leave the
		// previous failure on screen, and a second failure reads as new.
		setSaveError(null);
		try {
			await createPayment.mutateAsync({
				accountId: account.id,
				kind,
				paidDate,
				amountUsd,
				notes: notes.trim() || undefined,
			});
			onOpenChange(false);
		} catch (error) {
			// The dialog stays open with everything typed still in it. Without this
			// the only signal was the Save button ceasing to spin: there is no toast
			// system and the mutation has no onError, so the failure was invisible.
			setSaveError(formatError(error));
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[425px]">
				<DialogHeader>
					<DialogTitle>Record Payment</DialogTitle>
					<DialogDescription>
						Add a payment to the ledger for {account?.name}. Subscription
						renewals with a configured price are recorded automatically — use
						this for credit purchases or missed renewals.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-group py-group">
					<div className="grid grid-cols-4 items-center gap-group">
						<Label htmlFor="payment-kind" className="text-right">
							Kind
						</Label>
						<Select
							value={kind}
							onValueChange={(value) => setKind(value as PaymentKind)}
						>
							<SelectTrigger id="payment-kind" className="col-span-3">
								<SelectValue placeholder="Select kind" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="credits">Usage credits</SelectItem>
								<SelectItem value="subscription">
									Subscription renewal
								</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<div className="grid grid-cols-4 items-center gap-group">
						<Label htmlFor="payment-date" className="text-right">
							Date
						</Label>
						<Input
							id="payment-date"
							type="date"
							value={paidDate}
							onChange={(e) => setPaidDate(e.target.value)}
							className="col-span-3"
						/>
					</div>
					<div className="grid grid-cols-4 items-center gap-group">
						<Label htmlFor="payment-amount" className="text-right">
							Amount USD
						</Label>
						<Input
							id="payment-amount"
							type="number"
							min={0}
							step={0.01}
							placeholder="e.g. 25.00"
							value={amount}
							onChange={(e) => setAmount(e.target.value)}
							className="col-span-3"
						/>
					</div>
					<div className="grid grid-cols-4 items-center gap-group">
						<Label htmlFor="payment-notes" className="text-right">
							Notes
						</Label>
						<Input
							id="payment-notes"
							placeholder="Optional"
							value={notes}
							onChange={(e) => setNotes(e.target.value)}
							className="col-span-3"
						/>
					</div>
				</div>
				{saveError && (
					<p role="alert" className="text-sm text-destructive-strong">
						{saveError}
					</p>
				)}
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						type="button"
						onClick={handleSave}
						disabled={!isValid || createPayment.isPending}
					>
						{createPayment.isPending ? "Saving..." : "Save"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
