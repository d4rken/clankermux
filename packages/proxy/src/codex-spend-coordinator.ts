import { Logger } from "@clankermux/logger";
import {
	CODEX_DEFAULT_ENDPOINT,
	getProvider,
	sendCodexNativePing,
} from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import {
	applyCodexObservation,
	type CodexObservationResult,
	type CodexObservationSource,
	type CodexRateLimitAction,
	type CodexRequestAccounting,
} from "./handlers/codex-observation";
import type { ProxyContext } from "./handlers/proxy-types";
import {
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
	private readonly getProvider: typeof getProvider;

	constructor(ctx: ProxyContext, deps: CodexSpendCoordinatorDeps = {}) {
		this.ctx = ctx;
		this.getValidAccessToken = deps.getValidAccessToken ?? getValidAccessToken;
		this.applyCodexObservation =
			deps.applyCodexObservation ?? applyCodexObservation;
		this.sendCodexNativePing = deps.sendCodexNativePing ?? sendCodexNativePing;
		this.getProvider = deps.getProvider ?? getProvider;
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
		const result = await this.observe(accountId, "manual-refresh");
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
