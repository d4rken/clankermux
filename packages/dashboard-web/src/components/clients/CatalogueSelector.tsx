import type { ClientModel } from "@clankermux/types";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import type { DestinationAccount } from "./ClientWizard";
import {
	type DestinationFilter,
	DestinationFilterBar,
	matchesDestinationFilter,
} from "./destination-filter";
import { ModelFilterField, matchesModelQuery } from "./model-filter";

/** What a caller layers onto one row of one pane. */
export interface CatalogueRowExtras {
	/** Rendered under the model's names. */
	note?: ReactNode;
	/** Why the row cannot move to the other pane; it still renders. */
	blocked?: string;
	/** Buttons ahead of the row's own. */
	actions?: ReactNode;
}
/** Wording that differs between one client's catalogue and a batch's. */
export interface CatalogueLabels {
	selectedTitle: string;
	availableTitle: string;
	selectedEmpty: string;
	availableEmpty: string;
}
const CLIENT_LABELS: CatalogueLabels = {
	selectedTitle: "Selected models",
	availableTitle: "Available models",
	selectedEmpty: "No selected models. Add models from the available list.",
	availableEmpty:
		"No available models. All discovered models may already be selected. Refresh suggestions or add a custom model.",
};

interface CataloguePaneProps {
	selected: boolean;
	formatLabel: string;
	models: ClientModel[];
	query: string;
	onQueryChange: (value: string) => void;
	filter: DestinationFilter;
	busy: boolean;
	/** The accounts serving a model, which place it under a provider. */
	modelAccounts: (model: ClientModel) => DestinationAccount[];
	onMove: (models: ClientModel[]) => void;
	onEdit?: (model: ClientModel) => void;
	rowExtras?: (model: ClientModel, selected: boolean) => CatalogueRowExtras;
	labels: CatalogueLabels;
	children?: ReactNode;
}

function CataloguePane({
	selected,
	formatLabel,
	models,
	query,
	onQueryChange,
	filter,
	busy,
	modelAccounts,
	onMove,
	onEdit,
	rowExtras,
	labels,
	children,
}: CataloguePaneProps) {
	const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
	const selectAllRef = useRef<HTMLInputElement>(null);
	const visible = models.filter(
		(model) =>
			matchesModelQuery(model, query) &&
			matchesDestinationFilter(modelAccounts(model), filter),
	);
	const extras = new Map(
		visible.map((model) => [model.id, rowExtras?.(model, selected) ?? {}]),
	);
	const movable = visible.filter((model) => !extras.get(model.id)?.blocked);
	const checkedModels = movable.filter((model) => checked.has(model.id));
	const allChecked =
		movable.length > 0 && checkedModels.length === movable.length;
	const partiallyChecked = checkedModels.length > 0 && !allChecked;
	useEffect(() => {
		if (selectAllRef.current)
			selectAllRef.current.indeterminate = partiallyChecked;
	}, [partiallyChecked]);
	useEffect(() => {
		const ids = new Set(models.map((model) => model.id));
		setChecked((current) => {
			const retained = [...current].filter((id) => ids.has(id));
			return retained.length === current.size ? current : new Set(retained);
		});
	}, [models]);
	const side = selected ? "selected" : "available";
	const title = selected ? labels.selectedTitle : labels.availableTitle;
	const action = selected ? "Remove" : "Add";
	const move = (entries: ClientModel[]) => {
		onMove(entries);
		setChecked((current) => {
			const next = new Set(current);
			for (const model of entries) next.delete(model.id);
			return next;
		});
	};
	return (
		<section
			aria-label={title}
			className={`min-w-0 rounded-md border flex flex-col ${selected ? "md:order-2" : "md:order-1"}`}
		>
			<div className="space-y-3 border-b p-3">
				<div className="flex items-center justify-between gap-2">
					<h3 className="text-sm font-semibold">{title}</h3>
					<span className="text-xs text-muted-foreground tabular-nums">
						{models.length} {side}
					</span>
				</div>
				<ModelFilterField
					value={query}
					onChange={(value) => {
						setChecked(new Set());
						onQueryChange(value);
					}}
					shown={visible.length}
					total={models.length}
					label={`Filter ${formatLabel} ${side} models`}
				/>
				<div className="flex flex-wrap items-center justify-between gap-2">
					<label className="flex items-center gap-2 text-xs">
						<input
							ref={selectAllRef}
							type="checkbox"
							aria-label={`Check all shown ${side} models`}
							disabled={busy || !movable.length}
							checked={allChecked}
							onChange={(event) =>
								setChecked(
									new Set(event.target.checked ? movable.map((m) => m.id) : []),
								)
							}
						/>
						Check all shown
					</label>
					<Button
						size="sm"
						variant="outline"
						disabled={busy || !checkedModels.length}
						onClick={() => move(checkedModels)}
					>
						{action} checked ({checkedModels.length})
					</Button>
				</div>
			</div>
			<section
				aria-label={`${formatLabel} ${side} models`}
				className="h-[40dvh] min-h-48 md:h-[max(18rem,calc(100dvh-43rem))] overflow-auto overscroll-contain divide-y"
			>
				{visible.map((model) => {
					const names = modelAccounts(model).map((a) => a.name);
					const { note, blocked, actions } = extras.get(model.id) ?? {};
					return (
						<div
							key={model.id}
							data-model-id={model.id}
							className="flex items-center gap-2 p-3 hover:bg-muted/40"
						>
							<label className="flex min-w-0 flex-1 items-center gap-3">
								<input
									type="checkbox"
									className="shrink-0"
									aria-label={`Check ${model.id}`}
									disabled={busy || !!blocked}
									title={blocked}
									checked={!blocked && checked.has(model.id)}
									onChange={(event) => {
										const next = new Set(checked);
										if (event.target.checked) next.add(model.id);
										else next.delete(model.id);
										setChecked(next);
									}}
								/>
								<span className="grid min-w-0 gap-0.5">
									<span className="text-sm font-medium break-all leading-5">
										{model.displayName}
									</span>
									{model.displayName !== model.id && (
										<code className="text-xs break-all text-muted-foreground">
											{model.id}
										</code>
									)}
									{model.targetModel !== model.id && (
										<code className="text-xs break-all text-muted-foreground">
											Target: {model.targetModel}
										</code>
									)}
									{!!names.length && (
										<span
											title={names.join(", ")}
											className="truncate text-xs text-muted-foreground"
										>
											{names[0]}
											{names.length > 1 ? ` +${names.length - 1}` : ""}
										</span>
									)}
									{note}
								</span>
							</label>
							<div className="flex shrink-0 flex-col gap-1 sm:flex-row">
								{actions}
								{onEdit && (
									<Button
										variant="ghost"
										size="sm"
										className="h-7 px-2 text-xs"
										aria-label={`Edit ${model.id}`}
										disabled={busy}
										onClick={() => onEdit(model)}
									>
										Edit
									</Button>
								)}
								<Button
									variant="outline"
									size="sm"
									className="h-7 px-2 text-xs"
									aria-label={`${action} ${model.id}`}
									title={blocked}
									disabled={busy || !!blocked}
									onClick={() => move([model])}
								>
									{action}
								</Button>
							</div>
						</div>
					);
				})}
				{!visible.length && (
					<p className="p-4 text-sm text-muted-foreground">
						{models.length
							? "No models match this filter."
							: selected
								? labels.selectedEmpty
								: labels.availableEmpty}
					</p>
				)}
			</section>
			{children && <div className="border-t p-3">{children}</div>}
		</section>
	);
}

export function CatalogueSelector({
	available,
	selected,
	queries,
	onQueryChange,
	onFilterChange,
	onAdd,
	onRemove,
	labels = CLIENT_LABELS,
	children,
	...shared
}: Omit<
	CataloguePaneProps,
	"selected" | "models" | "query" | "onQueryChange" | "onMove" | "labels"
> & {
	available: ClientModel[];
	selected: ClientModel[];
	queries: { available: string; selected: string };
	onQueryChange: (side: "available" | "selected", value: string) => void;
	onFilterChange: (filter: DestinationFilter) => void;
	onAdd: (models: ClientModel[]) => void;
	onRemove: (models: ClientModel[]) => void;
	labels?: CatalogueLabels;
}) {
	// A model can sit in both panes (a batch where only some clients have it),
	// so the chips count each ID once.
	const models = new Map(
		[...selected, ...available].map((model) => [model.id, model]),
	);
	return (
		<div className="grid items-start gap-4 md:grid-cols-2">
			<div className="md:col-span-2">
				<DestinationFilterBar
					rows={[...models.values()].map(shared.modelAccounts)}
					filter={shared.filter}
					onChange={onFilterChange}
				/>
			</div>
			<CataloguePane
				{...shared}
				labels={labels}
				selected
				models={selected}
				query={queries.selected}
				onQueryChange={(value) => onQueryChange("selected", value)}
				onMove={onRemove}
			>
				{children}
			</CataloguePane>
			<CataloguePane
				{...shared}
				labels={labels}
				selected={false}
				models={available}
				query={queries.available}
				onQueryChange={(value) => onQueryChange("available", value)}
				onMove={onAdd}
			/>
		</div>
	);
}
