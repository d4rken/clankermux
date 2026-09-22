import { FAMILY_PRIORITY, PAUSE_REASON_NEEDS_REAUTH } from "@clankermux/core";
import type { AnthropicBankedResetEventRow } from "@clankermux/database";
import { Logger } from "@clankermux/logger";
import {
	anthropicBankedResetCache,
	canFetchAnthropicProfile,
	claimAnthropicBankedReset,
	fetchAnthropicBankedResetStatus,
	fetchAnthropicProfile,
	USAGE_RATE_LIMITED_DEFAULT_MS,
	usageCache,
} from "@clankermux/providers";
import type {
	Account,
	AnthropicBankedResetClaimRequest,
	AnthropicBankedResetClaimResult,
	AnthropicBankedResetEventStatus,
	AnthropicBankedResetStatus,
	AnthropicBankedResetWindow,
} from "@clankermux/types";
import { clearFamilyWeeklyExhausted } from "./family-weekly-memo";
import type { ProxyContext } from "./handlers/proxy-types";
import {
	type AnthropicBankedResetClaimDispatchOutcome,
	type AnthropicBankedResetRefreshOutcome,
	getValidAccessToken,
	refreshAccessTokenSafe,
} from "./handlers/token-manager";

const log = new Logger("AnthropicBankedResets");

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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseCleared(value: string | null): AnthropicBankedResetWindow[] {
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
		"fenceAndRefetch" | "noteRateLimited" | "getRateLimitedUntil"
	>;
	now?: () => number;
}

type LedgerTarget =
	| {
			kind: "post";
			rowId: string;
			createdAt: number;
			/** The row was pending before this call, so an earlier POST may have landed. */
			replay: boolean;
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
 * reuse the row's request id, which the server deduplicates on. A reset
 * changes the account's usage upstream, so a restoring claim fences the usage
 * cache and refetches instead of clearing any rate-limit state itself: the
 * refetch reaches the capacity-restored path, and `rate_limit_reset` must
 * never be nulled for an Anthropic account (a paused one could not auto-unpause
 * again).
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

		const promise = this.runStatusRead(accountId);
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
					"Another banked-reset claim is already in progress for this account.",
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
	): Promise<AnthropicBankedResetRefreshOutcome> {
		const account = await this.ctx.dbOps.getAccount(accountId);
		const unusable = this.unusableReason(account, accountId);
		if (unusable || !account) {
			return { success: false, message: unusable ?? "Account not found" };
		}

		const limitedUntil = this.usage.getRateLimitedUntil(accountId);
		if (limitedUntil !== null) {
			return {
				success: false,
				message: `Banked-reset status read for '${account.name}' skipped: the usage endpoint is rate-limited until ${new Date(limitedUntil).toISOString()}.`,
			};
		}

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
		let read = await this.fetchStatus(accessToken);
		if (read.httpStatus === 401) {
			const refreshed = await this.forceTokenRefresh(account, accessToken);
			if (refreshed) read = await this.fetchStatus(refreshed);
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
		anthropicBankedResetCache.set(accountId, status, this.now());
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
				message: `The organization of '${account.name}' is unknown, so no claim was sent. Re-authenticate the account or retry once its profile can be read.`,
			};
		}

		// A status read that left before the claim must not land after it and
		// store the pre-claim status.
		await this.settleStatusRead(accountId);

		// Last look at the account before the POST: it may have been disabled,
		// or its auto-apply toggle turned off, while the reads above ran.
		const gate = await this.claimableAccount(accountId, request);
		if ("message" in gate) return gate;
		account = gate.account;

		const target = await this.openLedgerRow(account, request);
		if (target.kind === "refused") return target.outcome;
		if (target.kind === "settled")
			return this.settledOutcome(account, target.row);

		const claimStartedAt = this.now();
		const ids = { grantId: request.grantId, requestId: request.requestId };
		let result = await this.claimReset(accessToken, orgUuid, ids);
		if (result.result === "auth_error") {
			const refreshed = await this.forceTokenRefresh(account, accessToken);
			if (refreshed) result = await this.claimReset(refreshed, orgUuid, ids);
		}

		// An answer of already_used to a replayed request id means an earlier
		// POST of ours landed and its response was lost.
		const windowsRestored =
			result.result === "reset" ||
			(result.result === "already_used" && target.replay);
		if (windowsRestored) {
			// Synchronously, before any await: the fence must cover every usage
			// fetch that left before the claim, and a memo entry recorded after
			// the claim started must survive.
			this.usage
				.fenceAndRefetch(accountId)
				.catch((error) =>
					log.warn(
						`Usage refetch after a banked reset failed for '${account.name}': ${errorMessage(error)}`,
					),
				);
			for (const family of FAMILY_PRIORITY) {
				clearFamilyWeeklyExhausted(accountId, family, claimStartedAt);
			}
		}

		const now = this.now();
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

		if (result.result === "reset") {
			// `reset` only: an already_used replay may surface long after the
			// windows were restored, and the account may have spent them since.
			try {
				if (await this.ctx.dbOps.resumeAccountIfOveragePaused(accountId)) {
					log.info(
						`Resumed '${account.name}' from its overage pause: a banked reset restored its usage windows`,
					);
				}
			} catch (error) {
				log.error(
					`Banked reset claimed for '${account.name}', but its overage pause could not be lifted:`,
					error,
				);
			}
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
			windowsRestored,
			statusRefreshed,
		};
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
				if (row && row.status !== "pending") return { kind: "settled", row };
				return {
					kind: "post",
					rowId: request.autoApply.ledgerRowId,
					createdAt: row?.created_at ?? now,
					replay: request.autoApply.replay,
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
						message: `Request ${request.requestId} was already used for grant ${begin.row.grant_id}; generate a new request id.`,
					},
				};
			}
			if (begin.kind === "pending_other") {
				return {
					kind: "refused",
					outcome: {
						status: "failed",
						code: "pending_claim",
						message: `An earlier banked-reset claim for '${account.name}' is still unconfirmed; retry it with request ${begin.row.request_id} before starting another.`,
						pendingRequestId: begin.row.request_id,
						pendingGrantId: begin.row.grant_id,
					},
				};
			}
			if (begin.kind === "existing" && begin.row.status !== "pending") {
				return { kind: "settled", row: begin.row };
			}
			return {
				kind: "post",
				rowId: begin.row.id,
				createdAt: begin.row.created_at,
				replay: begin.kind === "existing",
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
					message: `The banked-reset claim for '${account.name}' could not be recorded, so it was not sent: ${errorMessage(error)}`,
				},
			};
		}
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
			resetsLeft: row.resets_left,
			cleared: parseCleared(row.cleared),
			nextAttemptAt: row.next_attempt_at,
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
