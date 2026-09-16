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
import type { DestinationAccount } from "./ClientWizard";
import { suggestedModel } from "./ClientWizard";
import { ModelFilterField, matchesModelQuery } from "./model-filter";
import { FORMATS } from "./setup";

const SELECT = "h-9 rounded-md border border-input bg-background px-3 text-sm";
const FORMAT_KEYS = Object.keys(FORMATS) as ClientFormat[];
const SHORT: Record<ClientFormat, string> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	codex: "Codex",
};

/** Comparable account pin. `null` (any allowed account) stays distinct from a list. */
const pinOf = (model: ClientModel) =>
	JSON.stringify(model.accountIds ? [...model.accountIds].sort() : null);
const sameDefinition = (a: ClientModel, b: ClientModel) =>
	a.targetModel === b.targetModel &&
	a.displayName === b.displayName &&
	pinOf(a) === pinOf(b);

interface Candidate {
	model: ClientModel;
	/** Selected clients that publish this ID. */
	coverage: number;
	/** Those clients do not agree on what the ID means. */
	conflicted: boolean;
	/** Staged in this panel rather than read from a client or discovery. */
	staged?: boolean;
}

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
	const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
	/** Kept across format tabs: narrowing the list is a view, not an operation. */
	const [query, setQuery] = useState("");
	const [custom, setCustom] = useState(EMPTY_CUSTOM);
	const [customError, setCustomError] = useState<string | null>(null);
	/** Entries the operator typed, which no client and no discovery offers. */
	const [stagedModels, setStagedModels] = useState<ClientModel[]>([]);
	const [source, setSource] = useState<{
		id: string;
		models: ClientModel[];
	} | null>(null);
	const [replaceDefault, setReplaceDefault] = useState("");
	const [confirming, setConfirming] = useState(false);
	const [review, setReview] = useState<ClientBulkReview | null>(null);
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
		// definition that arrived after they checked the row must not be applied
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
	// Every operation reads the unfiltered candidates: hiding a row must not
	// change what is applied.
	const checkedCandidates = candidates.filter((c) => checked.has(c.model.id));
	const visible = candidates.filter((c) => matchesModelQuery(c.model, query));
	const visibleIds = new Set(visible.map((c) => c.model.id));
	const hiddenChecked = checkedCandidates.filter(
		(c) => !visibleIds.has(c.model.id),
	).length;
	const addable =
		checkedCandidates.length > 0 &&
		!checkedCandidates.some((c) => c.conflicted);
	const changeFormat = (next: ClientFormat) => {
		setFormat(next);
		setChecked(new Set());
		setSource(null);
		setReplaceDefault("");
		setStagedModels([]);
		setCustomError(null);
	};
	const toggle = (id: string) =>
		setChecked((current) => {
			const next = new Set(current);
			if (!next.delete(id)) next.add(id);
			return next;
		});
	const stage = () => {
		const id = custom.id.trim();
		const target = custom.target.trim() || id;
		if (!id) {
			setCustomError("Enter a model ID");
			return;
		}
		if (candidates.some((c) => c.model.id === id)) {
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
		setChecked((current) => new Set(current).add(id));
		setCustom(EMPTY_CUSTOM);
		setCustomError(null);
	};
	const unstage = (id: string) => {
		setStagedModels((current) => current.filter((m) => m.id !== id));
		setChecked((current) => {
			const next = new Set(current);
			next.delete(id);
			return next;
		});
	};
	const propose = (operation: ClientBulkOperation) =>
		run(async () => {
			setReview(
				await clientRequest<ClientBulkReview>("/bulk/review", {
					clientIds: clients.map((c) => c.apiKeyId),
					operation,
				}),
			);
		});
	const changed =
		review?.clients.filter((c) => c.status === "changed").length ?? 0;
	/**
	 * Commit, hand the committed views up, and stay open for the next operation
	 * — swapping an official ID for a variant is a remove and an add. The commit
	 * response is what the panel then reads: an invalidation only starts a
	 * refetch, so without it the next operation would work from pre-apply
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
			setChecked(new Set());
			setStagedModels([]);
			setSource(null);
			setReplaceDefault("");
			setNotice(
				`Applied to ${applied} ${applied === 1 ? "client" : "clients"}.`,
			);
		});
	const accountName = (id: string) =>
		accounts.find((a) => a.id === id)?.name ?? id;
	const shown = clients.slice(0, 3).map((c) => c.key.name);

	return (
		<Card>
			<CardHeader className="gap-3">
				<CardTitle>
					Edit catalogues · {clients.length}{" "}
					{clients.length === 1 ? "client" : "clients"}
				</CardTitle>
				<p
					className="text-sm text-muted-foreground"
					title={clients.map((c) => c.key.name).join(", ")}
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
									stored={clients.find((c) => c.apiKeyId === result.apiKeyId)}
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
										className="px-2 text-xs sm:px-3 sm:text-sm"
									>
										{SHORT[f]}
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
						<ModelFilterField
							value={query}
							onChange={setQuery}
							shown={visible.length}
							total={candidates.length}
							label={`Filter ${FORMATS[format]} models`}
						/>
						<section
							aria-label={`${FORMATS[format]} models`}
							className="h-[50dvh] min-h-48 overflow-auto divide-y rounded-md border"
						>
							{candidates.length === 0 && (
								<p className="p-3 text-sm text-muted-foreground">
									No models to choose from in this format yet.
								</p>
							)}
							{candidates.length > 0 && visible.length === 0 && (
								<p className="p-3 text-sm text-muted-foreground">
									No models match this filter.
								</p>
							)}
							{visible.map(({ model, coverage, conflicted, staged }) => (
								<div
									key={model.id}
									data-candidate={model.id}
									className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40"
								>
									<label className="flex flex-1 min-w-0 items-center gap-3">
										<input
											className="shrink-0"
											type="checkbox"
											aria-label={`Select ${model.id}`}
											checked={checked.has(model.id)}
											onChange={() => toggle(model.id)}
										/>
										<span className="min-w-0 flex-1 grid gap-x-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
											<span className="font-medium text-sm break-all leading-5">
												{model.displayName}
												{staged && (
													<span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">
														Custom
													</span>
												)}
											</span>
											<code className="text-xs break-all text-muted-foreground sm:col-start-1 sm:row-start-2">
												{model.id}
												{model.targetModel !== model.id
													? ` → ${model.targetModel}`
													: ""}
											</code>
											<span className="text-xs text-muted-foreground sm:col-start-2 sm:row-start-1 sm:row-span-2 sm:self-center">
												In {coverage} of {clients.length}
												{conflicted
													? ` · Defined differently in ${coverage} ${coverage === 1 ? "client" : "clients"} — edit these individually`
													: ""}
											</span>
										</span>
									</label>
									{staged && (
										<Button
											variant="ghost"
											size="sm"
											className="ml-auto h-7 px-2 text-xs"
											aria-label={`Remove ${model.id} from the list`}
											onClick={() => unstage(model.id)}
										>
											Remove
										</Button>
									)}
								</div>
							))}
						</section>
						{hiddenChecked > 0 && (
							<p className="text-sm text-muted-foreground">
								{checkedCandidates.length} selected · {hiddenChecked} hidden by
								the filter
							</p>
						)}
						<div className="flex flex-wrap gap-2">
							<Button
								disabled={busy || !addable}
								title={
									addable
										? undefined
										: "Selected IDs that different clients define differently, or that a client already publishes against another target, cannot be added in bulk"
								}
								onClick={() =>
									propose({
										format,
										mode: "add",
										models: checkedCandidates.map((c) => c.model),
									})
								}
							>
								Add to all selected
							</Button>
							<Button
								variant="outline"
								disabled={busy || !checkedCandidates.length}
								onClick={() =>
									propose({
										format,
										mode: "remove",
										models: checkedCandidates.map((c) => c.model),
									})
								}
							>
								Remove from all selected
							</Button>
						</div>
						<details className="rounded-md border p-3">
							<summary className="cursor-pointer w-fit text-sm font-medium">
								Add a custom model or alias
							</summary>
							<div className="mt-3 grid gap-4 max-w-xl sm:grid-cols-2">
								<p className="text-sm text-muted-foreground sm:col-span-2">
									Publish an entry no client offers yet. It joins the list
									above, already selected, and is applied like any other
									selection.
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
												{c.key.name} ({c.catalogues[format].models.length})
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
									disabled={busy || !source}
									onClick={() => setConfirming(true)}
								>
									Replace catalogue for {clients.length}{" "}
									{clients.length === 1 ? "client" : "clients"}
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
								{busy
									? "Working…"
									: `Apply to ${changed} ${changed === 1 ? "client" : "clients"}`}
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
							{source?.models.length ?? 0} entries from{" "}
							{clients.find((c) => c.apiKeyId === source?.id)?.key.name ??
								"the chosen client"}
							. Other formats are untouched.
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
		const next = operation.models.find((m) => m.id === id);
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
				<span className="font-medium">{result.name}</span>
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
