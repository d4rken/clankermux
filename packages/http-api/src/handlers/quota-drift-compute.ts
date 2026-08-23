/**
 * Quota-drift precompute — assembling the estimator's inputs from the database.
 *
 * This module is the ONLY place that reads SQLite for the quota-drift analysis,
 * and it deliberately does no statistics of its own: the segment builder, the
 * fit, the identifiability gate and the changepoint scan all live in
 * `@clankermux/core`'s quota-drift module, which is pure and exhaustively tested
 * against synthetic data with known ground truth. A second implementation of any
 * of that here would leave the tested one non-authoritative and drift on reset,
 * gap, null and bucket-edge behaviour — all silent failures.
 *
 * ## Why the segment↔request join is done in JS
 *
 * The natural SQL shape would write segment boundaries into a TEMP TABLE and
 * join `requests` against it. That is impossible on this connection: the pass
 * runs `readonly: true` AND `PRAGMA query_only = ON` (mirroring
 * analytics-worker.ts), and query_only rejects TEMP-table writes with
 * "attempt to write a readonly database". Dropping query_only to buy the TEMP
 * table would trade a hard guarantee for a convenience.
 *
 * So the join is a STREAMING per-account merge instead, which costs nothing:
 *
 *  - one bounded query per account over `[first segment t0, last segment t1)`,
 *    served by `idx_requests_account_timestamp` (see REQUEST_SCAN_SQL);
 *  - rows are consumed through `.iterate()`, so they are never materialized —
 *    memory is O(segments), not O(requests);
 *  - both sides are timestamp-ordered, so one linear pass with a per-list
 *    cursor attributes every row with no re-scan.
 *
 * ## Attribution rule
 *
 * A request belongs to the segment whose HALF-OPEN interval `[t0, t1)` contains
 * its timestamp. Segments tile each run with no gaps, so every request inside a
 * run lands in exactly one segment; requests that fall between runs belong to no
 * segment and are correctly dropped (their Δpct was never observed either).
 *
 * ## Which clock
 *
 * Segment boundaries use `observed_at` when the row has it and `sampled_at`
 * otherwise. `sampled_at` is the sampler tick's own clock, which accepts any
 * cache reading younger than the freshness bound, so it can trail the actual
 * observation by minutes — and the request clock is not shifted by the same
 * amount. Samples are re-sorted on that effective clock because `observed_at`
 * is `tick - cacheAge` and a varying age can reorder two adjacent ticks; the
 * core builder documents that it requires ordered input.
 */

import type { Database } from "bun:sqlite";
import {
	buildSegments,
	DISPLAY_BOOTSTRAP_B,
	detectChanges,
	eqTokenProviderFor,
	eqTokens,
	fitRolling,
	fitWithIntervals,
	INFERENCE_BOOTSTRAP_B,
	normalizeModelKey,
	type QuotaSegment,
	type QuotaWindowKind,
	type SeriesPoint,
	type TierProvenance,
	type WindowSample,
} from "@clankermux/core";
import type {
	QuotaDriftChange,
	QuotaDriftCohort,
	QuotaDriftModel,
	QuotaDriftPoint,
	QuotaDriftResponse,
	QuotaDriftWindowResult,
} from "@clankermux/types";

/** The windows the pass fits, in display order. */
const WINDOWS: readonly QuotaWindowKind[] = ["five_hour", "seven_day"];

/**
 * The per-account request scan.
 *
 * The bounds are that account's first segment `t0` and last segment `t1`, so
 * this is a bounded index range and NOT a table scan. Verified on the live
 * database (589k requests) to plan as:
 *
 *   SEARCH requests USING INDEX idx_requests_account_timestamp
 *          (account_used=? AND timestamp>? AND timestamp<?)
 *
 * `quota-drift.test.ts` asserts that plan. A degradation to SCAN is a defect,
 * not a slowdown: the pass would go from bounded to O(table) per account.
 */
export const REQUEST_SCAN_SQL = `SELECT timestamp, model, input_tokens, output_tokens,
       cache_read_input_tokens, cache_creation_input_tokens
FROM requests
WHERE account_used = ? AND timestamp >= ? AND timestamp < ?
ORDER BY timestamp`;

/** Rows the scan yields. */
interface RequestScanRow {
	timestamp: number;
	model: string | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_input_tokens: number | null;
	cache_creation_input_tokens: number | null;
}

/** One account as the pass sees it. */
export interface ComputeAccount {
	id: string;
	provider: string;
	/** Plan tier on the accounts row TODAY — the fallback, never preferred. */
	currentPlanTier: string | null;
	/** Rate-limit tier on the accounts row TODAY — the fallback, never preferred. */
	currentRateLimitTier: string | null;
}

/** One snapshot row, both windows together. */
interface SnapshotScanRow {
	sampled_at: number;
	observed_at: number | null;
	five_hour_pct: number | null;
	five_hour_reset: number | null;
	seven_day_pct: number | null;
	seven_day_reset: number | null;
	plan_tier: string | null;
	rate_limit_tier: string | null;
}

/** The tier a cohort files an account under, plus where it came from. */
export interface ResolvedTier {
	planTier: string | null;
	rateLimitTier: string | null;
	provenance: TierProvenance;
}

export interface QuotaDriftComputeOptions {
	/** Wall clock for `computedAt`. Defaults to `Date.now()`. */
	now?: number;
	/** Bootstrap resamples for the display series. Tests shrink this. */
	displayBootstrapB?: number;
	/** Bootstrap resamples for changepoint calibration. Tests shrink this. */
	inferenceBootstrapB?: number;
}

/**
 * Run one full precompute pass against an open (read-only) connection.
 *
 * Never throws for want of data: an empty database yields `status: "ready"`
 * with no cohorts, which the panel renders as "nothing measurable yet". Only a
 * genuine SQL/IO failure propagates, and the scheduler leaves the previous row
 * in place when it does.
 */
export function computeQuotaDrift(
	db: Database,
	options: QuotaDriftComputeOptions = {},
): QuotaDriftResponse {
	const startedAt = performance.now();
	const now = options.now ?? Date.now();
	const displayB = options.displayBootstrapB ?? DISPLAY_BOOTSTRAP_B;
	const inferenceB = options.inferenceBootstrapB ?? INFERENCE_BOOTSTRAP_B;

	const out: QuotaDriftCohort[] = [];
	for (const cohort of collectCohortSegments(db)) {
		const windows: QuotaDriftWindowResult[] = [];
		for (const window of WINDOWS) {
			const segments = cohort.segmentsByWindow.get(window);
			if (!segments || segments.length === 0) continue;
			windows.push(
				fitWindow(segments, {
					cohortKey: cohort.key,
					window,
					provenance: cohort.tierProvenance,
					displayB,
					inferenceB,
				}),
			);
		}
		if (windows.length === 0) continue;
		out.push({
			key: cohort.key,
			provider: cohort.provider,
			planTier: cohort.planTier,
			rateLimitTier: cohort.rateLimitTier,
			accountIds: [...cohort.accountIds].sort(),
			tierProvenance: cohort.tierProvenance,
			windows,
		});
	}

	return {
		status: "ready",
		computedAt: now,
		computeMs: Math.round(performance.now() - startedAt),
		cohorts: out,
	};
}

/** Shared empty token map — `buildSegments` is called for boundaries only. */
const EMPTY_TOKENS: Readonly<Record<string, number>> = Object.freeze({});
const NO_TOKENS = () => EMPTY_TOKENS;

/** One cohort's fittable inputs, before any statistics are run on them. */
export interface CohortSegments {
	/** Stable key: `provider|planTier|rateLimitTier`. */
	key: string;
	provider: string;
	planTier: string | null;
	rateLimitTier: string | null;
	/** Accounts that contributed at least one segment. */
	accountIds: Set<string>;
	/** `assumed` as soon as ONE contributing account's tier was inferred. */
	tierProvenance: TierProvenance;
	/** Per-window segments, tokens already attached. */
	segmentsByWindow: Map<QuotaWindowKind, QuotaSegment[]>;
}

/**
 * Assemble every cohort's fittable segments — the whole database half of the
 * pass, and the only part of it that touches SQL.
 *
 * Exported so a test can compare the segments the fit ACTUALLY consumes against
 * `buildSegments` called directly on the same samples. That comparison is what
 * keeps this path from quietly acquiring run/bucket logic of its own; a fixture
 * that agreed only on the final numbers would not catch a boundary drift that
 * happens to move few tokens.
 */
export function collectCohortSegments(db: Database): CohortSegments[] {
	const hasTierColumns = tableHasColumn(db, "usage_snapshots", "plan_tier");
	const hasObservedAt = tableHasColumn(db, "usage_snapshots", "observed_at");
	const requestScan = db.prepare<RequestScanRow, [string, number, number]>(
		REQUEST_SCAN_SQL,
	);
	const cohorts = new Map<string, CohortSegments>();

	for (const account of loadAccounts(db)) {
		const rows = loadSnapshots(db, account.id, hasObservedAt, hasTierColumns);
		// No snapshots at all: the account is ABSENT from the payload, never a
		// zero-filled cohort member. Listing an account a cohort has no evidence
		// for invites the reader to attribute the cohort's number to it.
		if (rows.length === 0) continue;

		const segmentLists = WINDOWS.map((window) =>
			buildSegments(toSamples(account.id, rows, window), {
				window,
				tokensFor: NO_TOKENS,
			}),
		);
		if (segmentLists.every((list) => list.length === 0)) continue;
		attachRequestTokens(requestScan, account, segmentLists);

		const tier = resolveTier(account, rows);
		const key = cohortKey(account.provider, tier);
		let cohort = cohorts.get(key);
		if (!cohort) {
			cohort = {
				key,
				provider: account.provider,
				planTier: tier.planTier,
				rateLimitTier: tier.rateLimitTier,
				accountIds: new Set(),
				tierProvenance: "recorded",
				segmentsByWindow: new Map(),
			};
			cohorts.set(key, cohort);
		}
		cohort.accountIds.add(account.id);
		// One assumed member taints the cohort: the reader cannot tell which
		// account's history was refiled, so the whole cohort has to say so.
		if (tier.provenance === "assumed") cohort.tierProvenance = "assumed";
		for (let i = 0; i < WINDOWS.length; i++) {
			if (segmentLists[i].length === 0) continue;
			const existing = cohort.segmentsByWindow.get(WINDOWS[i]);
			if (existing) existing.push(...segmentLists[i]);
			else cohort.segmentsByWindow.set(WINDOWS[i], [...segmentLists[i]]);
		}
	}

	return [...cohorts.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Stable cohort key: `provider|planTier|rateLimitTier`. */
export function cohortKey(provider: string, tier: ResolvedTier): string {
	return `${provider}|${tier.planTier ?? ""}|${tier.rateLimitTier ?? ""}`;
}

/**
 * Does a table have this column?
 *
 * Asked rather than assumed because the per-sample `observed_at` / `plan_tier` /
 * `rate_limit_tier` columns are additive migrations: a database that predates
 * them has every row legitimately without them, and that is exactly the
 * `tierProvenance: "assumed"` case rather than an error.
 */
function tableHasColumn(db: Database, table: string, column: string): boolean {
	try {
		const rows = db
			.prepare<{ name: string }, []>(`PRAGMA table_info(${table})`)
			.all();
		return rows.some((r) => r.name === column);
	} catch {
		return false;
	}
}

function loadAccounts(db: Database): ComputeAccount[] {
	const rows = db
		.prepare<
			{
				id: string;
				provider: string;
				identity_plan_tier: string | null;
				identity_rate_limit_tier: string | null;
			},
			[]
		>(
			`SELECT id, provider, identity_plan_tier, identity_rate_limit_tier
			 FROM accounts ORDER BY id`,
		)
		.all();
	return rows.map((r) => ({
		id: r.id,
		provider: r.provider,
		currentPlanTier: r.identity_plan_tier ?? null,
		currentRateLimitTier: r.identity_rate_limit_tier ?? null,
	}));
}

/**
 * One account's snapshots, ordered on the EFFECTIVE clock
 * (`observed_at ?? sampled_at`).
 *
 * The re-sort is not cosmetic: `observed_at` is `tick - cacheAge`, so a tick
 * that read an older cache entry can carry an earlier observation time than the
 * tick before it. `splitRuns` documents that its input must be ordered, and
 * feeding it out-of-order samples would fabricate percentage decreases (and
 * therefore run splits) that never happened. Ordering on the clock we actually
 * use is the honest fix; where the reordering makes a real run look
 * non-monotone the run splits, which loses evidence rather than inventing it.
 */
function loadSnapshots(
	db: Database,
	accountId: string,
	hasObservedAt: boolean,
	hasTierColumns: boolean,
): SnapshotScanRow[] {
	const observedAtCol = hasObservedAt ? "observed_at" : "NULL AS observed_at";
	const tierCols = hasTierColumns
		? "plan_tier, rate_limit_tier"
		: "NULL AS plan_tier, NULL AS rate_limit_tier";
	const rows = db
		.prepare<SnapshotScanRow, [string]>(
			`SELECT sampled_at, ${observedAtCol},
			        five_hour_pct, five_hour_reset,
			        seven_day_pct, seven_day_reset,
			        ${tierCols}
			 FROM usage_snapshots WHERE account_id = ? ORDER BY sampled_at`,
		)
		.all(accountId);
	return rows.sort((a, b) => effectiveMs(a) - effectiveMs(b));
}

/** The clock a snapshot's segment boundaries are placed on. */
function effectiveMs(row: SnapshotScanRow): number {
	return row.observed_at == null
		? Number(row.sampled_at)
		: Number(row.observed_at);
}

/** Project one account's snapshot rows onto one window's sample series. */
function toSamples(
	accountId: string,
	rows: readonly SnapshotScanRow[],
	window: QuotaWindowKind,
): WindowSample[] {
	return rows.map((row) => ({
		accountId,
		sampledAt: effectiveMs(row),
		pct:
			window === "five_hour"
				? nullableNumber(row.five_hour_pct)
				: nullableNumber(row.seven_day_pct),
		resetAt:
			window === "five_hour"
				? nullableNumber(row.five_hour_reset)
				: nullableNumber(row.seven_day_reset),
	}));
}

function nullableNumber(value: number | null): number | null {
	if (value == null) return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

/**
 * Fill `eqTokensByModel` on one account's segments by STREAMING its requests
 * once and merging them into every window's segment list at the same time.
 *
 * Mutates the lists in place (replacing each segment's token map), which is
 * what lets one row stream serve both windows: the 5h and 7d segment lists
 * cover the same account and very nearly the same span, so scanning twice would
 * double the I/O for nothing.
 *
 * Both sides are timestamp-ordered, so each list keeps a cursor that only ever
 * moves forward. Rows with no model, or with no positive exposure, contribute
 * nothing and are skipped rather than folded into an empty key.
 */
export function attachRequestTokens(
	scan: {
		iterate(
			accountId: string,
			lo: number,
			hi: number,
		): IterableIterator<RequestScanRow>;
	},
	account: ComputeAccount,
	segmentLists: QuotaSegment[][],
): void {
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	for (const list of segmentLists) {
		list.sort((a, b) => a.t0 - b.t0);
		for (const seg of list) {
			if (seg.t0 < lo) lo = seg.t0;
			if (seg.t1 > hi) hi = seg.t1;
		}
	}
	if (!(hi > lo)) return;

	const provider = eqTokenProviderFor(account.provider);
	const cursors = segmentLists.map(() => 0);
	const sums = segmentLists.map((list) =>
		list.map(() => new Map<string, number>()),
	);

	for (const row of scan.iterate(account.id, lo, hi)) {
		const key = normalizeModelKey(row.model);
		if (key === "") continue;
		const exposure = eqTokens(
			{
				inputTokens: row.input_tokens ?? 0,
				outputTokens: row.output_tokens ?? 0,
				cacheReadInputTokens: row.cache_read_input_tokens ?? 0,
				cacheCreationInputTokens: row.cache_creation_input_tokens ?? 0,
			},
			provider,
		);
		if (!(exposure > 0)) continue;
		const ts = Number(row.timestamp);

		for (let li = 0; li < segmentLists.length; li++) {
			const list = segmentLists[li];
			let cursor = cursors[li];
			// Rows arrive in ascending timestamp order, so a segment that already
			// ended can never receive another row: the cursor only moves forward.
			while (cursor < list.length && list[cursor].t1 <= ts) cursor++;
			cursors[li] = cursor;
			if (cursor >= list.length) continue;
			// Between two runs: inside the scan range but inside no segment. The
			// matching Δpct was never observed either, so dropping it is correct.
			if (ts < list[cursor].t0) continue;
			const bucket = sums[li][cursor];
			bucket.set(key, (bucket.get(key) ?? 0) + exposure);
		}
	}

	for (let li = 0; li < segmentLists.length; li++) {
		const list = segmentLists[li];
		for (let i = 0; i < list.length; i++) {
			list[i] = {
				...list[i],
				eqTokensByModel: Object.fromEntries(sums[li][i]),
			};
		}
	}
}

/**
 * Which tier a cohort files this account under.
 *
 * PREFERS the per-sample columns: the account's present-day tier refiles its
 * whole history under a tier it may have moved to yesterday, and a tier change
 * reads exactly like a change in what the subscription buys. The newest sample
 * that recorded a plan tier wins; falling back to today's values marks the
 * cohort `assumed`, which the panel must disclose.
 *
 * A null `rate_limit_tier` on a recorded row is a real value, not a gap —
 * Codex reports none — so recordedness keys off `plan_tier` only.
 */
export function resolveTier(
	account: ComputeAccount,
	rows: readonly SnapshotScanRow[],
): ResolvedTier {
	for (let i = rows.length - 1; i >= 0; i--) {
		if (rows[i].plan_tier != null) {
			return {
				planTier: rows[i].plan_tier,
				rateLimitTier: rows[i].rate_limit_tier ?? null,
				provenance: "recorded",
			};
		}
	}
	return {
		planTier: account.currentPlanTier,
		rateLimitTier: account.currentRateLimitTier,
		provenance: "assumed",
	};
}

/**
 * Fit one cohort's segments for one window: the rolling display series, the
 * latest fit's estimates, and a changepoint scan per model.
 *
 * `nSegments`, `r2` and `zeroObservedTokenDeltaShare` all describe the LATEST
 * rolling window rather than the whole history, so they qualify the numbers the
 * panel puts on screen. The changepoint scan, by contrast, runs over EVERY
 * segment: it is looking for a step, which only exists across history.
 */
function fitWindow(
	segments: readonly QuotaSegment[],
	opts: {
		cohortKey: string;
		window: QuotaWindowKind;
		provenance: TierProvenance;
		displayB: number;
		inferenceB: number;
	},
): QuotaDriftWindowResult {
	const seedParts = [opts.cohortKey, opts.window];
	const series = fitRolling(segments, {
		bootstrapB: opts.displayB,
		seedParts,
		tierProvenance: opts.provenance,
	});

	// The latest rolling window, read back OFF the series rather than
	// recomputed: duplicating fitRolling's grid arithmetic here is exactly the
	// kind of second implementation that drifts. When no model produced a
	// column there is no series to read, and the fallback covers everything.
	let latestStart: number | null = null;
	let latestEnd: number | null = null;
	for (const points of series.values()) {
		for (const point of points) {
			if (latestStart === null || point.windowStartMs > latestStart) {
				latestStart = point.windowStartMs;
				latestEnd = point.windowEndMs;
			}
		}
	}
	const latestSegments =
		latestStart === null || latestEnd === null
			? segments
			: segments.filter(
					(s) =>
						s.t0 >= (latestStart as number) && s.t1 <= (latestEnd as number),
				);
	const latestFit = fitWithIntervals(latestSegments, {
		bootstrapB: opts.displayB,
		// Matches the seed fitRolling derives for that same window, so the
		// `latest` numbers are the last series point's numbers and not a second,
		// slightly different draw of them.
		seedParts:
			latestStart === null ? seedParts : [...seedParts, latestStart as number],
		tierProvenance: opts.provenance,
	});

	const keys = new Set<string>(series.keys());
	for (const coef of latestFit.coefficients) keys.add(coef.key);

	const models: QuotaDriftModel[] = [];
	for (const key of [...keys].sort()) {
		const coef = latestFit.coefficients.find((c) => c.key === key) ?? null;
		const scan = detectChanges(segments, key, {
			bootstrapB: opts.inferenceB,
			seedParts: [...seedParts, key],
		});
		models.push({
			key,
			points: (series.get(key) ?? []).map(toWirePoint),
			latest: coef
				? {
						pointEstimate: coef.pointEstimate,
						ciLow: coef.ciLow,
						ciHigh: coef.ciHigh,
						impliedCapacityMtok: coef.impliedCapacityMtok,
						shareOfWindow: coef.shareOfWindow,
						identified: coef.identified,
						unidentifiedReasons: [...coef.unidentifiedReasons],
					}
				: null,
			changes: scan.changes.map((change): QuotaDriftChange => ({ ...change })),
			verdict: scan.verdict,
		});
	}

	return {
		window: opts.window,
		nSegments: latestFit.nSegments,
		r2: latestFit.r2,
		zeroObservedTokenDeltaShare: latestFit.zeroObservedTokenDeltaShare,
		models,
	};
}

function toWirePoint(point: SeriesPoint): QuotaDriftPoint {
	return {
		windowStartMs: point.windowStartMs,
		windowEndMs: point.windowEndMs,
		pointEstimate: point.pointEstimate,
		ciLow: point.ciLow,
		ciHigh: point.ciHigh,
		impliedCapacityMtok: point.impliedCapacityMtok,
		identified: point.identified,
		nSegments: point.nSegments,
	};
}
