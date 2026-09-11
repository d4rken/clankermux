import { createHash } from "node:crypto";
import {
	CLAUDE_MODEL_IDS,
	isAccountAllowedByPin,
	MODEL_DISPLAY_NAMES,
	matchRoutingRule,
} from "@clankermux/core";
import {
	ApiKeyRepository,
	type DatabaseOperations,
	RoutingConflictError,
	RoutingRepository,
} from "@clankermux/database";
import { BadRequest, Conflict, NotFound } from "@clankermux/errors";
import { handleModelsRequest } from "@clankermux/openai-responses-adapter";
import type {
	AccountModelPermissionService,
	CodexModelCatalogCache,
} from "@clankermux/proxy";
import {
	ANTHROPIC_BUNDLED_MODEL_CREATED_AT,
	modelPermissionScope,
} from "@clankermux/proxy";
import {
	type Account,
	type ApiKey,
	apiKeyLookupSuffix,
	type ClientDestinations,
	type ClientDraft,
	type ClientFormat,
	type ClientModel,
	type ClientProfile,
	type ClientReview,
	type ClientSuggestions,
	type ClientView,
	isKnownProvider,
	NodeCryptoUtils,
	type RoutingRule,
	toApiKeyResponse,
} from "@clankermux/types";
import {
	catalogueWithin,
	readCodexEnvelope,
	renderClientCatalogue,
} from "./client-catalogue";
import type { ModelCatalogService } from "./model-catalog-service";
import { handleModelsRoute } from "./models-route";

const FORMATS: ClientFormat[] = ["anthropic", "openai", "codex"];
interface Deps {
	dbOps: DatabaseOperations;
	modelCatalog: ModelCatalogService;
	permissions: AccountModelPermissionService;
	codexCatalog: CodexModelCatalogCache;
}
interface Prepared {
	review: ClientReview;
	profile: ClientProfile;
	fingerprint: string;
	expires: number;
}
const emptyCatalogues = (): ClientProfile["catalogues"] => ({
	anthropic: { models: [], defaultModel: null },
	openai: { models: [], defaultModel: null },
	codex: { models: [], defaultModel: null },
});

export class ClientService {
	private readonly pending = new Map<string, Prepared>();
	constructor(private readonly deps: Deps) {}
	async bootstrap(): Promise<void> {
		const { dbOps } = this.deps;
		if (!(await dbOps.clients.isBootstrapped())) {
			const keys = await dbOps.getApiKeys();
			const profiles = await Promise.all(
				keys.map((k) => this.legacyProfile(k.id)),
			);
			await dbOps.clients.bootstrap(profiles);
		}
		dbOps.clientInitializer = (id, destinations) =>
			this.initialProfile(id, destinations);
	}
	private async legacyProfile(id: string): Promise<ClientProfile> {
		const { modelCatalog } = this.deps;
		const key = await this.deps.dbOps.getApiKey(id);
		if (!key)
			throw new RoutingConflictError("Client key changed during migration");
		const scope = this.metadataScope(
			await this.accounts({
				accountId: key.pinnedAccountId,
				providers: key.pinnedProviders,
			}),
		);
		const [rawResult, anthropic, anthropicOverrides, openaiOverrides] =
			await Promise.all([
				catalogueWithin(modelCatalog.getCodexCatalog(id), null, 12000),
				catalogueWithin(
					modelCatalog.getAnthropicCatalog(),
					{
						models: Object.values(CLAUDE_MODEL_IDS).map((id) => ({
							id,
							displayName: MODEL_DISPLAY_NAMES[id] ?? id,
							createdAt: ANTHROPIC_BUNDLED_MODEL_CREATED_AT,
						})),
						source: "bundled" as const,
						fetchedAt: null,
					},
					12000,
				),
				modelCatalog.listOverrides("anthropic"),
				modelCatalog.listOverrides("openai"),
			]);
		const rich = readCodexEnvelope(rawResult);
		const raw = rich ? rawResult : null;
		const known = new Set<string>(
			(rich?.models ?? []).map((m: { slug: string }) => m.slug),
		);
		const notices: string[] = [];
		if (anthropic.source === "bundled")
			notices.push(
				"Anthropic discovery was unavailable at migration; the bundled catalogue was copied.",
			);
		if (rich)
			for (const o of openaiOverrides)
				if (o.custom && !o.hidden && !known.has(o.modelId))
					notices.push(
						`Codex entry ${o.modelId} was omitted at migration because target metadata was unknown.`,
					);
		const catalogues = emptyCatalogues();
		for (const format of FORMATS) {
			const response = await handleModelsRoute(
				new URL(
					`http://migration/v1/models${format === "codex" ? "?client_version=1" : ""}`,
				),
				{
					getCatalog: async () => raw,
					staticModels: handleModelsRequest,
					staticModelIds: modelCatalog.staticModelIds,
					getAnthropicCatalog: async () => anthropic,
					listOverrides: async (dialect) =>
						dialect === "anthropic" ? anthropicOverrides : openaiOverrides,
				},
				id,
				format === "anthropic" ? "anthropic" : "openai",
			);
			const body = await response.json();
			const isRich = format === "codex" && Array.isArray(body.models);
			catalogues[format] = {
				defaultModel: null,
				models: (isRich ? body.models : body.data).map(
					(m: Record<string, unknown>) => ({
						id: String(isRich ? m.slug : m.id),
						displayName: String(m.display_name ?? m.slug ?? m.id),
						targetModel: String(isRich ? m.slug : m.id),
						accountIds: null,
						...(format === "anthropic"
							? { createdAt: String(m.created_at) }
							: {}),
						...(isRich
							? {
									codexMetadata: m,
									metadataCapturedAt: Date.now(),
									metadataScope: scope,
								}
							: {}),
					}),
				),
				...(isRich
					? {
							envelope: Object.fromEntries(
								Object.entries(body).filter(([k]) => k !== "models"),
							),
						}
					: {}),
			};
		}
		if (!raw)
			notices.push(
				"No rich Codex metadata was available during migration. The existing generic-list fallback was copied; review Codex suggestions to configure it.",
			);
		return {
			apiKeyId: id,
			application: "generic",
			revision: 1,
			catalogues,
			notices,
		};
	}
	async initialProfile(
		id: string,
		destinations: ClientDestinations,
	): Promise<ClientProfile> {
		const suggestions = await this.suggestions(destinations, false);
		const catalogues = emptyCatalogues();
		for (const format of ["anthropic", "openai"] as const)
			catalogues[format].models = suggestions.models.map((m) => ({
				id: m.id,
				displayName: m.displayName,
				targetModel: m.id,
				accountIds: null,
			}));
		const scope = this.metadataScope(await this.accounts(destinations));
		const raw = await this.deps.codexCatalog.getForPin(destinations);
		if (raw)
			catalogues.codex.models = (readCodexEnvelope(raw)?.models ?? []).map(
				(m: Record<string, unknown>) => ({
					id: String(m.slug),
					targetModel: String(m.slug),
					displayName: String(m.display_name ?? m.slug),
					accountIds: null,
					codexMetadata: m,
					metadataCapturedAt: Date.now(),
					metadataScope: scope,
				}),
			);
		return {
			apiKeyId: id,
			application: "generic",
			revision: 1,
			catalogues,
			notices: [
				...(catalogues.codex.models.length
					? []
					: [
							"No Codex metadata was known at creation; review new model suggestions to populate its catalogue.",
						]),
				...(!catalogues.anthropic.models.some((m) =>
					/claude|anthropic/i.test(m.id),
				)
					? [
							"Claude Code ignores an empty compatible catalogue and may show its built-in models. Configure this client to review compatible aliases.",
						]
					: []),
			],
		};
	}
	private missingProfile(id: string): ClientProfile {
		return {
			apiKeyId: id,
			application: "generic",
			revision: 0,
			catalogues: emptyCatalogues(),
			notices: [
				"Client catalogue is missing. Configure and review this client to restore discovery; its existing key and routing still apply.",
			],
		};
	}
	private async view(key: ApiKey, rules: RoutingRule[]): Promise<ClientView> {
		const { dbOps } = this.deps;
		const profile =
			(await dbOps.clients.getProfile(key.id)) ?? this.missingProfile(key.id);
		const owned = await dbOps.clients.ownedRuleIds(key.id);
		const notices = [...profile.notices];
		for (const model of Object.values(profile.catalogues).flatMap(
			(c) => c.models,
		)) {
			if (model.id === model.targetModel) continue;
			const rule = matchRoutingRule(rules, key.id, model.id);
			if (
				!rule ||
				rule.target_kind !== "literal" ||
				rule.target_model !== model.targetModel
			)
				notices.push(
					`Alias ${model.id} no longer has its expected routing rule. Review this client or its routing configuration.`,
				);
		}
		if (profile.catalogues.codex.models.some((m) => !m.codexMetadata))
			notices.push(
				"Some selected Codex IDs have no saved target metadata. Live metadata is used when available; otherwise Codex may use its built-in catalogue.",
			);
		return {
			...profile,
			notices: [...new Set(notices)],
			key: toApiKeyResponse(key),
			aliasRules: rules.filter((r) => owned.includes(r.id)),
		};
	}
	async list(): Promise<ClientView[]> {
		const rules = await this.deps.dbOps.routing.listRules();
		return Promise.all(
			(await this.deps.dbOps.getApiKeys()).map((key) => this.view(key, rules)),
		);
	}
	private metadataScope(
		accounts: Account[],
		accountIds: string[] | null = null,
	): string {
		return createHash("sha256")
			.update(
				JSON.stringify(
					accounts
						.filter((a) => !accountIds || accountIds.includes(a.id))
						.sort((a, b) => a.id.localeCompare(b.id))
						.map((a) => [a.id, modelPermissionScope(a)]),
				),
			)
			.digest("hex");
	}
	private scopeLookup(accounts: Account[]): (ids: string[] | null) => string {
		const scopes = new Map<string, string>();
		return (ids) => {
			const key = JSON.stringify(ids?.slice().sort() ?? null);
			let scope = scopes.get(key);
			if (!scope) {
				scope = this.metadataScope(accounts, ids);
				scopes.set(key, scope);
			}
			return scope;
		};
	}
	async wire(id: string, format: ClientFormat): Promise<Response> {
		const profile = await this.deps.dbOps.clients.getProfile(id);
		const key = await this.deps.dbOps.getApiKeyPin(id);
		if (!profile || !key || key.malformed)
			throw new Error("Client catalogue not found");
		const catalogue = structuredClone(profile.catalogues[format]);
		if (format === "codex") {
			const destinations = {
				accountId: key.pinnedAccountId,
				providers: key.pinnedProviders,
			};
			const accounts = await this.accounts(destinations);
			const scopeFor = this.scopeLookup(accounts);
			await Promise.all(
				catalogue.models.map(async (model) => {
					const scope = scopeFor(model.accountIds);
					if (model.metadataScope !== scope) delete model.codexMetadata;
					const pins = model.accountIds
						? accounts
								.filter(
									(a) =>
										model.accountIds?.includes(a.id) && a.provider === "codex",
								)
								.map((a) => ({ accountId: a.id, providers: null }))
						: [destinations];
					// A stored, dated copy remains usable during a metadata refresh. Selection never expands.
					const lookup = Promise.all(
						pins.map((pin) => this.deps.codexCatalog.getForPin(pin)),
					)
						.then((results) =>
							results
								.flatMap((r) => readCodexEnvelope(r)?.models ?? [])
								.find((m: { slug: string }) => m.slug === model.targetModel),
						)
						.catch(() => null);
					let timer: ReturnType<typeof setTimeout> | undefined;
					const metadata = await Promise.race([
						lookup,
						new Promise<null>((resolve) => {
							timer = setTimeout(() => resolve(null), 100);
						}),
					]).finally(() => clearTimeout(timer));
					if (metadata) model.codexMetadata = metadata;
				}),
			);
		}
		return renderClientCatalogue(catalogue, format);
	}
	private destinations(value: unknown): ClientDestinations {
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw BadRequest("Choose upstream destinations");
		const { accountId, providers } = value as ClientDestinations;
		if (
			(accountId !== null &&
				(typeof accountId !== "string" || !accountId.trim())) ||
			(providers !== null &&
				(!Array.isArray(providers) ||
					!providers.length ||
					providers.some(
						(p) => typeof p !== "string" || !isKnownProvider(p),
					))) ||
			(accountId !== null && providers !== null)
		)
			throw BadRequest("Choose all accounts, one account, or a provider list");
		return {
			accountId,
			providers: providers === null ? null : [...new Set(providers)].sort(),
		};
	}
	private async accounts(destinations: ClientDestinations): Promise<Account[]> {
		const accounts = await this.deps.dbOps.getAllAccounts();
		if (
			destinations.accountId &&
			!accounts.some((a) => a.id === destinations.accountId)
		)
			throw BadRequest("Destination account no longer exists");
		return accounts.filter((a) => isAccountAllowedByPin(destinations, a));
	}
	async suggestions(
		input: unknown,
		refresh = false,
	): Promise<ClientSuggestions> {
		const destinations = this.destinations(input);
		const accounts = await this.accounts(destinations);
		if (refresh)
			await Promise.allSettled(
				accounts.map((a) => this.deps.permissions.refresh(a, true)),
			);
		const rows = await Promise.all(
			accounts.map(async (account) => {
				try {
					return {
						account,
						permissions: await this.deps.permissions.permissions(account),
					};
				} catch {
					return { account, permissions: null };
				}
			}),
		);
		const models = new Map<string, ClientSuggestions["models"][number]>();
		for (const { account, permissions } of rows)
			for (const id of new Set([
				...(permissions?.discovered_ids ?? []),
				...(permissions?.manual_ids ?? []),
			])) {
				const entry = models.get(id) ?? {
					id,
					displayName: id,
					accountIds: [],
					codexMetadataAvailable: false,
				};
				entry.accountIds.push(account.id);
				models.set(id, entry);
			}
		const richAccounts = await Promise.all(
			accounts
				.filter((a) => a.provider === "codex")
				.map(async (account) => ({
					account,
					body: readCodexEnvelope(
						await this.deps.codexCatalog.getForPin({
							accountId: account.id,
							providers: null,
						}),
					),
				})),
		);
		for (const { account, body } of richAccounts)
			for (const m of body?.models ?? []) {
				const entry = models.get(m.slug) ?? {
					id: m.slug,
					displayName: m.slug,
					accountIds: [],
					codexMetadataAvailable: false,
				};
				if (!entry.accountIds.includes(account.id))
					entry.accountIds.push(account.id);
				entry.codexMetadataAvailable = true;
				entry.displayName =
					typeof m.display_name === "string" ? m.display_name : m.slug;
				models.set(m.slug, entry);
			}
		return {
			models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)),
			accounts: rows.map(({ account, permissions }) => ({
				id: account.id,
				name: account.name,
				provider: account.provider,
				completeness: permissions?.completeness ?? "unknown",
				error:
					permissions?.last_error ??
					(permissions ? null : "Account changed during discovery"),
			})),
		};
	}
	private fingerprint(): string {
		const db = this.deps.dbOps.getAdapter().getSQLiteDb();
		return createHash("sha256")
			.update(
				JSON.stringify([
					db.query("SELECT * FROM routing_rules ORDER BY id").all(),
					db
						.query(
							"SELECT id,name,pinned_account_id,pinned_providers,is_active FROM api_keys ORDER BY id",
						)
						.all(),
					(
						db
							.query(
								"SELECT id,provider,custom_endpoint,api_key,identity_external_id,identity_email,identity_organization_name,identity_plan_tier FROM accounts ORDER BY id",
							)
							.all() as Account[]
					).map((a) => [a.id, modelPermissionScope(a)]),
					db.query("SELECT * FROM client_alias_rules ORDER BY rule_id").all(),
				]),
			)
			.digest("hex");
	}
	async review(input: unknown): Promise<ClientReview> {
		if (!input || typeof input !== "object" || Array.isArray(input))
			throw BadRequest("Client must be an object");
		const fingerprintBefore = this.fingerprint();
		const draft = structuredClone(input) as ClientDraft;
		if (
			typeof draft.name !== "string" ||
			!draft.name.trim() ||
			draft.name.trim().length > 100
		)
			throw BadRequest("Client name must contain 1 to 100 characters");
		draft.name = draft.name.trim();
		if (
			![
				"generic",
				"claude-code",
				"codex",
				"opencode",
				"oh-my-pi",
				"pi",
			].includes(draft.application)
		)
			throw BadRequest("Unknown client application");
		draft.destinations = this.destinations(draft.destinations);
		const accounts = await this.accounts(draft.destinations);
		const scopeFor = this.scopeLookup(accounts);
		const existing = draft.id
			? await this.deps.dbOps.clients.getProfile(draft.id)
			: null;
		if (draft.id && !existing && draft.revision !== 0)
			throw Conflict("Client catalogue is missing; reload and review again");
		if (existing && existing.revision !== draft.revision)
			throw Conflict("Client changed; reload and review again");
		const collision = await this.deps.dbOps.getApiKeyByName(draft.name);
		if (collision && collision.id !== draft.id)
			throw Conflict("A client with this name already exists");
		const id = draft.id ?? crypto.randomUUID();
		const existingKey = draft.id
			? await this.deps.dbOps.getApiKey(draft.id)
			: null;
		if (draft.id && !existingKey) throw NotFound("Client not found");
		const pinUnchanged =
			existingKey?.pinnedAccountId === draft.destinations.accountId &&
			JSON.stringify(existingKey?.pinnedProviders?.slice().sort() ?? null) ===
				JSON.stringify(draft.destinations.providers);
		const catalogue = emptyCatalogues();
		catalogue.codex.envelope = existing?.catalogues.codex.envelope;
		const aliasModels = new Map<string, ClientModel>();
		for (const format of FORMATS) {
			const selected = draft.catalogues?.[format];
			if (
				!selected ||
				!Array.isArray(selected.models) ||
				selected.models.length > 10000
			)
				throw BadRequest(`Invalid ${format} catalogue`);
			const seen = new Set<string>();
			for (const value of selected.models) {
				if (!value || typeof value !== "object")
					throw BadRequest("Invalid model entry");
				for (const [name, field] of [
					["model ID", value.id],
					["target model", value.targetModel],
					["display name", value.displayName],
				] as const)
					if (
						typeof field !== "string" ||
						!field.trim() ||
						field !== field.trim() ||
						field.length > 256
					)
						throw BadRequest(`Invalid ${name}`);
				if (seen.has(value.id)) throw BadRequest(`Duplicate model ${value.id}`);
				seen.add(value.id);
				if (
					value.accountIds !== null &&
					(!Array.isArray(value.accountIds) ||
						!value.accountIds.length ||
						value.accountIds.some(
							(a) => !accounts.some((account) => account.id === a),
						))
				)
					throw BadRequest(`Choose allowed accounts for ${value.id}`);
				const model: ClientModel = {
					id: value.id,
					displayName: value.displayName,
					targetModel: value.targetModel,
					accountIds:
						value.accountIds === null
							? null
							: [...new Set(value.accountIds)].sort(),
				};
				if (format === "anthropic") {
					model.createdAt =
						existing?.catalogues.anthropic.models.find((m) => m.id === value.id)
							?.createdAt ?? new Date().toISOString();
					if (
						draft.application === "claude-code" &&
						!/claude|anthropic/i.test(model.id)
					)
						throw BadRequest(
							`Claude Code requires a compatible alias for ${model.id}`,
						);
				}
				if (format === "codex") {
					const old = existing?.catalogues.codex.models.find(
						(m) => m.id === model.id && m.targetModel === model.targetModel,
					);

					const scope = scopeFor(model.accountIds);
					if (
						old?.codexMetadata &&
						old.metadataScope === scope &&
						pinUnchanged &&
						JSON.stringify(old.accountIds) === JSON.stringify(model.accountIds)
					) {
						model.codexMetadata = old.codexMetadata;
						model.metadataCapturedAt = old.metadataCapturedAt;
						model.metadataScope = scope;
					} else {
						const candidates = model.accountIds
							? accounts.filter((a) => model.accountIds?.includes(a.id))
							: accounts;
						for (const account of candidates.filter(
							(a) => a.provider === "codex",
						)) {
							const rich = await this.deps.codexCatalog.getForPin({
								accountId: account.id,
								providers: null,
							});
							const metadata = rich
								? (readCodexEnvelope(rich)?.models ?? []).find(
										(m: { slug: string }) => m.slug === model.targetModel,
									)
								: null;
							if (metadata) {
								model.codexMetadata = metadata;
								model.metadataCapturedAt = Date.now();
								model.metadataScope = scope;
								break;
							}
						}
					}
					if (!model.codexMetadata) {
						const unchangedCopy =
							old &&
							!old.codexMetadata &&
							model.targetModel === old.targetModel &&
							model.id === old.id &&
							JSON.stringify(model.accountIds) ===
								JSON.stringify(old.accountIds);
						if (!unchangedCopy)
							throw BadRequest(
								`Known Codex metadata is required for target ${model.targetModel}`,
							);
					}
				}
				catalogue[format].models.push(model);
				if (model.id !== model.targetModel) {
					if (!model.accountIds?.length)
						throw BadRequest(`Choose upstream accounts for alias ${model.id}`);
					const prior = aliasModels.get(model.id);
					if (
						prior &&
						(prior.targetModel !== model.targetModel ||
							JSON.stringify(prior.accountIds) !==
								JSON.stringify(model.accountIds))
					)
						throw BadRequest(
							`Alias ${model.id} has conflicting targets across catalogues`,
						);
					aliasModels.set(model.id, model);
				}
			}
			if (
				selected.defaultModel !== null &&
				(typeof selected.defaultModel !== "string" ||
					!seen.has(selected.defaultModel))
			)
				throw BadRequest(`Select a published ${format} default model`);
			catalogue[format].defaultModel = selected.defaultModel;
		}
		const owned = draft.id
			? await this.deps.dbOps.clients.ownedRuleIds(draft.id)
			: [];
		const allRules = await this.deps.dbOps.routing.listRules();
		const rules = allRules.filter((r) => !owned.includes(r.id));
		const aliasRules = [...aliasModels.values()].map((model, position) => ({
			id: crypto.randomUUID(),
			name: `${draft.name}: ${model.id}`,
			enabled: true,
			position,
			match_api_key_id: id,
			match_model_kind: "exact" as const,
			match_model_value: model.id,
			pool_kind: "accounts" as const,
			pool_provider: null,
			pool_account_ids: model.accountIds,
			target_kind: "literal" as const,
			target_model: model.targetModel,
		}));
		// Hiding a catalogue entry must not remove its working alias route.
		const retained = allRules.filter(
			(r) =>
				owned.includes(r.id) && !aliasModels.has(r.match_model_value ?? ""),
		);
		aliasRules.push(
			...(retained.map((r, index) => ({
				...r,
				position: aliasRules.length + index,
			})) as typeof aliasRules),
		);
		const validator = new RoutingRepository(this.deps.dbOps.getAdapter());
		for (const rule of [
			...rules.filter((r) => r.match_api_key_id === id),
			...aliasRules,
		])
			validator.assertPinCompatible(
				rule,
				draft.destinations.accountId,
				draft.destinations.providers === null
					? null
					: JSON.stringify(draft.destinations.providers),
			);
		const precedingRules = [
			...new Set(
				aliasRules
					.map((r) => matchRoutingRule(rules, id, r.match_model_value!)?.name)
					.filter((n): n is string => !!n),
			),
		];
		const notices = [
			"Catalogue selections control discovery only. Requests for unlisted models still use the normal routing policy.",
		];
		if (!catalogue.anthropic.models.some((m) => /claude|anthropic/i.test(m.id)))
			notices.push(
				"Claude Code ignores an empty compatible catalogue and may show its built-in models.",
			);
		if (aliasRules.length)
			notices.push(
				"Reviewed alias rules take precedence over existing rules for this client and model ID.",
			);
		const profile: ClientProfile = {
			apiKeyId: id,
			application: draft.application,
			revision: existing?.revision ?? 1,
			catalogues: catalogue,
			notices: [],
		};
		const token = crypto.randomUUID();
		const review: ClientReview = {
			token,
			draft: { ...draft, catalogues: catalogue },
			aliasRules,
			precedingRules,
			notices,
		};
		for (const [key, value] of this.pending)
			if (value.expires < Date.now()) this.pending.delete(key);
		if (this.pending.size >= 128)
			this.pending.delete(this.pending.keys().next().value!);
		if (this.fingerprint() !== fingerprintBefore)
			throw Conflict(
				"Routing or account identity changed during review; review again",
			);
		this.pending.set(token, {
			review,
			profile,
			fingerprint: fingerprintBefore,
			expires: Date.now() + 600000,
		});
		return review;
	}
	async commit(
		token: string,
	): Promise<{ client: ClientView; apiKey?: string }> {
		const prepared = this.pending.get(token);
		if (!prepared || prepared.expires < Date.now())
			throw Conflict("Review expired; review the client again");
		const { review, profile, fingerprint } = prepared;
		const { draft } = review;
		const { dbOps } = this.deps;
		const cryptoUtils = new NodeCryptoUtils();
		const apiKey = draft.id ? undefined : await cryptoUtils.generateApiKey();
		const hash = apiKey ? await cryptoUtils.hashApiKey(apiKey) : null;
		const adapter = dbOps.getAdapter();
		const createdAt = Date.now();
		const routing = new RoutingRepository(adapter);
		await adapter.runTransaction(() => {
			if (this.fingerprint() !== fingerprint)
				throw new RoutingConflictError(
					"Routing or destinations changed; review the client again",
				);
			const db = adapter.getSQLiteDb();
			if (!draft.id) {
				new ApiKeyRepository(adapter).createInTransaction({
					id: profile.apiKeyId,
					name: draft.name,
					hashed_key: hash!,
					prefix_last_8: apiKeyLookupSuffix(apiKey!),
					created_at: createdAt,
					last_used: null,
					is_active: 1,
					pinned_account_id: draft.destinations.accountId,
					pinned_providers:
						draft.destinations.providers === null
							? null
							: JSON.stringify(draft.destinations.providers),
				});
				dbOps.clients.insertInTransaction(profile);
			} else {
				dbOps.clients.saveInTransaction(profile, draft.revision!);
				db.query("UPDATE api_keys SET name=? WHERE id=?").run(
					draft.name,
					draft.id,
				);
			}
			const owned = db
				.query("SELECT rule_id FROM client_alias_rules WHERE api_key_id=?")
				.all(profile.apiKeyId) as { rule_id: string }[];
			for (const row of owned)
				db.query("DELETE FROM routing_rules WHERE id=?").run(row.rule_id);
			db.query("DELETE FROM client_alias_rules WHERE api_key_id=?").run(
				profile.apiKeyId,
			);
			routing.updateDestinationsInTransaction(
				profile.apiKeyId,
				draft.destinations.accountId,
				draft.destinations.providers,
			);
			const remaining = db
				.query("SELECT id FROM routing_rules ORDER BY position")
				.all() as { id: string }[];
			if (review.aliasRules.length) {
				for (const [index, row] of remaining.entries())
					db.query("UPDATE routing_rules SET position=? WHERE id=?").run(
						-index - 1,
						row.id,
					);
				for (const [index, row] of remaining.entries())
					db.query("UPDATE routing_rules SET position=? WHERE id=?").run(
						index + review.aliasRules.length,
						row.id,
					);
			}
			for (const rule of review.aliasRules) {
				routing.saveRuleInTransaction(rule);
				db.query(
					"INSERT INTO client_alias_rules(api_key_id,rule_id) VALUES(?,?)",
				).run(profile.apiKeyId, rule.id);
			}
		});
		this.pending.delete(token);
		return {
			client: await this.view(
				(await dbOps.getApiKey(profile.apiKeyId))!,
				await dbOps.routing.listRules(),
			),
			...(apiKey ? { apiKey } : {}),
		};
	}
	async remove(id: string): Promise<void> {
		const adapter = this.deps.dbOps.getAdapter();
		await adapter.runTransaction(() => {
			const db = adapter.getSQLiteDb();
			const owned = db
				.query("SELECT rule_id FROM client_alias_rules WHERE api_key_id=?")
				.all(id) as { rule_id: string }[];
			for (const row of owned)
				db.query("DELETE FROM routing_rules WHERE id=?").run(row.rule_id);
			db.query("DELETE FROM client_alias_rules WHERE api_key_id=?").run(id);
			// The existing key-delete trigger protects any manually owned routing references.
			if (!db.query("DELETE FROM api_keys WHERE id=?").run(id).changes)
				throw NotFound("Client not found");
			db.query("DELETE FROM client_profiles WHERE api_key_id=?").run(id);
		});
	}
}
