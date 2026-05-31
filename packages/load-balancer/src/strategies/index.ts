import { isAccountAvailable, TIME_CONSTANTS } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
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

	private sortAvailableAccounts(
		accounts: Account[],
		isAvailable: (account: Account) => boolean,
	): Account[] {
		return accounts
			.filter((a) => isAvailable(a))
			.sort((a, b) => {
				if (a.priority !== b.priority) return a.priority - b.priority;
				// Treat null as 0: an account with no usage data is assumed fresh
				// (maximum remaining capacity). This prevents newly-added accounts
				// from being permanently sidelined until all others expire.
				const utilA =
					this.store?.getAccountUtilization?.(a.id, a.provider) ?? 0;
				const utilB =
					this.store?.getAccountUtilization?.(b.id, b.provider) ?? 0;
				return utilA - utilB;
			});
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

		// Mirror the auto-fallback path from select(), but without unpausing.
		// When fallback would trigger, select() re-evaluates the priority queue
		// and returns the highest-priority available account — chosenFallback
		// only ends up first if it happens to outrank everyone else. Peek must
		// match that, otherwise a lower-priority fallback candidate gets
		// flagged Primary while a higher-priority non-fallback account is the
		// one that would actually be picked.
		const fallbackCandidates = this.checkForAutoFallbackAccounts(accounts, now);
		const fallbackTriggered = fallbackCandidates.some((c) => isAvailable(c));
		if (fallbackTriggered) {
			const sorted = this.sortAvailableAccounts(accounts, isAvailable);
			return sorted[0]?.id ?? null;
		}

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

		if (activeAccount && isAvailable(activeAccount)) {
			const higherPriorityAccount = accounts
				.filter(
					(a) =>
						a.id !== activeAccount.id &&
						isAvailable(a) &&
						a.priority < activeAccount.priority,
				)
				.sort((a, b) => a.priority - b.priority)[0];

			if (!higherPriorityAccount) {
				return activeAccount.id;
			}
		}

		const available = accounts
			.filter((a) => isAvailable(a))
			.sort((a, b) => {
				if (a.priority !== b.priority) return a.priority - b.priority;
				const utilA =
					this.store?.getAccountUtilization?.(a.id, a.provider) ?? 0;
				const utilB =
					this.store?.getAccountUtilization?.(b.id, b.provider) ?? 0;
				return utilA - utilB;
			});

		return available[0]?.id ?? null;
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

		// Check for higher priority accounts that have become available due to rate limit reset.
		// Iterate through all candidates in priority order to find the first usable one.
		const fallbackCandidates = this.checkForAutoFallbackAccounts(accounts, now);
		let chosenFallback: Account | null = null;
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
					continue;
				}
			}

			if (getCachedAvailability(candidate)) {
				chosenFallback = candidate;
				break;
			}
		}

		for (const [reason, names] of skippedByReason) {
			this.log.info(
				`Skipping auto-unpause of ${names.length} account(s) paused for '${reason}': ${names.join(", ")}`,
			);
		}

		if (chosenFallback !== null) {
			const available = this.sortAvailableAccounts(
				accounts,
				getCachedAvailability,
			);
			const servingAccount = available[0] ?? chosenFallback;

			if (!bypassSession) {
				this.resetSessionIfExpired(servingAccount);
				this.rememberAffinity(meta, servingAccount, now);
			}
			this.log.info(
				`Auto-fallback triggered to account ${chosenFallback.name} (priority: ${chosenFallback.priority}, auto-fallback enabled)`,
			);
			// Return all available accounts sorted by priority — chosenFallback will appear
			// first naturally if it is the highest-priority available account, avoiding
			// priority inversion when other accounts rank higher.
			this.setRoutingMeta(
				meta,
				"auto_fallback",
				servingAccount,
				available.length,
			);
			return available;
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
				const higherPriorityAccount = accounts
					.filter(
						(a) =>
							a.id !== affinedAccount.id &&
							getCachedAvailability(a) &&
							a.priority < affinedAccount.priority,
					)
					.sort((a, b) => a.priority - b.priority)[0];

				if (!higherPriorityAccount) {
					this.resetSessionIfExpired(affinedAccount);
					this.rememberAffinity(meta, affinedAccount, now);
					this.log.info(
						`Continuing ${this.getAffinityLabel(meta)} affinity on account ${affinedAccount.name} (${affinedAccount.session_request_count} requests in session)`,
					);
					const others = accounts
						.filter(
							(a) => a.id !== affinedAccount.id && getCachedAvailability(a),
						)
						.sort((a, b) => a.priority - b.priority);
					this.setRoutingMeta(
						meta,
						"affinity_hit",
						affinedAccount,
						others.length + 1,
						{ affinityKey, previousAccountId },
					);
					return [affinedAccount, ...others];
				}

				// Priority beats stickiness: route to the highest-priority
				// available account and re-pin affinity there. (The user's
				// explicit priority ranking takes precedence over cache warmth.)
				this.log.info(
					`Skipping ${this.getAffinityLabel(meta)} affinity on account ${affinedAccount.name} (priority: ${affinedAccount.priority}) — higher-priority account ${higherPriorityAccount.name} (priority: ${higherPriorityAccount.priority}) is available`,
				);
				const available = this.sortAvailableAccounts(
					accounts,
					getCachedAvailability,
				);
				if (available.length === 0) return [];
				const chosenAccount = available[0];
				this.resetSessionIfExpired(chosenAccount);
				this.rememberAffinity(meta, chosenAccount, now);
				this.setRoutingMeta(
					meta,
					"affinity_reassigned",
					chosenAccount,
					available.length,
					{ affinityKey, previousAccountId },
				);
				const others = available.filter((a) => a.id !== chosenAccount.id);
				return [chosenAccount, ...others];
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
				);
				if (available.length === 0) return [];
				const chosenAccount = available[0];
				this.resetSessionIfExpired(chosenAccount);
				// NOTE: deliberately NOT calling rememberAffinity — the held
				// account keeps its claim on this affinity key.
				this.log.info(
					`Holding ${this.getAffinityLabel(meta)} affinity (account ${resolution.heldAccountId} temporarily unavailable) — serving from ${chosenAccount.name} this request`,
				);
				this.setRoutingMeta(
					meta,
					"affinity_hold",
					chosenAccount,
					available.length,
					{ affinityKey, previousAccountId },
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
				);
				if (available.length === 0) return [];
				const chosenAccount = available[0];
				this.resetSessionIfExpired(chosenAccount);
				this.rememberAffinity(meta, chosenAccount, now);
				this.setRoutingMeta(
					meta,
					resolution.kind === "reassign"
						? "affinity_reassigned"
						: "affinity_miss",
					chosenAccount,
					available.length,
					{ affinityKey, previousAccountId },
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

		// If we have an active account and it's available, use it — unless a higher-priority
		// non-session account is available (priority is more important than stickiness).
		if (activeAccount && getCachedAvailability(activeAccount)) {
			// Check if any available account has strictly higher priority than the active session account
			const higherPriorityAccount = accounts
				.filter(
					(a) =>
						a.id !== activeAccount.id &&
						getCachedAvailability(a) &&
						a.priority < activeAccount.priority,
				)
				.sort((a, b) => a.priority - b.priority)[0];

			if (higherPriorityAccount) {
				this.log.info(
					`Skipping session on account ${activeAccount.name} (priority: ${activeAccount.priority}) — higher-priority account ${higherPriorityAccount.name} (priority: ${higherPriorityAccount.priority}) is available`,
				);
				// Fall through to normal priority-based selection below by nulling activeAccount
			} else {
				// Reset session if expired (shouldn't happen but just in case)
				if (!bypassSession) {
					this.resetSessionIfExpired(activeAccount);
					this.rememberAffinity(meta, activeAccount, now);
				}
				this.log.info(
					`Continuing session for account ${activeAccount.name} (${activeAccount.session_request_count} requests in session)`,
				);
				// Return active account first, then others as fallback (sorted by priority)
				const others = accounts
					.filter((a) => a.id !== activeAccount.id && getCachedAvailability(a))
					.sort((a, b) => a.priority - b.priority);
				this.setRoutingMeta(
					meta,
					"global_session",
					activeAccount,
					others.length + 1,
				);
				return [activeAccount, ...others];
			}
		}

		// No active session or active account is rate limited
		// Filter available accounts and sort by priority (lower number = higher priority).
		// Within the same priority, break ties by utilization (ascending) so that the
		// account with the most remaining capacity is chosen first.
		const available = this.sortAvailableAccounts(
			accounts,
			getCachedAvailability,
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
