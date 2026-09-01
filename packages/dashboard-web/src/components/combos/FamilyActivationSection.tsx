import type { ComboFamily } from "@clankermux/types";
import { useAssignFamily, useCombos, useFamilies } from "../../hooks/queries";
import { Alert } from "../ui/alert";
import { Badge } from "../ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";

const FAMILIES: ComboFamily[] = ["opus", "sonnet", "haiku", "fable"];

const FAMILY_LABELS: Record<ComboFamily, string> = {
	opus: "Opus",
	sonnet: "Sonnet",
	haiku: "Haiku",
	fable: "Fable",
};

export function FamilyActivationSection() {
	const combosQuery = useCombos();
	const familiesQuery = useFamilies();
	const assignFamily = useAssignFamily();

	const combos = combosQuery.data?.combos ?? [];
	const families = familiesQuery.data?.families ?? [];
	const enabledCombos = combos.filter((c) => c.enabled);

	const getFamilyAssignment = (family: ComboFamily) =>
		families.find((f) => f.family === family);

	const handleToggle = (family: ComboFamily, enabled: boolean) => {
		const assignment = getFamilyAssignment(family);
		assignFamily.mutate({
			family,
			comboId: assignment?.combo_id ?? null,
			enabled,
		});
	};

	const handleComboSelect = (family: ComboFamily, comboId: string) => {
		const assignment = getFamilyAssignment(family);
		assignFamily.mutate({
			family,
			comboId: comboId === "none" ? null : comboId,
			enabled: assignment?.enabled ?? true,
		});
	};

	const isLoading = familiesQuery.isLoading || combosQuery.isLoading;
	const isError = familiesQuery.isError || combosQuery.isError;

	// One shell, three bodies. The loading, error and loaded states each carried
	// a byte-identical Card/CardHeader/CardTitle/CardDescription of their own, so
	// the section's heading was written out three times and could drift in two of
	// them without anyone noticing.
	return (
		<Card>
			<CardHeader>
				<CardTitle>Family Activation</CardTitle>
				<CardDescription>
					Assign routing chains to model families
				</CardDescription>
			</CardHeader>
			<CardContent>
				{isLoading ? (
					<div aria-busy="true" className="space-y-row">
						<span className="sr-only" role="status">
							Loading family activation
						</span>
						{FAMILIES.map((family) => (
							<Skeleton key={family} className="h-9 w-full" />
						))}
					</div>
				) : isError ? (
					<Alert
						tone="destructive"
						size="sm"
						title="Failed to load family data."
					/>
				) : (
					<>
						{assignFamily.isError && (
							<Alert
								size="sm"
								tone="destructive"
								title={
									assignFamily.error?.message ??
									"Failed to update family activation."
								}
							/>
						)}
						<div className="space-y-row">
							{FAMILIES.map((family) => {
								const assignment = getFamilyAssignment(family);
								const isEnabled = assignment?.enabled ?? false;
								const activeComboId = assignment?.combo_id ?? null;

								return (
									<div
										key={family}
										className="grid grid-cols-[5rem_auto_1fr_auto] items-center gap-row"
									>
										<Label className="font-medium">
											{FAMILY_LABELS[family]}
										</Label>
										<Switch
											checked={isEnabled}
											onCheckedChange={(checked) =>
												handleToggle(family, checked)
											}
											disabled={assignFamily.isPending}
										/>
										<Select
											value={activeComboId ?? "none"}
											onValueChange={(value) =>
												handleComboSelect(family, value)
											}
											disabled={!isEnabled || assignFamily.isPending}
										>
											{/* No `opacity-40` here: the trigger is already `disabled`
											    on exactly this condition and SelectTrigger carries
											    `disabled:opacity-50`, so two opacity utilities were
											    racing on one element — and 0.4 on muted text is below
											    the AA contrast floor. */}
											<SelectTrigger>
												<SelectValue placeholder="Select routing chain..." />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="none">None</SelectItem>
												{enabledCombos.map((combo) => (
													<SelectItem key={combo.id} value={combo.id}>
														{combo.name}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
										<div className="w-14 text-right">
											{isEnabled && activeComboId && (
												<Badge variant="default">Active</Badge>
											)}
										</div>
									</div>
								);
							})}
						</div>
					</>
				)}
			</CardContent>
		</Card>
	);
}
