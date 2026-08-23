import type {
	AccountUsagePrediction,
	ApiKeyResponse,
	FullUsageData,
	RunwayKeyEntry,
	RunwayOutcome,
} from "@clankermux/types";
import { isAccountAllowedByPin, type RoutingPin } from "./api-key-pin";
import {
	computeCapacityRunway,
	type RunwayAccountInput,
	type RunwayWindowInput,
} from "./capacity-runway";
import { computeWindowStartMs } from "./throttle-utils";
import {
	type ExtractedValue,
	extractFiveHour,
	extractSevenDay,
	FIVE_HOUR_ELIGIBLE_PROVIDERS,
	SEVEN_DAY_ELIGIBLE_PROVIDERS,
} from "./usage-window-extract";

/**
 * Quota runway per API key.
 *
 * Per KEY rather than pool-wide, because a provider-pinned key runs out when
 * its own provider's accounts run out however healthy the rest of the pool is.
 *
 * Lives in core rather than the dashboard because the SERVER composes it now
 * (`GET /api/runway`): resolving each key's pin to its eligible accounts and
 * mapping those onto the runway model is the part a non-dashboard client would
 * otherwise have to reimplement.
 *
 * Pure QUOTA scope: `paused`, `rateLimitedUntil`, `usageThrottledUntil` and
 * `providerOverloadedUntil` are deliberately NOT read. Runway answers "when
 * does the quota run out", so an account that is merely paused or cooling still
 * counts as capacity. Surfaces built on this must say "quota", not
 * "available".
 */

/**
 * Name of the synthetic row that stands in for the whole pool when no API key
 * is active. `AuthService.isAuthenticationEnabled()` is `countActiveApiKeys() >
 * 0`, so zero active keys means authentication is OFF and every request routes
 * over the unpinned pool.
 */
export const UNAUTHENTICATED_POOL_KEY_NAME = "No API keys (unauthenticated)";

/**
 * The account fields the runway needs, and nothing else. Narrow on purpose so
 * both callers can satisfy it: the server builds these straight off
 * `getAllAccounts()` + the usage cache, and `AccountResponse` structurally
 * satisfies it as-is.
 *
 * `prediction` is OPTIONAL because `AccountResponse.prediction` is declared
 * optional; requiring it here would leave `AccountResponse` unassignable.
 */
export interface RunwayAccountSource {
	id: string;
	name: string;
	provider: string;
	usageData: FullUsageData | null;
	prediction?: AccountUsagePrediction | null;
}

/**
 * One runway row. The same declaration the `/api/runway` response serves
 * ({@link RunwayKeyEntry}), aliased rather than restated so the computed row and
 * the wire row cannot drift apart.
 */
export type KeyRunway = RunwayKeyEntry;

function windowInput(
	windowKind: "five_hour" | "seven_day",
	extracted: ExtractedValue | null,
	prediction: RunwayWindowInput["prediction"],
): RunwayWindowInput | null {
	if (extracted == null || extracted.pct == null) return null;
	return {
		windowKind,
		utilizationPct: extracted.pct,
		resetsAtMs: extracted.resetMs,
		windowStartMs:
			extracted.resetMs == null
				? null
				: computeWindowStartMs(extracted.resetMs, windowKind),
		prediction,
	};
}

/**
 * Map one account onto the runway model's account-wide windows.
 *
 * A provider in NEITHER eligibility set exposes no account-wide quota window at
 * all (local models, pay-as-you-go), which is `unmetered` — positively known to
 * be in quota, NOT unknown. A provider eligible for one window only (zai has a
 * token window but no weekly one) contributes just that window and stays
 * metered.
 */
function toRunwayAccount(account: RunwayAccountSource): RunwayAccountInput {
	const hasFiveHour = FIVE_HOUR_ELIGIBLE_PROVIDERS.has(account.provider);
	const hasSevenDay = SEVEN_DAY_ELIGIBLE_PROVIDERS.has(account.provider);
	if (!hasFiveHour && !hasSevenDay) {
		return { accountId: account.id, unmetered: true, windows: [] };
	}

	const usageData = account.usageData ?? null;
	const windows: RunwayWindowInput[] = [];
	if (hasFiveHour) {
		const window = windowInput(
			"five_hour",
			usageData ? extractFiveHour(usageData) : null,
			account.prediction?.fiveHour,
		);
		if (window) windows.push(window);
	}
	if (hasSevenDay) {
		const window = windowInput(
			"seven_day",
			usageData ? extractSevenDay(usageData) : null,
			account.prediction?.sevenDay,
		);
		if (window) windows.push(window);
	}

	return { accountId: account.id, unmetered: false, windows };
}

function runwayFor(
	pin: RoutingPin,
	accounts: RunwayAccountSource[],
	now: number,
): { eligibleAccountIds: string[]; outcome: RunwayOutcome } {
	const eligible = accounts.filter((account) =>
		isAccountAllowedByPin(pin, account),
	);
	return {
		// The IDS, not a count: a consumer that wants the count takes `.length`,
		// but nothing can recover which accounts a key reaches from a number.
		eligibleAccountIds: eligible.map((account) => account.id),
		outcome: computeCapacityRunway(eligible.map(toRunwayAccount), now),
	};
}

/**
 * One runway row per API key. Inactive keys are listed (they still describe a
 * configured route) but are excluded from {@link worstKeyRunway}.
 *
 * With no active key at all, authentication is disabled and every request
 * routes over the unpinned pool, so exactly one synthetic row is emitted for
 * that pool and no per-key rows: a disabled key describes nothing that can
 * happen.
 */
export function computeApiKeyRunways(
	keys: ApiKeyResponse[],
	accounts: RunwayAccountSource[],
	now: number,
): KeyRunway[] {
	const unpinned: RoutingPin = { accountId: null, providers: null };

	if (!keys.some((key) => key.isActive)) {
		return [
			{
				keyId: null,
				keyName: UNAUTHENTICATED_POOL_KEY_NAME,
				isActive: true,
				pin: unpinned,
				...runwayFor(unpinned, accounts, now),
			},
		];
	}

	return keys.map((key) => {
		const pin: RoutingPin = {
			accountId: key.pinnedAccountId,
			providers: key.pinnedProviders,
		};
		return {
			keyId: key.id,
			keyName: key.name,
			isActive: key.isActive,
			pin,
			...runwayFor(pin, accounts, now),
		};
	});
}

/**
 * Severity order for the headline, worst first:
 *
 *  - `no-accounts`    — definite immediate unavailability: nothing to route to.
 *  - `out-now`        — definite, but the quota comes back.
 *  - `unknown`        — poisons the headline. It could be worse than any finite
 *                       value, so the headline must not claim better; the
 *                       per-key rows still show their own definite figures.
 *  - `runway`         — finite, shortest first.
 *  - `beyond-horizon` — no run-out modelled.
 */
const OUTCOME_SEVERITY: Record<RunwayOutcome["kind"], number> = {
	"no-accounts": 0,
	"out-now": 1,
	unknown: 2,
	runway: 3,
	"beyond-horizon": 4,
};

/** The worst runway across ACTIVE keys, or null when none is active. */
export function worstKeyRunway(runways: KeyRunway[]): KeyRunway | null {
	let worst: KeyRunway | null = null;
	for (const candidate of runways) {
		if (!candidate.isActive) continue;
		if (worst === null) {
			worst = candidate;
			continue;
		}
		const candidateRank = OUTCOME_SEVERITY[candidate.outcome.kind];
		const worstRank = OUTCOME_SEVERITY[worst.outcome.kind];
		if (candidateRank < worstRank) {
			worst = candidate;
			continue;
		}
		if (
			candidateRank === worstRank &&
			candidate.outcome.kind === "runway" &&
			worst.outcome.kind === "runway" &&
			candidate.outcome.durationMs < worst.outcome.durationMs
		) {
			worst = candidate;
		}
	}
	return worst;
}
