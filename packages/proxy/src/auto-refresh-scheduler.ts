import {
	CLAUDE_MODEL_IDS,
	getClientVersion,
	registerHeartbeat,
} from "@clankermux/core";
import type { BunSqlAdapter } from "@clankermux/database";
import { Logger } from "@clankermux/logger";
import {
	type CodexCreditsInfo,
	fetchUsageData,
	getProvider,
	isCodexOnCredits,
	toEpochMs,
	usageCache,
} from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import {
	CodexSpendCoordinator,
	type CodexSpendResult,
} from "./codex-spend-coordinator";
import { TOKEN_SAFETY_WINDOW_MS } from "./constants";
import { dispatchProxyRequest } from "./dispatch";
import {
	getValidAccessToken,
	pauseAccountForReauthIfInvalidGrant,
} from "./handlers";
import type { ProxyContext } from "./proxy";

const log = new Logger("AutoRefreshScheduler");

/**
 * The row shape selected by the auto-refresh eligibility query and consumed by
 * sendTranslatedClaudePrime. Kept as a single alias so the 5h and weekly
 * selection passes share exactly the columns sendTranslatedClaudePrime needs.
 */
type AutoRefreshAccountRow = {
	id: string;
	name: string;
	provider: string;
	refresh_token: string;
	access_token: string | null;
	expires_at: number | null;
	rate_limit_reset: number | null;
	custom_endpoint: string | null;
	paused: number;
	auto_pause_on_overage_enabled: number;
	pause_reason: string | null;
};

function isZaiPeakHour(ts = Date.now()): boolean {
	const d = new Date(ts);
	const sgtHour = (d.getUTCHours() + d.getUTCMinutes() / 60 + 8) % 24;
	return sgtHour >= 14 && sgtHour < 18;
}

/**
 * Auto-refresh scheduler that monitors accounts with auto-refresh enabled
 * and sends dummy messages when their usage window resets
 */
export class AutoRefreshScheduler {
	private db: BunSqlAdapter;
	private proxyContext: ProxyContext;
	private unregisterInterval: (() => void) | null = null;
	private checkInterval = 60000; // Check every minute
	// Track the rate_limit_reset timestamp for each account when we last refreshed it
	// This allows us to detect when a new window has started (different rate_limit_reset)
	private lastRefreshResetTime: Map<string, number> = new Map();
	// Prevent concurrent refresh operations using a Promise-based mutex
	private refreshMutex: Promise<void> | null = null;
	private refreshMutexResolver: (() => void) | null = null;
	// Track consecutive failure counts for accounts to identify consistently failing ones
	private consecutiveFailures: Map<string, number> = new Map();
	// Threshold for marking an account as needing re-authentication
	private readonly FAILURE_THRESHOLD = 5;
	// Track the last time we primed an account's dormant WEEKLY (seven_day) window.
	// A per-account cooldown prevents a retry-storm when a weekly prime keeps failing.
	private lastWeeklyPrimeTime: Map<string, number> = new Map();
	// Minimum gap between weekly-dormant primes for the same account.
	private readonly WEEKLY_PRIME_COOLDOWN_MS = 15 * 60 * 1000;
	// Maximum age of a cached usage datum we will trust when classifying a weekly
	// window as dormant. Older than this → treat as unknown and skip (no prime).
	private readonly WEEKLY_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
	// The single authority for autonomous (scheduled-prime) Codex spend. Codex
	// priming does NOT use the translated Haiku dummy dispatch — it flows through
	// this coordinator, which owns the native `/responses` ping and ALL codex
	// side-effects (usageCache, credits carry-forward, window-roll, rate-limit
	// reset persistence, and the 429 cooldown). Injectable for tests; production
	// constructs the real coordinator over the same proxyContext.
	private readonly coordinator: CodexSpendCoordinator;

	constructor(
		db: BunSqlAdapter,
		proxyContext: ProxyContext,
		coordinator?: CodexSpendCoordinator,
	) {
		this.db = db;
		this.proxyContext = proxyContext;
		this.coordinator = coordinator ?? new CodexSpendCoordinator(proxyContext);
	}

	/**
	 * Start the auto-refresh scheduler
	 */
	start(): void {
		if (this.unregisterInterval) {
			log.warn("Auto-refresh scheduler already running");
			return;
		}

		log.info("Starting auto-refresh scheduler");
		this.unregisterInterval = registerHeartbeat({
			id: "auto-refresh-scheduler",
			callback: () => this.checkAndRefresh(),
			seconds: Math.floor(this.checkInterval / 1000),
			description: "Auto-refresh scheduler for account usage windows",
		});

		// Run immediately on start
		this.checkAndRefresh();
	}

	/**
	 * Stop the auto-refresh scheduler
	 */
	stop(): void {
		if (this.unregisterInterval) {
			this.unregisterInterval();
			this.unregisterInterval = null;
			log.info("Auto-refresh scheduler stopped");
		}
		// Clear the tracking maps to free memory
		this.lastRefreshResetTime.clear();
		this.consecutiveFailures.clear();
		this.lastWeeklyPrimeTime.clear();
	}

	/**
	 * Check for accounts that need auto-refresh and send dummy messages
	 */
	private async checkAndRefresh(): Promise<void> {
		// Use a mutex to prevent concurrent refresh operations
		if (this.refreshMutex) {
			log.debug(
				"Auto-refresh check skipped - previous check still in progress",
			);
			return;
		}

		// Create a new mutex promise to indicate we're currently refreshing
		const mutexPromise = new Promise<void>((resolve) => {
			this.refreshMutexResolver = resolve;
		});
		this.refreshMutex = mutexPromise;

		try {
			// Check if database is available
			if (!this.db) {
				log.warn("Database not available for auto-refresh check");
				return;
			}

			const now = Date.now();

			// Periodically clean up the tracking map - remove entries for accounts that no longer exist
			// or have auto-refresh disabled
			await this.cleanupTracking();

			await this.checkPeakHoursPause();

			// Proactively refresh OAuth tokens expiring within the safety window.
			// These run EVERY cycle, BEFORE the eligibility query and its early
			// `accounts.length === 0` return, so token refresh happens regardless of
			// whether any anthropic/codex/zai account is due for a window prime. (A
			// qwen-only — or otherwise prime-less — deployment must still get its
			// tokens refreshed.) They take no args and query independently, so their
			// order relative to each other and to the priming scan does not matter;
			// nothing below depends on their result.
			await this.checkAndRefreshQwenTokens();
			await this.checkAndRefreshCodexTokens();

			// Get all accounts with auto-refresh enabled that have reset windows OR need immediate refresh
			const accounts = await this.db.query<{
				id: string;
				name: string;
				provider: string;
				refresh_token: string;
				access_token: string | null;
				expires_at: number | null;
				rate_limit_reset: number | null;
				custom_endpoint: string | null;
				paused: number;
				auto_pause_on_overage_enabled: number;
				pause_reason: string | null;
			}>(
				`
				SELECT
					id, name, provider, refresh_token, access_token,
					expires_at, rate_limit_reset, custom_endpoint,
					COALESCE(paused, 0) as paused,
					COALESCE(auto_pause_on_overage_enabled, 0) as auto_pause_on_overage_enabled,
					pause_reason
				FROM accounts
				WHERE
					auto_refresh_enabled = 1
					AND provider IN ('anthropic', 'codex', 'zai')
					-- NOTE: the 5-hour reset predicate that used to live here has moved
					-- into the per-account fiveHourWindowGate()/shouldRefreshAccount()
					-- pass below. The base query now scans ALL eligible accounts so the
					-- weekly-dormant priming pass can also see accounts whose 5h window
					-- is still active (their 5h reset is in the future) — those would
					-- have been filtered out by the old SQL.
					-- Skip accounts that are still inside an active per-account cooldown.
					-- ClankerMux already knows upstream will reject us until rate_limited_until,
					-- so probing during that window is a guaranteed-fail call that wastes
					-- quota, re-applies the same cooldown, and pollutes the request log
					-- with synthetic 503s (issue #199, bug 1).
					AND (
						rate_limited_until IS NULL OR rate_limited_until <= ?
					)
					-- Only probe a paused account if it was auto-paused due to billing
					-- overage. The auto-resume guard in sendTranslatedClaudePrime only un-pauses an
					-- account when auto_pause_on_overage_enabled=1 AND pause_reason IN
					-- (NULL, 'overage'); selecting any other paused account here would probe
					-- it forever yet never resume it. So a manually-paused account
					-- (pause_reason='manual') or one paused by the failure-threshold guard
					-- (pause_reason='failure_threshold') is left completely alone — probing it
					-- just burns quota and pollutes the request log with synthetic 429s for an
					-- account the user (or the guard) intentionally disabled (issue #199, bug 1).
					-- These criteria MUST stay in sync with the resume guard.
					AND (
						COALESCE(paused, 0) = 0
						OR (
							COALESCE(auto_pause_on_overage_enabled, 0) = 1
							AND (pause_reason IS NULL OR pause_reason = 'overage')
						)
					)
			`,
				[now],
			);

			log.debug(
				`Auto-refresh check found ${accounts.length} account(s) to consider`,
			);

			if (accounts.length === 0) {
				return;
			}

			// Log accounts being considered
			accounts.forEach((account) => {
				log.debug(
					`Considering account: ${account.name}, reset_time: ${account.rate_limit_reset ? new Date(Number(account.rate_limit_reset)).toISOString() : "null"}`,
				);
			});

			// Filter accounts for the FIVE-HOUR reason: only refresh if this is a NEW
			// 5h window. The fiveHourWindowGate reproduces the predicate the base SQL
			// used to enforce (we removed it from the query so the weekly pass can see
			// all accounts). It is REQUIRED: without it, a never-refreshed account whose
			// 5h reset is still in the FUTURE would hit shouldRefreshAccount's first-time
			// `return true` branch and be primed on first sight — a regression. The gate
			// gives shouldRefreshAccount exactly the rows the old SQL would have surfaced.
			const accountsToRefresh = accounts.filter((account) =>
				this.fiveHourDue(account, now),
			);

			if (accountsToRefresh.length > 0) {
				log.info(
					`Found ${accountsToRefresh.length} account(s) with new windows for auto-refresh`,
				);
			}

			// Snapshot which accounts are due for a 5h prime BEFORE we send anything.
			// The weekly pass uses this set to defer to the 5h reason — building it
			// pre-send guarantees "5h wins" even if a 5h send fails (a failed send must
			// not reclassify the account as weekly-only and prime it twice).
			const fiveHourDueIds = new Set(accountsToRefresh.map((a) => a.id));

			// Prime each due account. primeAccount dispatches on provider: codex
			// accounts flow through the CodexSpendCoordinator's native ping;
			// anthropic/zai stay on the translated sendTranslatedClaudePrime path
			// (which updates lastRefreshResetTime with the NEW rate_limit_reset from
			// the API).
			for (const accountRow of accountsToRefresh) {
				await this.primeAccount(accountRow);
			}

			// WEEKLY-DORMANT priming: prime at most ONE account per cycle whose weekly
			// (seven_day) window is dormant while its 5h window is still active. Scope
			// is anthropic-OAuth only (provider==='anthropic' && refresh_token); the
			// Haiku prime starts the AGGREGATE seven_day window. Model-specific
			// seven_day_opus/seven_day_sonnet windows legitimately stay dormant until
			// that model is used — that is expected and not handled here.
			const weeklyAccount = this.selectWeeklyPrimeCandidate(
				accounts,
				fiveHourDueIds,
				now,
			);
			if (weeklyAccount) {
				log.info(
					`Weekly-dormant prime: priming ${weeklyAccount.name} (weekly window dormant; 5h window still active)`,
				);
				try {
					await this.primeAccount(weeklyAccount);
				} finally {
					// Set the cooldown timestamp even on failure so a failing prime does
					// not retry-storm every cycle (no retry-storm).
					this.lastWeeklyPrimeTime.set(weeklyAccount.id, now);
				}
			}
		} catch (error) {
			if (error instanceof Error) {
				const errorMessage = `Error in auto-refresh check: ${error.name}: ${error.message}`;
				log.error(errorMessage);
				if (error.stack) {
					// Log the stack trace separately to ensure it's visible
					log.error(`Auto-refresh stack trace: ${error.stack}`);
				}
			} else if (error !== undefined && error !== null) {
				log.error(`Error in auto-refresh check: ${JSON.stringify(error)}`);
			} else {
				log.error(
					"Error in auto-refresh check: Unknown error (possibly undefined or null)",
				);
			}
		} finally {
			// Resolve the mutex to indicate the refresh operation is complete
			if (this.refreshMutexResolver) {
				this.refreshMutexResolver();
				this.refreshMutexResolver = null;
			}
			this.refreshMutex = null;
		}
	}

	/**
	 * Prime a single due account, dispatching on provider. Codex accounts flow
	 * through the CodexSpendCoordinator's native `/responses` ping (which owns the
	 * codex side-effects and the query-to-dispatch gate); anthropic/zai stay on the
	 * translated Haiku sendTranslatedClaudePrime path (including its own race-guard).
	 * Both the 5h loop and the weekly-dormant prime route through here.
	 */
	private async primeAccount(accountRow: AutoRefreshAccountRow): Promise<void> {
		if (accountRow.provider === "codex") {
			await this.primeCodexViaCoordinator(accountRow);
			return;
		}
		await this.sendTranslatedClaudePrime(accountRow);
	}

	/**
	 * Prime a codex account by asking the coordinator to observe a scheduled-prime
	 * spend. The coordinator issues the native ping and applies ALL codex
	 * side-effects (usageCache, credits carry-forward, window-roll + session reset,
	 * rate_limit_reset persistence, and the 429 cooldown), so the scheduler only
	 * interprets the outcome — it MUST NOT re-record usage/reset or re-apply the
	 * cooldown for codex.
	 */
	private async primeCodexViaCoordinator(
		accountRow: AutoRefreshAccountRow,
	): Promise<void> {
		const result = await this.coordinator.observe(
			accountRow.id,
			"scheduled-prime",
		);
		await this.handleCodexPrimeOutcome(accountRow, result);
	}

	/**
	 * Interpret a codex scheduled-prime {@link CodexSpendResult}:
	 *   - `skipped`   → NOT a failure (auto-refresh off / deleted / no tokens /
	 *                   last-moment suppression). Log + return.
	 *   - `failed`    → a genuine failure → recordRefreshFailure.
	 *   - `completed` + responseOk (2xx) → prime success (matching the old
	 *                   `response.ok` rule even when observation.usage is null):
	 *                   update lastRefreshResetTime from observation.earliestResetMs
	 *                   when present, clear the consecutive-failure counter, and run
	 *                   the SAME overage-resume the translated path did.
	 *   - `completed` + !responseOk (429/5xx) → recordRefreshFailure. The cooldown /
	 *                   rate_limit_reset were already applied by the applicator; the
	 *                   scheduler MUST NOT touch them here.
	 */
	private async handleCodexPrimeOutcome(
		accountRow: AutoRefreshAccountRow,
		result: CodexSpendResult,
	): Promise<void> {
		switch (result.status) {
			case "skipped":
				log.debug(
					`Codex scheduled prime skipped for ${accountRow.name}: ${result.reason}`,
				);
				return;
			case "failed":
				await this.recordRefreshFailure(
					accountRow.id,
					accountRow.name,
					"(codex native prime failed)",
				);
				return;
			case "completed": {
				if (!result.responseOk) {
					// 429/5xx: the coordinator/applicator already persisted any reset and
					// applied the 429 cooldown — do NOT re-apply it here. Just count the
					// failure toward the re-auth threshold, matching the old failure path.
					await this.recordRefreshFailure(
						accountRow.id,
						accountRow.name,
						`(codex native prime status ${result.responseStatus})`,
					);
					return;
				}

				// 2xx: prime success. The coordinator has already synchronously updated
				// usageCache / credits, so shouldResumeFromOverage below sees fresh state.
				const { earliestResetMs } = result.observation;
				if (earliestResetMs != null) {
					this.lastRefreshResetTime.set(accountRow.id, earliestResetMs);
					log.info(
						`Updated lastRefreshResetTime for ${accountRow.name} to ${new Date(earliestResetMs).toISOString()} (codex native prime)`,
					);
				}

				// Reset consecutive failure counter on successful prime.
				if (this.consecutiveFailures.has(accountRow.id)) {
					this.consecutiveFailures.delete(accountRow.id);
					log.debug(
						`Reset consecutive failure counter for account ${accountRow.name} after successful codex native prime`,
					);
				}

				// Auto-resume on window reset — identical rule to the translated path.
				// A codex account paused for "overage" is on paid credits (weekly at
				// 100%); shouldResumeFromOverage only permits the resume once the account
				// is no longer on credits, avoiding resume/re-pause flapping.
				if (
					accountRow.auto_pause_on_overage_enabled === 1 &&
					accountRow.paused === 1 &&
					(!accountRow.pause_reason || accountRow.pause_reason === "overage") &&
					this.shouldResumeFromOverage(accountRow)
				) {
					log.debug(
						`Auto-resuming codex account '${accountRow.name}' after native prime (auto-pause-on-overage enabled)`,
					);
					await this.db.run(
						"UPDATE accounts SET paused = 0, pause_reason = NULL WHERE id = ?",
						[accountRow.id],
					);
				}
				return;
			}
		}
	}

	/**
	 * Send a translated Claude `/v1/messages` dummy prime to refresh the usage
	 * window for an ANTHROPIC or ZAI account. This is the anthropic/zai-only path:
	 * codex accounts prime through the CodexSpendCoordinator's native `/responses`
	 * ping instead (see {@link primeCodexViaCoordinator}) and must never reach this
	 * translated dispatch — the guard below enforces that.
	 * @returns true if the refresh was successful, false otherwise
	 */
	private async sendTranslatedClaudePrime(accountRow: {
		id: string;
		name: string;
		provider: string;
		refresh_token: string;
		access_token: string | null;
		expires_at: number | null;
		rate_limit_reset: number | null;
		custom_endpoint: string | null;
		paused: number;
		auto_pause_on_overage_enabled: number;
		pause_reason: string | null;
	}): Promise<boolean> {
		// Provider guard: codex NEVER flows through the translated Claude dummy
		// dispatch. primeAccount already routes codex rows to the coordinator, so
		// reaching here with a codex account is a programming error (a caller
		// bypassed primeAccount's provider dispatch). Refuse it loudly and return
		// false so a codex row can NEVER hit dispatchProxyRequest — a translated
		// Haiku `/v1/messages` request would mistranslate for codex and still burn
		// real quota.
		if (accountRow.provider === "codex") {
			log.error(
				`sendTranslatedClaudePrime called with a codex account (${accountRow.name}) — codex primes via the native /responses ping, not the translated Claude dummy path. Refusing to dispatch.`,
			);
			return false;
		}
		try {
			// Query-to-dispatch race guard: checkAndRefresh() selects a batch of
			// auto_refresh_enabled=1 accounts, then awaits this dispatch per account.
			// An operator can toggle auto_refresh_enabled OFF in the dashboard between
			// that SELECT and this point. Re-read the CURRENT flag and skip the probe
			// if it is now 0 (or the account was deleted mid-pass) so autonomous
			// priming never starts a window for an account the operator just turned
			// off — no real quota spent. This single guard covers both callers (the
			// 5h refresh loop and the weekly-dormant prime); both route through here.
			const freshFlag = await this.db.query<{ auto_refresh_enabled: number }>(
				"SELECT COALESCE(auto_refresh_enabled, 0) as auto_refresh_enabled FROM accounts WHERE id = ?",
				[accountRow.id],
			);
			if (!freshFlag[0] || freshFlag[0].auto_refresh_enabled === 0) {
				log.info(
					`Skipping auto-refresh dispatch for ${accountRow.name} — auto_refresh_enabled turned off since selection`,
				);
				return false;
			}

			log.info(`Sending auto-refresh message to account: ${accountRow.name}`);

			const provider = getProvider(accountRow.provider);
			if (!provider) {
				log.error(
					`No provider found for ${accountRow.provider} (account: ${accountRow.name})`,
				);
				return false;
			}

			log.info(
				`Current token expires at: ${accountRow.expires_at ? new Date(Number(accountRow.expires_at)).toISOString() : "null"}`,
			);
			log.info(`Current time: ${new Date().toISOString()}`);
			log.info(`Access token available: ${!!accountRow.access_token}`);
			log.info(`Refresh token available: ${!!accountRow.refresh_token}`);

			// Create a minimal account object
			const account: Account = {
				id: accountRow.id,
				name: accountRow.name,
				provider: accountRow.provider,
				api_key: null,
				refresh_token: accountRow.refresh_token,
				access_token: accountRow.access_token,
				expires_at: accountRow.expires_at
					? Number(accountRow.expires_at)
					: null,
				request_count: 0,
				total_requests: 0,
				last_used: null,
				created_at: 0,
				rate_limited_until: null,
				rate_limited_reason: null,
				rate_limited_at: null,
				session_start: null,
				session_request_count: 0,
				paused: false,
				rate_limit_reset: accountRow.rate_limit_reset
					? Number(accountRow.rate_limit_reset)
					: null,
				rate_limit_status: null,
				rate_limit_remaining: null,
				priority: 0,
				auto_fallback_enabled: false,
				auto_refresh_enabled: true,
				auto_pause_on_overage_enabled: false,
				peak_hours_pause_enabled: false,
				custom_endpoint: accountRow.custom_endpoint,
				model_mappings: null,
				model_fallbacks: null,
				billing_type: null,
				pause_reason: null,
				notes: null,
				refresh_token_issued_at: null,
				renewal_anchor: null,
				renewal_cadence: null,
				renewal_price_usd_micros: null,
				renewal_auto_start_date: null,
				consecutive_rate_limits: 0,
			};

			// Prepare dummy message request
			const dummyMessages = [
				"Write a hello world program in Python",
				"What is 2+2?",
				"Tell me a programmer joke",
				"What is the capital of France?",
				"Explain recursion in one sentence",
			];

			const randomMessage =
				dummyMessages[Math.floor(Math.random() * dummyMessages.length)];

			// Dispatch through the proxy pipeline in-process via dispatchProxyRequest.
			// The URL is constructed for handleProxy's URL parsing only — there is no
			// HTTP self-loop, no port, no TLS. The x-clankermux-account-id header
			// is what actually forces routing to this specific account.
			const endpoint = "http://internal.clankermux/v1/messages";
			const url = new URL(endpoint);

			// Use same headers as normal Claude Code CLI requests, plus the special account ID header
			const headers = new Headers({
				accept: "application/json",
				"accept-language": "*",
				"anthropic-beta":
					"oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14",
				"anthropic-dangerous-direct-browser-access": "true",
				"anthropic-version": "2023-06-01",
				connection: "keep-alive",
				"content-type": "application/json",
				"sec-fetch-mode": "cors",
				"user-agent": `claude-cli/${getClientVersion()} (external, cli)`,
				"x-app": "cli",
				"x-stainless-arch": "x64",
				"x-stainless-helper-method": "stream",
				"x-stainless-lang": "js",
				"x-stainless-os": "Linux",
				"x-stainless-package-version": "0.60.0",
				"x-stainless-retry-count": "0",
				"x-stainless-runtime": "node",
				"x-stainless-runtime-version": "v24.9.0",
				"x-stainless-timeout": "600",
				// CRITICAL: Force the proxy to use this specific account
				"x-clankermux-account-id": account.id,
				// CRITICAL: Bypass session tracking for auto-refresh messages
				"x-clankermux-bypass-session": "true",
				// Tag the request as a synthetic auto-refresh probe so downstream
				// pipeline layers can distinguish it from real user traffic
				// (cache-body-store skips staging for these, request logging
				// and pool-exhausted 503 metrics filter them out — issue #199,
				// bug 2). Mirrors the existing x-clankermux-keepalive
				// pattern used by cache-keepalive-scheduler.ts.
				"x-clankermux-auto-refresh": "true",
			});

			// Try sending with multiple models if needed
			let response: Response | null = null;
			let lastError: Error | null = null;
			let modelToTry: string = CLAUDE_MODEL_IDS.HAIKU_4_5; // Default model
			const models = [
				CLAUDE_MODEL_IDS.HAIKU_4_5,
				CLAUDE_MODEL_IDS.SONNET_4_5,
				CLAUDE_MODEL_IDS.SONNET_4,
			];

			for (const model of models) {
				try {
					modelToTry = model; // Update the model being tried
					log.info(
						`Attempting auto-refresh for ${accountRow.name} with model: ${modelToTry}`,
					);

					const requestBody = {
						model: modelToTry,
						max_tokens: 10,
						messages: [
							{
								role: "user",
								content: randomMessage,
							},
						],
					};

					log.debug(
						`Auto-refresh request payload: ${JSON.stringify(requestBody, null, 2)}`,
					);

					const req = new Request(url, {
						method: "POST",
						headers,
						body: JSON.stringify(requestBody),
					});
					response = await dispatchProxyRequest(
						req,
						url,
						this.proxyContext,
						null,
						null,
						true,
					);

					log.debug(
						`Auto-refresh response status: ${response.status} ${response.statusText}`,
					);

					// If we get a successful response, break out of the loop
					if (response.ok || response.status !== 404) {
						break;
					}

					// If model not found (404), try next model
					if (response.status === 404) {
						log.debug(
							`Model ${modelToTry} not found for ${accountRow.name}, trying next model`,
						);
					}
				} catch (dispatchError) {
					lastError = dispatchError as Error;
					log.debug(
						`Dispatch error with model ${modelToTry} for ${accountRow.name}:`,
						dispatchError,
					);
				}
			}

			// If we couldn't get any successful response
			if (!response) {
				const errorMsg = lastError?.message || "All models failed";
				log.error(
					`Failed to send auto-refresh message to ${accountRow.name} with any model: ${errorMsg}`,
				);
				return false;
			}

			// Surface upstream OAuth expiry — the proxy raises 503 with a message
			// listing the affected accounts when refresh_token age exceeds the safety
			// window. Log loudly with the reauth command, but do NOT auto-disable
			// auto-refresh: that flag is a user setting, not a fault indicator, and
			// disabling it caused false-positive reauth prompts when the real fault
			// was elsewhere in the pipeline.
			if (response.status === 503) {
				try {
					const body = await response.clone().text();
					if (body.includes("OAuth tokens have expired")) {
						log.warn(
							`⚠️  Auto-refresh for "${accountRow.name}" reports an expired OAuth refresh token.`,
						);
						log.warn(
							`   Re-authenticate account "${accountRow.name}" from the dashboard (Accounts tab).`,
						);
					}
				} catch {
					// ignore body read errors — we still record the failure below
				}
			}

			if (response.ok) {
				log.info(
					`Auto-refresh message sent successfully for account: ${accountRow.name}`,
				);

				// Log the response for debugging
				let responseText = "";
				try {
					responseText = await response.text();
					log.info(
						`Auto-refresh response for ${accountRow.name}: ${responseText}`,
					);
				} catch (e) {
					log.warn(`Could not read response body for ${accountRow.name}: ${e}`);
				}

				// Use the provider's parseRateLimit method to get unified rate limit info
				const rateLimitInfo = provider.parseRateLimit(response);

				// Update rate limit fields from unified headers
				if (rateLimitInfo.resetTime) {
					await this.db.run(
						"UPDATE accounts SET rate_limit_reset = ?, rate_limited_until = NULL, consecutive_rate_limits = 0, rate_limited_at = NULL WHERE id = ?",
						[rateLimitInfo.resetTime, accountRow.id],
					);

					// Update our tracking with the NEW rate_limit_reset from the API
					this.lastRefreshResetTime.set(accountRow.id, rateLimitInfo.resetTime);

					log.info(
						`Updated rate_limit_reset for ${accountRow.name} to ${new Date(rateLimitInfo.resetTime).toISOString()}`,
					);
					log.info(
						`Cleared rate_limited_until for ${accountRow.name} as account has been refreshed`,
					);
				} else {
					// Even if no reset time is provided, clear rate_limited_until as the refresh was successful
					// Also make sure to clear any existing rate_limited_until value to ensure the account is not stuck
					await this.db.run(
						"UPDATE accounts SET rate_limited_until = NULL, consecutive_rate_limits = 0, rate_limited_at = NULL WHERE id = ?",
						[accountRow.id],
					);
					log.info(
						`Cleared rate_limited_until for ${accountRow.name} as account has been refreshed (no new reset time)`,
					);
				}

				if (rateLimitInfo.statusHeader) {
					await this.db.run(
						"UPDATE accounts SET rate_limit_status = ? WHERE id = ?",
						[rateLimitInfo.statusHeader, accountRow.id],
					);
					log.info(
						`Updated rate_limit_status for ${accountRow.name} to ${rateLimitInfo.statusHeader}`,
					);
				}

				if (rateLimitInfo.remaining !== undefined) {
					await this.db.run(
						"UPDATE accounts SET rate_limit_remaining = ? WHERE id = ?",
						[rateLimitInfo.remaining, accountRow.id],
					);
					log.info(
						`Updated rate_limit_remaining for ${accountRow.name} to ${rateLimitInfo.remaining}`,
					);
				}

				// Auto-resume on window reset: if an anthropic/zai account was
				// auto-paused due to overage, resume it now. Never auto-resume accounts
				// paused manually or due to the failure threshold.
				//
				// This path is anthropic/zai only — codex primes via the coordinator,
				// which runs its OWN overage-resume in handleCodexPrimeOutcome (the
				// codex flapping/credits rationale lives in shouldResumeFromOverage's
				// docstring). For anthropic/zai shouldResumeFromOverage is
				// unconditionally true; the call is kept as the shared, self-consistent
				// guard.
				if (
					accountRow.auto_pause_on_overage_enabled === 1 &&
					accountRow.paused === 1 &&
					(!accountRow.pause_reason || accountRow.pause_reason === "overage") &&
					this.shouldResumeFromOverage(accountRow)
				) {
					log.debug(
						`Auto-resuming account '${accountRow.name}' after window reset (auto-pause-on-overage enabled)`,
					);
					await this.db.run(
						"UPDATE accounts SET paused = 0, pause_reason = NULL WHERE id = ?",
						[accountRow.id],
					);
				}

				if (accountRow.provider === "anthropic") {
					// Fetch usage data from the OAuth usage endpoint to get 5h window info
					// Get the access token for this account
					const accessToken = await getValidAccessToken(
						account,
						this.proxyContext,
					);
					if (accessToken) {
						const { data: usageData } = await fetchUsageData(accessToken);
						if (usageData) {
							log.info(
								`Fetched usage data for ${accountRow.name}: 5h=${usageData.five_hour.utilization}%, 7d=${usageData.seven_day.utilization}%`,
							);
						} else {
							log.warn(
								`Failed to fetch usage data for ${accountRow.name} after auto-refresh`,
							);
						}
					}
				}

				// Reset consecutive failure counter on successful refresh
				if (this.consecutiveFailures.has(accountRow.id)) {
					this.consecutiveFailures.delete(accountRow.id);
					log.debug(
						`Reset consecutive failure counter for account ${accountRow.name} after successful auto-refresh`,
					);
				}

				return true;
			}

			log.error(
				`Auto-refresh message failed for account ${accountRow.name}: ${response.status} ${response.statusText}`,
			);

			// Log response body for debugging
			try {
				const errorBody = await response.text();
				log.error(`Response body: ${errorBody}`);
			} catch {
				// Ignore error reading body
			}

			// Track consecutive failures for this account
			await this.recordRefreshFailure(
				accountRow.id,
				accountRow.name,
				`(status ${response.status})`,
			);

			return false;
		} catch (error) {
			if (error instanceof Error) {
				const errorMessage = `Error sending auto-refresh message to account ${accountRow.name}: ${error.name}: ${error.message}`;
				log.error(errorMessage);
				if (error.stack) {
					// Log the stack trace separately to ensure it's visible
					log.error(
						`Auto-refresh stack trace for ${accountRow.name}: ${error.stack}`,
					);
				}
			} else if (error !== undefined && error !== null) {
				log.error(
					`Error sending auto-refresh message to account ${accountRow.name}: ${JSON.stringify(error)}`,
				);
			} else {
				log.error(
					`Error sending auto-refresh message to account ${accountRow.name}: Unknown error (possibly undefined or null)`,
				);
			}

			// Track consecutive failures for this account (for exceptions too)
			await this.recordRefreshFailure(
				accountRow.id,
				accountRow.name,
				"(exception)",
			);

			return false;
		}
	}

	/**
	 * Decide whether an overage-paused account may be auto-resumed by the current
	 * successful probe.
	 *
	 * For every provider EXCEPT codex this is unconditionally true — a successful
	 * window-reset probe is the resume signal (unchanged behaviour). It also
	 * returns true for any non-overage pause reason (those are filtered upstream
	 * by the caller, but the guard stays self-consistent).
	 *
	 * For codex, "overage" means the account is spending paid credits because its
	 * WEEKLY (seven_day) window is at 100%. Codex returns HTTP 200 while on
	 * credits, so the success path alone is not proof the weekly window reset.
	 * We consult the freshly-updated usageCache.codexCredits — populated
	 * synchronously by updateAccountMetadata (response-processor) during THIS
	 * probe's dispatch — and only resume when the account is no longer on credits
	 * (i.e. the weekly window has room again). This avoids resume/re-pause
	 * flapping on every 5h reset and stops the probe from burning more credits.
	 *
	 * Data source: usageCache (not the probe Response headers). The cache is
	 * updated deterministically inside this probe's own pipeline and does not
	 * depend on the x-codex-* headers surviving the multiple response rebuilds
	 * (model-mapping transform, codex processResponse, streaming transform) between
	 * upstream and the client-facing Response we hold here.
	 */
	private shouldResumeFromOverage(account: {
		id: string;
		provider: string;
		pause_reason: string | null;
	}): boolean {
		if (account.provider !== "codex") return true;
		if (account.pause_reason && account.pause_reason !== "overage") return true;
		const cached = usageCache.get(account.id) as {
			codexCredits?: CodexCreditsInfo | null;
		} | null;
		// Resume only when no longer on credits (weekly has room again). If the
		// cache lacks credits info (null/undefined → isCodexOnCredits(null) is
		// false), we resume — we have no evidence the account is still on credits,
		// and a stale pause is worse than an extra probe that re-pauses if needed.
		return !isCodexOnCredits(cached?.codexCredits ?? null);
	}

	/**
	 * Records a consecutive auto-refresh failure for an account. When the
	 * FAILURE_THRESHOLD is reached the account is paused in the database so
	 * that the request router skips it until an operator resumes it.
	 */
	private async recordRefreshFailure(
		accountId: string,
		accountName: string,
		context: string,
	): Promise<void> {
		const currentFailures = this.consecutiveFailures.get(accountId) || 0;
		const newFailures = currentFailures + 1;
		this.consecutiveFailures.set(accountId, newFailures);

		log.warn(
			`Account ${accountName} has failed ${newFailures} consecutive auto-refresh attempts ${context}. Threshold is ${this.FAILURE_THRESHOLD}.`,
		);

		if (newFailures >= this.FAILURE_THRESHOLD) {
			try {
				// Guarded on the account still being active so this generic
				// failure_threshold reason never overwrites a more specific reason
				// (e.g. oauth_invalid_grant) already set by the token-refresh chokepoint.
				const changes = await this.db.runWithChanges(
					`UPDATE accounts SET paused = 1, pause_reason = 'failure_threshold' WHERE id = ? AND COALESCE(paused, 0) = 0`,
					[accountId],
				);
				// Clear the counter regardless so subsequent scheduler cycles don't fire
				// redundant DB writes and log entries — the account is paused either way.
				this.consecutiveFailures.delete(accountId);
				if (changes > 0) {
					log.error(
						`Account "${accountName}" has failed ${newFailures} consecutive auto-refresh attempts — PAUSED (failure_threshold). Resume it from the dashboard (Accounts tab) or via POST /api/accounts/:id/resume.`,
					);
				} else {
					log.warn(
						`Account "${accountName}" hit the auto-refresh failure threshold but was already paused — leaving the existing pause reason intact.`,
					);
				}
			} catch (dbErr) {
				log.error(`Failed to pause account ${accountName} in database:`, dbErr);
			}
		}
	}

	/**
	 * Proactively refresh Qwen OAuth access tokens that are expiring within the safety window.
	 * Unlike Anthropic accounts (which use dummy messages to reset rate-limit windows),
	 * Qwen only needs the OAuth token refreshed — no dummy message required.
	 */
	private async checkAndRefreshQwenTokens(): Promise<void> {
		if (!this.db) return;

		const now = Date.now();
		const expiryThreshold = now + TOKEN_SAFETY_WINDOW_MS;

		const accounts = await this.db.query<{
			id: string;
			name: string;
			provider: string;
			refresh_token: string;
			access_token: string | null;
			expires_at: number | null;
			custom_endpoint: string | null;
		}>(
			`
			SELECT id, name, provider, refresh_token, access_token, expires_at, custom_endpoint
			FROM accounts
			WHERE
				provider = 'qwen'
				AND refresh_token IS NOT NULL
				AND (
					access_token IS NULL
					OR expires_at IS NULL
					OR expires_at <= ?
				)
		`,
			[expiryThreshold],
		);

		if (accounts.length === 0) return;

		log.info(
			`Proactive Qwen token refresh: ${accounts.length} account(s) need refresh`,
		);

		for (const row of accounts) {
			// Skip if a refresh is already in-flight for this account (deduplication)
			if (this.proxyContext.refreshInFlight.has(row.id)) {
				log.debug(
					`Skipping proactive Qwen refresh for ${row.name} — refresh already in-flight`,
				);
				continue;
			}

			try {
				log.info(`Refreshing Qwen token for account: ${row.name}`);

				const provider = getProvider(row.provider);
				if (!provider) {
					log.error(`No provider found for qwen (account: ${row.name})`);
					continue;
				}

				const account: Account = {
					id: row.id,
					name: row.name,
					provider: row.provider,
					api_key: null,
					refresh_token: row.refresh_token,
					access_token: row.access_token,
					expires_at: row.expires_at,
					request_count: 0,
					total_requests: 0,
					last_used: null,
					created_at: 0,
					rate_limited_until: null,
					rate_limited_reason: null,
					rate_limited_at: null,
					session_start: null,
					session_request_count: 0,
					paused: false,
					rate_limit_reset: null,
					rate_limit_status: null,
					rate_limit_remaining: null,
					priority: 0,
					auto_fallback_enabled: false,
					auto_refresh_enabled: true,
					auto_pause_on_overage_enabled: false,
					peak_hours_pause_enabled: false,
					custom_endpoint: row.custom_endpoint,
					model_mappings: null,
					model_fallbacks: null,
					billing_type: null,
					pause_reason: null,
					notes: null,
					refresh_token_issued_at: null,
					renewal_anchor: null,
					renewal_cadence: null,
					renewal_price_usd_micros: null,
					renewal_auto_start_date: null,
					consecutive_rate_limits: 0,
				};

				// Use refreshAccessTokenSafe to get deduplication and backoff handling
				const refreshPromise = provider
					.refreshToken(account, this.proxyContext.runtime.clientId)
					.then(async (result) => {
						const newRefreshToken = result.refreshToken ?? row.refresh_token;
						await this.db.run(
							`UPDATE accounts SET access_token = ?, expires_at = ?, refresh_token = ?, refresh_token_issued_at = ? WHERE id = ?`,
							[
								result.accessToken,
								result.expiresAt,
								newRefreshToken,
								Date.now(),
								row.id,
							],
						);
						log.info(
							`Qwen token refreshed for ${row.name}, expires at ${new Date(result.expiresAt).toISOString()}`,
						);
						return result.accessToken;
					})
					.finally(() => {
						this.proxyContext.refreshInFlight.delete(row.id);
					});

				this.proxyContext.refreshInFlight.set(row.id, refreshPromise);
				await refreshPromise;
			} catch (error) {
				log.error(
					`Failed to proactively refresh Qwen token for ${row.name}:`,
					error,
				);
				// This proactive path calls provider.refreshToken directly (bypassing
				// refreshAccessTokenSafe), so pause-for-reauth on a revoked token here too.
				await pauseAccountForReauthIfInvalidGrant(
					error,
					{ id: row.id, name: row.name, refresh_token: row.refresh_token },
					this.proxyContext.dbOps,
				);
			}
		}
	}

	/**
	 * Proactively refresh Codex OAuth access tokens that are expiring within the safety window.
	 * Codex uses rotating refresh tokens, so each refresh returns a new refresh token.
	 */
	private async checkAndRefreshCodexTokens(): Promise<void> {
		if (!this.db) return;

		const now = Date.now();
		const expiryThreshold = now + TOKEN_SAFETY_WINDOW_MS;

		const accounts = await this.db.query<{
			id: string;
			name: string;
			provider: string;
			refresh_token: string;
			access_token: string | null;
			expires_at: number | null;
			custom_endpoint: string | null;
		}>(
			`
			SELECT id, name, provider, refresh_token, access_token, expires_at, custom_endpoint
			FROM accounts
			WHERE
				provider = 'codex'
				AND refresh_token IS NOT NULL
				AND (
					access_token IS NULL
					OR expires_at IS NULL
					OR expires_at <= ?
				)
		`,
			[expiryThreshold],
		);

		if (accounts.length === 0) return;

		log.info(
			`Proactive Codex token refresh: ${accounts.length} account(s) need refresh`,
		);

		for (const row of accounts) {
			// Skip if a refresh is already in-flight for this account (deduplication)
			if (this.proxyContext.refreshInFlight.has(row.id)) {
				log.debug(
					`Skipping proactive Codex refresh for ${row.name} — refresh already in-flight`,
				);
				continue;
			}

			try {
				log.info(`Refreshing Codex token for account: ${row.name}`);

				const provider = getProvider(row.provider);
				if (!provider) {
					log.error(`No provider found for codex (account: ${row.name})`);
					continue;
				}

				const account: Account = {
					id: row.id,
					name: row.name,
					provider: row.provider,
					api_key: null,
					refresh_token: row.refresh_token,
					access_token: row.access_token,
					expires_at: row.expires_at,
					request_count: 0,
					total_requests: 0,
					last_used: null,
					created_at: 0,
					rate_limited_until: null,
					rate_limited_reason: null,
					rate_limited_at: null,
					session_start: null,
					session_request_count: 0,
					paused: false,
					rate_limit_reset: null,
					rate_limit_status: null,
					rate_limit_remaining: null,
					priority: 0,
					auto_fallback_enabled: false,
					auto_refresh_enabled: true,
					auto_pause_on_overage_enabled: false,
					peak_hours_pause_enabled: false,
					custom_endpoint: row.custom_endpoint,
					model_mappings: null,
					model_fallbacks: null,
					billing_type: null,
					pause_reason: null,
					notes: null,
					refresh_token_issued_at: null,
					renewal_anchor: null,
					renewal_cadence: null,
					renewal_price_usd_micros: null,
					renewal_auto_start_date: null,
					consecutive_rate_limits: 0,
				};

				// Register in refreshInFlight so concurrent request-triggered refreshes join this one
				const refreshPromise = provider
					.refreshToken(account, this.proxyContext.runtime.clientId)
					.then(async (result) => {
						const newRefreshToken = result.refreshToken ?? row.refresh_token;
						await this.db.run(
							`UPDATE accounts SET access_token = ?, expires_at = ?, refresh_token = ?, refresh_token_issued_at = ? WHERE id = ?`,
							[
								result.accessToken,
								result.expiresAt,
								newRefreshToken,
								Date.now(),
								row.id,
							],
						);
						log.info(
							`Codex token refreshed for ${row.name}, expires at ${new Date(result.expiresAt).toISOString()}`,
						);
						return result.accessToken;
					})
					.finally(() => {
						this.proxyContext.refreshInFlight.delete(row.id);
					});

				this.proxyContext.refreshInFlight.set(row.id, refreshPromise);
				await refreshPromise;
			} catch (error) {
				log.error(
					`Failed to proactively refresh Codex token for ${row.name}:`,
					error,
				);
				// This proactive path calls provider.refreshToken directly (bypassing
				// refreshAccessTokenSafe), so pause-for-reauth on a revoked token here too.
				await pauseAccountForReauthIfInvalidGrant(
					error,
					{ id: row.id, name: row.name, refresh_token: row.refresh_token },
					this.proxyContext.dbOps,
				);
			}
		}
	}

	/**
	 * Clean up the tracking map by removing entries for accounts that no longer exist
	 * or have auto-refresh disabled
	 */
	private async cleanupTracking(): Promise<void> {
		try {
			// Check if database is available
			if (!this.db) {
				log.warn("Database not available for cleanup tracking");
				return;
			}

			// Get all account IDs that have auto-refresh enabled
			const rows = await this.db.query<{ id: string }>(
				`SELECT id FROM accounts WHERE auto_refresh_enabled = 1 AND provider IN ('anthropic', 'codex', 'zai')`,
			);

			const activeAccountIds = rows.map((row) => row.id);
			const activeAccountIdSet = new Set(activeAccountIds);

			// Remove entries from the maps that are not in the active set
			for (const accountId of this.lastRefreshResetTime.keys()) {
				if (!activeAccountIdSet.has(accountId)) {
					this.lastRefreshResetTime.delete(accountId);
					log.debug(
						`Removed tracking entry for account ${accountId} (no longer exists or auto-refresh disabled)`,
					);
				}
			}

			// Also clean up consecutive failures for non-active accounts
			for (const accountId of this.consecutiveFailures.keys()) {
				if (!activeAccountIdSet.has(accountId)) {
					this.consecutiveFailures.delete(accountId);
					log.debug(
						`Removed consecutive failure tracking for account ${accountId} (no longer exists or auto-refresh disabled)`,
					);
				}
			}

			// And the weekly-prime cooldown map for non-active accounts
			for (const accountId of this.lastWeeklyPrimeTime.keys()) {
				if (!activeAccountIdSet.has(accountId)) {
					this.lastWeeklyPrimeTime.delete(accountId);
					log.debug(
						`Removed weekly-prime tracking for account ${accountId} (no longer exists or auto-refresh disabled)`,
					);
				}
			}
		} catch (error) {
			if (error instanceof Error) {
				const errorMessage = `Error cleaning up tracking map: ${error.name}: ${error.message}`;
				log.error(errorMessage);
				if (error.stack) {
					// Log the stack trace separately to ensure it's visible
					console.error(`Tracking map cleanup stack trace: ${error.stack}`);
				}
			} else if (error !== undefined && error !== null) {
				log.error(`Error cleaning up tracking map: ${JSON.stringify(error)}`);
			} else {
				log.error(
					"Error cleaning up tracking map: Unknown error (possibly undefined or null)",
				);
			}
			// Don't throw - this is a non-critical cleanup operation
		}
	}

	/**
	 * Pause or resume zai accounts based on per-account peak_hours_pause_enabled flag.
	 * Only touches accounts that have opted in to peak hours auto-pause.
	 */
	private async checkPeakHoursPause(): Promise<void> {
		const inPeak = isZaiPeakHour();

		const zaiAccounts = await this.db.query<{
			id: string;
			name: string;
			paused: number;
			pause_reason: string | null;
			peak_hours_pause_enabled: number;
		}>(
			`SELECT id, name, COALESCE(paused, 0) as paused, pause_reason, COALESCE(peak_hours_pause_enabled, 0) as peak_hours_pause_enabled
			 FROM accounts WHERE provider = 'zai' AND peak_hours_pause_enabled = 1`,
		);

		for (const account of zaiAccounts) {
			if (inPeak && !account.paused) {
				// Pause account during peak hours
				// SQL-level guard prevents race: if another actor paused the account
				// with a different reason between SELECT and UPDATE, skip it
				await this.db.run(
					"UPDATE accounts SET paused = 1, pause_reason = 'peak_hours' WHERE id = ? AND COALESCE(paused, 0) = 0",
					[account.id],
				);
				log.info(`Peak hours pause: paused zai account '${account.name}'`);
			} else if (
				!inPeak &&
				account.paused &&
				account.pause_reason === "peak_hours"
			) {
				// Resume account after peak hours (only if we paused it)
				// SQL-level guard prevents race condition: if manual-pause API changed pause_reason
				// between SELECT and UPDATE, this UPDATE will not affect that account
				await this.db.run(
					"UPDATE accounts SET paused = 0, pause_reason = NULL WHERE id = ? AND pause_reason = 'peak_hours'",
					[account.id],
				);
				log.info(`Peak hours resume: resumed zai account '${account.name}'`);
			}
		}
	}

	/**
	 * Gate reproducing the 5-hour reset predicate the base eligibility SQL used to
	 * enforce (before it was broadened for weekly priming). An account is in scope
	 * for the 5h reason only when it has no known reset (rate_limit_reset == null)
	 * or its reset is already at/in the past. This excludes accounts whose 5h reset
	 * is still in the FUTURE — exactly what the old `rate_limit_reset <= ?` SQL did.
	 */
	private fiveHourWindowGate(
		account: { rate_limit_reset: number | null },
		now: number,
	): boolean {
		return account.rate_limit_reset == null || account.rate_limit_reset <= now;
	}

	/**
	 * True when an account is due for a FIVE-HOUR prime: it passes the window gate
	 * AND shouldRefreshAccount's new-window detection. Composing the two reproduces
	 * the old behaviour (SQL pre-filter + shouldRefreshAccount) exactly.
	 */
	private fiveHourDue(
		account: {
			id: string;
			name: string;
			provider: string;
			refresh_token: string;
			access_token: string | null;
			expires_at: number | null;
			rate_limit_reset: number | null;
			custom_endpoint: string | null;
		},
		now: number,
	): boolean {
		return (
			this.fiveHourWindowGate(account, now) &&
			this.shouldRefreshAccount(account, now)
		);
	}

	/**
	 * Classify an account's WEEKLY (seven_day) window as dormant based on the cached
	 * usage datum. Dormant means the weekly window has not started / has reset and
	 * is sitting idle, so a prime would (re)start it.
	 *
	 * Returns true iff:
	 *  - there is a fresh cached usage datum (age known and within
	 *    WEEKLY_CACHE_MAX_AGE_MS), AND
	 *  - it carries a seven_day window, AND
	 *  - that window's resets_at is null AND its utilization is exactly 0
	 *    (never started), OR resets_at parses to a timestamp that is at/before now
	 *    (already reset and idle).
	 *
	 * The null-reset case additionally requires utilization === 0. A null reset
	 * with util > 0 (or util null) is anomalous/unknown — the dashboard labels it
	 * "no reset data", NOT "not started" — so we treat it as NOT dormant and skip,
	 * rather than priming it every cooldown indefinitely. This keeps the priming
	 * decision consistent with the dashboard copy (util 0 + null reset = "not
	 * started"; util>0/null + null reset = "no reset data").
	 *
	 * A non-null but unparseable resets_at → toEpochMs returns null → NOT dormant
	 * (unknown → skip). A future reset → NOT dormant (window still running).
	 */
	private isWeeklyDormant(accountId: string, now: number): boolean {
		const entry = usageCache.get(accountId);
		if (!entry) return false;

		// Freshness: getAge returns ms-age, or null when there's no entry / it is
		// older than the cache's own 10-min ceiling. We additionally require it to
		// be within WEEKLY_CACHE_MAX_AGE_MS so we only prime on recent evidence.
		const age = usageCache.getAge(accountId);
		if (age === null || age > this.WEEKLY_CACHE_MAX_AGE_MS) return false;

		const seven = (
			entry as {
				seven_day?: { utilization: number | null; resets_at: string | null };
			}
		).seven_day;
		if (!seven) return false;

		// null reset + util 0 → never started → dormant.
		// null reset + util null/>0 → "no reset data" → unknown → NOT dormant.
		if (seven.resets_at == null) return seven.utilization === 0;
		const resetMs = toEpochMs(seven.resets_at);
		if (resetMs === null) return false; // unparseable → unknown → skip
		return resetMs <= now; // already reset and idle → dormant
	}

	/**
	 * Pick at most ONE account to prime for the WEEKLY-dormant reason this cycle.
	 * Candidates must:
	 *  - NOT already be due for a 5h prime (5h reason takes precedence),
	 *  - be anthropic-OAuth (provider==='anthropic' && refresh_token present),
	 *  - have a dormant weekly window (isWeeklyDormant), and
	 *  - be outside the per-account WEEKLY_PRIME_COOLDOWN_MS.
	 * Survivors are sorted OLDEST-weekly-prime-first (a never-primed account, whose
	 * lastWeeklyPrimeTime is absent → treated as 0, sorts ahead of any previously
	 * primed account), tie-broken by id ascending for determinism. The first is
	 * returned, or null if none qualify. Sorting by last-prime time (rather than by
	 * id) is what prevents starvation: with the cap of 1-per-cycle and the 15-minute
	 * cooldown, an id-ascending sort would let the lowest-id account become eligible
	 * again (cooldown elapsed) and be re-primed before higher-id accounts are ever
	 * chosen. Round-robining by least-recently-primed guarantees fairness.
	 */
	private selectWeeklyPrimeCandidate(
		candidates: AutoRefreshAccountRow[],
		fiveHourDueIds: Set<string>,
		now: number,
	): AutoRefreshAccountRow | null {
		const eligible = candidates.filter(
			(c) =>
				!fiveHourDueIds.has(c.id) &&
				c.provider === "anthropic" &&
				!!c.refresh_token &&
				this.isWeeklyDormant(c.id, now) &&
				now - (this.lastWeeklyPrimeTime.get(c.id) ?? 0) >=
					this.WEEKLY_PRIME_COOLDOWN_MS,
		);

		if (eligible.length === 0) return null;

		// Oldest weekly-prime first (never-primed = 0 sorts first), tie-break by id.
		eligible.sort((a, b) => {
			const aLast = this.lastWeeklyPrimeTime.get(a.id) ?? 0;
			const bLast = this.lastWeeklyPrimeTime.get(b.id) ?? 0;
			if (aLast !== bLast) return aLast - bLast;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});

		if (eligible.length > 1) {
			log.debug(
				`Weekly-dormant prime: ${eligible.length} candidate(s) dormant; priming 1 (${eligible[0].name}), deferring ${eligible.length - 1} to later cycles`,
			);
		}

		return eligible[0];
	}

	/**
	 * Determine if an account should be refreshed based on its reset time and tracking state
	 * @param account - The account to check
	 * @param now - The current timestamp
	 * @returns true if the account should be refreshed, false otherwise
	 */
	private shouldRefreshAccount(
		account: {
			id: string;
			name: string;
			provider: string;
			refresh_token: string;
			access_token: string | null;
			expires_at: number | null;
			rate_limit_reset: number | null;
			custom_endpoint: string | null;
		},
		now: number,
	): boolean {
		const lastResetTime = this.lastRefreshResetTime.get(account.id);

		// If we've never refreshed this account before, refresh it
		if (!lastResetTime) {
			log.info(`First-time refresh for account: ${account.name}`);
			return true;
		}

		// If no rate_limit_reset is available, skip
		if (!account.rate_limit_reset) {
			return false;
		}

		// Check if the reset time has passed - we need to refresh to get the next window's reset time
		const resetTimeHasPassed = account.rate_limit_reset <= now;
		if (resetTimeHasPassed) {
			log.info(
				`New window detected for account ${account.name}: reset time ${new Date(Number(account.rate_limit_reset)).toISOString()} has passed (now: ${new Date(now).toISOString()}), last refresh was at ${new Date(lastResetTime).toISOString()}`,
			);
			return true;
		}

		// Check if the database has a newer reset time than what we last refreshed
		// This handles the case where an external request updated the reset time
		const isNewerThanLastRefresh = account.rate_limit_reset > lastResetTime;
		if (isNewerThanLastRefresh) {
			log.info(
				`New window detected for account ${account.name}: current reset ${new Date(Number(account.rate_limit_reset)).toISOString()} > last refresh ${new Date(lastResetTime).toISOString()}`,
			);
			return true;
		}

		// Check if the reset time is very old (more than 24 hours) - this indicates a stale reset time that needs refresh
		const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
		if (account.rate_limit_reset < oneDayAgo) {
			log.info(
				`Stale reset time detected for account ${account.name}: ${new Date(Number(account.rate_limit_reset)).toISOString()} is more than 24h old, forcing refresh`,
			);
			return true;
		}

		// The window hasn't renewed yet - skip
		log.debug(
			`No new window for account ${account.name}: current reset ${new Date(Number(account.rate_limit_reset)).toISOString()}, last refresh ${new Date(lastResetTime).toISOString()}, now ${new Date(now).toISOString()}`,
		);
		return false;
	}
}
