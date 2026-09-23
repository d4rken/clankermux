import {
	type ClientFormat,
	type ClientModel,
	type ClientSuggestions,
	type ClientView,
	claudeCodeName,
	type GlobalCatalogueClientResult,
	type GlobalCatalogueDraft,
	type GlobalCatalogueReview,
	type GlobalCatalogueView,
	globalCatalogueFormats,
	globalEntry,
} from "@clankermux/types";
import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import { clientRequest } from "./api";
import { CatalogueSelector } from "./CatalogueSelector";
import { ClientLabel, clientLabelText } from "./ClientLabel";
import type { DestinationAccount } from "./ClientWizard";
import { suggestedModel } from "./ClientWizard";
import { NO_DESTINATION_FILTER, servingAccounts } from "./destination-filter";
import { FORMAT_LABELS, FORMATS } from "./setup";

const SELECT = "h-9 rounded-md border border-input bg-background px-3 text-sm";
const FORMAT_KEYS = Object.keys(FORMATS) as ClientFormat[];
const EMPTY_CUSTOM = {
	id: "",
	target: "",
	name: "",
	accounts: [] as string[],
	editId: null as string | null,
};
const SUBSCRIPTION_LABELS: Record<
	GlobalCatalogueClientResult["subscription"],
	string
> = {
	joins: "Starts using the global catalogue",
	leaves: "Stops using it and keeps its current models",
	stays: "Uses the global catalogue",
};

/** Formats as the operator names them, e.g. "Anthropic" or "Anthropic, OpenAI, Codex". */
const coveredLabel = (client: ClientView) =>
	globalCatalogueFormats(client.application)
		.map((f) => FORMAT_LABELS[f])
		.join(", ");

const draftOf = (view: GlobalCatalogueView): GlobalCatalogueDraft => ({
	revision: view.revision,
	catalogues: structuredClone(view.catalogues),
	subscribers: [...view.subscribers],
});

export function GlobalCatalogueEditor({
	clients,
	accounts,
	onCancel,
	onApplied,
}: {
	clients: ClientView[];
	accounts: DestinationAccount[];
	onCancel: () => void;
	onApplied: (clients: ClientView[]) => void;
}) {
	const busyRef = useRef(false);
	const editorRef = useRef<HTMLDetailsElement>(null);
	const [stored, setStored] = useState<GlobalCatalogueView | null>(null);
	const [draft, setDraft] = useState<GlobalCatalogueDraft | null>(null);
	const [format, setFormat] = useState<ClientFormat>("anthropic");
	const [suggestions, setSuggestions] = useState<ClientSuggestions | null>(
		null,
	);
	const [queries, setQueries] = useState({ available: "", selected: "" });
	const [filter, setFilter] = useState(NO_DESTINATION_FILTER);
	const [custom, setCustom] = useState(EMPTY_CUSTOM);
	/** Entries taken out in this session, so they can be put back as they were. */
	const [removed, setRemoved] = useState<Record<ClientFormat, ClientModel[]>>({
		anthropic: [],
		openai: [],
		codex: [],
	});
	const [copySource, setCopySource] = useState("");
	const [droppedRoutes, setDroppedRoutes] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const [review, setReview] = useState<GlobalCatalogueReview | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const run = async (work: () => Promise<void>) => {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		setError(null);
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
		Promise.all([
			clientRequest<GlobalCatalogueView>("/global-catalogue"),
			clientRequest<ClientSuggestions>("/suggestions", {
				destinations: { accountId: null, providers: null },
				refresh: false,
			}),
		])
			.then(([view, found]) => {
				if (!live) return;
				setStored(view);
				setDraft(draftOf(view));
				setSuggestions(found);
			})
			.catch((e: unknown) => {
				if (live) setError(e instanceof Error ? e.message : String(e));
			});
		return () => {
			live = false;
		};
	}, []);

	if (!draft || !stored)
		return (
			<Card>
				<CardContent className="p-6 space-y-3">
					{error ? (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					) : (
						<p className="text-sm text-muted-foreground">
							Loading the global catalogue…
						</p>
					)}
					<Button variant="ghost" onClick={onCancel}>
						Back to clients
					</Button>
				</CardContent>
			</Card>
		);

	const current = draft.catalogues[format];
	/** Every edit invalidates a review taken of the previous draft. */
	const edit = (change: (d: GlobalCatalogueDraft) => GlobalCatalogueDraft) => {
		setReview(null);
		setDraft((d) => (d ? change(d) : d));
	};
	const setModels = (models: ClientModel[]) =>
		edit((d) => ({
			...d,
			catalogues: {
				...d.catalogues,
				[format]: {
					models: models.map(globalEntry),
					defaultModel: models.some(
						(m) => m.id === d.catalogues[format].defaultModel,
					)
						? d.catalogues[format].defaultModel
						: null,
				},
			},
		}));
	const selectedIds = new Set(current.models.map((m) => m.id));
	const candidates = new Map<string, ClientModel>();
	for (const m of suggestions?.models ?? [])
		if (format !== "codex" || m.codexMetadataAvailable) {
			const model = suggestedModel(m.id, m.displayName);
			candidates.set(model.id, model);
		}
	for (const model of removed[format]) candidates.set(model.id, model);
	const available = [...candidates.values()].filter(
		(m) => !selectedIds.has(m.id),
	);
	const listed = new Set(
		FORMAT_KEYS.flatMap((f) => draft.catalogues[f].models.map((m) => m.id)),
	);
	/** Aliases the saved catalogue publishes that this draft no longer does. */
	const leftAliases = [
		...new Set(
			FORMAT_KEYS.flatMap((f) =>
				stored.catalogues[f].models
					.filter((m) => m.id !== m.targetModel && !listed.has(m.id))
					.map((m) => m.id),
			),
		),
	].sort();
	const subscribers = new Set(draft.subscribers);
	const copyClients = [...clients].sort((a, b) =>
		a.key.name.localeCompare(b.key.name),
	);
	const customIsAlias =
		custom.target.trim() !== "" && custom.target.trim() !== custom.id.trim();

	const submitReview = () =>
		run(async () => {
			const drops = leftAliases.filter((id) => droppedRoutes.has(id));
			setReview(
				await clientRequest<GlobalCatalogueReview>(
					"/global-catalogue/review",
					drops.length ? { ...draft, droppedAliasRoutes: drops } : draft,
				),
			);
		});
	const apply = () =>
		run(async () => {
			if (!review) return;
			const result = await clientRequest<{
				global: GlobalCatalogueView;
				clients: ClientView[];
			}>("/global-catalogue/commit", { token: review.token });
			onApplied(result.clients);
		});

	return (
		<Card>
			<CardHeader className="gap-2 border-b px-5 py-5 sm:px-6">
				<CardTitle className="text-lg leading-6">Global catalogue</CardTitle>
				<p className="text-sm text-muted-foreground max-w-prose">
					Clients that use the global catalogue publish it in their
					application's format, plus the models they add and minus the ones they
					remove. A generic client uses all three formats.
				</p>
			</CardHeader>
			<CardContent className="space-y-5 px-5 pt-5 pb-0 sm:px-6 sm:pt-6">
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				<Tabs
					value={format}
					onValueChange={(value) => {
						setFormat(value as ClientFormat);
						setCustom(EMPTY_CUSTOM);
					}}
					className="space-y-4"
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
								{FORMAT_LABELS[f]}
								<span className="ml-1.5 rounded bg-muted px-1 text-xs tabular-nums">
									{draft.catalogues[f].models.length}
								</span>
							</TabsTrigger>
						))}
					</TabsList>
				</Tabs>
				<div className="flex flex-wrap items-end gap-3">
					<label className="grid gap-2 text-sm font-medium">
						Copy this format from a client
						<select
							className={SELECT}
							aria-label="Copy from client"
							disabled={busy}
							value={copySource}
							onChange={(e) => setCopySource(e.target.value)}
						>
							<option value="">Choose a client</option>
							{copyClients.map((c) => (
								<option key={c.apiKeyId} value={c.apiKeyId}>
									{clientLabelText(c.key.name, c.application)} (
									{c.catalogues[format].models.length})
								</option>
							))}
						</select>
					</label>
					<Button
						variant="outline"
						disabled={busy || !copySource}
						onClick={() => {
							const source = clients.find((c) => c.apiKeyId === copySource);
							if (!source) return;
							edit((d) => ({
								...d,
								catalogues: {
									...d.catalogues,
									[format]: {
										models: source.catalogues[format].models.map(globalEntry),
										defaultModel: source.catalogues[format].defaultModel,
									},
								},
							}));
						}}
					>
						Copy into {FORMAT_LABELS[format]}
					</Button>
				</div>
				<CatalogueSelector
					formatLabel={FORMATS[format]}
					available={available}
					selected={current.models}
					queries={queries}
					onQueryChange={(side, value) =>
						setQueries((q) => ({ ...q, [side]: value }))
					}
					filter={filter}
					onFilterChange={setFilter}
					busy={busy}
					modelAccounts={(model) =>
						servingAccounts(model, suggestions, accounts)
					}
					rowExtras={(model) =>
						format === "anthropic" && claudeCodeName(model.id) !== model.id
							? {
									note: (
										<span className="block text-xs text-muted-foreground">
											Claude Code lists it as {claudeCodeName(model.id)}
										</span>
									),
								}
							: {}
					}
					onAdd={(models) => {
						const ids = new Set(models.map((m) => m.id));
						setRemoved((r) => ({
							...r,
							[format]: r[format].filter((m) => !ids.has(m.id)),
						}));
						setModels([...current.models, ...models]);
					}}
					onRemove={(models) => {
						const ids = new Set(models.map((m) => m.id));
						setRemoved((r) => ({
							...r,
							[format]: [...r[format].filter((m) => !ids.has(m.id)), ...models],
						}));
						setModels(current.models.filter((m) => !ids.has(m.id)));
					}}
					onEdit={(model) => {
						requestAnimationFrame(() =>
							editorRef.current?.scrollIntoView({
								block: "nearest",
								behavior: "smooth",
							}),
						);
						setCustom({
							id: model.id,
							target: model.targetModel,
							name: model.displayName,
							accounts: model.accountIds ?? [],
							editId: model.id,
						});
					}}
				>
					<label className="grid gap-2 max-w-xl text-sm font-medium">
						Default model
						<select
							className={`${SELECT} min-w-0 w-full`}
							aria-label="Default model"
							disabled={busy || !current.models.length}
							value={current.defaultModel ?? ""}
							onChange={(e) =>
								edit((d) => ({
									...d,
									catalogues: {
										...d.catalogues,
										[format]: {
											...d.catalogues[format],
											defaultModel: e.target.value || null,
										},
									},
								}))
							}
						>
							<option value="">No default</option>
							{current.models.map((m) => (
								<option value={m.id} key={m.id}>
									{m.displayName}
								</option>
							))}
						</select>
					</label>
				</CatalogueSelector>
				<details
					ref={editorRef}
					className="rounded-md border p-3"
					open={custom.editId !== null ? true : undefined}
				>
					<summary className="cursor-pointer text-sm font-medium">
						Add a custom model or alias
					</summary>
					<div className="grid gap-4 pt-4 sm:grid-cols-2">
						<label
							className="grid gap-2 text-sm font-medium"
							htmlFor="global-model-id"
						>
							Published model ID
							<Input
								id="global-model-id"
								disabled={busy}
								value={custom.id}
								onChange={(e) => setCustom({ ...custom, id: e.target.value })}
							/>
						</label>
						<label
							className="grid gap-2 text-sm font-medium"
							htmlFor="global-target-id"
						>
							Target model or alias ID
							<Input
								id="global-target-id"
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
							htmlFor="global-display-name"
						>
							Display name
							<Input
								id="global-display-name"
								disabled={busy}
								value={custom.name}
								onChange={(e) => setCustom({ ...custom, name: e.target.value })}
							/>
						</label>
						<fieldset className="sm:col-span-2">
							<legend className="text-sm mb-2">
								A concrete model published under a different ID needs its
								accounts. A client whose destinations exclude them skips the
								entry.
							</legend>
							<div className="flex flex-wrap gap-3">
								{accounts.map((a) => (
									<label key={a.id} className="text-sm flex gap-2">
										<input
											type="checkbox"
											disabled={busy || !customIsAlias}
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
						<Button
							variant="outline"
							disabled={busy}
							onClick={() => {
								const model: ClientModel = {
									id: custom.id.trim(),
									displayName: custom.name.trim() || custom.id.trim(),
									targetModel: custom.target.trim() || custom.id.trim(),
									accountIds:
										customIsAlias && custom.accounts.length
											? custom.accounts
											: null,
								};
								if (
									!model.id ||
									current.models.some(
										(m) => m.id === model.id && m.id !== custom.editId,
									)
								) {
									setError("Enter a unique model ID");
									return;
								}
								setModels([
									...current.models.filter((m) => m.id !== custom.editId),
									model,
								]);
								setCustom(EMPTY_CUSTOM);
							}}
						>
							{custom.editId ? "Update entry" : "Add entry"}
						</Button>
					</div>
				</details>
				<fieldset className="rounded-md border p-3 space-y-2">
					<legend className="px-1 text-sm font-medium">
						Clients using the global catalogue
					</legend>
					<p className="text-xs text-muted-foreground">
						A client that starts using it publishes exactly the global
						catalogue. A client that stops keeps what it publishes now as its
						own catalogue.
					</p>
					<ul className="grid gap-1.5 sm:grid-cols-2">
						{copyClients.map((c) => (
							<li key={c.apiKeyId}>
								<label className="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										disabled={busy}
										aria-label={`Use the global catalogue for ${clientLabelText(c.key.name, c.application)}`}
										checked={subscribers.has(c.apiKeyId)}
										onChange={() =>
											edit((d) => ({
												...d,
												subscribers: d.subscribers.includes(c.apiKeyId)
													? d.subscribers.filter((id) => id !== c.apiKeyId)
													: [...d.subscribers, c.apiKeyId],
											}))
										}
									/>
									<ClientLabel
										apiKeyId={c.apiKeyId}
										name={c.key.name}
										application={c.application}
									/>
									<span className="text-xs text-muted-foreground">
										{coveredLabel(c)}
									</span>
								</label>
							</li>
						))}
					</ul>
				</fieldset>
				{leftAliases.length > 0 && (
					<section
						aria-label="Leftover alias routes"
						className="rounded-md border p-3 space-y-2 text-sm"
					>
						<p className="font-medium">Aliases this edit stops publishing</p>
						<p className="text-muted-foreground">
							Each client keeps the route of an alias it stops publishing, so
							anything still sending that ID keeps working. Remove the routes
							once nothing does.
						</p>
						{leftAliases.map((id) => (
							<label key={id} className="flex items-center gap-2">
								<input
									type="checkbox"
									disabled={busy}
									checked={droppedRoutes.has(id)}
									onChange={() => {
										setReview(null);
										setDroppedRoutes((current) => {
											const next = new Set(current);
											if (!next.delete(id)) next.add(id);
											return next;
										});
									}}
								/>
								Remove the {id} route from every client using the global
								catalogue
							</label>
						))}
					</section>
				)}
				{review && (
					<section aria-label="Review" className="space-y-3">
						<h3 className="font-semibold">What changes</h3>
						{review.clients.length === 0 && (
							<p className="text-sm text-muted-foreground">
								No client uses the global catalogue, so saving changes only the
								global catalogue itself.
							</p>
						)}
						<ul className="divide-y rounded-md border">
							{review.clients.map((result) => (
								<ReviewRow key={result.apiKeyId} result={result} />
							))}
						</ul>
					</section>
				)}
				<div className="sticky bottom-0 z-10 -mx-5 sm:-mx-6 flex justify-between gap-3 border-t rounded-b-lg bg-card px-5 sm:px-6 pt-4 pb-16">
					<Button variant="ghost" disabled={busy} onClick={onCancel}>
						Cancel
					</Button>
					<Button disabled={busy} onClick={review ? apply : submitReview}>
						{busy
							? "Working…"
							: review
								? "Save global catalogue"
								: "Review changes"}
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}

function ReviewRow({ result }: { result: GlobalCatalogueClientResult }) {
	return (
		<li className="p-3 space-y-1 text-sm">
			<p className="font-medium">
				{result.name}{" "}
				<span className="font-normal text-muted-foreground">
					· {SUBSCRIPTION_LABELS[result.subscription]}
				</span>
			</p>
			{result.status === "rejected" && (
				<p className="text-destructive">
					Not updated: {result.reason}. It keeps what it publishes now.
				</p>
			)}
			{result.status === "unchanged" && (
				<p className="text-muted-foreground">No change to what it publishes.</p>
			)}
			{result.status === "changed" &&
				Object.entries(result.formats).map(([f, change]) => (
					<div key={f} className="text-xs space-y-0.5">
						<p className="font-medium">{FORMAT_LABELS[f as ClientFormat]}</p>
						{change.added.length > 0 && <p>Adds {change.added.join(", ")}</p>}
						{change.removed.length > 0 && (
							<p>Removes {change.removed.join(", ")}</p>
						)}
						{change.modified.length > 0 && (
							<p>Changes {change.modified.join(", ")}</p>
						)}
						{change.defaultModelChange && (
							<p>
								Default {change.defaultModelChange.from ?? "none"} becomes{" "}
								{change.defaultModelChange.to ?? "none"}
							</p>
						)}
						{change.skipped.map((s) => (
							<p key={s.id} className="text-muted-foreground">
								Skips {s.id}: {s.reason}
							</p>
						))}
					</div>
				))}
		</li>
	);
}
