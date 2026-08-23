/**
 * Quota-drift precompute and endpoint.
 *
 * The claims under test are the ones the compute path can get wrong on its own;
 * everything statistical is already pinned by the core module's synthetic tests
 * and is deliberately NOT re-asserted here.
 *
 *  1. Cohorting: accounts group by (provider, plan tier, rate-limit tier), the
 *     per-sample tiers win over today's accounts row, an account whose recorded
 *     tier changes contributes each stretch of its history to the cohort that
 *     stretch belongs to, and ONE assumed member marks the whole cohort assumed.
 *  1a. Tiering TAGS segments and never splits the builder's input. A flip from
 *     an inferred tier to the same tier recorded is not a tier change, and a
 *     split on it would cut one physical run into two bootstrap blocks —
 *     independence manufactured out of bookkeeping.
 *  1b. The pooled `other` column stays inside the fit and off the wire.
 *  2. An account with no snapshots is ABSENT, not a zero-filled cohort member.
 *  3. The endpoint says `computing` until a pass has stored a row.
 *  4. The compute path and the core segment builder agree on segment
 *     boundaries. This is the anti-drift test and the reason the segment↔request
 *     join moved into JS: the SQL must not re-derive run/bucket logic, so the
 *     segments the fit consumes have to be the core builder's, byte for byte.
 *  5. The per-account request scan stays on `idx_requests_account_timestamp`.
 *     A degradation to a table scan is a defect, not a slowdown.
 */
import { Database } from "bun:sqlite";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	setSystemTime,
} from "bun:test";
import {
	buildSegments,
	type QuotaSegment,
	type WindowSample,
} from "@clankermux/core";
import { ensureSchema } from "@clankermux/database";
import type { QuotaDriftResponse } from "@clankermux/types";
import {
	attachRequestTokens,
	collectCohortSegments,
	computeQuotaDrift,
	REQUEST_SCAN_SQL,
} from "../quota-drift-compute";
import {
	COMPUTING_RESPONSE,
	createQuotaDriftHandlerFromSources,
} from "../quota-drift-direct";
import {
	ACCOUNT_ASSUMED,
	ACCOUNT_CODEX,
	ACCOUNT_MAX_A,
	ACCOUNT_MAX_B,
	ACCOUNT_NO_SNAPSHOTS,
	COHORT_ASSUMED,
	COHORT_CODEX,
	COHORT_MAX,
	FIXTURE_NOW,
	fixtureAccount,
	fixtureWindowSamples,
	seedQuotaDriftFixture,
} from "./quota-drift-fixture";

/** Small resample counts: the plumbing is under test, not the intervals. */
const TEST_BOOTSTRAP = { displayBootstrapB: 12, inferenceBootstrapB: 12 };

let db: Database;

beforeEach(() => {
	setSystemTime(new Date(FIXTURE_NOW));
	db = new Database(":memory:");
	ensureSchema(db);
	seedQuotaDriftFixture(db);
});

afterEach(() => {
	db.close();
	setSystemTime();
});

describe("quota-drift cohorting", () => {
	it("groups accounts by provider and tier, preferring the recorded tiers", () => {
		const payload = computeQuotaDrift(db, {
			now: FIXTURE_NOW,
			...TEST_BOOTSTRAP,
		});

		expect(payload.status).toBe("ready");
		expect(payload.computedAt).toBe(FIXTURE_NOW);
		expect(payload.cohorts.map((c) => c.key)).toEqual([
			COHORT_MAX,
			COHORT_ASSUMED,
			COHORT_CODEX,
		]);

		const max = payload.cohorts.find((c) => c.key === COHORT_MAX);
		expect(max?.provider).toBe("anthropic");
		expect(max?.planTier).toBe("max");
		expect(max?.rateLimitTier).toBe("20x");
		expect(max?.accountIds).toEqual([ACCOUNT_MAX_A, ACCOUNT_MAX_B].sort());
		expect(max?.tierProvenance).toBe("recorded");

		const codex = payload.cohorts.find((c) => c.key === COHORT_CODEX);
		// Codex reports no rate-limit tier. Null is the recorded value, not a gap,
		// so its presence must not downgrade the cohort to "assumed".
		expect(codex?.rateLimitTier).toBeNull();
		expect(codex?.tierProvenance).toBe("recorded");
		expect(codex?.accountIds).toEqual([ACCOUNT_CODEX]);
	});

	it("marks a cohort assumed when the tier came from today's accounts row", () => {
		const payload = computeQuotaDrift(db, {
			now: FIXTURE_NOW,
			...TEST_BOOTSTRAP,
		});

		const assumed = payload.cohorts.find((c) => c.key === COHORT_ASSUMED);
		expect(assumed?.accountIds).toEqual([ACCOUNT_ASSUMED]);
		expect(assumed?.tierProvenance).toBe("assumed");
		// The tier itself still comes through — it is the PROVENANCE that is
		// weaker, not the value.
		expect(assumed?.planTier).toBe("pro");
	});

	it("files each stretch of history under the tier recorded for it", () => {
		// Every upgraded database has this shape: old snapshots with null tier
		// columns, newer ones carrying values. Resolving ONE tier per account and
		// applying it backwards refiles the old history under a tier that was not
		// in force then, hides the assumed-tier disclosure, and turns a real
		// subscription change into a manufactured changepoint.
		seedTieredAccount(db, { recordedPlanTier: "max" });

		const cohorts = collectCohortSegments(db);
		const earlier = cohorts.find((c) => c.key === COHORT_ASSUMED);
		const later = cohorts.find((c) => c.key === COHORT_MAX);

		// The account appears in BOTH cohorts, once per tier it was sampled under.
		expect([...(earlier?.accountIds ?? [])]).toContain(ACCOUNT_TIERED);
		expect([...(later?.accountIds ?? [])]).toContain(ACCOUNT_TIERED);

		const segmentsIn = (cohort: typeof earlier) =>
			(cohort?.segmentsByWindow.get("seven_day") ?? []).filter(
				(s) => s.accountId === ACCOUNT_TIERED,
			);
		expect(segmentsIn(earlier).length).toBeGreaterThan(0);
		expect(segmentsIn(later).length).toBeGreaterThan(0);
		// The untiered half really is the earlier one, not a stray segment.
		expect(
			Math.max(...segmentsIn(earlier).map((s) => s.t1)),
		).toBeLessThanOrEqual(Math.min(...segmentsIn(later).map((s) => s.t0)));
		// The tier really did move here (pro -> max), and the segment whose own
		// span straddles the move is tagged by neither side: it is dropped, so the
		// two cohorts' segments do not overlap in time.
		expect(segmentsIn(earlier).some((s) => s.t1 > TIER_CHANGE_MS)).toBe(false);
		expect(segmentsIn(later).some((s) => s.t0 < TIER_CHANGE_MS)).toBe(false);
		// The cohort carrying inferred history has to say so; the other must not
		// be downgraded by it.
		expect(earlier?.tierProvenance).toBe("assumed");
		expect(later?.tierProvenance).toBe("recorded");
	});

	it("does not split a run when only the tier's PROVENANCE changes", () => {
		// The upgrade case that is NOT a tier change: the columns start carrying
		// values midway through a monotone run, and the value they record is the
		// one the accounts row was already supplying as the fallback. Splitting the
		// builder's input on that flip turns one physical run into two bootstrap
		// blocks, which is exactly what the single-run guard in `fitWithIntervals`
		// counts — so a coefficient measured on ONE window instance would be
		// reported with a narrow interval.
		seedTieredAccount(db, { recordedPlanTier: "pro" });

		const expected = buildSegments(
			tieredAccountSamples(),
			// No `runIdPrefix`: the compute path calls the builder once per account
			// per window, so its run ids are the builder's own.
			{ window: "seven_day", tokensFor: () => ({}) },
		);
		expect(expected.length).toBeGreaterThan(0);
		expect(new Set(expected.map((s) => s.runId)).size).toBe(1);

		const cohorts = collectCohortSegments(db);
		const actual = cohorts.flatMap((c) =>
			(c.segmentsByWindow.get("seven_day") ?? []).filter(
				(s) => s.accountId === ACCOUNT_TIERED,
			),
		);

		// Same boundaries AND the same single run as the core builder.
		expect(actual.map(boundary)).toEqual(expected.map(boundary));
		expect(new Set(actual.map((s) => s.runId)).size).toBe(1);
		// One tier throughout, so one cohort — carrying the disclosure that part of
		// its history had the tier inferred rather than recorded.
		const owning = cohorts.filter((c) => c.accountIds.has(ACCOUNT_TIERED));
		expect(owning.map((c) => c.key)).toEqual([COHORT_ASSUMED]);
		expect(owning[0].tierProvenance).toBe("assumed");
	});

	it("omits an account with no snapshots rather than zero-filling it", () => {
		const payload = computeQuotaDrift(db, {
			now: FIXTURE_NOW,
			...TEST_BOOTSTRAP,
		});

		const listed = payload.cohorts.flatMap((c) => c.accountIds);
		expect(listed).not.toContain(ACCOUNT_NO_SNAPSHOTS);
		// It shares (anthropic, max, 20x) with the two measured accounts, so a
		// zero-fill would silently widen that cohort's membership.
		const max = payload.cohorts.find((c) => c.key === COHORT_MAX);
		expect(max?.accountIds).not.toContain(ACCOUNT_NO_SNAPSHOTS);
	});

	it("reports both windows with normalized model keys", () => {
		const payload = computeQuotaDrift(db, {
			now: FIXTURE_NOW,
			...TEST_BOOTSTRAP,
		});

		const max = payload.cohorts.find((c) => c.key === COHORT_MAX);
		expect(max?.windows.map((w) => w.window)).toEqual([
			"five_hour",
			"seven_day",
		]);
		const fiveHour = max?.windows.find((w) => w.window === "five_hour");
		// The trailing release date is stripped; `claude-sonnet-5` has none.
		expect(fiveHour?.models.map((m) => m.key).sort()).toEqual([
			"claude-opus-5",
			"claude-sonnet-5",
		]);
		expect(fiveHour?.nSegments).toBeGreaterThan(0);

		const codex = payload.cohorts.find((c) => c.key === COHORT_CODEX);
		const codexFiveHour = codex?.windows.find((w) => w.window === "five_hour");
		expect(codexFiveHour?.models.map((m) => m.key)).toContain("gpt-5.6-codex");
	});

	it("reports a sub-share model as its own unmeasurable series, never as `other`", () => {
		// The pooled column has to stay in the FIT — it absorbs the sub-share tail
		// so the kept columns do not — but its membership changes as rare models
		// come and go, so a coefficient or a change verdict for it would present
		// composition change as quota drift.
		seedRareModelRequests(db);

		const payload = computeQuotaDrift(db, {
			now: FIXTURE_NOW,
			...TEST_BOOTSTRAP,
		});

		const everyModel = payload.cohorts.flatMap((c) =>
			c.windows.flatMap((w) => w.models),
		);
		expect(everyModel.length).toBeGreaterThan(0);
		expect(everyModel.map((m) => m.key)).not.toContain("other");

		// The rare model is still present as a model, with the gap the panel needs
		// rather than a number it cannot support.
		const rare = everyModel.filter((m) => m.key === RARE_MODEL_KEY);
		expect(rare.length).toBeGreaterThan(0);
		for (const model of rare) {
			expect(model.latest?.identified ?? false).toBe(false);
			expect(model.points.length).toBeGreaterThan(0);
			expect(model.points.every((p) => !p.identified)).toBe(true);
		}
	});
});

describe("quota-drift segment assembly", () => {
	it("produces exactly the core builder's segments for one account", () => {
		const cohorts = collectCohortSegments(db);
		const account = fixtureAccount(ACCOUNT_MAX_A);

		for (const window of ["five_hour", "seven_day"] as const) {
			const expected = buildSegments(fixtureWindowSamples(account, window), {
				window,
				tokensFor: () => ({}),
				// No `runIdPrefix`: the compute path calls the builder ONCE per
				// account per window over the whole history, so its run ids are the
				// builder's own. Run ids are compared, not just boundaries — they
				// are the bootstrap's resampling unit and what the identifiability
				// gate counts.
			});
			const actual = (
				cohorts
					.find((c) => c.key === COHORT_MAX)
					?.segmentsByWindow.get(window) ?? []
			).filter((s) => s.accountId === ACCOUNT_MAX_A);

			expect(actual.length).toBe(expected.length);
			expect(actual.length).toBeGreaterThan(0);
			expect(actual.map(boundary)).toEqual(expected.map(boundary));
		}
	});

	it("attributes every request's exposure to exactly one segment", () => {
		const cohorts = collectCohortSegments(db);
		const segments =
			cohorts
				.find((c) => c.key === COHORT_MAX)
				?.segmentsByWindow.get("seven_day")
				?.filter((s) => s.accountId === ACCOUNT_MAX_A) ?? [];
		expect(segments.length).toBeGreaterThan(0);

		// The weekly window is one uninterrupted run in the fixture, so it tiles
		// [firstBoundary, lastBoundary) with no gaps: every request inside that
		// span must be counted once and only once.
		const lo = segments[0].t0;
		const hi = segments[segments.length - 1].t1;
		const account = fixtureAccount(ACCOUNT_MAX_A);
		const inSpan = account.requests.filter(
			(r) => r.timestamp >= lo && r.timestamp < hi,
		);
		const expectedEq = inSpan.reduce(
			(sum, r) =>
				sum +
				r.inputTokens +
				r.cacheCreationInputTokens * 1.25 +
				r.cacheReadInputTokens * 0.1 +
				r.outputTokens * 5,
			0,
		);
		const actualEq = segments.reduce(
			(sum, s) =>
				sum + Object.values(s.eqTokensByModel).reduce((a, b) => a + b, 0),
			0,
		);
		expect(actualEq).toBeCloseTo(expectedEq, 3);
	});

	it("places a request exactly on a boundary in the LATER segment", () => {
		// [0, 100) and [100, 200): the half-open rule puts t=100 in the second.
		const segments: QuotaSegment[] = [
			{
				runId: "r",
				accountId: "a",
				t0: 0,
				t1: 100,
				dpct: 1,
				eqTokensByModel: {},
			},
			{
				runId: "r",
				accountId: "a",
				t0: 100,
				t1: 200,
				dpct: 1,
				eqTokensByModel: {},
			},
			// A separate run: 200..300 belongs to NO segment.
			{
				runId: "r2",
				accountId: "a",
				t0: 300,
				t1: 400,
				dpct: 1,
				eqTokensByModel: {},
			},
		];
		const rows = [99, 100, 250, 350].map((timestamp) => ({
			timestamp,
			model: "claude-opus-5-20260101",
			input_tokens: 1_000_000,
			output_tokens: 0,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		}));
		const lists = [segments];
		attachRequestTokens(
			{ iterate: () => rows[Symbol.iterator]() },
			{
				id: "a",
				provider: "anthropic",
				currentPlanTier: null,
				currentRateLimitTier: null,
			},
			lists,
		);

		expect(lists[0][0].eqTokensByModel).toEqual({ "claude-opus-5": 1_000_000 });
		expect(lists[0][1].eqTokensByModel).toEqual({ "claude-opus-5": 1_000_000 });
		// The row at 250 fell between runs — dropped, exactly like the Δpct that
		// was never observed for it.
		expect(lists[0][2].eqTokensByModel).toEqual({ "claude-opus-5": 1_000_000 });
	});

	it("still computes on a database predating the per-sample columns", () => {
		const legacy = new Database(":memory:");
		ensureSchema(legacy);
		seedQuotaDriftFixture(legacy);
		legacy.exec("ALTER TABLE usage_snapshots DROP COLUMN observed_at");
		legacy.exec("ALTER TABLE usage_snapshots DROP COLUMN plan_tier");
		legacy.exec("ALTER TABLE usage_snapshots DROP COLUMN rate_limit_tier");

		const payload = computeQuotaDrift(legacy, {
			now: FIXTURE_NOW,
			...TEST_BOOTSTRAP,
		});
		legacy.close();

		expect(payload.status).toBe("ready");
		expect(payload.cohorts.length).toBeGreaterThan(0);
		// With no recorded tier anywhere, EVERY cohort is inferred from today's
		// accounts row and has to say so.
		for (const cohort of payload.cohorts) {
			expect(cohort.tierProvenance).toBe("assumed");
		}
	});
});

describe("quota-drift request scan", () => {
	it("uses the account/timestamp index rather than scanning requests", () => {
		const plan = db
			.prepare<{ detail: string }, [string, number, number]>(
				`EXPLAIN QUERY PLAN ${REQUEST_SCAN_SQL}`,
			)
			.all(ACCOUNT_MAX_A, 0, FIXTURE_NOW);
		const detail = plan.map((r) => r.detail).join(" | ");

		expect(detail).toContain("idx_requests_account_timestamp");
		expect(detail).not.toContain("SCAN requests");
	});
});

describe("GET /api/analytics/quota-drift", () => {
	it("reports computing until a pass has stored a row", async () => {
		const handler = createQuotaDriftHandlerFromSources({
			getLatest: async () => null,
		});
		const body = (await (
			await handler(new URLSearchParams())
		).json()) as QuotaDriftResponse;

		expect(body).toEqual(COMPUTING_RESPONSE);
		expect(body.status).toBe("computing");
		// Null, never 0: a concrete timestamp would claim a pass that never ran.
		expect(body.computedAt).toBeNull();
		expect(body.computeMs).toBeNull();
	});

	it("serves the stored payload with the row's own computedAt", async () => {
		const payload = computeQuotaDrift(db, {
			now: FIXTURE_NOW,
			...TEST_BOOTSTRAP,
		});
		const handler = createQuotaDriftHandlerFromSources({
			getLatest: async () => ({
				computedAt: FIXTURE_NOW,
				payload: JSON.stringify(payload),
			}),
		});
		const body = (await (
			await handler(new URLSearchParams())
		).json()) as QuotaDriftResponse;

		expect(body.status).toBe("ready");
		expect(body.computedAt).toBe(FIXTURE_NOW);
		expect(body.cohorts.map((c) => c.key)).toEqual(
			payload.cohorts.map((c) => c.key),
		);
	});

	it("falls back to computing rather than 500-ing on an unreadable row", async () => {
		const handler = createQuotaDriftHandlerFromSources({
			getLatest: async () => ({
				computedAt: FIXTURE_NOW,
				payload: "{not json",
			}),
		});
		const response = await handler(new URLSearchParams());
		const body = (await response.json()) as QuotaDriftResponse;

		expect(response.status).toBe(200);
		expect(body.status).toBe("computing");
	});
});

function boundary(segment: QuotaSegment): [number, number, number, string] {
	return [segment.t0, segment.t1, segment.dpct, segment.runId];
}

/** Account whose snapshots record no tier for the first half of its history. */
const ACCOUNT_TIERED = "qd-acct-tier-change";

/** Normalized key of the trace-volume model seeded by `seedRareModelRequests`. */
const RARE_MODEL_KEY = "claude-haiku-4-5";

/**
 * A handful of tiny requests for one more model, far below the 2% share floor,
 * so the fit pools them into `other` while the model itself still exists.
 */
function seedRareModelRequests(db: Database): void {
	const account = fixtureAccount(ACCOUNT_MAX_A);
	const first = account.requests[0].timestamp;
	const last = account.requests[account.requests.length - 1].timestamp;
	const insert = db.prepare(
		`INSERT INTO requests (
			id, timestamp, method, path, account_used, status_code, success,
			response_time_ms, failover_attempts, model, total_tokens, cost_usd,
			input_tokens, cache_read_input_tokens, cache_creation_input_tokens,
			output_tokens, billing_type
		) VALUES (?, ?, 'POST', '/v1/messages', ?, 200, 1, 800, 0,
			'claude-haiku-4-5-20251001', 900, 0.0001, 900, 0, 0, 0, 'plan')`,
	);
	db.transaction(() => {
		for (let i = 0; i < 24; i++) {
			const timestamp = first + Math.round(((last - first) * i) / 24) + 1_000;
			insert.run(`${ACCOUNT_MAX_A}-rare-${i}`, timestamp, ACCOUNT_MAX_A);
		}
	})();
}

const TIERED_STEP_MS = 5 * 60_000;
/** 48h at 5-minute cadence. */
const TIERED_SAMPLES = 576;
const TIERED_START = FIXTURE_NOW - TIERED_SAMPLES * TIERED_STEP_MS;
const TIERED_RESET = FIXTURE_NOW + 3 * 24 * 60 * 60_000;
/** When {@link seedTieredAccount}'s tier columns start carrying values. */
const TIER_CHANGE_MS = TIERED_START + (TIERED_SAMPLES / 2) * TIERED_STEP_MS;

/**
 * Seed one account with 48h of weekly-window samples whose recorded tier
 * appears only halfway through: the exact shape an upgraded database has, where
 * the tier columns start carrying values at the restart that added them.
 *
 * `recordedPlanTier` picks which of the two upgrade cases this is. `"max"` is a
 * genuine tier change away from the accounts row's `pro`; `"pro"` records
 * exactly what the fallback was already supplying, so only the PROVENANCE moves
 * and the run must survive intact.
 *
 * Only the weekly window is populated. A null 5h percentage is absence of
 * evidence, so it yields no runs and no segments at all, which keeps the
 * fixture to the one axis under test. The percentage rises monotonically at a
 * constant rate with a fixed reset, so the whole history is ONE run.
 */
function seedTieredAccount(
	db: Database,
	opts: { recordedPlanTier: "max" | "pro" },
): void {
	db.run(
		`INSERT INTO accounts (id, name, provider, created_at,
			identity_plan_tier, identity_rate_limit_tier)
		 VALUES (?, ?, 'anthropic', ?, 'pro', NULL)`,
		[ACCOUNT_TIERED, ACCOUNT_TIERED, TIERED_START],
	);
	const insert = db.prepare(
		`INSERT INTO usage_snapshots (
			account_id, provider, sampled_at, five_hour_pct, five_hour_reset,
			seven_day_pct, seven_day_reset, observed_at, plan_tier, rate_limit_tier
		) VALUES (?, 'anthropic', ?, NULL, NULL, ?, ?, ?, ?, ?)`,
	);
	const rateLimitTier = opts.recordedPlanTier === "max" ? "20x" : null;
	db.transaction(() => {
		for (let i = 0; i < TIERED_SAMPLES; i++) {
			const sampledAt = TIERED_START + i * TIERED_STEP_MS;
			// The tier columns only start carrying values at the halfway point.
			const recorded = sampledAt >= TIER_CHANGE_MS;
			insert.run(
				ACCOUNT_TIERED,
				sampledAt,
				(i * 100) / TIERED_SAMPLES,
				TIERED_RESET,
				sampledAt,
				recorded ? opts.recordedPlanTier : null,
				recorded ? rateLimitTier : null,
			);
		}
	})();
}

/** The weekly-window samples {@link seedTieredAccount} writes, as the builder sees them. */
function tieredAccountSamples(): WindowSample[] {
	return Array.from({ length: TIERED_SAMPLES }, (_, i) => ({
		accountId: ACCOUNT_TIERED,
		sampledAt: TIERED_START + i * TIERED_STEP_MS,
		pct: (i * 100) / TIERED_SAMPLES,
		resetAt: TIERED_RESET,
	}));
}
