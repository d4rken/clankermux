/**
 * Usage-snapshot sampler — a periodic job that records per-account rate-limit
 * utilization into the `usage_snapshots` time-series that backs the dashboard
 * "sawtooth" Limits graph.
 *
 * The sampler is a PURE READ-THROUGH observer: it only reads the shared
 * in-memory usage cache and never issues an upstream request, so it never
 * spends quota or starts a dormant window.
 *
 * Design notes:
 *  - Only `anthropic` and `codex` accounts have the windowed `UsageData`
 *    (five_hour / seven_day). All other providers are excluded.
 *  - The cache is kept warm WITHOUT the sampler's help, but the source differs by
 *    provider. For CODEX, real user traffic warms it: `updateAccountMetadata`
 *    writes `usageCache` through `applyCodexObservation` (Codex usage rides on
 *    `/responses` response headers). For ANTHROPIC, real inference traffic does
 *    NOT populate the windowed cache — the quota windows come only from the direct
 *    Anthropic 90s usage poller (`startUsagePollingWithRefresh`, GET /oauth/usage),
 *    now demand-aware (active cadence for recently-used accounts, ~10min idle).
 *    Both providers are additionally warmed by the auto-refresh scheduler's priming
 *    (gated per-account by `auto_refresh_enabled`) — anthropic/zai via the
 *    translated Claude prime, Codex via the CodexSpendCoordinator's native
 *    `/responses` ping (which writes `usageCache` through `applyCodexObservation`);
 *    a Codex manual "Refresh usage" instead reads the FREE `/wham/usage` GET.
 *    The sampler just reads whatever those have populated — for Codex too. Because
 *    it never probes, paused Codex accounts are treated no differently from any
 *    other: pause is irrelevant to reading, so a paused account with a fresh cache
 *    entry is still recorded.
 *  - Freshness is honest: if the cache for an account is missing, older than
 *    `freshnessMs`, or carries no observation time at all, no row is written
 *    (gaps are real, never carried forward, and never invented).
 *    This is the WRITE path — the DB stores only what was actually observed.
 *    The READ path (the usage-history handler) is where a paused/maxed account's
 *    last value is carried forward across those gaps until its recorded window
 *    reset, so the pool-average chart line doesn't falsely drop when the highest
 *    account stops reporting. Gap-vs-carry is the write/read boundary: see
 *    `packages/http-api/src/handlers/usage-history.ts`.
 *  - The SAME tick also records the per-model-family weekly windows into
 *    `usage_scoped_snapshots` (capture only — nothing reads them yet). They come
 *    from the same normalized reading under the same freshness gate; history for
 *    that axis cannot be backfilled, so recording starts before there is a
 *    consumer.
 */

import {
	computeUsagePrediction,
	intervalManager,
	normalizeAnthropicUsage,
} from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import type { AnyUsageData, UsageData } from "@clankermux/providers";
import {
	observeUsageReading,
	pruneWeeklyBurnSlopes,
	recordWeeklyBurnSlope,
} from "@clankermux/proxy";
import type {
	Account,
	AnthropicUsageData,
	PredictionPoint,
	ScopedUsageSnapshotRow,
	UsageSnapshotRow,
	UsageSnapshotSample,
} from "@clankermux/types";

const log = new Logger("UsageSnapshotSampler");

/** Sample cadence (2 minutes). */
export const SAMPLE_INTERVAL_MS = 120_000;

/**
 * How far back the weekly burn-slope fit reads persisted snapshots. Matches the
 * dashboard prediction service's 7d lookback: recent pace, not the whole window.
 */
export const BURN_SLOPE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * How far back the boot-time revision-anchor seed replays persisted snapshots.
 * The full weekly span, NOT the burn-slope fit's 24h: a gift reset from three
 * days ago is still the correct burn origin for the current weekly window, and
 * a shorter replay would silently forget it on every restart.
 */
export const ANCHOR_SEED_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Minimal cache surface the pure projection needs (matches `usageCache`). The
 * sampler is a pure observer, so it uses the NON-evicting read: leaving stale
 * entries in place keeps its sampling side-effect-free (no impact on routing or
 * window-reset comparisons that read the raw cache).
 *
 * One ATOMIC read, deliberately: data, age and observation provenance must all
 * describe the SAME cache entry. Composing `peek()` + `peekAge()` took two
 * reads, so a write landing between them let the sampler pair one entry's data
 * with another entry's age — and provenance was not readable at all that way.
 */
export interface SamplerCache {
	peekWithAge(accountId: string): {
		data: AnyUsageData;
		ageMs: number;
		/**
		 * When the reading was OBSERVED at the provider, or null when the cache's
		 * writer could not honestly say (a reconstruction — e.g. Codex usage
		 * recovered from a retained payload, written via `usageCache.setUntimed`).
		 */
		observedAtMs: number | null;
	} | null;
}

/** The slice of an account the sampler reasons about. */
interface SamplerAccount {
	id: string;
	provider: string;
	/** Plan tier as of now (e.g. "pro", "max"); undefined/null when uncaptured. */
	identity_plan_tier?: string | null;
	/** Rate-limit tier as of now (e.g. "20x"); undefined/null when uncaptured. */
	identity_rate_limit_tier?: string | null;
}

/**
 * PURE projection: turn the current cache contents into write-ready snapshot
 * rows for one tick. All rows share the single `now` timestamp.
 *
 * Per account:
 *  - skip non-(anthropic|codex) providers entirely;
 *  - skip when the cache entry is absent or older than `freshnessMs` (no
 *    carry-forward);
 *  - skip when the entry carries NO observation time (see `buildSamplerRows`);
 *  - pull the session (5h) / account-wide weekly (7d) utilization + reset via
 *    `normalizeAnthropicUsage`, so a `limits[]`-only payload (upstream is
 *    dropping the flat five_hour/seven_day keys) still yields a row — otherwise
 *    the sawtooth graph and stale-usage recovery go blank for those accounts;
 *  - skip when BOTH windows are absent/null (nothing meaningful to record);
 *  - stamp the cache entry's own observation clock and the account's tiers as
 *    of this sample, so a later reader is not left inferring either from
 *    today's values.
 */
export function buildSnapshotRows(
	accounts: ReadonlyArray<SamplerAccount>,
	cache: SamplerCache,
	now: number,
	freshnessMs: number,
): UsageSnapshotRow[] {
	return buildSamplerRows(accounts, cache, now, freshnessMs).rows;
}

/** Both write-ready row sets produced by one sampler tick. */
export interface SamplerRows {
	/** Account-wide 5h/7d rows for `usage_snapshots`. */
	rows: UsageSnapshotRow[];
	/** Per-model-family weekly rows for `usage_scoped_snapshots`. */
	scopedRows: ScopedUsageSnapshotRow[];
}

/**
 * PURE projection producing BOTH snapshot series for one tick from one pass over
 * the cache — the account-wide 5h/7d windows and the per-model-family weekly
 * windows. Same `now`, same freshness gate, same no-carry-forward rule for both.
 *
 * The two series are gated independently once an account clears freshness: a
 * provider can report scoped windows with no account-wide utilization (and vice
 * versa), and dropping one because the other is absent would fabricate a gap in
 * a series that had evidence.
 *
 * UNKNOWN OBSERVATION TIME IS A GAP, for BOTH series. A cache entry whose
 * `observedAtMs` is null (today: Codex usage rebuilt from a retained payload
 * after a restart, seeded via `usageCache.setUntimed`) says "this reading was
 * observed at a time we cannot state" — the headers behind it can predate the
 * cache write by hours. Placing such a reading on the tick clock would mint a
 * confident timestamp out of an admitted unknown, and the row is indistinguish-
 * able from an honestly-stamped one forever after: `usage_snapshots.observed_at`
 * is permanent history, and the quota-drift compute treats a null `observed_at`
 * as "use `sampled_at`", so writing null instead of skipping fabricates the very
 * same instant one indirection later. The scoped series is dropped with it for
 * the same reason: it carries only the tick clock, so recording it would file
 * per-family percentages under a time they were not observed at. Skipping is the
 * same answer the sampler already gives a stale cache — gaps are real.
 *
 * Scoped rows come from `normalizeAnthropicUsage(...).weeklyScoped`, which
 * already drops entries whose reset is in the past — a rolled-over window is
 * stale, not a zero. `displayName` is carried through because the routing family
 * alone cannot distinguish two generations of the same family, which is exactly
 * the axis a later quota analysis would need.
 */
export function buildSamplerRows(
	accounts: ReadonlyArray<SamplerAccount>,
	cache: SamplerCache,
	now: number,
	freshnessMs: number,
): SamplerRows {
	const rows: UsageSnapshotRow[] = [];
	const scopedRows: ScopedUsageSnapshotRow[] = [];

	for (const account of accounts) {
		const { id, provider } = account;
		if (provider !== "anthropic" && provider !== "codex") continue;

		// ONE read: data, age and provenance must describe the same entry.
		const entry = cache.peekWithAge(id);
		if (entry === null) continue; // missing → honest gap
		if (entry.ageMs > freshnessMs) continue; // stale → honest gap
		// No observation time → honest gap. Never substitute `now`/`sampledAt`.
		if (entry.observedAtMs === null) continue;

		const data = entry.data as UsageData;
		const observedAt = entry.observedAtMs;

		const normalized = normalizeAnthropicUsage(
			data as unknown as AnthropicUsageData,
			now,
		);
		const fiveHourPct = normalized.session?.utilization ?? null;
		const sevenDayPct = normalized.weeklyAll?.utilization ?? null;

		// If neither window contributes a utilization, there is nothing to plot.
		if (fiveHourPct !== null || sevenDayPct !== null) {
			rows.push({
				accountId: id,
				provider,
				sampledAt: now,
				fiveHourPct,
				fiveHourReset: normalized.session?.resetMs ?? null,
				sevenDayPct,
				sevenDayReset: normalized.weeklyAll?.resetMs ?? null,
				// The entry's OWN observation time, never the tick clock and never
				// reconstructed from an age: the cache is the only place that knows
				// when this reading was actually observed.
				observedAt,
				planTier: account.identity_plan_tier ?? null,
				rateLimitTier: account.identity_rate_limit_tier ?? null,
			});
		}

		for (const scoped of normalized.weeklyScoped) {
			scopedRows.push({
				accountId: id,
				sampledAt: now,
				family: scoped.family,
				displayName: scoped.displayName,
				pct: scoped.percent,
				resetAt: scoped.resetsAtMs,
			});
		}
	}

	return { rows, scopedRows };
}

/** The sample cadence shared by the usage and cache-keepalive samplers. */
export function resolveSampleIntervalMs(): number {
	return SAMPLE_INTERVAL_MS;
}

/** Dependencies the sampler needs from the host server. */
export interface UsageSnapshotSamplerDeps {
	/** Re-read the live account list each tick (add/remove aware). */
	getAccounts: () => Promise<Account[]>;
	/** Persist a batch of snapshot rows. */
	insertSnapshots: (rows: UsageSnapshotRow[]) => Promise<void>;
	/**
	 * Persist a batch of per-model-family weekly snapshot rows. Written from the
	 * same tick as `insertSnapshots`, under the same freshness gate, but with its
	 * own failure boundary: neither write may suppress the other.
	 */
	insertScopedSnapshots: (rows: ScopedUsageSnapshotRow[]) => Promise<void>;
	/**
	 * Read back the raw (un-bucketed) snapshots sampled at/after `sinceMs` for the
	 * given accounts — the history the weekly burn-slope fit regresses over.
	 */
	getRecentSnapshots: (
		accountIds: string[],
		sinceMs: number,
	) => Promise<UsageSnapshotSample[]>;
	/** The shared in-memory usage cache. */
	cache: SamplerCache;
	/** Resolve the freshness window in ms (`max(2*pollInterval, 150_000)`). */
	getFreshnessMs: () => number;
	/**
	 * Base poll interval (ms) used to compute the deferred first-sample delay
	 * (`accountCount * 5000 + pollIntervalMs`), so the first tick lands after
	 * the server's startup poll-stagger wave has had time to warm the cache.
	 */
	getPollIntervalMs: () => number;
}

/**
 * Periodic sampler. Each tick:
 *  1) stamps one shared `now`,
 *  2) reads the live account list,
 *  3) projects the cache → rows via `buildSnapshotRows` (pure read-through),
 *  4) writes any non-empty batch (DB errors are logged, never thrown),
 *  5) refits the weekly burn slopes from PERSISTED history (`refreshBurnSlopes`).
 *
 * Step 5 is deliberately independent of steps 1–4: it regresses over rows already
 * in the DB, so it runs on the no-fresh-rows and insert-failure paths too, and it
 * is additionally bootstrapped once at `start()` so a deploy restart does not
 * leave the routing gates blind for the whole startup deferral.
 *
 * Registered through `intervalManager` with `maxConcurrent: 1` so a slow tick
 * can never overlap the next.
 */
export class UsageSnapshotSampler {
	private readonly deps: UsageSnapshotSamplerDeps;
	private stopInterval: (() => void) | null = null;
	private startupTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly intervalId = "usage-snapshot-sampler";
	/**
	 * Per-account newest `sampledAt` that has already been fitted. Refitting
	 * unchanged history is both wasted work and a freshness lie (the fit would be
	 * re-recorded with the same, already-aging evidence), so an account whose
	 * newest sample has not advanced is skipped entirely.
	 *
	 * Pruned against the live roster on every `refreshBurnSlopes()` tick — see
	 * the comment there for why a delete-time hook cannot own this.
	 */
	private readonly lastFittedSampleAt = new Map<string, number>();

	constructor(deps: UsageSnapshotSamplerDeps) {
		this.deps = { ...deps };
	}

	/**
	 * Start the sampler. The first sample is DEFERRED until after the startup
	 * poll-stagger wave (accounts × 5s) plus one poll interval, so we don't
	 * record an empty pool before the cache is warm. After that, steady cadence.
	 */
	async start(): Promise<void> {
		const intervalMs = resolveSampleIntervalMs();

		// Seed the revision anchors BEFORE any live feed can run: the registry's
		// write-side ordering guard rejects readings older than the newest it has
		// seen, so a live tick landing first would permanently block the replay of
		// the current window's history — the exact revision the seed exists to
		// recover. Best-effort and non-throwing, like the burn-slope bootstrap.
		await this.seedRevisionAnchors();

		let accountCount = 0;
		try {
			accountCount = (await this.deps.getAccounts()).length;
		} catch (err) {
			log.warn(`Failed to count accounts for startup delay: ${err}`);
		}

		// Mirror the server's startup stagger (index * 5000) plus one poll
		// interval, so the cache is warm before the first sample.
		const initialDelayMs = accountCount * 5_000 + this.deps.getPollIntervalMs();

		log.info(
			`Usage snapshot sampler starting: interval=${Math.round(intervalMs / 1000)}s, first sample in ~${Math.round(initialDelayMs / 1000)}s`,
		);

		this.startupTimer = setTimeout(() => {
			this.startupTimer = null;
			// Register the recurring interval; run the first tick immediately now
			// that the deferral has elapsed.
			this.stopInterval = intervalManager.register({
				id: this.intervalId,
				callback: () => this.tick(),
				intervalMs,
				immediate: true,
				maxConcurrent: 1,
				description: "Usage snapshot sampler (rate-limit sawtooth)",
			});
		}, initialDelayMs);
		// Don't let the deferral timer keep the process alive on its own.
		this.startupTimer.unref?.();

		// Bootstrap the burn-slope store from PERSISTED history right away, after
		// the recurring schedule is already armed. Snapshots survive a restart, so
		// there is no reason to leave the routing gates on their static fallback for
		// the whole startup deferral. Best-effort and non-throwing by construction,
		// so it can never prevent the interval from being registered.
		await this.refreshBurnSlopes();
	}

	/** Stop the sampler: cancel the deferral timer and unregister the interval. */
	stop(): void {
		if (this.startupTimer) {
			clearTimeout(this.startupTimer);
			this.startupTimer = null;
		}
		if (this.stopInterval) {
			this.stopInterval();
			this.stopInterval = null;
		}
	}

	/**
	 * One sampling tick (exposed for tests / manual triggering): record the cache
	 * projection, then refit the weekly burn slopes.
	 *
	 * The refit runs in a `finally` because it reads PERSISTED history: whether
	 * this tick found fresh cache entries, or its insert failed, has no bearing on
	 * whether the stored series can be fitted.
	 */
	async tick(): Promise<void> {
		try {
			await this.recordSnapshots();
		} finally {
			await this.refreshBurnSlopes();
		}
	}

	/** The cache → `usage_snapshots` write half of a tick. */
	private async recordSnapshots(): Promise<void> {
		const now = Date.now();

		let accounts: Account[];
		try {
			accounts = await this.deps.getAccounts();
		} catch (err) {
			log.warn(`Snapshot sampler: failed to read accounts: ${err}`);
			return;
		}

		const freshnessMs = this.deps.getFreshnessMs();
		const { rows, scopedRows } = buildSamplerRows(
			accounts,
			this.deps.cache,
			now,
			freshnessMs,
		);

		// Feed the revision-anchor detector BEFORE any insert: the registry is a
		// pure observer of the readings and must not depend on DB success. Rows
		// already passed the freshness gate and carry a real observation time
		// (buildSamplerRows drops entries without one).
		for (const row of rows) {
			if (row.observedAt == null) continue;
			observeUsageReading(row.accountId, "five_hour", {
				pct: row.fiveHourPct,
				resetMs: row.fiveHourReset,
				observedAtMs: row.observedAt,
			});
			observeUsageReading(row.accountId, "seven_day", {
				pct: row.sevenDayPct,
				resetMs: row.sevenDayReset,
				observedAtMs: row.observedAt,
			});
		}

		if (rows.length === 0 && scopedRows.length === 0) {
			log.debug("Snapshot sampler: no fresh windowed accounts this tick");
			return;
		}

		if (rows.length > 0) {
			try {
				await this.deps.insertSnapshots(rows);
				log.debug(
					`Snapshot sampler: recorded ${rows.length} usage snapshot(s)`,
				);
			} catch (err) {
				// A DB error must not kill the interval — log and move on.
				log.error(`Snapshot sampler: failed to persist snapshots: ${err}`);
			}
		}

		// Separate try: a failure writing one series must not discard the other,
		// and neither series is a precondition of the other.
		if (scopedRows.length > 0) {
			try {
				await this.deps.insertScopedSnapshots(scopedRows);
				log.debug(
					`Snapshot sampler: recorded ${scopedRows.length} scoped usage snapshot(s)`,
				);
			} catch (err) {
				log.error(
					`Snapshot sampler: failed to persist scoped snapshots: ${err}`,
				);
			}
		}
	}

	/**
	 * Refit each account's WEEKLY burn slope from persisted snapshots and publish
	 * it to the routing store (`recordWeeklyBurnSlope`), where the pool-liveness
	 * reserve reads it to size its release horizon.
	 *
	 * Best-effort in every sense: it reads the stored series (never the provider),
	 * logs and swallows any failure, and is a pure add-on to the sampler — nothing
	 * about the snapshot write depends on it, and vice versa.
	 *
	 * Details that matter:
	 *  - Only accounts with WINDOWED usage (anthropic/codex) have a series at all.
	 *  - `observedAt` is the newest CONTRIBUTING sample, never `Date.now()`: the
	 *    store's staleness check is about the age of the evidence.
	 *  - An account whose newest sample has not advanced since its last fit is
	 *    skipped — the regression over unchanged rows yields the same answer.
	 *  - `lowConfidence` fits are recorded as-is; the store filters them on read,
	 *    so exactly one place decides usability.
	 */
	/**
	 * Seed the revision-anchor registry from PERSISTED snapshot history — the
	 * restart path. Replays up to {@link ANCHOR_SEED_LOOKBACK_MS} of stored
	 * samples chronologically through `observeUsageReading`, the SAME detection
	 * path the live tick feeds, so replay + live cannot disagree; the registry's
	 * own observation-order guard makes re-feeding already-seen readings a
	 * no-op.
	 *
	 * Rows without observation provenance (pre-`observed_at` history) are
	 * skipped: they cannot place a revision honestly, and `sampled_at` is only
	 * an upper bound the schema explicitly forbids substituting.
	 *
	 * Best-effort and non-throwing, like the burn-slope bootstrap beside it.
	 */
	async seedRevisionAnchors(): Promise<void> {
		try {
			const now = Date.now();
			const accountIds = (await this.deps.getAccounts())
				.filter((a) => a.provider === "anthropic" || a.provider === "codex")
				.map((a) => a.id);

			if (accountIds.length === 0) return;

			const samples = await this.deps.getRecentSnapshots(
				accountIds,
				now - ANCHOR_SEED_LOOKBACK_MS,
			);

			// Ordered (account_id, sampled_at) by the repository; state is keyed
			// per account, so per-account chronology is all that matters.
			let fed = 0;
			for (const s of samples) {
				if (s.observedAt == null) continue;
				observeUsageReading(s.accountId, "five_hour", {
					pct: s.fiveHourPct,
					resetMs: s.fiveHourReset,
					observedAtMs: s.observedAt,
				});
				observeUsageReading(s.accountId, "seven_day", {
					pct: s.sevenDayPct,
					resetMs: s.sevenDayReset,
					observedAtMs: s.observedAt,
				});
				fed++;
			}
			if (fed > 0) {
				log.debug(
					`Snapshot sampler: seeded revision anchors from ${fed} stored sample(s)`,
				);
			}
		} catch (err) {
			log.warn(`Snapshot sampler: revision-anchor seed failed: ${err}`);
		}
	}

	async refreshBurnSlopes(): Promise<void> {
		try {
			const now = Date.now();

			const accountIds = (await this.deps.getAccounts())
				.filter((a) => a.provider === "anthropic" || a.provider === "codex")
				.map((a) => a.id);

			// Reconcile BOTH per-account maps against the live roster, before the
			// early return so an emptied roster is cleaned up too.
			//
			// Pruned per tick rather than from a delete hook, for three reasons.
			// The sampler is a server-owned instance the HTTP delete handler cannot
			// reach, and no account-removed hook exists. `getAccounts` is re-read
			// every tick anyway, so the roster costs nothing here. And a DELETE that
			// lands while a tick is awaiting its history read below races the
			// handler's own clear: the fit re-records the slope AFTER the clear, so
			// the store has to be reconciled from the roster as well.
			const liveIds = new Set(accountIds);
			for (const accountId of this.lastFittedSampleAt.keys()) {
				if (!liveIds.has(accountId)) this.lastFittedSampleAt.delete(accountId);
			}
			pruneWeeklyBurnSlopes(liveIds);

			if (accountIds.length === 0) return;

			const samples = await this.deps.getRecentSnapshots(
				accountIds,
				now - BURN_SLOPE_LOOKBACK_MS,
			);

			// Group the 7d series per account in a single pass (mirrors the 7d
			// assembly in http-api's build-account-predictions).
			const pointsByAccount = new Map<string, PredictionPoint[]>();
			for (const s of samples) {
				if (s.sevenDayPct == null) continue;
				const point: PredictionPoint = {
					t: s.sampledAt,
					utilization: s.sevenDayPct,
					resetsAt: s.sevenDayReset,
				};
				const list = pointsByAccount.get(s.accountId);
				if (list) list.push(point);
				else pointsByAccount.set(s.accountId, [point]);
			}

			let fitted = 0;
			for (const [accountId, points] of pointsByAccount) {
				let newestSampleAt = Number.NEGATIVE_INFINITY;
				for (const p of points) {
					if (p.t > newestSampleAt) newestSampleAt = p.t;
				}
				if (!Number.isFinite(newestSampleAt)) continue;
				// Unchanged history → the fit cannot have changed. Skip.
				if (this.lastFittedSampleAt.get(accountId) === newestSampleAt) continue;
				this.lastFittedSampleAt.set(accountId, newestSampleAt);

				const prediction = computeUsagePrediction(points);
				// Without a window reset the slope cannot be matched to the gate's
				// BINDING weekly window, and a non-finite slope is not a measurement.
				if (prediction.resetsAtMs == null) continue;
				if (!Number.isFinite(prediction.slopePerHour)) continue;

				recordWeeklyBurnSlope(accountId, {
					slopePctPerHour: prediction.slopePerHour,
					lowConfidence: prediction.lowConfidence,
					observedAt: newestSampleAt,
					windowResetMs: prediction.resetsAtMs,
				});
				fitted++;
			}

			if (fitted > 0) {
				log.debug(`Snapshot sampler: refit ${fitted} weekly burn slope(s)`);
			}
		} catch (err) {
			// Never throws: the slope feed is an optimization for a fail-open gate.
			log.warn(
				`Snapshot sampler: failed to refresh weekly burn slopes: ${err}`,
			);
		}
	}
}
