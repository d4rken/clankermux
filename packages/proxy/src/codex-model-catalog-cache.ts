import { Logger } from "@clankermux/logger";
import {
	type fetchCodexModelCatalog,
	readChatgptAccountId,
} from "@clankermux/providers";
import type { Account } from "@clankermux/types";

const log = new Logger("CodexModelCatalogCache");

/**
 * How long a fetched catalog is served before a refresh is attempted.
 *
 * The catalog changes when OpenAI ships or retires a model — a scale of days —
 * so six hours is already far tighter than the data moves. The cost of being
 * stale is bounded anyway: a model absent from the catalog still works, because
 * the responses adapter forwards model names verbatim.
 */
export const CODEX_MODEL_CATALOG_TTL_MS = 6 * 60 * 60 * 1_000;

/**
 * Most distinct client versions kept at once, oldest evicted first.
 *
 * The key originates in a request parameter, so this is a self-defence bound,
 * not a tuning knob: without it a caller varying the version could grow the map
 * indefinitely and, worse, force a fresh authenticated upstream call per novel
 * value. Callers are expected to sanitize too (see apps/server/models-route),
 * but a cache that only holds its bound when its caller behaves does not hold
 * it. Real deployments see one or two versions; a handful is generous.
 */
export const CODEX_MODEL_CATALOG_MAX_ENTRIES = 8;

export interface CodexModelCatalogEntry {
	bodyText: string;
	etag: string | null;
}

export interface CodexModelCatalogCacheDeps {
	/** Every account in the pool; filtering to usable Codex accounts is ours. */
	listCodexAccounts: () => Promise<readonly Account[]>;
	getAccessToken: (account: Account) => Promise<string>;
	fetchCatalog: typeof fetchCodexModelCatalog;
	now?: () => number;
}

interface CacheSlot {
	entry: CodexModelCatalogEntry;
	fetchedAt: number;
}

/**
 * Serves the Codex model catalog on behalf of the pool.
 *
 * The catalog is per-subscription, so this reads it from one of our own Codex
 * accounts rather than relaying the client's credential — our clients
 * authenticate with a ClankerMux API key and hold no upstream-valid token.
 * Serving account A's catalog to a request that may later route to account B is
 * a theoretical mismatch and strictly better than the hardcoded list it
 * replaces; nothing downstream gates on it, because model names are forwarded
 * verbatim.
 *
 * Everything here is best-effort. A failure means we could not LEARN the
 * catalog, never that an account is unhealthy, so no failure recorded here is
 * counted against an account.
 */
export class CodexModelCatalogCache {
	private readonly deps: Required<CodexModelCatalogCacheDeps>;
	private readonly slots = new Map<string, CacheSlot>();
	/** Keyed like {@link slots}, so concurrent callers share one upstream call. */
	private readonly inFlight = new Map<
		string,
		Promise<CodexModelCatalogEntry | null>
	>();

	constructor(deps: CodexModelCatalogCacheDeps) {
		this.deps = { now: Date.now, ...deps };
	}

	/**
	 * The catalog for `clientVersion`, or `null` when the pool cannot produce
	 * one. Never throws and never rejects: the caller's fallback is a static
	 * list, which is what shipped before this existed.
	 */
	async get(
		clientVersion: string | null,
	): Promise<CodexModelCatalogEntry | null> {
		// The catalog is version-gated upstream, so two client versions are two
		// different documents.
		const key = clientVersion ?? "";
		const slot = this.slots.get(key);
		if (slot && this.deps.now() - slot.fetchedAt < CODEX_MODEL_CATALOG_TTL_MS) {
			return slot.entry;
		}

		const existing = this.inFlight.get(key);
		if (existing) return existing;

		const refresh = this.refresh(key, clientVersion).finally(() => {
			this.inFlight.delete(key);
		});
		this.inFlight.set(key, refresh);
		return refresh;
	}

	private async refresh(
		key: string,
		clientVersion: string | null,
	): Promise<CodexModelCatalogEntry | null> {
		const fetched = await this.fetchFromAnyAccount(clientVersion);
		if (fetched) {
			// Delete before set so insertion order tracks write recency: Map keeps
			// a re-`set` key in its original position, which would make eviction
			// drop the entry written longest ago rather than the one least recently
			// refreshed.
			this.slots.delete(key);
			this.slots.set(key, { entry: fetched, fetchedAt: this.deps.now() });
			this.evictOverflow();
			return fetched;
		}

		// Expired but present beats nothing: a catalog that is hours old still
		// describes the models correctly, whereas the static fallback is a shape
		// Codex cannot parse at all. The failure itself is NOT cached, so the next
		// caller retries instead of inheriting this verdict for a whole TTL.
		const stale = this.slots.get(key);
		if (stale) {
			log.warn(
				"Could not refresh the Codex model catalog; serving the previous copy",
			);
			return stale.entry;
		}
		return null;
	}

	/**
	 * Hold at most {@link CODEX_MODEL_CATALOG_MAX_ENTRIES}, dropping the least
	 * recently written first. Relies on Map iterating in insertion order, which
	 * `refresh` keeps aligned with write recency by deleting before setting.
	 */
	private evictOverflow(): void {
		while (this.slots.size > CODEX_MODEL_CATALOG_MAX_ENTRIES) {
			const oldest = this.slots.keys().next();
			if (oldest.done) return;
			this.slots.delete(oldest.value);
		}
	}

	private async fetchFromAnyAccount(
		clientVersion: string | null,
	): Promise<CodexModelCatalogEntry | null> {
		let accounts: readonly Account[];
		try {
			accounts = await this.deps.listCodexAccounts();
		} catch (error) {
			log.warn(
				"Could not list accounts for a model-catalog read:",
				error instanceof Error ? error.message : String(error),
			);
			return null;
		}

		const candidates = accounts.filter(
			(account) => account.provider === "codex" && !account.paused,
		);
		if (candidates.length === 0) return null;

		for (const account of candidates) {
			let accessToken: string;
			try {
				accessToken = await this.deps.getAccessToken(account);
			} catch (error) {
				// A paused-for-reauth account cannot produce a token; that is an
				// account problem the reauth flow already owns, not a catalog problem.
				log.debug(
					`No usable token for '${account.name}' while reading the model catalog:`,
					error instanceof Error ? error.message : String(error),
				);
				continue;
			}

			// The real fetcher is fail-clean and returns `ok: false` rather than
			// throwing, but this class promises its caller a value or null and must
			// not depend on that to keep the promise.
			try {
				const result = await this.deps.fetchCatalog({
					accessToken,
					chatgptAccountId: readChatgptAccountIdSafe(accessToken),
					clientVersion,
				});
				if (result.ok) {
					return { bodyText: result.bodyText, etag: result.etag };
				}
			} catch (error) {
				log.warn(
					`Model-catalog read threw for '${account.name}':`,
					error instanceof Error ? error.message : String(error),
				);
			}
		}

		return null;
	}
}

/**
 * The `ChatGPT-Account-ID` claim, or null. Deliberately swallowing errors: the
 * header is optional, and a token whose claims we cannot decode is still worth
 * trying — the bearer is what actually authenticates the call.
 */
function readChatgptAccountIdSafe(accessToken: string): string | null {
	try {
		return readChatgptAccountId(accessToken);
	} catch {
		return null;
	}
}
