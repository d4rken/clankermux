import { AlertCircle } from "lucide-react";
import { Alert } from "../ui/alert";
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

interface DeleteConfirmationDialogProps {
	isOpen: boolean;
	accountName: string;
	confirmInput: string;
	/** True while the removal request is in flight. Closes every dismissal path. */
	isDeleting?: boolean;
	onConfirmInputChange: (value: string) => void;
	onConfirm: () => void;
	onClose: () => void;
}

export function DeleteConfirmationDialog({
	isOpen,
	accountName,
	confirmInput,
	isDeleting = false,
	onConfirmInputChange,
	onConfirm,
	onClose,
}: DeleteConfirmationDialogProps) {
	return (
		<Dialog
			open={isOpen}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent
				closeDisabled={isDeleting}
				// Escape and an outside click only became dismissal paths when this
				// moved onto the Dialog primitive, and mid-request they are a race:
				// the removal continues regardless, so a dialog reopened for another
				// account would inherit the first request's completion. Both are held
				// shut while a deletion is in flight, alongside the two buttons and
				// the corner close.
				onEscapeKeyDown={(event) => {
					if (isDeleting) event.preventDefault();
				}}
				onPointerDownOutside={(event) => {
					if (isDeleting) event.preventDefault();
				}}
			>
				<DialogHeader>
					<DialogTitle>Confirm Account Removal</DialogTitle>
					<DialogDescription>This action cannot be undone.</DialogDescription>
				</DialogHeader>
				<Alert
					tone="destructive"
					size="md"
					icon={<AlertCircle className="h-5 w-5" />}
					title="Warning"
				>
					<p>
						You are about to permanently remove the account '{accountName}'.
						This will delete all associated data and cannot be recovered.
					</p>
				</Alert>
				<div className="space-y-item">
					<Label htmlFor="confirm-input">
						Type <span className="font-mono font-semibold">{accountName}</span>{" "}
						to confirm:
					</Label>
					<Input
						id="confirm-input"
						value={confirmInput}
						onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
							onConfirmInputChange((e.target as HTMLInputElement).value)
						}
						placeholder="Enter account name"
						autoComplete="off"
					/>
				</div>
				{/* Cancel first, Delete second — DialogFooter is
				    `flex-col-reverse sm:flex-row sm:justify-end`, so this is the DOM
				    order every other dialog in the app uses to put Cancel left and
				    the primary action right. This one used to invert it and place
				    the destructive button where muscle memory expects Cancel. */}
				<DialogFooter>
					<Button variant="outline" onClick={onClose} disabled={isDeleting}>
						Cancel
					</Button>
					<Button
						variant="destructive"
						onClick={onConfirm}
						disabled={isDeleting || confirmInput !== accountName}
					>
						Delete Account
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
