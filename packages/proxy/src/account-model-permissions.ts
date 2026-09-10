import { createHash } from "node:crypto";
import { parseCustomEndpointData } from "@clankermux/core";
import type { RoutingRepository } from "@clankermux/database";
import {
	fetchCodexModelCatalog,
	readChatgptAccountId,
} from "@clankermux/providers";
import type { Account, AccountModelPermissions } from "@clankermux/types";

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
interface DiscoveryDeps {
	repository: RoutingRepository;
	listAccounts: () => Promise<readonly Account[]>;
	getAccessToken: (account: Account) => Promise<string>;
	fetchImpl?: typeof fetch;
	now?: () => number;
	requestBudgetMs?: number;
	backgroundBudgetMs?: number;
}

/** Permission discovery never borrows a provider-wide or pin-wide catalogue. */
export class AccountModelPermissionService {
	private readonly inFlight = new Map<string, Promise<void>>();
	private readonly retryAt = new Map<string, number>();
	private readonly failures = new Map<string, number>();
	private readonly nextRefresh = new Map<string, number>();
	private readonly controllers = new Set<AbortController>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly now: () => number;
	constructor(private readonly deps: DiscoveryDeps) {
		this.now = deps.now ?? Date.now;
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
		const key = `${account.id}:${scope}`;
		const controller = new AbortController();
		this.controllers.add(controller);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new Error("Model discovery timed out"));
			}, this.deps.backgroundBudgetMs ?? 10000);
		});
		let permissions: AccountModelPermissions | undefined;
		try {
			// Credential acquisition is INSIDE the deadline; a late operation never commits.
			const ids = await Promise.race([
				deadline,
				(async () => {
					permissions = await this.permissions(account);
					const result = await this.fetchIds(account, controller.signal);
					controller.signal.throwIfAborted();
					return result;
				})(),
			]);
			if (!permissions) throw new Error("Missing discovery generation");
			const committed = await this.deps.repository.completeDiscovery(
				account.id,
				scope,
				permissions.generation,
				ids,
				this.now(),
			);
			if (!committed) return;
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
	private async fetchIds(
		account: Account,
		signal: AbortSignal,
	): Promise<string[]> {
		const token = account.api_key || (await this.deps.getAccessToken(account));
		signal.throwIfAborted();
		const fetchImpl = this.deps.fetchImpl ?? fetch;
		const endpoint = parseCustomEndpointData(account.custom_endpoint)?.endpoint;
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
			return body.models.map((m: { slug: string }) => m.slug);
		}
		let url: URL;
		const headers = new Headers({ accept: "application/json" });
		const anthropic =
			account.provider === "anthropic" ||
			account.provider === "claude-console-api";
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
		} else if (account.provider === "openrouter") {
			if (endpoint && !endpoint.startsWith("https://openrouter.ai/"))
				throw new Error("Custom backend requires manual models");
			url = new URL("https://openrouter.ai/api/v1/models/user");
			headers.set("authorization", `Bearer ${token}`);
		} else if (
			endpoint &&
			["openai-compatible", "anthropic-compatible"].includes(account.provider)
		) {
			url = new URL(endpoint);
			if (
				url.username ||
				url.password ||
				url.search ||
				url.hash ||
				!["http:", "https:"].includes(url.protocol)
			)
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
				return [...ids];
			if (
				body.has_more !== true ||
				typeof body.last_id !== "string" ||
				!body.last_id ||
				cursors.has(body.last_id)
			)
				throw new Error("Incomplete model pagination");
			cursors.add(body.last_id);
			url.searchParams.set(anthropic ? "after_id" : "after", body.last_id);
		}
		throw new Error("Model pagination exceeded limit");
	}
	async tick(): Promise<void> {
		const accounts = await this.deps.listAccounts();
		const live = new Set(
			accounts.map((a) => `${a.id}:${modelPermissionScope(a)}`),
		);
		for (const map of [this.retryAt, this.failures, this.nextRefresh])
			for (const key of map.keys()) if (!live.has(key)) map.delete(key);
		await Promise.allSettled(
			accounts.map(async (account) => {
				const p = await this.permissions(account);
				const key = `${account.id}:${p.scope}`;
				if (
					p.last_success_at === null ||
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
