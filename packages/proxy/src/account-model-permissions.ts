import { createHash } from "node:crypto";
import { baseUrlShapeProblem, parseCustomEndpointData } from "@clankermux/core";
import type { RoutingRepository } from "@clankermux/database";
import {
	DevinClient,
	devinClient,
	fetchCodexModelCatalog,
	readChatgptAccountId,
} from "@clankermux/providers";
import type {
	Account,
	AccountModelPermissions,
	ClientModelMetadataMap,
} from "@clankermux/types";
import { getDefaultEndpoint, PROVIDER_NAMES } from "@clankermux/types";

/** No credential is persisted in provenance; OAuth refresh keeps the principal stable. */
export function modelPermissionScope(account: Account): string {
	const endpoint =
		parseCustomEndpointData(account.custom_endpoint)?.endpoint ?? null;
	return createHash("sha256")
		.update(
			JSON.stringify([
				account.provider,
				endpoint,
				account.api_key ?? null,
				account.identity_external_id ?? account.id,
				account.identity_email ?? null,
				account.identity_organization_name ?? null,
				account.identity_plan_tier ?? null,
			]),
		)
		.digest("hex");
}
interface DiscoveredCatalog {
	ids: string[];
	metadata?: ClientModelMetadataMap;
}
interface NativeMetadataSnapshot {
	generation: number;
	fetchedAt: number;
	models: ClientModelMetadataMap;
}
interface DiscoveryDeps {
	repository: RoutingRepository;
	listAccounts: () => Promise<readonly Account[]>;
	getAccessToken: (account: Account) => Promise<string>;
	fetchImpl?: typeof fetch;
	now?: () => number;
	requestBudgetMs?: number;
	backgroundBudgetMs?: number;
}

/**
 * Whole-attempt discovery budget for providers whose catalogue endpoint rests on
 * no published contract.
 *
 * Z.ai speaks the Anthropic Messages protocol, so `/v1/models` on its base is a
 * reasonable guess — but only a guess. MiMo's path is not guessed (see the
 * branch below), yet it is still a third-party host with nothing owed about how
 * fast it answers. Either way a request that hangs is worse than one that fails
 * outright, because an in-flight attempt is joined by every request that arrives
 * during it. One second is long enough for a catalogue that answers and short
 * enough that one that does not costs little.
 */
const ASSUMED_CATALOGUE_BUDGET_MS: Record<string, number> = {
	zai: 1000,
	mimo: 1000,
};

/** Providers whose client metadata requires an account discovery snapshot. */
export const NATIVE_DISCOVERY_PROVIDERS: ReadonlySet<string> = new Set([
	"devin",
]);

/**
 * Providers that authenticate discovery with a stored API key and have no OAuth
 * path, so discovery must never reach for an access token on their behalf.
 */
const API_KEY_ONLY_PROVIDERS: ReadonlySet<string> = new Set(["zai", "mimo"]);

/** Permission discovery never borrows a provider-wide or pin-wide catalogue. */
export class AccountModelPermissionService {
	private readonly inFlight = new Map<string, Promise<void>>();
	private readonly retryAt = new Map<string, number>();
	private readonly failures = new Map<string, number>();
	private readonly nextRefresh = new Map<string, number>();
	private readonly nativeMetadata = new Map<string, NativeMetadataSnapshot>();
	private readonly controllers = new Set<AbortController>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly now: () => number;
	private readonly devin: DevinClient;
	constructor(private readonly deps: DiscoveryDeps) {
		this.now = deps.now ?? Date.now;
		this.devin = deps.fetchImpl ? new DevinClient(deps.fetchImpl) : devinClient;
	}
	async permissions(account: Account): Promise<AccountModelPermissions> {
		const scope = modelPermissionScope(account);
		const previous = await this.deps.repository.getPermissions(account.id);
		if (previous?.scope === scope) return previous;
		const current = (await this.deps.listAccounts()).find(
			(a) => a.id === account.id,
		);
		if (!current || modelPermissionScope(current) !== scope)
			throw new Error("Account identity changed");
		const next = await this.deps.repository.ensurePermissionScope(
			account.id,
			scope,
			previous?.generation ?? 0,
		);
		if (next.scope !== scope) throw new Error("Account identity changed");
		return next;
	}
	/** Read the account's committed discovery snapshot without issuing upstream requests. */
	discoveredMetadata(
		account: Account,
		permissions: AccountModelPermissions | null,
	): { models: ClientModelMetadataMap; stale: boolean } | undefined {
		const scope = modelPermissionScope(account);
		if (
			!permissions ||
			permissions.account_id !== account.id ||
			permissions.scope !== scope
		)
			return undefined;
		const snapshot = this.nativeMetadata.get(`${account.id}:${scope}`);
		if (!snapshot || snapshot.generation !== permissions.generation)
			return undefined;
		return {
			models: snapshot.models,
			stale:
				permissions.last_error !== null ||
				this.now() >= snapshot.fetchedAt + 3600000,
		};
	}
	async refreshMisses(accounts: readonly Account[]): Promise<void> {
		// One race over the entire operation, never N sequential account deadlines.
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			Promise.allSettled(accounts.map((a) => this.refresh(a))),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, this.deps.requestBudgetMs ?? 2000);
			}),
		]).finally(() => clearTimeout(timer));
	}
	refresh(account: Account, manual = false): Promise<void> {
		if (account.disabled) return Promise.resolve();
		const scope = modelPermissionScope(account);
		const key = `${account.id}:${scope}`;
		const pending = this.inFlight.get(key);
		if (pending) return pending;
		if (!manual && (this.retryAt.get(key) ?? 0) > this.now())
			return Promise.resolve();
		this.retryAt.set(key, this.now() + 60000);
		const work = this.discover(account, scope).finally(() => {
			if (this.inFlight.get(key) === work) this.inFlight.delete(key);
		});
		this.inFlight.set(key, work);
		return work;
	}
	private async discover(account: Account, scope: string): Promise<void> {
		const current = (await this.deps.listAccounts()).find(
			(a) => a.id === account.id,
		);
		if (!current || current.disabled) return;
		const key = `${account.id}:${scope}`;
		const controller = new AbortController();
		this.controllers.add(controller);
		let timer: ReturnType<typeof setTimeout> | undefined;
		// A miss is refreshed ON THE REQUEST PATH for every account in the pool
		// (routing-service), and `refresh` joins an in-flight attempt before it
		// consults the backoff — so while one attempt hangs, arriving requests wait
		// out the caller's budget even when a higher-priority account already
		// permits the model. Providers with no published catalogue contract get a
		// tighter whole-attempt bound so a slow or wrong one costs one short wait
		// per backoff window instead of the full background budget.
		const budgetMs = Math.min(
			this.deps.backgroundBudgetMs ?? 10000,
			ASSUMED_CATALOGUE_BUDGET_MS[account.provider] ?? Number.POSITIVE_INFINITY,
		);
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new Error("Model discovery timed out"));
			}, budgetMs);
		});
		let permissions: AccountModelPermissions | undefined;
		try {
			// Credential acquisition is INSIDE the deadline; a late operation never commits.
			const catalog = await Promise.race([
				deadline,
				(async () => {
					permissions = await this.permissions(account);
					const result = await this.fetchCatalog(account, controller.signal);
					controller.signal.throwIfAborted();
					return result;
				})(),
			]);
			if (!permissions) throw new Error("Missing discovery generation");
			const committed = await this.deps.repository.completeDiscovery(
				account.id,
				scope,
				permissions.generation,
				catalog.ids,
				this.now(),
			);
			if (!committed) return;
			if (catalog.metadata)
				this.nativeMetadata.set(key, {
					generation: permissions.generation,
					fetchedAt: this.now(),
					models: catalog.metadata,
				});
			this.failures.delete(key);
			this.nextRefresh.set(
				key,
				this.now() + 3600000 * (0.9 + Math.random() * 0.2),
			);
		} catch {
			if (controller.signal.reason === "model-discovery-stopped") return;
			const count = (this.failures.get(key) ?? 0) + 1;
			this.failures.set(key, count);
			this.retryAt.set(
				key,
				this.now() + Math.min(300000, 60000 * 2 ** Math.min(count - 1, 3)),
			);
			// Do not surface upstream bodies, URLs or exception text (credentials can be echoed).
			if (permissions)
				await this.deps.repository.failDiscovery(
					account.id,
					scope,
					permissions.generation,
					controller.signal.aborted
						? "Model discovery timed out"
						: "Could not obtain a complete account model list; configure manual models if discovery is unsupported",
					this.now(),
				);
		} finally {
			clearTimeout(timer);
			controller.abort();
			this.controllers.delete(controller);
		}
	}
	private async fetchCatalog(
		account: Account,
		signal: AbortSignal,
	): Promise<DiscoveredCatalog> {
		// Before token acquisition, not inside the provider branch below: these
		// providers authenticate with a stored key and have no OAuth path at all,
		// so a keyless account must fail here rather than fall through to the
		// generic access-token helper and ask it to mint one.
		if (API_KEY_ONLY_PROVIDERS.has(account.provider) && !account.api_key)
			throw new Error(`${account.provider} account requires an API key`);
		const token = account.api_key || (await this.deps.getAccessToken(account));
		signal.throwIfAborted();
		const fetchImpl = this.deps.fetchImpl ?? fetch;
		const endpoint = parseCustomEndpointData(account.custom_endpoint)?.endpoint;
		if (account.provider === "devin") {
			const info = await this.devin.getAccount(token, endpoint, signal);
			const models = info.models.filter(
				(m) => !m.disabled && m.id !== "adaptive",
			);
			const metadata: ClientModelMetadataMap = Object.fromEntries(
				models.map((model) => {
					const entry: ClientModelMetadataMap[string] = {
						inputModalities: model.supportsImages
							? ["text", "image"]
							: ["text"],
					};
					for (const [field, value] of [
						["contextWindow", model.contextWindow],
						["maxOutputTokens", model.maxOutputTokens],
					] as const) {
						if (value !== null && Number.isInteger(value) && value > 0)
							entry[field] = value;
					}
					if (model.supportsThinking !== undefined)
						entry.reasoning = model.supportsThinking;
					return [model.id, entry];
				}),
			);
			return { ids: [...new Set(models.map((m) => m.id))], metadata };
		}
		if (account.provider === "codex") {
			if (endpoint && !endpoint.startsWith("https://chatgpt.com/"))
				throw new Error("Custom Codex backend requires manual models");
			const result = await fetchCodexModelCatalog({
				accessToken: token,
				chatgptAccountId: readChatgptAccountId(token),
				fetchImpl: ((input: string | URL | Request, init?: RequestInit) =>
					fetchImpl(input, {
						...init,
						signal: AbortSignal.any([
							signal,
							...(init?.signal ? [init.signal] : []),
						]),
					})) as typeof fetch,
			});
			if (!result.ok) throw new Error("Incomplete Codex catalogue");
			const body = JSON.parse(result.bodyText);
			if (body.has_more || body.next_page)
				throw new Error("Incomplete Codex catalogue");
			return { ids: body.models.map((m: { slug: string }) => m.slug) };
		}
		let url: URL;
		const headers = new Headers({ accept: "application/json" });
		const anthropic =
			account.provider === "anthropic" ||
			account.provider === "claude-console-api";
		// Cursor style is NOT the same question as "is this the official Anthropic
		// backend". `anthropic` selects the api.anthropic.com URL above; this
		// selects only the pagination parameter, so an Anthropic-SHAPED third
		// party can page correctly without being pointed at Anthropic's host.
		let cursorParam: "after_id" | "after" = anthropic ? "after_id" : "after";
		if (anthropic) {
			if (endpoint && !endpoint.startsWith("https://api.anthropic.com/"))
				throw new Error("Custom backend requires manual models");
			url = new URL("https://api.anthropic.com/v1/models");
			headers.set("anthropic-version", "2023-06-01");
			if (account.api_key) headers.set("x-api-key", token);
			else {
				headers.set("authorization", `Bearer ${token}`);
				headers.set("anthropic-beta", "oauth-2025-04-20");
			}
			url.searchParams.set("limit", "1000");
		} else if (account.provider === "zai") {
			// Z.ai speaks the Anthropic Messages protocol on a FIXED base that its
			// provider pins and its buildUrl never overrides (supportsCustomEndpoint
			// is false for zai), so the endpoint is hardcoded here rather than read
			// from the account: a stored custom_endpoint must not redirect a
			// credential.
			//
			// The catalogue path and its pagination are assumed from that Messages
			// compatibility, not from a published Z.ai contract. If the assumption is
			// wrong the fetch fails and failDiscovery records it, leaving previously
			// discovered and manual ids untouched — the account stays exactly as
			// routable as it was, and manual model ids remain the way through.
			url = new URL("https://api.z.ai/api/anthropic/v1/models");
			// Non-null by the API_KEY_ONLY_PROVIDERS check above.
			headers.set("x-api-key", token);
			headers.set("anthropic-version", "2023-06-01");
			url.searchParams.set("limit", "1000");
			cursorParam = "after_id";
		} else if (account.provider === "mimo") {
			// One Token Plan host, two surfaces. The stored endpoint is the REQUEST
			// base and normally ends in `/anthropic` — that is where the provider
			// dials `/anthropic/v1/messages` — but the catalogue is OpenAI-shaped and
			// sits on the host ROOT, so the segments the request path supplies for
			// itself come off here instead of being extended: one terminal `/v1` (a
			// stored base may already carry it), then one terminal `/anthropic`. Any
			// deployment prefix ahead of them survives, so `/anthropic`,
			// `/anthropic/v1` and a bare host all land on `<host>/v1/models`.
			// The strip is not a typo: on a live Token Plan subscription
			// `/anthropic/v1/models` 404s, while the root `/v1/models` answers 200
			// with `{object:"list",data:[{id,…}]}` to a Bearer token and no cursor —
			// hence one request, not a paged loop. If MiMo moves it the fetch fails
			// and failDiscovery records it, leaving previously discovered and manual
			// ids untouched: the account stays exactly as routable as it was.
			//
			// The base is READ FROM THE ACCOUNT where zai's is pinned, because MiMo's
			// honoursCustomEndpoint is true — the region (cn / sgp / ams) is what
			// custom_endpoint holds, and a Token Plan key is accepted by its own
			// region alone. Discovering against a different region would describe a
			// backend other than the one that serves the account's traffic, and would
			// answer 401 anyway.
			url = new URL(endpoint || getDefaultEndpoint(PROVIDER_NAMES.MIMO));
			// Operator-supplied, so it earns the same base-shape guard the
			// *-compatible branches use rather than a second derivation of it: a base
			// carrying a query or credentials cannot have a path appended to it.
			if (baseUrlShapeProblem(url))
				throw new Error("Invalid discovery endpoint");
			url.pathname = `${url.pathname
				.replace(/\/+$/, "")
				.replace(/\/v1$/, "")
				.replace(/\/anthropic$/, "")}/v1/models`;
			// Non-null by the API_KEY_ONLY_PROVIDERS check above.
			headers.set("authorization", `Bearer ${token}`);
		} else if (account.provider === "openrouter") {
			if (endpoint && !endpoint.startsWith("https://openrouter.ai/"))
				throw new Error("Custom backend requires manual models");
			url = new URL("https://openrouter.ai/api/v1/models/user");
			headers.set("authorization", `Bearer ${token}`);
		} else if (account.provider === "grok") {
			if (endpoint && !endpoint.startsWith("https://api.x.ai/"))
				throw new Error("Custom backend requires manual models");
			url = new URL("https://api.x.ai/v1/models");
			headers.set("authorization", `Bearer ${token}`);
		} else if (
			endpoint &&
			["openai-compatible", "anthropic-compatible"].includes(account.provider)
		) {
			url = new URL(endpoint);
			if (baseUrlShapeProblem(url))
				throw new Error("Invalid discovery endpoint");
			const base = url.pathname.replace(/\/+$/, "");
			url.pathname = `${base}${base.endsWith("/v1") ? "" : "/v1"}/models`;
			headers.set("authorization", `Bearer ${token}`);
		} else throw new Error("Provider requires manual models");
		const ids = new Set<string>();
		const cursors = new Set<string>();
		for (let page = 0; page < 100; page++) {
			signal.throwIfAborted();
			const response = await fetchImpl(url.toString(), {
				headers,
				signal,
				redirect: "error",
			});
			if (!response.ok) {
				await response.body?.cancel();
				throw new Error("Model listing failed");
			}
			const body = (await response.json()) as Record<string, unknown>;
			if (!Array.isArray(body.data)) throw new Error("Invalid model list");
			for (const item of body.data) {
				if (
					!item ||
					typeof item.id !== "string" ||
					!item.id.trim() ||
					item.id !== item.id.trim()
				)
					throw new Error("Partial model list");
				ids.add(item.id);
			}
			if (
				body.has_more === false ||
				(body.has_more === undefined && !body.next_page && !body.next)
			)
				return { ids: [...ids] };
			if (
				body.has_more !== true ||
				typeof body.last_id !== "string" ||
				!body.last_id ||
				cursors.has(body.last_id)
			)
				throw new Error("Incomplete model pagination");
			cursors.add(body.last_id);
			url.searchParams.set(cursorParam, body.last_id);
		}
		throw new Error("Model pagination exceeded limit");
	}
	async tick(): Promise<void> {
		const accounts = await this.deps.listAccounts();
		const live = new Set(
			accounts.map((a) => `${a.id}:${modelPermissionScope(a)}`),
		);
		for (const map of [
			this.retryAt,
			this.failures,
			this.nextRefresh,
			this.nativeMetadata,
		])
			for (const key of map.keys()) if (!live.has(key)) map.delete(key);
		await Promise.allSettled(
			accounts.map(async (account) => {
				const p = await this.permissions(account);
				const key = `${account.id}:${p.scope}`;
				if (
					p.last_success_at === null ||
					(NATIVE_DISCOVERY_PROVIDERS.has(account.provider) &&
						!this.discoveredMetadata(account, p)) ||
					this.now() >=
						(this.nextRefresh.get(key) ?? p.last_success_at + 3600000)
				)
					await this.refresh(account);
			}),
		);
	}
	start(): void {
		if (this.timer) return;
		void this.tick().catch(() => {});
		this.timer = setInterval(() => {
			void this.tick().catch(() => {});
		}, 60000);
		this.timer.unref?.();
	}
	stop(): void {
		for (const controller of this.controllers)
			controller.abort("model-discovery-stopped");
		this.inFlight.clear();
		this.controllers.clear();
		clearInterval(this.timer);
		this.timer = undefined;
	}
}
