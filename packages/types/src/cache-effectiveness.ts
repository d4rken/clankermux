// Cache-warming EFFECTIVENESS report — a per-range SUMMARY that answers "did the
// bridge actually help my usage/quota?" by joining three sources over the window:
//  - the bridge ledger (cache_keepalive_snapshots, summed per-bucket deltas),
//  - real work volume (the requests table: counts + token breakdown),
//  - per-account quota peaks (usage_snapshots).
// GET /api/analytics/cache-effectiveness?range=…
//
// The headline figures are the CONSERVATIVE (5m-counterfactual) savings — the
// honest "what the bridge saved vs Claude Code's native behaviour with no bridge".
// The optimistic (1h-rate) figures are included for comparison.

/** Per-account quota utilization peak over the window. */
export interface CacheEffectivenessAccountPeak {
	accountId: string;
	name: string;
	/** Peak 5-hour utilization % observed in the window (0 if no samples). */
	peakFiveHourPct: number;
	/** Peak 7-day utilization % observed in the window (0 if no samples). */
	peakSevenDayPct: number;
}

/** Wire response for `GET /api/analytics/cache-effectiveness?range=…`. */
export interface CacheEffectivenessResponse {
	range: string;
	/** Window start (ms epoch); 0 for the "all" range. */
	sinceMs: number;

	// ── Bridge ledger over the window (summed per-bucket deltas) ──────────────
	/** Keepalives whose hit/miss was decided in the window. */
	keepalivesSent: number;
	hits: number;
	misses: number;
	/** hits / (hits + misses), 0 when none decided. */
	hitRate: number;
	/** Real warm resumes booked in the window (the bridge's ROI events). */
	warmResumes: number;
	/** USD spent on keepalives in the window. */
	spentUsd: number;
	/** Optimistic (1h-rate) USD saved in the window. */
	savedUsd: number;
	/** Honest (5m-counterfactual) USD saved in the window — the headline. */
	savedUsdConservative: number;
	/** savedUsd - spentUsd (optimistic). */
	netUsd: number;
	/** savedUsdConservative - spentUsd (honest) — the headline net. */
	netUsdConservative: number;

	// ── Real work over the window (requests table) ───────────────────────────
	/** Total proxied requests recorded in the window. */
	totalRequests: number;
	/** Uncached input tokens billed across those requests. */
	inputTokens: number;
	/** Cache-read input tokens (cheap hits) across those requests. */
	cacheReadTokens: number;
	/** Cache-creation input tokens (cache writes) across those requests. */
	cacheCreationTokens: number;
	/** input + cache_read + cache_creation — total prompt token volume of real work. */
	totalPromptTokens: number;

	// ── Per-account quota peaks over the window (usage_snapshots) ─────────────
	accounts: CacheEffectivenessAccountPeak[];
	/** Pool-wide peak 5h utilization % across accounts in the window. */
	poolPeakFiveHourPct: number;
	/** Pool-wide peak 7d utilization % across accounts in the window. */
	poolPeakSevenDayPct: number;

	// ── Normalizer (de-confounds workload) ───────────────────────────────────
	/**
	 * Pool 7-day peak utilization % per 1M prompt tokens of real work in the window
	 * — "quota pressure per unit of work". Comparable across weeks of different
	 * volume. 0 when there were no prompt tokens.
	 */
	sevenDayPeakPer1MTokens: number;
}
