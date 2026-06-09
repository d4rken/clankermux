import { useEffect, useState } from "react";
import type { Account } from "../../api";
import type { RenewalCadence } from "../../lib/renewal";
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

interface AccountRenewalDialogProps {
	account: Account | null;
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	onUpdateRenewal: (
		accountId: string,
		anchor: string | null,
		cadence: RenewalCadence,
	) => Promise<void>;
}

export function AccountRenewalDialog({
	account,
	isOpen,
	onOpenChange,
	onUpdateRenewal,
}: AccountRenewalDialogProps) {
	const [anchor, setAnchor] = useState(account?.renewalAnchor ?? "");
	const [cadence, setCadence] = useState<RenewalCadence>(
		account?.renewalCadence ?? "monthly",
	);
	const [isUpdating, setIsUpdating] = useState(false);

	// Reset fields when the account changes or the dialog opens.
	useEffect(() => {
		if (account) {
			setAnchor(account.renewalAnchor ?? "");
			setCadence(account.renewalCadence ?? "monthly");
		}
	}, [account]);

	const hasAnchorSet = !!account?.renewalAnchor;

	const handleSave = async () => {
		if (!account) return;
		const anchorOrNull = anchor.trim() === "" ? null : anchor;
		setIsUpdating(true);
		try {
			await onUpdateRenewal(account.id, anchorOrNull, cadence);
			onOpenChange(false);
		} catch (error) {
			console.error("Failed to update renewal date:", error);
		} finally {
			setIsUpdating(false);
		}
	};

	const handleClear = async () => {
		if (!account) return;
		setIsUpdating(true);
		try {
			await onUpdateRenewal(account.id, null, "none");
			onOpenChange(false);
		} catch (error) {
			console.error("Failed to clear renewal date:", error);
		} finally {
			setIsUpdating(false);
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[425px]">
				<DialogHeader>
					<DialogTitle>Set Renewal Date</DialogTitle>
					<DialogDescription>
						Set the subscription renewal date for {account?.name}. The Accounts
						page shows a chip that turns amber as renewal approaches and red
						when it is imminent.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-4 py-4">
					<div className="grid grid-cols-4 items-center gap-4">
						<Label htmlFor="renewal-anchor" className="text-right">
							Date
						</Label>
						<Input
							id="renewal-anchor"
							type="date"
							value={anchor}
							onChange={(e) => setAnchor(e.target.value)}
							className="col-span-3"
						/>
					</div>
					<div className="grid grid-cols-4 items-center gap-4">
						<Label htmlFor="renewal-cadence" className="text-right">
							Repeats
						</Label>
						<Select
							value={cadence}
							onValueChange={(value) => setCadence(value as RenewalCadence)}
						>
							<SelectTrigger id="renewal-cadence" className="col-span-3">
								<SelectValue placeholder="Select cadence" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="monthly">Monthly</SelectItem>
								<SelectItem value="yearly">Yearly</SelectItem>
								<SelectItem value="none">One-time</SelectItem>
							</SelectContent>
						</Select>
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
						variant="outline"
						onClick={handleClear}
						disabled={isUpdating || !hasAnchorSet}
					>
						Clear
					</Button>
					<Button type="button" onClick={handleSave} disabled={isUpdating}>
						{isUpdating ? "Saving..." : "Save"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
