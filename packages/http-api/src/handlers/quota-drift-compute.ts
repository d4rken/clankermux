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
 *
 * ## Which tier
 *
 * Tiers are resolved PER SAMPLE, because one tier per account cannot be right:
 * on any upgraded database the tier columns are null until the restart that
 * added them, so a single resolution files pre-column history under a tier that
 * was not in force then. A subscription change would then look like a change in
 * what the subscription buys, which is the very thing being measured.
 *
 * Tiers are applied by TAGGING built segments, never by splitting the builder's
 * input. Runs are the bootstrap's independent blocks and the unit the
 * identifiability gate counts, so cutting the sample series before
 * `buildSegments` turns one physical run into two and manufactures independence
 * out of bookkeeping. That is not hypothetical: `plan_tier` starts being
 * recorded partway through a monotone run and usually records exactly the value
 * the accounts row was already supplying, so a split on PROVENANCE alone would
 * fabricate a second run — and with it an interval — where the tier never moved.
 *
 * A segment is therefore tagged from every sample spanning `[t0, t1]`: agreeing
 * tier values give the tag (marked `assumed` if any spanning sample had to fall
 * back to the accounts row), and disagreeing values drop that ONE segment, which
 * belongs to neither tier. Segments either side of the change keep their run id
 * and stay in whichever cohort their own span supports.
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
	MAX_SAMPLE_GAP_MS,
	normalizeModelKey,
	OTHER_MODEL_KEY,
	type QuotaSegment,
	type QuotaWindowKind,
	type SeriesPoint,
	shareByKey,
	type TierProvenance,
	type WindowSample,
} from "@clankermux/core";
import type {
	QuotaDriftAccountScope,
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
			windows.push({
				...fitWindow(segments, {
					cohortKey: cohort.key,
					window,
					provenance: cohort.tierProvenance,
					displayB,
					inferenceB,
				}),
				// Whether the window MOVED, and whether our readings still include it
				// at all, are not things a fit can answer — a constant response
				// variable yields no coefficients and an absent one yields no samples
				// — so both come from the samples, alongside rather than inside the
				// fit. `now` is the same clock the payload is stamped with, which is
				// what lets the absence claim be checked against it.
				...summarizeFlatWindow(
					cohort.observationsByWindow.get(window) ?? [],
					window,
					segments,
					now,
				),
			});
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
	/**
	 * `assumed` as soon as ONE contributing stretch of history had its tier
	 * inferred from today's accounts row rather than recorded per sample. An
	 * account whose tier changed contributes to several cohorts, so this is a
	 * property of the segments in THIS cohort, not of any account as a whole.
	 */
	tierProvenance: TierProvenance;
	/** Per-window segments, tokens already attached. */
	segmentsByWindow: Map<QuotaWindowKind, QuotaSegment[]>;
	/**
	 * Per-window movement facts, one entry per contributing account.
	 *
	 * Kept separate from the segments because they answer a different question:
	 * segments say how the window moved, these say WHETHER it moved at all.
	 */
	observationsByWindow: Map<QuotaWindowKind, WindowObservation[]>;
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
	const observations = new Map<
		string,
		Map<QuotaWindowKind, WindowObservation[]>
	>();

	for (const account of loadAccounts(db)) {
		const rows = loadSnapshots(db, account.id, hasObservedAt, hasTierColumns);
		// No snapshots at all: the account is ABSENT from the payload, never a
		// zero-filled cohort member. Listing an account a cohort has no evidence
		// for invites the reader to attribute the cohort's number to it.
		if (rows.length === 0) continue;

		// ONE `buildSegments` call per window over the account's WHOLE history, so
		// the runs the fit and the bootstrap see are the physical ones. Tiering is
		// applied afterwards, by tagging; see "Which tier" at the top of the file
		// for why splitting the input instead fabricates independent runs.
		const built = WINDOWS.map((window) => ({
			window,
			segments: buildSegments(toSamples(account.id, rows, window), {
				window,
				tokensFor: NO_TOKENS,
			}),
		}));
		if (built.every((entry) => entry.segments.length === 0)) continue;
		// One request scan for the whole account, merged into both windows' lists
		// at once: each list carries its own forward cursor, so scanning per window
		// would only cost I/O.
		attachRequestTokens(
			requestScan,
			account,
			built.map((entry) => entry.segments),
		);

		// The sample clock, precomputed once: `resolveSpanTier` binary-searches it
		// per segment, and `rows` is already ordered on it.
		const clock = rows.map(effectiveMs);
		for (const entry of built) {
			for (const segment of entry.segments) {
				const tier = resolveSpanTier(account, rows, clock, segment);
				// A segment whose own span really does straddle a tier change belongs
				// to neither tier, so it — and only it — is dropped.
				if (tier === null) continue;
				addSegmentToCohort(cohorts, account, entry.window, tier, segment);
			}
			// Movement facts come from the SAMPLES, not the segments: a window that
			// never moves still produces segments (a constant percentage is monotone),
			// so stillness is invisible on the segment side.
			for (const [key, observation] of collectWindowObservations(
				account,
				rows,
				entry.window,
			)) {
				const forCohort = observations.get(key) ?? new Map();
				const forWindow = forCohort.get(entry.window) ?? [];
				forWindow.push(observation);
				forCohort.set(entry.window, forWindow);
				observations.set(key, forCohort);
			}
		}
	}

	// Attached only at the END, so an observation never depends on whether its
	// cohort happened to exist yet when the account producing it was scanned.
	for (const cohort of cohorts.values()) {
		const forCohort = observations.get(cohort.key);
		if (forCohort) cohort.observationsByWindow = forCohort;
	}

	return [...cohorts.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** File one tagged segment under its cohort, creating the cohort on demand. */
function addSegmentToCohort(
	cohorts: Map<string, CohortSegments>,
	account: ComputeAccount,
	window: QuotaWindowKind,
	tier: ResolvedTier,
	segment: QuotaSegment,
): void {
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
			observationsByWindow: new Map(),
		};
		cohorts.set(key, cohort);
	}
	cohort.accountIds.add(account.id);
	// One assumed segment taints the cohort: the reader cannot tell which stretch
	// of history was inferred, so the whole cohort has to say so.
	if (tier.provenance === "assumed") cohort.tierProvenance = "assumed";
	const existing = cohort.segmentsByWindow.get(window);
	if (existing) existing.push(segment);
	else cohort.segmentsByWindow.set(window, [segment]);
}

/* ── Whether a window moved at all ──────────────────────────────────────── */

/**
 * How long a window must sit unchanged before its stillness says anything.
 *
 * Per window kind, because a weekly percentage legitimately sits still far
 * longer than a 5-hour one: two full reset cycles for the weekly window, one
 * week for the 5-hour window (which resets 33 times in that period).
 */
export const FLAT_WINDOW_THRESHOLD_MS: Record<QuotaWindowKind, number> = {
	five_hour: 7 * 24 * 60 * 60 * 1000,
	seven_day: 14 * 24 * 60 * 60 * 1000,
};

/**
 * Eq-tokens that must have been charged against a window during its flat
 * period before the flatness is reported.
 *
 * THE crux of this whole computation. A window that did not move because we
 * sent no traffic against it is a fact about us, not about the provider, and
 * the two are indistinguishable in the percentage series alone. 1M eq-tokens
 * over a period of at least a week is unambiguously real usage.
 */
export const MIN_FLAT_TRAFFIC_EQ_TOKENS = 1_000_000;

/**
 * How far behind the cohort's newest SNAPSHOT an account may be and still count
 * as currently sampled.
 *
 * An account that stopped being sampled a month ago cannot testify to whether
 * the window is moving NOW, so it is excluded from the decision entirely rather
 * than counted as flat — counting it would let a decommissioned account either
 * freeze a live cohort or, worse, be the only evidence for a flat claim.
 *
 * This bound decides SAMPLING membership and nothing else. Whether a
 * still-sampled account is REPORTING this window is a different question with a
 * different answer — `latestIncludesWindow`, read off its newest reading — and
 * no age bound substitutes for it; see {@link summarizeFlatWindow}.
 */
export const CURRENT_MEMBER_MS = 24 * 60 * 60 * 1000;

/** What one account's samples say about whether one window moved. */
export interface WindowObservation {
	accountId: string;
	/** Oldest non-null sample in this cohort's stretch, ms since epoch. */
	firstObservedMs: number;
	/** Newest non-null sample, ms since epoch. */
	lastObservedMs: number;
	/**
	 * Newest snapshot of ANY kind in this cohort, ms since epoch.
	 *
	 * The account-activity signal, and deliberately not the same thing as
	 * `lastObservedMs`. A snapshot whose value for THIS window is null is still
	 * a reading the sampler took: the account is alive and being polled, it just
	 * is not reporting this particular window. Conflating the two lets an
	 * account that has gone quiet and an account whose window dropped out of the
	 * payload look identical, and only the first may be dropped from a cohort
	 * claim without qualifying it.
	 */
	lastSampleMs: number;
	/**
	 * Whether the NEWEST reading of this account in this cohort carried a value
	 * for this window.
	 *
	 * Current presence, and deliberately not derived from how old
	 * `lastObservedMs` is or from whether an absence cleared the gates in
	 * {@link summarizeAbsentWindow}. Claim MATURITY — is the absence old enough,
	 * and can it be dated? — and current PRESENCE are different properties, and
	 * using the first as a proxy for the second states that an account still
	 * reports a window whose latest readings are null.
	 */
	latestIncludesWindow: boolean;
	/** Newest observed CHANGE, ms, or null when the value never moved. */
	lastMovementMs: number | null;
	/** Start of the current unbroken constant run, ms. */
	flatStartMs: number;
	/** The value that run has been reporting. */
	flatValuePct: number;
	/**
	 * The first reading of the trailing run whose readings carry NO value for
	 * this window, ms, or null when the newest reading still carries one or the
	 * transition into that run cannot be dated.
	 *
	 * A claim about our readings, never about the provider's payload: the
	 * normalizer maps a missing field, an explicit null, a non-finite value and
	 * an unrecognised `limits[]` shape all to the same null, and the sampler
	 * persists normalized output.
	 *
	 * See {@link findAbsenceOnset} for which of those conditions are decided
	 * here and which are left to {@link summarizeFlatWindow}.
	 */
	notReportingSinceMs: number | null;
}

/**
 * Walk ONE account's samples for ONE window and record whether it moved,
 * splitting the record by the cohort each sample belongs to.
 *
 * Four rules, each of which is a way of NOT claiming stillness that was never
 * observed:
 *
 *  - movement is a change between two CONSECUTIVE samples of this account. Two
 *    accounts reading different values is not movement, so accounts are never
 *    compared with each other;
 *  - a null sample breaks the streak. Absence of evidence is not a flat line,
 *    and the reading either side of it may be hours apart in meaning;
 *  - so does a gap wider than the sampler's freshness bound
 *    (`MAX_SAMPLE_GAP_MS`): the window was unobserved across it and may have
 *    moved and come back;
 *  - so does a change of tier. A cohort's stillness must be measured from
 *    samples that belong to that cohort, or movement lands on the wrong one.
 *
 * The clock is the effective one (`observed_at ?? sampled_at`), matching what
 * segment boundaries use.
 */
export function collectWindowObservations(
	account: ComputeAccount,
	rows: readonly SnapshotScanRow[],
	window: QuotaWindowKind,
): Map<string, WindowObservation> {
	const out = new Map<string, WindowObservation>();
	let prev: { ms: number; pct: number; cohort: string } | null = null;

	for (const row of rows) {
		const pct = nullableNumber(
			window === "five_hour" ? row.five_hour_pct : row.seven_day_pct,
		);
		const ms = effectiveMs(row);
		const key = cohortKey(account.provider, resolveRowTier(account, row));
		if (pct === null) {
			// The sampler DID take a reading here; it just did not include this
			// window. That is account activity, and recording it is what keeps a
			// live account whose window went absent from being mistaken for one
			// that stopped being polled.
			const existing = out.get(key);
			if (existing) {
				existing.lastSampleMs = ms;
				existing.latestIncludesWindow = false;
			}
			prev = null;
			continue;
		}
		const continuous =
			prev !== null && prev.cohort === key && ms - prev.ms <= MAX_SAMPLE_GAP_MS;
		const existing = out.get(key);
		if (!existing) {
			out.set(key, {
				accountId: account.id,
				firstObservedMs: ms,
				lastObservedMs: ms,
				lastSampleMs: ms,
				latestIncludesWindow: true,
				lastMovementMs: null,
				flatStartMs: ms,
				flatValuePct: pct,
				notReportingSinceMs: null,
			});
		} else {
			existing.lastObservedMs = ms;
			existing.lastSampleMs = ms;
			existing.latestIncludesWindow = true;
			if (!continuous) {
				// Unobserved time is not stillness: the streak restarts here rather
				// than bridging whatever happened across the break.
				existing.flatStartMs = ms;
				existing.flatValuePct = pct;
			} else if (prev !== null && pct !== prev.pct) {
				existing.lastMovementMs = ms;
				existing.flatStartMs = ms;
				existing.flatValuePct = pct;
			}
		}
		prev = { ms, pct, cohort: key };
	}

	// Attached after the walk because it is decided from the END of the series
	// backwards, and only for the cohort that actually reported a value before
	// the run began — `out` has an entry for exactly those.
	const absence = findAbsenceOnset(account, rows, window);
	const observation = absence ? out.get(absence.cohort) : undefined;
	if (absence && observation) {
		observation.notReportingSinceMs = absence.sinceMs;
	}

	return out;
}

/**
 * When ONE account's readings stopped carrying a value for this window, or null
 * when they still do, when it never carried one, or when the transition cannot
 * be dated.
 *
 * Decided here, because each needs the rows:
 *
 *  - the NEWEST reading has no value for this window. Anything else is not an
 *    ongoing absence;
 *  - a value was reported immediately before the run, in the SAME cohort. A run
 *    with no reading before it establishes nothing, and one whose tier changed
 *    across the boundary belongs to two cohorts;
 *  - the BOUNDARY gap — last reading with a value to first reading without one
 *    — is within `MAX_SAMPLE_GAP_MS`;
 *  - the sibling window carried a value on EVERY reading of the run. A reading
 *    that carries neither window is a sampler that fetched nothing, and a run
 *    of those says nothing about which windows the payload contains.
 *
 * Left to {@link summarizeFlatWindow}: how long the absence must have held, how
 * fresh the newest reading must be, and who in the cohort it covers.
 *
 * ## Why only the BOUNDARY gap is checked, and never the gaps inside the run
 *
 * Deliberate, and the opposite of the rule `collectWindowObservations` applies
 * to flat streaks. The two claims fail differently:
 *
 *  - `flatSince` claims the value did not MOVE. An unobserved interval can
 *    falsify that — the value may have moved and moved back unseen — so every
 *    gap has to break the streak;
 *  - this claims our readings did not INCLUDE a value. An unobserved interval
 *    cannot falsify that: a reading never taken cannot have included anything.
 *
 * What does matter is the boundary, because it is what DATES the transition. If
 * we were not observing when the value went absent, we cannot say when it went
 * absent, and the gate refuses rather than naming a date it cannot support.
 *
 * The gaps inside the run are the demand-aware poller backing off while the
 * proxy is idle — ordinary operation, and irrelevant to this claim. Do not
 * "fix" this into intra-run continuity: it would refuse the very case the field
 * exists for while establishing nothing.
 */
function findAbsenceOnset(
	account: ComputeAccount,
	rows: readonly SnapshotScanRow[],
	window: QuotaWindowKind,
): { cohort: string; sinceMs: number } | null {
	if (rows.length === 0) return null;
	const targetPct = (row: SnapshotScanRow) =>
		nullableNumber(
			window === "five_hour" ? row.five_hour_pct : row.seven_day_pct,
		);
	const siblingPct = (row: SnapshotScanRow) =>
		nullableNumber(
			window === "five_hour" ? row.seven_day_pct : row.five_hour_pct,
		);

	if (targetPct(rows[rows.length - 1]) !== null) return null;

	let index = rows.length - 1;
	while (index >= 0 && targetPct(rows[index]) === null) {
		// Neither window present: nothing was read, so this run cannot testify to
		// what a reading contains.
		if (siblingPct(rows[index]) === null) return null;
		index--;
	}
	if (index < 0) return null;

	const lastValueRow = rows[index];
	const firstAbsentRow = rows[index + 1];
	const sinceMs = effectiveMs(firstAbsentRow);
	if (sinceMs - effectiveMs(lastValueRow) > MAX_SAMPLE_GAP_MS) return null;

	const cohort = cohortKey(
		account.provider,
		resolveRowTier(account, lastValueRow),
	);
	for (let i = index + 1; i < rows.length; i++) {
		const rowCohort = cohortKey(
			account.provider,
			resolveRowTier(account, rows[i]),
		);
		if (rowCohort !== cohort) return null;
	}
	return { cohort, sinceMs };
}

/** The movement facts one cohort reports for one window. */
export interface FlatWindowFacts {
	lastMovementMs: number | null;
	lastObservedMs: number | null;
	flatValuePct: number | null;
	flatSince: number | null;
	flatScope: QuotaDriftAccountScope | null;
	notReportedSince: number | null;
	notReportedScope: QuotaDriftAccountScope | null;
}

const NO_MOVEMENT_FACTS: FlatWindowFacts = {
	lastMovementMs: null,
	lastObservedMs: null,
	flatValuePct: null,
	flatSince: null,
	flatScope: null,
	notReportedSince: null,
	notReportedScope: null,
};

/**
 * Aggregate one cohort's per-account observations into the facts the panel
 * renders.
 *
 * ## Two different questions about an account, deliberately kept apart
 *
 * "Is this account still being sampled?" is answered by `lastSampleMs`, the
 * newest snapshot of any kind. "Is it still reporting THIS window?" is answered
 * by `latestIncludesWindow`, whether its newest reading carried a value.
 *
 * Using the first for both is a false-claim generator, and not a subtle one.
 * Take an account A that still reports the 5-hour window and has been flat for
 * eight days, and an account B producing fresh weekly readings whose 5-hour
 * value has been null for 25 hours. Judged on target-window freshness alone B
 * drops out of the decision entirely, so A speaks for the cohort — and the
 * differing-value branch below would go on to say "on every account" about a
 * cohort where one member had been silently excluded. The cohort is mixed
 * (flat on A, absent on B) and the copy has to say so.
 *
 * Presence is read from the newest reading rather than from how OLD the newest
 * value is, because a freshness bound answers a third question again. An
 * account whose 5-hour value went null two hours ago is inside any freshness
 * bound and is still not reporting the window; counting it as reporting puts an
 * account with nothing to say into a claim about what the window shows.
 *
 * So membership is decided on sampling, and the still-sampled accounts are then
 * split into the ones reporting the window and the ones that are not. Only the
 * REPORTING ones can be flat or moving; the rest make the claim a subset claim,
 * which `flatScope` carries to the panel.
 *
 * ## What `flatSince` still requires
 *
 * Every one of these exists to prevent a specific false claim:
 *
 *  - EVERY reporting account is flat. One account still moving means the window
 *    is not frozen, whatever the others show, and no scope qualifies that away;
 *  - each of them has been flat for longer than the window's threshold, over an
 *    observed span longer than that threshold. A three-day-old database cannot
 *    establish a two-week absence of movement;
 *  - observation was continuous through the period — already guaranteed by how
 *    `collectWindowObservations` breaks its streaks;
 *  - material traffic really was charged against the window in that period. A
 *    window that did not move because we sent nothing is not a provider fact.
 *
 * The cohort's `flatSince` is the LATEST member's, because that is when the
 * cohort as a whole became still.
 *
 * ## `notReportedSince` is a separate state, on the OTHER side of the split
 *
 * It is established on the accounts whose readings no longer carry the window,
 * so it survives every early return below — including the one taken when
 * NOTHING reports the window, which is precisely when it is the only thing left
 * to say. See {@link summarizeAbsentWindow}.
 */
export function summarizeFlatWindow(
	observations: readonly WindowObservation[],
	window: QuotaWindowKind,
	segments: readonly QuotaSegment[],
	nowMs: number,
): FlatWindowFacts {
	if (observations.length === 0) return NO_MOVEMENT_FACTS;

	const lastObservedMs = Math.max(...observations.map((o) => o.lastObservedMs));
	const movements = observations
		.map((o) => o.lastMovementMs)
		.filter((ms): ms is number => ms !== null);
	const observed: FlatWindowFacts = {
		...NO_MOVEMENT_FACTS,
		lastMovementMs: movements.length > 0 ? Math.max(...movements) : null,
		lastObservedMs,
	};

	const newestSampleMs = Math.max(...observations.map((o) => o.lastSampleMs));
	const active = observations.filter(
		(o) => newestSampleMs - o.lastSampleMs <= CURRENT_MEMBER_MS,
	);
	if (active.length === 0) return observed;

	// Carried by every return from here on: whether our readings still include
	// the window is decided on the accounts that are NOT reporting it, and the
	// flat gates below can only ever withhold a claim about the ones that are.
	const base: FlatWindowFacts = {
		...observed,
		...summarizeAbsentWindow(active, newestSampleMs, nowMs),
	};

	// Still sampled AND still carrying a value for this window. An active
	// account that is not in here has not gone quiet — its readings simply no
	// longer include the window, which is a different fact and cannot be settled
	// by the accounts that do report it.
	const reporting = active.filter((o) => o.latestIncludesWindow);
	if (reporting.length === 0) return base;

	const threshold = FLAT_WINDOW_THRESHOLD_MS[window];
	const allFlat = reporting.every(
		(o) =>
			o.lastObservedMs - o.flatStartMs >= threshold &&
			o.lastObservedMs - o.firstObservedMs > threshold,
	);
	if (!allFlat) return base;

	const flatSince = Math.max(...reporting.map((o) => o.flatStartMs));
	const accountIds = new Set(reporting.map((o) => o.accountId));
	if (!hasMaterialTraffic(segments, accountIds, flatSince)) return base;

	const values = new Set(reporting.map((o) => o.flatValuePct));
	return {
		...base,
		// Accounts constant at DIFFERENT values are each flat, so the cohort is
		// flat, but there is no single number to name.
		flatValuePct: values.size === 1 ? reporting[0].flatValuePct : null,
		flatSince,
		flatScope:
			reporting.length === active.length ? "all-accounts" : "reporting-subset",
	};
}

/**
 * How long a window's value must have been absent from every reading before the
 * absence is reported.
 *
 * A day, and deliberately NOT scaled by the window's reset duration the way
 * {@link FLAT_WINDOW_THRESHOLD_MS} is. Stillness has to outlast the thing that
 * would make it move, so a weekly percentage needs weeks; presence does not —
 * these fields are expected on every poll, so a day without one is already far
 * longer than any cadence or backoff explains.
 */
export const WINDOW_ABSENT_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the cohort's readings have stopped including this window, decided on
 * the still-sampled accounts that are NOT reporting it.
 *
 * The per-account half of the question — that a value was reported before, that
 * the transition was observed closely enough to be dated, and that the sibling
 * window kept reporting through the run — is already settled in
 * {@link findAbsenceOnset}. What is left is the cohort's half:
 *
 *  - the absence has held for at least {@link WINDOW_ABSENT_THRESHOLD_MS};
 *  - the newest reading is itself recent. A cohort nobody has sampled since
 *    yesterday says nothing about what today's readings contain, and reporting
 *    its last known state as current would be exactly the stalled-sampler
 *    confusion `lastObservedMs` exists to expose;
 *  - who it covers. Some accounts absent and others still reporting is a
 *    PARTIAL rollout, and stating it as a cohort-wide observation would claim
 *    something none of the readings support.
 *
 * The cohort's `notReportedSince` is the LATEST member's, because that is when
 * the cohort as a whole stopped carrying the window.
 *
 * ## Maturity is not presence
 *
 * Whether an absence is ESTABLISHED (old enough, datable) and whether a window
 * is currently PRESENT are separate properties, and the scope has to be decided
 * on the second. Two accounts that both stopped reporting, 30 hours ago and 12
 * hours ago, produce exactly one onset — and reading "not in the onsets" as
 * "still reporting" made the panel tell a reader that the 12-hour account still
 * reports a window whose newest readings are null. That is the failure class
 * this whole analysis exists to avoid, so the remainder is partitioned on
 * `latestIncludesWindow` and the uncertain case gets copy that asserts nothing
 * about it.
 */
function summarizeAbsentWindow(
	active: readonly WindowObservation[],
	newestSampleMs: number,
	nowMs: number,
): Pick<FlatWindowFacts, "notReportedSince" | "notReportedScope"> {
	const none = { notReportedSince: null, notReportedScope: null } as const;
	if (nowMs - newestSampleMs > CURRENT_MEMBER_MS) return none;

	// The accounts this claim can be about at all: the ones whose NEWEST reading
	// carried no value for the window. Membership here is current presence, and
	// nothing below may widen it.
	const absent = active.filter((o) => !o.latestIncludesWindow);
	const onsets = absent.flatMap((o) => {
		const since = o.notReportingSinceMs;
		if (since === null) return [];
		return o.lastSampleMs - since >= WINDOW_ABSENT_THRESHOLD_MS ? [since] : [];
	});
	if (onsets.length === 0) return none;

	// Three-way, because the accounts the claim does NOT cover are not one
	// group. Some are reporting the window right now; the rest are not reporting
	// it either but their absence is too young or could not be dated. Collapsing
	// the second into the first is how the partial notice came to tell a reader
	// that an account still reports a window whose newest readings were null.
	const scope: QuotaDriftAccountScope =
		onsets.length === active.length
			? "all-accounts"
			: onsets.length === absent.length
				? "reporting-subset"
				: "partial-cohort";

	return { notReportedSince: Math.max(...onsets), notReportedScope: scope };
}

/** Whether enough exposure was charged against a window since `sinceMs`. */
function hasMaterialTraffic(
	segments: readonly QuotaSegment[],
	accountIds: ReadonlySet<string>,
	sinceMs: number,
): boolean {
	let total = 0;
	for (const segment of segments) {
		if (segment.t0 < sinceMs) continue;
		if (!accountIds.has(segment.accountId)) continue;
		for (const tokens of Object.values(segment.eqTokensByModel))
			total += tokens;
		if (total >= MIN_FLAT_TRAFFIC_EQ_TOKENS) return true;
	}
	return false;
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
			key,
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
 * Which tier ONE sample was taken under.
 *
 * PREFERS the row's own columns. Resolving a single tier per account and
 * applying it to that account's whole history is what every upgraded database
 * would hit: old rows have null tier columns, newer ones carry values, and a
 * backward scan for "the newest recorded tier" then files the old rows under a
 * tier that was not in force when they were sampled. That both suppresses the
 * assumed-tier disclosure the panel owes the reader and turns a real
 * subscription change into a manufactured changepoint.
 *
 * A null `rate_limit_tier` on a recorded row is a real value, not a gap —
 * Codex reports none — so recordedness keys off `plan_tier` only.
 */
export function resolveRowTier(
	account: ComputeAccount,
	row: SnapshotScanRow,
): ResolvedTier {
	if (row.plan_tier != null) {
		return {
			planTier: row.plan_tier,
			rateLimitTier: row.rate_limit_tier ?? null,
			provenance: "recorded",
		};
	}
	return {
		planTier: account.currentPlanTier,
		rateLimitTier: account.currentRateLimitTier,
		provenance: "assumed",
	};
}

/**
 * Which tier ONE BUILT SEGMENT was measured under, or null when its span
 * straddles a tier change and it belongs to neither.
 *
 * The segment is tagged from every sample spanning `[t0, t1]` inclusive — both
 * endpoints are anchor samples, and the samples between them are the evidence
 * the segment's Δpct came from.
 *
 * Provenance is deliberately NOT part of the identity being compared. A stretch
 * that recorded `max` and a stretch that inferred `max` from today's accounts
 * row describe the same tier; the difference is in how well it is known, which
 * is what `provenance: "assumed"` exists to say. Treating the difference as a
 * tier CHANGE would split the run it happens in, and `plan_tier` starts being
 * recorded partway through a run with the value the fallback was already
 * supplying — so the split would be pure bookkeeping presented as independent
 * evidence.
 *
 * `rows` and `clock` are the account's samples ordered on the effective clock,
 * so the first spanning sample is found by binary search rather than a rescan.
 */
export function resolveSpanTier(
	account: ComputeAccount,
	rows: readonly SnapshotScanRow[],
	clock: readonly number[],
	span: { t0: number; t1: number },
): ResolvedTier | null {
	let resolved: ResolvedTier | null = null;
	let assumed = false;
	for (let i = lowerBound(clock, span.t0); i < rows.length; i++) {
		if (clock[i] > span.t1) break;
		const tier = resolveRowTier(account, rows[i]);
		if (resolved === null) {
			resolved = tier;
		} else if (
			resolved.planTier !== tier.planTier ||
			resolved.rateLimitTier !== tier.rateLimitTier
		) {
			return null;
		}
		if (tier.provenance === "assumed") assumed = true;
	}
	if (resolved === null) return null;
	return assumed ? { ...resolved, provenance: "assumed" } : resolved;
}

/** Index of the first entry of an ascending array that is `>= value`. */
function lowerBound(values: readonly number[], value: number): number {
	let lo = 0;
	let hi = values.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (values[mid] < value) lo = mid + 1;
		else hi = mid;
	}
	return lo;
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
	// The pooled column stays in every fit — it has to absorb the sub-share tail,
	// or that exposure would be pushed onto whichever kept column co-occurred
	// with it — but it is not a model. Its membership changes as rare models come
	// and go, so reporting a coefficient or a change verdict for it would present
	// pure composition change as quota drift.
	keys.delete(OTHER_MODEL_KEY);

	// Raw (unpooled) share of the latest window per key, for the models that got
	// NO column in that fit. Passing every key as kept makes `shareByKey` return
	// each one's own share instead of pooling it into `other`, and for a key that
	// DID get a column the number is the same one the coefficient already
	// carries — this cannot restate an existing share differently.
	const latestShares = shareByKey(latestSegments, [...keys]);

	const models: QuotaDriftModel[] = [];
	for (const key of [...keys].sort()) {
		const coef = latestFit.coefficients.find((c) => c.key === key) ?? null;
		const points = series.get(key) ?? [];
		const scan = detectChanges(segments, key, {
			bootstrapB: opts.inferenceB,
			seedParts: [...seedParts, key],
		});
		models.push({
			key,
			points: points.map(toWirePoint),
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
				: latestUnidentified(points, latestShares.get(key) ?? 0),
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

/**
 * The `latest` entry for a model the latest fit gave NO column at all.
 *
 * Returning null here — which is what this used to do — throws away the one
 * thing the reader needed. A model with zero exposure in the latest window is
 * not in `selectKeys`, so it has no coefficient, and the cost table fell back
 * to its generic "Not enough independent traffic" wording. The chart's gap list
 * said "Not in use during this period" about the very same fact, so one tab
 * gave two different answers and contradicted the distinction `no-exposure`
 * exists to draw.
 *
 * The reasons come from the model's LAST series point, which is the same fit:
 * `fitRolling`'s final grid window and the `latest` fit cover an identical
 * segment set under an identical seed. Nothing is estimated here — the entry is
 * unidentified, every number in it is null, and `shareOfWindow` is a counted
 * ratio of eq-tokens rather than a fitted quantity.
 *
 * `shareOfWindow` is the model's REAL share, not a hard 0. Zero exposure and
 * sub-floor exposure both miss the column, and printing 0.0% for a model that
 * genuinely carried 1.5% of the window would be exactly the kind of fabricated
 * number this panel refuses everywhere else.
 */
function latestUnidentified(
	points: readonly SeriesPoint[],
	shareOfWindow: number,
): QuotaDriftModel["latest"] {
	const last = points.at(-1);
	// No column AND no series point: nothing observed this model in the window
	// at all, and there is no reason on record to attribute the absence to.
	if (!last) return null;
	return {
		pointEstimate: null,
		ciLow: null,
		ciHigh: null,
		impliedCapacityMtok: null,
		shareOfWindow,
		identified: false,
		unidentifiedReasons: [...last.unidentifiedReasons],
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
		unidentifiedReasons: [...point.unidentifiedReasons],
	};
}
