import {
	isAccountAllowedByPin,
	isPinActive,
	type RoutingPin,
} from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import {
	type fetchCodexModelCatalog,
	readChatgptAccountId,
} from "@clankermux/providers";
import { type Account, isKnownProvider } from "@clankermux/types";

const log = new Logger("CodexModelCatalogCache");

/**
 * How long a fetched catalog is served before a refresh is attempted.
 *
 * The catalog changes when OpenAI ships or retires a model — a scale of days —
 * so six hours is already far tighter than the data moves. Staleness is cheap
 * here anyway: a model absent from the catalog still works, because the
 * responses adapter forwards model names verbatim.
 */
export const CODEX_MODEL_CATALOG_TTL_MS = 6 * 60 * 60 * 1_000;

/**
 * Whole-lookup budget for a COLD read, across every account tried.
 *
 * The per-request timeout in the fetcher bounds one call, not the loop: with
 * several Codex accounts and a hanging backend, trying them in turn would hold
 * the client for the sum of those timeouts. A Codex startup would give up
 * waiting long before we returned the 200 we promise it, so the loop needs its
 * own ceiling rather than inheriting N times the fetcher's.
 *
 * Enforced as a RACE, not as a check between attempts. A per-attempt check
 * cannot bound anything: an attempt starting one millisecond inside the budget
 * still runs to its own timeout, and token acquisition has no timeout at all
 * (`getValidAccessToken` may refresh OAuth over a fetch with no deadline). A
 * hang there would otherwise never settle the in-flight entry, wedging the
 * scope permanently — every later cold caller awaiting a promise that cannot
 * resolve.
 */
export const CODEX_MODEL_CATALOG_LOOKUP_BUDGET_MS = 12_000;

/**
 * How long a scope waits before another upstream attempt after a failed one.
 *
 * Without it a failed refresh leaves `fetchedAt` expired, so every subsequent
 * request starts its own attempt: one unreachable backend becomes a stream of
 * authenticated calls, which is the traffic shape this must not generate.
 */
export const CODEX_MODEL_CATALOG_RETRY_AFTER_MS = 60_000;

/**
 * Most distinct pin scopes cached at once, least recently written evicted
 * first. Keys derive from API-key pins in the database, not from anything a
 * caller sends, so this is a modest safety bound rather than a defence.
 */
export const CODEX_MODEL_CATALOG_MAX_ENTRIES = 16;

export interface CodexModelCatalogEntry {
	bodyText: string;
	etag: string | null;
}

export interface CodexModelCatalogCacheDeps {
	/** Every account in the pool; narrowing to usable candidates is ours. */
	listAccounts: () => Promise<readonly Account[]>;
	/**
	 * The routing pin for an API key, or null when the key has no pin row.
	 * Mirrors `DatabaseOperations.getApiKeyPin`.
	 */
	getApiKeyPin: (apiKeyId: string) => Promise<{
		pinnedAccountId: string | null;
		pinnedProviders: string[] | null;
		malformed: boolean;
	} | null>;
	getAccessToken: (account: Account) => Promise<string>;
	fetchCatalog: typeof fetchCodexModelCatalog;
	now?: () => number;
	/** Overridable so tests can exercise the deadline without waiting for it. */
	lookupBudgetMs?: number;
}

interface CacheSlot {
	entry: CodexModelCatalogEntry;
	fetchedAt: number;
}

/** Resolution of an API key to the accounts whose catalog it may be shown. */
type PinScope =
	| { kind: "allowed"; key: string; pin: RoutingPin | null }
	/** Malformed pin: fail closed, exactly as the routing layer does. */
	| { kind: "refused" };

/**
 * Serves the Codex model catalog on behalf of the pool.
 *
 * The catalog is per-subscription, so it is read from one of OUR Codex accounts
 * rather than relayed from the client: clients authenticate with a ClankerMux
 * API key and hold no upstream-valid credential.
 *
 * Which account is not arbitrary. A key pinned to one account — or to a
 * provider class — must not be shown a different account's catalog: entitlement
 * differs by subscription (`available_in_plans` gates entries), so a catalog
 * from outside the pin can advertise a model the request will then be routed
 * away from and fail on. Candidates are therefore filtered by the same pin
 * predicate the router enforces, and cached per pin scope.
 *
 * Everything here is best-effort. A failure means we could not LEARN the
 * catalog, never that an account is unhealthy, so nothing here is counted
 * against an account.
 */
export class CodexModelCatalogCache {
	private readonly deps: Required<CodexModelCatalogCacheDeps>;
	private readonly slots = new Map<string, CacheSlot>();
	/** Keyed like {@link slots}, so concurrent callers share one upstream call. */
	private readonly inFlight = new Map<
		string,
		Promise<CodexModelCatalogEntry | null>
	>();
	/** Per-scope epoch-ms before which no further upstream attempt is made. */
	private readonly retryAfter = new Map<string, number>();

	constructor(deps: CodexModelCatalogCacheDeps) {
		this.deps = {
			now: Date.now,
			lookupBudgetMs: CODEX_MODEL_CATALOG_LOOKUP_BUDGET_MS,
			...deps,
		};
	}

	/**
	 * The catalog this API key may be shown, or `null` when the pool cannot
	 * produce one. Never throws and never rejects: the caller's fallback is the
	 * static list, which is what shipped before this existed.
	 *
	 * A cached-but-expired copy is returned IMMEDIATELY and refreshed in the
	 * background. Blocking a client on a refresh would hand it the full lookup
	 * budget of latency to receive a catalog we already had.
	 */
	async get(apiKeyId: string | null): Promise<CodexModelCatalogEntry | null> {
		// Bounded like the fetch, and for the same reason. Resolving the pin is a
		// database read, and the SQLite adapter's busy-retry can persist for
		// minutes; leaving this stage outside the deadline would let a busy
		// database stall even a HOT catalog request long past the point the
		// caller should have had its static fallback. Fails closed on timeout.
		const scope = await this.withDeadline<PinScope>(
			this.resolveScope(apiKeyId),
			{ kind: "refused" },
		);
		if (scope.kind === "refused") return null;

		const { key, pin } = scope;
		const slot = this.slots.get(key);
		if (slot) {
			const age = this.deps.now() - slot.fetchedAt;
			if (age < CODEX_MODEL_CATALOG_TTL_MS) return slot.entry;
			// Stale-while-revalidate. The refresh is deliberately not awaited; its
			// rejection cannot escape because refresh() resolves rather than throws.
			if (!this.inBackoff(key)) void this.startRefresh(key, pin);
			return slot.entry;
		}

		// Cold and recently failed: answer now rather than spending the budget
		// again. The caller's fallback is the static list.
		if (this.inBackoff(key)) return null;

		return this.startRefresh(key, pin);
	}

	/**
	 * When the POOL-WIDE catalog was last fetched, or null when none is held.
	 *
	 * Provenance for the operator's editing view, which reads the catalog at the
	 * unpinned scope (`get(null)`) because curation applies to the pool rather
	 * than to one key's pin. Deliberately not parameterised by API key: this is
	 * a display detail, and resolving a pin here would make a UI read do a
	 * database lookup it has no reason to do.
	 */
	getFetchedAt(): number | null {
		return this.slots.get("")?.fetchedAt ?? null;
	}

	private inBackoff(key: string): boolean {
		const until = this.retryAfter.get(key);
		if (until === undefined) return false;
		if (this.deps.now() >= until) {
			this.retryAfter.delete(key);
			return false;
		}
		return true;
	}

	/** Join the in-flight refresh for `key`, or start one. */
	private startRefresh(
		key: string,
		pin: RoutingPin | null,
	): Promise<CodexModelCatalogEntry | null> {
		const existing = this.inFlight.get(key);
		if (existing) return existing;

		const refresh = this.refresh(key, pin).finally(() => {
			this.inFlight.delete(key);
		});
		this.inFlight.set(key, refresh);
		return refresh;
	}

	/**
	 * Which accounts this key may see a catalog from, and the cache key for that
	 * scope. Unpinned keys share one entry; pinned keys get their own.
	 */
	private async resolveScope(apiKeyId: string | null): Promise<PinScope> {
		if (!apiKeyId) return { kind: "allowed", key: "", pin: null };

		let raw: Awaited<ReturnType<CodexModelCatalogCacheDeps["getApiKeyPin"]>>;
		try {
			raw = await this.deps.getApiKeyPin(apiKeyId);
		} catch (error) {
			// Unknown pin state. Fail closed rather than guess "unpinned" — that
			// guess is what could show a Codex-pinned key another pool's catalog.
			log.warn(
				"Could not resolve an API key's routing pin for a model-catalog read:",
				error instanceof Error ? error.message : String(error),
			);
			return { kind: "refused" };
		}

		// A null row means the key does not exist, NOT that it is unpinned — an
		// unpinned key returns an object whose fields are null. We only get here
		// with a non-null id, i.e. a request that authenticated, so a missing row
		// means the key was deleted underneath us. Reading that as "unpinned"
		// would widen a formerly pinned key to the whole pool during that race.
		if (!raw) return { kind: "refused" };

		// A pin we cannot parse is corruption; the routing layer fails closed on
		// it and so does this. Serving a pooled catalog here would be the same
		// mistake one step earlier.
		if (raw.malformed) return { kind: "refused" };

		const pin: RoutingPin = {
			accountId: raw.pinnedAccountId,
			providers: raw.pinnedProviders,
		};
		if (!isPinActive(pin)) return { kind: "allowed", key: "", pin: null };

		if (pin.accountId) {
			return { kind: "allowed", key: `account:${pin.accountId}`, pin };
		}

		const providers = [...(pin.providers ?? [])];
		// The stored list is only checked for "non-empty array of strings", so a
		// tampered row can hold anything. Refuse names we do not know rather than
		// key on them: the encoding below must be injective, and a value like
		// "anthropic,codex" is exactly the sort of thing that collapses two
		// distinct pins onto one cache entry.
		if (!providers.every((name) => isKnownProvider(name))) {
			return { kind: "refused" };
		}

		// JSON, not a comma join: `["a","b"]` and `["a,b"]` join identically, and
		// a shared key would serve one pin's catalog to the other.
		return {
			kind: "allowed",
			key: `providers:${JSON.stringify(providers.sort())}`,
			pin,
		};
	}

	private async refresh(
		key: string,
		pin: RoutingPin | null,
	): Promise<CodexModelCatalogEntry | null> {
		const fetched = await this.withDeadline<CodexModelCatalogEntry | null>(
			this.fetchFromAnyAccount(pin),
			null,
		);
		if (!fetched) {
			this.retryAfter.delete(key);
			this.retryAfter.set(
				key,
				this.deps.now() + CODEX_MODEL_CATALOG_RETRY_AFTER_MS,
			);
			// Bounded like `slots`. A marker is only removed when its own scope is
			// asked for again, so an outage touching many scopes once would
			// otherwise leave a marker per scope for the life of the process —
			// past the bound this class claims to hold.
			this.evictOverflowFrom(this.retryAfter);
		}
		if (fetched) {
			// Delete before set so insertion order tracks write recency: Map keeps a
			// re-`set` key in its original position, which would make eviction drop
			// the entry written longest ago rather than the least recently
			// refreshed.
			this.slots.delete(key);
			this.slots.set(key, { entry: fetched, fetchedAt: this.deps.now() });
			this.evictOverflow();
			return fetched;
		}

		// Expired but present beats nothing: an hours-old catalog still describes
		// the models correctly, whereas the static fallback is a shape Codex
		// cannot parse at all. The failure itself is NOT cached, so the next
		// caller retries rather than inheriting this verdict for a whole TTL.
		const stale = this.slots.get(key);
		if (stale) {
			log.warn(
				"Could not refresh the Codex model catalog; keeping the previous copy",
			);
			return stale.entry;
		}
		return null;
	}

	/**
	 * Resolve `work`, or `null` once the lookup budget expires — whichever comes
	 * first.
	 *
	 * A losing `work` is abandoned, not cancelled: `getValidAccessToken` exposes
	 * no signal, so the only thing we control is how long anyone waits on it.
	 * That is the point. The in-flight entry settles on the deadline and clears,
	 * so a dependency that never settles costs one slow lookup rather than
	 * wedging the scope forever. An abandoned attempt that later succeeds is
	 * simply discarded; it can never write to the cache, because the write
	 * happens here, downstream of the race.
	 */
	private async withDeadline<T>(work: Promise<T>, fallback: T): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<T>((resolve) => {
			timer = setTimeout(() => {
				log.warn(
					"Model-catalog lookup exceeded its budget; falling back for now",
				);
				resolve(fallback);
			}, this.deps.lookupBudgetMs);
			// Never hold the process open for a catalog read.
			(timer as { unref?: () => void }).unref?.();
		});

		// Neutralise the rejection here rather than relying on the race: once the
		// deadline wins, nothing is awaiting `work`, and a late rejection would
		// surface as an unhandled one with no caller left to blame.
		const settled = work.catch((error: unknown) => {
			log.warn(
				"Model-catalog lookup rejected:",
				error instanceof Error ? error.message : String(error),
			);
			return fallback;
		});

		try {
			return await Promise.race([settled, deadline]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	/**
	 * Hold at most {@link CODEX_MODEL_CATALOG_MAX_ENTRIES}, dropping the least
	 * recently written first. Relies on Map iterating in insertion order, which
	 * `refresh` keeps aligned with write recency by deleting before setting.
	 */
	private evictOverflow(): void {
		const evicted = this.evictOverflowFrom(this.slots);
		// A scope with no cached catalog has no reason to keep a failure marker.
		for (const key of evicted) this.retryAfter.delete(key);
	}

	/** Trim `map` to the entry bound, returning the keys dropped. */
	private evictOverflowFrom(map: Map<string, unknown>): string[] {
		const evicted: string[] = [];
		while (map.size > CODEX_MODEL_CATALOG_MAX_ENTRIES) {
			const oldest = map.keys().next();
			if (oldest.done) break;
			map.delete(oldest.value);
			evicted.push(oldest.value);
		}
		return evicted;
	}

	private async fetchFromAnyAccount(
		pin: RoutingPin | null,
	): Promise<CodexModelCatalogEntry | null> {
		let accounts: readonly Account[];
		try {
			accounts = await this.deps.listAccounts();
		} catch (error) {
			log.warn(
				"Could not list accounts for a model-catalog read:",
				error instanceof Error ? error.message : String(error),
			);
			return null;
		}

		const candidates = accounts
			.filter(
				(account) =>
					account.provider === "codex" &&
					!account.paused &&
					isAccountAllowedByPin(pin, account),
			)
			// Sorted, not database order. When a scope admits several accounts the
			// catalog we serve is one of theirs, and which one must not depend on
			// row order or on who answered first — otherwise the models Codex is
			// shown can change with no configuration change behind it.
			.sort((a, b) => a.id.localeCompare(b.id));
		if (candidates.length === 0) return null;

		if (candidates.length > 1) {
			// Entitlement is per-subscription, so in a multi-account scope the
			// catalog describes ONE account while inference may load-balance to
			// another. A model listed here but missing there fails upstream and
			// falls over to the next account, so this costs an attempt rather than
			// a request — but it is worth being able to find in a log.
			log.debug(
				`Model-catalog scope admits ${candidates.length} accounts; serving '${candidates[0].name}'`,
			);
		}

		// Two bounds, because they stop different things. This one keeps a loop of
		// attempts that each RETURN from consuming the budget several times over;
		// the race in withDeadline is the backstop for a single attempt that never
		// returns at all, which no amount of checking between attempts can catch.
		const deadline = this.deps.now() + this.deps.lookupBudgetMs;

		for (const account of candidates) {
			if (this.deps.now() >= deadline) {
				log.warn(
					"Model-catalog lookup ran out of budget before every account was tried",
				);
				break;
			}

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

			// Re-checked AFTER the token, not just before it. Token acquisition is
			// the unbounded step: `getValidAccessToken` may join an OAuth refresh
			// that hangs, and every attempt abandoned at the deadline is still
			// parked on it. Without this, one refresh finally completing would
			// release all of them into `fetchCatalog` at once — a burst of
			// bearer-authenticated reads whose results are all discarded anyway.
			if (this.deps.now() >= deadline) {
				log.warn(
					"Model-catalog budget expired while acquiring a token; dropping the attempt",
				);
				break;
			}

			// The real fetcher is fail-clean and returns `ok: false` rather than
			// throwing, but this class promises its caller a value or null and must
			// not depend on that to keep the promise.
			try {
				const result = await this.deps.fetchCatalog({
					accessToken,
					chatgptAccountId: readChatgptAccountIdSafe(accessToken),
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
