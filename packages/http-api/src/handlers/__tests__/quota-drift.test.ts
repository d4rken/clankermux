/**
 * Quota-drift precompute and endpoint.
 *
 * The claims under test are the ones the compute path can get wrong on its own;
 * everything statistical is already pinned by the core module's synthetic tests
 * and is deliberately NOT re-asserted here.
 *
 *  1. Cohorting: accounts group by (provider, plan tier, rate-limit tier), the
 *     per-sample tiers win over today's accounts row, and ONE assumed member
 *     marks the whole cohort assumed.
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
import { buildSegments, type QuotaSegment } from "@clankermux/core";
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
});

describe("quota-drift segment assembly", () => {
	it("produces exactly the core builder's segments for one account", () => {
		const cohorts = collectCohortSegments(db);
		const account = fixtureAccount(ACCOUNT_MAX_A);

		for (const window of ["five_hour", "seven_day"] as const) {
			const expected = buildSegments(fixtureWindowSamples(account, window), {
				window,
				tokensFor: () => ({}),
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
