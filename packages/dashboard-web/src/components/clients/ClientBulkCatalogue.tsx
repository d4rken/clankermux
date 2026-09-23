import type {
	ClientBulkClientResult,
	ClientBulkOperation,
	ClientBulkReview,
	ClientFormat,
	ClientModel,
	ClientSuggestions,
	ClientView,
} from "@clankermux/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import { clientRequest } from "./api";
import {
	type CatalogueLabels,
	type CatalogueRowExtras,
	CatalogueSelector,
} from "./CatalogueSelector";
import { ClientLabel, clientLabelText } from "./ClientLabel";
import type { DestinationAccount } from "./ClientWizard";
import { suggestedModel } from "./ClientWizard";
import { NO_DESTINATION_FILTER, servingAccounts } from "./destination-filter";
import { FORMAT_LABELS, FORMATS } from "./setup";

const SELECT = "h-9 rounded-md border border-input bg-background px-3 text-sm";
const FORMAT_KEYS = Object.keys(FORMATS) as ClientFormat[];
const BATCH_LABELS: CatalogueLabels = {
	selectedTitle: "In catalogues",
	availableTitle: "Not in every catalogue",
	selectedEmpty: "No selected client publishes a model in this format yet.",
	availableEmpty: "Every model listed is already in every selected catalogue.",
};
const PENDING_FIRST = "Review or discard the pending changes first";

/** Comparable account pin. `null` (any allowed account) stays distinct from a list. */
const pinOf = (model: ClientModel) =>
	JSON.stringify(model.accountIds ? [...model.accountIds].sort() : null);
const sameDefinition = (a: ClientModel, b: ClientModel) =>
	a.targetModel === b.targetModel &&
	a.displayName === b.displayName &&
	pinOf(a) === pinOf(b);
const clientCount = (n: number) => `${n} ${n === 1 ? "client" : "clients"}`;

interface Candidate {
	model: ClientModel;
	/** Selected clients that publish this ID. */
	coverage: number;
	/** Those clients do not agree on what the ID means. */
	conflicted: boolean;
	/** Staged in this panel rather than read from a client or discovery. */
	staged?: boolean;
}
/**
 * `add` publishes the ID on every selected client missing it, `remove` drops it
 * from every client that has it. One intent per ID, so a model some clients
 * publish leaves the pane it was moved out of.
 */
type Intent = "add" | "remove";

const EMPTY_CUSTOM = { id: "", target: "", name: "", accounts: [] as string[] };

export function ClientBulkCatalogue({
	clients,
	accounts,
	onCancel,
	onApplied,
}: {
	clients: ClientView[];
	accounts: DestinationAccount[];
	onCancel: () => void;
	/** The committed views, freshly read by the server. */
	onApplied: (clients: ClientView[]) => void;
}) {
	const busyRef = useRef(false);
	const [format, setFormat] = useState<ClientFormat>(
		() =>
			FORMAT_KEYS.find((f) =>
				clients.some((c) => c.catalogues[f].models.length),
			) ?? "anthropic",
	);
	const [suggestions, setSuggestions] = useState<ClientSuggestions | null>(
		null,
	);
	const [pending, setPending] = useState<ReadonlyMap<string, Intent>>(
		() => new Map(),
	);
	/** Kept across format tabs: narrowing the list is a view, not an operation. */
	const [queries, setQueries] = useState({ available: "", selected: "" });
	const [filter, setFilter] = useState(NO_DESTINATION_FILTER);
	const [custom, setCustom] = useState(EMPTY_CUSTOM);
	const [customError, setCustomError] = useState<string | null>(null);
	/** Entries the operator typed, which no client and no discovery offers. */
	const [stagedModels, setStagedModels] = useState<ClientModel[]>([]);
	const [source, setSource] = useState<{
		id: string;
		models: ClientModel[];
	} | null>(null);
	const [replaceDefault, setReplaceDefault] = useState("");
	const [dropRoutes, setDropRoutes] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [review, setReview] = useState<ClientBulkReview | null>(null);
	/** The catalogues the review was taken against; the list keeps refreshing. */
	const [reviewedClients, setReviewedClients] = useState<ClientView[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const run = async (work: () => Promise<void>) => {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			await work();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};
	useEffect(() => {
		let live = true;
		// A bare destinations object is not the body shape: the handler reads
		// `body.destinations` and answers 400 without it.
		clientRequest<ClientSuggestions>("/suggestions", {
			destinations: { accountId: null, providers: null },
			refresh: false,
		})
			.then((result) => {
				if (live) setSuggestions(result);
			})
			.catch((e: unknown) => {
				if (live) setError(e instanceof Error ? e.message : String(e));
			});
		return () => {
			live = false;
		};
	}, []);
	const candidates = useMemo((): Candidate[] => {
		const union = new Map<string, Candidate>();
		for (const client of clients)
			for (const model of client.catalogues[format].models) {
				const entry = union.get(model.id);
				if (!entry) {
					union.set(model.id, { model, coverage: 1, conflicted: false });
					continue;
				}
				entry.coverage += 1;
				if (!sameDefinition(entry.model, model)) entry.conflicted = true;
			}
		for (const suggestion of suggestions?.models ?? []) {
			// `generic` keeps every non-alias entry at `accountIds: null`, which
			// validates against any client's destinations.
			const model = suggestedModel(
				suggestion.id,
				suggestion.displayName,
				suggestion.accountIds,
				"generic",
				format,
			);
			if (!union.has(model.id))
				union.set(model.id, { model, coverage: 0, conflicted: false });
		}
		// A staged definition outranks both: the operator typed it, and a
		// definition that arrived after they staged the row must not be applied
		// in its place. Coverage stays honest about who already publishes the ID.
		for (const model of stagedModels) {
			const covering = clients.filter((c) =>
				c.catalogues[format].models.some((m) => m.id === model.id),
			);
			union.set(model.id, {
				model,
				coverage: covering.length,
				conflicted: covering.some((c) => {
					const stored = c.catalogues[format].models.find(
						(m) => m.id === model.id,
					);
					return !!stored && !sameDefinition(stored, model);
				}),
				staged: true,
			});
		}
		return [...union.values()].sort((a, b) =>
			a.model.id.localeCompare(b.model.id),
		);
	}, [clients, format, suggestions, stagedModels]);
	const byId = new Map(candidates.map((c) => [c.model.id, c]));
	const total = clients.length;
	/**
	 * Read against the coverage in hand, not the one at staging time: after the
	 * selected clients refresh, an add every client now has, or a remove none
	 * has, changes nothing and counts as no intent.
	 */
	const intentOf = (c: Candidate): Intent | undefined => {
		const intent = pending.get(c.model.id);
		return (intent === "add" && c.coverage === total) ||
			(intent === "remove" && c.coverage === 0)
			? undefined
			: intent;
	};
	// Drop what a refresh made void rather than only hiding it: an intent kept
	// behind a no-op, or behind a model that left the list, would come back on
	// a later refresh without the operator having staged it again.
	useEffect(() => {
		const byIdNow = new Map(candidates.map((c) => [c.model.id, c]));
		setPending((current) => {
			const live = [...current].filter(([id, intent]) => {
				const c = byIdNow.get(id);
				return (
					!!c &&
					!(intent === "add" && c.coverage === total) &&
					!(intent === "remove" && c.coverage === 0)
				);
			});
			return live.length === current.size ? current : new Map(live);
		});
	}, [candidates, total]);
	const inCatalogues = candidates.filter((c) => {
		const intent = intentOf(c);
		return intent ? intent === "add" : c.coverage > 0;
	});
	const notEverywhere = candidates.filter((c) => {
		const intent = intentOf(c);
		return intent ? intent === "remove" : c.coverage < total;
	});
	// Operations read the intents, never the panes: a filter hiding a row must
	// not change what is applied.
	const adds = candidates.filter((c) => intentOf(c) === "add");
	const removes = candidates.filter((c) => intentOf(c) === "remove");
	const staged = adds.length + removes.length;
	// A row can turn conflicted after it was staged: a custom entry a client
	// then publishes differently, or a refetch that changes a client's entry.
	const conflictedAdds = adds.filter((c) => c.conflicted).length;
	/**
	 * Moving a row to the side its stored coverage already puts it on undoes the
	 * intent rather than recording one that changes nothing.
	 */
	const move = (models: ClientModel[], intent: Intent) => {
		// A custom entry exists only to be added; taking it back out discards it
		// rather than leaving a row that looks queued and changes nothing.
		const discarded = new Set(
			models
				.filter((m) => intent === "remove" && byId.get(m.id)?.staged)
				.filter((m) => byId.get(m.id)?.coverage === 0)
				.map((m) => m.id),
		);
		if (discarded.size)
			setStagedModels((current) => current.filter((m) => !discarded.has(m.id)));
		setPending((current) => {
			const next = new Map(current);
			for (const { id } of models) {
				const coverage = byId.get(id)?.coverage ?? 0;
				if (intent === "add" ? coverage === total : coverage === 0)
					next.delete(id);
				else next.set(id, intent);
			}
			return next;
		});
	};
	const undo = (id: string) =>
		setPending((current) => {
			const next = new Map(current);
			next.delete(id);
			return next;
		});
	const changeFormat = (next: ClientFormat) => {
		setFormat(next);
		setPending(new Map());
		setSource(null);
		setReplaceDefault("");
		setStagedModels([]);
		setCustomError(null);
	};
	const discard = () => {
		setPending(new Map());
		setStagedModels([]);
	};
	const stage = () => {
		const id = custom.id.trim();
		const target = custom.target.trim() || id;
		if (!id) {
			setCustomError("Enter a model ID");
			return;
		}
		if (byId.has(id)) {
			// Adding an ID a client already has is a no-op for that client, so a
			// collision would apply to some of the batch and silently skip the rest.
			setCustomError(`${id} is already in this list`);
			return;
		}
		if (target !== id && !custom.accounts.length) {
			setCustomError("Choose at least one destination for an alias");
			return;
		}
		setStagedModels((current) => [
			...current,
			{
				id,
				displayName: custom.name.trim() || id,
				targetModel: target,
				accountIds:
					target !== id && custom.accounts.length ? custom.accounts : null,
			},
		]);
		setPending((current) => new Map(current).set(id, "add"));
		setCustom(EMPTY_CUSTOM);
		setCustomError(null);
	};
	const unstage = (id: string) => {
		setStagedModels((current) => current.filter((m) => m.id !== id));
		undo(id);
	};
	const propose = (operation: ClientBulkOperation) =>
		run(async () => {
			const snapshot = clients;
			setReview(
				await clientRequest<ClientBulkReview>("/bulk/review", {
					clientIds: snapshot.map((c) => c.apiKeyId),
					operation: dropRoutes ? { ...operation, dropRoutes } : operation,
				}),
			);
			setReviewedClients(snapshot);
		});
	const changed =
		review?.clients.filter((c) => c.status === "changed").length ?? 0;
	/**
	 * Commit, hand the committed views up, and stay open for the next change.
	 * The commit response is what the panel then reads: an invalidation only
	 * starts a refetch, so without it the next change would work from pre-apply
	 * catalogues.
	 */
	const apply = (token: string) =>
		run(async () => {
			const applied = changed;
			const committed = await clientRequest<{ clients: ClientView[] }>(
				"/bulk/commit",
				{ token },
			);
			onApplied(committed.clients);
			setReview(null);
			setPending(new Map());
			setStagedModels([]);
			setSource(null);
			setReplaceDefault("");
			setDropRoutes(false);
			setNotice(`Applied to ${clientCount(applied)}.`);
		});
	const accountName = (id: string) =>
		accounts.find((a) => a.id === id)?.name ?? id;
	const rowExtras = (
		model: ClientModel,
		selected: boolean,
	): CatalogueRowExtras => {
		const candidate = byId.get(model.id);
		if (!candidate) return {};
		const { coverage, conflicted, staged: custom } = candidate;
		const intent = intentOf(candidate);
		return {
			// Only adding needs one agreed definition; a remove reads the ID alone.
			blocked:
				conflicted && !selected
					? "Clients define this ID differently; edit them individually"
					: undefined,
			note: (
				<span className="text-xs text-muted-foreground">
					In {coverage} of {total}
					{conflicted
						? ` · Defined differently in ${clientCount(coverage)}`
						: ""}
					{custom && (
						<span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px]">
							Custom
						</span>
					)}
					{intent && (
						<span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
							{intent === "add"
								? `Adding to ${clientCount(total - coverage)}`
								: `Removing from ${clientCount(coverage)}`}
						</span>
					)}
				</span>
			),
			actions: (
				<>
					{intent && !custom && (
						<Button
							variant="ghost"
							size="sm"
							className="h-7 px-2 text-xs"
							aria-label={`Undo ${model.id}`}
							disabled={busy}
							onClick={() => undo(model.id)}
						>
							Undo
						</Button>
					)}
					{custom && (
						<Button
							variant="ghost"
							size="sm"
							className="h-7 px-2 text-xs"
							aria-label={`Discard ${model.id}`}
							disabled={busy}
							onClick={() => unstage(model.id)}
						>
							Discard
						</Button>
					)}
				</>
			),
		};
	};
	const shown = clients
		.slice(0, 3)
		.map((c) => clientLabelText(c.key.name, c.application));

	return (
		<Card>
			<CardHeader className="gap-3">
				<CardTitle>Edit catalogues · {clientCount(total)}</CardTitle>
				<p
					className="text-sm text-muted-foreground"
					title={clients
						.map((c) => clientLabelText(c.key.name, c.application))
						.join(", ")}
				>
					{shown.join(", ")}
					{clients.length > shown.length
						? ` +${clients.length - shown.length} more`
						: ""}
				</p>
			</CardHeader>
			<CardContent className="space-y-5 px-5 pt-5 pb-0 sm:px-6 sm:pt-6">
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				{notice && (
					<p role="status" className="text-sm text-muted-foreground">
						{notice}
					</p>
				)}
				{review ? (
					<div className="space-y-4">
						<h3 className="font-medium">
							{changed} of {review.clients.length} clients will change
						</h3>
						<section
							aria-label="Bulk edit preview"
							className="divide-y rounded-md border"
						>
							{review.clients.map((result) => (
								<PreviewRow
									key={result.apiKeyId}
									result={result}
									operation={review.operation}
									stored={reviewedClients.find(
										(c) => c.apiKeyId === result.apiKeyId,
									)}
									accountName={accountName}
								/>
							))}
						</section>
					</div>
				) : (
					<>
						<Tabs
							value={format}
							onValueChange={(value) => changeFormat(value as ClientFormat)}
						>
							<TabsList
								aria-label="Catalogue format"
								className="h-auto flex flex-wrap justify-start w-fit gap-1"
							>
								{FORMAT_KEYS.map((f) => (
									<TabsTrigger
										key={f}
										value={f}
										// The pending changes belong to this format's catalogues.
										disabled={f !== format && staged > 0}
										title={
											f !== format && staged > 0 ? PENDING_FIRST : undefined
										}
										className="px-2 text-xs sm:px-3 sm:text-sm"
									>
										{FORMAT_LABELS[f]}
										<span className="ml-1.5 rounded bg-muted px-1 text-xs tabular-nums">
											{
												clients.filter((c) => c.catalogues[f].models.length)
													.length
											}
										</span>
									</TabsTrigger>
								))}
							</TabsList>
						</Tabs>
						{candidates.length === 0 ? (
							<p className="rounded-md border p-3 text-sm text-muted-foreground">
								No models to choose from in this format yet.
							</p>
						) : (
							<CatalogueSelector
								formatLabel={FORMATS[format]}
								available={notEverywhere.map((c) => c.model)}
								selected={inCatalogues.map((c) => c.model)}
								queries={queries}
								onQueryChange={(side, value) =>
									setQueries((current) => ({ ...current, [side]: value }))
								}
								filter={filter}
								onFilterChange={setFilter}
								busy={busy}
								modelAccounts={(model) =>
									servingAccounts(model, suggestions, accounts)
								}
								onAdd={(models) => move(models, "add")}
								onRemove={(models) => move(models, "remove")}
								rowExtras={rowExtras}
								labels={BATCH_LABELS}
							/>
						)}
						<div className="flex flex-wrap items-center gap-3">
							<Button
								disabled={busy || staged === 0 || conflictedAdds > 0}
								title={
									conflictedAdds > 0
										? "Some models to add are defined differently across the selected clients; undo them or edit those clients individually"
										: undefined
								}
								onClick={() =>
									propose({
										format,
										mode: "edit",
										add: adds.map((c) => c.model),
										remove: removes.map((c) => c.model.id),
									})
								}
							>
								Review changes
							</Button>
							<Button
								variant="outline"
								disabled={busy || (staged === 0 && !stagedModels.length)}
								onClick={discard}
							>
								Discard changes
							</Button>
							<p
								role="status"
								className="text-sm text-muted-foreground tabular-nums"
							>
								{staged
									? `${adds.length} to add · ${removes.length} to remove`
									: "Move models between the columns to stage changes."}
							</p>
						</div>
						<label className="flex items-start gap-2 text-sm">
							<input
								type="checkbox"
								className="mt-1"
								aria-label="Delete the routes of removed aliases"
								disabled={busy}
								checked={dropRoutes}
								onChange={(e) => setDropRoutes(e.target.checked)}
							/>
							<span>
								Delete the routes of aliases this edit or replace removes
								<span className="block text-muted-foreground">
									Otherwise a client that still sends the alias ID keeps
									reaching its target.
								</span>
							</span>
						</label>
						<details className="rounded-md border p-3">
							<summary className="cursor-pointer w-fit text-sm font-medium">
								Add a custom model or alias
							</summary>
							<div className="mt-3 grid gap-4 max-w-xl sm:grid-cols-2">
								<p className="text-sm text-muted-foreground sm:col-span-2">
									Publish an entry no client offers yet. It is staged for every
									selected client and applied with the other changes.
								</p>
								<label
									className="grid gap-2 text-sm font-medium"
									htmlFor="bulk-model-id"
								>
									Published model ID
									<Input
										id="bulk-model-id"
										disabled={busy}
										value={custom.id}
										onChange={(e) =>
											setCustom({ ...custom, id: e.target.value })
										}
									/>
								</label>
								<label
									className="grid gap-2 text-sm font-medium"
									htmlFor="bulk-target-id"
								>
									Upstream target ID
									<Input
										id="bulk-target-id"
										placeholder="Same as published ID for a direct model"
										disabled={busy}
										value={custom.target}
										onChange={(e) =>
											setCustom({ ...custom, target: e.target.value })
										}
									/>
								</label>
								<label
									className="grid gap-2 text-sm font-medium"
									htmlFor="bulk-display-name"
								>
									Display name
									<Input
										id="bulk-display-name"
										disabled={busy}
										value={custom.name}
										onChange={(e) =>
											setCustom({ ...custom, name: e.target.value })
										}
									/>
								</label>
								<fieldset className="sm:col-span-2">
									<legend className="text-sm mb-2">
										Alias destinations (required when IDs differ)
									</legend>
									<div className="flex flex-wrap gap-3">
										{accounts.map((a) => (
											<label key={a.id} className="text-sm flex gap-2">
												<input
													type="checkbox"
													disabled={busy}
													checked={custom.accounts.includes(a.id)}
													onChange={(e) =>
														setCustom({
															...custom,
															accounts: e.target.checked
																? [...custom.accounts, a.id]
																: custom.accounts.filter((id) => id !== a.id),
														})
													}
												/>
												{a.name}
											</label>
										))}
									</div>
								</fieldset>
								{customError && (
									<p
										role="alert"
										className="text-sm text-destructive sm:col-span-2"
									>
										{customError}
									</p>
								)}
								<Button
									variant="outline"
									className="w-fit"
									disabled={busy}
									onClick={stage}
								>
									Add to list
								</Button>
							</div>
						</details>
						<details className="rounded-md border p-3">
							<summary className="cursor-pointer w-fit text-sm font-medium">
								Replace whole catalogue
							</summary>
							<div className="mt-3 grid gap-3 max-w-xl">
								<p className="text-sm text-muted-foreground">
									Copy one client's {FORMATS[format]} catalogue onto every
									selected client. Each client's current entries in this format
									are discarded.
								</p>
								<label className="grid gap-2 text-sm font-medium">
									Start from
									<select
										className={SELECT}
										aria-label="Start from"
										disabled={busy}
										value={source?.id ?? ""}
										onChange={(e) => {
											const picked = clients.find(
												(c) => c.apiKeyId === e.target.value,
											);
											// The source client's own entries, not the deduplicated
											// union: another selected client may define the same ID
											// against a different target.
											setSource(
												picked
													? {
															id: picked.apiKeyId,
															models: structuredClone(
																picked.catalogues[format].models,
															),
														}
													: null,
											);
											setReplaceDefault("");
										}}
									>
										<option value="">Choose a client</option>
										{clients.map((c) => (
											<option key={c.apiKeyId} value={c.apiKeyId}>
												{clientLabelText(c.key.name, c.application)} (
												{c.catalogues[format].models.length})
											</option>
										))}
									</select>
								</label>
								<label className="grid gap-2 text-sm font-medium">
									Default model
									<select
										className={SELECT}
										aria-label="Default model"
										disabled={busy || !source}
										value={replaceDefault}
										onChange={(e) => setReplaceDefault(e.target.value)}
									>
										<option value="">No default</option>
										{(source?.models ?? []).map((m) => (
											<option key={m.id} value={m.id}>
												{m.id}
											</option>
										))}
									</select>
								</label>
								<Button
									variant="destructive"
									className="w-fit"
									// A replace would silently drop the staged changes.
									disabled={busy || !source || staged > 0}
									title={staged > 0 ? PENDING_FIRST : undefined}
									onClick={() => setConfirming(true)}
								>
									Replace catalogue for {clientCount(total)}
								</Button>
							</div>
						</details>
					</>
				)}
				{/* Leave room below the actions for the shared floating Debug shortcut. */}
				<div className="sticky bottom-0 z-10 -mx-5 sm:-mx-6 flex justify-between gap-3 border-t rounded-b-lg bg-card px-5 sm:px-6 pt-4 pb-16">
					<Button variant="ghost" disabled={busy} onClick={onCancel}>
						Close
					</Button>
					{review && (
						<div className="flex gap-2">
							<Button
								variant="outline"
								disabled={busy}
								onClick={() => setReview(null)}
							>
								Back
							</Button>
							<Button
								disabled={busy || !changed}
								onClick={() => apply(review.token)}
							>
								{busy ? "Working…" : `Apply to ${clientCount(changed)}`}
							</Button>
						</div>
					)}
				</div>
			</CardContent>
			<Dialog
				open={confirming}
				onOpenChange={(open) => {
					if (!open && !busy) setConfirming(false);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Replace catalogue</DialogTitle>
						<DialogDescription>
							Every one of the {clients.length} selected{" "}
							{clients.length === 1 ? "client's" : "clients'"} current{" "}
							{FORMATS[format]} entries are discarded and replaced with the{" "}
							{source?.models.length ?? 0} entries from {(() => {
								const picked = clients.find((c) => c.apiKeyId === source?.id);
								return picked
									? clientLabelText(picked.key.name, picked.application)
									: "the chosen client";
							})()}. Other formats are untouched.{" "}
							{dropRoutes
								? "Routes of the aliases it removes are deleted."
								: "Routes of the aliases it removes are kept."}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="outline"
							disabled={busy}
							onClick={() => setConfirming(false)}
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							disabled={busy}
							onClick={() => {
								setConfirming(false);
								void propose({
									format,
									mode: "replace",
									models: source?.models ?? [],
									defaultModel: replaceDefault || null,
								});
							}}
						>
							Replace catalogues
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</Card>
	);
}

/** One client's row in the preview, including what a `modified` ID moved from. */
function PreviewRow({
	result,
	operation,
	stored,
	accountName,
}: {
	result: ClientBulkClientResult;
	operation: ClientBulkOperation;
	stored: ClientView | undefined;
	accountName: (id: string) => string;
}) {
	const names = (model: ClientModel) =>
		model.accountIds?.map(accountName).join(", ") ?? "Any allowed account";
	const describe = (id: string) => {
		const old = stored?.catalogues[operation.format].models.find(
			(m) => m.id === id,
		);
		const next = (
			operation.mode === "replace" ? operation.models : operation.add
		).find((m) => m.id === id);
		if (!old || !next) return id;
		const moves: string[] = [];
		if (old.targetModel !== next.targetModel)
			moves.push(`${old.targetModel} → ${next.targetModel}`);
		if (old.displayName !== next.displayName)
			moves.push(`${old.displayName} → ${next.displayName}`);
		if (pinOf(old) !== pinOf(next))
			moves.push(`${names(old)} → ${names(next)}`);
		return `${id}: ${moves.join(", ")}`;
	};
	return (
		<div data-preview={result.apiKeyId} className="px-3 py-2 text-sm">
			<div className="flex flex-wrap items-baseline gap-x-3">
				<ClientLabel
					apiKeyId={result.apiKeyId}
					name={result.name}
					application={stored?.application ?? null}
					className="font-medium"
				/>
				<span
					className={
						result.status === "rejected"
							? "text-destructive text-xs"
							: "text-muted-foreground text-xs"
					}
				>
					{result.status}
				</span>
			</div>
			{result.status === "rejected" ? (
				<p className="text-xs text-destructive mt-1 break-words">
					{result.reason}
				</p>
			) : (
				<dl className="mt-1 grid gap-x-4 gap-y-0.5 text-xs text-muted-foreground sm:grid-cols-[6rem_minmax(0,1fr)]">
					{result.added.length > 0 && (
						<>
							<dt>Added</dt>
							<dd className="break-all">{result.added.join(", ")}</dd>
						</>
					)}
					{result.removed.length > 0 && (
						<>
							<dt>Removed</dt>
							<dd className="break-all">{result.removed.join(", ")}</dd>
						</>
					)}
					{result.modified.length > 0 && (
						<>
							<dt>Repointed</dt>
							<dd className="break-all">
								{result.modified.map(describe).join("; ")}
							</dd>
						</>
					)}
					{result.droppedRoutes.length > 0 && (
						<>
							<dt>Routes removed</dt>
							<dd className="break-all">{result.droppedRoutes.join(", ")}</dd>
						</>
					)}
					{result.keptRoutes.length > 0 && (
						<>
							<dt>Routes kept</dt>
							<dd className="break-all">{result.keptRoutes.join(", ")}</dd>
						</>
					)}
					{result.defaultModelChange && (
						<>
							<dt>Default model</dt>
							<dd className="break-all">
								{result.defaultModelChange.to === null
									? `Default model cleared (was ${result.defaultModelChange.from})`
									: `${result.defaultModelChange.from ?? "none"} → ${result.defaultModelChange.to}`}
							</dd>
						</>
					)}
				</dl>
			)}
			{result.notices.map((notice) => (
				<p key={notice} className="text-xs text-muted-foreground mt-1">
					{notice}
				</p>
			))}
		</div>
	);
}
