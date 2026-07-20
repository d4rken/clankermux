import { Logger } from "@clankermux/logger";
import {
	CODEX_DEFAULT_ENDPOINT,
	codexRateLimitResetCreditsCache,
	consumeCodexRateLimitResetCredit,
	fetchCodexRateLimitResetCredits,
	getProvider,
	sendCodexNativePing,
	usageCache,
} from "@clankermux/providers";
import type {
	Account,
	CodexRateLimitResetCreditConsumeRequest,
	CodexRateLimitResetCreditConsumeResult,
	CodexResetCreditEventStatus,
} from "@clankermux/types";
import {
	applyCodexObservation,
	type CodexObservationResult,
	type CodexObservationSource,
	type CodexRateLimitAction,
	type CodexRequestAccounting,
} from "./handlers/codex-observation";
import type { ProxyContext } from "./handlers/proxy-types";
import {
	type CodexResetCreditConsumeDispatchOutcome,
	type CodexUsageRefreshOutcome,
	getValidAccessToken,
} from "./handlers/token-manager";

const log = new Logger("CodexSpendCoordinator");

/**
 * Why a Codex spend (a single quota-consuming native `/responses` ping) is being
 * requested. Deliberately a CLOSED union — there is no "telemetry" or generic
 * string cause. Every autonomous or manual Codex usage probe flows through the
 * coordinator under exactly one of these two intents:
 *
 *   - `"scheduled-prime"`: the auto-refresh scheduler priming a dormant/aging
 *     window. Gated on the account's `auto_refresh_enabled` flag and counted
 *     against the account's request tally (`count-only`).
 *   - `"manual-refresh"`: an operator-initiated "refresh usage" click. Always
 *     allowed (ignores `auto_refresh_enabled`) and NOT counted against the
 *     request tally (`none`) — the operator's action is not app traffic.
 */
export type CodexSpendCause = "scheduled-prime" | "manual-refresh";

/**
 * Discriminated outcome of {@link CodexSpendCoordinator.observe}. Scheduled and
 * manual successes are NOT collapsed into one boolean: `completed` carries the
 * raw {@link CodexObservationResult} plus the transport status so each caller
 * (scheduler vs manual-refresh endpoint) applies its own interpretation.
 *
 *   - `completed`: the native ping was issued and the observation applied.
 *     `responseOk`/`responseStatus` describe the transport; `observation`
 *     carries usage/credits/rate-limit bookkeeping. A `completed` result with a
 *     429 or a null `observation.usage` is still `completed` — success/failure
 *     interpretation belongs to the caller.
 *   - `skipped`: no spend happened (account gone / not codex / no tokens /
 *     scheduled prime suppressed because auto-refresh is off). `reason` is a
 *     human-readable explanation.
 *   - `failed`: a spend was attempted but the token refresh or native transport
 *     threw. `message` is a human-readable error. There is NO fallback to a
 *     translated/`/v1/messages` request — the native ping is the only transport.
 */
export type CodexSpendResult =
	| {
			status: "completed";
			responseOk: boolean;
			responseStatus: number;
			accountName: string;
			observation: CodexObservationResult;
	  }
	| { status: "skipped"; reason: string }
	| { status: "failed"; message: string };

/**
 * Per-account in-flight spend. Concurrent {@link CodexSpendCoordinator.observe}
 * callers for the same account share ONE physical native request and ONE
 * applicator call by joining this entry; `causes` accumulates every intent that
 * joined before the request is issued (drives the last-moment scheduled gate and
 * the request-accounting tie-break).
 */
interface InflightSpend {
	causes: Set<CodexSpendCause>;
	promise: Promise<CodexSpendResult>;
}

/**
 * Injectable policy/transport dependencies for {@link CodexSpendCoordinator}.
 * Every field is OPTIONAL and defaults to the real free-function import, so
 * production callers construct the coordinator with just `new
 * CodexSpendCoordinator(ctx)` and get unchanged behavior. Unit tests pass test
 * doubles here instead of relying on global `mock.module` registrations (which
 * bun does NOT undo between files and would leak into the rest of the suite).
 */
export interface CodexSpendCoordinatorDeps {
	getValidAccessToken?: typeof getValidAccessToken;
	applyCodexObservation?: typeof applyCodexObservation;
	sendCodexNativePing?: typeof sendCodexNativePing;
	fetchCodexRateLimitResetCredits?: typeof fetchCodexRateLimitResetCredits;
	consumeCodexRateLimitResetCredit?: typeof consumeCodexRateLimitResetCredit;
	getProvider?: typeof getProvider;
}

/**
 * The single authority for autonomous (scheduled-prime) and manual
 * (manual-refresh) Codex spend. Owns the policy around issuing a native
 * `/responses` ping: the per-cause gate, concurrent de-duplication, the
 * last-moment scheduled re-check, one rate-limit parse, and one
 * {@link applyCodexObservation} call. It NEVER falls back to a translated
 * `/v1/messages` request — the native ping is the only transport.
 *
 * Wiring: constructed in later refactor steps. Step 3 reroutes the scheduler to
 * {@link observe}; Step 4 reroutes the manual-refresh endpoint to
 * {@link refreshManual}. This module only adds the capability + unit tests.
 */
export class CodexSpendCoordinator {
	private readonly ctx: ProxyContext;
	private readonly inflight = new Map<string, InflightSpend>();
	private readonly getValidAccessToken: typeof getValidAccessToken;
	private readonly applyCodexObservation: typeof applyCodexObservation;
	private readonly sendCodexNativePing: typeof sendCodexNativePing;
	private readonly fetchCodexRateLimitResetCredits: typeof fetchCodexRateLimitResetCredits;
	private readonly consumeCodexRateLimitResetCredit: typeof consumeCodexRateLimitResetCredit;
	private readonly getProvider: typeof getProvider;
	private readonly resetCreditsInflight = new Map<
		string,
		Promise<CodexUsageRefreshOutcome>
	>();

	constructor(ctx: ProxyContext, deps: CodexSpendCoordinatorDeps = {}) {
		this.ctx = ctx;
		this.getValidAccessToken = deps.getValidAccessToken ?? getValidAccessToken;
		this.applyCodexObservation =
			deps.applyCodexObservation ?? applyCodexObservation;
		this.sendCodexNativePing = deps.sendCodexNativePing ?? sendCodexNativePing;
		this.fetchCodexRateLimitResetCredits =
			deps.fetchCodexRateLimitResetCredits ?? fetchCodexRateLimitResetCredits;
		this.consumeCodexRateLimitResetCredit =
			deps.consumeCodexRateLimitResetCredit ?? consumeCodexRateLimitResetCredit;
		this.getProvider = deps.getProvider ?? getProvider;
	}

	/**
	 * Book a consume attempt into the `codex_reset_credit_events` ledger. Auto
	 * attempts (request.autoApply) resolve their pre-claimed pending row;
	 * manual attempts insert a one-shot resolved event. A FAILED auto attempt
	 * deliberately writes NOTHING — the pending row must stay pending so the
	 * next scheduler tick retries with the SAME idempotency key. Ledger writes
	 * must never break the consume flow, so every error is swallowed and logged.
	 */
	private async recordResetCreditLedger(
		accountId: string,
		accountName: string,
		request: CodexRateLimitResetCreditConsumeRequest,
		status: Exclude<CodexResetCreditEventStatus, "pending">,
		windowsReset: number | null,
		errorMessage: string | null,
	): Promise<void> {
		try {
			if (request.autoApply) {
				// Transport/validation failures keep the pending auto row for a
				// same-key retry; only business outcomes resolve it.
				if (status === "failed") return;
				await this.ctx.dbOps.resolveCodexResetCreditAttempt(
					request.autoApply.ledgerRowId,
					status,
					windowsReset,
					null,
				);
			} else {
				await this.ctx.dbOps.recordManualCodexResetCreditEvent({
					accountId,
					accountName,
					creditId: request.creditId ?? null,
					idempotencyKey: request.idempotencyKey,
					status,
					windowsReset,
					errorMessage,
				});
			}
		} catch (error) {
			log.error(
				`Failed to record reset-credit ledger event for '${accountName}' (status ${status}):`,
				error,
			);
		}
	}

	/**
	 * Record a failed consume attempt (manual only — auto rows stay pending)
	 * and produce the failed dispatch outcome.
	 */
	private async failResetCreditConsume(
		accountId: string,
		accountName: string,
		request: CodexRateLimitResetCreditConsumeRequest,
		message: string,
	): Promise<CodexResetCreditConsumeDispatchOutcome> {
		await this.recordResetCreditLedger(
			accountId,
			accountName,
			request,
			"failed",
			null,
			message,
		);
		return { status: "failed", message };
	}

	/**
	 * Consume one earned reset credit for a Codex account. This is the only
	 * coordinator method that performs the state-changing reset action.
	 */
	async consumeResetCredit(
		accountId: string,
		request: CodexRateLimitResetCreditConsumeRequest,
	): Promise<CodexResetCreditConsumeDispatchOutcome> {
		const account = await this.ctx.dbOps.getAccount(accountId);
		if (!account) {
			return this.failResetCreditConsume(
				accountId,
				accountId,
				request,
				`Account ${accountId} not found`,
			);
		}
		if (account.provider !== "codex") {
			return this.failResetCreditConsume(
				accountId,
				account.name,
				request,
				`Account '${account.name}' is not a Codex account`,
			);
		}
		if (!account.access_token && !account.refresh_token) {
			return this.failResetCreditConsume(
				accountId,
				account.name,
				request,
				`Account '${account.name}' has no tokens — please re-authenticate`,
			);
		}

		let accessToken: string;
		try {
			accessToken = await this.getValidAccessToken(account, this.ctx);
		} catch (error) {
			return this.failResetCreditConsume(
				accountId,
				account.name,
				request,
				`Could not refresh access token for '${account.name}': ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		// Do not let a metadata read begun before the mutation finish afterward and
		// overwrite the post-consume cache with a stale pre-consume snapshot.
		const metadataRead = this.resetCreditsInflight.get(accountId);
		if (metadataRead) {
			try {
				await metadataRead;
			} catch {
				// The consume attempt remains valid even if the preceding read failed.
			}
		}

		let result: CodexRateLimitResetCreditConsumeResult;
		try {
			result = await this.consumeCodexRateLimitResetCredit(
				accessToken,
				request,
			);
		} catch (error) {
			return this.failResetCreditConsume(
				accountId,
				account.name,
				request,
				`Failed to consume a reset credit for '${account.name}': ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		// A business outcome (reset/nothingToReset/noCredit/alreadyRedeemed) is
		// definitive: resolve the auto row / book the manual event now, before the
		// best-effort cleanup below.
		await this.recordResetCreditLedger(
			accountId,
			account.name,
			request,
			result.outcome,
			result.windowsReset,
			null,
		);

		let localRateLimitStateCleared = false;
		if (result.outcome === "reset" || result.outcome === "alreadyRedeemed") {
			try {
				localRateLimitStateCleared =
					await this.ctx.dbOps.forceResetAccountRateLimit(accountId);
			} catch (error) {
				log.error(
					`Reset was consumed for '${account.name}', but local rate-limit state could not be cleared:`,
					error,
				);
			}
			usageCache.delete(accountId);
		}

		let resetMetadataRefreshed = false;
		let availableResetCount: number | null = null;
		try {
			codexRateLimitResetCreditsCache.markAttempt(accountId);
			const summary = await this.fetchCodexRateLimitResetCredits(accessToken);
			if (summary) {
				codexRateLimitResetCreditsCache.set(accountId, summary);
				resetMetadataRefreshed = true;
				availableResetCount = summary.availableCount;
			}
		} catch (error) {
			log.warn(
				`Reset-credit metadata refresh after consume failed for '${account.name}':`,
				error,
			);
		}

		return {
			status: "completed",
			accountName: account.name,
			result,
			resetMetadataRefreshed,
			availableResetCount,
			localRateLimitStateCleared,
		};
	}

	/**
	 * Refresh the read-only earned-reset summary for one Codex account. This is
	 * deliberately separate from observe(): it sends no model request and has no
	 * consume/redeem capability. Non-forced background callers are TTL/retry
	 * gated; manual usage refreshes force a fresh read.
	 */
	async refreshResetCredits(
		accountId: string,
		force = false,
	): Promise<CodexUsageRefreshOutcome> {
		const existing = this.resetCreditsInflight.get(accountId);
		if (existing) return existing;

		if (!force && !codexRateLimitResetCreditsCache.needsRefresh(accountId)) {
			const cached = codexRateLimitResetCreditsCache.get(accountId);
			return cached
				? {
						success: true,
						message: `Codex reset metadata is still fresh (${cached.summary.availableCount} available).`,
					}
				: {
						success: false,
						message:
							"Codex reset metadata refresh is waiting for its retry window.",
					};
		}

		const promise = this.runResetCreditsRefresh(accountId);
		this.resetCreditsInflight.set(accountId, promise);
		void promise.finally(() => {
			if (this.resetCreditsInflight.get(accountId) === promise) {
				this.resetCreditsInflight.delete(accountId);
			}
		});
		return promise;
	}

	private async runResetCreditsRefresh(
		accountId: string,
	): Promise<CodexUsageRefreshOutcome> {
		const account = await this.ctx.dbOps.getAccount(accountId);
		if (!account) {
			return { success: false, message: `Account ${accountId} not found` };
		}
		if (account.provider !== "codex") {
			return {
				success: false,
				message: `Account '${account.name}' is not a Codex account`,
			};
		}
		if (!account.access_token && !account.refresh_token) {
			return {
				success: false,
				message: `Account '${account.name}' has no tokens — please re-authenticate`,
			};
		}

		let accessToken: string;
		try {
			accessToken = await this.getValidAccessToken(account, this.ctx);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: `Could not refresh access token for '${account.name}': ${message}`,
			};
		}

		codexRateLimitResetCreditsCache.markAttempt(accountId);
		const summary = await this.fetchCodexRateLimitResetCredits(accessToken);
		if (!summary) {
			return {
				success: false,
				message: `Codex returned no reset-credit metadata for '${account.name}'`,
			};
		}

		codexRateLimitResetCreditsCache.set(accountId, summary);
		return {
			success: true,
			message: `Reset metadata refreshed for '${account.name}' (${summary.availableCount} available).`,
		};
	}

	/**
	 * Observe (and, when authorized, issue) a Codex spend for `accountId` under
	 * `cause`. Concurrent calls for the same account collapse onto one physical
	 * ping + one applicator call; the returned result is shared by all joiners.
	 */
	async observe(
		accountId: string,
		cause: CodexSpendCause,
	): Promise<CodexSpendResult> {
		// 1. Load the fresh full account.
		const account = await this.ctx.dbOps.getAccount(accountId);
		if (!account) {
			return { status: "skipped", reason: `Account ${accountId} not found` };
		}

		// 2. Validate provider + token presence.
		if (account.provider !== "codex") {
			return {
				status: "skipped",
				reason: `Account '${account.name}' is not a Codex account`,
			};
		}
		if (!account.access_token && !account.refresh_token) {
			return {
				status: "skipped",
				reason: `Account '${account.name}' has no tokens — please re-authenticate`,
			};
		}

		// 3. Per-cause gate. A scheduled prime is only allowed while the account
		//    has auto-refresh enabled; manual refresh ignores that flag entirely.
		if (cause === "scheduled-prime" && !account.auto_refresh_enabled) {
			return {
				status: "skipped",
				reason: `Scheduled priming skipped for '${account.name}': auto-refresh disabled`,
			};
		}

		// 4. Join or establish the account's in-flight spend. Everything from the
		//    map lookup to the map.set below runs synchronously (no await), so two
		//    concurrent callers can never both establish — the later one always
		//    joins the shared physical request and shares its result.
		const existing = this.inflight.get(accountId);
		if (existing) {
			existing.causes.add(cause);
			return existing.promise;
		}

		const causes = new Set<CodexSpendCause>([cause]);
		const promise = this.runSharedSpend(accountId, account, causes);
		const entry: InflightSpend = { causes, promise };
		this.inflight.set(accountId, entry);
		// Clear the entry once settled, guarded by identity so a superseding entry
		// (should one ever exist) is never deleted out from under itself.
		void promise.finally(() => {
			if (this.inflight.get(accountId) === entry) {
				this.inflight.delete(accountId);
			}
		});
		return promise;
	}

	/**
	 * Manual "refresh usage" adapter. Maps {@link observe}(…, "manual-refresh")
	 * onto the existing {@link CodexUsageRefreshOutcome} dashboard contract,
	 * matching the wording the server's refresher callback produces today. NOT
	 * wired to the HTTP endpoint yet (Step 4 does that).
	 */
	async refreshManual(accountId: string): Promise<CodexUsageRefreshOutcome> {
		const [result] = await Promise.all([
			this.observe(accountId, "manual-refresh"),
			this.refreshResetCredits(accountId, true),
		]);
		switch (result.status) {
			case "skipped":
				return { success: false, message: result.reason };
			case "failed":
				return { success: false, message: result.message };
			case "completed": {
				const { accountName, responseStatus, observation } = result;
				if (!observation.usage) {
					return {
						success: false,
						message: `Codex returned no usage headers (status ${responseStatus}) for '${accountName}'`,
					};
				}
				const fiveHour = observation.usage.five_hour?.utilization ?? 0;
				const sevenDay = observation.usage.seven_day?.utilization ?? 0;
				// A 429 still yields a usable usage refresh (the payload is what we
				// wanted), but the message must not celebrate an exhausted account.
				const message = observation.isRateLimited
					? `Usage refreshed for '${accountName}' — account is rate limited (5h: ${fiveHour}%, 7d: ${sevenDay}%).`
					: `Usage refreshed for '${accountName}' (5h: ${fiveHour}%, 7d: ${sevenDay}%).`;
				return { success: true, message };
			}
		}
	}

	/**
	 * The shared spend body: token → last-moment scheduled gate → single native
	 * ping → single rate-limit parse → single applicator call. Runs once per
	 * in-flight entry; every joined cause observes its result.
	 */
	private async runSharedSpend(
		accountId: string,
		account: Account,
		causes: Set<CodexSpendCause>,
	): Promise<CodexSpendResult> {
		// 5. Obtain a valid access token (may perform a network refresh).
		let accessToken: string;
		try {
			accessToken = await this.getValidAccessToken(account, this.ctx);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				status: "failed",
				message: `Could not refresh access token for '${account.name}': ${message}`,
			};
		}

		// 6. Last-moment scheduled gate. If the only authorizing cause is a
		//    scheduled prime, re-read the account: the operator may have disabled
		//    auto-refresh during the (possibly slow) token refresh, in which case
		//    the prime must be suppressed WITHOUT issuing a request. A joined
		//    manual-refresh cause is explicit operator consent and authorizes the
		//    single request even if scheduling was disabled meanwhile.
		if (!causes.has("manual-refresh")) {
			const fresh = await this.ctx.dbOps.getAccount(accountId);
			if (!fresh?.auto_refresh_enabled) {
				return {
					status: "skipped",
					reason: `Scheduled priming suppressed for '${account.name}': auto-refresh disabled`,
				};
			}
		}

		// 7. Issue the single native ping (the ONLY transport — no translated
		//    fallback on failure).
		const endpoint = account.custom_endpoint ?? CODEX_DEFAULT_ENDPOINT;
		let response: Response;
		try {
			response = await this.sendCodexNativePing(accessToken, endpoint);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				status: "failed",
				message: `Codex request failed for '${account.name}': ${message}`,
			};
		}

		// 8. Parse rate-limit ONCE with the codex provider.
		const provider = this.getProvider("codex");
		if (!provider) {
			return {
				status: "failed",
				message: "Codex provider is not registered",
			};
		}
		const rateLimitInfo = provider.parseRateLimit(response);

		// 9. Apply the observation ONCE. Scheduled priming wins the accounting
		//    tie-break so a shared prime+manual spend is counted exactly once
		//    (count-only); a manual-only spend is never counted (none). The
		//    applicator owns the 429 cooldown and (for these non-real-traffic
		//    sources) the success-cooldown recovery. On a success (non-429) we
		//    MUST skip the cooldown action — applyRateLimitCooldown keys off the
		//    upstream reset time, which is always future on a healthy Codex
		//    response, so applying it would wrongly cool down a live account.
		const hasScheduled = causes.has("scheduled-prime");
		const source: CodexObservationSource = hasScheduled
			? "scheduled-prime"
			: "manual-refresh";
		const requestAccounting: CodexRequestAccounting = hasScheduled
			? "count-only"
			: "none";
		const rateLimitAction: CodexRateLimitAction =
			response.status === 429 ? { kind: "apply" } : { kind: "skip" };

		const observation = this.applyCodexObservation(
			account,
			response,
			this.ctx,
			{
				source,
				rateLimitInfo,
				requestAccounting,
				rateLimitAction,
				successRecovery: "scheduled-prime",
			},
		);

		log.debug(
			`Codex spend for '${account.name}' [${[...causes].join("+")}]: status=${response.status}, 5h=${observation.usage?.five_hour?.utilization ?? "n/a"}%, 7d=${observation.usage?.seven_day?.utilization ?? "n/a"}%`,
		);

		// 10. Return the raw observation for caller-specific interpretation.
		return {
			status: "completed",
			responseOk: response.ok,
			responseStatus: response.status,
			accountName: account.name,
			observation,
		};
	}
}
