import {
	FAMILY_PRIORITY,
	normalizeAnthropicUsage,
	PAUSE_REASON_NEEDS_REAUTH,
} from "@clankermux/core";
import type {
	AccountPauseMarker,
	AnthropicBankedResetEventRow,
} from "@clankermux/database";
import { Logger } from "@clankermux/logger";
import {
	anthropicBankedResetCache,
	canFetchAnthropicProfile,
	claimAnthropicBankedReset,
	fetchAnthropicBankedResetStatus,
	fetchAnthropicProfile,
	USAGE_RATE_LIMITED_DEFAULT_MS,
	type UsageData,
	usageCache,
} from "@clankermux/providers";
import {
	type Account,
	ANTHROPIC_BANKED_RESET_REPLAY_WINDOW_MS,
	type AnthropicBankedResetClaimRequest,
	type AnthropicBankedResetClaimResult,
	type AnthropicBankedResetEventStatus,
	type AnthropicBankedResetStatus,
	type AnthropicBankedResetWindow,
	type AnthropicUsageData,
} from "@clankermux/types";
import { clearFamilyWeeklyExhausted } from "./family-weekly-memo";
import type { ProxyContext } from "./handlers/proxy-types";
import {
	type AnthropicBankedResetClaimDispatchOutcome,
	type AnthropicBankedResetRefreshOutcome,
	getValidAccessToken,
	refreshAccessTokenSafe,
} from "./handlers/token-manager";
import {
	type ReadGate,
	type ReadTurn,
	SpacedReadGate,
} from "./spaced-read-gate";

const log = new Logger("AnthropicBankedResets");

/**
 * `reason` of a manual row resolved `failed` without its POST ever being
 * sent, as opposed to `unconfirmed`: given up when its replay window closed.
 */
export const BANKED_RESET_NOT_SENT_REASON = "not_sent";

/**
 * How long a spent reset whose post-claim usage read was unavailable keeps
 * owing the account's overage pause a verdict.
 */
export const BANKED_RESET_RECOVERY_WINDOW_MS = 60 * 60_000;

/**
 * What a usage reading says about lifting an overage pause after a reset:
 * both the 5-hour and weekly windows known and below their limit (`lift`),
 * either at its limit (`exhausted`), or either missing (`unknown`).
 */
export function overagePauseVerdict(
	usage: UsageData | null,
	now: number,
):
	| { kind: "lift" }
	| { kind: "exhausted"; detail: string }
	| { kind: "unknown" } {
	const normalized = normalizeAnthropicUsage(
		usage as unknown as AnthropicUsageData | null,
		now,
	);
	if (!normalized.session || !normalized.weeklyAll) return { kind: "unknown" };
	if (
		normalized.session.utilization >= 100 ||
		normalized.weeklyAll.utilization >= 100
	) {
		return {
			kind: "exhausted",
			detail: `5h ${normalized.session.utilization}%, weekly ${normalized.weeklyAll.utilization}%`,
		};
	}
	return { kind: "lift" };
}

/** First wait before replaying a claim that got no answer. */
export const BANKED_RESET_CLAIM_RETRY_MIN_MS = 60_000;
export const BANKED_RESET_CLAIM_RETRY_MAX_MS = 15 * 60_000;

/** Server answers that settle a claim; everything else leaves it pending. */
const RESOLVING_RESULTS: ReadonlySet<string> =
	new Set<AnthropicBankedResetEventStatus>([
		"reset",
		"already_used",
		"not_limited",
		"cooldown",
		"ineligible",
	]);

/**
 * When a claim that got no answer may be replayed. Without a Retry-After the
 * wait equals the time the claim has been open (at least a minute, at most 15),
 * which doubles it on every retry.
 */
export function bankedResetClaimRetryDelayMs(
	createdAt: number,
	now: number,
	retryAfterMs: number | null,
): number {
	if (retryAfterMs !== null) return retryAfterMs;
	return Math.min(
		BANKED_RESET_CLAIM_RETRY_MAX_MS,
		Math.max(BANKED_RESET_CLAIM_RETRY_MIN_MS, now - createdAt),
	);
}

/** Resets left across every grant. */
export function bankedResetsLeftTotal(
	status: AnthropicBankedResetStatus,
): number {
	return status.grants.reduce((sum, grant) => sum + grant.resetsLeft, 0);
}

/**
 * The proxy's own overage pause, the only one a restored week lifts: the rule
 * resumeIfOveragePaused applies in SQL.
 */
export function isOveragePause(marker: AccountPauseMarker): boolean {
	return (
		marker.paused &&
		marker.autoPauseOnOverageEnabled &&
		(marker.pauseReason === null || marker.pauseReason === "overage")
	);
}

function notYetDue(row: AnthropicBankedResetEventRow, now: number): boolean {
	return row.next_attempt_at !== null && row.next_attempt_at > now;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A ledger row's `cleared` JSON; empty when absent or unparseable. */
export function parseCleared(
	value: string | null,
): AnthropicBankedResetWindow[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter(
					(entry): entry is AnthropicBankedResetWindow =>
						typeof entry === "string",
				)
			: [];
	} catch {
		return [];
	}
}

export interface AnthropicBankedResetCoordinatorDeps {
	getValidAccessToken?: typeof getValidAccessToken;
	refreshAccessTokenSafe?: typeof refreshAccessTokenSafe;
	fetchStatus?: typeof fetchAnthropicBankedResetStatus;
	claim?: typeof claimAnthropicBankedReset;
	fetchProfile?: typeof fetchAnthropicProfile;
	canFetchProfile?: typeof canFetchAnthropicProfile;
	usage?: Pick<
		typeof usageCache,
		| "fenceAndRefetch"
		| "get"
		| "noteRateLimited"
		| "getRateLimitedUntil"
		| "noteAnthropicUsageRead"
	>;
	now?: () => number;
	/** Spaces status reads of different accounts; one per coordinator. */
	readGate?: ReadGate;
	/**
	 * Lifts the account's cooldown for the windows a claim reports cleared.
	 * `claimStartedAt` is when the claim was sent.
	 */
	onWindowsRestored?: (
		accountId: string,
		cleared: AnthropicBankedResetWindow[],
		claimStartedAt: number,
	) => Promise<void>;
}

/** Gap between status reads of different accounts, jittered up to 1.5×. */
export const ANTHROPIC_BANKED_RESET_READ_SPACING_MS = 3_000;

type LedgerTarget =
	| {
			kind: "post";
			rowId: string;
			createdAt: number;
			/** The row was pending before this call, so an earlier POST may have landed. */
			replay: boolean;
			/** A manual row written by this call: no POST under its request id yet. */
			createdHere: boolean;
	  }
	| { kind: "settled"; row: AnthropicBankedResetEventRow }
	| {
			kind: "refused";
			outcome: Extract<
				AnthropicBankedResetClaimDispatchOutcome,
				{ status: "failed" }
			>;
	  };

/**
 * The single authority for Anthropic banked resets (Claude Code's
 * `cedar_ember` program): the status read, which shares its rate-limit bucket
 * with the usage poll, and the claim, which spends a reset.
 *
 * Every claim has a ledger row written `pending` before its POST, and replays
 * reuse the row's request id, which the server deduplicates on, but only
 * within ANTHROPIC_BANKED_RESET_REPLAY_WINDOW_MS of the row opening. A
 * restoring claim lifts the quota cooldown of the windows it cleared through
 * `onWindowsRestored`, and fences the usage cache and refetches: an overage
 * pause and the weekly usage throttle wait for that post-claim reading.
 * `rate_limit_reset` is never nulled for an Anthropic account (a paused one
 * could not auto-unpause again).
 */
export class AnthropicBankedResetCoordinator {
	private readonly ctx: ProxyContext;
	private readonly getValidAccessToken: typeof getValidAccessToken;
	private readonly refreshAccessTokenSafe: typeof refreshAccessTokenSafe;
	private readonly fetchStatus: typeof fetchAnthropicBankedResetStatus;
	private readonly claimReset: typeof claimAnthropicBankedReset;
	private readonly fetchProfile: typeof fetchAnthropicProfile;
	private readonly canFetchProfile: typeof canFetchAnthropicProfile;
	private readonly usage: NonNullable<
		AnthropicBankedResetCoordinatorDeps["usage"]
	>;
	private readonly now: () => number;
	private readonly readGate: ReadGate;
	private readonly onWindowsRestored: AnthropicBankedResetCoordinatorDeps["onWindowsRestored"];
	private readonly statusInflight = new Map<
		string,
		Promise<AnthropicBankedResetRefreshOutcome>
	>();
	private readonly claimInflight = new Map<
		string,
		{
			requestId: string;
			promise: Promise<AnthropicBankedResetClaimDispatchOutcome>;
		}
	>();

	constructor(
		ctx: ProxyContext,
		deps: AnthropicBankedResetCoordinatorDeps = {},
	) {
		this.ctx = ctx;
		this.getValidAccessToken = deps.getValidAccessToken ?? getValidAccessToken;
		this.refreshAccessTokenSafe =
			deps.refreshAccessTokenSafe ?? refreshAccessTokenSafe;
		this.fetchStatus = deps.fetchStatus ?? fetchAnthropicBankedResetStatus;
		this.claimReset = deps.claim ?? claimAnthropicBankedReset;
		this.fetchProfile = deps.fetchProfile ?? fetchAnthropicProfile;
		this.canFetchProfile = deps.canFetchProfile ?? canFetchAnthropicProfile;
		this.usage = deps.usage ?? usageCache;
		this.now = deps.now ?? Date.now;
		this.readGate =
			deps.readGate ??
			new SpacedReadGate({
				spacingMs: ANTHROPIC_BANKED_RESET_READ_SPACING_MS,
				now: this.now,
			});
		this.onWindowsRestored = deps.onWindowsRestored;
	}

	/** Refuses every status read still waiting for its turn, and any later one. */
	stop(): void {
		this.readGate.stop();
	}

	/**
	 * Read the account's banked-reset status into the shared cache. One read
	 * per account at a time; non-forced calls are gated by the cache's TTL.
	 */
	async refreshStatus(
		accountId: string,
		force = false,
	): Promise<AnthropicBankedResetRefreshOutcome> {
		const existing = this.statusInflight.get(accountId);
		if (existing) return existing;

		if (
			!force &&
			!anthropicBankedResetCache.needsRefresh(accountId, this.now())
		) {
			return anthropicBankedResetCache.get(accountId)
				? { success: true, message: "Banked-reset status is still fresh." }
				: {
						success: false,
						message:
							"Banked-reset status read is waiting for its retry window.",
					};
		}

		const promise = this.runStatusRead(accountId, force);
		this.statusInflight.set(accountId, promise);
		const clear = () => {
			if (this.statusInflight.get(accountId) === promise) {
				this.statusInflight.delete(accountId);
			}
		};
		void promise.then(clear, clear);
		return promise;
	}

	/**
	 * Claim one banked reset. Concurrent calls with the same request id share
	 * one attempt; another request id for the same account is refused while one
	 * is in flight.
	 */
	async claim(
		accountId: string,
		request: AnthropicBankedResetClaimRequest,
	): Promise<AnthropicBankedResetClaimDispatchOutcome> {
		const existing = this.claimInflight.get(accountId);
		if (existing) {
			if (existing.requestId === request.requestId) return existing.promise;
			return {
				status: "failed",
				code: "busy",
				message:
					"Another banked-reset attempt is already in progress for this account.",
			};
		}
		const promise = this.runClaim(accountId, request);
		const entry = { requestId: request.requestId, promise };
		this.claimInflight.set(accountId, entry);
		const clear = () => {
			if (this.claimInflight.get(accountId) === entry) {
				this.claimInflight.delete(accountId);
			}
		};
		void promise.then(clear, clear);
		return promise;
	}

	private async runStatusRead(
		accountId: string,
		urgent: boolean,
	): Promise<AnthropicBankedResetRefreshOutcome> {
		const queued = await this.ctx.dbOps.getAccount(accountId);
		const unusable = this.unusableReason(queued, accountId);
		if (unusable || !queued) {
			return { success: false, message: unusable ?? "Account not found" };
		}
		const limited = this.rateLimitedStatusRead(queued);
		if (limited) return limited;

		let turn: ReadTurn;
		try {
			turn = await this.readGate.acquire(accountId, { urgent });
		} catch {
			return {
				success: false,
				message: `Banked-reset status read for '${queued.name}' skipped: shutting down.`,
			};
		}
		try {
			// The turn can take several reads' spacing to come round, so the
			// account, its rate limit and its token are taken as they stand now.
			const account = await this.ctx.dbOps.getAccount(accountId);
			const unusableNow = this.unusableReason(account, accountId);
			if (unusableNow || !account) {
				return { success: false, message: unusableNow ?? "Account not found" };
			}
			const limitedNow = this.rateLimitedStatusRead(account);
			if (limitedNow) return limitedNow;

			let accessToken: string;
			try {
				accessToken = await this.getValidAccessToken(account, this.ctx);
			} catch (error) {
				return {
					success: false,
					message: `Could not refresh access token for '${account.name}': ${errorMessage(error)}`,
				};
			}

			anthropicBankedResetCache.markAttempt(accountId, this.now());
			return await this.sendStatusRead(account, accessToken, turn);
		} finally {
			turn.release();
		}
	}

	private rateLimitedStatusRead(
		account: Account,
	): AnthropicBankedResetRefreshOutcome | null {
		const limitedUntil = this.usage.getRateLimitedUntil(account.id);
		if (limitedUntil === null) return null;
		return {
			success: false,
			message: `Banked-reset status read for '${account.name}' skipped: the usage endpoint is rate-limited until ${new Date(limitedUntil).toISOString()}.`,
		};
	}

	private async sendStatusRead(
		account: Account,
		accessToken: string,
		turn: ReadTurn,
	): Promise<AnthropicBankedResetRefreshOutcome> {
		const accountId = account.id;
		const sent = () => {
			turn.sent();
			this.usage.noteAnthropicUsageRead(accountId);
		};
		sent();
		let markAtReadStart = anthropicBankedResetCache.dueMark(accountId);
		let read = await this.fetchStatus(accessToken);
		if (read.httpStatus === 401) {
			const refreshed = await this.forceTokenRefresh(account, accessToken);
			if (refreshed) {
				sent();
				markAtReadStart = anthropicBankedResetCache.dueMark(accountId);
				read = await this.fetchStatus(refreshed);
			}
		}
		if (read.httpStatus === 429) {
			this.usage.noteRateLimited(
				accountId,
				this.now() + (read.retryAfterMs ?? USAGE_RATE_LIMITED_DEFAULT_MS),
			);
			return {
				success: false,
				message: `Banked-reset status read for '${account.name}' was rate-limited.`,
			};
		}
		if (!read.status) {
			return {
				success: false,
				message: `Anthropic returned no banked-reset status for '${account.name}' (HTTP ${read.httpStatus ?? "none"}).`,
			};
		}

		const status = read.status;
		anthropicBankedResetCache.set(
			accountId,
			status,
			this.now(),
			markAtReadStart,
		);
		log.info(
			`banked_reset_status account=${account.name} eligible=${status.eligible} ineligible_reason=${status.ineligibleReason ?? "none"} grants=${status.grants.length} resets_left=${bankedResetsLeftTotal(status)} next_grant=${status.nextGrantId ?? "none"}`,
		);
		return {
			success: true,
			message: `Banked-reset status read for '${account.name}'.`,
		};
	}

	private async runClaim(
		accountId: string,
		request: AnthropicBankedResetClaimRequest,
	): Promise<AnthropicBankedResetClaimDispatchOutcome> {
		const first = await this.claimableAccount(accountId, request);
		if ("message" in first) return first;
		let account = first.account;

		let accessToken: string;
		try {
			accessToken = await this.getValidAccessToken(account, this.ctx);
		} catch (error) {
			return {
				status: "failed",
				code: "error",
				message: `Could not refresh access token for '${account.name}': ${errorMessage(error)}`,
			};
		}

		const orgUuid = await this.resolveOrganizationUuid(account, accessToken);
		if (!orgUuid) {
			return {
				status: "failed",
				code: "error",
				message: `The organization of '${account.name}' is unknown, so nothing was sent. Re-authenticate the account or retry once its profile can be read.`,
			};
		}

		// A status read that left before the claim must not land after it and
		// store the pre-claim status.
		await this.settleStatusRead(accountId);

		const target = await this.openLedgerRow(account, request);
		if (target.kind === "refused") return target.outcome;
		if (target.kind === "settled")
			return this.settledOutcome(account, target.row);

		// The overage pause standing when the claim is sent, if any: the one a
		// restoring reset owes a verdict. Unreadable, the obligation could not
		// be recorded, so nothing is sent.
		const pauseRead = await this.overagePauseAtClaim(account);
		if ("error" in pauseRead) {
			const message = `Not sent: the pause of '${account.name}' could not be read (${pauseRead.error})`;
			const now = this.now();
			await this.writeLedger(account.name, target.rowId, (id) =>
				target.createdHere
					? this.ctx.dbOps.resolveAnthropicBankedResetAttempt(id, {
							status: "failed",
							reason: BANKED_RESET_NOT_SENT_REASON,
							errorMessage: message,
							now,
						})
					: this.ctx.dbOps.setAnthropicBankedResetNextAttemptAt(
							id,
							now + BANKED_RESET_CLAIM_RETRY_MIN_MS,
							message,
						),
			);
			return { status: "failed", code: "error", message };
		}
		const pauseAtClaim = pauseRead.pause;

		// Last look at the account before the POST, after every await above: it
		// may have been disabled, or its auto-apply toggle turned off, meanwhile.
		const gate = await this.claimableAccount(accountId, request);
		if ("message" in gate) {
			if (target.createdHere) {
				// Never sent, so it must not hold off the account's next claim.
				await this.writeLedger(account.name, target.rowId, (id) =>
					this.ctx.dbOps.resolveAnthropicBankedResetAttempt(id, {
						status: "failed",
						reason: BANKED_RESET_NOT_SENT_REASON,
						errorMessage: `Not sent: ${gate.message}`,
						now: this.now(),
					}),
				);
			}
			return gate;
		}
		account = gate.account;

		// The awaits since the ledger sweep may have carried the row past its
		// replay window; checked with no await before the POST it guards.
		const replayUntil =
			target.createdAt + ANTHROPIC_BANKED_RESET_REPLAY_WINDOW_MS;
		if (this.now() >= replayUntil) {
			return this.giveUpAtWindow(account, request, target);
		}
		const claimStartedAt = this.now();
		const ids = { grantId: request.grantId, requestId: request.requestId };
		let result = await this.claimReset(accessToken, orgUuid, ids);
		if (result.result === "auth_error") {
			const refreshed = await this.forceTokenRefresh(account, accessToken);
			// The retry is a second POST; the account gets the same last look.
			const retryGate = refreshed
				? await this.claimableAccount(accountId, request)
				: null;
			if (retryGate && "message" in retryGate) {
				log.warn(
					`Banked-reset claim for '${account.name}' not retried after an auth error: ${retryGate.message}`,
				);
			} else if (refreshed && this.now() >= replayUntil) {
				log.warn(
					`Banked-reset claim for '${account.name}' not retried after an auth error: its replay window closed`,
				);
			} else if (refreshed) {
				result = await this.claimReset(refreshed, orgUuid, ids);
			}
			// Whatever kept the retry from leaving, a claim past its window is
			// given up now rather than left pending to block the account.
			if (result.result === "auth_error" && this.now() >= replayUntil) {
				return this.giveUpAtWindow(account, request, {
					...target,
					createdHere: false,
				});
			}
		}

		// An answer of already_used to a replayed request id means an earlier
		// POST of ours landed and its response was lost.
		const windowsRestored =
			result.result === "reset" ||
			(result.result === "already_used" && target.replay);
		let refetch: Promise<boolean> | null = null;
		if (windowsRestored) {
			// Synchronously, before any await: the fence must cover every usage
			// fetch that left before the claim, and a memo entry recorded after
			// the claim started must survive.
			refetch = this.usage.fenceAndRefetch(accountId).catch((error) => {
				log.warn(
					`Usage refetch after a banked reset failed for '${account.name}': ${errorMessage(error)}`,
				);
				return false;
			});
			for (const family of FAMILY_PRIORITY) {
				clearFamilyWeeklyExhausted(accountId, family, claimStartedAt);
			}
		}

		const now = this.now();
		// Owed only by a fresh reset that cleared the weekly window of an account
		// overage-paused when the claim was sent. Recorded in the resolving write
		// itself, so no crash can leave a spent reset without it.
		const owedPause =
			result.result === "reset" &&
			refetch &&
			pauseAtClaim &&
			(result.cleared.includes("seven_day") ||
				result.cleared.includes("seven_day_overage_included"))
				? pauseAtClaim
				: null;
		let ledgerStatus: AnthropicBankedResetEventStatus;
		let nextAttemptAt: number | null = null;
		if (RESOLVING_RESULTS.has(result.result)) {
			ledgerStatus = result.result as AnthropicBankedResetEventStatus;
			await this.writeLedger(account.name, target.rowId, (id) =>
				this.ctx.dbOps.resolveAnthropicBankedResetAttempt(id, {
					status: ledgerStatus as Exclude<
						AnthropicBankedResetEventStatus,
						"pending"
					>,
					reason: result.reason,
					cleared: result.cleared,
					resetsLeft: result.resetsLeft,
					cooldownUntil: result.cooldownUntil,
					recovery: owedPause && {
						until: now + BANKED_RESET_RECOVERY_WINDOW_MS,
						pauseEpoch: owedPause.pauseEpoch,
						pauseChangedAt: owedPause.pauseChangedAt,
					},
					now,
				}),
			);
		} else {
			ledgerStatus = "pending";
			const retryAt =
				now +
				bankedResetClaimRetryDelayMs(
					target.createdAt,
					now,
					result.retryAfterMs,
				);
			nextAttemptAt = retryAt;
			await this.writeLedger(account.name, target.rowId, (id) =>
				this.ctx.dbOps.setAnthropicBankedResetNextAttemptAt(
					id,
					retryAt,
					this.unansweredMessage(result),
				),
			);
		}

		log.info(
			`banked_reset_claim account=${account.name} grant=${request.grantId} trigger=${request.autoApply ? `auto:${request.autoApply.cause}` : "manual"} replay=${target.replay} result=${result.result} reason=${result.reason ?? "none"} ledger=${ledgerStatus}`,
		);

		if (windowsRestored && this.onWindowsRestored) {
			try {
				await this.onWindowsRestored(accountId, result.cleared, claimStartedAt);
			} catch (error) {
				log.warn(
					`Could not lift the cooldown of '${account.name}' after a banked reset; the post-claim usage reading still can: ${errorMessage(error)}`,
				);
			}
		}

		if (owedPause && refetch) {
			await this.settleOwedPause(
				account.name,
				accountId,
				target.rowId,
				owedPause.pauseEpoch,
				refetch,
			);
		}

		let statusRefreshed = false;
		if (windowsRestored) {
			await this.settleStatusRead(accountId);
			statusRefreshed = (await this.refreshStatus(accountId, true)).success;
		}

		return {
			status: "completed",
			accountName: account.name,
			eventId: target.rowId,
			ledgerStatus,
			result,
			reason: result.reason,
			resetsLeft: result.resetsLeft,
			cleared: result.cleared,
			nextAttemptAt,
			replayUntil:
				ledgerStatus === "pending"
					? target.createdAt + ANTHROPIC_BANKED_RESET_REPLAY_WINDOW_MS
					: null,
			windowsRestored,
			statusRefreshed,
		};
	}

	/**
	 * The account's overage pause and its identity when the claim is sent;
	 * `pause` is null when it is not paused for overage.
	 */
	private async overagePauseAtClaim(
		account: Account,
	): Promise<
		| { pause: { pauseEpoch: number; pauseChangedAt: number | null } | null }
		| { error: string }
	> {
		try {
			const marker = await this.ctx.dbOps.getAccountPauseMarker(account.id);
			return { pause: marker && isOveragePause(marker) ? marker : null };
		} catch (error) {
			log.warn(
				`Could not read the pause of '${account.name}' before its banked-reset claim; not sending it: ${errorMessage(error)}`,
			);
			return { error: errorMessage(error) };
		}
	}

	/**
	 * Decide the verdict a reset owes the claim-time pause from the fenced
	 * post-claim reading: headroom in both the 5-hour and weekly windows lifts
	 * exactly that pause, a window at its limit keeps it; either way the
	 * obligation is settled. Without a usable reading the obligation stays for
	 * the applier.
	 */
	private async settleOwedPause(
		accountName: string,
		accountId: string,
		rowId: string,
		pauseEpoch: number,
		refetch: Promise<boolean>,
	): Promise<void> {
		try {
			if (!(await refetch)) {
				log.info(
					`Overage pause of '${accountName}' kept after a banked reset for now: the post-claim usage read failed or was deferred`,
				);
				return;
			}
			const verdict = overagePauseVerdict(
				this.usage.get(accountId) as UsageData | null,
				this.now(),
			);
			if (verdict.kind === "unknown") {
				log.info(
					`Overage pause of '${accountName}' kept after a banked reset for now: the post-claim reading lacks the 5-hour or weekly window`,
				);
				return;
			}
			if (verdict.kind === "exhausted") {
				log.info(
					`Overage pause of '${accountName}' kept after a banked reset: the post-claim reading is still at a limit (${verdict.detail})`,
				);
			} else if (
				await this.ctx.dbOps.resumeAccountIfOveragePausedAt(
					accountId,
					pauseEpoch,
				)
			) {
				log.info(
					`Resumed '${accountName}' from its overage pause: a banked reset restored its usage windows`,
				);
			}
			await this.ctx.dbOps.clearAnthropicBankedResetRecoveryPending(rowId);
		} catch (error) {
			log.error(
				`Banked reset claimed for '${accountName}', but its overage pause could not be settled; the applier retries it:`,
				error,
			);
		}
	}

	/**
	 * The ledger row this claim resolves. A manual claim writes its row here;
	 * a replayed request id is reconciled onto its existing row, one bound to
	 * another grant is refused, and so is a new one while another claim on the
	 * account is pending. An auto claim's row was written by the
	 * scheduler. The pending row is what makes a replay reuse the request id
	 * and what blocks a second claim, so a ledger failure here sends nothing.
	 */
	private async openLedgerRow(
		account: Account,
		request: AnthropicBankedResetClaimRequest,
	): Promise<LedgerTarget> {
		const now = this.now();
		try {
			// Nothing is replayed once its window has closed, and a claim given up
			// that way no longer holds off a new one.
			const expired =
				await this.ctx.dbOps.expireStaleAnthropicBankedResetAttempts(now);
			if (expired > 0) {
				log.info(
					`Gave up ${expired} banked-reset claim(s) whose replay window closed`,
				);
			}
			if (request.autoApply) {
				const row =
					await this.ctx.dbOps.getAnthropicBankedResetEventByRequestId(
						account.id,
						request.requestId,
					);
				if (
					row &&
					(row.id !== request.autoApply.ledgerRowId ||
						row.grant_id !== request.grantId)
				) {
					return {
						kind: "refused",
						outcome: {
							status: "failed",
							code: "grant_mismatch",
							message: `Request ${request.requestId} belongs to another banked-reset attempt.`,
						},
					};
				}
				if (row && (row.status !== "pending" || notYetDue(row, now))) {
					return { kind: "settled", row };
				}
				return {
					kind: "post",
					rowId: request.autoApply.ledgerRowId,
					createdAt: row?.created_at ?? now,
					replay: request.autoApply.replay,
					createdHere: false,
				};
			}

			const grant = anthropicBankedResetCache
				.get(account.id)
				?.status.grants.find((candidate) => candidate.id === request.grantId);
			const begin = await this.ctx.dbOps.beginManualAnthropicBankedResetAttempt(
				{
					accountId: account.id,
					accountName: account.name,
					grantId: request.grantId,
					requestId: request.requestId,
					grantEndsAt: grant?.endsAt ?? null,
					now,
				},
			);
			if (begin.kind === "grant_mismatch") {
				return {
					kind: "refused",
					outcome: {
						status: "failed",
						code: "grant_mismatch",
						message: `Request ${request.requestId} was already used for banked reset ${begin.row.grant_id}; generate a new request id.`,
					},
				};
			}
			if (begin.kind === "pending_other") {
				return {
					kind: "refused",
					outcome: {
						status: "failed",
						code: "pending_claim",
						message: `An earlier banked-reset attempt for '${account.name}' is still unconfirmed; retry it with request ${begin.row.request_id} before starting another.`,
						pendingRequestId: begin.row.request_id,
						pendingGrantId: begin.row.grant_id,
						pendingReplayUntil:
							begin.row.created_at + ANTHROPIC_BANKED_RESET_REPLAY_WINDOW_MS,
					},
				};
			}
			// A resolved row answers from the ledger, and so does a pending one
			// still backing off: its retry time is the server's or ours to keep.
			if (
				begin.kind === "existing" &&
				(begin.row.status !== "pending" || notYetDue(begin.row, now))
			) {
				return { kind: "settled", row: begin.row };
			}
			return {
				kind: "post",
				rowId: begin.row.id,
				createdAt: begin.row.created_at,
				replay: begin.kind === "existing",
				createdHere: begin.kind === "created",
			};
		} catch (error) {
			log.error(
				`Banked-reset ledger could not record the claim for '${account.name}'; no claim was sent:`,
				error,
			);
			return {
				kind: "refused",
				outcome: {
					status: "failed",
					code: "error",
					message: `The banked-reset attempt for '${account.name}' could not be recorded, so it was not sent: ${errorMessage(error)}`,
				},
			};
		}
	}

	/**
	 * A claim whose replay window closed before its next POST could leave. A
	 * manual row written by this call never had a POST, so it is `not_sent`;
	 * any other row may have, so it is given up as the ledger sweep would.
	 * Answers with the settled row.
	 */
	private async giveUpAtWindow(
		account: Account,
		request: AnthropicBankedResetClaimRequest,
		target: { rowId: string; createdHere: boolean },
	): Promise<AnthropicBankedResetClaimDispatchOutcome> {
		try {
			if (target.createdHere) {
				await this.ctx.dbOps.resolveAnthropicBankedResetAttempt(target.rowId, {
					status: "failed",
					reason: BANKED_RESET_NOT_SENT_REASON,
					errorMessage: `Not sent: the attempt for '${account.name}' reached the end of its replay window before its request left`,
					now: this.now(),
				});
			} else {
				await this.ctx.dbOps.expireStaleAnthropicBankedResetAttempts(
					this.now(),
				);
			}
			const row = await this.ctx.dbOps.getAnthropicBankedResetEventByRequestId(
				account.id,
				request.requestId,
			);
			if (row) return this.settledOutcome(account, row);
		} catch (error) {
			log.warn(
				`Could not give up the expired banked-reset claim for '${account.name}': ${errorMessage(error)}`,
			);
		}
		return {
			status: "failed",
			code: "error",
			message: `Not sent: the banked-reset attempt for '${account.name}' reached the end of its replay window.`,
		};
	}

	private settledOutcome(
		account: Account,
		row: AnthropicBankedResetEventRow,
	): AnthropicBankedResetClaimDispatchOutcome {
		return {
			status: "completed",
			accountName: account.name,
			eventId: row.id,
			ledgerStatus: row.status,
			result: null,
			reason: row.reason,
			errorMessage: row.error_message,
			resetsLeft: row.resets_left,
			cleared: parseCleared(row.cleared),
			nextAttemptAt: row.next_attempt_at,
			replayUntil:
				row.status === "pending"
					? row.created_at + ANTHROPIC_BANKED_RESET_REPLAY_WINDOW_MS
					: null,
			windowsRestored: false,
			statusRefreshed: false,
		};
	}

	private async writeLedger(
		accountName: string,
		rowId: string,
		write: (rowId: string) => Promise<boolean>,
	): Promise<void> {
		try {
			if (!(await write(rowId))) {
				log.warn(
					`Banked-reset ledger row ${rowId} for '${accountName}' was no longer pending`,
				);
			}
		} catch (error) {
			log.error(
				`Failed to record a banked-reset claim outcome for '${accountName}':`,
				error,
			);
		}
	}

	private unansweredMessage(result: AnthropicBankedResetClaimResult): string {
		if (result.errorMessage) return result.errorMessage;
		return `Anthropic answered ${result.result}${result.reason ? ` (${result.reason})` : ""}`;
	}

	private unusableReason(
		account: Account | null,
		accountId: string,
	): string | null {
		if (!account) return `Account ${accountId} not found`;
		if (account.disabled) return `Account '${account.name}' is disabled`;
		if (account.provider !== "anthropic" || !account.refresh_token) {
			return `Account '${account.name}' is not an Anthropic OAuth account`;
		}
		if (account.pause_reason === PAUSE_REASON_NEEDS_REAUTH) {
			return `Account '${account.name}' needs re-authentication`;
		}
		return null;
	}

	private async claimableAccount(
		accountId: string,
		request: AnthropicBankedResetClaimRequest,
	): Promise<
		| { account: Account }
		| Extract<AnthropicBankedResetClaimDispatchOutcome, { status: "failed" }>
	> {
		const account = await this.ctx.dbOps.getAccount(accountId);
		const unusable = this.unusableReason(account, accountId);
		if (unusable || !account) {
			return {
				status: "failed",
				code: "account_state",
				message: unusable ?? `Account ${accountId} not found`,
			};
		}
		if (request.autoApply) {
			const enabled =
				request.autoApply.cause === "expiry"
					? account.anthropic_auto_apply_banked_resets_enabled
					: account.anthropic_auto_apply_banked_reset_on_weekly_limit_enabled;
			if (!enabled) {
				return {
					status: "failed",
					code: "account_state",
					message: `Auto-apply (${request.autoApply.cause}) is turned off for '${account.name}'`,
				};
			}
		}
		return { account };
	}

	/**
	 * The organization uuid the claim URL names. Missing on an account whose
	 * identity predates its capture: one profile read, stored through the
	 * identity setter, recovers it.
	 */
	private async resolveOrganizationUuid(
		account: Account,
		accessToken: string,
	): Promise<string | null> {
		if (account.identity_organization_uuid) {
			return account.identity_organization_uuid;
		}
		if (!this.canFetchProfile()) {
			log.warn(
				`Organization uuid for '${account.name}' is unknown and the profile endpoint is rate-limited`,
			);
			return null;
		}
		const identity = await this.fetchProfile(accessToken);
		if (!identity) return null;
		try {
			await this.ctx.dbOps.setAccountIdentityFromProfile(
				account.id,
				identity,
				accessToken,
			);
		} catch (error) {
			log.warn(
				`Could not store the profile identity of '${account.name}': ${errorMessage(error)}`,
			);
		}
		return identity.organizationUuid ?? null;
	}

	private async settleStatusRead(accountId: string): Promise<void> {
		const read = this.statusInflight.get(accountId);
		if (!read) return;
		try {
			await read;
		} catch {
			// The claim does not depend on the read's outcome.
		}
	}

	/**
	 * Force one token rotation after a 401 or 403. Returns the new token only
	 * when it differs from the rejected one.
	 */
	private async forceTokenRefresh(
		account: Account,
		rejectedToken: string,
	): Promise<string | null> {
		try {
			const refreshed = await this.refreshAccessTokenSafe(account, this.ctx);
			return refreshed && refreshed !== rejectedToken ? refreshed : null;
		} catch (error) {
			log.warn(
				`Forced token refresh for '${account.name}' failed: ${errorMessage(error)}`,
			);
			return null;
		}
	}
}
