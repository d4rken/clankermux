import type {
	ClientApplication,
	ClientDraft,
	ClientFormat,
	ClientModel,
	ClientReview,
	ClientSuggestions,
	ClientView,
} from "@clankermux/types";
import { useState } from "react";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { clientRequest } from "./api";
import { APPLICATIONS, preferredFormat } from "./setup";

export interface DestinationAccount {
	id: string;
	name: string;
	provider: string;
}
const SELECT = "h-9 rounded-md border border-input bg-background px-3 text-sm";
const FORMATS: Record<ClientFormat, string> = {
	anthropic: "Anthropic-style discovery",
	openai: "OpenAI-style discovery",
	codex: "Codex rich catalogue",
};
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
		!/claude|anthropic/i.test(id);
	return {
		id: alias ? `claude-${id}` : id,
		displayName,
		targetModel: id,
		accountIds: alias ? accountIds : null,
	};
}
export function ClientWizard({
	client,
	accounts,
	onCancel,
	onSaved,
}: {
	client?: ClientView;
	accounts: DestinationAccount[];
	onCancel: () => void;
	onSaved: (result: { client: ClientView; apiKey?: string }) => void;
}) {
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
	const [initialized, setInitialized] = useState(!!client);
	const [custom, setCustom] = useState({
		id: "",
		target: "",
		name: "",
		accounts: [] as string[],
		editId: null as string | null,
	});
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
		setBusy(true);
		setError(null);
		try {
			await work();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	const updateModels = (models: ClientModel[]) =>
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
	const loadSuggestions = async (refresh = false) => {
		const result = await clientRequest<ClientSuggestions>("/suggestions", {
			destinations: draft.destinations,
			refresh,
		});
		setSuggestions(result);
		if (!initialized) {
			setDraft((d) => ({
				...d,
				catalogues: Object.fromEntries(
					(Object.keys(FORMATS) as ClientFormat[]).map((f) => [
						f,
						{
							defaultModel: null,
							models: result.models
								.filter((m) => f !== "codex" || m.codexMetadataAvailable)
								.map((m) =>
									suggestedModel(
										m.id,
										m.displayName,
										m.accountIds,
										d.application,
										f,
									),
								),
						},
					]),
				) as ClientDraft["catalogues"],
			}));
			setInitialized(true);
		}
	};
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
	const next = () =>
		run(async () => {
			if (step === 0) {
				if (!draft.name.trim()) throw new Error("Enter a client name");
				setStep(1);
			} else if (step === 1) {
				await loadSuggestions();
				setStep(2);
			} else if (step === 2) {
				setReview(await clientRequest<ClientReview>("/review", draft));
				setStep(3);
			} else if (review)
				onSaved(
					await clientRequest<{ client: ClientView; apiKey?: string }>(
						"/commit",
						{ token: review.token },
					),
				);
		});
	return (
		<Card>
			<CardHeader>
				<CardTitle>{client ? "Configure client" : "Add client"}</CardTitle>
				<ol
					aria-label="Setup steps"
					className="flex flex-wrap gap-group text-sm text-muted-foreground"
				>
					{["Application", "Destinations", "Catalogue", "Review"].map(
						(label, i) => (
							<li
								key={label}
								aria-current={step === i ? "step" : undefined}
								className={step === i ? "font-semibold text-foreground" : ""}
							>
								{i + 1}. {label}
							</li>
						),
					)}
				</ol>
			</CardHeader>
			<CardContent className="space-y-group">
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				{step === 0 && (
					<div className="grid max-w-xl gap-group">
						<label className="space-y-2" htmlFor="client-name">
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
						<p className="text-sm text-muted-foreground">
							Name this installation, script, or integration. It gets its own
							API key and model catalogue.
						</p>
						<label className="grid gap-2">
							Application
							<select
								className={SELECT}
								value={draft.application}
								onChange={(e) => {
									const application = e.target.value as ClientApplication;
									setDraft({ ...draft, application });
									setFormat(preferredFormat(application));
								}}
							>
								{Object.entries(APPLICATIONS).map(([value, label]) => (
									<option key={value} value={value}>
										{label}
									</option>
								))}
							</select>
						</label>
						<p className="text-sm text-muted-foreground">
							The application selects a setup recipe. Every client can use all
							supported API protocols.
						</p>
					</div>
				)}
				{step === 1 && (
					<div className="space-y-group">
						<p>Choose which upstream destinations this client can use.</p>
						<label className="grid gap-2 max-w-xl">
							Allowed destinations
							<select
								className={SELECT}
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
							<label className="grid gap-2 max-w-xl">
								Account
								<select
									className={SELECT}
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
					<div className="space-y-group">
						<div className="flex flex-wrap justify-between gap-group">
							<label className="grid gap-2">
								Catalogue format
								<select
									className={SELECT}
									value={format}
									onChange={(e) => setFormat(e.target.value as ClientFormat)}
								>
									{Object.entries(FORMATS).map(([value, label]) => (
										<option value={value} key={value}>
											{label}
										</option>
									))}
								</select>
							</label>
							<Button
								variant="outline"
								disabled={busy}
								onClick={() => run(() => loadSuggestions(true))}
							>
								Refresh suggestions
							</Button>
						</div>
						<p className="text-sm text-muted-foreground">
							Selections only control the advertised list. New discoveries
							remain suggestions until you select and save them. Review all
							three formats if you use more than one application with this key.
						</p>
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
										<ul className="list-disc pl-5">
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
										<ul className="list-disc pl-5">
											{retainedConflicts.map((r) => (
												<li key={r.id}>{r.name}</li>
											))}
										</ul>
									</>
								)}
							</div>
						)}
						{suggestions?.accounts.map((a) => (
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
						{format === "codex" && (
							<p className="text-sm text-muted-foreground">
								Only targets with known Codex metadata can be added. Previously
								copied generic fallback entries remain until you configure this
								catalogue.
							</p>
						)}
						<div className="flex gap-2">
							<Button
								size="sm"
								variant="outline"
								onClick={() => updateModels([...candidates.values()])}
							>
								Select all
							</Button>
							<Button
								size="sm"
								variant="outline"
								onClick={() => updateModels([])}
							>
								Deselect all
							</Button>
							<span className="text-sm self-center text-muted-foreground">
								{draft.catalogues[format].models.length} selected
							</span>
						</div>
						<div className="max-h-96 overflow-auto divide-y rounded-md border">
							{[...candidates.values()].map((model) => (
								<div
									key={model.id}
									className="flex items-start gap-3 p-3 hover:bg-muted/40"
								>
									<label className="flex flex-1 min-w-0 items-start gap-3">
										<input
											className="mt-1"
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
										<span className="min-w-0">
											<span className="block font-medium text-sm">
												{model.displayName}
											</span>
											<code className="text-xs break-all text-muted-foreground">
												{model.id}
												{model.targetModel !== model.id
													? ` → ${model.targetModel}`
													: ""}
											</code>
											<span className="block text-xs text-muted-foreground">
												{(
													suggestions?.models.find(
														(m) => m.id === model.targetModel,
													)?.accountIds ??
													model.accountIds ??
													[]
												)
													.map(
														(id) =>
															accounts.find((a) => a.id === id)?.name ?? id,
													)
													.join(", ")}
											</span>
										</span>
									</label>
									<Button
										variant="ghost"
										size="sm"
										className="ml-auto"
										onClick={(e) => {
											e.preventDefault();
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
							))}
							{!candidates.size && (
								<p className="p-4 text-sm text-muted-foreground">
									No known models from these destinations. Refresh discovery or
									add a model explicitly.
								</p>
							)}
						</div>
						<label className="grid gap-2 max-w-xl">
							Default model for setup
							<select
								className={SELECT}
								value={draft.catalogues[format].defaultModel ?? ""}
								onChange={(e) =>
									setDraft({
										...draft,
										catalogues: {
											...draft.catalogues,
											[format]: {
												...draft.catalogues[format],
												defaultModel: e.target.value || null,
											},
										},
									})
								}
							>
								<option value="">First selected model</option>
								{draft.catalogues[format].models.map((m) => (
									<option value={m.id} key={m.id}>
										{m.displayName}
									</option>
								))}
							</select>
						</label>
						<details
							className="rounded border p-3"
							open={custom.editId !== null ? true : undefined}
						>
							<summary className="cursor-pointer text-sm font-medium">
								Add a custom model or alias
							</summary>
							<div className="grid gap-3 pt-3">
								<label htmlFor="model-id">
									Published model ID
									<Input
										id="model-id"
										value={custom.id}
										onChange={(e) =>
											setCustom({ ...custom, id: e.target.value })
										}
									/>
								</label>
								<label htmlFor="target-id">
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
								<label htmlFor="display-name">
									Display name
									<Input
										id="display-name"
										value={custom.name}
										onChange={(e) =>
											setCustom({ ...custom, name: e.target.value })
										}
									/>
								</label>
								<fieldset>
									<legend className="text-sm mb-2">
										Alias destinations (required when IDs differ)
									</legend>
									<div className="flex flex-wrap gap-3">
										{editorAccounts.map((a) => (
											<label key={a.id} className="text-sm flex gap-2">
												<input
													type="checkbox"
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
											accountIds: custom.accounts.length
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
					</div>
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
				<div className="flex justify-between border-t pt-4">
					<Button variant="ghost" disabled={busy} onClick={onCancel}>
						Cancel
					</Button>
					<div className="flex gap-2">
						{step > 0 && (
							<Button
								variant="outline"
								disabled={busy}
								onClick={() => {
									setReview(null);
									setStep(step - 1);
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
