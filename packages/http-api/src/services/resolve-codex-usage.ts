import type { DatabaseOperations } from "@clankermux/database";
import { Logger } from "@clankermux/logger";
import {
	type CodexCreditsInfo,
	parseCodexCreditsHeaders,
	parseCodexUsageHeaders,
	type UsageData,
	usageCache,
} from "@clankermux/providers";
import type { FullUsageData } from "@clankermux/types";

const log = new Logger("CodexUsageResolver");

/**
 * The whole "where does this Codex account's usage come from" question, in one
 * place: the live usage cache, the persisted `accounts.codex_usage_json`
 * column, and the legacy scan over stored request payloads.
 *
 * Extracted from the accounts handler so `/api/accounts` and `/api/runway`
 * cannot drift on the resolution ORDER, the normalization, or which sources the
 * proxy can actually see. `/api/runway` shipped reading only the in-memory
 * usage cache, so every Codex account went blank after a restart while the
 * accounts page beside it served the persisted snapshot — the drift this file
 * exists to make impossible.
 */
export function normalizeCodexUsageData(usage: UsageData): UsageData | null {
	const now = Date.now();
	const normalized: UsageData = {
		five_hour: usage.five_hour ? { ...usage.five_hour } : null,
		seven_day: { ...usage.seven_day },
	};
	// Codex retired its 5h window. A rolled/expired Codex 5h window is absent, not
	// a 0% card, so collapse a stale reset to `null` (hidden) rather than a
	// fabricated `{0, null}` placeholder. `normalizeCodexUsageData` only ever runs
	// for codex accounts, so `null` here is always correct.
	if (
		normalized.five_hour?.resets_at &&
		new Date(normalized.five_hour.resets_at).getTime() <= now
	) {
		normalized.five_hour = null;
	}
	if (
		normalized.seven_day.resets_at &&
		new Date(normalized.seven_day.resets_at).getTime() <= now
	) {
		normalized.seven_day = { utilization: 0, resets_at: null };
	}
	// Preserve the synthetic per-model `limits[]` (Codex scoped weekly windows),
	// dropping any entry whose reset has already passed — parity with the flat
	// window zeroing above. A stale-reset entry is a spent window, not a live one.
	if (usage.limits) {
		normalized.limits = usage.limits.filter((entry) => {
			if (!entry.resets_at) return true;
			const resetMs = new Date(entry.resets_at).getTime();
			return !Number.isFinite(resetMs) || resetMs > now;
		});
	}
	// Keep the payload alive when any per-model scoped weekly limit survived the
	// filter above, even if both flat windows have gone stale. Codex no longer
	// reports a 5-hour window (`five_hour.resets_at` is always null), so gating
	// solely on the flat windows would discard a still-live Spark scoped card the
	// moment the account-wide weekly reset lapses in a stale cache snapshot.
	const hasLiveLimits = (normalized.limits?.length ?? 0) > 0;
	return (normalized.five_hour?.resets_at ?? null) !== null ||
		normalized.seven_day.resets_at !== null ||
		hasLiveLimits
		? normalized
		: null;
}

/**
 * The newest usable Codex usage reconstructed from stored request payloads,
 * together with the timestamp of the response it came from. This is the LEGACY
 * recovery channel: the headers belong to whatever request happened to be
 * retained, so the reading can be arbitrarily old relative to the account's
 * current window. Returns null when no retained payload yields usable windows.
 *
 * Deliberately does NOT touch the usage cache — the caller decides whether this
 * candidate actually wins before re-seeding anything.
 */
async function scanCodexUsageFromPayloads(
	db: ReturnType<DatabaseOperations["getAdapter"]>,
	accountId: string,
	accountName: string,
): Promise<{ data: UsageData; timestampMs: number } | null> {
	const rows = await db.query<{ json: string; timestamp: number | null }>(
		`SELECT rp.json, COALESCE(rp.timestamp, r.timestamp) as timestamp
		 FROM request_payloads rp
		 JOIN requests r ON rp.id = r.id
		 WHERE r.account_used = ?
		 ORDER BY r.timestamp DESC
		 LIMIT 20`,
		[accountId],
	);

	for (const row of rows) {
		if (!row.json || !row.timestamp) continue;

		try {
			const payload = JSON.parse(row.json) as {
				response?: { headers?: Record<string, string>; status?: number };
				meta?: { timestamp?: number };
			};
			const headerEntries = Object.entries(payload.response?.headers ?? {});
			if (headerEntries.length === 0) continue;

			const codexStatus = payload.response?.status;
			const payloadTimestamp = payload.meta?.timestamp ?? row.timestamp;
			const usage = parseCodexUsageHeaders(new Headers(headerEntries), {
				baseTimeMs: payloadTimestamp,
				allowRelativeResetAfter: true,
				defaultUtilization: codexStatus === 429 ? 100 : 0,
			});
			if (!usage) continue;

			const normalizedUsage = normalizeCodexUsageData(usage);
			if (!normalizedUsage) continue;

			// Recover credits state from the same stored headers so the chip
			// survives a server restart / cache eviction.
			const credits = parseCodexCreditsHeaders(new Headers(headerEntries));
			if (credits) normalizedUsage.codexCredits = credits;

			return { data: normalizedUsage, timestampMs: payloadTimestamp };
		} catch (error) {
			log.warn(
				`Failed to recover Codex usage from stored payload for ${accountName}:`,
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	return null;
}

/**
 * The persisted `accounts.codex_usage_json` snapshot, split into the part that
 * expires and the part that does not.
 *
 * `data` is the snapshot normalized for display — null when the column is empty,
 * unparseable, or contains nothing still live. `codexCredits` is the credits
 * state the same JSON carries, and it is retained EVEN WHEN `data` is null: an
 * account being on credits is not a window that lapses when its reset passes, so
 * dropping it with the spent windows would blank the credits chip for every idle
 * account after a restart.
 */
function readPersistedCodexUsageColumn(
	persistedJson: string | null,
	accountName: string,
): { data: FullUsageData | null; codexCredits: CodexCreditsInfo | null } {
	if (!persistedJson) return { data: null, codexCredits: null };
	try {
		const parsed = JSON.parse(persistedJson) as UsageData;
		const credits = parsed.codexCredits ?? null;
		const normalized = normalizeCodexUsageData(parsed);
		if (!normalized) return { data: null, codexCredits: credits };
		// normalizeCodexUsageData only carries the windows; reattach the credits
		// state the same way the live-cache branch does.
		if (credits) normalized.codexCredits = credits;
		return { data: normalized as FullUsageData, codexCredits: credits };
	} catch (error) {
		log.warn(
			`Failed to parse the persisted Codex usage snapshot for ${accountName}:`,
			error instanceof Error ? error.message : String(error),
		);
		return { data: null, codexCredits: null };
	}
}

/**
 * Whether a resolution is allowed to WRITE.
 *
 * The stored-payload tier re-seeds the live usage cache so the PROXY can see
 * the reading it reconstructed. That write is a mutation of the state routing,
 * throttling and capacity decisions read, and it must never be performed on
 * behalf of a caller that is only reading — an unauthenticated
 * `GET /public/v1/runway` after a restart would otherwise change the pool's
 * routing inputs for the next ten minutes.
 *
 * Required rather than defaulted, so a new call site has to decide which it is
 * rather than inheriting a write it did not ask for. The resolution itself is
 * identical either way: the same tier wins, under the same `source`, with the
 * same stamp.
 */
export interface CodexUsageResolutionPolicy {
	/**
	 * `true` only for a request path that is entitled to refresh what the proxy
	 * can see (`/api/accounts`, which is the surface that has always owned this
	 * recovery). `false` for every read-only projection.
	 */
	seedCache: boolean;
}

/**
 * Resolve a Codex account's usage, reporting WHERE it came from and (for the
 * persisted column) WHEN it was observed.
 *
 * Three channels, newest wins, each reported under its own `source` so callers
 * can tell them apart:
 *   1. `"cache"` — the live usage cache, the only source the response may label
 *      with the cache entry's own OBSERVATION time (`peekWithAge().observedAtMs`,
 *      never its write time — an entry seeded by tier 3 below carries a write
 *      time and no observation time at all);
 *   2. `"column"` — `accounts.codex_usage_json`, written by every Codex
 *      observation and stamped with `codex_usage_observed_at`;
 *   3. `"payload"` — the legacy scan over stored request payloads, whose headers
 *      may predate the account's current window by hours.
 *
 * The distinction matters beyond labelling: only `"cache"` and `"payload"` are
 * reflected in the live usage cache (the payload scan re-seeds it, when the
 * caller's {@link CodexUsageResolutionPolicy} permits a write), so only they
 * describe a reading the PROXY can also see. A `"column"` reading is
 * display-only.
 *
 * The column is compared against `last_used` because that is the only cheap
 * upper bound on how new a payload candidate could possibly be: when the column
 * is at least as new as the account's last request, no payload can beat it and
 * the scan is skipped entirely. A winning column candidate is deliberately NOT
 * written back into the usage cache — re-seeding would relabel aged data as a
 * fresh live reading, which is the exact defect this resolution order fixes.
 *
 * `policy` decides whether this resolution may WRITE — see
 * {@link CodexUsageResolutionPolicy}. It changes nothing about WHICH reading is
 * returned or how it is labelled; only the cache re-seed disappears.
 */
export async function getCachedOrPersistedCodexUsage(
	db: ReturnType<DatabaseOperations["getAdapter"]>,
	accountId: string,
	accountName: string,
	cacheData: FullUsageData | null,
	persistedJson: string | null,
	persistedObservedAt: number | null,
	lastUsed: number | null,
	policy: CodexUsageResolutionPolicy,
): Promise<{
	data: FullUsageData | null;
	source: "cache" | "column" | "payload" | null;
	observedAtMs: number | null;
	persistedCredits: CodexCreditsInfo | null;
}> {
	// Read the column FIRST, whichever source ends up winning: its credits state
	// is reported unconditionally so a caller can fall back to it when the served
	// reading carries none.
	const column = readPersistedCodexUsageColumn(persistedJson, accountName);
	const persistedCredits = column.codexCredits;

	if (cacheData) {
		const normalizedCache = normalizeCodexUsageData(cacheData as UsageData);
		if (normalizedCache) {
			// Preserve live credits state through normalization (which only
			// carries the 5h/7d windows).
			const cacheCredits = (cacheData as UsageData).codexCredits;
			if (cacheCredits) normalizedCache.codexCredits = cacheCredits;
			return {
				data: normalizedCache as FullUsageData,
				source: "cache",
				observedAtMs: null,
				persistedCredits,
			};
		}
	}

	const columnData = column.data;
	const columnObservedAt = columnData ? persistedObservedAt : null;
	const serveColumn = () => {
		log.debug(`Served the persisted Codex usage snapshot for ${accountName}`);
		return {
			data: columnData,
			source: "column" as const,
			observedAtMs: columnObservedAt,
			persistedCredits,
		};
	};

	if (
		columnData &&
		(lastUsed == null ||
			(columnObservedAt != null && columnObservedAt >= lastUsed))
	) {
		// Nothing the payload scan could find is newer — skip it.
		return serveColumn();
	}

	const payloadCandidate = await scanCodexUsageFromPayloads(
		db,
		accountId,
		accountName,
	);

	if (
		columnData &&
		(!payloadCandidate ||
			payloadCandidate.timestampMs <=
				(columnObservedAt ?? Number.NEGATIVE_INFINITY))
	) {
		return serveColumn();
	}

	if (payloadCandidate) {
		// Re-seeded so the PROXY can see the reading (that is what the payload
		// channel is for), but seeded UNTIMED: the headers come from whatever
		// request payload was retained and can predate this write by hours. A plain
		// `set()` would stamp the entry with the recovery instant, and the very next
		// refresh would classify it as a live cache reading with a confident
		// observation time — the same reading gaining full confidence between two
		// refetches with no new provider evidence behind it.
		//
		// Gated on the caller's policy: this is the only write in the whole
		// resolution, and a read-only projection must not perform it. The reading
		// itself is returned either way.
		if (policy.seedCache) {
			usageCache.setUntimed(accountId, payloadCandidate.data);
		}
		log.debug(`Recovered Codex usage from stored payload for ${accountName}`);
		return {
			data: payloadCandidate.data as FullUsageData,
			source: "payload",
			observedAtMs: null,
			persistedCredits,
		};
	}

	return { data: null, source: null, observedAtMs: null, persistedCredits };
}

/** The persisted Codex usage pair carried on an account row. */
export interface PersistedCodexUsageColumns {
	persistedJson: string | null;
	persistedObservedAtMs: number | null;
}

/**
 * The `codex_usage_json` / `codex_usage_observed_at` pair for a set of accounts.
 *
 * `getAllAccounts()` deliberately does NOT select these columns:
 * `codex_usage_json` is an unbounded TEXT blob and that query runs on hot paths
 * (`/health` among them), so widening it would make every caller pay for a
 * snapshot only Codex display code reads. Callers holding `Account` rows from
 * there load the pair here instead, for codex account ids only.
 *
 * Returns an empty map for an empty id list without touching the database, and
 * on a read failure — the persisted snapshot is itself a fallback, and failing
 * to read a fallback must not fail the response that asked for it.
 */
export async function loadPersistedCodexUsageColumns(
	db: ReturnType<DatabaseOperations["getAdapter"]>,
	accountIds: readonly string[],
): Promise<Map<string, PersistedCodexUsageColumns>> {
	const result = new Map<string, PersistedCodexUsageColumns>();
	if (accountIds.length === 0) return result;

	try {
		const rows = await db.query<{
			id: string;
			codex_usage_json: string | null;
			codex_usage_observed_at: number | null;
		}>(
			`SELECT id, codex_usage_json, codex_usage_observed_at
			 FROM accounts
			 WHERE id IN (${accountIds.map(() => "?").join(", ")})`,
			[...accountIds],
		);
		for (const row of rows) {
			result.set(row.id, {
				persistedJson: row.codex_usage_json ?? null,
				persistedObservedAtMs:
					row.codex_usage_observed_at != null
						? Number(row.codex_usage_observed_at)
						: null,
			});
		}
	} catch (error) {
		log.warn(
			"Failed to load the persisted Codex usage columns:",
			error instanceof Error ? error.message : String(error),
		);
	}

	return result;
}
