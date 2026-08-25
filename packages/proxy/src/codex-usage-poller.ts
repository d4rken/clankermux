import { registerHeartbeat } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import {
	computeDemandAwareInterval,
	computePollDelay,
	IDLE_REFRESH_LEAD_MS,
	USAGE_CACHE_TTL_MS,
} from "@clankermux/providers";

const log = new Logger("CodexUsagePoller");

/**
 * How often the poller re-evaluates its per-account schedule. This is NOT the
 * poll cadence — it is the granularity at which due times are checked, account
 * additions/removals are noticed, and resumed traffic can pull an idle account
 * back to the active cadence. Real network reads happen only when an account's
 * demand-aware due time has arrived.
 */
const HEARTBEAT_SECONDS = 30;

/** The slice of an account row the poller needs. */
export interface PolledCodexAccount {
	id: string;
	name: string;
	access_token: string | null;
	refresh_token: string | null;
	/** Persisted last-request time — the demand-aware activity signal. */
	last_used: number | null;
}

/**
 * Injected seams. Production wiring (apps/server) passes the real DB listing,
 * `CodexSpendCoordinator.readUsageStatus`, a `usageCache.peekWithAge` projection
 * and the configured active poll interval; tests pass fakes. Deliberately a
 * plain dependency object rather than a ProxyContext so the schedule logic is
 * testable without a database or coordinator.
 */
export interface CodexUsagePollerDeps {
	/** All codex-provider accounts, paused ones included (usage reads are free). */
	listCodexAccounts(): Promise<PolledCodexAccount[]>;
	/**
	 * Perform one zero-cost usage read (`GET /wham/usage`) and apply it through
	 * the shared codex bookkeeping. The coordinator's own in-flight dedup,
	 * 401-recovery and supersession guards all apply — this poller only decides
	 * WHEN to call it.
	 */
	readUsage(accountId: string): Promise<{ success: boolean; message: string }>;
	/**
	 * Observation time (ms since epoch) of the account's current usage-cache
	 * entry, or null when there is no entry or it is UNTIMED (a post-restart
	 * payload rebuild — exactly the state a poll should replace).
	 */
	peekObservedAtMs(accountId: string): number | null;
	/** The configured active poll cadence (shared with the Anthropic poller). */
	activeIntervalMs(): number;
	/** Clock seam for tests. */
	now?(): number;
	/** Jitter seam: a value in [-0.2, 0.2]; tests pass () => 0. */
	jitterFraction?(): number;
}

interface AccountPollState {
	dueAt: number;
	isIdle: boolean;
	failures: number;
	/** Whether the last completed read failed — drives transition-only logging. */
	lastReadFailed: boolean;
}

/**
 * Demand-aware usage poller for Codex accounts, mirroring the Anthropic
 * `/oauth/usage` poller's cadence policy on top of the FREE `GET /wham/usage`
 * read (zero quota — see CodexSpendCoordinator.readUsageStatus).
 *
 * Why it exists: the usage snapshot sampler is a pure read-through observer, and
 * before this poller the Codex usage cache was only warmed by live `/responses`
 * traffic — so snapshots existed only during active bursts, every idle gap broke
 * the quota-drift observation runs, and a post-restart cache rebuilt from a
 * retained payload (UNTIMED, observation time unknown) was skipped by the
 * sampler until the next real request. The poller closes all three gaps:
 *
 *  - ACTIVE accounts (recent `last_used`) are covered by their own traffic; the
 *    poller reads only when the cache lacks a timed reading younger than one
 *    active interval, so it adds near-zero requests while traffic flows.
 *  - IDLE accounts are read on the shared idle cadence
 *    (min(10min, USAGE_CACHE_TTL_MS - IDLE_REFRESH_LEAD_MS) ≈ 9min via
 *    computePollDelay's clamp). That spacing is deliberately inside the
 *    quota-drift MAX_SAMPLE_GAP (15min) on the observation clock, so idle
 *    periods no longer break runs.
 *  - Failures back off exponentially (computePollDelay, 30min cap), so a dead
 *    or reauth-needing account costs one lightweight failed GET per half hour.
 *
 * Scheduling is a 30s heartbeat over per-account due times rather than
 * per-account timers: with a handful of codex accounts the heartbeat is cheap,
 * account add/remove is picked up on the next beat with no registration
 * choreography, and there is no generation machinery to keep correct.
 */
export class CodexUsagePoller {
	private readonly deps: CodexUsagePollerDeps;
	private readonly state = new Map<string, AccountPollState>();
	private unregisterHeartbeat: (() => void) | null = null;
	private tickInFlight = false;
	/**
	 * Set by stop(). A tick that is mid-batch when stop() runs checks this before
	 * every account and before writing any schedule, so shutdown never keeps
	 * initiating new network reads for the rest of the batch.
	 */
	private stopped = false;

	constructor(deps: CodexUsagePollerDeps) {
		this.deps = deps;
	}

	start(): void {
		if (this.unregisterHeartbeat) {
			log.warn("Codex usage poller already running");
			return;
		}
		log.info("Starting Codex usage poller");
		this.stopped = false;
		this.unregisterHeartbeat = registerHeartbeat({
			id: "codex-usage-poller",
			callback: () => void this.tick(),
			seconds: HEARTBEAT_SECONDS,
			description: "Zero-cost Codex usage polling (GET /wham/usage)",
		});
		void this.tick();
	}

	stop(): void {
		this.stopped = true;
		if (this.unregisterHeartbeat) {
			this.unregisterHeartbeat();
			this.unregisterHeartbeat = null;
			log.info("Codex usage poller stopped");
		}
		this.state.clear();
	}

	/**
	 * One schedule evaluation. Public so tests can drive it with a controlled
	 * clock; production only ever calls it from the heartbeat. Overlap-guarded:
	 * a beat that lands while the previous evaluation is still awaiting network
	 * or DB work returns immediately (the work is already happening).
	 */
	async tick(): Promise<void> {
		if (this.tickInFlight) return;
		this.tickInFlight = true;
		try {
			await this.evaluate();
		} catch (error) {
			log.warn(
				`Codex usage poller tick failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			this.tickInFlight = false;
		}
	}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	private jitterFraction(): number {
		return this.deps.jitterFraction?.() ?? (Math.random() - 0.5) * 0.4;
	}

	private async evaluate(): Promise<void> {
		const accounts = await this.deps.listCodexAccounts();

		// Prune state for accounts that no longer exist, so a later re-add starts
		// fresh (due immediately) instead of inheriting a stale schedule.
		const liveIds = new Set(accounts.map((a) => a.id));
		for (const id of this.state.keys()) {
			if (!liveIds.has(id)) this.state.delete(id);
		}

		for (const account of accounts) {
			if (this.stopped) return;
			// No credentials at all: a read would fail before reaching the network.
			// Keep no schedule; the account is re-checked on every heartbeat and
			// picked up the moment tokens appear (e.g. after an OAuth flow).
			if (!account.access_token && !account.refresh_token) {
				this.state.delete(account.id);
				continue;
			}
			// Per-account isolation: readUsage normally reports failure as an
			// outcome, but its DB lookups can still reject — one throwing account
			// must not abort the batch and starve the accounts behind it.
			try {
				await this.evaluateAccount(account);
			} catch (error) {
				this.recordThrownRead(account, error);
			}
		}
	}

	/**
	 * A read that THREW (rather than returning a failure outcome) counts toward
	 * the same failure streak, so a persistently-throwing account backs off
	 * exponentially instead of retrying on every heartbeat.
	 */
	private recordThrownRead(account: PolledCodexAccount, error: unknown): void {
		const state = this.state.get(account.id);
		if (!state || this.stopped) return;
		state.failures += 1;
		state.lastReadFailed = true;
		log.warn(
			`Codex usage poll threw for account ${account.name} (${state.failures} consecutive): ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		const { delayMs, isIdle } = computePollDelay({
			demandAware: true,
			activeIntervalMs: this.deps.activeIntervalMs(),
			lastActivityMs: account.last_used,
			failures: state.failures,
			retryAfterMs: null,
			now: this.now(),
			jitterFraction: this.jitterFraction(),
		});
		state.dueAt = this.now() + delayMs;
		state.isIdle = isIdle;
	}

	private async evaluateAccount(account: PolledCodexAccount): Promise<void> {
		const now = this.now();
		const activeIntervalMs = this.deps.activeIntervalMs();
		let state = this.state.get(account.id);
		if (!state) {
			state = { dueAt: now, isIdle: false, failures: 0, lastReadFailed: false };
			this.state.set(account.id, state);
		}

		// Idle→active pull-in, mirroring UsageCache.noteActivity: an account
		// sleeping on the ~9min idle schedule whose traffic just resumed should not
		// wait out that sleep. Only when the pending wake is more than one active
		// interval (plus max jitter) away — otherwise re-arming gains nothing.
		if (state.isIdle && state.dueAt - now > activeIntervalMs * 1.2) {
			const { isIdle } = computeDemandAwareInterval(
				{ demandAware: true },
				account.last_used,
				activeIntervalMs,
				now,
			);
			if (!isIdle) {
				state.dueAt = now;
				state.isIdle = false;
			}
		}

		// Freshness threshold for "a poll now would be redundant". Two bounds keep
		// it strictly below every delay the healthy scheduler can produce, so a
		// due poll can never classify ITS OWN previous reading as fresh (which
		// would skip the poll, double the real cadence, and break the ≤15min
		// observation-gap contract the poller exists to uphold):
		//  - min(active, TTL - lead): computePollDelay clamps every demand-aware
		//    delay to that cap, while the configured interval may be up to 1h;
		//  - × 0.8: the worst-case downward jitter (active is symmetric ±20%,
		//    idle folds to negative-only −10%), so even the earliest jittered poll
		//    still sees the previous reading as stale.
		const freshnessMs =
			0.8 *
			Math.min(activeIntervalMs, USAGE_CACHE_TTL_MS - IDLE_REFRESH_LEAD_MS);
		const isTrafficFresh = () => {
			const observedAtMs = this.deps.peekObservedAtMs(account.id);
			return observedAtMs !== null && now - observedAtMs < freshnessMs;
		};

		if (now < state.dueAt) {
			// A fresh TIMED reading arriving while a failure BACKOFF is pending is
			// positive evidence acquisition recovered (traffic or a manual refresh
			// repopulated the cache). Convert the backoff into the healthy cadence
			// now instead of serving out up to 30 minutes of it — without this, the
			// first poll after recovery could sit a full backoff away from that
			// lone reading and break the observation run anyway.
			if (state.failures > 0 && isTrafficFresh()) {
				state.failures = 0;
				state.lastReadFailed = false;
				const { delayMs, isIdle } = computePollDelay({
					demandAware: true,
					activeIntervalMs,
					lastActivityMs: account.last_used,
					failures: 0,
					retryAfterMs: null,
					now,
					jitterFraction: this.jitterFraction(),
				});
				state.dueAt = now + delayMs;
				state.isIdle = isIdle;
			}
			return;
		}

		// Real traffic keeps the cache fresh with TIMED readings; a poll on top
		// would be redundant. An UNTIMED entry (peekObservedAtMs → null, the
		// post-restart payload rebuild) never satisfies this and is replaced by a
		// real read immediately.
		const trafficFresh = isTrafficFresh();

		if (trafficFresh) {
			// A fresh TIMED reading is positive evidence acquisition works, however
			// it arrived — clear any failure streak so a recovered account does not
			// serve out a stale multi-minute backoff before its next real read.
			state.failures = 0;
			state.lastReadFailed = false;
		} else {
			const outcome = await this.deps.readUsage(account.id);
			if (this.stopped) return;
			if (outcome.success) {
				if (state.lastReadFailed) {
					log.info(
						`Codex usage poll recovered for account ${account.name}: ${outcome.message}`,
					);
				}
				state.failures = 0;
				state.lastReadFailed = false;
			} else {
				state.failures += 1;
				// Transition to failing at info, repeats at debug — a standby account
				// with an expired token fails here on every attempt by design.
				const logFn = state.lastReadFailed
					? log.debug.bind(log)
					: log.info.bind(log);
				logFn(
					`Codex usage poll failed for account ${account.name} (${state.failures} consecutive): ${outcome.message}`,
				);
				state.lastReadFailed = true;
			}
		}

		// A "successful" read can still leave the cache UNTIMED: the coordinator
		// reports success when its GET was superseded by a newer cache write, and
		// that newer write can be an UNTIMED payload reconstruction (the accounts
		// endpoint racing this poller just after a restart). Sleeping the full
		// idle interval on that outcome would leave the sampler blind for another
		// cycle — retry at the active cadence until a TIMED reading exists.
		const timedAfterRead = this.deps.peekObservedAtMs(account.id) !== null;

		// Schedule the next evaluation from the CURRENT clock (the read above may
		// have taken a while). Failure backoff wins inside computePollDelay.
		const { delayMs, isIdle } = computePollDelay({
			demandAware: true,
			activeIntervalMs,
			// An untimed cache forces the ACTIVE branch (recent-activity signal) so
			// the retry lands one active interval out rather than ~9min out.
			lastActivityMs: timedAfterRead ? account.last_used : this.now(),
			failures: state.failures,
			retryAfterMs: null,
			now: this.now(),
			jitterFraction: this.jitterFraction(),
		});
		state.dueAt = this.now() + delayMs;
		state.isIdle = isIdle;
	}
}
