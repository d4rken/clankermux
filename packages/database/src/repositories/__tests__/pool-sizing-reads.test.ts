/**
 * The four reads behind `GET /api/analytics/pool-sizing`.
 *
 * They exist to hand the pure computation grouped rows it could not derive
 * from a bucketed chart read: peaks per reported reset (with the values at the
 * edges of each group), raw sampling presence, per-tick 5-hour saturation, and
 * the individual refusal rows. Everything asserted here is a property the
 * computation depends on and SQL alone decides.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Force @clankermux/core to initialise before @clankermux/types resolves its
// circular dependency. Same pattern as account-payment.repository.test.ts.
import "@clankermux/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { RequestRepository } from "../request.repository";
import { UsageScopedSnapshotRepository } from "../usage-scoped-snapshot.repository";
import { UsageSnapshotRepository } from "../usage-snapshot.repository";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SINCE = Date.UTC(2026, 7, 1);
const RESET = Date.UTC(2026, 7, 23, 7);

let db: Database;
let usage: UsageSnapshotRepository;
let scoped: UsageScopedSnapshotRepository;
let requests: RequestRepository;

beforeEach(() => {
	db = new Database(":memory:");
	ensureSchema(db);
	const adapter = new BunSqlAdapter(db);
	usage = new UsageSnapshotRepository(adapter);
	scoped = new UsageScopedSnapshotRepository(adapter);
	requests = new RequestRepository(adapter);
});

afterEach(() => {
	db.close();
});

describe("UsageSnapshotRepository.getResetPeakRows", () => {
	it("groups by reported reset and reports the peak with both edge values", async () => {
		await usage.insertSnapshots([
			{
				accountId: "a1",
				provider: "anthropic",
				sampledAt: RESET - 3 * DAY,
				sevenDayPct: 10,
				sevenDayReset: RESET,
			},
			{
				accountId: "a1",
				provider: "anthropic",
				sampledAt: RESET - 2 * DAY,
				sevenDayPct: 96,
				sevenDayReset: RESET,
			},
			{
				accountId: "a1",
				provider: "anthropic",
				sampledAt: RESET - DAY,
				sevenDayPct: 80,
				sevenDayReset: RESET,
			},
		]);

		const rows = await usage.getResetPeakRows(SINCE);
		expect(rows).toEqual([
			{
				accountId: "a1",
				resetAt: RESET,
				peakPct: 96,
				sampleCount: 3,
				firstSampledAt: RESET - 3 * DAY,
				lastSampledAt: RESET - DAY,
				// Edge values, not aggregates: the merge rule compares where one
				// group ended with where the next began.
				firstPct: 10,
				lastPct: 80,
				planTier: null,
				rateLimitTier: null,
			},
		]);
	});

	it("keeps one-second reset jitter as separate groups for the caller to cluster", async () => {
		await usage.insertSnapshots([
			{
				accountId: "a1",
				provider: "anthropic",
				sampledAt: RESET - 2 * DAY,
				sevenDayPct: 50,
				sevenDayReset: RESET - 1_000,
			},
			{
				accountId: "a1",
				provider: "anthropic",
				sampledAt: RESET - DAY,
				sevenDayPct: 60,
				sevenDayReset: RESET,
			},
		]);

		const rows = await usage.getResetPeakRows(SINCE);
		expect(rows.map((row) => row.resetAt).sort()).toEqual([
			RESET - 1_000,
			RESET,
		]);
	});

	it("splits a group when the captured tier changes mid-window", async () => {
		await usage.insertSnapshots([
			{
				accountId: "a1",
				provider: "anthropic",
				sampledAt: RESET - 3 * DAY,
				sevenDayPct: 20,
				sevenDayReset: RESET,
			},
			{
				accountId: "a1",
				provider: "anthropic",
				sampledAt: RESET - DAY,
				sevenDayPct: 70,
				sevenDayReset: RESET,
				planTier: "max",
				rateLimitTier: "20x",
			},
		]);

		const rows = await usage.getResetPeakRows(SINCE);
		expect(rows).toHaveLength(2);
		expect(rows.map((row) => row.planTier).sort()).toEqual([
			"max",
			null,
		] as unknown as string[]);
		// Both halves report the same window edges, so collapsing them cannot
		// invent a second window out of an identity-capture boundary.
		for (const row of rows) {
			expect(row.firstPct).toBe(20);
			expect(row.lastPct).toBe(70);
		}
	});

	it("excludes rows with no reported reset and rows before the cutoff", async () => {
		await usage.insertSnapshots([
			{
				accountId: "a1",
				provider: "anthropic",
				sampledAt: RESET - DAY,
				sevenDayPct: 40,
				sevenDayReset: null,
			},
			{
				accountId: "a1",
				provider: "anthropic",
				sampledAt: SINCE - DAY,
				sevenDayPct: 40,
				sevenDayReset: SINCE + DAY,
			},
		]);

		expect(await usage.getResetPeakRows(SINCE)).toEqual([]);
	});
});

describe("UsageSnapshotRepository.getDailyPresence", () => {
	it("reports exact first and last sample times per account and day", async () => {
		const day = Date.UTC(2026, 7, 10);
		// Every sample reports the weekly window, which is what presence means:
		// the last one at 0 % is a placeholder window and still counts.
		await usage.insertSnapshots([
			{
				accountId: "a1",
				provider: "anthropic",
				sampledAt: day + HOUR,
				sevenDayPct: 10,
				sevenDayReset: RESET,
			},
			{
				accountId: "a1",
				provider: "anthropic",
				sampledAt: day + 20 * HOUR,
				sevenDayPct: 20,
				sevenDayReset: RESET,
			},
			{
				accountId: "a1",
				provider: "anthropic",
				sampledAt: day + DAY + HOUR,
				sevenDayPct: 0,
				sevenDayReset: RESET,
			},
		]);

		const rows = await usage.getDailyPresence(SINCE);
		expect(rows).toEqual([
			{
				accountId: "a1",
				firstSampledAt: day + HOUR,
				lastSampledAt: day + 20 * HOUR,
			},
			{
				accountId: "a1",
				firstSampledAt: day + DAY + HOUR,
				lastSampledAt: day + DAY + HOUR,
			},
		]);
	});
});

describe("UsageSnapshotRepository.getFiveHourSpentTicks", () => {
	it("counts spent accounts per tick and provider", async () => {
		const tick = Date.UTC(2026, 7, 10, 12);
		await usage.insertSnapshots([
			{
				accountId: "a1",
				provider: "anthropic",
				sampledAt: tick,
				fiveHourPct: 100,
			},
			{
				accountId: "a2",
				provider: "anthropic",
				sampledAt: tick,
				fiveHourPct: 100,
			},
			{ accountId: "c1", provider: "codex", sampledAt: tick, fiveHourPct: 100 },
			// Not spent, and a spent account one tick later: neither joins the
			// simultaneity count of this tick.
			{
				accountId: "a3",
				provider: "anthropic",
				sampledAt: tick,
				fiveHourPct: 99,
			},
			{
				accountId: "a1",
				provider: "anthropic",
				sampledAt: tick + HOUR,
				fiveHourPct: 100,
			},
		]);

		const rows = await usage.getFiveHourSpentTicks(SINCE);
		expect(rows).toEqual([
			{ sampledAt: tick, provider: "anthropic", spent: 2 },
			{ sampledAt: tick, provider: "codex", spent: 1 },
			{ sampledAt: tick + HOUR, provider: "anthropic", spent: 1 },
		]);
	});
});

describe("UsageScopedSnapshotRepository", () => {
	it("groups scoped peaks per family and display name", async () => {
		await scoped.insertSnapshots([
			{
				accountId: "a1",
				sampledAt: RESET - 2 * DAY,
				family: "fable",
				displayName: "Fable",
				pct: 30,
				resetAt: RESET,
			},
			{
				accountId: "a1",
				sampledAt: RESET - DAY,
				family: "fable",
				displayName: "Fable",
				pct: 70,
				resetAt: RESET,
			},
			{
				accountId: "a1",
				sampledAt: RESET - DAY,
				family: "fable",
				displayName: "Mythos",
				pct: 40,
				resetAt: RESET,
			},
		]);

		const rows = await scoped.getResetPeakRows(SINCE);
		expect(rows).toEqual([
			{
				accountId: "a1",
				family: "fable",
				displayName: "Fable",
				resetAt: RESET,
				peakPct: 70,
				sampleCount: 2,
				firstSampledAt: RESET - 2 * DAY,
				lastSampledAt: RESET - DAY,
				firstPct: 30,
				lastPct: 70,
			},
			{
				accountId: "a1",
				family: "fable",
				displayName: "Mythos",
				resetAt: RESET,
				peakPct: 40,
				sampleCount: 1,
				firstSampledAt: RESET - DAY,
				lastSampledAt: RESET - DAY,
				firstPct: 40,
				lastPct: 40,
			},
		]);
	});

	it("reports scoped presence per account, family and day", async () => {
		const day = Date.UTC(2026, 7, 10);
		// 0 % under a reported reset is a family that was watched and consumed
		// nothing, which is presence; a null reset would be a blind spot.
		await scoped.insertSnapshots([
			{
				accountId: "a1",
				sampledAt: day + HOUR,
				family: "fable",
				displayName: "Fable",
				pct: 0,
				resetAt: RESET,
			},
			{
				accountId: "a1",
				sampledAt: day + 5 * HOUR,
				family: "fable",
				displayName: "Fable",
				pct: 0,
				resetAt: RESET,
			},
		]);

		expect(await scoped.getDailyPresence(SINCE)).toEqual([
			{
				accountId: "a1",
				family: "fable",
				firstSampledAt: day + HOUR,
				lastSampledAt: day + 5 * HOUR,
			},
		]);
	});
});

describe("RequestRepository.getStopRows", () => {
	function insertStop(
		id: string,
		label: string | null,
		requestedModel: string | null,
		model: string | null,
		timestamp: number,
		success = 0,
	): void {
		db.run(
			`INSERT INTO requests
				(id, timestamp, method, path, account_used, status_code, success,
				 error_message, response_time_ms, failover_attempts, model, requested_model)
			 VALUES (?, ?, 'POST', '/v1/messages', NULL, 429, ?, ?, 10, 0, ?, ?)`,
			[id, timestamp, success, label, model, requestedModel],
		);
	}

	it("returns the requested model, falling back to the served one", async () => {
		insertStop("s1", "pool_exhausted", "claude-sonnet-4-5", "claude-x", RESET);
		insertStop("s2", "pool_exhausted", null, "gpt-5.6", RESET + MINUTE);

		const rows = await requests.getStopRows(SINCE, ["pool_exhausted"]);
		expect(rows).toEqual([
			{ label: "pool_exhausted", model: "claude-sonnet-4-5", timestamp: RESET },
			{ label: "pool_exhausted", model: "gpt-5.6", timestamp: RESET + MINUTE },
		]);
	});

	it("ignores other labels, successful rows and rows before the cutoff", async () => {
		insertStop("s1", "upstream_error", "claude-sonnet-4-5", null, RESET);
		insertStop("s2", "pool_exhausted", "claude-sonnet-4-5", null, RESET, 1);
		insertStop("s3", "pool_exhausted", "claude-sonnet-4-5", null, SINCE - DAY);

		expect(
			await requests.getStopRows(SINCE, [
				"pool_exhausted",
				"all_accounts_failed",
			]),
		).toEqual([]);
	});

	it("short-circuits an empty label list", async () => {
		insertStop("s1", "pool_exhausted", "claude-sonnet-4-5", null, RESET);
		expect(await requests.getStopRows(SINCE, [])).toEqual([]);
	});
});

describe("pool-sizing reset-peak reads: query plan", () => {
	/**
	 * Captures the SQL a repository sends without changing what it runs, so the
	 * plan is taken from the statement the production code actually executes
	 * rather than from a copy that could drift away from it.
	 */
	class RecordingAdapter extends BunSqlAdapter {
		readonly sent: Array<{ sql: string; params: unknown[] }> = [];

		override async query<R>(sql: string, params: unknown[] = []): Promise<R[]> {
			this.sent.push({ sql, params });
			return super.query<R>(sql, params);
		}
	}

	async function planFor(
		call: (adapter: BunSqlAdapter) => Promise<unknown>,
	): Promise<string[]> {
		const recorder = new RecordingAdapter(db);
		await call(recorder);
		const sent = recorder.sent[0];
		if (!sent) throw new Error("the repository sent no query");
		const plan = db
			.query(`EXPLAIN QUERY PLAN ${sent.sql}`)
			.all(...(sent.params as Array<string | number | null>)) as Array<{
			detail: string;
		}>;
		return plan.map((step) => step.detail);
	}

	it("reads the account-wide edge values without a correlated scalar subquery", async () => {
		const details = await planFor((adapter) =>
			new UsageSnapshotRepository(adapter).getResetPeakRows(SINCE),
		);
		expect(
			details.filter((detail) => detail.includes("CORRELATED SCALAR SUBQUERY")),
		).toEqual([]);
	});

	it("reads the scoped edge values without a correlated scalar subquery", async () => {
		const details = await planFor((adapter) =>
			new UsageScopedSnapshotRepository(adapter).getResetPeakRows(SINCE),
		);
		expect(
			details.filter((detail) => detail.includes("CORRELATED SCALAR SUBQUERY")),
		).toEqual([]);
	});
});

describe("pool-sizing presence: samples that carry no weekly window", () => {
	const day = Date.UTC(2026, 7, 12);

	it("omits an account whose weekly reset was never reported", async () => {
		await usage.insertSnapshots([
			{
				accountId: "no-weekly",
				provider: "codex",
				sampledAt: day + HOUR,
				fiveHourPct: 40,
				sevenDayPct: null,
				sevenDayReset: null,
			},
			{
				accountId: "no-weekly",
				provider: "codex",
				sampledAt: day + 6 * HOUR,
				fiveHourPct: 55,
				sevenDayPct: null,
				sevenDayReset: null,
			},
		]);

		const rows = await usage.getDailyPresence(SINCE);
		expect(rows.filter((row) => row.accountId === "no-weekly")).toEqual([]);
	});

	it("omits a scoped family whose reset and percentage were never reported", async () => {
		await scoped.insertSnapshots([
			{
				accountId: "a1",
				sampledAt: day + HOUR,
				family: "fable",
				displayName: "Fable",
				pct: null,
				resetAt: null,
			},
			{
				accountId: "a1",
				sampledAt: day + 6 * HOUR,
				family: "fable",
				displayName: "Fable",
				pct: null,
				resetAt: null,
			},
		]);

		expect(await scoped.getDailyPresence(SINCE)).toEqual([]);
	});
});
