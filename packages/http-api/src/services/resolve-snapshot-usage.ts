import {
	getModelFamily,
	type RunwayWindowObservations,
	type ScopedFamilyLimit,
} from "@clankermux/core";
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
 * `sampled_at` VERSUS `observed_at`, and why the difference decides a race: the
 * sampler stamps each row with its OWN tick time while reading a cache entry
 * that may itself be up to `max(2 * pollIntervalMs, 150s)` old. A row's
 * `sampled_at` is therefore an UPPER BOUND on the observation's recency, not the
 * observation instant. It is fine as an age bar, which is all it was ever used
 * for while this reader was a pure fallback — reached only when the live read
 * produced nothing at all.
 *
 * It is NOT fine as a rank. `runway-scan.ts` now picks between this and the live
 * cache reading by observation time, and one tick's rows all carry the same
 * `sampled_at` while the readings behind them were observed minutes apart and
 * EARLIER. Ranked on `sampled_at`, a snapshot therefore outranks the very cache
 * entry it was copied from, from each sampler tick until that account's next
 * poll. The copy then substitutes for its own source and drops everything the
 * source carried that the row does not — which is how the per-family windows
 * came to flicker in and out of `/public/v1/workload-headroom` on the sampler's
 * ~2 minute cycle.
 *
 * So {@link SnapshotObservation} carries `observedAtMs`, the row's recorded
 * `observed_at`, and that is what a caller must rank on. It is null when the
 * reading behind the row could not state one, which is a reading that cannot be
 * shown to be the more recent one rather than one that is current;
 * `freshestCandidate` sorts those last. The sampler will not write an
 * account-wide row without one (`buildSamplerRows` treats a missing observation
 * time as an honest gap and skips the account), so among those only pre-migration
 * rows carry null; the scoped-only observations built at the end of
 * `loadRecentSnapshotObservations` carry null because the stamp lives on the
 * account-wide row they do not have.
 *
 * Ranking on it restores the property this module was written under: every row
 * is a COPY of a cache entry, and a cache entry's observation time only moves
 * forward, so a snapshot's `observed_at` can never exceed that of a live entry
 * for the same account. The snapshot therefore wins only when there is no live
 * reading to lose to — a fallback again, rather than a competitor to the source
 * it was copied from.
 *
 * WHAT it deliberately does NOT do: feed the prediction. The prediction service
 * appends its input as a data point stamped `t: now`, so a reading observed
 * minutes ago would enter the regression claiming to be current. An account
 * restored from a snapshot therefore reports its utilization with
 * `prediction: null` and is projected by the lifetime-average path — exactly
 * what a column-restored Codex account already does.
 */

export interface SnapshotObservation extends RunwayWindowObservations {
	/** The real sample instant, not a bucket start. The AGE BAR, never a rank. */
	sampledAtMs: number;
	/**
	 * When the reading behind this row was observed, null when it could not say.
	 * The RANK — see the header on why `sampledAtMs` must not be used for it.
	 */
	observedAtMs: number | null;
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
	> = [];
	try {
		samples = await dbOps.getRecentUsageSnapshotsForAccounts(
			accountIds,
			now - maxAgeMs,
		);
	} catch (err) {
		// Degrade to "no account-wide fallback" and carry on rather than returning.
		// The scoped read below is a separate query over a separate table and can
		// still succeed, and scoped rows have their own path to an observation (see
		// the scoped-only pass at the end of this function). Abandoning it here
		// would delete a family row on the strength of an unrelated error.
		log.warn(`Failed to read persisted usage snapshots: ${err}`);
	}

	// The per-model-family rows the same sampler tick wrote. Loaded
	// unconditionally rather than only when something needs them: it is one read
	// over an indexed range for the same account set, and a scoped window missing
	// here is indistinguishable downstream from a family the account does not
	// report at all.
	let scopedSamples: Awaited<
		ReturnType<DatabaseOperations["getRecentScopedUsageSnapshotsForAccounts"]>
	> = [];
	try {
		scopedSamples = await dbOps.getRecentScopedUsageSnapshotsForAccounts(
			accountIds,
			now - maxAgeMs,
		);
	} catch (err) {
		// Same contract as above, one degree softer: this half failing costs the
		// scoped windows, not the account-wide ones, so the map is still returned.
		// The absence it leaves behind is reported as null, like every other
		// absence here — see the note on the field.
		log.warn(`Failed to read persisted scoped usage snapshots: ${err}`);
	}

	const scopedByTick = new Map<string, ScopedFamilyLimit[]>();
	for (const sample of scopedSamples) {
		// The SAME admissibility the live path applies in `normalizeWeeklyScoped`:
		// a finite percent, a resolvable family, and a finite FUTURE reset. A row
		// whose reset has passed describes a window that has since rolled over. The
		// stored family id is deliberately not trusted either — `getModelFamily`
		// stays the one resolver, so the two paths cannot drift apart on what a
		// display name means.
		if (sample.pct == null || !Number.isFinite(sample.pct)) continue;
		if (sample.resetAt == null || !Number.isFinite(sample.resetAt)) continue;
		if (sample.resetAt <= now) continue;
		const family = getModelFamily(sample.displayName);
		if (family === null) continue;
		const key = tickKey(sample.accountId, sample.sampledAt);
		const limit: ScopedFamilyLimit = {
			family,
			percent: sample.pct,
			resetsAtMs: sample.resetAt,
			// Not recorded in the series. `is_active` is carried for logging and is
			// explicitly gated on nowhere, so a fixed `true` states nothing any
			// consumer acts on.
			isActive: true,
			displayName: sample.displayName,
		};
		const limits = scopedByTick.get(key);
		if (limits) limits.push(limit);
		else scopedByTick.set(key, [limit]);
	}

	const byAccount = new Map<string, SnapshotObservation>();
	const orphaned = new Map<string, SnapshotObservation>();
	for (const sample of samples) {
		// A row whose windows are both empty is not evidence of anything, and
		// keeping it would let it shadow an older row that actually recorded a
		// reading. The sampler does not write such rows today; the guard is here
		// so this function's contract does not depend on that.
		if (sample.fiveHourPct == null && sample.sevenDayPct == null) continue;
		// Admissibility BEFORE selection, for the same reason it comes first in the
		// scoped-only pass below. A future-stamped row (clock rollback across a
		// restart) otherwise wins the newest-tick comparison, shadows an older row
		// that was perfectly usable, and is only rejected later by `snapshotWithin`
		// — by which point the account has no observation at all, and the
		// scoped-only pass is blocked too because the account is already in the map.
		if (!admissibleTick(sample.sampledAt, now, maxAgeMs)) continue;
		const existing = byAccount.get(sample.accountId);
		if (existing && existing.sampledAtMs >= sample.sampledAt) continue;
		byAccount.set(sample.accountId, {
			sampledAtMs: sample.sampledAt,
			observedAtMs: sample.observedAt ?? null,
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
			// Paired on the TICK, not merely on the account: the two series are
			// written together, so the scoped rows carrying this row's `sampled_at`
			// are the ones observed alongside it. Pairing on the account alone would
			// let a newer scoped row ride an older account-wide reading, the
			// cross-instant merge the candidate list exists to prevent.
			//
			// ABSENCE IS NULL, never `[]`. It is tempting to read "this tick wrote an
			// account-wide row and no scoped rows" as "the account reports no
			// families", but the sampler writes the two series in SEPARATE
			// statements, under separate error handling, explicitly so that one
			// failing does not discard the other. An account-wide row is therefore
			// no evidence that the scoped write for its tick ever landed, and a
			// reader can also arrive between the two. `[]` would state as fact
			// something only the live payload can establish, and stating it wrongly
			// removes the account from a family row — the exact false negative that
			// made the row vanish. Null merely marks it unreadable.
			weeklyScoped:
				scopedByTick.get(tickKey(sample.accountId, sample.sampledAt)) ?? null,
		});
	}

	// SCOPED-ONLY TICKS: a tick that recorded scoped windows and no account-wide
	// row. Two things produce one, and only the first is about payload shape:
	//
	//  - the sampler guards the account-wide row on there being a utilization to
	//    plot and emits the scoped rows outside that guard. This does not fire in
	//    practice, because a payload carrying a `weekly_scoped` limit carries the
	//    account-wide `seven_day` one too — measured 2026-09-04, 0 scoped-only
	//    ticks out of 23,324 across the eleven days the series has existed.
	//  - the two INSERTS are separate statements under separate error handling, so
	//    an account-wide write that fails still leaves the scoped write to land.
	//    That needs no unusual payload at all, only a database error, and it is why
	//    the count above proves less than it appears to: it measures the absence of
	//    write failures, not the impossibility of the state.
	//
	// The rule, stated rather than emergent: this is a LAST RESORT for an account
	// with no account-wide observation at all. An account that has one keeps it,
	// and its scoped state stays whatever ITS OWN tick recorded — pulling another
	// tick's scoped rows onto it would merge two observation instants into one
	// reading, which is the thing the candidate list exists to prevent. So an
	// account whose newest account-wide tick lacked scoped rows reads as
	// unreadable, not as one that reports no families.
	for (const sample of scopedSamples) {
		if (byAccount.has(sample.accountId)) continue;
		// Admissibility BEFORE selection. Choosing the greatest raw `sampled_at`
		// first lets a future or non-finite tick win and then be rejected by
		// `snapshotWithin`, taking an older, perfectly usable tick down with it.
		if (!admissibleTick(sample.sampledAt, now, maxAgeMs)) continue;
		const limits = scopedByTick.get(
			tickKey(sample.accountId, sample.sampledAt),
		);
		if (!limits) continue;
		const existing = orphaned.get(sample.accountId);
		if (existing && existing.sampledAtMs >= sample.sampledAt) continue;
		orphaned.set(sample.accountId, {
			sampledAtMs: sample.sampledAt,
			// The observation time lives on the account-wide row, and there is none.
			// This reading cannot say when it was observed, and says so — which makes
			// it untimed to `freshestCandidate`: usable, never able to outrank.
			observedAtMs: null,
			fiveHour: null,
			sevenDay: null,
			weeklyScoped: limits,
		});
	}
	for (const [accountId, observation] of orphaned) {
		byAccount.set(accountId, observation);
	}

	return byAccount;
}

/** Join key for the two series the sampler writes in one tick. */
function tickKey(accountId: string, sampledAt: number): string {
	return `${accountId}|${sampledAt}`;
}

/**
 * Whether a tick is young enough, and real enough, to be selected from.
 *
 * The SAME test `snapshotWithin` applies, deliberately shared: applied only
 * afterwards it rejects the winner without recovering the runner-up, so an
 * inadmissible row does not merely fail to be used, it takes a usable older row
 * down with it. A negative age is a row stamped in the future — clock rollback
 * or skew across a restart — which unchecked outranks every honest row until the
 * wall clock catches up.
 */
function admissibleTick(
	sampledAt: number,
	now: number,
	maxAgeMs: number,
): boolean {
	const ageMs = now - sampledAt;
	return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= maxAgeMs;
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
	// The WINDOWS, not the whole observation: this reads no stamp, and taking one
	// made the only caller fabricate a `SnapshotObservation` around the winning
	// candidate's windows just to satisfy the parameter.
	snapshot: RunwayWindowObservations,
	now: number,
): RunwayWindowObservations {
	const keep = (window: RunwayWindowObservations["fiveHour"]) =>
		window && window.resetMs != null && window.resetMs <= now ? null : window;
	return {
		fiveHour: keep(snapshot.fiveHour),
		sevenDay: keep(snapshot.sevenDay),
		// Carried through, on the same rule and for the same reason as the two
		// account-wide windows. Dropping it here made a snapshot-restored account
		// state NO scoped evidence — not "reports none", which is what its own row
		// actually said — and a caller that cannot tell those apart either loses the
		// account from a family row or invents an unreadable one. The loader has
		// already dropped any entry whose reset had passed at load time; this
		// re-applies it against the caller's `now`, which may be later.
		//
		// Null survives as null. Filtering a null into an empty array would turn
		// "not looked at" into "looked, reports none" at the last step, undoing the
		// distinction the loader takes care to preserve.
		weeklyScoped:
			snapshot.weeklyScoped == null
				? snapshot.weeklyScoped
				: snapshot.weeklyScoped.filter((limit) => limit.resetsAtMs > now),
	};
}
