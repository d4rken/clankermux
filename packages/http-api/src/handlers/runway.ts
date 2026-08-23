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
import {
	getCachedOrPersistedCodexUsage,
	loadPersistedCodexUsageColumns,
} from "../services/resolve-codex-usage";

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
 *    (10 min) — the scan for every provider except Codex, which resolves
 *    through the persisted snapshot described below. Both DERIVE a value
 *    modelling "now", and a derived value must not be built on a reading that
 *    stopped being worth routing on. This is a
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
 * CODEX — the usage cache is in-memory, so after any restart a Codex account
 * has nothing in it until Codex traffic repopulates it. `/api/accounts` has
 * always resolved through `getCachedOrPersistedCodexUsage` (cache, then the
 * persisted `accounts.codex_usage_json` column, then the stored-payload scan),
 * and the browser used to compute the runway from exactly that resolved
 * reading. Serving the composition here without it turned every Codex account
 * blank after a restart, which then poisoned every Codex-pinned key to
 * `unknown`. The resolved reading therefore feeds BOTH the evidence block and
 * the runway scan.
 *
 * That resolver documents a `"column"` reading as DISPLAY-ONLY, and this is not
 * a violation of it: the constraint exists because only the `"cache"` and
 * `"payload"` sources are reflected in the live usage cache, i.e. it protects
 * anything describing what the PROXY can see and do (routing, the throttle
 * claim). The runway is a display projection and never feeds routing, so
 * display-only data is a valid input to it. Do not "fix" this back.
 *
 * It deliberately does NOT feed the PREDICTIONS, which stay routing-fresh-only:
 * `buildPredictionsForAccounts` appends the live reading as a data point stamped
 * `t: now`, so a column reading observed hours ago would enter the regression
 * claiming to be current. A restored Codex account therefore reports its
 * utilization with an honest `usageAsOfMs` and `prediction: null`.
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

/**
 * A Codex account's usage after the cache/column/payload resolution, with the
 * only stamp that honestly describes it (null when the winning source cannot
 * say when it was observed).
 */
interface ResolvedCodexUsage {
	data: FullUsageData | null;
	sampledAtMs: number | null;
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
		//  - routing-fresh (10 min) feeds the prediction inputs and, for every
		//    non-Codex provider, the utilization the runway scan reads.
		//  - the display reading (up to 30 min) and its sample time are what the
		//    `accounts[]` evidence block REPORTS, and are the cache candidate the
		//    Codex resolution below starts from. Neither is ever substituted into
		//    the projection.
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

		// Routing-fresh ONLY, deliberately: the prediction appends its input as a
		// data point stamped `t: now`, so the persisted Codex resolution below must
		// not reach it. A Codex account restored from the column reports its
		// utilization with `prediction: null`.
		const predictionByAccount = await buildPredictionsForAccounts(
			dbOps,
			accounts.map((a) => ({ id: a.id, provider: a.provider ?? null })),
			routingFreshUsageByAccount,
			now,
		);

		// Codex only: resolve through the cache, then `accounts.codex_usage_json`,
		// then the stored-payload scan — the same resolution `/api/accounts` runs,
		// so a restart cannot blank one endpoint while the other still reads. Fed
		// the DISPLAY entry as its cache candidate for the same reason
		// `/api/accounts` does: it is what an observation-with-an-age means, and
		// passing the routing-fresh view instead would let an hours-old column beat
		// a cache reading that is merely 12 minutes old.
		const codexAccounts = accounts.filter((a) => a.provider === "codex");
		const codexUsageByAccount = new Map<string, ResolvedCodexUsage>();
		if (codexAccounts.length > 0) {
			// `getAllAccounts()` does not select the persisted columns (an unbounded
			// TEXT blob on a hot query), so load them here for codex ids only.
			const db = dbOps.getAdapter();
			const columnsByAccount = await loadPersistedCodexUsageColumns(
				db,
				codexAccounts.map((a) => a.id),
			);
			await Promise.all(
				codexAccounts.map(async (account) => {
					const entry = entryByAccount.get(account.id) ?? null;
					const columns = columnsByAccount.get(account.id) ?? null;
					const resolved = await getCachedOrPersistedCodexUsage(
						db,
						account.id,
						account.name,
						(entry?.data ?? null) as FullUsageData | null,
						columns?.persistedJson ?? null,
						columns?.persistedObservedAtMs ?? null,
						account.last_used != null ? Number(account.last_used) : null,
					);
					codexUsageByAccount.set(account.id, {
						data: resolved.data,
						// Only two sources can honestly stamp a reading: the live cache
						// entry's own write time, and the column's recorded observation
						// time. A payload-reconstructed reading gets null rather than a
						// borrowed timestamp — the same rule `/api/accounts` applies.
						sampledAtMs:
							resolved.source === "cache"
								? (entry?.sampledAtMs ?? null)
								: resolved.source === "column"
									? resolved.observedAtMs
									: null,
					});
				}),
			);
		}

		const usageDataByAccount = new Map<string, FullUsageData | null>(
			accounts.map((a) => [
				a.id,
				a.provider === "codex"
					? (codexUsageByAccount.get(a.id)?.data ?? null)
					: ((routingFreshUsageByAccount.get(a.id) ??
							null) as FullUsageData | null),
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
			// that. Only the predictions above are held to the routing TTL, because
			// only they derive a value modelling "now". For Codex the display
			// reading is the resolved one (cache / column / payload), which is also
			// what `sources` above scans.
			accounts: accounts.map((account) => {
				const resolvedCodex =
					account.provider === "codex"
						? (codexUsageByAccount.get(account.id) ?? null)
						: null;
				return accountSummary(
					account,
					resolvedCodex
						? resolvedCodex.data
						: ((entryByAccount.get(account.id)?.data ??
								null) as FullUsageData | null),
					resolvedCodex
						? resolvedCodex.sampledAtMs
						: (entryByAccount.get(account.id)?.sampledAtMs ?? null),
					predictionByAccount.get(account.id),
				);
			}),
		};

		return jsonResponse(response);
	};
}
