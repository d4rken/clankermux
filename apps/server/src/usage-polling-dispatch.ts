import { Logger } from "@clankermux/logger";
import type { CapacityRestoredEvidence } from "@clankermux/providers";
import { usageCache } from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import { supportsUsagePolling } from "@clankermux/types";

const log = new Logger("UsagePollingDispatch");

/**
 * One definition of "how do we start usage polling for provider X".
 *
 * Every entry point routes through here: the boot sweeps, which start pollers
 * for accounts that existed at startup, and the registered polling restarter,
 * which serves account creation and the manual refresh button. They used to be
 * separate code, which is how a Z.ai account added at runtime ended up never
 * polled at all while the identical account survived a restart polling fine.
 *
 * Providers differ in more than a credential, so this dispatches to explicit
 * per-provider starters rather than flattening them into one generic call:
 * Anthropic carries five callbacks and a demand-aware cadence, Devin re-reads
 * its key per poll and reports identity metadata, Z.ai needs the session reset
 * that Kilo must NOT get, and grok-subscription authenticates with a refreshed
 * OAuth token rather than a stored key.
 */
export interface UsagePollingStarters {
	/**
	 * Anthropic's refresh-aware starter. Injected rather than imported so this
	 * module can be loaded (and tested) without pulling in server.ts.
	 */
	startAnthropic: (account: Account, initialDelayMs: number) => void;
	/** Devin's starter, including its endpoint handling and metadata effects. */
	startDevin: (account: Account) => boolean;
	/**
	 * Refresh-aware token provider for the OAuth providers that need no bespoke
	 * starter. Injected for the same reason `startAnthropic` is: this module
	 * must load without pulling in server.ts.
	 */
	createTokenProvider: (account: Account) => () => Promise<string>;
	/** Resets the account's session window when a usage window rolls over. */
	resetAccountSession: (accountId: string) => void;
	/**
	 * Hands a poll's account-wide headroom reading to the listener that decides
	 * whether a quota-derived cooldown may be released before its deadline.
	 */
	onCapacityRestored: (evidence: CapacityRestoredEvidence) => void;
	/** Reads the CURRENT stored key, so a credential edit is picked up. */
	getApiKey: (accountId: string) => Promise<string | null>;
	intervalMs: () => number;
}

/**
 * Providers whose usage window is a SESSION that rolls over, so a reset must
 * reset session tracking too. Kilo is credit-based and has no such window; a
 * session reset there would zero counters nothing re-establishes.
 */
const SESSION_WINDOW_PROVIDERS: ReadonlySet<string> = new Set(["zai"]);

/**
 * Providers whose usage payload reports an ACCOUNT-WIDE utilization, so a poll
 * that sees headroom is evidence the account as a whole recovered and a
 * quota-derived cooldown can be released early. Kilo reports a credit balance,
 * which is not a window and says nothing about a lock.
 *
 * grok-subscription qualifies because its single weekly pool IS the account:
 * Chat, Imagine, Voice, Build and API all draw on it, so there is no surface
 * whose exhaustion the reading could miss.
 */
const ACCOUNT_WIDE_WINDOW_PROVIDERS: ReadonlySet<string> = new Set([
	"zai",
	"grok-subscription",
]);

/**
 * Start usage polling for one account.
 *
 * `initialDelayMs` staggers the boot wave; the runtime paths pass 0 so a newly
 * added account's bars fill immediately. Returns whether a poller was started —
 * a false result is a reason to tell the operator, never a thrown error, since
 * every caller is a best-effort side path.
 */
export function startUsagePollingFor(
	account: Account,
	starters: UsagePollingStarters,
	initialDelayMs = 0,
): boolean {
	if (account.disabled) return false;
	if (!supportsUsagePolling(account.provider)) {
		log.debug(
			`Not starting usage polling for ${account.name}: provider ${account.provider} has no pollable usage window`,
		);
		return false;
	}

	if (account.provider === "anthropic") {
		if (!account.access_token && !account.refresh_token) {
			log.warn(
				`Account ${account.name} has no access token or refresh token, skipping usage polling`,
			);
			return false;
		}
		starters.startAnthropic(account, initialDelayMs);
		return true;
	}

	if (account.provider === "devin") {
		usageCache.stopPolling(account.id);
		return starters.startDevin(account);
	}

	// Created the Qwen/Codex way: `api_key` is NULL and the credentials live in
	// `access_token`/`refresh_token`. This has to precede the API-key
	// fallthrough below, which would refuse the account on its missing key and
	// leave EVERY lifecycle path — the boot sweep, the restarter behind re-auth,
	// account-add priming and the manual refresh button — with no poller at all.
	if (account.provider === "grok-subscription") {
		if (!account.access_token && !account.refresh_token) {
			log.warn(
				`Account ${account.name} has no access token or refresh token, skipping usage polling`,
			);
			return false;
		}
		// No custom endpoint (the provider ignores one) and no session-reset
		// callback: a paid Grok plan draws Chat, Imagine, Voice, Build and API
		// from one weekly pool, so it has no session window to roll. That same
		// pool is what makes the reading account-wide, hence the capacity-restored
		// callback — gated on the set above so membership stays the one place
		// that decides which providers may release a cooldown early.
		usageCache.startPolling(
			account.id,
			starters.createTokenProvider(account),
			account.provider,
			starters.intervalMs(),
			undefined, // customEndpoint
			undefined, // onWindowReset
			ACCOUNT_WIDE_WINDOW_PROVIDERS.has(account.provider)
				? (evidence) => starters.onCapacityRestored(evidence)
				: undefined,
		);
		log.info(
			`Started usage polling for ${account.provider} account ${account.name}`,
		);
		return true;
	}

	// API-key providers (zai, kilo). No token to refresh: the poller re-reads the
	// stored key each tick so an edited key is picked up without a restart, and a
	// key removed underneath it ends the poll rather than sending an empty
	// credential upstream.
	if (!account.api_key) {
		log.warn(
			`${account.provider} account ${account.name} has no API key, skipping usage polling`,
		);
		return false;
	}
	usageCache.startPolling(
		account.id,
		async () => {
			const key = await starters.getApiKey(account.id);
			if (!key)
				throw new Error(`${account.provider} account credentials unavailable`);
			return key;
		},
		account.provider,
		starters.intervalMs(),
		undefined, // customEndpoint: these providers pin their own usage endpoint
		SESSION_WINDOW_PROVIDERS.has(account.provider)
			? (accountId) => starters.resetAccountSession(accountId)
			: undefined,
		ACCOUNT_WIDE_WINDOW_PROVIDERS.has(account.provider)
			? (evidence) => starters.onCapacityRestored(evidence)
			: undefined,
	);
	log.info(
		`Started usage polling for ${account.provider} account ${account.name}`,
	);
	return true;
}
