import { Plus } from "lucide-react";
import { useState } from "react";
import {
	useCombos,
	useDeleteCombo,
	useFamilies,
	useUpdateCombo,
} from "../../hooks/queries";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { PanelEmptyState } from "../ui/panel-empty-state";
import { SectionHeading } from "../ui/section-heading";
import { Separator } from "../ui/separator";
import { Skeleton } from "../ui/skeleton";
import { ComboCard } from "./ComboCard";
import { ComboDialog } from "./ComboDialog";
import { FamilyActivationSection } from "./FamilyActivationSection";

/**
 * Stable keys for the routing-chain loading grid.
 *
 * `h-32` is the height of a real `ComboCard` carrying a one-line description,
 * not an estimate: 1px of border top and bottom (2), a header at `p-4 pb-3`
 * around a `leading-snug` title, the 0.5rem title-to-description gap and one
 * `text-sm` description line (16 + 22 + 8 + 20 + 12 = 78), and a body at
 * `p-4 pt-0` around a `size="sm"` button (32 + 16 = 48). 2 + 78 + 48 = 128px.
 */
const COMBO_SKELETON_CARDS = ["card-1", "card-2", "card-3"] as const;

export function CombosTab() {
	const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
	const [editDialogComboId, setEditDialogComboId] = useState<string | null>(
		null,
	);
	const combosQuery = useCombos();
	const familiesQuery = useFamilies();
	const deleteCombo = useDeleteCombo();
	const updateCombo = useUpdateCombo();
	const combos = combosQuery.data?.combos ?? [];
	const families = familiesQuery.data?.families ?? [];

	const getAssignedFamily = (comboId: string) => {
		const assignment = families.find((f) => f.combo_id === comboId);
		if (!assignment) return null;
		return (
			assignment.family.charAt(0).toUpperCase() + assignment.family.slice(1)
		);
	};

	return (
		<div className="space-y-section">
			<FamilyActivationSection />

			<Separator />

			<div className="space-y-group">
				<div className="flex items-center justify-between">
					<SectionHeading title="Routing Chains" />
					<Button onClick={() => setIsCreateDialogOpen(true)}>
						{/* No `mr-2`: Button's base already carries `gap-item`, so the
						    margin rendered a 1rem gap where the rest of the app
						    renders 0.5rem. */}
						<Plus className="h-4 w-4" />
						Create Routing Chain
					</Button>
				</div>

				{combosQuery.isLoading && (
					<div
						aria-busy="true"
						className="grid gap-group sm:grid-cols-2 lg:grid-cols-3"
					>
						<span className="sr-only" role="status">
							Loading routing chains
						</span>
						{COMBO_SKELETON_CARDS.map((key) => (
							<Skeleton key={key} className="h-32 w-full rounded-lg" />
						))}
					</div>
				)}

				{combosQuery.isError && (
					<Alert
						tone="destructive"
						size="sm"
						title="Failed to load routing chains."
					/>
				)}

				{!combosQuery.isLoading &&
					!combosQuery.isError &&
					combos.length === 0 && (
						<PanelEmptyState
							action={
								<Button size="sm" onClick={() => setIsCreateDialogOpen(true)}>
									<Plus className="h-4 w-4" />
									Create Routing Chain
								</Button>
							}
						>
							No routing chains yet. Create one to define a fallback chain.
						</PanelEmptyState>
					)}

				{combos.length > 0 && (
					<div className="grid gap-group sm:grid-cols-2 lg:grid-cols-3">
						{combos.map((combo) => (
							<ComboCard
								key={combo.id}
								combo={combo}
								slotCount={combo.slot_count}
								assignedFamily={getAssignedFamily(combo.id)}
								onEdit={() => setEditDialogComboId(combo.id)}
								onDelete={() => deleteCombo.mutate(combo.id)}
								onToggleEnabled={(enabled) =>
									updateCombo.mutate({ id: combo.id, enabled })
								}
							/>
						))}
					</div>
				)}
			</div>

			<ComboDialog
				isOpen={isCreateDialogOpen}
				onClose={() => setIsCreateDialogOpen(false)}
			/>

			<ComboDialog
				isOpen={!!editDialogComboId}
				comboId={editDialogComboId}
				onClose={() => setEditDialogComboId(null)}
			/>
		</div>
	);
}
