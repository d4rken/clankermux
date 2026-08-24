import type {
	AccountBurnAnchors,
	AccountUsagePrediction,
	ApiKeyResponse,
	FullUsageData,
	RunwayKeyEntry,
	RunwayOutcome,
	UsageBurnAnchor,
} from "@clankermux/types";
import { isAccountAllowedByPin, type RoutingPin } from "./api-key-pin";
import {
	computeCapacityRunway,
	type LifetimeConfidence,
	type RunwayAccountInput,
	type RunwayResetCreditBank,
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
	/**
	 * Pre-extracted window readings, used ONLY when `usageData` is null.
	 *
	 * The server's persisted `usage_snapshots` history stores the four scalars
	 * these windows are made of, not a provider usage payload, so a caller
	 * restoring an account from a snapshot has nothing to put in `usageData`
	 * short of fabricating a payload shape. Feeding the already-extracted
	 * readings instead keeps the extractors the single place that knows how each
	 * provider's payload is laid out.
	 *
	 * Optional, so `AccountResponse` still structurally satisfies this interface.
	 */
	windowObservations?: RunwayWindowObservations | null;
	/**
	 * When the reading behind `usageData` / `windowObservations` was OBSERVED.
	 *
	 * Required for the weekly window's full-confidence projection, which anchors
	 * its ETA to the reading rather than to `now` so it cannot drift between
	 * polls (see `WindowExhaustionInput.observedAtMs`). A caller that
	 * cannot say honestly passes null, and the weekly window falls back to the
	 * amber-capped now-anchored estimate — never a substituted `Date.now()`.
	 */
	usageObservedAtMs?: number | null;
	/**
	 * Last observed mid-window downward revision per window (gift reset /
	 * applied reset credit), keyed to the SAME resolved reading as
	 * `usageObservedAtMs`. The estimator validates each anchor against the
	 * projected window's reset identity, so a stale entry degrades to the
	 * structural estimate rather than distorting it.
	 */
	burnAnchors?: AccountBurnAnchors | null;
	/**
	 * Modeled reset-credit bank for the scan (see
	 * {@link RunwayResetCreditBank}). Assembled by the caller from the credit
	 * cache and the account's auto-apply opt-ins; absent → no credits modeled.
	 */
	codexResetCredits?: RunwayResetCreditBank | null;
}

/**
 * The two account-wide quota windows, already extracted from whatever source
 * produced them. `null` for a window the source could not read; `{ pct: null }`
 * for one it read as carrying no percentage — the same distinction the
 * extractors draw.
 */
export interface RunwayWindowObservations {
	fiveHour: ExtractedValue | null;
	sevenDay: ExtractedValue | null;
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
	observedAtMs: number | null,
	anchor: UsageBurnAnchor | null,
	lifetimeConfidence?: LifetimeConfidence,
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
		lifetimeConfidence,
		// Carried on every window, not just the one that reads it today: both
		// windows come from the SAME resolved reading, so its observation time
		// describes both, and stating it only where the current policy happens to
		// consume it would make the field look like a property of the weekly window.
		observedAtMs,
		anchor,
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

	// A live payload always wins; the pre-extracted readings are a FALLBACK for
	// the caller that has no payload at all, never a merge. Mixing the two would
	// let one window come from a live read and the other from an older one, and
	// the runway would then be projected from two different instants.
	const usageData = account.usageData ?? null;
	const observations = usageData ? null : (account.windowObservations ?? null);
	// One instant for both windows, because both are read out of one resolution.
	const observedAtMs = account.usageObservedAtMs ?? null;
	const windows: RunwayWindowInput[] = [];
	if (hasFiveHour) {
		const window = windowInput(
			"five_hour",
			usageData ? extractFiveHour(usageData) : (observations?.fiveHour ?? null),
			account.prediction?.fiveHour,
			observedAtMs,
			account.burnAnchors?.fiveHour ?? null,
		);
		if (window) windows.push(window);
	}
	if (hasSevenDay) {
		const window = windowInput(
			"seven_day",
			usageData ? extractSevenDay(usageData) : (observations?.sevenDay ?? null),
			account.prediction?.sevenDay,
			observedAtMs,
			account.burnAnchors?.sevenDay ?? null,
			// The weekly display estimator IS the lifetime average (it beat the
			// regression on held-out data), so its projection is a measured best
			// estimate rather than a fallback nobody checked. It reaches red, so it
			// is anchored to `observedAtMs` above; with no observation time it
			// degrades back to the amber-capped now-anchored estimate.
			"full",
		);
		if (window) windows.push(window);
	}

	return {
		accountId: account.id,
		unmetered: false,
		windows,
		codexResetCredits: account.codexResetCredits ?? null,
	};
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
 * The outcome as it stands AT `now`.
 *
 * A `runway` whose `exhaustsAtMs` has passed with no newer data is not a
 * runway of zero, and it is not still counting down: the metric is a
 * projection throughout, and its own answer once the deadline passes is that
 * there is no quota. So it reads exactly as `out-now`, carrying the same
 * causes and unprojectable accounts.
 *
 * Outcome logic rather than presentation, so it lives here: the ranking in
 * {@link worstKeyRunway} and every surface that renders a row have to agree on
 * what a served row MEANS, or a headline can contradict the rows beneath it.
 */
export function effectiveRunwayOutcome(
	outcome: RunwayOutcome,
	now: number,
): RunwayOutcome {
	if (outcome.kind !== "runway") return outcome;
	if (outcome.exhaustsAtMs - now > 0) return outcome;
	return {
		kind: "out-now",
		causes: outcome.causes,
		unprojectableAccountIds: outcome.unprojectableAccountIds,
	};
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

/**
 * The worst runway across ACTIVE keys, or null when none is active.
 *
 * Ranks the outcomes AT `now` rather than as served. The rows come from a poll,
 * so a `runway` whose deadline has since passed is already out of quota; ranking
 * the raw outcome would leave the headline reporting `unknown` while the row
 * beneath it reads "Out of quota".
 *
 * The shortest-first tiebreak compares REMAINING time for the same reason: the
 * ordering must not depend on when the response was generated, which is what
 * the served `durationMs` encodes.
 */
export function worstKeyRunway(
	runways: KeyRunway[],
	now: number,
): KeyRunway | null {
	let worst: KeyRunway | null = null;
	let worstOutcome: RunwayOutcome | null = null;
	for (const candidate of runways) {
		if (!candidate.isActive) continue;
		const candidateOutcome = effectiveRunwayOutcome(candidate.outcome, now);
		if (worst === null || worstOutcome === null) {
			worst = candidate;
			worstOutcome = candidateOutcome;
			continue;
		}
		const candidateRank = OUTCOME_SEVERITY[candidateOutcome.kind];
		const worstRank = OUTCOME_SEVERITY[worstOutcome.kind];
		if (candidateRank < worstRank) {
			worst = candidate;
			worstOutcome = candidateOutcome;
			continue;
		}
		if (
			candidateRank === worstRank &&
			candidateOutcome.kind === "runway" &&
			worstOutcome.kind === "runway"
		) {
			const candidateRemaining = candidateOutcome.exhaustsAtMs - now;
			const worstRemaining = worstOutcome.exhaustsAtMs - now;
			if (candidateRemaining < worstRemaining) {
				worst = candidate;
				worstOutcome = candidateOutcome;
			}
		}
	}
	return worst;
}

/**
 * What a HEADLINE may say about a set of runway rows.
 *
 * `worstKeyRunway` answers "what is the worst outcome", and `unknown` outranks
 * every finite one because it could be worse than any of them. That is the
 * right answer for ranking, and the wrong thing to put in a single-figure
 * summary: one key whose accounts have no readable window takes the whole
 * headline to "unstateable", even when every other key has perfectly good
 * evidence.
 *
 * So a headline ranks only the rows it can STATE, and reports separately how
 * many it could not. The two numbers have to travel together, because the
 * honesty of the figure depends on the count beside it:
 *
 *  - WITHIN a key, dropping an unreadable account can only SHORTEN the runway
 *    (fewer accounts to survive on), so the served figure is a lower bound.
 *  - ACROSS keys, dropping an unstateable key can only LENGTHEN the headline
 *    (the hidden key might be the worst one), so the figure is an UPPER bound.
 *
 * A surface that renders `worst` without also rendering `unobservedKeyCount` is
 * therefore claiming more than it knows. `null` for `worst` when nothing can be
 * stated keeps the floor: with no evidence anywhere, the headline still refuses
 * to name a figure.
 */
export interface RunwayHeadline {
	/** Worst STATEABLE outcome among active keys, or null when none is. */
	worst: KeyRunway | null;
	/** Active keys the headline covers. */
	statedKeyCount: number;
	/** Active keys whose outcome at `now` is `unknown`. */
	unobservedKeyCount: number;
	/** Every active key, i.e. `statedKeyCount + unobservedKeyCount`. */
	activeKeyCount: number;
}

/**
 * The headline reading of a set of runway rows.
 *
 * `no-accounts` is deliberately NOT excluded: "this key can reach nothing" is a
 * definite, stateable finding and the most severe one there is. Only `unknown`
 * — evidence missing — is set aside.
 *
 * Ranking is by {@link worstKeyRunway} over the stateable subset, so the
 * headline and the per-key breakdown can never disagree about which row is
 * worse.
 */
export function summarizeKeyRunways(
	runways: KeyRunway[],
	now: number,
): RunwayHeadline {
	const active = runways.filter((runway) => runway.isActive);
	const stateable = active.filter(
		(runway) => effectiveRunwayOutcome(runway.outcome, now).kind !== "unknown",
	);
	return {
		worst: worstKeyRunway(stateable, now),
		statedKeyCount: stateable.length,
		unobservedKeyCount: active.length - stateable.length,
		activeKeyCount: active.length,
	};
}
