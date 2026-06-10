import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

export type SortDir = "asc" | "desc";

/**
 * Three-state sort chevron shared by the sortable analytics tables
 * (ModelPerformanceTable, ToolErrorsPanel): neutral double-chevron when the
 * column isn't the active sort key, otherwise a direction arrow.
 */
export function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
	if (!active) return <ChevronsUpDown className="h-3 w-3 opacity-40" />;
	return dir === "asc" ? (
		<ArrowUp className="h-3 w-3" />
	) : (
		<ArrowDown className="h-3 w-3" />
	);
}

/**
 * Sortable column header button: label + three-state SortIcon with the shared
 * muted/hover styling. Sort-key/direction state and toggle semantics stay in
 * the owning table — this only renders the common header affordance.
 */
export function SortHeaderButton({
	label,
	active,
	dir,
	onClick,
}: {
	label: string;
	active: boolean;
	dir: SortDir;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="inline-flex items-center gap-1 hover:text-foreground text-muted-foreground"
		>
			{label} <SortIcon active={active} dir={dir} />
		</button>
	);
}
