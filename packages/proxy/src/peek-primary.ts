import type { Config } from "@clankermux/config";
import { Logger } from "@clankermux/logger";
import { usageCache } from "@clankermux/providers";
import type { Account, LoadBalancingStrategy } from "@clankermux/types";
import { getUsageThrottleUntil } from "./handlers/usage-throttling";
import { getProviderOverloadUntil } from "./provider-overload-cooldown";

const log = new Logger("PrimaryAccountPeek");

// Last computed primary id, for change-only diagnostic logging. `undefined`
// means "never computed"; `null` means "computed, but nothing was eligible".
let lastPrimaryAccountId: string | null | undefined;

/**
 * Predict the account a FRESH, no-affinity, NOMINAL-size request would route to
 * RIGHT NOW, applying the same proxy gates the real request path applies — in
 * the same order: provider-overload (the shared 529 `anthropic-upstream`
 * cooldown) THEN usage-throttle. Used to drive the dashboard "Primary" badge so
 * it reflects where traffic actually goes during an outage instead of the raw,
 * gate-blind strategy ranking.
 *
 * Modeled scope (intentionally narrow — a single fresh nominal request):
 *  - Walks the strategy's `peekRanked()` ordering and returns the first account
 *    that passes both gates. Because the ranking spans providers, **cross-provider
 *    fallback to Codex IS modeled**: when every Anthropic account is gated, a
 *    healthy Codex account further down the ranking becomes the primary.
 *  - Returns `null` when every ranked account is gated (badge shows on no one).
 *
 * Deliberately NOT modeled (would require request-specific inputs the badge has
 * no business assuming):
 *  - The context-window gate — we assume a normal-size request, so Codex stays
 *    eligible (a huge prompt that wouldn't fit Codex is not the "next session").
 *  - Burst-throttle — it only delays a request, it does not change its target.
 *  - Combo / model-family routing — request-shape dependent.
 *
 * Purity note: this is read-only with respect to routing state, but not strictly
 * pure — `getProviderOverloadUntil` / `getUsageThrottleUntil` (via `usageCache.get`)
 * may evict their own expired entries as a side effect of being read.
 */
export function peekPrimaryAccountId(
	accounts: Account[],
	strategy: LoadBalancingStrategy | null | undefined,
	config: Pick<
		Config,
		"getUsageThrottlingFiveHourEnabled" | "getUsageThrottlingWeeklyEnabled"
	>,
	now = Date.now(),
): string | null {
	if (!strategy) return null;

	// Mirror applyUsageThrottling() in proxy.ts exactly.
	const settings = {
		fiveHourEnabled: config.getUsageThrottlingFiveHourEnabled(),
		weeklyEnabled: config.getUsageThrottlingWeeklyEnabled(),
	};
	const throttlingActive = settings.fiveHourEnabled || settings.weeklyEnabled;

	const skippedOverloaded: string[] = [];
	const skippedThrottled: string[] = [];
	let primaryId: string | null = null;

	for (const account of strategy.peekRanked(accounts)) {
		const ov = getProviderOverloadUntil(account.provider, now);
		if (ov && ov > now) {
			skippedOverloaded.push(account.id);
			continue;
		}

		if (throttlingActive) {
			const tu = getUsageThrottleUntil(
				usageCache.get(account.id),
				settings,
				now,
			);
			if (tu && tu > now) {
				skippedThrottled.push(account.id);
				continue;
			}
		}

		primaryId = account.id;
		break;
	}

	// Cheap, change-only diagnostic: only emit when the chosen primary actually
	// moves (mirrors the spirit of the old strategy-level logPeekChange).
	if (primaryId !== lastPrimaryAccountId) {
		const skips: string[] = [];
		if (skippedOverloaded.length) {
			skips.push(`overload-skipped=[${skippedOverloaded.join(", ")}]`);
		}
		if (skippedThrottled.length) {
			skips.push(`throttle-skipped=[${skippedThrottled.join(", ")}]`);
		}
		log.info(
			`Primary account → ${primaryId ?? "none"}${
				skips.length ? ` (${skips.join(" ")})` : ""
			}`,
		);
		lastPrimaryAccountId = primaryId;
	}

	return primaryId;
}
