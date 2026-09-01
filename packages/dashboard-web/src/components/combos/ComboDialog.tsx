import { useState } from "react";
import { useCreateCombo, useGetCombo } from "../../hooks/queries";
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
import { InsetPanel } from "../ui/inset-panel";
import { Label } from "../ui/label";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { ComboSlotBuilder } from "./ComboSlotBuilder";

interface ComboDialogProps {
	isOpen: boolean;
	onClose: () => void;
	comboId?: string | null;
}

export function ComboDialog({ isOpen, onClose, comboId }: ComboDialogProps) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [enabled, setEnabled] = useState(true);

	const createCombo = useCreateCombo();
	const comboQuery = useGetCombo(comboId ?? null);
	const combo = comboQuery.data?.combo;

	const isEditMode = !!comboId;

	const handleCreate = () => {
		if (!name.trim()) return;

		createCombo.mutate(
			{
				name: name.trim(),
				description: description.trim() || undefined,
				enabled,
			},
			{
				onSuccess: () => {
					setName("");
					setDescription("");
					setEnabled(true);
					onClose();
				},
			},
		);
	};

	const handleClose = () => {
		setName("");
		setDescription("");
		setEnabled(true);
		onClose();
	};

	const isNameValid = name.trim().length > 0 && name.trim().length <= 100;

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
			<DialogContent className="flex max-h-[90vh] max-w-lg flex-col overflow-hidden">
				<DialogHeader>
					<DialogTitle>
						{isEditMode ? "Edit Routing Chain" : "Create Routing Chain"}
					</DialogTitle>
					<DialogDescription>
						{isEditMode
							? "Manage slots and settings for this routing chain"
							: "Define a new fallback chain for model families"}
					</DialogDescription>
				</DialogHeader>

				{isEditMode ? (
					<div className="min-h-0 flex-1 space-y-group overflow-y-auto py-item">
						{comboQuery.isLoading && (
							<div aria-busy="true" className="space-y-item">
								<span className="sr-only" role="status">
									Loading routing chain
								</span>
								{/* Stands in for the slot-builder Card at its minimum, which
								    is what a chain with no slots renders: 1px of border top
								    and bottom (2), a `p-4 pb-item` header whose tallest child
								    is the size="sm" Add Slot button (16 + 32 + 8 = 56), and a
								    `p-4 pt-0` body around the `py-item` empty-slots line
								    (8 + 20 + 8 + 16 = 52). 2 + 56 + 52 = 110px. A chain WITH
								    slots is taller, so this is a floor, not a match. */}
								<Skeleton className="h-[6.875rem] w-full rounded-lg" />
							</div>
						)}
						{combo && <ComboSlotBuilder combo={combo} />}
					</div>
				) : (
					<div className="space-y-group py-item">
						<div className="space-y-item">
							<Label htmlFor="combo-name">Name</Label>
							<Input
								id="combo-name"
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="My Routing Chain"
								maxLength={100}
							/>
						</div>

						<div className="space-y-item">
							<Label htmlFor="combo-description">Description</Label>
							<Input
								id="combo-description"
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								placeholder="Optional description"
							/>
						</div>

						{/* Exact class match for what this rendered by hand, plus the
						    `bg-muted/30` surface step it was always meant to have. */}
						<InsetPanel className="flex items-center justify-between">
							<Label htmlFor="combo-enabled" className="cursor-pointer">
								Enabled
							</Label>
							<Switch
								id="combo-enabled"
								checked={enabled}
								onCheckedChange={setEnabled}
							/>
						</InsetPanel>

						<p className="text-xs text-muted-foreground">
							Slots can be configured after creation.
						</p>
					</div>
				)}

				{createCombo.isError && (
					<Alert
						tone="destructive"
						size="sm"
						title="Failed to create routing chain. Please try again."
					/>
				)}

				<DialogFooter>
					<Button
						variant="outline"
						onClick={handleClose}
						disabled={createCombo.isPending}
					>
						{isEditMode ? "Close" : "Cancel"}
					</Button>
					{!isEditMode && (
						<Button
							onClick={handleCreate}
							disabled={!isNameValid || createCombo.isPending}
						>
							{createCombo.isPending ? "Creating..." : "Create"}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
