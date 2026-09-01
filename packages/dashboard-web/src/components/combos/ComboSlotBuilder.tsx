import type { ComboSlot, ComboWithSlots } from "@clankermux/types";
import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
	useAccounts,
	useAddComboSlot,
	useFamilies,
	useRemoveComboSlot,
	useReorderComboSlots,
} from "../../hooks/queries";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { InsetPanel } from "../ui/inset-panel";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";

interface SortableSlotRowProps {
	slot: ComboSlot;
	comboId: string;
	index: number;
	accountName: string;
	provider: string;
	onRemove: () => void;
	isRemoving: boolean;
}

function SortableSlotRow({
	slot,
	index,
	accountName,
	provider,
	onRemove,
	isRemoving,
}: SortableSlotRowProps) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: slot.id });

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : 1,
	};

	return (
		// `setNodeRef` and the transform `style` MUST stay on the same element:
		// dnd-kit measures the node it was given and positions it with that
		// transform, so a wrapper between them breaks drag positioning silently.
		// InsetPanel forwards its ref and spreads props, so it satisfies that; a
		// plain wrapper <div> would not. The row carried `bg-card` inside a Card,
		// which is no surface step at all.
		<InsetPanel
			ref={setNodeRef}
			style={style}
			className="flex items-center gap-item"
		>
			<span className="w-4 shrink-0 text-center text-xs font-medium text-muted-foreground">
				{index}
			</span>
			<button
				type="button"
				className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
				{...attributes}
				{...listeners}
			>
				<GripVertical className="h-4 w-4" />
			</button>

			<div className="flex min-w-0 flex-1 items-center gap-item">
				<Badge variant="secondary" className="shrink-0">
					{provider}
				</Badge>
				<span className="truncate text-sm font-medium">{accountName}</span>
			</div>

			<span className="shrink-0 font-mono text-xs text-muted-foreground">
				{slot.model}
			</span>

			<Button
				variant="ghost"
				size="sm"
				onClick={onRemove}
				disabled={isRemoving}
				className="shrink-0 text-destructive-strong hover:text-destructive-strong"
			>
				<Trash2 className="h-4 w-4" />
			</Button>
		</InsetPanel>
	);
}

interface ComboSlotBuilderProps {
	combo: ComboWithSlots;
}

export function ComboSlotBuilder({ combo }: ComboSlotBuilderProps) {
	const [showAddForm, setShowAddForm] = useState(false);
	const [newAccountId, setNewAccountId] = useState("");
	const [newModel, setNewModel] = useState("");

	const accountsQuery = useAccounts();
	const familiesQuery = useFamilies();
	const addSlot = useAddComboSlot();
	const removeSlot = useRemoveComboSlot();
	const reorderSlots = useReorderComboSlots();

	const accounts = accountsQuery.data ?? [];
	const families = familiesQuery.data?.families ?? [];
	const assignedFamily = families.find((f) => f.combo_id === combo.id);

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
	);

	const getAccountInfo = (accountId: string) => {
		const account = accounts.find((a) => a.id === accountId);
		return {
			name: account?.name ?? accountId,
			provider: account?.provider ?? "unknown",
		};
	};

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;
		if (!over || active.id === over.id) return;

		const oldIndex = combo.slots.findIndex((s) => s.id === active.id);
		const newIndex = combo.slots.findIndex((s) => s.id === over.id);
		if (oldIndex === -1 || newIndex === -1) return;

		const reordered = [...combo.slots];
		const [moved] = reordered.splice(oldIndex, 1);
		reordered.splice(newIndex, 0, moved);

		reorderSlots.mutate({
			comboId: combo.id,
			slotIds: reordered.map((s) => s.id),
		});
	};

	const handleAddSlot = () => {
		if (!newAccountId || !newModel.trim()) return;
		addSlot.mutate(
			{
				comboId: combo.id,
				params: { account_id: newAccountId, model: newModel.trim() },
			},
			{
				onSuccess: () => {
					setNewAccountId("");
					setNewModel("");
					setShowAddForm(false);
				},
			},
		);
	};

	return (
		<Card>
			<CardHeader className="pb-item">
				<div className="flex items-center justify-between">
					<CardTitle className="text-sm">Slots</CardTitle>
					<Button
						variant="outline"
						size="sm"
						onClick={() => setShowAddForm((v) => !v)}
					>
						{/* No margin: Button's base gap-item already separates the icon
						    from the label. `h-3 w-3` is inert here — the base's
						    [&_svg]:size-4 outranks it. */}
						<Plus className="h-3 w-3" />
						Add Slot
					</Button>
				</div>
			</CardHeader>
			<CardContent className="space-y-item">
				{assignedFamily && (
					<div className="flex items-center gap-item text-xs text-muted-foreground">
						<span>Assigned to:</span>
						<Badge variant="default">
							{assignedFamily.family.charAt(0).toUpperCase() +
								assignedFamily.family.slice(1)}
						</Badge>
					</div>
				)}
				{showAddForm && (
					<div className="space-y-row rounded-md border border-dashed p-row">
						<div className="space-y-item">
							<Label>Account</Label>
							<Select value={newAccountId} onValueChange={setNewAccountId}>
								<SelectTrigger>
									<SelectValue placeholder="Select account...">
										{newAccountId &&
											(() => {
												const acc = accounts.find((a) => a.id === newAccountId);
												return acc ? acc.name : newAccountId;
											})()}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									{accounts.map((account) => (
										<SelectItem key={account.id} value={account.id}>
											<span className="flex items-center gap-item">
												<Badge variant="secondary">{account.provider}</Badge>
												{account.name}
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-item">
							<Label>Model</Label>
							<Input
								value={newModel}
								onChange={(e) => setNewModel(e.target.value)}
								placeholder="claude-3-opus"
							/>
						</div>
						<div className="flex justify-end gap-item">
							<Button
								variant="outline"
								size="sm"
								onClick={() => {
									setShowAddForm(false);
									setNewAccountId("");
									setNewModel("");
								}}
							>
								Cancel
							</Button>
							<Button
								size="sm"
								onClick={handleAddSlot}
								disabled={
									!newAccountId || !newModel.trim() || addSlot.isPending
								}
							>
								{addSlot.isPending ? "Adding..." : "Add"}
							</Button>
						</div>
					</div>
				)}

				{combo.slots.length === 0 && !showAddForm && (
					<p className="py-item text-center text-sm text-muted-foreground">
						No slots yet. Add a slot to define the fallback chain.
					</p>
				)}

				{combo.slots.length > 0 && (
					<DndContext
						sensors={sensors}
						collisionDetection={closestCenter}
						onDragEnd={handleDragEnd}
					>
						<SortableContext
							items={combo.slots.map((s) => s.id)}
							strategy={verticalListSortingStrategy}
						>
							<div className="space-y-tight">
								{combo.slots.map((slot, index) => {
									const { name, provider } = getAccountInfo(slot.account_id);
									return (
										<SortableSlotRow
											key={slot.id}
											slot={slot}
											comboId={combo.id}
											accountName={name}
											provider={provider}
											index={index + 1}
											onRemove={() =>
												removeSlot.mutate({
													comboId: combo.id,
													slotId: slot.id,
												})
											}
											isRemoving={removeSlot.isPending}
										/>
									);
								})}
							</div>
						</SortableContext>
					</DndContext>
				)}
			</CardContent>
		</Card>
	);
}
