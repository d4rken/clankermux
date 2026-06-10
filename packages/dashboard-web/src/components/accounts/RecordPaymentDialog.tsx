import type { PaymentKind } from "@clankermux/types";
import { useEffect, useState } from "react";
import type { Account } from "../../api";
import { useCreatePayment } from "../../hooks/queries";
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
	const [kind, setKind] = useState<PaymentKind>("credits");
	const [paidDate, setPaidDate] = useState(todayIso);
	const [amount, setAmount] = useState("");
	const [notes, setNotes] = useState("");

	// Reset fields when the account changes or the dialog reopens.
	useEffect(() => {
		if (account && isOpen) {
			setKind("credits");
			setPaidDate(todayIso());
			setAmount("");
			setNotes("");
		}
	}, [account, isOpen]);

	const amountUsd = Number.parseFloat(amount);
	const isValid =
		!!paidDate && Number.isFinite(amountUsd) && amountUsd > 0 && !!account;

	const handleSave = async () => {
		if (!isValid || !account) return;
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
			console.error("Failed to record payment:", error);
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
				<div className="grid gap-4 py-4">
					<div className="grid grid-cols-4 items-center gap-4">
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
					<div className="grid grid-cols-4 items-center gap-4">
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
					<div className="grid grid-cols-4 items-center gap-4">
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
					<div className="grid grid-cols-4 items-center gap-4">
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
