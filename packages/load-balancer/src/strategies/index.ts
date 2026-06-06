import { isAccountAvailable, TIME_CONSTANTS } from "@clankermux/core";
import { Logger, LogLevel } from "@clankermux/logger";
import type {
	Account,
	LoadBalancingStrategy,
	RateLimitReason,
	RequestMeta,
	StrategyStore,
} from "@clankermux/types";
import {
	PROVIDER_NAMES,
	requiresSessionDurationTracking,
} from "@clankermux/types";
import { isPeekAvailable } from "./peek-availability";

export { LeastUsedStrategy } from "./least-used";

/**
 * Minimum remaining cooldown duration before we consider a rate-limit "durable"
 * (i.e. real 5h/7d usage-window exhaustion) and break project affinity to
 * reassign to a healthy account.  Anything shorter is treated as a transient
 * throttle worth waiting out so the warmed prompt cache on the original account
 * is preserved.
 *
 * 15 minutes is comfortably above per-minute throttles (60s), brief 529
 * Retry-After values (seconds – a few minutes), and probe cooldowns, while
 * catching genuine multi-hour window-reset cooldowns.
 */
const AFFINITY_REASSIGN_MIN_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_AFFINITY_ENTRIES = 10_000;

const HEADROOM_EPS = 5; // percent; min meaningful headroom

/**
 * Capacity buckets for FEFO ordering, shared between the comparator
 * (sortAvailableAccounts) and the selection debug log (logSelection) so the two
 * can never drift. Lower bucket = preferred. HARVEST accounts have a known reset
 * deadline and healthy headroom (serve soonest-expiring first); UNKNOWN have no
 * usable capacity model (or no deadline) and fall back to least-utilization;
 * NEAR_LIMIT are nearly exhausted and serve last.
 */
const CAPACITY_BUCKET = {
	HARVEST: 0,
	UNKNOWN: 1,
	NEAR_LIMIT: 2,
} as const;

/** Human-readable bucket names for the selection debug log. */
const CAPACITY_BUCKET_LABEL: Record<number, string> = {
	[CAPACITY_BUCKET.HARVEST]: "HARVEST",
	[CAPACITY_BUCKET.UNKNOWN]: "UNKNOWN",
	[CAPACITY_BUCKET.NEAR_LIMIT]: "NEAR_LIMIT",
};

/** Per-account capacity metric snapshot used by the comparator and the log. */
interface CapacityMetric {
	bucket: number;
	/** Weekly-window reset (ms) — the HARVEST ranking deadline (FEFO). */
	harvestDeadline: number;
	/** min(100 - util) over weekly windows — the HARVEST tie-break. */
	weeklyHeadroom: number;
	/** soonest reset over ALL hard windows (incl. 5h) — kept for the debug log only. */
	soonest: number;
	minHeadroom: number;
	binding: number;
	util: number;
}

/**
 * Rate-limit reasons that indicate a server-wide or self-resolving condition
 * where switching to another account of the same provider would NOT help.
 * Affinity is always preserved ("held") through these, regardless of cooldown
 * duration — the original account's prompt cache is worth snapping back to.
 */
const TRANSIENT_RATE_LIMIT_REASONS: ReadonlySet<RateLimitReason> = new Set([
	"upstream_529_overloaded_with_reset",
	"upstream_529_overloaded_no_reset",
	"upstream_429_no_reset_probe_cooldown",
]);

/** Discriminated result from resolveAffinity(). */
type AffinityResolution =
	| { kind: "hit"; account: Account }
	| { kind: "hold"; heldAccountId: string }
	| { kind: "miss" }
	| { kind: "reassign"; previousAccountId: string };

export class SessionStrategy implements LoadBalancingStrategy {
	private sessionDurationMs: number;
	private store: StrategyStore | null = null;
	private log = new Logger("SessionStrategy");
	private pickSeq = 0;
	private lastPickedSeq = new Map<string, number>();
	private affinityByKey = new Map<
		string,
		{ accountId: string; lastUsedAt: number }
	>();

	constructor(
		sessionDurationMs: number = TIME_CONSTANTS.ANTHROPIC_SESSION_DURATION_DEFAULT,
	) {
		this.sessionDurationMs = sessionDurationMs;
	}

	initialize(store: StrategyStore): void {
		this.store = store;
	}

	private resetSessionIfExpired(account: Account): void {
		const now = Date.now();

		// Check if session has exceeded the fixed duration (only for providers that require session duration tracking)
		const fixedDurationExpired =
			requiresSessionDurationTracking(account.provider) &&
			(!account.session_start ||
				now - account.session_start >= this.sessionDurationMs);

		// Check if the account's rate limit window has reset
		// This helps Anthropic accounts better utilize their usage windows
		// Usage windows: Anthropic accounts with proactive rate limit headers (usage-based accounts)
		// No usage windows: Other account types or Anthropic console keys without usage windows
		const rateLimitWindowReset =
			account.provider === PROVIDER_NAMES.ANTHROPIC && // Explicit provider check for Anthropic usage windows
			account.rate_limit_reset &&
			account.rate_limit_reset < now - 1000; // 1 second buffer for clock skew protection

		if (fixedDurationExpired || rateLimitWindowReset) {
			// Reset session
			if (this.store) {
				const wasExpired = account.session_start !== null;
				const resetReason = rateLimitWindowReset
					? "rate limit window reset"
					: "fixed duration expired";
				this.log.info(
					wasExpired
						? `Session expired for account ${account.name} due to ${resetReason}, starting new session`
						: `Starting new session for account ${account.name}`,
				);
				this.store.resetAccountSession(account.id, now);

				// Update the account object to reflect changes
				account.session_start = now;
				account.session_request_count = 0;
			}
		}
	}

	/**
	 * Determines if an account has an active session based on provider requirements
	 * For Anthropic providers: checks if session is within the 5-hour window AND
	 * the account is not currently rate-limited
	 * For other providers: always returns false (no session stickiness for pay-as-you-go)
	 * @param account The account to check
	 * @param now Current timestamp
	 * @returns true if session is active (Anthropic only), false otherwise
	 */
	private hasActiveSession(account: Account, now: number): boolean {
		// Non-Anthropic providers (API-key-based, etc.) should not have persistent sessions
		// since they're pay-as-you-go and don't benefit from session stickiness
		if (!requiresSessionDurationTracking(account.provider)) {
			return false;
		}

		// An account that is currently rate-limited has no usable session, even
		// if its session_start is still inside the 5h Anthropic session window.
		// Treating it as active would re-pin requests to a known-throttled
		// upstream for the entire rate-limit window. Note we do NOT clear
		// session_start here — when the rate-limit window elapses the session
		// is conceptually still valid (5h Anthropic prompt-cache windows are
		// independent of rate-limit windows), so we'll resume the cached
		// session naturally on the next request after recovery. See issue #115.
		if (account.rate_limited_until && account.rate_limited_until > now) {
			return false;
		}

		// For Anthropic providers: check if session is active (within duration window)
		return (
			!!account.session_start &&
			now - account.session_start < this.sessionDurationMs
		);
	}

	/**
	 * Whether the account's session window is still valid, ignoring rate-limit
	 * state. Used by resolveAffinity to distinguish "session genuinely expired"
	 * (reassign) from "rate-limited but session conceptually alive" (hold/check).
	 *
	 * hasActiveSession() returns false for rate-limited accounts — correct for
	 * routing, but it would short-circuit the hold/reassign decision in affinity
	 * resolution. This helper separates the two concerns.
	 */
	private hasValidSessionWindow(account: Account, now: number): boolean {
		if (!requiresSessionDurationTracking(account.provider)) return true;
		return (
			!!account.session_start &&
			now - account.session_start < this.sessionDurationMs
		);
	}

	private getAffinityKey(meta: RequestMeta): string | null {
		const partition = meta.affinityPartition?.trim();
		const prefix = partition ? `partition:${partition}:` : "";
		const explicitKey = meta.affinityKey?.trim();
		if (explicitKey && meta.affinityScope) {
			return `${prefix}${meta.affinityScope}:${explicitKey}`;
		}
		const project = meta.project?.trim();
		if (!project) return null;
		return `${prefix}project:${project}`;
	}

	private getAffinityScope(
		meta: RequestMeta,
	): RequestMeta["affinityScope"] | null {
		if (meta.affinityKey?.trim() && meta.affinityScope) {
			return meta.affinityScope;
		}
		return meta.project?.trim() ? "project" : null;
	}

	private getAffinityLabel(meta: RequestMeta): string {
		return this.getAffinityScope(meta) ?? "request";
	}

	private setRoutingMeta(
		meta: RequestMeta,
		decision: string,
		selectedAccount: Account | null,
		candidatesCount: number,
		options: {
			affinityKey?: string | null;
			previousAccountId?: string | null;
			failoverReason?: string | null;
			/**
			 * The cache-affinity-pinned account id — set on affinity hit (the
			 * pinned account, which equals the selected account) and on affinity
			 * hold (the pinned-but-cooled account, NOT the served sibling). Lets the
			 * transparent burst-retry feature target the cache-warm account before
			 * the failover loop. Left undefined (→ null) for non-affinity picks.
			 */
			heldAccountId?: string | null;
		} = {},
	): void {
		meta.routing = {
			strategy: "session",
			decision,
			affinityScope: this.getAffinityScope(meta),
			affinityKey: options.affinityKey ?? this.getAffinityKey(meta),
			selectedAccountId: selectedAccount?.id ?? null,
			previousAccountId: options.previousAccountId ?? null,
			candidatesCount,
			failoverReason: options.failoverReason ?? null,
			heldAccountId: options.heldAccountId ?? null,
		};
	}

	private rememberAffinity(
		meta: RequestMeta,
		account: Account,
		now: number,
	): void {
		const key = this.getAffinityKey(meta);
		if (!key) return;
		this.affinityByKey.delete(key);
		this.affinityByKey.set(key, { accountId: account.id, lastUsedAt: now });
		this.pruneAffinity(now);
	}

	/**
	 * Clear every affinity pin currently pointing at the given account, so the
	 * projects/sessions that were stuck to it re-pick a fresh account on their
	 * next request. Returns the number of pins removed.
	 *
	 * This is the manual lever behind the dashboard "Reset session stickiness"
	 * action — used to migrate sessions off an account after a priority change.
	 * Note this only clears the affinity map; the account's active-session
	 * anchor (`session_start`) is cleared separately by the caller via the DB
	 * op `clearAccountSessionAnchor`, because the no-affinity `global_session`
	 * path re-sticks from `session_start`.
	 */
	clearAffinityForAccount(accountId: string): number {
		let cleared = 0;
		for (const [key, entry] of this.affinityByKey) {
			if (entry.accountId === accountId) {
				this.affinityByKey.delete(key);
				cleared++;
			}
		}
		return cleared;
	}

	private pruneAffinity(now: number): void {
		const staleBefore = now - this.sessionDurationMs;
		for (const [key, entry] of this.affinityByKey) {
			if (entry.lastUsedAt < staleBefore) {
				this.affinityByKey.delete(key);
			}
		}

		if (this.affinityByKey.size <= MAX_AFFINITY_ENTRIES) return;

		const overflow = this.affinityByKey.size - MAX_AFFINITY_ENTRIES;
		let removed = 0;
		for (const key of this.affinityByKey.keys()) {
			this.affinityByKey.delete(key);
			removed++;
			if (removed >= overflow) break;
		}
		this.log.warn(
			`Pruned ${removed} cache affinity entr${removed === 1 ? "y" : "ies"} after reaching ${MAX_AFFINITY_ENTRIES} entries`,
		);
	}

	/**
	 * Resolve the cache-affinity map entry for the given request.
	 *
	 * Returns one of:
	 *  - `hit`       — affined account is available; use it.
	 *  - `hold`      — affined account is transiently unavailable (short 429,
	 *                   529 overload, probe cooldown). Serve from the next best
	 *                   candidate WITHOUT overwriting affinity, so it snaps back
	 *                   when the original account recovers and its prompt cache
	 *                   is still warm.
	 *  - `reassign`  — affined account is durably gone (real 5h/7d exhaustion,
	 *                   manual pause, session expired, removed). Delete the
	 *                   affinity entry and pick a fresh account.
	 *  - `miss`      — no affinity entry exists for this key yet.
	 */
	private resolveAffinity(
		accounts: Account[],
		meta: RequestMeta,
		now: number,
		isAvailable: (account: Account) => boolean,
	): AffinityResolution {
		this.pruneAffinity(now);
		const key = this.getAffinityKey(meta);
		if (!key) return { kind: "miss" };

		const entry = this.affinityByKey.get(key);
		if (!entry) return { kind: "miss" };

		const account = accounts.find((a) => a.id === entry.accountId);

		// Account removed or session window genuinely expired → reassign.
		// Note: we check hasValidSessionWindow (ignores rate-limit state)
		// rather than hasActiveSession (returns false for rate-limited
		// accounts), because a rate-limited account with a valid session
		// window should flow into the hold/reassign decision below — not
		// be force-reassigned.
		if (!account || !this.hasValidSessionWindow(account, now)) {
			this.affinityByKey.delete(key);
			return { kind: "reassign", previousAccountId: entry.accountId };
		}

		// Account is available → use it.
		if (isAvailable(account)) {
			return { kind: "hit", account };
		}

		// Account is unavailable — decide whether to hold or reassign based on
		// the nature of the unavailability.
		if (this.isAffinityBreakingUnavailability(account, now)) {
			this.affinityByKey.delete(key);
			return { kind: "reassign", previousAccountId: entry.accountId };
		}

		// Transient unavailability — keep the affinity slot reserved so the
		// affinity snaps back to this account (and its warmed prompt cache)
		// once the cooldown lifts.
		return { kind: "hold", heldAccountId: entry.accountId };
	}

	/**
	 * Determine whether the account's current unavailability justifies
	 * permanently breaking cache affinity (reassign) vs temporarily
	 * serving elsewhere while holding the slot (hold).
	 *
	 * Affinity-breaking ("durable") conditions:
	 *  - Manual or failure-threshold pause (operator intervention required).
	 *  - Long rate-limit cooldown (>= AFFINITY_REASSIGN_MIN_COOLDOWN_MS) for a
	 *    non-server-wide reason — indicates real 5h/7d usage-window exhaustion.
	 *
	 * Affinity-preserving ("transient") conditions:
	 *  - 529 overload / probe cooldown — server-wide; switching doesn't help.
	 *  - Short rate-limit cooldown — per-minute throttle; resolves in seconds.
	 *  - Billing overage / peak-hours pause — auto-resumes on window reset.
	 */
	private isAffinityBreakingUnavailability(
		account: Account,
		now: number,
	): boolean {
		// Sticky pauses: operator must manually resume.
		if (account.paused) {
			const reason = account.pause_reason;
			return reason === "manual" || reason === "failure_threshold";
		}

		const until = account.rate_limited_until;
		if (!until || until <= now) return false;

		// 529 overload and probe cooldowns are server-wide or self-healing;
		// switching to a different account of the same provider does not help
		// and wastes the warmed prompt cache. Always hold.
		const rlReason = account.rate_limited_reason;
		if (rlReason && TRANSIENT_RATE_LIMIT_REASONS.has(rlReason)) {
			return false;
		}

		// A long remaining cooldown signals real 5h/7d usage-window exhaustion —
		// the account is out for hours, the prompt cache will be cold, and the
		// project benefits from being re-pinned to a healthy account.
		return until - now > AFFINITY_REASSIGN_MIN_COOLDOWN_MS;
	}

	/**
	 * Compute the per-account capacity metric used for FEFO ordering. Shared by
	 * the comparator (sortAvailableAccounts) and the selection debug log
	 * (logSelection) so the ranking the operator reads always matches the
	 * ranking traffic follows. Pure with respect to `account`/`now` — does not
	 * read the recency sequence (that lives in the comparator's tie-break).
	 */
	private capacityMetricFor(account: Account, now: number): CapacityMetric {
		const s =
			this.store?.getAccountCapacity?.(account.id, account.provider, now) ??
			null;
		// Legacy representative utilization — kept so providers without a capacity
		// model (Zai/Kilo/Alibaba) still balance least-used within the UNKNOWN bucket.
		const util =
			this.store?.getAccountUtilization?.(account.id, account.provider) ?? 0;
		let bucket: number = CAPACITY_BUCKET.UNKNOWN;
		let harvestDeadline = Number.POSITIVE_INFINITY;
		let weeklyHeadroom = 100;
		let soonest = Number.POSITIVE_INFINITY;
		let minHeadroom = 0;
		let binding = 0;
		if (s !== null) {
			minHeadroom = s.minHeadroom;
			binding = s.bindingUtilization;
			weeklyHeadroom = s.weeklyHeadroom;
			// The HARVEST deadline is the WEEKLY reset, never the always-sooner 5h.
			// No 5h fallback: an account without a weekly window is not harvestable.
			harvestDeadline = s.weeklyResetMs ?? Number.POSITIVE_INFINITY;
			// soonest is kept for the debug line only (5h context), not for ranking.
			soonest = s.soonestResetMs ?? Number.POSITIVE_INFINITY;
			if (
				s.minHeadroom <= HEADROOM_EPS ||
				s.bindingUtilization > 100 - HEADROOM_EPS
			) {
				// 5h safety gate: an account near any hard window's limit serves last.
				bucket = CAPACITY_BUCKET.NEAR_LIMIT;
			} else if (s.weeklyResetMs === null) {
				// No weekly deadline → not harvestable; do NOT rank via the 5h reset.
				bucket = CAPACITY_BUCKET.UNKNOWN;
			} else {
				bucket = CAPACITY_BUCKET.HARVEST;
			}
		}
		return {
			bucket,
			harvestDeadline,
			weeklyHeadroom,
			soonest,
			minHeadroom,
			binding,
			util,
		};
	}

	private sortAvailableAccounts(
		accounts: Account[],
		isAvailable: (account: Account) => boolean,
		now: number,
	): Account[] {
		const avail = accounts.filter((a) => isAvailable(a));
		// Snapshot per-account metrics once so the comparator stays pure/stable.
		const info = new Map<string, CapacityMetric & { seq: number }>();
		for (const a of avail) {
			info.set(a.id, {
				...this.capacityMetricFor(a, now),
				seq: this.lastPickedSeq.get(a.id) ?? 0,
			});
		}
		// Every account in `avail` was just inserted into `info`; the ?? fallback
		// is unreachable but keeps the comparator total without a non-null assert.
		const metricsFor = (id: string) =>
			info.get(id) ?? {
				bucket: CAPACITY_BUCKET.UNKNOWN,
				harvestDeadline: Number.POSITIVE_INFINITY,
				weeklyHeadroom: 100,
				soonest: Number.POSITIVE_INFINITY,
				minHeadroom: 0,
				binding: 0,
				util: 0,
				seq: 0,
			};
		return avail.sort((a, b) => {
			if (a.priority !== b.priority) return a.priority - b.priority;
			const x = metricsFor(a.id);
			const y = metricsFor(b.id);
			if (x.bucket !== y.bucket) return x.bucket - y.bucket;
			if (x.bucket === CAPACITY_BUCKET.HARVEST) {
				// FEFO on the WEEKLY window: serve the account whose weekly quota
				// expires soonest first (that's where unused budget is truly lost).
				if (x.harvestDeadline !== y.harvestDeadline)
					return x.harvestDeadline - y.harvestDeadline;
				// Tie on weekly reset → more weekly headroom to harvest wins.
				if (x.weeklyHeadroom !== y.weeklyHeadroom)
					return y.weeklyHeadroom - x.weeklyHeadroom;
				return x.seq - y.seq; // least-recently-picked
			}
			if (x.bucket === CAPACITY_BUCKET.UNKNOWN) {
				// Preserve legacy least-used ordering for non-capacity providers;
				// seq only breaks genuine ties (cold accounts with no usage data).
				if (x.util !== y.util) return x.util - y.util;
				return x.seq - y.seq;
			}
			// NEAR_LIMIT: least-utilized first, then least-recently-picked.
			if (x.binding !== y.binding) return x.binding - y.binding;
			return x.seq - y.seq;
		});
	}

	/**
	 * Emit a single compact DEBUG line explaining a select() decision. Filters
	 * to available accounts and ranks them through sortAvailableAccounts so the
	 * logged order is the real ranking — including when a sticky pick (affinity /
	 * session) overrides what FEFO would have chosen, which is visible because the
	 * chosen account (marked `*`) need not be first in the ranked list.
	 *
	 * Only constructs the string when DEBUG is actually enabled. Not called from
	 * peek() (read-only) or from inside sortAvailableAccounts (used for fallback
	 * tails too — would be noisy).
	 */
	private logSelection(
		decision: string,
		chosen: Account | null,
		accounts: Account[],
		isAvailable: (account: Account) => boolean,
		now: number,
	): void {
		// Avoid building the (potentially long) line when DEBUG is off.
		if (this.log.getLevel() > LogLevel.DEBUG) return;

		const ranked = this.sortAvailableAccounts(accounts, isAvailable, now);
		const MAX = 10;
		const shown = ranked.slice(0, MAX);
		const parts = shown.map((a) => {
			const m = this.capacityMetricFor(a, now);
			const bucketLabel = CAPACITY_BUCKET_LABEL[m.bucket] ?? "UNKNOWN";
			// reset= reflects the weekly deadline that actually drives HARVEST
			// ranking; the parenthesized 5h reset is shown for context only.
			const reset =
				m.harvestDeadline === Number.POSITIVE_INFINITY
					? "none"
					: `${Math.round((m.harvestDeadline - now) / 60000)}m`;
			const fiveHour =
				m.soonest === Number.POSITIVE_INFINITY
					? "none"
					: `${Math.round((m.soonest - now) / 60000)}m`;
			const mark = chosen && a.id === chosen.id ? "*" : "";
			return `${a.name}${mark}[${bucketLabel} reset=${reset}(5h=${fiveHour}) headroom=${Math.round(m.minHeadroom)}% util=${Math.round(m.util)}%]`;
		});
		if (ranked.length > MAX) parts.push(`(+${ranked.length - MAX} more)`);
		this.log.debug(
			`Selection [${decision}] chose ${chosen?.name ?? "none"} (* marks chosen): ${parts.join(" ")}`,
		);
	}

	private recordComparatorPick(account: Account): void {
		this.lastPickedSeq.set(account.id, ++this.pickSeq);
	}

	peek(accounts: Account[]): string | null {
		const now = Date.now();

		// isPeekAvailable simulates the auto-unpause that select() performs on
		// safe-reason paused accounts (auto_fallback_enabled + window elapsed).
		// Without it, peek() and select() disagree whenever such an account is
		// the would-be Primary, flagging the wrong row on the dashboard while
		// real traffic goes to the auto-unpaused one.
		const isAvailable = (account: Account): boolean =>
			isPeekAvailable(account, now);

		// peek() has no RequestMeta, so it has no per-request affinity. The
		// dashboard "Primary" badge it produces = where a FRESH request would
		// harvest = the FEFO pick. We deliberately do NOT mirror select()'s
		// global active-session stickiness here: real client traffic is
		// affinity-keyed and routes via FEFO on a miss, and keying the badge off
		// session_start made it stick to whichever account most recently STARTED a
		// session — including a 0-request session opened on an idle account during
		// post-restart warm-up — instead of the actual harvest target.
		const available = this.sortAvailableAccounts(accounts, isAvailable, now);
		const result = available[0]?.id ?? null;

		// Diagnostic: log the badge value ONLY when it changes (so we capture
		// every transition without spamming on each dashboard poll), with the
		// per-account buckets that drove it.
		this.logPeekChange(result, accounts, isAvailable, now);

		return result;
	}

	private lastPeekPrimary: string | null | undefined = undefined;

	private logPeekChange(
		result: string | null,
		accounts: Account[],
		isAvailable: (account: Account) => boolean,
		now: number,
	): void {
		if (result === this.lastPeekPrimary) return;
		const prev = this.lastPeekPrimary;
		this.lastPeekPrimary = result;
		if (this.log.getLevel() > LogLevel.DEBUG) return;
		const parts = accounts.map((a) => {
			const m = this.capacityMetricFor(a, now);
			const bucket = CAPACITY_BUCKET_LABEL[m.bucket] ?? "UNKNOWN";
			const wk =
				m.harvestDeadline === Number.POSITIVE_INFINITY
					? "none"
					: `${Math.round((m.harvestDeadline - now) / 60000)}m`;
			const sess =
				this.hasActiveSession(a, now) && a.session_start
					? `sess@${Math.round((now - a.session_start) / 60000)}m`
					: "no-sess";
			const avail = isAvailable(a) ? "" : " UNAVAIL";
			const mark = a.id === result ? "*" : "";
			return `${a.name}${mark}[${bucket} wk=${wk} util=${Math.round(m.util)}% ${sess}${avail}]`;
		});
		this.log.debug(
			`Peek primary changed ${prev ?? "none"} -> ${result ?? "none"} (* marks chosen): ${parts.join(" ")}`,
		);
	}

	select(accounts: Account[], meta: RequestMeta): Account[] {
		const now = Date.now();

		// Check if session tracking should be bypassed (for auto-refresh messages)
		const bypassHeader = meta.headers?.get("x-clankermux-bypass-session");
		const bypassSession = meta.internal === true && bypassHeader === "true";

		if (bypassSession) {
			this.log.debug("Session tracking bypassed due to bypass header");
		}

		// Cache availability checks within this request lifecycle
		const availabilityCache = new Map<string, boolean>();
		const getCachedAvailability = (account: Account): boolean => {
			if (!availabilityCache.has(account.id)) {
				availabilityCache.set(account.id, isAccountAvailable(account, now));
			}
			return availabilityCache.get(account.id) || false;
		};

		// Auto-unpause side-effect: recovered auto_fallback_enabled accounts that
		// were paused for a safe reason (overage / rate_limit_window) are returned
		// to the pool here, BEFORE affinity/session resolution runs, so they are
		// candidates for the affinity / fresh-pick paths below. We deliberately do
		// NOT early-return a re-sorted pool from this loop: pinned sessions stay on
		// their account (priority/FEFO govern only new/unpinned picks), and the
		// normal selection path already routes new sessions to the best available
		// account once the unpause has run.
		const fallbackCandidates = this.checkForAutoFallbackAccounts(accounts, now);
		const skippedByReason = new Map<string, string[]>();
		for (const candidate of fallbackCandidates) {
			// If the candidate is paused, only auto-unpause if it was paused due to
			// overage, or `rate_limit_window` (reserved/future pause reason) — never auto-unpause
			// manual or failure_threshold pauses.
			if (candidate.paused && this.store?.resumeAccount) {
				const canAutoUnpause =
					!candidate.pause_reason ||
					candidate.pause_reason === "overage" ||
					candidate.pause_reason === "rate_limit_window";
				if (canAutoUnpause) {
					this.log.info(
						`Unpausing account ${candidate.name} due to auto-fallback reactivation`,
					);
					this.store.resumeAccount(candidate.id);
					candidate.paused = false;
					// Invalidate the cache so getCachedAvailability reflects the unpause
					availabilityCache.delete(candidate.id);
				} else {
					const reason = candidate.pause_reason || "unknown";
					if (!skippedByReason.has(reason)) {
						skippedByReason.set(reason, []);
					}
					skippedByReason.get(reason)?.push(candidate.name);
				}
			}
		}

		for (const [reason, names] of skippedByReason) {
			this.log.info(
				`Skipping auto-unpause of ${names.length} account(s) paused for '${reason}': ${names.join(", ")}`,
			);
		}

		if (!bypassSession) {
			const affinityKey = this.getAffinityKey(meta);
			const previousAccountId = affinityKey
				? (this.affinityByKey.get(affinityKey)?.accountId ?? null)
				: null;
			const resolution = this.resolveAffinity(
				accounts,
				meta,
				now,
				getCachedAvailability,
			);

			if (resolution.kind === "hit") {
				const affinedAccount = resolution.account;
				// Affinity-first: a pinned session that is available ALWAYS keeps its
				// account, immune to priority edits and auto-fallback recovery.
				// Priority/FEFO govern only new/unpinned picks — never an established
				// pin while its account is healthy.
				this.resetSessionIfExpired(affinedAccount);
				this.rememberAffinity(meta, affinedAccount, now);
				this.log.info(
					`Continuing ${this.getAffinityLabel(meta)} affinity on account ${affinedAccount.name} (${affinedAccount.session_request_count} requests in session)`,
				);
				// FEFO-consistent fallback tail: order the non-sticky candidates
				// through the capacity comparator, not bare priority. The sticky
				// primary stays prepended.
				const others = this.sortAvailableAccounts(
					accounts.filter((a) => a.id !== affinedAccount.id),
					getCachedAvailability,
					now,
				);
				this.setRoutingMeta(
					meta,
					"affinity_hit",
					affinedAccount,
					others.length + 1,
					{
						affinityKey,
						previousAccountId,
						// The affined account IS the cache account and was selected; expose
						// it as the held account so a first-attempt transient 429 on it can
						// route into the hold path instead of diverting to a sibling.
						heldAccountId: affinedAccount.id,
					},
				);
				this.logSelection(
					"affinity_hit",
					affinedAccount,
					accounts,
					getCachedAvailability,
					now,
				);
				return [affinedAccount, ...others];
			}

			// The affined account is transiently unavailable (short 429, 529
			// overload, probe cooldown). Serve this request from the next best
			// candidate WITHOUT overwriting affinity, so the key snaps back
			// to its warmed account once the cooldown lifts. Switching providers
			// here is futile for server-wide overloads anyway.
			if (resolution.kind === "hold") {
				const available = this.sortAvailableAccounts(
					accounts,
					getCachedAvailability,
					now,
				);
				if (available.length === 0) {
					// STORM-DEGRADE (Finding 1): the pinned cache account AND every
					// sibling are cooled — there is no available candidate to serve THIS
					// request. We still record the held (cache-affinity) account in
					// routing meta before returning the empty list, so the proxy's
					// no-accounts terminal can run the transparent burst-retry HOLD on
					// the cache account instead of immediately 503-ing pool_exhausted.
					// Without this, the worst storm moment (all accounts cooled) would
					// bypass the hold entirely — exactly when holding the warm cache
					// account matters most. selectedAccount is null / 0 candidates here
					// (setRoutingMeta tolerates both); heldAccountId carries the pin.
					this.setRoutingMeta(meta, "affinity_hold", null, 0, {
						affinityKey,
						previousAccountId,
						heldAccountId: resolution.heldAccountId,
					});
					return [];
				}
				const chosenAccount = available[0];
				this.resetSessionIfExpired(chosenAccount);
				// NOTE: deliberately NOT calling rememberAffinity — the held
				// account keeps its claim on this affinity key.
				// Decision-point logging: surface WHY we held vs reassigned — the held
				// account's rate-limit reason, remaining cooldown, and which rule fired
				// (a transient/server-wide reason vs a short [<15min] cooldown). The
				// held account is the affinity-pinned one (resolution.heldAccountId); it
				// is present in `accounts` (resolveAffinity found it there).
				const heldAccount = accounts.find(
					(a) => a.id === resolution.heldAccountId,
				);
				const heldReason = heldAccount?.rate_limited_reason ?? null;
				const heldUntil = heldAccount?.rate_limited_until ?? null;
				const remainingMs = heldUntil && heldUntil > now ? heldUntil - now : 0;
				const heldRule =
					heldReason && TRANSIENT_RATE_LIMIT_REASONS.has(heldReason)
						? "transient-reason"
						: `short-cooldown(<${Math.round(AFFINITY_REASSIGN_MIN_COOLDOWN_MS / 60_000)}min)`;
				this.log.info(
					`Holding ${this.getAffinityLabel(meta)} affinity (account ${resolution.heldAccountId} temporarily unavailable) — serving from ${chosenAccount.name} this request; reason=${heldReason ?? "unknown"} remainingCooldownMs=${remainingMs} rule=${heldRule}`,
				);
				this.setRoutingMeta(
					meta,
					"affinity_hold",
					chosenAccount,
					available.length,
					{
						affinityKey,
						previousAccountId,
						// The pinned (cache-warm) account is cooled and a sibling is being
						// served this request — expose the PINNED account, not the served
						// sibling, so the burst-retry feature can hold/re-probe it.
						heldAccountId: resolution.heldAccountId,
					},
				);
				this.recordComparatorPick(chosenAccount);
				this.logSelection(
					"affinity_hold",
					chosenAccount,
					accounts,
					getCachedAvailability,
					now,
				);
				const others = available.filter((a) => a.id !== chosenAccount.id);
				return [chosenAccount, ...others];
			}

			// No affinity yet (miss) or the affined account is durably gone
			// (reassign). Choose a fresh candidate directly instead of inheriting
			// some other project's most-recent global session, and pin it. This
			// keeps each warmed project cache stable once assigned while still
			// honoring priority/utilization.
			if (
				affinityKey &&
				(resolution.kind === "miss" || resolution.kind === "reassign")
			) {
				const available = this.sortAvailableAccounts(
					accounts,
					getCachedAvailability,
					now,
				);
				if (available.length === 0) return [];
				const chosenAccount = available[0];
				this.resetSessionIfExpired(chosenAccount);
				this.rememberAffinity(meta, chosenAccount, now);
				const decision =
					resolution.kind === "reassign"
						? "affinity_reassigned"
						: "affinity_miss";
				this.setRoutingMeta(meta, decision, chosenAccount, available.length, {
					affinityKey,
					previousAccountId,
				});
				this.recordComparatorPick(chosenAccount);
				this.logSelection(
					decision,
					chosenAccount,
					accounts,
					getCachedAvailability,
					now,
				);
				const others = available.filter((a) => a.id !== chosenAccount.id);
				return [chosenAccount, ...others];
			}
		}

		// Find account with active session (most recent session_start within window)
		// Only for providers that require session duration tracking
		let activeAccount: Account | null = null;
		let mostRecentSessionStart = 0;

		for (const account of accounts) {
			if (
				this.hasActiveSession(account, now) &&
				account.session_start &&
				account.session_start > mostRecentSessionStart
			) {
				activeAccount = account;
				mostRecentSessionStart = account.session_start;
			}
		}

		// Log session tracking decisions for debugging
		if (activeAccount) {
			this.log.debug(
				`Active session found for account ${activeAccount.name} (provider: ${activeAccount.provider})`,
			);
		} else {
			this.log.debug(
				`No active sessions found, will select from available accounts`,
			);
		}

		// If we have an active account and it's available, use it. Affinity-first:
		// an established session keeps its account, immune to priority edits —
		// priority/FEFO govern only new/unpinned picks below.
		if (activeAccount && getCachedAvailability(activeAccount)) {
			// Reset session if expired (shouldn't happen but just in case)
			if (!bypassSession) {
				this.resetSessionIfExpired(activeAccount);
				this.rememberAffinity(meta, activeAccount, now);
			}
			this.log.info(
				`Continuing session for account ${activeAccount.name} (${activeAccount.session_request_count} requests in session)`,
			);
			// FEFO-consistent fallback tail: order the non-sticky candidates
			// through the capacity comparator, not bare priority. The sticky
			// primary stays prepended.
			const others = this.sortAvailableAccounts(
				accounts.filter((a) => a.id !== activeAccount.id),
				getCachedAvailability,
				now,
			);
			this.setRoutingMeta(
				meta,
				"global_session",
				activeAccount,
				others.length + 1,
			);
			this.logSelection(
				"global_session",
				activeAccount,
				accounts,
				getCachedAvailability,
				now,
			);
			return [activeAccount, ...others];
		}

		// No active session or active account is rate limited.
		// Filter available accounts and sort by priority (lower number = higher
		// priority). Within the same priority tier, break ties via the FEFO
		// capacity comparator (see sortAvailableAccounts) so the account whose
		// capacity expires soonest is harvested first.
		const available = this.sortAvailableAccounts(
			accounts,
			getCachedAvailability,
			now,
		);

		if (available.length === 0) return [];

		// Pick the highest priority account (first in sorted list) and start a new session with it
		const chosenAccount = available[0];
		if (!bypassSession) {
			this.resetSessionIfExpired(chosenAccount);
			this.rememberAffinity(meta, chosenAccount, now);
		}
		this.setRoutingMeta(
			meta,
			"priority_utilization",
			chosenAccount,
			available.length,
		);
		this.recordComparatorPick(chosenAccount);
		this.logSelection(
			"priority_utilization",
			chosenAccount,
			accounts,
			getCachedAvailability,
			now,
		);

		// Return chosen account first, then others as fallback (already sorted by priority)
		const others = available.filter((a) => a.id !== chosenAccount.id);
		return [chosenAccount, ...others];
	}

	/**
	 * Check for higher priority accounts that have auto-fallback enabled and have become available
	 * due to rate limit reset
	 */
	private checkForAutoFallbackAccounts(
		accounts: Account[],
		now: number,
	): Account[] {
		// Find accounts with auto-fallback enabled that:
		// 1. Have an API reset time that has passed (usage window has reset)
		// 2. Are not currently paused
		// 3. Are not currently in a rate limited state (rate_limited_until is in the past or null)
		const resetAccounts = accounts.filter((account) => {
			if (!account.auto_fallback_enabled) return false;
			// Note: We check paused status AFTER filtering for auto-fallback enabled accounts
			// This allows paused accounts with auto-fallback to be considered for reactivation

			// Check if the API usage window has reset for auto-fallback
			const supportsWindowReset =
				account.provider === PROVIDER_NAMES.ANTHROPIC ||
				account.provider === PROVIDER_NAMES.CODEX ||
				account.provider === PROVIDER_NAMES.ZAI;
			const providerWindowReset =
				supportsWindowReset &&
				account.rate_limit_reset &&
				account.rate_limit_reset < now - 1000; // 1 second buffer for clock skew protection

			// Check if the account is not currently rate limited by our system
			const notRateLimited =
				!account.rate_limited_until || account.rate_limited_until <= now;

			return providerWindowReset && notRateLimited;
		});

		if (resetAccounts.length === 0) return [];

		// Sort by priority (lower number = higher priority)
		return resetAccounts.sort((a, b) => a.priority - b.priority);
	}
}
