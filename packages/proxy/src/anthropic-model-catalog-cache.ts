import { CLAUDE_MODEL_IDS, MODEL_DISPLAY_NAMES } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import type { Account } from "@clankermux/types";

const log = new Logger("AnthropicModelCatalogCache");

/**
 * Anthropic's own model listing.
 *
 * Metadata only — id, display name, creation date — and free: it starts no
 * quota window and consumes no tokens. It is the ONE sanctioned automated call
 * to `api.anthropic.com` this proxy makes; inference on a Claude account still
 * only ever happens on behalf of a real client.
 *
 * The URL is a fixed constant and deliberately not parameterised by an
 * account's `custom_endpoint`: the call carries a pooled OAuth bearer, and
 * sending that to an operator-configured host would hand the credential to
 * whatever it names.
 */
export const ANTHROPIC_MODEL_CATALOG_URL =
	"https://api.anthropic.com/v1/models";

/**
 * How long a fetched catalogue is served before a refresh is attempted.
 *
 * Anthropic ships or retires a model on a scale of weeks, so an hour is already
 * far tighter than the data moves. Staleness costs nothing: a model missing
 * from this list is still routable — the proxy forwards model names verbatim —
 * so the list is a discovery aid, not an allowlist.
 */
export const ANTHROPIC_MODEL_CATALOG_TTL_MS = 60 * 60 * 1_000;

/**
 * How long to wait before another upstream attempt after a failed one.
 *
 * Without it a failed refresh leaves the entry expired, so every subsequent
 * request starts its own attempt: one unreachable endpoint becomes a stream of
 * bearer-authenticated calls to Anthropic, which is exactly the traffic shape
 * this must not generate.
 */
export const ANTHROPIC_MODEL_CATALOG_RETRY_AFTER_MS = 5 * 60 * 1_000;

/**
 * Whole-lookup budget for a COLD read, across every account tried.
 *
 * Enforced as a RACE, not as a check between attempts, because the unbounded
 * step is token acquisition: `getValidAccessToken` may join an OAuth refresh
 * that has no deadline of its own and accepts no abort signal. A hang there
 * would otherwise never settle the in-flight entry and would wedge the cache
 * permanently, with every later caller awaiting a promise that cannot resolve.
 * The AbortController below bounds the HTTP call only; it cannot bound this.
 */
export const ANTHROPIC_MODEL_CATALOG_LOOKUP_BUDGET_MS = 8_000;

/**
 * Per-request timeout for the catalogue HTTP call itself.
 *
 * Shorter than the whole-lookup budget so a single slow account still leaves
 * room to try the next one. A dashboard render or a Claude Code startup is
 * waiting on this; on timeout the caller serves the bundled list instead.
 */
const REQUEST_TIMEOUT_MS = 4_000;

/**
 * Creation date stamped on the bundled fallback entries.
 *
 * A fixed value, not `now`: the bundled list is a static artifact of this
 * build, and a moving timestamp would make every poll look like a new model.
 */
export const ANTHROPIC_BUNDLED_MODEL_CREATED_AT = "2025-01-01T00:00:00Z";

/** One model as this cache reports it, upstream shape already normalised. */
export interface AnthropicCatalogModel {
	id: string;
	displayName: string;
	/** ISO-8601, as Anthropic sends it. */
	createdAt: string;
}

export interface AnthropicModelCatalogSnapshot {
	models: readonly AnthropicCatalogModel[];
	/** Where the list came from — surfaced to the operator, never guessed at. */
	source: "upstream" | "bundled";
	/** Epoch ms of the successful fetch backing `models`, or null when bundled. */
	fetchedAt: number | null;
}

export interface AnthropicModelCatalogCacheDeps {
	/** Every account in the pool; narrowing to usable candidates is ours. */
	listAccounts: () => Promise<readonly Account[]>;
	/**
	 * The same token path inference uses. Never a raw database read: a stored
	 * token may be expired, and refreshing it is this function's job.
	 */
	getAccessToken: (account: Account) => Promise<string>;
	fetchImpl?: typeof fetch;
	now?: () => number;
	/** Overridable so tests can exercise the deadline without waiting for it. */
	lookupBudgetMs?: number;
}

interface CacheSlot {
	models: readonly AnthropicCatalogModel[];
	fetchedAt: number;
}

/** The bundled list, built once: the registry this build ships with. */
function bundledModels(): AnthropicCatalogModel[] {
	return Object.values(CLAUDE_MODEL_IDS).map((id) => ({
		id,
		displayName: MODEL_DISPLAY_NAMES[id] ?? id,
		createdAt: ANTHROPIC_BUNDLED_MODEL_CREATED_AT,
	}));
}

/**
 * Serves Anthropic's model listing on behalf of the pool.
 *
 * ONE cache entry, unlike the Codex catalogue's per-pin scopes. Anthropic's
 * listing is not entitlement-scoped the way a ChatGPT subscription's catalogue
 * is — every OAuth account is shown the same models — so keying it per API-key
 * pin would multiply identical fetches for no difference in the answer.
 *
 * Everything here is best-effort. A failure means we could not LEARN the
 * catalogue, never that an account is unhealthy, so nothing here is counted
 * against an account and the caller always gets a list: the bundled registry is
 * the floor.
 */
export class AnthropicModelCatalogCache {
	private readonly deps: Required<AnthropicModelCatalogCacheDeps>;
	private slot: CacheSlot | null = null;
	/** Set while a refresh runs, so concurrent callers share one upstream call. */
	private inFlight: Promise<readonly AnthropicCatalogModel[] | null> | null =
		null;
	/** Epoch ms before which no further upstream attempt is made. */
	private retryAfter: number | null = null;

	constructor(deps: AnthropicModelCatalogCacheDeps) {
		this.deps = {
			fetchImpl: fetch,
			now: Date.now,
			lookupBudgetMs: ANTHROPIC_MODEL_CATALOG_LOOKUP_BUDGET_MS,
			...deps,
		};
	}

	/**
	 * The catalogue, always. Never throws and never rejects.
	 *
	 * A cached-but-expired copy is returned IMMEDIATELY and refreshed in the
	 * background: blocking a client on a refresh would hand it the full lookup
	 * budget of latency to receive a list we already had.
	 */
	async get(): Promise<AnthropicModelCatalogSnapshot> {
		const slot = this.slot;
		if (slot) {
			const age = this.deps.now() - slot.fetchedAt;
			if (age >= ANTHROPIC_MODEL_CATALOG_TTL_MS && !this.inBackoff()) {
				// Stale-while-revalidate. Deliberately not awaited; its rejection
				// cannot escape because refresh() resolves rather than throws.
				void this.startRefresh();
			}
			return {
				models: slot.models,
				source: "upstream",
				fetchedAt: slot.fetchedAt,
			};
		}

		// Cold and recently failed: answer now rather than spending the budget
		// again. The caller's fallback is the bundled list.
		if (this.inBackoff()) return this.bundled();

		const fetched = await this.startRefresh();
		if (!fetched) return this.bundled();
		return {
			models: fetched,
			source: "upstream",
			fetchedAt: this.slot?.fetchedAt ?? null,
		};
	}

	private bundled(): AnthropicModelCatalogSnapshot {
		return { models: bundledModels(), source: "bundled", fetchedAt: null };
	}

	private inBackoff(): boolean {
		if (this.retryAfter === null) return false;
		if (this.deps.now() >= this.retryAfter) {
			this.retryAfter = null;
			return false;
		}
		return true;
	}

	/** Join the in-flight refresh, or start one. */
	private startRefresh(): Promise<readonly AnthropicCatalogModel[] | null> {
		if (this.inFlight) return this.inFlight;
		const refresh = this.refresh().finally(() => {
			this.inFlight = null;
		});
		this.inFlight = refresh;
		return refresh;
	}

	private async refresh(): Promise<readonly AnthropicCatalogModel[] | null> {
		const fetched = await this.withDeadline(this.fetchFromAnyAccount(), null);
		if (fetched) {
			this.slot = { models: fetched, fetchedAt: this.deps.now() };
			this.retryAfter = null;
			return fetched;
		}

		this.retryAfter = this.deps.now() + ANTHROPIC_MODEL_CATALOG_RETRY_AFTER_MS;

		// Expired but present beats the bundled list: an hours-old upstream
		// catalogue still describes the models correctly, including any this build
		// has never heard of. The failure itself is not cached beyond the backoff.
		if (this.slot) {
			log.warn(
				"Could not refresh the Anthropic model catalogue; keeping the previous copy",
			);
			return this.slot.models;
		}
		return null;
	}

	/**
	 * Resolve `work`, or `fallback` once the lookup budget expires — whichever
	 * comes first.
	 *
	 * A losing `work` is abandoned, not cancelled: `getAccessToken` exposes no
	 * signal, so the only thing we control is how long anyone waits on it. The
	 * in-flight entry settles on the deadline and clears, so a dependency that
	 * never settles costs one slow lookup rather than wedging the cache forever.
	 * An abandoned attempt that later succeeds is discarded; it can never write
	 * to the cache, because the write happens downstream of this race.
	 */
	private async withDeadline<T>(work: Promise<T>, fallback: T): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<T>((resolve) => {
			timer = setTimeout(() => {
				log.warn(
					"Anthropic model-catalogue lookup exceeded its budget; falling back for now",
				);
				resolve(fallback);
			}, this.deps.lookupBudgetMs);
			// Never hold the process open for a catalogue read.
			(timer as { unref?: () => void }).unref?.();
		});

		// Neutralise the rejection here rather than relying on the race: once the
		// deadline wins, nothing is awaiting `work`, and a late rejection would
		// surface as an unhandled one with no caller left to blame.
		const settled = work.catch((error: unknown) => {
			log.warn(
				"Anthropic model-catalogue lookup rejected:",
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

	private async fetchFromAnyAccount(): Promise<
		readonly AnthropicCatalogModel[] | null
	> {
		let accounts: readonly Account[];
		try {
			accounts = await this.deps.listAccounts();
		} catch (error) {
			log.warn(
				"Could not list accounts for an Anthropic model-catalogue read:",
				error instanceof Error ? error.message : String(error),
			);
			return null;
		}

		const candidates = accounts
			.filter((account) => account.provider === "anthropic" && !account.paused)
			// Sorted, not database order: the answer must not depend on row order or
			// on who happened to answer first.
			.sort((a, b) => a.id.localeCompare(b.id));
		if (candidates.length === 0) return null;

		// Two bounds, because they stop different things. This one keeps a loop of
		// attempts that each RETURN from consuming the budget several times over;
		// the race in withDeadline is the backstop for a single attempt that never
		// returns at all, which no amount of checking between attempts can catch.
		const deadline = this.deps.now() + this.deps.lookupBudgetMs;

		for (const account of candidates) {
			if (this.deps.now() >= deadline) {
				log.warn(
					"Anthropic model-catalogue lookup ran out of budget before every account was tried",
				);
				break;
			}

			let accessToken: string;
			try {
				accessToken = await this.deps.getAccessToken(account);
			} catch (error) {
				// A paused-for-reauth account cannot produce a token; that is an
				// account problem the reauth flow owns, not a catalogue problem.
				log.debug(
					`No usable token for '${account.name}' while reading the model catalogue:`,
					error instanceof Error ? error.message : String(error),
				);
				continue;
			}

			// Re-checked AFTER the token, not just before it. Token acquisition is
			// the unbounded step, and every attempt abandoned at the deadline is
			// still parked on it. Without this, one refresh finally completing would
			// release all of them into the fetch at once — a burst of
			// bearer-authenticated reads whose results are all discarded anyway.
			if (this.deps.now() >= deadline) {
				log.warn(
					"Anthropic model-catalogue budget expired while acquiring a token; dropping the attempt",
				);
				break;
			}

			const models = await this.fetchWith(accessToken, account.name);
			if (models) return models;
		}

		return null;
	}

	/** One authenticated read. Fail-clean: null on any non-answer. */
	private async fetchWith(
		accessToken: string,
		accountName: string,
	): Promise<readonly AnthropicCatalogModel[] | null> {
		const url = new URL(ANTHROPIC_MODEL_CATALOG_URL);
		// The endpoint pages at 20 by default; the whole list is short enough that
		// one page with a generous limit removes pagination from the picture.
		url.searchParams.set("limit", "1000");

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			const response = await this.deps.fetchImpl(url.toString(), {
				method: "GET",
				signal: controller.signal,
				// A cross-origin redirect would strip Authorization per the fetch
				// spec, but say so structurally rather than relying on that: this
				// bearer has exactly one valid destination.
				redirect: "error",
				headers: {
					authorization: `Bearer ${accessToken}`,
					"anthropic-version": "2023-06-01",
					"anthropic-beta": "oauth-2025-04-20",
					accept: "application/json",
				},
			});

			if (!response.ok) {
				log.warn(
					`Anthropic model catalogue returned ${response.status} for '${accountName}'`,
				);
				return null;
			}

			const models = parseCatalog(await response.text());
			if (!models) {
				log.warn(
					"Anthropic model catalogue returned a body with no usable models array; ignoring it",
				);
				return null;
			}
			return models;
		} catch (error) {
			log.warn(
				`Failed to read the Anthropic model catalogue via '${accountName}':`,
				error instanceof Error ? error.message : String(error),
			);
			return null;
		} finally {
			clearTimeout(timeoutId);
		}
	}
}

/**
 * Parse `{"data":[{"id":…,"display_name":…,"created_at":…}]}`.
 *
 * Returns null for anything that is not that shape, INCLUDING an empty list: a
 * catalogue with no models cannot be right, and caching it for an hour would
 * present an empty picker as though it were the answer. Treating it as a failed
 * fetch keeps the bundled list (or the previous copy) in play.
 *
 * Optional fields are normalised rather than rejected — a missing display name
 * costs a nicer label, not the entry.
 */
function parseCatalog(bodyText: string): AnthropicCatalogModel[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return null;
	}
	const data = (parsed as { data?: unknown }).data;
	if (!Array.isArray(data)) return null;

	const models: AnthropicCatalogModel[] = [];
	for (const entry of data) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			continue;
		}
		const row = entry as {
			id?: unknown;
			display_name?: unknown;
			created_at?: unknown;
		};
		if (typeof row.id !== "string" || row.id.length === 0) continue;
		models.push({
			id: row.id,
			displayName:
				typeof row.display_name === "string" && row.display_name.length > 0
					? row.display_name
					: row.id,
			createdAt:
				typeof row.created_at === "string" && row.created_at.length > 0
					? row.created_at
					: ANTHROPIC_BUNDLED_MODEL_CREATED_AT,
		});
	}

	return models.length > 0 ? models : null;
}
