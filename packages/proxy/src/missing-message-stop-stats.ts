/**
 * In-memory, cumulative-since-restart counter for the "missing message_stop"
 * anomaly (see {@link detectMissingMessageStop} in usage-collector).
 *
 * Diagnostic only. Its purpose is to answer one question from production traffic:
 * do native Anthropic streams actually terminate WITHOUT their protocol-closing
 * `message_stop` event — the condition that hangs Claude Code at end-of-stream —
 * before we decide whether to adopt the upstream stream-repair wrapper. The
 * running count is folded into the ResponseHandler warn log so each occurrence is
 * visible without a separate read; {@link MissingMessageStopStats.snapshot} is a
 * seam for surfacing it via the HTTP API later if the signal proves real.
 *
 * A dependency-light singleton (no DB, no logger), mirroring bridge-stats. All
 * counters are cumulative since process start and reset only by
 * {@link MissingMessageStopStats.reset} (used in tests).
 */
export interface MissingMessageStopSnapshot {
	/** Total anomalies observed since process start. */
	count: number;
	/** Model of the most recent anomaly, or undefined if none yet. */
	lastModel: string | undefined;
	/** requestId of the most recent anomaly, or undefined if none yet. */
	lastRequestId: string | undefined;
	/** epoch-ms of the most recent anomaly, or undefined if none yet. */
	lastAtMs: number | undefined;
}

class MissingMessageStopStats {
	private count = 0;
	private lastModel: string | undefined;
	private lastRequestId: string | undefined;
	private lastAtMs: number | undefined;

	/**
	 * Record one observed anomaly. Returns the new cumulative count so the caller
	 * can fold the occurrence number straight into its log line.
	 */
	record(model: string | undefined, requestId: string, nowMs: number): number {
		this.count++;
		this.lastModel = model;
		this.lastRequestId = requestId;
		this.lastAtMs = nowMs;
		return this.count;
	}

	snapshot(): MissingMessageStopSnapshot {
		return {
			count: this.count,
			lastModel: this.lastModel,
			lastRequestId: this.lastRequestId,
			lastAtMs: this.lastAtMs,
		};
	}

	/** Reset all counters (tests only). */
	reset(): void {
		this.count = 0;
		this.lastModel = undefined;
		this.lastRequestId = undefined;
		this.lastAtMs = undefined;
	}
}

export const missingMessageStopStats = new MissingMessageStopStats();
