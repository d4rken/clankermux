/**
 * Usage-snapshot sampler — a periodic job that records per-account rate-limit
 * utilization into the `usage_snapshots` time-series that backs the dashboard
 * "sawtooth" Limits graph.
 *
 * Design notes:
 *  - Only `anthropic` and `codex` accounts have the windowed `UsageData`
 *    (five_hour / seven_day). All other providers are excluded.
 *  - Anthropic accounts are kept warm by the existing 90s usage poller
 *    (`startUsagePollingWithRefresh`), so we just read their cache.
 *  - Codex has no free polling endpoint — each refresh costs a real (bounded)
 *    upstream request. We trigger the EXISTING bounded probe
 *    (`refreshCodexUsageForAccount`) on each tick so the cache is fresh, then
 *    read it. Paused Codex accounts are SKIPPED to avoid spend on accounts the
 *    operator has deliberately taken out of rotation; Anthropic is always
 *    recorded (its poll is free and runs regardless of paused state).
 *  - Freshness is honest: if the cache for an account is missing or older than
 *    `freshnessMs`, no row is written (gaps are real, never carried forward).
 */

import { intervalManager, readEnv } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import type {
	AnyUsageData,
	UsageData,
	UsageWindow,
} from "@clankermux/providers";
import {
	type CodexUsageRefreshOutcome,
	refreshCodexUsageForAccount,
} from "@clankermux/proxy";
import type { Account, UsageSnapshotRow } from "@clankermux/types";

const log = new Logger("UsageSnapshotSampler");

/** Default sample cadence (2 minutes). */
export const SAMPLE_INTERVAL_MS = 120_000;
/** Floor for the env-overridable sample cadence (30s). */
const SAMPLE_INTERVAL_FLOOR_MS = 30_000;
/** Per-account timeout for the bounded Codex probe so one hang can't stall a tick. */
const CODEX_PROBE_TIMEOUT_MS = 8_000;
/**
 * How many times to attempt the Codex probe per tick. The at-rest probe
 * intermittently comes back without the `x-codex-*` usage headers; a single
 * retry meaningfully tightens an otherwise-gappy Codex line at the cost of one
 * extra bounded request on a miss.
 */
const CODEX_PROBE_ATTEMPTS = 2;
/** Delay between Codex probe attempts (lets the per-account in-flight dedup clear). */
const CODEX_PROBE_RETRY_DELAY_MS = 1_500;

/** Minimal cache surface the pure projection needs (matches `usageCache`). */
export interface SamplerCache {
	get(accountId: string): AnyUsageData | null;
	getAge(accountId: string): number | null;
}

/** The slice of an account the sampler reasons about. */
interface SamplerAccount {
	id: string;
	provider: string;
}

/**
 * Read a numeric utilization (%) from a usage window, or null when the window
 * is absent or its utilization is missing/non-numeric.
 */
function windowPct(window: UsageWindow | undefined): number | null {
	if (!window) return null;
	const util = (window as { utilization?: unknown }).utilization;
	return typeof util === "number" && Number.isFinite(util) ? util : null;
}

/**
 * Convert a window's `resets_at` ISO string to epoch ms, or null when absent or
 * unparseable.
 */
function windowResetMs(window: UsageWindow | undefined): number | null {
	if (!window) return null;
	const resetsAt = (window as { resets_at?: unknown }).resets_at;
	if (typeof resetsAt !== "string" || resetsAt.length === 0) return null;
	const ms = new Date(resetsAt).getTime();
	return Number.isFinite(ms) ? ms : null;
}

/**
 * PURE projection: turn the current cache contents into write-ready snapshot
 * rows for one tick. All rows share the single `now` timestamp.
 *
 * Per account:
 *  - skip non-(anthropic|codex) providers entirely;
 *  - skip when cache age is null or `> freshnessMs` (no carry-forward);
 *  - pull five_hour / seven_day utilization + reset (null when absent/invalid);
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

		const age = cache.getAge(id);
		if (age === null || age > freshnessMs) continue; // missing/stale → honest gap

		const data = cache.get(id) as UsageData | null;
		if (!data) continue;

		const fiveHour = data.five_hour as UsageWindow | undefined;
		const sevenDay = data.seven_day as UsageWindow | undefined;

		const fiveHourPct = windowPct(fiveHour);
		const sevenDayPct = windowPct(sevenDay);

		// If neither window contributes a utilization, there is nothing to plot.
		if (fiveHourPct === null && sevenDayPct === null) continue;

		rows.push({
			accountId: id,
			provider,
			sampledAt: now,
			fiveHourPct,
			fiveHourReset: windowResetMs(fiveHour),
			sevenDayPct,
			sevenDayReset: windowResetMs(sevenDay),
		});
	}

	return rows;
}

/** Resolve the sample cadence from env (with a sane floor) or the constant. */
export function resolveSampleIntervalMs(): number {
	const fromEnv = readEnv("USAGE_SNAPSHOT_SAMPLE_INTERVAL_MS");
	if (fromEnv) {
		const n = parseInt(fromEnv, 10);
		if (Number.isFinite(n)) return Math.max(n, SAMPLE_INTERVAL_FLOOR_MS);
	}
	return SAMPLE_INTERVAL_MS;
}

/** True for any account currently paused. */
function isPaused(account: Account): boolean {
	return account.paused === true;
}

/** Dependencies the sampler needs from the host server. */
export interface UsageSnapshotSamplerDeps {
	/** Re-read the live account list each tick (add/remove/pause aware). */
	getAccounts: () => Promise<Account[]>;
	/** Persist a batch of snapshot rows. */
	insertSnapshots: (rows: UsageSnapshotRow[]) => Promise<void>;
	/** The shared in-memory usage cache. */
	cache: SamplerCache;
	/** Trigger the bounded Codex usage probe for one account. */
	refreshCodex?: (accountId: string) => Promise<CodexUsageRefreshOutcome>;
	/** Delay between Codex probe retries (ms). Overridable for fast tests. */
	codexProbeRetryDelayMs?: number;
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
 *  2) primes Codex accounts via the bounded probe (per-account try/catch +
 *     timeout; paused Codex accounts skipped),
 *  3) projects the cache → rows via `buildSnapshotRows`,
 *  4) writes any non-empty batch (DB errors are logged, never thrown).
 *
 * Registered through `intervalManager` with `maxConcurrent: 1` so a slow tick
 * (e.g. a hanging Codex probe) can never overlap the next.
 */
export class UsageSnapshotSampler {
	private readonly deps: UsageSnapshotSamplerDeps;
	private stopInterval: (() => void) | null = null;
	private startupTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly intervalId = "usage-snapshot-sampler";

	constructor(deps: UsageSnapshotSamplerDeps) {
		// Apply the default only when the caller omits the field — spreading an
		// explicit `refreshCodex: undefined` must not silently restore the default
		// (a test suppressing the probe relies on this).
		this.deps = { ...deps };
		this.deps.refreshCodex ??= refreshCodexUsageForAccount;
		this.deps.codexProbeRetryDelayMs ??= CODEX_PROBE_RETRY_DELAY_MS;
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

		// Prime Codex accounts (bounded probe) before reading the cache. Skip
		// paused Codex accounts to avoid spend; Anthropic is kept warm for free
		// by its own poller regardless of paused state.
		const codexToProbe = accounts.filter(
			(a) => a.provider === "codex" && !isPaused(a),
		);
		await Promise.all(codexToProbe.map((a) => this.probeCodex(a.id)));

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

	/**
	 * Trigger the bounded Codex probe for one account, inspecting the outcome so
	 * the otherwise-silent "no usage headers" case is surfaced, and retrying once
	 * on a non-success result to tighten the gappy Codex line. Each attempt has a
	 * per-attempt timeout + try/catch so a hang or failure can't stall or abort
	 * the tick. A throw/timeout is NOT retried — the underlying request may still
	 * be in flight and would be deduped by the refresher's in-flight tracker.
	 */
	private async probeCodex(accountId: string): Promise<void> {
		const refresh = this.deps.refreshCodex;
		if (!refresh) return;
		const retryDelayMs =
			this.deps.codexProbeRetryDelayMs ?? CODEX_PROBE_RETRY_DELAY_MS;

		for (let attempt = 1; attempt <= CODEX_PROBE_ATTEMPTS; attempt++) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const outcome = await Promise.race([
					refresh(accountId),
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error("codex probe timeout")),
							CODEX_PROBE_TIMEOUT_MS,
						);
					}),
				]);
				if (outcome.success) return; // fresh usage cached — done

				// Resolved but no usage data (e.g. response lacked x-codex-* headers).
				// This used to be swallowed silently; surface it and retry once.
				if (attempt < CODEX_PROBE_ATTEMPTS) {
					log.debug(
						`Snapshot sampler: Codex probe for ${accountId} returned no usage (${outcome.message}); retrying`,
					);
					await new Promise<void>((resolve) =>
						setTimeout(resolve, retryDelayMs),
					);
					continue;
				}
				log.debug(
					`Snapshot sampler: Codex probe for ${accountId} returned no usage after ${attempt} attempts (${outcome.message}); skipping this tick`,
				);
				return;
			} catch (err) {
				log.warn(
					`Snapshot sampler: Codex probe failed for ${accountId}: ${err}`,
				);
				return;
			} finally {
				// Clear the timeout so it can't keep the event loop alive after the
				// probe settled (or fire a no-op rejection on an already-settled race).
				if (timer) clearTimeout(timer);
			}
		}
	}
}
