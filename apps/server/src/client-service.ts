import { createHash } from "node:crypto";
import {
	CLAUDE_MODEL_IDS,
	isAccountAllowedByPin,
	isModelPermitted,
	MODEL_DISPLAY_NAMES,
	matchRoutingRule,
	pricingCatalogueStatus,
	resolveClientModelMetadata,
	resolveModelCachePolicy,
	resolveRoutingTarget,
	validateRoutingRule,
} from "@clankermux/core";
import {
	ApiKeyRepository,
	type DatabaseOperations,
	isClientInputError,
	RoutingConflictError,
	RoutingRepository,
} from "@clankermux/database";
import { BadRequest, Conflict, HttpError, NotFound } from "@clankermux/errors";
import { handleModelsRequest } from "@clankermux/openai-responses-adapter";
import type {
	AccountModelPermissionService,
	CodexModelCatalogCache,
} from "@clankermux/proxy";
import {
	ANTHROPIC_BUNDLED_MODEL_CREATED_AT,
	modelPermissionScope,
	NATIVE_DISCOVERY_PROVIDERS,
} from "@clankermux/proxy";
import {
	type Account,
	type ApiKey,
	apiKeyLookupSuffix,
	type ClientBulkClientResult,
	type ClientBulkMode,
	type ClientBulkOperation,
	type ClientBulkReview,
	type ClientDestinations,
	type ClientDraft,
	type ClientFormat,
	type ClientModel,
	type ClientModelMetadata,
	type ClientModelMetadataResponse,
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
import {
	listLegacyOverrides,
	renderLegacyCatalogue,
} from "./legacy-catalogue-snapshot";
import type { ModelCatalogService } from "./model-catalog-service";

const FORMATS: ClientFormat[] = ["anthropic", "openai", "codex"];
interface Deps {
	dbOps: DatabaseOperations;
	modelCatalog: ModelCatalogService;
	permissions: AccountModelPermissionService;
	codexCatalog: CodexModelCatalogCache;
}
const BULK_MODES: ClientBulkMode[] = ["add", "remove", "replace"];
/** How long a review token stays redeemable. */
const PENDING_TTL_MS = 600000;
/** Prepared client records held across all pending reviews. */
const PENDING_CLIENT_CAP = 128;
const BULK_MAX_CLIENTS = 50;
const BULK_MAX_MODELS = 500;
/**
 * Ceiling on the summed `review.aliasRules.length` of a batch's prepared
 * records. Applying one client rewrites every routing rule's position twice
 * whenever it contributes alias rules, so the write count grows with the
 * square of that sum. Only a prepared record knows that sum: a client's
 * retained pre-existing rules count towards the write transaction while the
 * request that triggers them can carry no alias at all. Bounding after
 * preparation throws away reads, which is the right trade for bounding the
 * quantity that is actually written.
 */
const BULK_MAX_ALIAS_WRITES = 500;

/**
 * Ceiling on resolving one client's published model metadata.
 *
 * Deliberately above `@clankermux/core`'s 6s catalogue wait, so a normal cold
 * models.dev load is not cut short — the shorter budget the catalogue reads use
 * would report every limit unknown for exactly the requests that arrive first
 * after a restart. The fallback is an empty map marked unloaded, which the
 * setup dialog renders as "limits could not be resolved" rather than as a
 * snippet that looks complete.
 */
const MODEL_METADATA_BUDGET_MS = 8_000;
/** Optional wire enrichment must fit inside the models route's catalogue budget. */
const WIRE_METADATA_BUDGET_MS = 1_000;

/** One client's reviewed outcome, ready to be written. */
interface PreparedDraft {
	review: Omit<ClientReview, "token">;
	profile: ClientProfile;
}
/**
 * Single-client and bulk reviews share one pending map, so the expiry sweep and
 * the retention cap cover both, and a token can never be redeemed through the
 * commit path it was not issued for.
 */
type Prepared = { fingerprint: string; expires: number } & (
	| { kind: "single"; record: PreparedDraft }
	| {
			kind: "bulk";
			operation: ClientBulkOperation;
			records: PreparedDraft[];
	  }
);
const emptyCatalogues = (): ClientProfile["catalogues"] => ({
	anthropic: { models: [], defaultModel: null },
	openai: { models: [], defaultModel: null },
	codex: { models: [], defaultModel: null },
});

/**
 * Structural equality over JSON-shaped values. A stored catalogue arrives from
 * `JSON.parse` and a proposed one is built here, so their keys can be in
 * different orders while the two describe the same catalogue.
 */
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b))
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((value, index) => deepEqual(value, b[index]))
		);
	if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	for (const key of new Set([...Object.keys(left), ...Object.keys(right)]))
		if (!deepEqual(left[key], right[key])) return false;
	return true;
}

/** Sorted account pin, as a comparable string. `null` stays distinct from `[]`. */
const pinOf = (model: ClientModel): string =>
	JSON.stringify(model.accountIds ? [...model.accountIds].sort() : null);

const rejectedClient = (
	apiKeyId: string,
	name: string,
	reason: string,
): ClientBulkClientResult => ({
	apiKeyId,
	name,
	status: "rejected",
	reason,
	added: [],
	removed: [],
	modified: [],
	defaultModelChange: null,
	notices: [],
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
				listLegacyOverrides(this.deps.dbOps, "anthropic"),
				listLegacyOverrides(this.deps.dbOps, "openai"),
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
			const response = await renderLegacyCatalogue(format, {
				getCatalog: async () => raw,
				staticModels: handleModelsRequest,
				staticModelIds: modelCatalog.staticModelIds,
				getAnthropicCatalog: async () => anthropic,
				listOverrides: async (dialect) =>
					dialect === "anthropic" ? anthropicOverrides : openaiOverrides,
			});
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
	/**
	 * What this client's setup snippets may declare about each published model.
	 *
	 * Resolved per call and never stored: the answer depends on the routing rules
	 * and account permissions in force right now, and a saved copy would describe
	 * the route the catalogue had when it was written.
	 */
	async modelMetadata(
		id: string,
		format: ClientFormat,
	): Promise<ClientModelMetadataResponse> {
		const profile = await this.deps.dbOps.clients.getProfile(id);
		const key = await this.deps.dbOps.getApiKeyPin(id);
		if (!profile || !key || key.malformed)
			throw new Error("Client catalogue not found");
		return catalogueWithin(
			this.resolveModelMetadata(
				id,
				key,
				profile.catalogues[format].models,
				format,
			),
			{ models: {}, catalogueLoaded: false, catalogueStale: false },
			MODEL_METADATA_BUDGET_MS,
		);
	}
	private async resolveModelMetadata(
		id: string,
		key: { pinnedAccountId: string | null; pinnedProviders: string[] | null },
		models: ClientModel[],
		format: ClientFormat,
	): Promise<ClientModelMetadataResponse> {
		const rules = await this.deps.dbOps.routing.listRules();
		const accounts = await this.accounts({
			accountId: key.pinnedAccountId,
			providers: key.pinnedProviders,
		});
		// Stored rows only. Discovery is never triggered from here: opening a setup
		// dialog must not put requests on the operator's accounts.
		const permissions = new Map(
			await Promise.all(
				accounts.map(
					async (account) =>
						[
							account.id,
							await this.deps.permissions
								.permissions(account)
								.catch(() => null),
						] as const,
				),
			),
		);
		const resolved = new Map<string, Promise<ClientModelMetadata>>();
		let lookups = 0;
		let nativeLoaded = false;
		let nativeStale = false;
		const entries = await Promise.all(
			models.map(async (model) => {
				const winning = matchRoutingRule(rules, id, model.id);
				// The live route, not the stored `targetModel`: a literal rule matching
				// `any` or this model's family remaps the published id, and the stored
				// value would then describe a route that no longer exists.
				const target = resolveRoutingTarget(winning, model.id).upstreamModel;
				const pool =
					winning?.pool_kind === "accounts"
						? (winning.pool_account_ids ?? [])
						: null;
				const providers = new Set<string>();
				const cacheRoutes: Array<{
					provider: string;
					customEndpoint?: string | null;
					format: ClientFormat;
				}> = [];
				const discoveredMetadata: ClientModelMetadata[] = [];
				const nativeAccountIds: string[] = [];
				let staleNativeRoute = false;
				let unresolvedRoutes = false;
				for (const account of accounts) {
					if (pool && !pool.includes(account.id)) continue;
					if (
						winning?.pool_kind === "provider" &&
						account.provider !== winning.pool_provider
					)
						continue;
					const permission = permissions.get(account.id) ?? null;
					if (isModelPermitted(permission, account.id, target, winning)) {
						cacheRoutes.push({
							provider: account.provider,
							customEndpoint: account.custom_endpoint,
							format,
						});
						const native = this.deps.permissions.discoveredMetadata(
							account,
							permission,
						);
						if (native) {
							discoveredMetadata.push(native.models[target] ?? {});
							nativeAccountIds.push(account.id);
							staleNativeRoute ||= native.stale;
						} else if (NATIVE_DISCOVERY_PROVIDERS.has(account.provider)) {
							unresolvedRoutes = true;
						} else providers.add(account.provider);
					}
					// Neither eligible nor dismissible: an account whose permissions were
					// never read may or may not serve this model, so the whole alias goes
					// unresolved rather than being described from the accounts we can see.
					else if (!permission || permission.completeness === "unknown")
						unresolvedRoutes = true;
				}
				if (!unresolvedRoutes && nativeAccountIds.length) {
					nativeLoaded = true;
					nativeStale ||= staleNativeRoute;
				}
				// Aliases share targets, and the pin and the rule pool are the same for
				// most of them, so one catalogue resolution usually covers several.
				const cacheKey = JSON.stringify([
					target,
					[...providers].sort(),
					nativeAccountIds.sort(),
					unresolvedRoutes,
				]);
				let work = resolved.get(cacheKey);
				if (!work) {
					if (providers.size && !unresolvedRoutes) lookups++;
					work = resolveClientModelMetadata({
						targetModel: target,
						providers: [...providers],
						discoveredMetadata,
						unresolvedRoutes,
					});
					resolved.set(cacheKey, work);
				}
				const metadata = { ...(await work) };
				const cachePolicy = resolveModelCachePolicy(
					target,
					cacheRoutes,
					unresolvedRoutes,
				);
				if (cachePolicy) metadata.cachePolicy = cachePolicy;
				return [model.id, metadata] as const;
			}),
		);
		// Read once the lookups are done rather than per lookup: they all consult
		// the same process-wide catalogue, so this is what every one of them saw,
		// only fresher. With no lookups at all nothing was consulted.
		const status = pricingCatalogueStatus();
		return {
			models: Object.fromEntries(entries),
			catalogueLoaded:
				(nativeLoaded || lookups > 0) && (lookups === 0 || status.loaded),
			catalogueStale: nativeStale || (lookups > 0 && status.stale),
		};
	}
	async wire(
		id: string,
		format: ClientFormat,
		includeMetadata = false,
	): Promise<Response> {
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
		const metadata = includeMetadata
			? await catalogueWithin(
					this.resolveModelMetadata(id, key, catalogue.models, format),
					{ models: {}, catalogueLoaded: false, catalogueStale: false },
					WIRE_METADATA_BUDGET_MS,
				)
			: undefined;
		return renderClientCatalogue(catalogue, format, metadata?.models);
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
								"SELECT id,provider,custom_endpoint,api_key,identity_external_id,identity_email,identity_organization_name,identity_plan_tier FROM accounts WHERE disabled = 0 ORDER BY id",
							)
							.all() as Account[]
					).map((a) => [a.id, modelPermissionScope(a)]),
					db.query("SELECT * FROM client_alias_rules ORDER BY rule_id").all(),
				]),
			)
			.digest("hex");
	}
	/**
	 * Validates one draft against the current database and builds everything a
	 * commit needs, without reserving a token or reading the fingerprint. A
	 * batch prepares many drafts under one fingerprint reading, so neither can
	 * belong here.
	 */
	private async prepareDraft(input: unknown): Promise<PreparedDraft> {
		if (!input || typeof input !== "object" || Array.isArray(input))
			throw BadRequest("Client must be an object");
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
		// The same checks the write path runs, run here instead of inside the
		// commit transaction.
		for (const rule of aliasRules)
			try {
				validateRoutingRule(rule);
			} catch (error) {
				throw BadRequest(
					error instanceof Error ? error.message : String(error),
				);
			}
		const precedingRules = [
			...new Set(
				aliasRules
					.map((r) => matchRoutingRule(rules, id, r.match_model_value)?.name)
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
		return {
			review: {
				draft: { ...draft, catalogues: catalogue },
				aliasRules,
				precedingRules,
				notices,
			},
			profile,
		};
	}
	/**
	 * Writes one prepared client. The caller owns the transaction and the
	 * fingerprint check, so a batch can hold many of these under one of each.
	 *
	 * The position renumbering re-reads the table on every call, which is what
	 * keeps repeated passes correct under `routing_rules`' unique position.
	 */
	private applyPreparedInTransaction(
		prepared: PreparedDraft,
		created: { apiKey?: string; hash?: string | null; createdAt: number },
	): void {
		const { review, profile } = prepared;
		const { draft } = review;
		const { dbOps } = this.deps;
		const adapter = dbOps.getAdapter();
		const routing = new RoutingRepository(adapter);
		const db = adapter.getSQLiteDb();
		if (!draft.id) {
			new ApiKeyRepository(adapter).createInTransaction({
				id: profile.apiKeyId,
				name: draft.name,
				// biome-ignore lint/style/noNonNullAssertion: commit() hashes the key it generates, and only a draft with no id reaches this branch
				hashed_key: created.hash!,
				// biome-ignore lint/style/noNonNullAssertion: commit() generates the plaintext key for exactly the no-id case this branch tests
				setup_key: created.apiKey!,
				// biome-ignore lint/style/noNonNullAssertion: the same generated key as setup_key above
				prefix_last_8: apiKeyLookupSuffix(created.apiKey!),
				created_at: created.createdAt,
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
			// biome-ignore lint/style/noNonNullAssertion: prepareDraft refuses a draft carrying an id unless its revision equals the stored profile's, or is 0 when no profile exists
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
	}
	/** Drops expired reviews, then oldest-first until the client cap holds. */
	private trimPending(): void {
		for (const [key, value] of this.pending)
			if (value.expires < Date.now()) this.pending.delete(key);
		const held = (entry: Prepared) =>
			entry.kind === "bulk" ? entry.records.length : 1;
		let total = 0;
		for (const [, entry] of this.pending) total += held(entry);
		for (const [key, entry] of this.pending) {
			if (total <= PENDING_CLIENT_CAP) break;
			total -= held(entry);
			this.pending.delete(key);
		}
	}
	async review(input: unknown): Promise<ClientReview> {
		const fingerprintBefore = this.fingerprint();
		const record = await this.prepareDraft(input);
		const token = crypto.randomUUID();
		if (this.fingerprint() !== fingerprintBefore)
			throw Conflict(
				"Routing or account identity changed during review; review again",
			);
		this.pending.set(token, {
			kind: "single",
			record,
			fingerprint: fingerprintBefore,
			expires: Date.now() + PENDING_TTL_MS,
		});
		this.trimPending();
		return { token, ...record.review };
	}
	async commit(
		token: string,
	): Promise<{ client: ClientView; apiKey?: string }> {
		const prepared = this.pending.get(token);
		if (
			!prepared ||
			prepared.expires < Date.now() ||
			prepared.kind !== "single"
		)
			throw Conflict("Review expired; review the client again");
		const { record, fingerprint } = prepared;
		const { profile } = record;
		const { draft } = record.review;
		const { dbOps } = this.deps;
		const cryptoUtils = new NodeCryptoUtils();
		const apiKey = draft.id ? undefined : await cryptoUtils.generateApiKey();
		const hash = apiKey ? await cryptoUtils.hashApiKey(apiKey) : null;
		const adapter = dbOps.getAdapter();
		const createdAt = Date.now();
		await adapter.runTransaction(() => {
			if (this.fingerprint() !== fingerprint)
				throw new RoutingConflictError(
					"Routing or destinations changed; review the client again",
				);
			this.applyPreparedInTransaction(record, { apiKey, hash, createdAt });
		});
		this.pending.delete(token);
		return {
			client: await this.view(
				// biome-ignore lint/style/noNonNullAssertion: the transaction above wrote a client_profiles row for this id, and that row is a cascading reference to api_keys
				(await dbOps.getApiKey(profile.apiKeyId))!,
				await dbOps.routing.listRules(),
			),
			...(apiKey ? { apiKey } : {}),
		};
	}
	/**
	 * Validates the request shape. Everything here is refused outright, before
	 * any client is looked at, because none of it can be true for one client and
	 * false for another.
	 */
	private bulkRequest(input: unknown): {
		clientIds: string[];
		operation: ClientBulkOperation;
	} {
		if (!input || typeof input !== "object" || Array.isArray(input))
			throw BadRequest("Bulk request must be an object");
		const body = structuredClone(input) as {
			clientIds?: unknown;
			operation?: unknown;
		};
		const clientIds = body.clientIds;
		if (
			!Array.isArray(clientIds) ||
			!clientIds.length ||
			clientIds.length > BULK_MAX_CLIENTS ||
			clientIds.some((id) => typeof id !== "string" || !id)
		)
			throw BadRequest(`Select 1 to ${BULK_MAX_CLIENTS} clients`);
		if (new Set(clientIds as string[]).size !== clientIds.length)
			throw BadRequest("A client can appear only once in a bulk edit");
		if (
			!body.operation ||
			typeof body.operation !== "object" ||
			Array.isArray(body.operation)
		)
			throw BadRequest("Bulk operation must be an object");
		const operation = body.operation as {
			format?: unknown;
			mode?: unknown;
			models?: unknown;
			defaultModel?: unknown;
		};
		if (!FORMATS.includes(operation.format as ClientFormat))
			throw BadRequest("Unknown catalogue format");
		if (!BULK_MODES.includes(operation.mode as ClientBulkMode))
			throw BadRequest("Unknown bulk operation");
		const models = operation.models;
		if (!Array.isArray(models) || models.length > BULK_MAX_MODELS)
			throw BadRequest(`Choose at most ${BULK_MAX_MODELS} models`);
		// Only `id` is checked here: all three modes read it while merging and
		// while diffing, so a malformed entry would throw out of the request
		// before any validation ran. The rest of an entry is per-client and
		// stays prepareDraft's job.
		const seen = new Set<string>();
		for (const value of models) {
			if (!value || typeof value !== "object" || Array.isArray(value))
				throw BadRequest("Invalid model entry");
			const id = (value as ClientModel).id;
			if (
				typeof id !== "string" ||
				!id.trim() ||
				id !== id.trim() ||
				id.length > 256
			)
				throw BadRequest("Invalid model ID");
			if (seen.has(id)) throw BadRequest(`Duplicate model ${id}`);
			seen.add(id);
		}
		return {
			clientIds: clientIds as string[],
			operation: {
				format: operation.format as ClientFormat,
				mode: operation.mode as ClientBulkMode,
				models: models as ClientModel[],
				defaultModel: (operation.defaultModel ?? null) as string | null,
			},
		};
	}
	/**
	 * Proposes one catalogue operation to many clients. Catalogue entries are
	 * not portable verbatim — account pins, Claude Code's compatible-alias rule
	 * and Codex metadata are all properties of the target client — so every
	 * client re-validates the proposal and the ones that refuse it are reported
	 * and skipped rather than failing the batch.
	 */
	async bulkReview(input: unknown): Promise<ClientBulkReview> {
		const { clientIds, operation } = this.bulkRequest(input);
		const { dbOps } = this.deps;
		const fingerprintBefore = this.fingerprint();
		const operationIds = new Set(operation.models.map((m) => m.id));
		const clients: ClientBulkClientResult[] = [];
		const records: PreparedDraft[] = [];
		for (const id of clientIds) {
			const key = await dbOps.getApiKey(id);
			if (!key) {
				clients.push(rejectedClient(id, id, "Client not found"));
				continue;
			}
			// A bulk edit must not resurrect a missing profile: `missingProfile()`
			// carries revision 0, which prepareDraft reads as a create.
			const profile = await dbOps.clients.getProfile(id);
			if (!profile) {
				clients.push(
					rejectedClient(
						id,
						key.name,
						"Client catalogue is missing; configure this client first",
					),
				);
				continue;
			}
			const draft: ClientDraft = {
				id,
				revision: profile.revision,
				name: key.name,
				application: profile.application,
				destinations: {
					accountId: key.pinnedAccountId,
					providers: key.pinnedProviders,
				},
				catalogues: structuredClone(profile.catalogues),
			};
			const before = profile.catalogues[operation.format];
			const after = draft.catalogues[operation.format];
			const notices: string[] = [];
			if (operation.mode === "replace") {
				after.models = structuredClone(operation.models);
				after.defaultModel = operation.defaultModel ?? null;
			} else {
				if (operation.mode === "add") {
					const present = new Set(after.models.map((m) => m.id));
					for (const model of operation.models)
						if (!present.has(model.id))
							after.models.push(structuredClone(model));
				} else
					after.models = after.models.filter((m) => !operationIds.has(m.id));
				if (
					after.defaultModel !== null &&
					!after.models.some((m) => m.id === after.defaultModel)
				) {
					notices.push(
						`Default model cleared: ${after.defaultModel} is no longer in this catalogue.`,
					);
					after.defaultModel = null;
				}
			}
			const beforeById = new Map(before.models.map((m) => [m.id, m]));
			const afterById = new Map(after.models.map((m) => [m.id, m]));
			const added = [...afterById.keys()].filter((k) => !beforeById.has(k));
			const removed = [...beforeById.keys()].filter((k) => !afterById.has(k));
			const result: ClientBulkClientResult = {
				apiKeyId: id,
				name: key.name,
				status: "unchanged",
				reason: null,
				added,
				removed,
				modified: [],
				defaultModelChange: null,
				notices,
			};
			// An identical raw draft prepares to an identical record for every
			// format, so this fast path only ever skips work.
			if (deepEqual(after, before)) {
				clients.push(result);
				continue;
			}
			try {
				const record = await this.prepareDraft(draft);
				// Everything past here diffs the prepared catalogue rather than
				// the raw draft: preparation is what validates an entry,
				// normalizes its account pin, and resolves an Anthropic entry's
				// `createdAt` from this client's own stored one. Diffing the raw
				// draft would both read unvalidated fields and call a
				// replacement carrying another client's timestamps a change.
				const prepared = record.profile.catalogues[operation.format];
				if (deepEqual(prepared, before)) {
					clients.push(result);
					continue;
				}
				const preparedById = new Map(prepared.models.map((m) => [m.id, m]));
				records.push(record);
				clients.push({
					...result,
					status: "changed",
					added: [...preparedById.keys()].filter((k) => !beforeById.has(k)),
					removed: [...beforeById.keys()].filter((k) => !preparedById.has(k)),
					modified: [...preparedById.keys()].filter((k) => {
						const old = beforeById.get(k);
						const next = preparedById.get(k);
						return (
							!!old &&
							!!next &&
							(old.targetModel !== next.targetModel ||
								old.displayName !== next.displayName ||
								pinOf(old) !== pinOf(next))
						);
					}),
					defaultModelChange:
						before.defaultModel === prepared.defaultModel
							? null
							: { from: before.defaultModel, to: prepared.defaultModel },
					notices: [...notices, ...record.review.notices],
				});
			} catch (error) {
				if (
					!isClientInputError(error) &&
					!(
						error instanceof HttpError &&
						(error.status === 400 || error.status === 409)
					)
				)
					throw error;
				clients.push(
					rejectedClient(
						id,
						key.name,
						error instanceof Error ? error.message : String(error),
					),
				);
			}
		}
		const aliasWrites = records.reduce(
			(n, r) => n + r.review.aliasRules.length,
			0,
		);
		if (aliasWrites > BULK_MAX_ALIAS_WRITES)
			throw BadRequest(
				"This batch would rewrite too many routing rules; select fewer clients or fewer alias models",
			);
		if (this.fingerprint() !== fingerprintBefore)
			throw Conflict(
				"Routing or account identity changed during review; review again",
			);
		const token = crypto.randomUUID();
		this.pending.set(token, {
			kind: "bulk",
			operation,
			records,
			fingerprint: fingerprintBefore,
			expires: Date.now() + PENDING_TTL_MS,
		});
		this.trimPending();
		return { token, operation, clients };
	}
	/**
	 * Applies every client the review prepared, in one transaction under one
	 * fingerprint check. Committing a single client moves `routing_rules`, so N
	 * separate commits would invalidate each other's reviews.
	 */
	async bulkCommit(token: string): Promise<{ clients: ClientView[] }> {
		const prepared = this.pending.get(token);
		if (!prepared || prepared.expires < Date.now() || prepared.kind !== "bulk")
			throw Conflict("Review expired; review the client again");
		const { records, fingerprint } = prepared;
		const { dbOps } = this.deps;
		const adapter = dbOps.getAdapter();
		const createdAt = Date.now();
		// Applying in a fixed order keeps the routing-rule renumbering the same
		// run to run, whatever order the operator selected the clients in.
		const ordered = [...records].sort((a, b) =>
			a.profile.apiKeyId.localeCompare(b.profile.apiKeyId),
		);
		await adapter.runTransaction(() => {
			if (this.fingerprint() !== fingerprint)
				throw new RoutingConflictError(
					"Routing or destinations changed; review the client again",
				);
			for (const record of ordered)
				this.applyPreparedInTransaction(record, { createdAt });
		});
		this.pending.delete(token);
		const rules = await dbOps.routing.listRules();
		const clients: ClientView[] = [];
		for (const record of records)
			clients.push(
				await this.view(
					// biome-ignore lint/style/noNonNullAssertion: the transaction above wrote a client_profiles row for this id, and that row is a cascading reference to api_keys
					(await dbOps.getApiKey(record.profile.apiKeyId))!,
					rules,
				),
			);
		return { clients };
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
