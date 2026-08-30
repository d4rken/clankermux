import { registerDisposable } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import type { AccountIdentity } from "@clankermux/types";

const log = new Logger("PendingRotationRegistry");

/**
 * A refresh-token rotation the PROVIDER already committed but whose DB persist
 * THREW. The exchanged token is dead upstream and the row still holds it, so
 * this entry is the only live copy of the new generation until a flush lands it.
 *
 * `attemptedRefreshToken` is the ANCHOR: the refresh token the DB is believed to
 * still hold. Every write derived from this entry compare-and-swaps on it, so an
 * anchor that names anything else either silently no-ops (rotation lost) or
 * overwrites a newer writer's credentials.
 */
export interface PendingRotation {
	accessToken: string;
	expiresAt: number;
	refreshToken?: string;
	/**
	 * Deadline of `refreshToken`, carried with it so a flush lands the pair the
	 * provider actually issued. Reading it back off the row at flush time would
	 * describe whichever token the row still holds, which is precisely the one
	 * this entry exists to replace.
	 */
	refreshTokenExpiresAt?: number | null;
	identity: AccountIdentity | null;
	attemptedRefreshToken: string;
	recordedAt: number;
}

/**
 * Minimal slice of DatabaseOperations the registry needs. Structural (not the
 * concrete class) so the registry carries no `@clankermux/database` import and
 * tests can inject a plain object instead of mocking a module.
 */
export interface PendingRotationWriter {
	updateAccountTokens(
		accountId: string,
		accessToken: string,
		expiresAt: number,
		refreshToken?: string,
		identity?: AccountIdentity | null,
		expectedRefreshToken?: string | null,
		options?: { refreshTokenExpiresAt?: number | null },
	): Promise<boolean>;
}

/**
 * The deadline known for `refreshToken` — the token a persist is about to
 * install — or null when nothing knows one.
 *
 * Both refresh paths pick the token they write from up to three sources (this
 * refresh's result, a pending rotation, the row's own token) and must attach
 * the deadline belonging to THAT token, not to whichever source was consulted
 * first. Those can diverge: a pending rotation can hold a token plus its
 * deadline while the refresh that follows returns the same token with no
 * deadline of its own (the provider echoed it, or our own earlier flush had
 * already landed it). Sourcing by position would then assert "no deadline" for
 * a token whose deadline is sitting right there in the registry, and the write
 * would clear a date we know.
 *
 * Matching on token identity instead makes the answer independent of which
 * branch supplied the token. Null stays "unknown", which the repository turns
 * into keep-or-clear depending on whether the stored token actually changed.
 */
export function refreshTokenDeadlineFor(
	refreshToken: string | undefined,
	result: {
		refreshToken?: string | null;
		refreshTokenExpiresAt?: number | null;
	},
	pending: PendingRotation | undefined,
): number | null {
	if (refreshToken === undefined) return null;
	if (
		result.refreshToken === refreshToken &&
		result.refreshTokenExpiresAt != null
	) {
		return result.refreshTokenExpiresAt;
	}
	if (pending?.refreshToken === refreshToken) {
		return pending.refreshTokenExpiresAt ?? null;
	}
	return null;
}

export type PendingRotationFlushOutcome =
	| "none"
	| "persisted"
	| "superseded"
	| "failed";

export interface PendingRotationFlushResult {
	outcome: PendingRotationFlushOutcome;
	/**
	 * The entry this flush acted on. Returned so a caller can install the flushed
	 * credentials directly instead of re-reading the row it just wrote (or, on
	 * "failed", the row it knows is stale).
	 */
	entry?: PendingRotation;
}

/**
 * In-memory only, by design: a restart loses every pending rotation, and the
 * accounts holding one then need a re-auth. Persisting them would mean writing
 * the very credentials whose write is failing.
 */
const pending = new Map<string, PendingRotation>();

/**
 * FIFO cap. Reaching it means the DB has been rejecting token writes for a very
 * long time across many accounts; dropping the oldest keeps this map bounded and
 * the loss is logged at error level (that rotation is then durably gone).
 */
export const MAX_PENDING_ROTATIONS = 1000;

const RETRY_BASE_INTERVAL_MS = 30_000;
const RETRY_JITTER_MS = 5_000;

let retryTimer: Timer | null = null;
let retryWriter: PendingRotationWriter | null = null;
let retryIntervalOverrideMs: number | null = null;

function nextRetryIntervalMs(): number {
	if (retryIntervalOverrideMs !== null) return retryIntervalOverrideMs;
	// Jittered so a fleet of proxies that lost their DB at the same moment does
	// not retry in lockstep.
	return RETRY_BASE_INTERVAL_MS + Math.floor(Math.random() * RETRY_JITTER_MS);
}

/**
 * Record a rotation whose persist threw. Chained rotations COMPRESS: an entry
 * only still exists because every flush failed, so the DB never moved — a chain
 * RT1→RT2→RT3 must keep CASing on RT1, and keeps the original `recordedAt` so a
 * retried account cannot repeatedly jump the FIFO queue.
 */
export function recordPendingRotation(
	accountId: string,
	rotation: Omit<PendingRotation, "recordedAt">,
	dbOps: PendingRotationWriter,
): void {
	const existing = pending.get(accountId);
	const anchor =
		existing?.attemptedRefreshToken ?? rotation.attemptedRefreshToken;
	if (typeof anchor !== "string" || anchor.length === 0) {
		// Unrecordable by construction: the repo CAS treats "" as a literal match
		// and null as an UNCONDITIONAL write, so an entry without a real anchor
		// could only ever no-op or clobber a newer writer. Assert-style — a caller
		// reaching this has lost track of what the row holds.
		log.error(
			`Refusing to record a pending refresh-token rotation for account ${accountId} without a usable anchor (the refresh token the database still holds) — the rotation is durably lost and the account will need re-authentication.`,
		);
		return;
	}

	if (!existing && pending.size >= MAX_PENDING_ROTATIONS) {
		evictOldestPendingRotation();
	}

	pending.set(accountId, {
		accessToken: rotation.accessToken,
		expiresAt: rotation.expiresAt,
		refreshToken: rotation.refreshToken,
		// Chained rotations compress onto the newest token, so its deadline wins
		// outright — EXCEPT when the incoming rotation names the token this entry
		// already holds and reports no deadline of its own, where dropping to
		// null would discard a date the entry already knew.
		refreshTokenExpiresAt: refreshTokenDeadlineFor(
			rotation.refreshToken,
			rotation,
			existing,
		),
		// The DB write COALESCE-merges identity fields, so preserving the whole
		// previously-captured identity here is enough to keep a later null from
		// erasing what an earlier rotation captured.
		identity: rotation.identity ?? existing?.identity ?? null,
		attemptedRefreshToken: anchor,
		recordedAt: existing?.recordedAt ?? Date.now(),
	});
	armRetryTimer(dbOps);
}

function evictOldestPendingRotation(): void {
	const oldest = pending.keys().next();
	if (oldest.done) return;
	pending.delete(oldest.value);
	log.error(
		`Pending refresh-token rotation registry is full (${MAX_PENDING_ROTATIONS}); dropped the oldest entry (account ${oldest.value}) — that rotation is durably lost and the account will need re-authentication.`,
	);
}

export function getPendingRotation(
	accountId: string,
): PendingRotation | undefined {
	return pending.get(accountId);
}

/**
 * The refresh token the DB is believed to hold for this account, or undefined
 * when nothing is pending. Callers key their own persist CAS on it so a write
 * derived from a newer in-memory generation still matches the stale row.
 */
export function getPendingRotationAnchor(
	accountId: string,
): string | undefined {
	return pending.get(accountId)?.attemptedRefreshToken;
}

/**
 * Try to land a pending rotation in the DB. Pure DB work — it never calls a
 * provider, so it is safe on any hot path and from the background retry.
 *
 * - "persisted": the row now holds the entry's credentials; the entry is dropped
 *   (identity-guarded) and any newer survivor is rebased onto what was written.
 * - "superseded": the CAS missed, so the row moved past the anchor (a re-auth or
 *   a newer rotation landed); the entry is dropped — it describes a dead
 *   generation.
 * - "failed": the write threw again; the entry is kept for the next attempt.
 */
export async function flushPendingRotation(
	accountId: string,
	dbOps: PendingRotationWriter,
): Promise<PendingRotationFlushResult> {
	const entry = pending.get(accountId);
	if (!entry) return { outcome: "none" };

	try {
		const persisted = await dbOps.updateAccountTokens(
			accountId,
			entry.accessToken,
			entry.expiresAt,
			entry.refreshToken,
			entry.identity,
			entry.attemptedRefreshToken,
			{ refreshTokenExpiresAt: entry.refreshTokenExpiresAt ?? null },
		);
		if (persisted) {
			resolvePendingAfterPersist(
				accountId,
				entry,
				entry.refreshToken ?? entry.attemptedRefreshToken,
			);
			log.info(
				`Persisted a previously-failed refresh-token rotation for account ${accountId}`,
			);
			return { outcome: "persisted", entry };
		}
		clearPendingRotationIfCurrent(accountId, entry);
		log.warn(
			`Dropped the pending refresh-token rotation for account ${accountId}: the stored refresh token no longer matches the anchor (a re-authentication or a newer rotation was persisted first).`,
		);
		return { outcome: "superseded", entry };
	} catch (error) {
		log.warn(
			`Failed to persist the pending refresh-token rotation for account ${accountId} — keeping it in memory for the next attempt`,
			error,
		);
		return { outcome: "failed", entry };
	}
}

/**
 * Settle the registry after a CALLER's own anchor-keyed persist succeeded.
 *
 * `persistedRefreshToken` is the token that write actually wrote, which may
 * differ from `entrySnapshot.refreshToken` (a chained refresh persists its own
 * newly minted token). A newer entry recorded while that write was in flight
 * survives and is rebased onto it — that is what the row holds now, so it is
 * what the survivor's next CAS must name.
 */
export function resolvePendingAfterPersist(
	accountId: string,
	entrySnapshot: PendingRotation,
	persistedRefreshToken: string | undefined,
): void {
	const current = pending.get(accountId);
	if (!current) return;
	if (current === entrySnapshot) {
		pending.delete(accountId);
		disarmRetryTimerIfIdle();
		return;
	}
	// REPLACED, never mutated in place: a rebase makes every snapshot taken
	// before it describe a superseded anchor, so the holders of those snapshots
	// must FAIL the identity guards. Mutating would keep object identity, and a
	// concurrent flush that had already submitted the OLD anchor would then pass
	// its guard on the superseded path and delete the rebased survivor — the
	// newest credentials, durably lost.
	if (persistedRefreshToken) {
		pending.set(accountId, {
			...current,
			attemptedRefreshToken: persistedRefreshToken,
		});
	}
}

/** Drop a pending rotation only if it is still the entry the caller saw. */
export function clearPendingRotationIfCurrent(
	accountId: string,
	entrySnapshot: PendingRotation,
): void {
	if (pending.get(accountId) !== entrySnapshot) return;
	pending.delete(accountId);
	disarmRetryTimerIfIdle();
}

/**
 * Drop whatever is pending for an account, unconditionally. Two sanctioned
 * callers: reauth COMPLETION (fresh credentials have just been written, so any
 * pending rotation describes a generation the provider has already replaced)
 * and ACCOUNT REMOVAL (the row is gone, so the rotation has nowhere to land —
 * the retry sweep would discover that itself within ~35s via the CAS matching
 * zero rows, but it would log a misleading "superseded" warning on the way).
 * Never call it from generic cache-clearing paths (force-reset-rate-limit,
 * manual usage refresh) — those would discard the only live copy of a rotated
 * token.
 */
export function clearPendingRotation(accountId: string): void {
	if (!pending.delete(accountId)) return;
	disarmRetryTimerIfIdle();
}

function armRetryTimer(dbOps: PendingRotationWriter): void {
	retryWriter = dbOps;
	if (retryTimer || pending.size === 0) return;
	retryTimer = setInterval(() => {
		void runRetrySweep();
	}, nextRetryIntervalMs());
}

function disarmRetryTimerIfIdle(): void {
	if (pending.size > 0 || !retryTimer) return;
	clearInterval(retryTimer);
	retryTimer = null;
}

/**
 * Retry every pending rotation on a timer. Without it an Anthropic account only
 * reaches a flush touchpoint when a refresh is attempted (roughly hourly), so a
 * restart inside that window would lose a rotation the DB would have accepted
 * seconds after the original failure.
 */
async function runRetrySweep(): Promise<void> {
	const dbOps = retryWriter;
	if (!dbOps) return;
	for (const accountId of Array.from(pending.keys())) {
		await flushPendingRotation(accountId, dbOps);
	}
	disarmRetryTimerIfIdle();
}

/** Test seam: shorten (number) or restore (null) the background retry interval. */
export function setPendingRotationRetryIntervalForTests(
	intervalMs: number | null,
): void {
	retryIntervalOverrideMs = intervalMs;
	if (!retryTimer) return;
	clearInterval(retryTimer);
	retryTimer = setInterval(() => {
		void runRetrySweep();
	}, nextRetryIntervalMs());
}

/** Test seam: whether the background retry timer is currently armed. */
export function isPendingRotationRetryArmedForTests(): boolean {
	return retryTimer !== null;
}

export function clearAllPendingRotationsForTests(): void {
	pending.clear();
	if (retryTimer) {
		clearInterval(retryTimer);
		retryTimer = null;
	}
	retryWriter = null;
}

registerDisposable({
	dispose: () => {
		if (retryTimer) {
			clearInterval(retryTimer);
			retryTimer = null;
		}
		pending.clear();
		retryWriter = null;
	},
});
