import type {
	ClientApplication,
	ClientCatalogue,
	ClientDraft,
	ClientFormat,
	ClientModel,
	ClientReview,
	ClientSuggestions,
	ClientView,
} from "@clankermux/types";
import { useRef, useState } from "react";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { clientRequest } from "./api";
import { ModelFilterField, matchesModelQuery } from "./model-filter";
import {
	APPLICATIONS,
	destinationsLabel,
	FORMAT_LABELS,
	FORMATS,
	needsClaudeAlias,
	preferredFormat,
} from "./setup";

export interface DestinationAccount {
	id: string;
	name: string;
	provider: string;
}
const SELECT = "h-9 rounded-md border border-input bg-background px-3 text-sm";
const FORMAT_KEYS = Object.keys(FORMATS) as ClientFormat[];
const COPY_PARTS = [
	{ key: "application", label: "Application recipe" },
	{ key: "destinations", label: "Allowed destinations" },
	{ key: "catalogues", label: "All three catalogues" },
] as const;
export function draftFor(client?: ClientView): ClientDraft {
	return client
		? {
				id: client.apiKeyId,
				revision: client.revision,
				name: client.key.name,
				application: client.application,
				destinations: {
					accountId: client.key.pinnedAccountId,
					providers: client.key.pinnedProviders,
				},
				catalogues: structuredClone(client.catalogues),
			}
		: {
				name: "",
				application: "generic",
				destinations: { accountId: null, providers: null },
				catalogues: {
					anthropic: { models: [], defaultModel: null },
					openai: { models: [], defaultModel: null },
					codex: { models: [], defaultModel: null },
				},
			};
}
export function suggestedModel(
	id: string,
	displayName: string,
	accountIds: string[],
	application: ClientApplication,
	format: ClientFormat,
): ClientModel {
	const alias =
		application === "claude-code" &&
		format === "anthropic" &&
		needsClaudeAlias(id);
	return {
		id: alias ? `claude-${id}` : id,
		displayName,
		targetModel: id,
		accountIds: alias ? accountIds : null,
	};
}
/**
 * The two server rules a copy can break that the draft alone cannot repair,
 * phrased for the operator. Selecting models by hand cannot reach either: the
 * Anthropic rule is applied by `suggestedModel` as entries are offered, and the
 * Codex tab only ever offers targets discovery could substantiate. Copying
 * takes another client's entries verbatim, so it can carry in both.
 *
 * Review is still the authority; this only moves the refusal forward to the
 * click that caused it.
 */
function uncommittable(
	application: ClientApplication,
	catalogues: Record<ClientFormat, ClientCatalogue>,
	discovered: ClientSuggestions | null,
): string[] {
	const messages: string[] = [];
	const unaliased =
		application === "claude-code"
			? catalogues.anthropic.models
					.filter((m) => needsClaudeAlias(m.id))
					.map((m) => m.id)
			: [];
	if (unaliased.length)
		messages.push(
			`Claude Code cannot publish ${unaliased.join(", ")} under ${unaliased.length === 1 ? "that ID" : "those IDs"}; each needs a claude-* alias.`,
		);
	// Undiscovered is not the same as unavailable, so this stays silent until
	// discovery has actually answered for these destinations.
	const rich = new Set(
		(discovered?.models ?? [])
			.filter((m) => m.codexMetadataAvailable)
			.map((m) => m.id),
	);
	const bare = discovered
		? catalogues.codex.models
				.filter((m) => !rich.has(m.targetModel))
				.map((m) => m.id)
		: [];
	if (bare.length)
		messages.push(
			`These destinations have no Codex metadata for ${bare.join(", ")}.`,
		);
	return messages;
}
export function ClientWizard({
	client,
	clients,
	accounts,
	onCancel,
	onSaved,
}: {
	client?: ClientView;
	/** Every client, so this draft can be seeded from one of the others. */
	clients: ClientView[];
	accounts: DestinationAccount[];
	onCancel: () => void;
	onSaved: (result: { client: ClientView; apiKey?: string }) => void;
}) {
	const busyRef = useRef(false);
	const suggestionsDestinations = useRef<string | null>(null);
	const editorRef = useRef<HTMLDetailsElement>(null);
	const [draft, setDraft] = useState(() => draftFor(client));
	const [step, setStep] = useState(0);
	const [format, setFormat] = useState<ClientFormat>(
		preferredFormat(draft.application),
	);
	const [suggestions, setSuggestions] = useState<ClientSuggestions | null>(
		null,
	);
	const [review, setReview] = useState<ClientReview | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** A new client still owes its one automatic catalogue seed. */
	const [pendingSeed, setPendingSeed] = useState(!client);
	/** The format that seed wrote, so an application change can withdraw it. */
	const [seeded, setSeeded] = useState<ClientFormat | null>(null);
	/** Formats the operator has edited. Sticky: editing back is still intent. */
	const [touched, setTouched] = useState<ReadonlySet<ClientFormat>>(
		() => new Set(),
	);
	const [custom, setCustom] = useState({
		id: "",
		target: "",
		name: "",
		accounts: [] as string[],
		editId: null as string | null,
	});
	/** Kept across format tabs: narrowing the list is a view, not catalogue data. */
	const [query, setQuery] = useState("");
	const [copy, setCopy] = useState({
		sourceId: "",
		application: true,
		destinations: true,
		catalogues: true,
	});
	const [copied, setCopied] = useState<string | null>(null);
	const mode =
		draft.destinations.accountId !== null
			? "account"
			: draft.destinations.providers !== null
				? "providers"
				: "all";
	const providers = [...new Set(accounts.map((a) => a.provider))].sort();
	const eligible = accounts.filter(
		(a) =>
			mode === "all" ||
			(mode === "account"
				? a.id === draft.destinations.accountId
				: draft.destinations.providers?.includes(a.provider)),
	);
	const eligibleIds = new Set(eligible.map((a) => a.id));
	const conflicts = Object.entries(draft.catalogues).flatMap(([f, c]) =>
		c.models
			.filter(
				(m) =>
					(m.id !== m.targetModel && !m.accountIds?.length) ||
					m.accountIds?.some((id) => !eligibleIds.has(id)),
			)
			.map((m) => `${FORMATS[f as ClientFormat]}: ${m.id}`),
	);
	const replacedAliases = new Set(
		Object.values(draft.catalogues)
			.flatMap((c) => c.models)
			.filter((m) => m.id !== m.targetModel)
			.map((m) => m.id),
	);
	const retainedConflicts = (client?.aliasRules ?? []).filter(
		(r) =>
			mode !== "all" &&
			!replacedAliases.has(r.match_model_value ?? "") &&
			(r.pool_kind === "accounts"
				? !r.pool_account_ids?.some((id) => eligibleIds.has(id))
				: r.pool_kind === "provider" &&
					(mode === "account"
						? !eligible.some((a) => a.provider === r.pool_provider)
						: !draft.destinations.providers?.includes(r.pool_provider ?? ""))),
	);
	/**
	 * Destinations are only recorded for an alias. An entry published under its
	 * own name writes no routing rule, so a saved account list would reach
	 * nothing the proxy reads.
	 */
	const customIsAlias =
		custom.target.trim() !== "" && custom.target.trim() !== custom.id.trim();
	const editorAccounts = [
		...eligible,
		...custom.accounts
			.filter((id) => !eligibleIds.has(id))
			.map((id) => ({
				id,
				name: `${accounts.find((a) => a.id === id)?.name ?? id} (outside destinations)`,
				provider: "",
			})),
	];
	const run = async (work: () => Promise<void>) => {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		setError(null);
		setCopied(null);
		try {
			await work();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};
	const markTouched = (f: ClientFormat) =>
		setTouched((current) =>
			current.has(f) ? current : new Set(current).add(f),
		);
	const updateModels = (models: ClientModel[]) => {
		markTouched(format);
		setDraft((d) => ({
			...d,
			catalogues: {
				...d.catalogues,
				[format]: {
					...d.catalogues[format],
					models,
					defaultModel: models.some(
						(m) => m.id === d.catalogues[format].defaultModel,
					)
						? d.catalogues[format].defaultModel
						: null,
				},
			},
		}));
	};
	/**
	 * Suggestions for the current destinations, reusing the cached result when
	 * they have not changed. Seeding must not depend on a fetch: an application
	 * change reseeds without touching destinations.
	 */
	const ensureSuggestions = async (
		refresh = false,
		destinations = draft.destinations,
	) => {
		const stamp = JSON.stringify(destinations);
		if (!refresh && suggestions && suggestionsDestinations.current === stamp)
			return suggestions;
		const result = await clientRequest<ClientSuggestions>("/suggestions", {
			destinations,
			refresh,
		});
		setSuggestions(result);
		suggestionsDestinations.current = stamp;
		return result;
	};
	/**
	 * Write the owed seed into `application`'s preferred format and spend it.
	 * The application is passed rather than read off the draft: a seed is armed
	 * by the change that selects a new application, so the state holding it has
	 * not landed by the time the seed is written.
	 */
	const seedPreferred = (
		application: ClientApplication,
		models: ClientSuggestions["models"],
	) => {
		const preferred = preferredFormat(application);
		setDraft((d) => ({
			...d,
			catalogues: {
				...d.catalogues,
				[preferred]: {
					defaultModel: null,
					models: models
						.filter((m) => preferred !== "codex" || m.codexMetadataAvailable)
						.map((m) =>
							suggestedModel(
								m.id,
								m.displayName,
								m.accountIds,
								application,
								preferred,
							),
						),
				},
			},
		}));
		setSeeded(preferred);
		setPendingSeed(false);
	};
	const loadSuggestions = async (refresh = false) => {
		const result = await ensureSuggestions(refresh);
		if (!pendingSeed) return;
		const preferred = preferredFormat(draft.application);
		// An edited catalogue outranks a seed that is still owed to it.
		if (touched.has(preferred)) {
			setPendingSeed(false);
			return;
		}
		seedPreferred(draft.application, result.models);
	};
	/**
	 * Move the automatic seed to the new application's format. Only formats the
	 * operator has never edited are rewritten, so a hand-built catalogue — an
	 * emptied one included — survives switching applications.
	 */
	const changeApplication = (application: ClientApplication) => {
		const next = preferredFormat(application);
		setFormat(next);
		setDraft((d) => {
			const previous = preferredFormat(d.application);
			const drop =
				previous !== next && seeded === previous && !touched.has(previous);
			return {
				...d,
				application,
				catalogues: drop
					? {
							...d.catalogues,
							[previous]: { models: [], defaultModel: null },
						}
					: d.catalogues,
			};
		});
		if (client) return;
		const previous = preferredFormat(draft.application);
		if (previous === next) return;
		if (seeded === previous) setSeeded(null);
		// Decide the pending seed in both directions. Returning to a format the
		// operator has edited must WITHDRAW a seed armed by the trip away from it,
		// or that seed lands on their work the next time the catalogue opens.
		setPendingSeed(!touched.has(next));
	};
	const copySources = clients
		.filter((c) => c.apiKeyId !== client?.apiKeyId)
		.sort((a, b) => a.key.name.localeCompare(b.key.name));
	const copySource = copySources.find((c) => c.apiKeyId === copy.sourceId);
	const copyParts = COPY_PARTS.filter((part) => copy[part.key]);
	/**
	 * Seed this draft from another client. The name and the API key are the
	 * client's identity, so they are never part of a copy; everything else is
	 * replaced outright rather than merged, because a half-copied catalogue is
	 * not a configuration either client has ever run.
	 */
	const applyCopy = () =>
		run(async () => {
			const source = copySource;
			if (!source) return;
			const application = copy.application
				? source.application
				: draft.application;
			const destinations = copy.destinations
				? {
						accountId: source.key.pinnedAccountId,
						providers: source.key.pinnedProviders,
					}
				: draft.destinations;
			const catalogues = copy.catalogues
				? structuredClone(source.catalogues)
				: draft.catalogues;
			const nextPreferred = preferredFormat(application);
			/**
			 * `changeApplication` arms a seed whenever it moves a new client to a
			 * format they have never edited, and only the step-2 entry consumes
			 * one. A copy runs with step 2 already open, so an armed seed nobody
			 * writes would leave Review refusing with "Choose your catalogue models
			 * before reviewing" until the operator left the step and came back.
			 */
			const seedOwed =
				!client &&
				copy.application &&
				!copy.catalogues &&
				nextPreferred !== preferredFormat(draft.application) &&
				!touched.has(nextPreferred);
			if (copy.application) changeApplication(source.application);
			setDraft((d) => ({
				...d,
				destinations,
				...(copy.catalogues ? { catalogues } : {}),
			}));
			if (copy.catalogues) {
				// A copied catalogue is the operator's answer for every format, so
				// the automatic seed is spent and an application change must not
				// discard what was copied.
				setTouched(new Set(FORMAT_KEYS));
				setSeeded(null);
				setPendingSeed(false);
			}
			setCustom({ id: "", target: "", name: "", accounts: [], editId: null });
			// Discovery is scoped to the destinations, so copied ones need their own
			// suggestions before the candidate list — or a seed — means anything.
			const discovered =
				copy.destinations || seedOwed
					? await ensureSuggestions(false, destinations)
					: suggestions;
			if (seedOwed) seedPreferred(application, discovered?.models ?? []);
			const rejected = uncommittable(application, catalogues, discovered);
			setCopied(
				`Copied ${copyParts.map((part) => part.label.toLowerCase()).join(", ")} from ${source.key.name}. Nothing is saved until you review.${
					rejected.length
						? ` ${rejected.join(" ")} Fix that on the affected tab, or Review will refuse the whole client.`
						: ""
				}`,
			);
		});
	const candidates = new Map<string, ClientModel>();
	for (const m of suggestions?.models ?? [])
		if (format !== "codex" || m.codexMetadataAvailable) {
			const model = suggestedModel(
				m.id,
				m.displayName,
				m.accountIds,
				draft.application,
				format,
			);
			candidates.set(model.id, model);
		}
	for (const model of draft.catalogues[format].models)
		candidates.set(model.id, model);
	const filtering = query.trim().length > 0;
	const visibleCandidates = [...candidates.values()].filter((m) =>
		matchesModelQuery(m, query),
	);
	// Bulk selection acts on what the filter shows; a selected entry the filter
	// hides keeps its place in the catalogue.
	const visibleIds = new Set(visibleCandidates.map((m) => m.id));
	const goToStep = (target: number) =>
		run(async () => {
			if (target > step && !draft.name.trim())
				throw new Error("Enter a client name");
			setReview(null);
			if (target === 2) await loadSuggestions();
			if (target === 3) {
				if (pendingSeed)
					throw new Error("Choose your catalogue models before reviewing");
				const undecided = FORMAT_KEYS.find(
					(f) =>
						draft.catalogues[f].models.length > 0 &&
						!draft.catalogues[f].models.some(
							(m) => m.id === draft.catalogues[f].defaultModel,
						),
				);
				if (undecided) {
					setFormat(undecided);
					setStep(2);
					throw new Error(
						`Choose a default model for ${FORMATS[undecided]} before reviewing`,
					);
				}
				setReview(await clientRequest<ClientReview>("/review", draft));
			}
			setStep(target);
		});
	const next = () =>
		step < 3
			? goToStep(step + 1)
			: run(async () => {
					if (review)
						onSaved(
							await clientRequest<{ client: ClientView; apiKey?: string }>(
								"/commit",
								{ token: review.token },
							),
						);
				});

	return (
		<Card>
			<CardHeader className="gap-5 border-b px-5 py-5 sm:px-6">
				<CardTitle className="text-lg leading-6">
					{client ? `Configure ${client.key.name}` : "Add client"}
				</CardTitle>
				<ol
					aria-label="Setup steps"
					className="flex flex-wrap gap-x-6 gap-y-3 text-sm text-muted-foreground"
				>
					{["Application", "Destinations", "Catalogue", "Review"].map(
						(label, i) => (
							<li
								key={label}
								aria-current={step === i ? "step" : undefined}
								className={step === i ? "font-medium text-foreground" : ""}
							>
								<button
									type="button"
									aria-label={label}
									disabled={busy}
									onClick={() => {
										if (i !== step) void goToStep(i);
									}}
									className="flex items-center gap-2 rounded-md text-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
								>
									<span
										aria-hidden="true"
										className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${step === i ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
									>
										{i + 1}
									</span>
									{label}
								</button>
							</li>
						),
					)}
				</ol>
			</CardHeader>
			<CardContent className="space-y-5 px-5 pt-5 pb-0 sm:px-6 sm:pt-6">
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				{step === 0 && (
					<div className="grid max-w-xl gap-3 py-1">
						<label
							className="grid gap-2 text-sm font-medium"
							htmlFor="client-name"
						>
							Client name
							<Input
								id="client-name"
								aria-label="Client name"
								placeholder="CNC / OpenCode"
								maxLength={100}
								value={draft.name}
								onChange={(e) => setDraft({ ...draft, name: e.target.value })}
							/>
						</label>
						<p className="text-xs leading-5 text-muted-foreground -mt-1 mb-3">
							Name this installation, script, or integration. It gets its own
							API key and model catalogue.
						</p>
						<label className="grid gap-2 text-sm font-medium">
							Application
							<select
								className={SELECT}
								aria-label="Application"
								disabled={busy}
								value={draft.application}
								onChange={(e) =>
									changeApplication(e.target.value as ClientApplication)
								}
							>
								{Object.entries(APPLICATIONS).map(([value, label]) => (
									<option key={value} value={value}>
										{label}
									</option>
								))}
							</select>
						</label>
						<p className="text-xs leading-5 text-muted-foreground -mt-1">
							The application selects a setup recipe. Every client can use all
							supported API protocols.
						</p>
					</div>
				)}
				{step === 1 && (
					<div className="space-y-group">
						<p>Choose which upstream destinations this client can use.</p>
						<label className="grid gap-2 max-w-xl text-sm font-medium">
							Allowed destinations
							<select
								className={SELECT}
								disabled={busy}
								value={mode}
								onChange={(e) =>
									setDraft({
										...draft,
										destinations:
											e.target.value === "all"
												? { accountId: null, providers: null }
												: e.target.value === "account"
													? {
															accountId: accounts[0]?.id ?? "",
															providers: null,
														}
													: {
															accountId: null,
															providers: providers.slice(0, 1),
														},
									})
								}
							>
								<option value="all">All accounts</option>
								<option value="providers">Selected providers</option>
								<option value="account">One account</option>
							</select>
						</label>
						{mode === "account" && (
							<label className="grid gap-2 max-w-xl text-sm font-medium">
								Account
								<select
									className={SELECT}
									disabled={busy}
									value={draft.destinations.accountId ?? ""}
									onChange={(e) =>
										setDraft({
											...draft,
											destinations: {
												accountId: e.target.value,
												providers: null,
											},
										})
									}
								>
									{accounts.map((a) => (
										<option key={a.id} value={a.id}>
											{a.name} ({a.provider})
										</option>
									))}
								</select>
							</label>
						)}
						{mode === "providers" && (
							<fieldset className="flex flex-wrap gap-group">
								<legend className="mb-2 text-sm">Allowed providers</legend>
								{providers.map((provider) => (
									<label key={provider} className="flex gap-2 items-center">
										<input
											type="checkbox"
											disabled={busy}
											checked={
												draft.destinations.providers?.includes(provider) ??
												false
											}
											onChange={(e) =>
												setDraft({
													...draft,
													destinations: {
														accountId: null,
														providers: e.target.checked
															? [
																	...(draft.destinations.providers ?? []),
																	provider,
																]
															: (draft.destinations.providers?.filter(
																	(p) => p !== provider,
																) ?? []),
													},
												})
											}
										/>
										{provider}
									</label>
								))}
							</fieldset>
						)}
						<p className="text-sm text-muted-foreground">
							These restrictions apply to upstream requests. Catalogue
							visibility is configured separately.
						</p>
					</div>
				)}
				{step === 2 && (
					<Tabs
						value={format}
						onValueChange={(value) => {
							setFormat(value as ClientFormat);
							setCustom({
								id: "",
								target: "",
								name: "",
								accounts: [],
								editId: null,
							});
						}}
						className="space-y-4"
					>
						<div className="flex flex-wrap justify-between gap-group">
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

							<Button
								variant="outline"
								disabled={busy}
								onClick={() => run(() => loadSuggestions(true))}
							>
								Refresh suggestions
							</Button>
						</div>
						<p className="text-sm text-muted-foreground">
							Each tab has its own selections. All three catalogues are saved
							together. Hiding a model only removes it from discovery; it does
							not block requests.
						</p>
						<details className="rounded-md border p-3">
							<summary className="cursor-pointer w-fit text-sm font-medium">
								Copy setup from another client
							</summary>
							{copySources.length === 0 ? (
								<p className="mt-3 text-sm text-muted-foreground">
									There is no other client to copy from yet.
								</p>
							) : (
								<div className="mt-3 grid gap-3 max-w-xl">
									<p className="text-sm text-muted-foreground">
										Load another client's configuration into this draft. The
										client name and API key are never copied, and nothing is
										saved until you review.
									</p>
									<label className="grid gap-2 text-sm font-medium">
										Copy from
										<select
											className={SELECT}
											aria-label="Copy from"
											disabled={busy}
											value={copy.sourceId}
											onChange={(e) =>
												setCopy({ ...copy, sourceId: e.target.value })
											}
										>
											<option value="">Choose a client</option>
											{copySources.map((c) => (
												<option key={c.apiKeyId} value={c.apiKeyId}>
													{c.key.name}
												</option>
											))}
										</select>
									</label>
									{copySource && (
										<p className="text-xs leading-5 text-muted-foreground -mt-1">
											{APPLICATIONS[copySource.application]} ·{" "}
											{destinationsLabel(copySource.key, accounts)} ·{" "}
											{FORMAT_KEYS.map(
												(f) =>
													`${copySource.catalogues[f].models.length} ${FORMAT_LABELS[f]}`,
											).join(", ")}
										</p>
									)}
									<fieldset>
										<legend className="text-sm mb-2">What to copy</legend>
										<div className="flex flex-wrap gap-3">
											{COPY_PARTS.map((part) => (
												<label key={part.key} className="text-sm flex gap-2">
													<input
														type="checkbox"
														disabled={busy}
														checked={copy[part.key]}
														onChange={(e) =>
															setCopy({
																...copy,
																[part.key]: e.target.checked,
															})
														}
													/>
													{part.label}
												</label>
											))}
										</div>
									</fieldset>
									<Button
										variant="outline"
										className="w-fit"
										disabled={busy || !copySource || !copyParts.length}
										onClick={applyCopy}
									>
										Copy into this draft
									</Button>
								</div>
							)}
						</details>
						{copied && (
							<p role="status" className="text-sm text-muted-foreground">
								{copied}
							</p>
						)}
						{(conflicts.length > 0 || retainedConflicts.length > 0) && (
							<div
								role="alert"
								className="rounded border border-destructive/40 p-3 text-sm space-y-2"
							>
								<p className="font-medium">
									Some model destinations need attention
								</p>
								{conflicts.length > 0 && (
									<>
										<p>
											Edit these entries to remove excluded accounts and choose
											allowed destinations. Switch catalogue format to see each
											entry.
										</p>
										<ul className="list-disc pl-5 max-h-24 overflow-auto">
											{conflicts.map((c) => (
												<li key={c}>{c}</li>
											))}
										</ul>
									</>
								)}
								{retainedConflicts.length > 0 && (
									<>
										<p>
											Hidden aliases keep their routes. Update these rules in{" "}
											<a
												href="/routing"
												target="_blank"
												rel="noreferrer"
												className="underline"
											>
												Routing
											</a>
											, then reopen this client, or restore the previous
											destinations:
										</p>
										<ul className="list-disc pl-5 max-h-24 overflow-auto">
											{retainedConflicts.map((r) => (
												<li key={r.id}>{r.name}</li>
											))}
										</ul>
									</>
								)}
							</div>
						)}
						{suggestions && (
							<details className="text-xs text-muted-foreground">
								<summary className="cursor-pointer w-fit">
									Discovery from {suggestions.accounts.length}{" "}
									{suggestions.accounts.length === 1 ? "account" : "accounts"}
									{suggestions.accounts.some(
										(a) => a.error || a.completeness === "unknown",
									)
										? " · Some model lists unavailable"
										: ""}
								</summary>
								<div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
									{suggestions.accounts.map((a) => (
										<p key={a.id} className="text-xs text-muted-foreground">
											{a.name}:{" "}
											{a.completeness === "unknown"
												? "model list unknown"
												: a.completeness === "known-empty"
													? "no discovered models"
													: "model list discovered"}
											{a.error ? ` · ${a.error}` : ""}
										</p>
									))}
								</div>
							</details>
						)}
						<TabsContent key={format} value={format} className="space-y-4 mt-0">
							{format === "codex" && (
								<p className="text-sm text-muted-foreground">
									Only targets with known Codex metadata can be added.
									Previously copied generic fallback entries remain until you
									configure this catalogue.
								</p>
							)}
							<div className="flex flex-wrap gap-2">
								<Button
									size="sm"
									variant="outline"
									onClick={() =>
										updateModels([
											...draft.catalogues[format].models.filter(
												(m) => !visibleIds.has(m.id),
											),
											...visibleCandidates,
										])
									}
								>
									{filtering ? "Select all shown" : "Select all in tab"}
								</Button>
								<Button
									size="sm"
									variant="outline"
									onClick={() =>
										updateModels(
											draft.catalogues[format].models.filter(
												(m) => !visibleIds.has(m.id),
											),
										)
									}
								>
									{filtering ? "Deselect all shown" : "Deselect all in tab"}
								</Button>
								<span className="text-sm self-center text-muted-foreground">
									{draft.catalogues[format].models.length} selected
								</span>
							</div>
							<ModelFilterField
								value={query}
								onChange={setQuery}
								shown={visibleCandidates.length}
								total={candidates.size}
								label={`Filter ${FORMATS[format]} models`}
							/>
							{/* Reserve space for the step header, catalogue controls and footer on desktop. */}
							<section
								aria-label={`${FORMATS[format]} models`}
								className="h-[60dvh] min-h-48 md:h-[max(18rem,calc(100dvh-45rem))] overflow-auto divide-y rounded-md border"
							>
								{visibleCandidates.map((model) => {
									const accountNames = (
										suggestions?.models.find((m) => m.id === model.targetModel)
											?.accountIds ??
										model.accountIds ??
										[]
									).map((id) => accounts.find((a) => a.id === id)?.name ?? id);
									return (
										<div
											key={model.id}
											className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40"
										>
											<label className="flex flex-1 min-w-0 items-center gap-3">
												<input
													className="shrink-0"
													type="checkbox"
													checked={draft.catalogues[format].models.some(
														(m) => m.id === model.id,
													)}
													onChange={(e) =>
														updateModels(
															e.target.checked
																? [...draft.catalogues[format].models, model]
																: draft.catalogues[format].models.filter(
																		(m) => m.id !== model.id,
																	),
														)
													}
												/>
												<span className="min-w-0 flex-1 grid gap-x-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
													<span className="font-medium text-sm break-all leading-5">
														{model.displayName}
													</span>
													<code className="text-xs break-all text-muted-foreground sm:col-start-1 sm:row-start-2">
														{model.id}
														{model.targetModel !== model.id
															? ` → ${model.targetModel}`
															: ""}
													</code>
													<span
														title={accountNames.join(", ")}
														className="text-xs text-muted-foreground truncate sm:col-start-2 sm:row-start-1 sm:row-span-2 sm:self-center"
													>
														{accountNames[0]}
														{accountNames.length > 1
															? ` +${accountNames.length - 1}`
															: ""}
													</span>
												</span>
											</label>
											<Button
												variant="ghost"
												size="sm"
												className="ml-auto h-7 px-2 text-xs"
												onClick={(e) => {
													e.preventDefault();
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
												Edit
											</Button>
										</div>
									);
								})}
								{!candidates.size && (
									<p className="p-4 text-sm text-muted-foreground">
										No known models from these destinations. Refresh discovery
										or add a model explicitly.
									</p>
								)}
								{!!candidates.size && !visibleCandidates.length && (
									<p className="p-4 text-sm text-muted-foreground">
										No models match this filter.
									</p>
								)}
							</section>
							<label className="grid gap-2 max-w-xl text-sm font-medium">
								Default model for setup
								<select
									className={SELECT}
									disabled={!draft.catalogues[format].models.length}
									value={draft.catalogues[format].defaultModel ?? ""}
									onChange={(e) => {
										markTouched(format);
										setDraft({
											...draft,
											catalogues: {
												...draft.catalogues,
												[format]: {
													...draft.catalogues[format],
													defaultModel: e.target.value || null,
												},
											},
										});
									}}
								>
									<option value="">
										{draft.catalogues[format].models.length
											? "Choose a default model"
											: "No selected models"}
									</option>
									{draft.catalogues[format].models.map((m) => (
										<option value={m.id} key={m.id}>
											{m.displayName}
										</option>
									))}
								</select>
							</label>
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
										htmlFor="model-id"
									>
										Published model ID
										<Input
											id="model-id"
											value={custom.id}
											onChange={(e) =>
												setCustom({ ...custom, id: e.target.value })
											}
										/>
									</label>
									<label
										className="grid gap-2 text-sm font-medium"
										htmlFor="target-id"
									>
										Upstream target ID
										<Input
											placeholder="Same as published ID for a direct model"
											id="target-id"
											value={custom.target}
											onChange={(e) =>
												setCustom({ ...custom, target: e.target.value })
											}
										/>
									</label>
									<label
										className="grid gap-2 text-sm font-medium"
										htmlFor="display-name"
									>
										Display name
										<Input
											id="display-name"
											value={custom.name}
											onChange={(e) =>
												setCustom({ ...custom, name: e.target.value })
											}
										/>
									</label>
									<fieldset className="sm:col-span-2">
										<legend className="text-sm mb-2">
											Alias destinations (required when IDs differ). A model
											published under its own name always uses the client's own
											destinations.
										</legend>
										<div className="flex flex-wrap gap-3">
											{editorAccounts.map((a) => (
												<label key={a.id} className="text-sm flex gap-2">
													<input
														type="checkbox"
														disabled={!customIsAlias}
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
										onClick={() => {
											const model = {
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
												draft.catalogues[format].models.some(
													(m) => m.id === model.id && m.id !== custom.editId,
												)
											) {
												setError("Enter a unique model ID");
												return;
											}
											updateModels([
												...draft.catalogues[format].models.filter(
													(m) => m.id !== custom.editId,
												),
												model,
											]);
											setCustom({
												id: "",
												target: "",
												name: "",
												accounts: [],
												editId: null,
											});
										}}
									>
										{custom.editId ? "Update selection" : "Add to selection"}
									</Button>
								</div>
							</details>
						</TabsContent>
					</Tabs>
				)}
				{step === 3 && review && (
					<div className="space-y-group">
						<div>
							<h3 className="font-semibold">{review.draft.name}</h3>
							<p className="text-sm text-muted-foreground">
								{APPLICATIONS[review.draft.application]} ·{" "}
								{review.draft.destinations.accountId
									? accounts.find(
											(a) => a.id === review.draft.destinations.accountId,
										)?.name
									: (review.draft.destinations.providers?.join(", ") ??
										"All accounts")}
							</p>
						</div>
						{Object.entries(review.draft.catalogues).map(([f, c]) => (
							<div key={f}>
								<p className="font-medium text-sm">
									{FORMATS[f as ClientFormat]} · {c.models.length} models
								</p>
								<p className="text-xs break-all text-muted-foreground">
									{c.models.map((m) => m.id).join(", ") || "Empty catalogue"}
								</p>
								<p className="text-xs">
									Setup default:{" "}
									{c.defaultModel ??
										c.models[0]?.id ??
										"Application default (empty catalogue)"}
								</p>
							</div>
						))}
						{review.aliasRules.length > 0 && (
							<div>
								<h3 className="font-medium">Client routing rules</h3>
								{review.aliasRules.map((r) => (
									<p key={r.id} className="text-sm break-all">
										{r.match_model_value} → {r.target_model} ·{" "}
										{r.pool_account_ids
											?.map(
												(id) => accounts.find((a) => a.id === id)?.name ?? id,
											)
											.join(", ")}
									</p>
								))}
								{review.precedingRules.length > 0 && (
									<p className="text-sm">
										These aliases take precedence over:{" "}
										{review.precedingRules.join(", ")}.
									</p>
								)}
							</div>
						)}
						{review.notices.map((n) => (
							<p className="text-sm text-muted-foreground" key={n}>
								{n}
							</p>
						))}
					</div>
				)}
				{/* Leave room below the actions for the shared floating Debug shortcut. */}
				<div className="sticky bottom-0 z-10 -mx-5 sm:-mx-6 flex justify-between gap-3 border-t rounded-b-lg bg-card px-5 sm:px-6 pt-4 pb-16">
					<Button variant="ghost" disabled={busy} onClick={onCancel}>
						Cancel
					</Button>
					<div className="flex gap-2">
						{step > 0 && (
							<Button
								variant="outline"
								disabled={busy}
								onClick={() => {
									void goToStep(step - 1);
								}}
							>
								Back
							</Button>
						)}
						<Button disabled={busy} onClick={next}>
							{busy
								? "Working…"
								: step === 3
									? client
										? "Save client"
										: "Create client"
									: step === 2
										? "Review changes"
										: "Next"}
						</Button>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
