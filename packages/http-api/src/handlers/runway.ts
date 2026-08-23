import {
	computeApiKeyRunways,
	extractFiveHour,
	extractSevenDay,
	FIVE_HOUR_ELIGIBLE_PROVIDERS,
	RUNWAY_HORIZON_MS,
	type RunwayAccountSource,
	SEVEN_DAY_ELIGIBLE_PROVIDERS,
	worstKeyRunway,
} from "@clankermux/core";
import type { DatabaseOperations } from "@clankermux/database";
import { jsonResponse } from "@clankermux/http-common";
import {
	type AnyUsageData,
	USAGE_CACHE_TTL_MS,
	usageCache,
} from "@clankermux/providers";
import type {
	Account,
	AccountUsagePrediction,
	FullUsageData,
	RunwayAccountSummary,
	RunwayResponse,
	RunwayWindowKind,
	RunwayWindowSummary,
	UsagePrediction,
} from "@clankermux/types";
import { listApiKeys } from "../services/admin/api-keys";
import { buildPredictionsForAccounts } from "../services/build-account-predictions-for";

/**
 * `GET /api/runway` — the quota runway per API key, plus the account evidence it
 * was computed from.
 *
 * The math has always been shared (`@clankermux/core/capacity-runway`); what
 * lived only in the browser was the COMPOSITION — resolving each key's routing
 * pin to its eligible accounts, mapping those onto the model's windows and
 * running the scan. Serving that composition is what lets a desktop widget or
 * any other non-dashboard client read a runway without reimplementing it.
 *
 * QUOTA, not availability: pauses, rate-limit cooldowns, usage throttling and
 * the provider-overload breaker are deliberately not read. Copy built on this
 * must say "quota", never "available".
 *
 * FRESHNESS — the response deliberately reads the usage cache through BOTH of
 * its documented views, because it carries two different kinds of thing:
 *
 *  - The runway SCAN and the per-window PREDICTION take the ROUTING-fresh view
 *    (10 min). Both DERIVE a value modelling "now", and a derived value must
 *    not be built on a reading that stopped being worth routing on. This is a
 *    deliberate semantic change from what the browser used to do — it computed
 *    the runway from `AccountResponse.usageData`, the display view. When the
 *    difference bites (usage-fetch failure backoff, long poll intervals, Codex
 *    restart recovery), an outcome moves from `beyond-horizon` to `unknown`, or
 *    to a shorter lower bound driven by the accounts still fresh. That is the
 *    honest answer, not a regression.
 *  - The reported account EVIDENCE (`accounts[].windows[].utilizationPct` /
 *    `resetsAtMs`, stamped by `usageAsOfMs`) takes the DISPLAY view
 *    (`peekWithAge`, 30 min) with its age. An observation is not a derived
 *    value: a reading 12 minutes old is live data with an age, which is exactly
 *    what `/api/accounts` renders "as of HH:MM", and a widget reading this
 *    endpoint must not be shown less than the dashboard beside it. It is also
 *    what makes `usageAsOfMs` mean anything — sourced from routing-fresh data it
 *    could never exceed 10 minutes.
 *
 * The two cannot disagree. Inside 10 minutes the display entry and the
 * routing-fresh entry are the same object; past it the routing-fresh side is
 * null, so no prediction is emitted and the scan reports the account as
 * unprojectable. There is no case where a served utilization and a served
 * prediction come from different readings.
 *
 * Runs INLINE rather than through a dashboard read worker: the worker exists
 * for multi-second `requests` scans and cannot see `usageCache`, which is
 * main-thread-only. There is deliberately no response TTL cache.
 *
 * Authentication is out of scope — `/api/*` is unauthenticated for all methods
 * by design, and this exposes nothing `/api/accounts` does not already expose.
 *
 * `usageCache` is imported directly rather than threaded through `APIContext`:
 * it is a module singleton, and `accounts.ts` / `health.ts` reach it the same
 * way.
 */

/**
 * A prediction is only served when the estimator actually established a trend.
 * `computeUsagePrediction` returns `slopePerHour: 0` for `insufficient_data`;
 * shipping that verbatim would hand an external client a zero slope where no
 * slope was measured, which is exactly the null-vs-zero confusion the rest of
 * this response avoids.
 */
function servablePrediction(
	prediction: UsagePrediction | undefined,
): UsagePrediction | null {
	if (!prediction) return null;
	return prediction.state === "insufficient_data" ? null : prediction;
}

function windowSummary(
	kind: RunwayWindowKind,
	usageData: FullUsageData | null,
	prediction: UsagePrediction | undefined,
): RunwayWindowSummary {
	const extracted =
		usageData == null
			? null
			: kind === "five_hour"
				? extractFiveHour(usageData)
				: extractSevenDay(usageData);
	return {
		kind,
		utilizationPct: extracted?.pct ?? null,
		resetsAtMs: extracted?.resetMs ?? null,
		prediction: servablePrediction(prediction),
	};
}

/**
 * One account's evidence block.
 *
 * EVERY window the provider supports is emitted, with nullable values, so an
 * absent window means "this provider has no such window" and can never be
 * mistaken for "we could not read it". A provider with no account-wide window
 * at all (ollama, pay-as-you-go) reports `metered: false` and no windows.
 */
function accountSummary(
	account: Account,
	usageData: FullUsageData | null,
	sampledAtMs: number | null,
	prediction: AccountUsagePrediction | undefined,
): RunwayAccountSummary {
	const provider = account.provider || "anthropic";
	const hasFiveHour = FIVE_HOUR_ELIGIBLE_PROVIDERS.has(provider);
	const hasSevenDay = SEVEN_DAY_ELIGIBLE_PROVIDERS.has(provider);

	const windows: RunwayWindowSummary[] = [];
	if (hasFiveHour) {
		windows.push(windowSummary("five_hour", usageData, prediction?.fiveHour));
	}
	if (hasSevenDay) {
		windows.push(windowSummary("seven_day", usageData, prediction?.sevenDay));
	}

	// An "as of" stamp is only honest next to a value it describes. With no
	// window carrying a utilization there is nothing it could be as of, and
	// reporting the sample time anyway would dress an absent reading up as a
	// resolved one.
	const anyUtilization = windows.some((w) => w.utilizationPct != null);

	return {
		id: account.id,
		name: account.name,
		provider,
		metered: hasFiveHour || hasSevenDay,
		usageAsOfMs: anyUtilization ? sampledAtMs : null,
		windows,
	};
}

export function createRunwayHandler(
	dbOps: DatabaseOperations,
): () => Promise<Response> {
	return async (): Promise<Response> => {
		const now = Date.now();
		const [accounts, keys] = await Promise.all([
			dbOps.getAllAccounts(),
			listApiKeys(dbOps),
		]);

		// One non-evicting cache read per account, split into the two documented
		// views exactly as /api/accounts splits them:
		//  - routing-fresh (10 min) feeds BOTH the prediction inputs AND the
		//    utilization the runway scan reads, because the runway derives a value
		//    modelling "now".
		//  - the display reading (up to 30 min) and its sample time are what the
		//    `accounts[]` evidence block REPORTS. Neither is ever substituted into
		//    the scan or the projection.
		const entryByAccount = new Map(
			accounts.map((a) => [a.id, usageCache.peekWithAge(a.id)] as const),
		);
		const routingFreshUsageByAccount = new Map<string, AnyUsageData | null>(
			accounts.map((a) => {
				const entry = entryByAccount.get(a.id);
				return [
					a.id,
					entry && entry.ageMs <= USAGE_CACHE_TTL_MS ? entry.data : null,
				] as const;
			}),
		);

		const predictionByAccount = await buildPredictionsForAccounts(
			dbOps,
			accounts.map((a) => ({ id: a.id, provider: a.provider ?? null })),
			routingFreshUsageByAccount,
			now,
		);

		const usageDataByAccount = new Map<string, FullUsageData | null>(
			accounts.map((a) => [
				a.id,
				(routingFreshUsageByAccount.get(a.id) ?? null) as FullUsageData | null,
			]),
		);

		const sources: RunwayAccountSource[] = accounts.map((account) => ({
			id: account.id,
			name: account.name,
			provider: account.provider || "anthropic",
			usageData: usageDataByAccount.get(account.id) ?? null,
			prediction: predictionByAccount.get(account.id) ?? null,
		}));

		const runways = computeApiKeyRunways(keys, sources, now);
		const worst = worstKeyRunway(runways, now);

		const response: RunwayResponse = {
			generatedAt: now,
			horizonMs: RUNWAY_HORIZON_MS,
			worstKeyId: worst?.keyId ?? null,
			keys: runways,
			// The DISPLAY reading, not the routing-fresh one: this block reports an
			// observation with its age, and `peekWithAge` exists to serve exactly
			// that. Only `sources` and the predictions above are held to the routing
			// TTL, because only they derive a value modelling "now".
			accounts: accounts.map((account) =>
				accountSummary(
					account,
					(entryByAccount.get(account.id)?.data ??
						null) as FullUsageData | null,
					entryByAccount.get(account.id)?.sampledAtMs ?? null,
					predictionByAccount.get(account.id),
				),
			),
		};

		return jsonResponse(response);
	};
}
