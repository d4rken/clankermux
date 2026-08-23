import type { RunwayWindowObservations } from "@clankermux/core";
import type { DatabaseOperations } from "@clankermux/database";
import { Logger } from "@clankermux/logger";

const log = new Logger("SnapshotUsage");

/**
 * Restore an account's two account-wide quota windows from the persisted
 * `usage_snapshots` history.
 *
 * WHY this exists: `usageCache` is in-memory, so every restart empties it.
 * Until the usage poller has been round the accounts again, a key whose
 * accounts are all cold has no readable window, its runway outcome is
 * `unknown`, and the tile built on it has nothing to say. `/api/accounts` and
 * `/api/runway` already work around this for Codex alone, through
 * `accounts.codex_usage_json`. This is the same idea using evidence that is
 * already being written for the Limits sawtooth.
 *
 * COVERAGE — the sampler persists ANTHROPIC AND CODEX ONLY (`buildSnapshotRows`
 * skips every other provider). Alibaba and Zai accounts do expose account-wide
 * windows, so they stay `unknown` after a restart until their first poll lands;
 * closing that needs the sampler widened, not this reader.
 *
 * WHAT `sampled_at` ACTUALLY MEANS, and why the age bar is approximate: the
 * sampler stamps each row with its OWN tick time while reading a cache entry
 * that may itself be up to `max(2 * pollIntervalMs, 150s)` old. A row's
 * `sampled_at` is therefore an UPPER BOUND on the observation's recency, not the
 * observation instant — a row reading as 2 minutes old can describe a reading
 * ~5 minutes old at the default 90s poll interval, and proportionally more if
 * that interval is raised. The caller's bar is consequently permissive by that
 * margin. It stays the same ORDER as the live path it substitutes for (a cache
 * entry the projection uses unhesitatingly is itself up to 10 minutes old), and
 * it is only ever reached when the live read produced nothing at all, never as a
 * competitor to one that produced something. Fixing the imprecision at the root
 * means stamping the cache entry's own write time (`usageCache.peekWrittenAt`)
 * in the sampler, which also changes what the shared `usage_snapshots` series
 * means for the sawtooth and for the regression.
 *
 * WHAT it deliberately does NOT do: feed the prediction. The prediction service
 * appends its input as a data point stamped `t: now`, so a reading observed
 * minutes ago would enter the regression claiming to be current. An account
 * restored from a snapshot therefore reports its utilization with
 * `prediction: null` and is projected by the lifetime-average path — exactly
 * what a column-restored Codex account already does.
 */

export interface SnapshotObservation extends RunwayWindowObservations {
	/** The real sample instant, not a bucket start. */
	sampledAtMs: number;
}

/**
 * Newest snapshot per account within `maxAgeMs` of `now`, keyed by account id.
 *
 * Accounts with no row in the window are absent from the map rather than
 * present with nulls: "no snapshot" and "a snapshot that recorded nothing" are
 * different answers, and only the second one is evidence.
 *
 * The read is bounded by `maxAgeMs` rather than being a per-account "latest"
 * lookup, so a months-old row for a long-dead account can never be loaded and
 * then discarded. At the sampler's ~2 minute cadence a 30-minute window is
 * about fifteen rows per account.
 */
export async function loadRecentSnapshotObservations(
	dbOps: DatabaseOperations,
	accountIds: string[],
	now: number,
	maxAgeMs: number,
): Promise<Map<string, SnapshotObservation>> {
	if (accountIds.length === 0) return new Map();

	// This is a FALLBACK for evidence that is already missing, so a failure to
	// read it must degrade to "no fallback" and never take the response down —
	// the same contract, for the same reason, as the prediction service's read of
	// this table.
	let samples: Awaited<
		ReturnType<DatabaseOperations["getRecentUsageSnapshotsForAccounts"]>
	>;
	try {
		samples = await dbOps.getRecentUsageSnapshotsForAccounts(
			accountIds,
			now - maxAgeMs,
		);
	} catch (err) {
		log.warn(`Failed to read persisted usage snapshots: ${err}`);
		return new Map();
	}

	const byAccount = new Map<string, SnapshotObservation>();
	for (const sample of samples) {
		// A row whose windows are both empty is not evidence of anything, and
		// keeping it would let it shadow an older row that actually recorded a
		// reading. The sampler does not write such rows today; the guard is here
		// so this function's contract does not depend on that.
		if (sample.fiveHourPct == null && sample.sevenDayPct == null) continue;
		const existing = byAccount.get(sample.accountId);
		if (existing && existing.sampledAtMs >= sample.sampledAt) continue;
		byAccount.set(sample.accountId, {
			sampledAtMs: sample.sampledAt,
			// `{ pct: null }` rather than a null window: the snapshot row proves the
			// sampler looked, so an absent percentage is "read, nothing reported",
			// which is what the extractors return for the same situation.
			fiveHour: {
				pct: sample.fiveHourPct,
				resetMs: sample.fiveHourReset,
			},
			sevenDay: {
				pct: sample.sevenDayPct,
				resetMs: sample.sevenDayReset,
			},
		});
	}

	return byAccount;
}

/**
 * The snapshot for `accountId` if it is within `maxAgeMs` of `now`, else null.
 *
 * The map is loaded once at the widest horizon any caller needs; this narrows
 * it per use, so the routing-fresh projection and the display evidence block
 * can read the same map under their own different age bars without two queries.
 */
export function snapshotWithin(
	snapshots: Map<string, SnapshotObservation>,
	accountId: string,
	now: number,
	maxAgeMs: number,
): SnapshotObservation | null {
	const snapshot = snapshots.get(accountId);
	if (!snapshot) return null;
	const ageMs = now - snapshot.sampledAtMs;
	// A NEGATIVE age is a row stamped in the future — clock rollback or skew
	// across a restart. Unchecked it passes the bar until the wall clock catches
	// up, so an obsolete reading could drive the projection for as long as the
	// skew lasts. An age has to be a real age.
	if (!Number.isFinite(ageMs) || ageMs < 0) return null;
	return ageMs <= maxAgeMs ? snapshot : null;
}

/**
 * The snapshot's windows with anything unfit to PROJECT from removed.
 *
 * A window whose recorded reset has already passed rolled over since the row was
 * written, so its utilization describes a window that no longer exists. Left in,
 * it reaches `estimateWindowExhaustion`, whose `pct >= 100` branch runs BEFORE
 * the reset guards and answers `already-exhausted`; `windowDeadIntervals` then
 * holds a window with a passed reset dead for the WHOLE horizon. The tile would
 * announce "Out of quota" about quota that has in fact replenished.
 *
 * Only the scan needs this. The evidence block reports observations rather than
 * projecting from them, and an observation whose reset has since passed is still
 * a true statement about when it was taken.
 */
export function projectableWindows(
	snapshot: SnapshotObservation,
	now: number,
): RunwayWindowObservations {
	const keep = (window: SnapshotObservation["fiveHour"]) =>
		window && window.resetMs != null && window.resetMs <= now ? null : window;
	return {
		fiveHour: keep(snapshot.fiveHour),
		sevenDay: keep(snapshot.sevenDay),
	};
}
