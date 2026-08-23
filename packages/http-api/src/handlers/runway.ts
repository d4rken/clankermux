import {
	computeApiKeyRunways,
	type ExtractedValue,
	extractFiveHour,
	extractSevenDay,
	FIVE_HOUR_ELIGIBLE_PROVIDERS,
	RUNWAY_HORIZON_MS,
	type RunwayAccountSource,
	type RunwayWindowObservations,
	SEVEN_DAY_ELIGIBLE_PROVIDERS,
	worstKeyRunway,
} from "@clankermux/core";
import type { DatabaseOperations } from "@clankermux/database";
import { jsonResponse } from "@clankermux/http-common";
import {
	type AnyUsageData,
	UI_STALE_HORIZON_MS,
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
import {
	loadRecentSnapshotObservations,
	projectableWindows,
	snapshotWithin,
} from "../services/resolve-snapshot-usage";

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
 * The two cannot disagree about WHICH READING an account has, because both are
 * chosen from one list of timestamped candidates (`UsageCandidate`) — they
 * differ only in how fresh a reading has to be for their purpose. No prediction
 * is ever emitted for a reading the routing bar rejects, so a served
 * utilization and a served prediction always come from the same observation.
 *
 * SNAPSHOT FALLBACK — the usage cache is in-memory, so a restart empties it for
 * EVERY provider, not just Codex. Until the poller has been round again, a key
 * whose accounts are all cold has no readable window and its outcome is
 * `unknown`. The persisted `usage_snapshots` history therefore joins the
 * candidate list, bounded by the display horizon, and each view picks the
 * FRESHEST candidate it will accept. Ranking by observation time rather than by
 * source is load-bearing: source precedence is how a three-day-old persisted
 * Codex column came to outrank a two-minute snapshot sitting unread beside it.
 * Predictions are deliberately NOT restored from snapshots — see
 * `resolve-snapshot-usage.ts`, which also documents why `sampled_at` is an upper
 * bound on recency rather than an exact observation instant, and that the
 * sampler covers Anthropic and Codex only.
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
	extracted: ExtractedValue | null,
	prediction: UsagePrediction | undefined,
): RunwayWindowSummary {
	return {
		kind,
		utilizationPct: extracted?.pct ?? null,
		resetsAtMs: extracted?.resetMs ?? null,
		prediction: servablePrediction(prediction),
	};
}

/**
 * Pull both account-wide windows out of a provider usage payload.
 *
 * Extracting ONCE per account, up front, is what lets the scan and the evidence
 * block below read the same resolution — including when that resolution came
 * from a persisted snapshot, which is already a pair of extracted readings and
 * never a payload.
 */
function observationsFrom(
	usageData: FullUsageData | null,
): RunwayWindowObservations | null {
	if (usageData == null) return null;
	return {
		fiveHour: extractFiveHour(usageData),
		sevenDay: extractSevenDay(usageData),
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
	observations: RunwayWindowObservations | null,
	sampledAtMs: number | null,
	prediction: AccountUsagePrediction | undefined,
): RunwayAccountSummary {
	const provider = account.provider || "anthropic";
	const hasFiveHour = FIVE_HOUR_ELIGIBLE_PROVIDERS.has(provider);
	const hasSevenDay = SEVEN_DAY_ELIGIBLE_PROVIDERS.has(provider);

	const windows: RunwayWindowSummary[] = [];
	if (hasFiveHour) {
		windows.push(
			windowSummary(
				"five_hour",
				observations?.fiveHour ?? null,
				prediction?.fiveHour,
			),
		);
	}
	if (hasSevenDay) {
		windows.push(
			windowSummary(
				"seven_day",
				observations?.sevenDay ?? null,
				prediction?.sevenDay,
			),
		);
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

/**
 * One reading of an account's windows, with when it was observed.
 *
 * `observedAtMs` is `null` when the source cannot honestly say — today only the
 * Codex stored-payload reconstruction, which has no trustworthy timestamp. That
 * is a real answer, not a missing field, and the selection below treats it as
 * one: such a reading may be REPORTED but never DERIVED from.
 */
interface UsageCandidate {
	windows: RunwayWindowObservations;
	observedAtMs: number | null;
	/**
	 * Where it came from. Only the scan's fallback tier cares, and it cares for
	 * one reason: `codex-persisted` is the single source this endpoint has
	 * decided may project from OUTSIDE the routing bar (see the CODEX paragraph
	 * of the header comment). An aged `cache` reading may not, and neither may an
	 * aged `snapshot` — for those the honest answer is that the account is
	 * unprojectable, which is the behaviour this endpoint already ships.
	 */
	source: "cache" | "codex-persisted" | "snapshot";
}

/**
 * The freshest candidate, optionally restricted to those younger than
 * `maxAgeMs`. Null when there is nothing to choose from.
 *
 * Ranks by OBSERVATION TIME rather than by source. That is the whole point: the
 * sources have no natural precedence over one another, and ordering them by
 * source is how a three-day-old persisted Codex column came to beat a
 * two-minute snapshot sitting unread beside it.
 *
 * A candidate that cannot say when it was observed sorts last and wins only when
 * nothing else is available — a reading with no time is still a reading, but it
 * can never be shown to be the more recent one. A future-stamped reading is
 * skipped for the reason `snapshotWithin` skips one: clock skew must not let an
 * obsolete reading pass as current.
 */
function freshestCandidate(
	candidates: UsageCandidate[],
	now: number,
	maxAgeMs = Number.POSITIVE_INFINITY,
): UsageCandidate | null {
	let best: UsageCandidate | null = null;
	let untimed: UsageCandidate | null = null;
	for (const candidate of candidates) {
		if (candidate.observedAtMs == null) {
			untimed ??= candidate;
			continue;
		}
		const ageMs = now - candidate.observedAtMs;
		if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > maxAgeMs) continue;
		if (best == null || candidate.observedAtMs > (best.observedAtMs ?? 0)) {
			best = candidate;
		}
	}
	return best ?? untimed;
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

		// Persisted snapshot history, loaded once at the WIDEST horizon either
		// consumer needs and narrowed per use below. The sampler writes these
		// every ~2 minutes for every metered account and only when the reading
		// behind them was fresh, so they are what a restart-emptied cache falls
		// back to. See `resolve-snapshot-usage.ts` for why this does not loosen
		// the freshness contract.
		const snapshotByAccount = await loadRecentSnapshotObservations(
			dbOps,
			accounts.map((a) => a.id),
			now,
			UI_STALE_HORIZON_MS,
		);

		// Every account's readings as TIMESTAMPED CANDIDATES, so the scan and the
		// evidence block pick from one list under their own age bars instead of
		// each hard-coding a source order. That is what keeps them from
		// disagreeing about which reading an account HAS while differing only, as
		// documented, on how fresh a reading has to be for each purpose.
		//
		// The live candidate is the routing-fresh cache entry for most providers
		// and the resolved cache/column/payload reading for Codex. Only Codex can
		// carry an unknown or arbitrarily old observation time, because only its
		// resolution reaches past the cache.
		const candidatesByAccount = new Map<string, UsageCandidate[]>(
			accounts.map((a) => {
				const resolvedCodex =
					a.provider === "codex"
						? (codexUsageByAccount.get(a.id) ?? null)
						: null;
				const entry = entryByAccount.get(a.id) ?? null;
				// The DISPLAY reading, deliberately — `peekWithAge` already stops
				// serving at 30 minutes, so this is pre-filtered, and the scan's own
				// bar below decides separately whether it is fresh enough to project
				// from. Building this from the routing-fresh map instead would delete
				// the 10-to-30-minute band from the evidence block entirely.
				const live = observationsFrom(
					resolvedCodex
						? resolvedCodex.data
						: ((entry?.data ?? null) as FullUsageData | null),
				);
				// Bounded here rather than trusting the query's `sinceMs`: this
				// reader states its own admissibility, and a row older than the
				// display horizon is not evidence for either view.
				const snapshot = snapshotWithin(
					snapshotByAccount,
					a.id,
					now,
					UI_STALE_HORIZON_MS,
				);
				const candidates: UsageCandidate[] = [];
				if (live) {
					candidates.push({
						windows: live,
						observedAtMs: resolvedCodex
							? resolvedCodex.sampledAtMs
							: (entry?.sampledAtMs ?? null),
						// Every Codex reading is labelled `codex-persisted`, including
						// one that actually came from the cache. That is exact rather
						// than sloppy: a cache-sourced reading inside the bar wins on its
						// own merits and never reaches the fallback tier, and one outside
						// the bar is precisely what the resolved Codex path has always
						// projected from here.
						source: resolvedCodex ? "codex-persisted" : "cache",
					});
				}
				if (snapshot) {
					candidates.push({
						windows: snapshot,
						observedAtMs: snapshot.sampledAtMs,
						source: "snapshot",
					});
				}
				return [a.id, candidates];
			}),
		);

		// The windows the SCAN projects from, in two tiers:
		//
		//  1. the freshest candidate inside the ROUTING bar, whatever its source;
		//  2. failing that, the persisted CODEX reading and nothing else.
		//
		// Tier 2 is not a general licence for stale data — it is the single
		// exception the CODEX paragraph of the header comment already argued for
		// and this endpoint already ships. An aged cache entry still leaves its
		// account unprojectable, which is the documented behaviour and what keeps
		// "no prediction is emitted for a reading the routing bar rejects" true.
		//
		// What CHANGED here is only tier 1's ordering: candidates rank by
		// observation time rather than by source, so a two-minute snapshot can no
		// longer lose to a three-day-old persisted column merely because the
		// column was consulted first.
		//
		// Never a merge across candidates: a runway projected from a live 5-hour
		// reading and an older weekly one would be anchored to two different
		// instants.
		const scanObservationsByAccount = new Map<
			string,
			RunwayWindowObservations | null
		>(
			accounts.map((a) => {
				const candidates = candidatesByAccount.get(a.id) ?? [];
				const winner =
					freshestCandidate(candidates, now, USAGE_CACHE_TTL_MS) ??
					freshestCandidate(
						candidates.filter((c) => c.source === "codex-persisted"),
						now,
					);
				if (!winner) return [a.id, null];
				return [
					a.id,
					// A snapshot's windows may have rolled over since the row was
					// written; a live reading's cannot have.
					winner.source === "snapshot"
						? projectableWindows(
								{ ...winner.windows, sampledAtMs: winner.observedAtMs ?? now },
								now,
							)
						: winner.windows,
				];
			}),
		);

		const sources: RunwayAccountSource[] = accounts.map((account) => ({
			id: account.id,
			name: account.name,
			provider: account.provider || "anthropic",
			// Already extracted above, so the scan and the evidence block below
			// cannot end up reading two different resolutions of the same account.
			usageData: null,
			windowObservations: scanObservationsByAccount.get(account.id) ?? null,
			prediction: predictionByAccount.get(account.id) ?? null,
		}));

		const runways = computeApiKeyRunways(keys, sources, now);
		const worst = worstKeyRunway(runways, now);

		const response: RunwayResponse = {
			generatedAt: now,
			horizonMs: RUNWAY_HORIZON_MS,
			worstKeyId: worst?.keyId ?? null,
			keys: runways,
			// The DISPLAY view of the SAME candidates the scan chose from: freshest
			// first, untimed last, and NO further age bar. Each candidate is already
			// display-filtered where it was produced — `peekWithAge` yields nothing
			// past 30 minutes, and the snapshot load is bounded by the same horizon
			// — so a bar here would only ever cut the one candidate that is
			// deliberately unbounded, the persisted Codex column, and this endpoint
			// would then show LESS than `/api/accounts` for exactly the accounts the
			// column exists to cover.
			//
			// That is the whole scan/display split: this block reports an
			// observation with its age, while only the scan and the predictions
			// derive a value modelling "now" and are held to the routing TTL. A
			// reading with no trustworthy observation time is reported here too,
			// with `usageAsOfMs: null` saying exactly that.
			accounts: accounts.map((account) => {
				const winner = freshestCandidate(
					candidatesByAccount.get(account.id) ?? [],
					now,
					Number.POSITIVE_INFINITY,
				);
				return accountSummary(
					account,
					winner?.windows ?? null,
					winner?.observedAtMs ?? null,
					predictionByAccount.get(account.id),
				);
			}),
		};

		return jsonResponse(response);
	};
}
