import { Logger } from "@clankermux/logger";
import { restartUsagePollingForAccount } from "@clankermux/proxy";
import { supportsUsagePolling } from "@clankermux/types";

const log = new Logger("AccountUsagePriming");

/**
 * Start usage polling for a freshly-created account so its 5h / weekly (and
 * per-family) usage populates right away, instead of showing a single blank
 * placeholder bar until the next service restart or a manual "Refresh usage".
 *
 * Why this is needed: the `GET /api/accounts` response derives `usageData`
 * (and `usageUtilization` / `usageWindow`) solely from the in-memory
 * usageCache, which is filled only by the UsageFetcher polling loop. That loop
 * is otherwise started in just two places — server boot (for accounts that
 * existed then) and the manual refresh button — so an account added at runtime
 * never gets polled and its cache entry stays absent, yielding
 * `usageData: null`. This wires the same restart the refresh button uses
 * (`restartUsagePollingForAccount`, whose first fetch is immediate) into the
 * account-creation path.
 *
 * Which providers qualify is decided by `supportsUsagePolling`, not by a list
 * kept here: Codex usage is warmed separately by the CodexSpendCoordinator, and
 * console API-key, Qwen and the other pass-through providers have no pollable
 * usage window. `restartUsagePollingForAccount` also guards on provider
 * internally, but short-circuiting here keeps the intent explicit and avoids a
 * needless dispatch + DB lookup for those providers.
 *
 * Never throws — a priming failure must not fail account creation; polling will
 * still begin on the next service restart.
 */
export async function primeUsagePollingForNewAccount(account: {
	id: string;
	provider: string;
	name: string;
}): Promise<void> {
	if (!supportsUsagePolling(account.provider)) {
		return;
	}
	try {
		const started = await restartUsagePollingForAccount(account.id);
		log.info(
			`Usage polling ${started ? "started" : "not started"} for new account '${account.name}'`,
		);
	} catch (err) {
		log.warn(
			`Failed to start usage polling for new account '${account.name}': ${err}`,
		);
	}
}
