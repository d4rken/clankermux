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
	collectWindowObservations,
	computeQuotaDrift,
	REQUEST_SCAN_SQL,
	summarizeFlatWindow,
	type WindowObservation,
} from "../quota-drift-compute";
import {
	COMPUTING_RESPONSE,
	createQuotaDriftHandlerFromSources,
	normalizeQuotaDriftPayload,
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

/* -- Models with no exposure left --------------------------------------- */

const RETIRED_ACCOUNT = "qd-acct-retired";
/** Sampler cadence the retired-model fixture imitates. */
const RETIRED_STEP_MS = 10 * 60_000;
const RETIRED_MAIN_MODEL = "gpt-5.6-codex";
const RETIRED_MODEL = "gpt-5.1-codex-mini";

/**
 * A database where one model ran for the first third of the history and then
 * stopped, while another kept running throughout.
 *
 * The LATEST rolling window is the point: it contains zero eq-tokens for the
 * retired model, so `selectKeys` gives it no column and the latest fit has no
 * coefficient for it at all. 30 days of history is enough for the 14-day
 * rolling window to have moved entirely past the retired model's traffic.
 */
function seedRetiredModel(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	const count = Math.floor((30 * 24 * 60 * 60_000) / RETIRED_STEP_MS);
	const startMs = FIXTURE_NOW - count * RETIRED_STEP_MS;
	const retiredUntilMs = startMs + 10 * 24 * 60 * 60_000;
	const fiveHourMs = 5 * 60 * 60_000;

	db.run(
		`INSERT INTO accounts (id, name, provider, created_at,
			identity_plan_tier, identity_rate_limit_tier)
		 VALUES (?, ?, 'codex', ?, 'pro', NULL)`,
		[RETIRED_ACCOUNT, RETIRED_ACCOUNT, startMs - 24 * 60 * 60_000],
	);
	const insertSnapshot = db.prepare(
		`INSERT INTO usage_snapshots (
			account_id, provider, sampled_at, five_hour_pct, five_hour_reset,
			seven_day_pct, seven_day_reset, observed_at, plan_tier, rate_limit_tier
		) VALUES (?, 'codex', ?, ?, ?, NULL, NULL, ?, 'pro', NULL)`,
	);
	const insertRequest = db.prepare(
		`INSERT INTO requests (
			id, timestamp, method, path, account_used, status_code, success,
			response_time_ms, failover_attempts, model, total_tokens, cost_usd,
			input_tokens, cache_read_input_tokens, cache_creation_input_tokens,
			output_tokens, billing_type
		) VALUES (?, ?, 'POST', '/v1/responses', ?, 200, 1, 800, 0,
			?, ?, 0.4, ?, 0, 0, 0, 'plan')`,
	);

	let pct = 0;
	let currentWindow = Math.floor(startMs / fiveHourMs);
	db.transaction(() => {
		for (let i = 0; i < count; i++) {
			const t = startMs + i * RETIRED_STEP_MS;
			const windowIndex = Math.floor(t / fiveHourMs);
			if (windowIndex !== currentWindow) {
				currentWindow = windowIndex;
				pct = 0;
			}
			const mainEq = 200_000;
			const retiredEq = t < retiredUntilMs ? 150_000 : 0;
			pct = Math.min(100, pct + ((mainEq + retiredEq) / 1e6) * 2);
			insertSnapshot.run(
				RETIRED_ACCOUNT,
				t,
				pct,
				Math.ceil((t + 1) / fiveHourMs) * fiveHourMs,
				t,
			);
			insertRequest.run(
				`${RETIRED_ACCOUNT}-m${i}`,
				t + 60_000,
				RETIRED_ACCOUNT,
				RETIRED_MAIN_MODEL,
				mainEq,
				mainEq,
			);
			if (retiredEq > 0) {
				insertRequest.run(
					`${RETIRED_ACCOUNT}-r${i}`,
					t + 90_000,
					RETIRED_ACCOUNT,
					RETIRED_MODEL,
					retiredEq,
					retiredEq,
				);
			}
		}
	})();
	return db;
}

describe("quota-drift models with no exposure left", () => {
	it("states the reason on `latest` instead of leaving it null", () => {
		// A model with zero exposure in the latest window gets no column, so there
		// is no coefficient to report. Returning null made the cost table fall
		// back to "not enough independent traffic" while the chart's gap list said
		// "not in use" about the same model — one tab, two answers, and the wrong
		// one is the measurement claim.
		const retiredDb = seedRetiredModel();
		const payload = computeQuotaDrift(retiredDb, {
			now: FIXTURE_NOW,
			...TEST_BOOTSTRAP,
		});
		retiredDb.close();

		const window = payload.cohorts
			.find((c) => c.provider === "codex")
			?.windows.find((w) => w.window === "five_hour");
		const retired = window?.models.find((m) => m.key === RETIRED_MODEL);
		const running = window?.models.find((m) => m.key === RETIRED_MAIN_MODEL);

		expect(retired).toBeDefined();
		// The series still covers it, which is what the gap list reads.
		expect(retired?.points.length).toBeGreaterThan(1);
		expect(retired?.points.at(-1)?.unidentifiedReasons).toContain(
			"no-exposure",
		);

		expect(retired?.latest).not.toBeNull();
		expect(retired?.latest?.identified).toBe(false);
		expect(retired?.latest?.unidentifiedReasons).toContain("no-exposure");
		// Never a number: the entry says why there is none, it does not supply a
		// small one.
		expect(retired?.latest?.pointEstimate).toBeNull();
		expect(retired?.latest?.ciLow).toBeNull();
		expect(retired?.latest?.ciHigh).toBeNull();
		expect(retired?.latest?.impliedCapacityMtok).toBeNull();
		// Zero exposure really is zero share — a counted ratio, not an estimate.
		expect(retired?.latest?.shareOfWindow).toBe(0);

		// The model still running is unaffected and keeps a real share.
		expect(running?.latest?.shareOfWindow).toBeGreaterThan(0.9);
	});
});

/* -- Windows that never moved ------------------------------------------- */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** Sampler cadence the flat fixtures imitate - inside MAX_SAMPLE_GAP_MS (15m). */
const FLAT_STEP_MS = 10 * MINUTE_MS;
const FLAT_ACCOUNT = "qd-acct-flat";

interface FlatFixture {
	/** Days of continuous samples ending at FIXTURE_NOW. */
	days: number;
	/** The constant percentage reported throughout. */
	pct: number;
	/** Whether requests were charged against the window in that period. */
	withTraffic: boolean;
	/** Blank out this many samples in the middle of the run. */
	nullSamples?: number;
	/**
	 * Blank out this many samples at the END of the run.
	 *
	 * The rows are still written: the sampler kept polling, and the account is
	 * still alive - its readings just stopped carrying a value for this window.
	 */
	nullTailSamples?: number;
	/** Skip this many samples in the middle, producing a sampling gap. */
	skipSamples?: number;
	/** End the samples this long before FIXTURE_NOW (a stalled sampler). */
	staleForMs?: number;
	accountId?: string;
}

/**
 * A database holding ONE account whose 5-hour window never moves.
 *
 * The 7-day percentage is left null throughout: a null yields no runs and so no
 * segments at all, which keeps each fixture to the single axis under test.
 * `five_hour_reset` is null too, matching what the provider reports for the
 * window this case came from, so no rollover splits the run.
 */
function seedFlatWindow(opts: FlatFixture): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	const accountId = opts.accountId ?? FLAT_ACCOUNT;
	const endMs = FIXTURE_NOW - (opts.staleForMs ?? 0);
	const count = Math.floor((opts.days * DAY_MS) / FLAT_STEP_MS);
	const startMs = endMs - count * FLAT_STEP_MS;

	db.run(
		`INSERT INTO accounts (id, name, provider, created_at,
			identity_plan_tier, identity_rate_limit_tier)
		 VALUES (?, ?, 'codex', ?, 'pro', NULL)`,
		[accountId, accountId, startMs - DAY_MS],
	);
	const insertSnapshot = db.prepare(
		`INSERT INTO usage_snapshots (
			account_id, provider, sampled_at, five_hour_pct, five_hour_reset,
			seven_day_pct, seven_day_reset, observed_at, plan_tier, rate_limit_tier
		) VALUES (?, 'codex', ?, ?, NULL, NULL, NULL, ?, 'pro', NULL)`,
	);
	const insertRequest = db.prepare(
		`INSERT INTO requests (
			id, timestamp, method, path, account_used, status_code, success,
			response_time_ms, failover_attempts, model, total_tokens, cost_usd,
			input_tokens, cache_read_input_tokens, cache_creation_input_tokens,
			output_tokens, billing_type
		) VALUES (?, ?, 'POST', '/v1/responses', ?, 200, 1, 800, 0,
			'gpt-5.6-codex', 400000, 0.4, 400000, 0, 0, 0, 'plan')`,
	);
	// The middle of the run, where a null or a gap is planted.
	const breakAt = Math.floor(count / 2);
	db.transaction(() => {
		for (let i = 0; i < count; i++) {
			const sampledAt = startMs + i * FLAT_STEP_MS;
			if (opts.skipSamples && i >= breakAt && i < breakAt + opts.skipSamples) {
				continue;
			}
			const blanked =
				(opts.nullSamples != null &&
					i >= breakAt &&
					i < breakAt + opts.nullSamples) ||
				(opts.nullTailSamples != null && i >= count - opts.nullTailSamples);
			insertSnapshot.run(
				accountId,
				sampledAt,
				blanked ? null : opts.pct,
				sampledAt,
			);
			// 400k eq-tokens per request, one every 24 samples: material usage
			// throughout, without seeding a request per sample.
			if (opts.withTraffic && i % 24 === 0) {
				insertRequest.run(`${accountId}-r${i}`, sampledAt + 60_000, accountId);
			}
		}
	})();
	return db;
}

/** The 5-hour window of the only cohort a flat fixture produces. */
function flatWindowOf(db: Database) {
	const payload = computeQuotaDrift(db, {
		now: FIXTURE_NOW,
		...TEST_BOOTSTRAP,
	});
	const cohort = payload.cohorts.find((c) => c.provider === "codex");
	return cohort?.windows.find((w) => w.window === "five_hour");
}

describe("quota-drift flat windows", () => {
	it("reports a window flat for 43 days while traffic was being sent", () => {
		// The motivating case: the provider's 5-hour window has reported the same
		// value for six weeks while the sampler kept reading it every few minutes.
		const db = seedFlatWindow({ days: 43, pct: 0, withTraffic: true });
		const window = flatWindowOf(db);
		db.close();

		expect(window).toBeDefined();
		expect(window?.flatSince).not.toBeNull();
		expect(window?.flatValuePct).toBe(0);
		// The only account is both sampled and reporting, so the claim really does
		// cover the whole cohort.
		expect(window?.flatScope).toBe("all-accounts");
		// It never moved inside the observed span, which is not the same as
		// "moved long ago" and must not be reported as a timestamp.
		expect(window?.lastMovementMs).toBeNull();
		expect(FIXTURE_NOW - (window?.lastObservedMs ?? 0)).toBeLessThanOrEqual(
			FLAT_STEP_MS,
		);
		expect(FIXTURE_NOW - (window?.flatSince ?? 0)).toBeGreaterThan(42 * DAY_MS);
	});

	it("says nothing about a window that has only been flat for three days", () => {
		// Below the 5-hour window's 7-day threshold. Three quiet days is an
		// ordinary weekend, not a provider fact.
		const db = seedFlatWindow({ days: 3, pct: 0, withTraffic: true });
		const window = flatWindowOf(db);
		db.close();

		expect(window?.flatSince).toBeNull();
		// The observation itself is still reported - only the CLAIM is withheld.
		expect(window?.lastObservedMs).not.toBeNull();
	});

	it("withdraws the claim once the only account stops reporting the window", () => {
		// Same 43 flat days, but the readings stopped carrying a 5-hour value ~34
		// hours ago while the sampler kept polling. Nothing currently reporting
		// the window is left to establish that it is still flat, so the claim goes
		// - it does not quietly survive on stale readings.
		const db = seedFlatWindow({
			days: 43,
			pct: 0,
			withTraffic: true,
			nullTailSamples: 200,
		});
		const window = flatWindowOf(db);
		db.close();

		expect(window?.flatSince).toBeNull();
		expect(window?.flatScope).toBeNull();
		// What WAS seen is still reported, including how old it is.
		expect(window?.lastObservedMs).not.toBeNull();
		expect(FIXTURE_NOW - (window?.lastObservedMs ?? 0)).toBeGreaterThan(
			24 * 60 * MINUTE_MS,
		);
	});

	it("says nothing when the window was flat because we sent nothing", () => {
		// THE case this gate exists for. A window that did not move because no
		// traffic was charged against it is a fact about us, not the provider,
		// and the percentage series alone cannot tell the two apart.
		const db = seedFlatWindow({ days: 43, pct: 0, withTraffic: false });
		const window = flatWindowOf(db);
		db.close();

		expect(window?.flatSince).toBeNull();
	});
});

/* -- Windows our readings no longer include ------------------------------ */

/**
 * One account whose readings carry a 5-hour value and then stop carrying one.
 *
 * The sibling weekly window keeps reporting throughout unless a case says
 * otherwise, because that is what separates "this window is absent from the
 * payload" from "the sampler fetched nothing": a reading with neither window
 * is not evidence about which windows a reading contains.
 */
interface AbsentFixture {
	/** Days of readings that DID carry a 5-hour value. */
	reportedDays: number;
	/** Hours of readings that did not, following those. */
	absentHours: number;
	/**
	 * Time between the last reading with a value and the first without.
	 *
	 * THE gate that dates the transition: past MAX_SAMPLE_GAP_MS we were not
	 * watching when the value went absent and cannot say when it did.
	 * Defaults to one sampler step.
	 */
	boundaryGapMs?: number;
	/** Drop this many readings from the middle of the absent run. */
	tailGapSamples?: number;
	/** Blank the sibling window across the absent run too. */
	siblingAbsent?: boolean;
	/** Readings at the very end that carry a value again. */
	resumedSamples?: number;
	/** End this account's readings this long before FIXTURE_NOW. */
	staleForMs?: number;
	/** Never let this account's readings stop carrying the value. */
	neverAbsent?: boolean;
	accountId?: string;
}

/** The weekly percentage the sibling window reports throughout. */
const SIBLING_PCT = 19;

interface AbsentRow {
	at: number;
	pct: number | null;
	sibling: number | null;
}

/** The readings one `AbsentFixture` account produces, oldest first. */
function absentRows(opts: AbsentFixture): AbsentRow[] {
	const reportedCount = Math.round((opts.reportedDays * DAY_MS) / FLAT_STEP_MS);
	const absentCount = opts.neverAbsent
		? 0
		: Math.round((opts.absentHours * 60 * MINUTE_MS) / FLAT_STEP_MS);
	const rows: AbsentRow[] = [];
	let at = 0;
	for (let i = 0; i < reportedCount; i++) {
		rows.push({ at, pct: 0, sibling: SIBLING_PCT });
		at += FLAT_STEP_MS;
	}
	// The boundary is measured from the LAST reading that carried a value, so
	// the first absent reading is placed relative to it rather than to the grid.
	at = rows[rows.length - 1].at + (opts.boundaryGapMs ?? FLAT_STEP_MS);
	const gapAt = Math.floor(absentCount / 2);
	for (let i = 0; i < absentCount; i++) {
		// The demand-aware poller backing off while the proxy is idle. Ordinary
		// operation, and irrelevant to whether a reading included the value.
		if (opts.tailGapSamples && i >= gapAt && i < gapAt + opts.tailGapSamples) {
			at += FLAT_STEP_MS;
			continue;
		}
		rows.push({
			at,
			pct: null,
			sibling: opts.siblingAbsent ? null : SIBLING_PCT,
		});
		at += FLAT_STEP_MS;
	}
	for (let i = 0; i < (opts.resumedSamples ?? 0); i++) {
		rows.push({ at, pct: 0, sibling: SIBLING_PCT });
		at += FLAT_STEP_MS;
	}
	// Shift the whole series so its newest reading lands where the case wants it.
	const shift = FIXTURE_NOW - (opts.staleForMs ?? 0) - rows[rows.length - 1].at;
	return rows.map((row) => ({ ...row, at: row.at + shift }));
}

/** Seed one such account into an open database. */
function seedAbsentAccount(db: Database, opts: AbsentFixture): AbsentRow[] {
	const accountId = opts.accountId ?? FLAT_ACCOUNT;
	const rows = absentRows(opts);
	db.run(
		`INSERT INTO accounts (id, name, provider, created_at,
			identity_plan_tier, identity_rate_limit_tier)
		 VALUES (?, ?, 'codex', ?, 'pro', NULL)`,
		[accountId, accountId, rows[0].at - DAY_MS],
	);
	const insertSnapshot = db.prepare(
		`INSERT INTO usage_snapshots (
			account_id, provider, sampled_at, five_hour_pct, five_hour_reset,
			seven_day_pct, seven_day_reset, observed_at, plan_tier, rate_limit_tier
		) VALUES (?, 'codex', ?, ?, NULL, ?, NULL, ?, 'pro', NULL)`,
	);
	db.transaction(() => {
		for (const row of rows) {
			insertSnapshot.run(accountId, row.at, row.pct, row.sibling, row.at);
		}
	})();
	return rows;
}

/** The first reading that did not carry a 5-hour value. */
function firstAbsentMs(rows: readonly AbsentRow[]): number {
	const row = rows.find((r) => r.pct === null);
	expect(row).toBeDefined();
	return row?.at ?? 0;
}

describe("quota-drift windows that stopped being reported", () => {
	function absentWindowOf(opts: AbsentFixture) {
		const db = new Database(":memory:");
		ensureSchema(db);
		const rows = seedAbsentAccount(db, opts);
		const window = flatWindowOf(db);
		db.close();
		return { window, rows };
	}

	it("dates the absence from the first reading without a value", () => {
		// The live shape: a run of readings that carried a 5-hour value, a
		// two-minute boundary we watched it disappear across, then three days of
		// readings that did not, with the weekly window reporting throughout.
		const { window, rows } = absentWindowOf({
			reportedDays: 3,
			absentHours: 30,
			boundaryGapMs: 2 * MINUTE_MS,
		});

		expect(window?.notReportedSince).toBe(firstAbsentMs(rows));
		expect(window?.notReportedScope).toBe("all-accounts");
		// The last reading that DID carry one is a different instant, and still
		// reported separately.
		expect(window?.lastObservedMs).toBeLessThan(window?.notReportedSince ?? 0);
	});

	it("refuses to date a transition it did not watch", () => {
		// Nothing was read across the boundary, so the value may have gone absent
		// at any point inside it. A date we cannot support is worse than silence.
		const { window } = absentWindowOf({
			reportedDays: 3,
			absentHours: 30,
			boundaryGapMs: 45 * MINUTE_MS,
		});

		expect(window?.notReportedSince).toBeNull();
		expect(window?.notReportedScope).toBeNull();
	});

	it("says nothing until the absence has held for a day", () => {
		// These fields are expected on every poll, so a few hours without one is
		// still inside what a single bad response explains.
		const { window } = absentWindowOf({
			reportedDays: 3,
			absentHours: 12,
			boundaryGapMs: 2 * MINUTE_MS,
		});

		expect(window?.notReportedSince).toBeNull();
	});

	it("says nothing when the sibling window went absent too", () => {
		// A reading carrying NEITHER window is a sampler that fetched nothing.
		// Reporting that as a window dropping out of the payload would attribute
		// our own failure to the provider.
		const { window } = absentWindowOf({
			reportedDays: 3,
			absentHours: 30,
			boundaryGapMs: 2 * MINUTE_MS,
			siblingAbsent: true,
		});

		expect(window?.notReportedSince).toBeNull();
	});

	it("still reports it across wide gaps INSIDE the absent run", () => {
		// The resolved case, and the one most likely to be "fixed" into
		// continuity: 11 hours unobserved in the middle of the run. A reading
		// never taken cannot have included a value, so unobserved time cannot
		// falsify this claim - unlike a flat streak, which it can.
		const { window, rows } = absentWindowOf({
			reportedDays: 3,
			absentHours: 30,
			boundaryGapMs: 2 * MINUTE_MS,
			tailGapSamples: 66,
		});

		expect(window?.notReportedSince).toBe(firstAbsentMs(rows));
		expect(window?.notReportedScope).toBe("all-accounts");
	});

	it("clears as soon as a reading carries the value again", () => {
		// The claim is about a period that was observed, not a state that
		// continues: a transient omission has to stop being reported.
		const { window } = absentWindowOf({
			reportedDays: 3,
			absentHours: 30,
			boundaryGapMs: 2 * MINUTE_MS,
			resumedSamples: 3,
		});

		expect(window?.notReportedSince).toBeNull();
		expect(window?.notReportedScope).toBeNull();
	});

	it("says nothing when nobody has been sampled since yesterday", () => {
		// A cohort whose newest reading is two days old cannot testify to what
		// today's readings contain, however long its last known absence ran.
		const { window } = absentWindowOf({
			reportedDays: 3,
			absentHours: 30,
			boundaryGapMs: 2 * MINUTE_MS,
			staleForMs: 2 * DAY_MS,
		});

		expect(window?.notReportedSince).toBeNull();
	});

	it("calls a partial rollout what it is", () => {
		// One account's readings stopped carrying the window and another's did
		// not. Stating that cohort-wide would claim something none of the
		// readings support.
		const db = new Database(":memory:");
		ensureSchema(db);
		const rows = seedAbsentAccount(db, {
			accountId: "qd-acct-absent",
			reportedDays: 3,
			absentHours: 30,
			boundaryGapMs: 2 * MINUTE_MS,
		});
		seedAbsentAccount(db, {
			accountId: "qd-acct-reporting",
			reportedDays: 3,
			absentHours: 30,
			neverAbsent: true,
		});
		const window = flatWindowOf(db);
		db.close();

		expect(window?.notReportedSince).toBe(firstAbsentMs(rows));
		expect(window?.notReportedScope).toBe("reporting-subset");
	});

	it("never says the others still report when their absence is just young", () => {
		// THE false statement this partition exists for. Both accounts stopped
		// carrying the window; one 30 hours ago, one 12. Only the first clears the
		// day-long threshold, so only it produces an onset - and reading "not in
		// the onsets" as "still reporting" put a sentence on the panel saying the
		// second account still reports a window whose newest readings are null.
		const db = new Database(":memory:");
		ensureSchema(db);
		const rows = seedAbsentAccount(db, {
			accountId: "qd-acct-absent-30h",
			reportedDays: 3,
			absentHours: 30,
			boundaryGapMs: 2 * MINUTE_MS,
		});
		seedAbsentAccount(db, {
			accountId: "qd-acct-absent-12h",
			reportedDays: 3,
			absentHours: 12,
			boundaryGapMs: 2 * MINUTE_MS,
		});
		const window = flatWindowOf(db);
		db.close();

		// The established absence is still reported, dated from the account it
		// was established on.
		expect(window?.notReportedSince).toBe(firstAbsentMs(rows));
		// Neither cohort-wide (the 12-hour absence is not established) nor a
		// reporting subset (nothing in this cohort is currently reporting).
		expect(window?.notReportedScope).toBe("partial-cohort");
	});
});

describe("collectWindowObservations", () => {
	const account = {
		id: FLAT_ACCOUNT,
		provider: "codex",
		currentPlanTier: "pro",
		currentRateLimitTier: null,
	};

	function observationsFor(opts: FlatFixture): WindowObservation {
		const db = seedFlatWindow(opts);
		const rows = db
			.prepare<
				{
					sampled_at: number;
					observed_at: number | null;
					five_hour_pct: number | null;
					five_hour_reset: number | null;
					seven_day_pct: number | null;
					seven_day_reset: number | null;
					plan_tier: string | null;
					rate_limit_tier: string | null;
				},
				[]
			>(
				`SELECT sampled_at, observed_at, five_hour_pct, five_hour_reset,
				        seven_day_pct, seven_day_reset, plan_tier, rate_limit_tier
				 FROM usage_snapshots ORDER BY sampled_at`,
			)
			.all();
		db.close();
		const byCohort = collectWindowObservations(account, rows, "five_hour");
		const observation = [...byCohort.values()][0];
		expect(observation).toBeDefined();
		return observation;
	}

	it("breaks the flat streak at a null sample rather than bridging it", () => {
		// Absence of evidence is never a flat line: the readings either side of a
		// blank may be hours apart in meaning.
		const observation = observationsFor({
			days: 43,
			pct: 0,
			withTraffic: true,
			nullSamples: 3,
		});

		// The streak restarts halfway, so it covers ~21 days rather than 43.
		expect(observation.lastObservedMs - observation.flatStartMs).toBeLessThan(
			22 * DAY_MS,
		);
		expect(observation.flatStartMs).toBeGreaterThan(
			observation.firstObservedMs,
		);
	});

	it("breaks the flat streak at a sampling gap rather than bridging it", () => {
		// Two hours unobserved: the window may have moved and come back, and
		// nothing here can rule that out.
		const observation = observationsFor({
			days: 43,
			pct: 0,
			withTraffic: true,
			skipSamples: 12,
		});

		expect(observation.lastObservedMs - observation.flatStartMs).toBeLessThan(
			22 * DAY_MS,
		);
	});

	it("keeps counting a snapshot whose value for THIS window is null", () => {
		// The sampler is still polling and the row is still written; the reading
		// just no longer carries this window. That is account activity, and losing
		// it is what let a live account be silently dropped from a cohort claim.
		const observation = observationsFor({
			days: 43,
			pct: 0,
			withTraffic: true,
			// ~34 hours of null values at the end of an otherwise unbroken run.
			nullTailSamples: 200,
		});

		expect(observation.lastSampleMs).toBeGreaterThan(
			observation.lastObservedMs,
		);
		expect(FIXTURE_NOW - observation.lastSampleMs).toBeLessThanOrEqual(
			FLAT_STEP_MS,
		);
		expect(FIXTURE_NOW - observation.lastObservedMs).toBeGreaterThan(
			24 * 60 * MINUTE_MS,
		);
	});

	it("surfaces a stalled sampler as an old last observation", () => {
		// A window that has not moved because nobody has looked at it for 30 days
		// is not a provider fact. The percentage series cannot tell the two apart,
		// so the panel is handed the date and has to disclose it.
		const observation = observationsFor({
			days: 43,
			pct: 0,
			withTraffic: true,
			staleForMs: 30 * DAY_MS,
		});

		expect(FIXTURE_NOW - observation.lastObservedMs).toBeGreaterThan(
			29 * DAY_MS,
		);
	});
});

describe("summarizeFlatWindow", () => {
	const FLAT_START = FIXTURE_NOW - 40 * DAY_MS;

	function observation(
		over: Partial<WindowObservation> & { accountId: string },
	): WindowObservation {
		const lastObservedMs = over.lastObservedMs ?? FIXTURE_NOW;
		return {
			firstObservedMs: FIXTURE_NOW - 60 * DAY_MS,
			lastObservedMs,
			// An account reporting normally is sampled and observed at the same
			// instant; the cases where the two diverge set this explicitly.
			lastSampleMs: over.lastSampleMs ?? lastObservedMs,
			// The invariant the walk maintains: the newest reading carried a value
			// exactly when the newest sample IS the newest observation. Cases that
			// separate the two are describing an account whose latest readings no
			// longer include the window.
			latestIncludesWindow:
				(over.lastSampleMs ?? lastObservedMs) === lastObservedMs,
			lastMovementMs: null,
			flatStartMs: FLAT_START,
			flatValuePct: 0,
			// Still carrying the window; the absence cases set this explicitly.
			notReportingSinceMs: null,
			...over,
		};
	}

	/** One segment carrying enough exposure to clear the traffic gate. */
	function traffic(accountId: string, t0: number): QuotaSegment {
		return {
			runId: `${accountId}:1`,
			accountId,
			t0,
			t1: t0 + 60 * MINUTE_MS,
			dpct: 0,
			eqTokensByModel: { "gpt-5.6-codex": 5_000_000 },
		};
	}

	it("is not flat when one account in the cohort is still moving", () => {
		// One account still seeing the window move settles it: the window is not
		// frozen, whatever the rest report.
		const facts = summarizeFlatWindow(
			[
				observation({ accountId: "a" }),
				observation({
					accountId: "b",
					lastMovementMs: FIXTURE_NOW - 2 * DAY_MS,
					flatStartMs: FIXTURE_NOW - 2 * DAY_MS,
					flatValuePct: 12,
				}),
			],
			"five_hour",
			[traffic("a", FLAT_START), traffic("b", FLAT_START)],
			FIXTURE_NOW,
		);

		expect(facts.flatSince).toBeNull();
		expect(facts.flatValuePct).toBeNull();
		// The movement itself is still reported.
		expect(facts.lastMovementMs).toBe(FIXTURE_NOW - 2 * DAY_MS);
	});

	it("names no value when the accounts are constant at different ones", () => {
		// Each account is flat, so the cohort is flat - but there is no single
		// number to name, and inventing one would be a fabrication.
		const facts = summarizeFlatWindow(
			[
				observation({ accountId: "a", flatValuePct: 0 }),
				observation({ accountId: "b", flatValuePct: 43 }),
			],
			"five_hour",
			[traffic("a", FLAT_START), traffic("b", FLAT_START)],
			FIXTURE_NOW,
		);

		expect(facts.flatSince).toBe(FLAT_START);
		expect(facts.flatValuePct).toBeNull();
	});

	it("agrees on a value the whole cohort reports", () => {
		const facts = summarizeFlatWindow(
			[
				observation({ accountId: "a" }),
				observation({ accountId: "b", flatStartMs: FLAT_START + DAY_MS }),
			],
			"five_hour",
			[traffic("a", FLAT_START), traffic("b", FLAT_START + DAY_MS)],
			FIXTURE_NOW,
		);

		// The cohort has only been uniformly flat since its LAST member went flat.
		expect(facts.flatSince).toBe(FLAT_START + DAY_MS);
		expect(facts.flatValuePct).toBe(0);
	});

	it("holds the weekly window to two reset cycles, not one week", () => {
		// A weekly percentage legitimately sits still far longer than a 5-hour one.
		const eightDaysFlat = [
			observation({ accountId: "a", flatStartMs: FIXTURE_NOW - 8 * DAY_MS }),
		];
		const segments = [traffic("a", FIXTURE_NOW - 8 * DAY_MS)];

		expect(
			summarizeFlatWindow(eightDaysFlat, "five_hour", segments, FIXTURE_NOW)
				.flatSince,
		).not.toBeNull();
		expect(
			summarizeFlatWindow(eightDaysFlat, "seven_day", segments, FIXTURE_NOW)
				.flatSince,
		).toBeNull();
	});

	it("reports nothing at all when the window was never observed", () => {
		expect(summarizeFlatWindow([], "five_hour", [], FIXTURE_NOW)).toEqual({
			lastMovementMs: null,
			lastObservedMs: null,
			flatValuePct: null,
			flatSince: null,
			flatScope: null,
			notReportedSince: null,
			notReportedScope: null,
		});
	});

	it("marks a whole-cohort claim as covering every account", () => {
		const facts = summarizeFlatWindow(
			[observation({ accountId: "a" }), observation({ accountId: "b" })],
			"five_hour",
			[traffic("a", FLAT_START), traffic("b", FLAT_START)],
			FIXTURE_NOW,
		);

		expect(facts.flatSince).toBe(FLAT_START);
		expect(facts.flatScope).toBe("all-accounts");
	});

	it("qualifies the claim when a live account stopped reporting the window", () => {
		// THE defect this partition exists for. Account b is still being sampled
		// - its weekly readings are fresh - but its 5-hour value has been null for
		// 25 hours. Judged on the TARGET window's freshness it vanishes from the
		// decision, and account a alone produces an unqualified cohort claim for a
		// cohort that is actually mixed.
		const facts = summarizeFlatWindow(
			[
				observation({ accountId: "a" }),
				observation({
					accountId: "b",
					lastObservedMs: FIXTURE_NOW - 25 * 60 * MINUTE_MS,
					lastSampleMs: FIXTURE_NOW,
				}),
			],
			"five_hour",
			[traffic("a", FLAT_START), traffic("b", FLAT_START)],
			FIXTURE_NOW,
		);

		expect(facts.flatSince).not.toBeNull();
		expect(facts.flatScope).toBe("reporting-subset");
	});

	it("drops an account whose latest reading is null, however fresh it is", () => {
		// Flat membership is CURRENT PRESENCE, not target-value freshness. Account
		// b stopped carrying the window two hours ago, well inside any age bound,
		// and has nothing to say about what the window currently shows. Counting
		// it would put an unqualified "every account" on a cohort where one member
		// is not reporting at all.
		const facts = summarizeFlatWindow(
			[
				observation({ accountId: "a" }),
				observation({
					accountId: "b",
					lastObservedMs: FIXTURE_NOW - 2 * 60 * MINUTE_MS,
					lastSampleMs: FIXTURE_NOW,
				}),
			],
			"five_hour",
			[traffic("a", FLAT_START), traffic("b", FLAT_START)],
			FIXTURE_NOW,
		);

		expect(facts.flatSince).not.toBeNull();
		expect(facts.flatScope).toBe("reporting-subset");
	});

	it("separates an established absence from a young one in the scope", () => {
		// Maturity is not presence. Account b's absence is 30 hours old and
		// datable, account c's is two hours old; both are absent NOW. The claim
		// covers b, and the scope must not imply that c still reports the window.
		const facts = summarizeFlatWindow(
			[
				observation({ accountId: "a" }),
				observation({
					accountId: "b",
					lastObservedMs: FIXTURE_NOW - 30 * 60 * MINUTE_MS,
					lastSampleMs: FIXTURE_NOW,
					notReportingSinceMs: FIXTURE_NOW - 30 * 60 * MINUTE_MS,
				}),
				observation({
					accountId: "c",
					lastObservedMs: FIXTURE_NOW - 2 * 60 * MINUTE_MS,
					lastSampleMs: FIXTURE_NOW,
					notReportingSinceMs: FIXTURE_NOW - 2 * 60 * MINUTE_MS,
				}),
			],
			"five_hour",
			[traffic("a", FLAT_START)],
			FIXTURE_NOW,
		);

		expect(facts.notReportedSince).toBe(FIXTURE_NOW - 30 * 60 * MINUTE_MS);
		expect(facts.notReportedScope).toBe("partial-cohort");
	});

	it("says the others still report only when every one of them does", () => {
		// The narrow case the `reporting-subset` wording is actually true for:
		// one established absence, and every other active account carrying the
		// window in its newest reading.
		const facts = summarizeFlatWindow(
			[
				observation({ accountId: "a" }),
				observation({
					accountId: "b",
					lastObservedMs: FIXTURE_NOW - 30 * 60 * MINUTE_MS,
					lastSampleMs: FIXTURE_NOW,
					notReportingSinceMs: FIXTURE_NOW - 30 * 60 * MINUTE_MS,
				}),
			],
			"five_hour",
			[traffic("a", FLAT_START)],
			FIXTURE_NOW,
		);

		expect(facts.notReportedScope).toBe("reporting-subset");
	});

	it("never says every account when one was excluded from the decision", () => {
		// The differing-value branch is where a dropped member does real damage:
		// its wording claims the cohort agreed, so the panel would state a
		// cohort-wide provider fact established on a subset.
		const facts = summarizeFlatWindow(
			[
				observation({ accountId: "a", flatValuePct: 0 }),
				observation({ accountId: "b", flatValuePct: 43 }),
				observation({
					accountId: "c",
					lastObservedMs: FIXTURE_NOW - 30 * 60 * MINUTE_MS,
					lastSampleMs: FIXTURE_NOW,
				}),
			],
			"five_hour",
			[
				traffic("a", FLAT_START),
				traffic("b", FLAT_START),
				traffic("c", FLAT_START),
			],
			FIXTURE_NOW,
		);

		expect(facts.flatValuePct).toBeNull();
		expect(facts.flatScope).toBe("reporting-subset");
	});

	it("still drops an account that stopped being sampled altogether", () => {
		// Not the same case: this account produces NO readings at all, so it
		// cannot testify either way and its absence does not qualify anything.
		const facts = summarizeFlatWindow(
			[
				observation({ accountId: "a" }),
				observation({
					accountId: "gone",
					lastObservedMs: FIXTURE_NOW - 30 * DAY_MS,
					lastSampleMs: FIXTURE_NOW - 30 * DAY_MS,
				}),
			],
			"five_hour",
			[traffic("a", FLAT_START)],
			FIXTURE_NOW,
		);

		expect(facts.flatSince).toBe(FLAT_START);
		expect(facts.flatScope).toBe("all-accounts");
	});

	it("says nothing at all when NO active account still reports the window", () => {
		const facts = summarizeFlatWindow(
			[
				observation({
					accountId: "a",
					lastObservedMs: FIXTURE_NOW - 3 * DAY_MS,
					lastSampleMs: FIXTURE_NOW,
				}),
			],
			"five_hour",
			[traffic("a", FLAT_START)],
			FIXTURE_NOW,
		);

		expect(facts.flatSince).toBeNull();
		expect(facts.flatScope).toBeNull();
		// The observation itself is still reported.
		expect(facts.lastObservedMs).toBe(FIXTURE_NOW - 3 * DAY_MS);
	});

	it("is still not flat when a reporting account is moving, whatever the scope", () => {
		// No qualification rescues a moving account: the window is not frozen.
		const facts = summarizeFlatWindow(
			[
				observation({ accountId: "a" }),
				observation({
					accountId: "b",
					lastMovementMs: FIXTURE_NOW - 2 * DAY_MS,
					flatStartMs: FIXTURE_NOW - 2 * DAY_MS,
					flatValuePct: 12,
				}),
				observation({
					accountId: "c",
					lastObservedMs: FIXTURE_NOW - 25 * 60 * MINUTE_MS,
					lastSampleMs: FIXTURE_NOW,
				}),
			],
			"five_hour",
			[traffic("a", FLAT_START), traffic("b", FLAT_START)],
			FIXTURE_NOW,
		);

		expect(facts.flatSince).toBeNull();
		expect(facts.flatScope).toBeNull();
	});
});

/* -- Payloads written before these fields existed ------------------------ */

/**
 * The payload shape a PREVIOUS version of the precompute stored: no per-point
 * reasons, no movement facts on any window.
 *
 * Not hypothetical, and not a migration concern that resolves itself at deploy
 * time: the pass refreshes every 30 minutes and the blob is handed out without
 * schema validation, so this is exactly what the endpoint serves for the first
 * half hour after any deploy.
 */
function stripNewFields(payload: QuotaDriftResponse): QuotaDriftResponse {
	const clone = JSON.parse(JSON.stringify(payload)) as QuotaDriftResponse;
	for (const cohort of clone.cohorts) {
		for (const window of cohort.windows) {
			const legacy = window as unknown as Record<string, unknown>;
			legacy.lastMovementMs = undefined;
			legacy.lastObservedMs = undefined;
			legacy.flatValuePct = undefined;
			legacy.flatSince = undefined;
			legacy.flatScope = undefined;
			for (const model of window.models) {
				for (const point of model.points) {
					(point as unknown as Record<string, unknown>).unidentifiedReasons =
						undefined;
				}
			}
		}
	}
	// A JSON round-trip drops the undefined keys, which is what a payload
	// written before the fields existed actually looks like.
	return JSON.parse(JSON.stringify(clone)) as QuotaDriftResponse;
}

describe("quota-drift payload normalization", () => {
	it("defaults every field a pre-change payload is missing", () => {
		const legacy = stripNewFields(
			computeQuotaDrift(db, { now: FIXTURE_NOW, ...TEST_BOOTSTRAP }),
		);
		// The fixture really is missing them, or the test proves nothing.
		const legacyWindow = legacy.cohorts[0].windows[0];
		expect("flatSince" in legacyWindow).toBe(false);
		expect("unidentifiedReasons" in legacyWindow.models[0].points[0]).toBe(
			false,
		);

		const normalized = normalizeQuotaDriftPayload(legacy);

		expect(normalized.cohorts.length).toBeGreaterThan(0);
		for (const cohort of normalized.cohorts) {
			for (const window of cohort.windows) {
				// Null, never 0: a concrete timestamp would claim a measurement the
				// payload does not contain.
				expect(window.flatSince).toBeNull();
				expect(window.flatScope).toBeNull();
				expect(window.lastMovementMs).toBeNull();
				expect(window.lastObservedMs).toBeNull();
				expect(window.flatValuePct).toBeNull();
				for (const model of window.models) {
					expect(model.points.length).toBeGreaterThan(0);
					for (const point of model.points) {
						expect(point.unidentifiedReasons).toEqual([]);
					}
				}
			}
		}
	});

	it("leaves a current payload's values alone", () => {
		const payload = computeQuotaDrift(db, {
			now: FIXTURE_NOW,
			...TEST_BOOTSTRAP,
		});

		expect(normalizeQuotaDriftPayload(payload)).toEqual(payload);
	});

	it("serves a pre-change cached row without inventing anything", async () => {
		const legacy = stripNewFields(
			computeQuotaDrift(db, { now: FIXTURE_NOW, ...TEST_BOOTSTRAP }),
		);
		const handler = createQuotaDriftHandlerFromSources({
			getLatest: async () => ({
				computedAt: FIXTURE_NOW,
				payload: JSON.stringify(legacy),
			}),
		});

		const body = (await (
			await handler(new URLSearchParams())
		).json()) as QuotaDriftResponse;

		expect(body.status).toBe("ready");
		const window = body.cohorts[0].windows[0];
		expect(window.flatSince).toBeNull();
		expect(window.models[0].points[0].unidentifiedReasons).toEqual([]);
	});

	it("survives a payload whose arrays are missing entirely", async () => {
		// A hand-inserted or half-written row. It must not throw the panel's
		// request into a 500.
		const handler = createQuotaDriftHandlerFromSources({
			getLatest: async () => ({
				computedAt: FIXTURE_NOW,
				payload: JSON.stringify({ status: "ready", computedAt: FIXTURE_NOW }),
			}),
		});

		const response = await handler(new URLSearchParams());
		const body = (await response.json()) as QuotaDriftResponse;

		expect(response.status).toBe(200);
		expect(body.cohorts).toEqual([]);
	});
});
