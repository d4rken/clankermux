import type { ModelCatalogRow, ModelDialect } from "@clankermux/types";
import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

interface ModelRowProps {
	dialect: ModelDialect;
	row: ModelCatalogRow;
	/** True while any write for this row is in flight. */
	busy: boolean;
	onRename(name: string | null): void;
	onSetHidden(hidden: boolean): void;
	onDelete(): void;
}

/**
 * One model, and the three things an operator can do to it.
 *
 * The name is a DRAFT until it is committed (blur or Enter). Writing on every
 * keystroke would mean one request per character and, worse, a half-typed name
 * briefly served to real clients; committing on the same gestures a form field
 * already implies keeps the edit atomic.
 *
 * A hidden row is DIMMED rather than removed. The wire drops it — that is what
 * hiding means — but the page is where it gets un-hidden, so it has to stay
 * visible and legible enough to find.
 */
export function ModelRow({
	dialect,
	row,
	busy,
	onRename,
	onSetHidden,
	onDelete,
}: ModelRowProps) {
	const [draft, setDraft] = useState(row.displayName);
	// Tracks the value the server last reported, so a refetch that CHANGED the
	// name resets the field while one that did not leaves an in-progress edit
	// alone. Without this, a failed write's refetch would silently discard what
	// the operator typed.
	const lastServerName = useRef(row.displayName);

	useEffect(() => {
		if (lastServerName.current !== row.displayName) {
			lastServerName.current = row.displayName;
			setDraft(row.displayName);
		}
	}, [row.displayName]);

	const commit = () => {
		const trimmed = draft.trim();
		if (trimmed === row.displayName) return;
		// An emptied field means "use whatever upstream calls it", which is a
		// cleared override rather than a rename to the empty string.
		onRename(trimmed === "" ? null : trimmed);
	};

	const isCustom = row.source === "custom";

	return (
		<div
			className={cn(
				"flex flex-wrap items-center gap-row border-b py-item last:border-b-0",
				row.hidden && "opacity-50",
			)}
			data-testid={`model-row-${row.id}`}
		>
			<div className="flex min-w-0 flex-1 items-center gap-item">
				<span className="truncate font-mono text-sm">{row.id}</span>
				{isCustom && (
					<Badge variant="secondary" className="shrink-0">
						Custom
					</Badge>
				)}
			</div>

			<Input
				className="w-56"
				aria-label={`Display name for ${row.id}`}
				value={draft}
				placeholder={row.id}
				disabled={busy}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						commit();
					}
				}}
			/>

			{isCustom ? (
				<Button
					variant="ghost"
					size="sm"
					disabled={busy}
					aria-label={`Remove ${row.id}`}
					onClick={onDelete}
				>
					<Trash2 className="h-4 w-4" />
				</Button>
			) : (
				<div className="flex items-center gap-item">
					<Switch
						checked={!row.hidden}
						disabled={busy}
						aria-label={`Show ${row.id} on /wire/${dialect}`}
						onCheckedChange={(checked) => onSetHidden(!checked)}
					/>
					<span className="w-14 text-xs text-muted-foreground">
						{row.hidden ? "Hidden" : "Shown"}
					</span>
				</div>
			)}
		</div>
	);
}
