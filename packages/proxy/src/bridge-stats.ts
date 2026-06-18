/**
 * In-memory, cumulative-since-restart telemetry for the Session Cache Bridge.
 *
 * A dependency-light singleton (no DB, no logger) the bridge updates as it runs:
 * the store records keepalive results / failures and real warm resumes, the
 * scheduler reads {@link BridgeStats.snapshot} for its per-tick heartbeat, and the
 * http-api / sampler can read the same snapshot to surface live bridge economics.
 *
 * All counters are cumulative since process start and are reset only by
 * {@link BridgeStats.reset} (used in tests). USD inputs are clamped to a finite,
 * positive value so a stray NaN/negative cost can't corrupt the running totals.
 */
export interface BridgeStatsSnapshot {
	/** Total keepalives whose hit/miss was determined (hits + misses). */
	keepalivesSent: number;
	/** Keepalives that found the cache still warm. */
	hits: number;
	/** Keepalives that had to re-create the cache (it had expired). */
	misses: number;
	/** Keepalives that failed (non-routable / non-ok / threw). */
	failures: number;
	/** Real cache-read turns that resumed a session we'd spent budget on. */
	warmResumes: number;
	/** Sum of all keepalive hit+miss costs charged, in USD. */
	spentUsd: number;
	/** Sum of resume penalties avoided on real warm resumes, in USD. */
	savedUsd: number;
	/** savedUsd - spentUsd. */
	netUsd: number;
	/** hits / (hits + misses), or 0 when nothing has been decided. */
	hitRate: number;
}

class BridgeStats {
	private keepalivesSent = 0;
	private hits = 0;
	private misses = 0;
	private failures = 0;
	private spentUsd = 0; // sum of all keepalive hit+miss costs charged
	private savedUsd = 0; // sum of resume penalties avoided on real warm resumes
	private warmResumes = 0; // count of real cache-read turns that resumed a kept-warm session

	/** A dispatched keepalive whose hit/miss was determined. cost = the USD charged. */
	recordResult(hit: boolean, costUsd: number): void {
		this.keepalivesSent++;
		if (hit) this.hits++;
		else this.misses++;
		this.spentUsd += Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;
	}

	/** A keepalive that failed (non-routable / non-ok / threw). */
	recordFailure(): void {
		this.failures++;
	}

	/** A real cache-read turn resumed a session we'd spent keepalive budget on. */
	recordWarmResume(savedUsd: number): void {
		this.warmResumes++;
		this.savedUsd += Number.isFinite(savedUsd) && savedUsd > 0 ? savedUsd : 0;
	}

	snapshot(): BridgeStatsSnapshot {
		const decided = this.hits + this.misses;
		return {
			keepalivesSent: this.keepalivesSent,
			hits: this.hits,
			misses: this.misses,
			failures: this.failures,
			warmResumes: this.warmResumes,
			spentUsd: this.spentUsd,
			savedUsd: this.savedUsd,
			netUsd: this.savedUsd - this.spentUsd,
			hitRate: decided > 0 ? this.hits / decided : 0,
		};
	}

	reset(): void {
		this.keepalivesSent = 0;
		this.hits = 0;
		this.misses = 0;
		this.failures = 0;
		this.spentUsd = 0;
		this.savedUsd = 0;
		this.warmResumes = 0;
	}
}

export const bridgeStats = new BridgeStats();
