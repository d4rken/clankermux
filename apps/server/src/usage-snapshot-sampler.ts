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
 *  - Freshness is honest: if the cache for an account is missing or older than
 *    `freshnessMs`, no row is written (gaps are real, never carried forward).
 *    This is the WRITE path — the DB stores only what was actually observed.
 *    The READ path (the usage-history handler) is where a paused/maxed account's
 *    last value is carried forward across those gaps until its recorded window
 *    reset, so the pool-average chart line doesn't falsely drop when the highest
 *    account stops reporting. Gap-vs-carry is the write/read boundary: see
 *    `packages/http-api/src/handlers/usage-history.ts`.
 */

import { intervalManager, normalizeAnthropicUsage } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import type { AnyUsageData, UsageData } from "@clankermux/providers";
import type {
	Account,
	AnthropicUsageData,
	UsageSnapshotRow,
} from "@clankermux/types";

const log = new Logger("UsageSnapshotSampler");

/** Sample cadence (2 minutes). */
export const SAMPLE_INTERVAL_MS = 120_000;

/**
 * Minimal cache surface the pure projection needs (matches `usageCache`). The
 * sampler is a pure observer, so it uses the NON-evicting reads: leaving stale
 * entries in place keeps its sampling side-effect-free (no impact on routing or
 * window-reset comparisons that read the raw cache).
 */
export interface SamplerCache {
	peek(accountId: string): AnyUsageData | null;
	peekAge(accountId: string): number | null;
}

/** The slice of an account the sampler reasons about. */
interface SamplerAccount {
	id: string;
	provider: string;
}

/**
 * PURE projection: turn the current cache contents into write-ready snapshot
 * rows for one tick. All rows share the single `now` timestamp.
 *
 * Per account:
 *  - skip non-(anthropic|codex) providers entirely;
 *  - skip when cache age is null or `> freshnessMs` (no carry-forward);
 *  - pull the session (5h) / account-wide weekly (7d) utilization + reset via
 *    `normalizeAnthropicUsage`, so a `limits[]`-only payload (upstream is
 *    dropping the flat five_hour/seven_day keys) still yields a row — otherwise
 *    the sawtooth graph and stale-usage recovery go blank for those accounts;
 *  - skip when BOTH windows are absent/null (nothing meaningful to record).
 */
export function buildSnapshotRows(
	accounts: ReadonlyArray<SamplerAccount>,
	cache: SamplerCache,
	now: number,
	freshnessMs: number,
): UsageSnapshotRow[] {
	const rows: UsageSnapshotRow[] = [];

	for (const account of accounts) {
		const { id, provider } = account;
		if (provider !== "anthropic" && provider !== "codex") continue;

		const age = cache.peekAge(id);
		if (age === null || age > freshnessMs) continue; // missing/stale → honest gap

		const data = cache.peek(id) as UsageData | null;
		if (!data) continue;

		const normalized = normalizeAnthropicUsage(
			data as unknown as AnthropicUsageData,
			now,
		);
		const fiveHourPct = normalized.session?.utilization ?? null;
		const sevenDayPct = normalized.weeklyAll?.utilization ?? null;

		// If neither window contributes a utilization, there is nothing to plot.
		if (fiveHourPct === null && sevenDayPct === null) continue;

		rows.push({
			accountId: id,
			provider,
			sampledAt: now,
			fiveHourPct,
			fiveHourReset: normalized.session?.resetMs ?? null,
			sevenDayPct,
			sevenDayReset: normalized.weeklyAll?.resetMs ?? null,
		});
	}

	return rows;
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
 *  4) writes any non-empty batch (DB errors are logged, never thrown).
 *
 * Registered through `intervalManager` with `maxConcurrent: 1` so a slow tick
 * can never overlap the next.
 */
export class UsageSnapshotSampler {
	private readonly deps: UsageSnapshotSamplerDeps;
	private stopInterval: (() => void) | null = null;
	private startupTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly intervalId = "usage-snapshot-sampler";

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

	/** One sampling tick (exposed for tests / manual triggering). */
	async tick(): Promise<void> {
		const now = Date.now();

		let accounts: Account[];
		try {
			accounts = await this.deps.getAccounts();
		} catch (err) {
			log.warn(`Snapshot sampler: failed to read accounts: ${err}`);
			return;
		}

		const freshnessMs = this.deps.getFreshnessMs();
		const rows = buildSnapshotRows(accounts, this.deps.cache, now, freshnessMs);

		if (rows.length === 0) {
			log.debug("Snapshot sampler: no fresh windowed accounts this tick");
			return;
		}

		try {
			await this.deps.insertSnapshots(rows);
			log.debug(`Snapshot sampler: recorded ${rows.length} usage snapshot(s)`);
		} catch (err) {
			// A DB error must not kill the interval — log and move on.
			log.error(`Snapshot sampler: failed to persist snapshots: ${err}`);
		}
	}
}
