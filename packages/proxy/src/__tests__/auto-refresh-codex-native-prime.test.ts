/**
 * Tests for CODEX scheduled priming routed through the CodexSpendCoordinator
 * (Step 3 of the codex-unify refactor).
 *
 * A codex account that is due for a scheduled prime must NOT go through the
 * translated Claude-Haiku `/v1/messages` dummy dispatch (sendTranslatedClaudePrime →
 * dispatchProxyRequest). Instead the scheduler asks the injected
 * CodexSpendCoordinator to `observe(id, "scheduled-prime")`, which owns the
 * native `/responses` ping and ALL codex side-effects (usageCache, credits
 * carry-forward, window-roll, rate_limit_reset persistence, and the 429
 * cooldown). The scheduler only interprets the coordinator's result:
 *
 *   - skipped   → not a failure (auto-refresh off / deleted / no tokens /
 *                 last-moment suppression); log + return.
 *   - failed    → recordRefreshFailure.
 *   - completed + responseOk  → prime success: update lastRefreshResetTime from
 *                 observation.earliestResetMs, clear the failure counter, and run
 *                 the same overage-resume the old translated path did.
 *   - completed + !responseOk → recordRefreshFailure. The scheduler MUST NOT
 *                 re-apply the cooldown / re-write rate_limited_until — the
 *                 coordinator/applicator already did.
 *
 * Non-codex (anthropic/zai) accounts still use the translated sendTranslatedClaudePrime
 * path and never touch the coordinator.
 *
 * Test hygiene: the coordinator is injected as a FAKE object (a plain object with
 * an `observe` spy) via the scheduler constructor — NO `mock.module`, which bun
 * keeps global for the whole run and would leak into sibling test files. The
 * private surface (primeAccount / consecutiveFailures / lastRefreshResetTime) is
 * reached via cast. usageCache is the real singleton, seeded + cleaned per test.
 */
import { afterEach, describe, expect, it, mock } from "bun:test";
import type { CodexCreditsInfo, UsageData } from "@clankermux/providers";
import { usageCache } from "@clankermux/providers";
import type { AutoRefreshScheduler } from "../auto-refresh-scheduler";
import type { CodexSpendResult } from "../codex-spend-coordinator";
import type { CodexObservationResult } from "../handlers/codex-observation";

// ── row shape ──────────────────────────────────────────────────────────────
type Row = {
	id: string;
	name: string;
	provider: string;
	refresh_token: string;
	access_token: string | null;
	expires_at: number | null;
	rate_limit_reset: number | null;
	custom_endpoint: string | null;
	paused: number;
	auto_pause_on_overage_enabled: number;
	pause_reason: string | null;
};

function makeRow(overrides: Partial<Row> = {}): Row {
	return {
		id: "codex-1",
		name: "codex-backup",
		provider: "codex",
		refresh_token: "rt",
		access_token: "at",
		expires_at: null,
		rate_limit_reset: null,
		custom_endpoint: null,
		paused: 0,
		auto_pause_on_overage_enabled: 0,
		pause_reason: null,
		...overrides,
	};
}

// ── canned coordinator results ───────────────────────────────────────────────
function makeObservation(
	overrides: Partial<CodexObservationResult> = {},
): CodexObservationResult {
	return {
		usage: null,
		effectiveCredits: null,
		earliestResetMs: null,
		windowRolledOver: false,
		isRateLimited: false,
		responseStatus: 200,
		...overrides,
	};
}

function completed(
	responseOk: boolean,
	responseStatus: number,
	observation: CodexObservationResult = makeObservation({ responseStatus }),
): CodexSpendResult {
	return {
		status: "completed",
		responseOk,
		responseStatus,
		accountName: "codex-backup",
		observation,
	};
}

// ── fakes ────────────────────────────────────────────────────────────────────
function makeCoordinator(result: CodexSpendResult) {
	return {
		observe: mock(async (_id: string, _cause: string) => result),
	};
}

/**
 * Mock db. `query` drives the anthropic sendTranslatedClaudePrime race-guard re-read;
 * `run`/`runWithChanges` are spied so we can assert the codex path does NOT
 * re-apply cooldown/reset and only issues the overage-resume UPDATE when told.
 */
function makeDb(recheckRows: Array<{ auto_refresh_enabled: number }> = []) {
	const runCalls: Array<{ sql: string; params: unknown[] }> = [];
	const queryCalls: Array<{ sql: string; params: unknown[] }> = [];
	return {
		run: mock(async (sql: string, params: unknown[]) => {
			runCalls.push({ sql, params });
		}),
		runWithChanges: mock(async (sql: string, params: unknown[]) => {
			runCalls.push({ sql, params });
			return 1;
		}),
		query: mock(async (sql: string, params: unknown[]) => {
			queryCalls.push({ sql, params });
			return recheckRows;
		}),
		runCalls,
		queryCalls,
	};
}

function makeProxyContext() {
	return {
		runtime: { port: 8080, clientId: "test-client" },
		refreshInFlight: new Map(),
	};
}

type SchedulerInternals = AutoRefreshScheduler & {
	primeAccount(row: Row): Promise<void>;
	sendTranslatedClaudePrime(row: Row): Promise<boolean>;
	consecutiveFailures: Map<string, number>;
	lastRefreshResetTime: Map<string, number>;
};

async function makeScheduler(
	db: ReturnType<typeof makeDb>,
	coordinator: ReturnType<typeof makeCoordinator>,
): Promise<SchedulerInternals> {
	const { AutoRefreshScheduler } = await import("../auto-refresh-scheduler");
	return new AutoRefreshScheduler(
		db as never,
		makeProxyContext() as never,
		coordinator as never,
	) as never as SchedulerInternals;
}

// ── usageCache seeding (drives shouldResumeFromOverage for codex) ─────────────
const seededIds = new Set<string>();
afterEach(() => {
	for (const id of seededIds) usageCache.delete(id);
	seededIds.clear();
});

function seedCredits(
	accountId: string,
	credits: CodexCreditsInfo | null,
): void {
	seededIds.add(accountId);
	usageCache.set(accountId, {
		five_hour: { utilization: 0, resets_at: null },
		seven_day: { utilization: 100, resets_at: null },
		codexCredits: credits,
	} as unknown as UsageData);
}

function onCredits(weeklyUsedPct: number): CodexCreditsInfo {
	return {
		hasCredits: true,
		balance: 12.5,
		unlimited: false,
		planType: "plus",
		weeklyUsedPct,
	};
}

// ── tests ────────────────────────────────────────────────────────────────────
describe("AutoRefreshScheduler — codex native prime via coordinator", () => {
	it("routes a codex prime through coordinator.observe(id, 'scheduled-prime') exactly once and never touches the translated db path", async () => {
		const db = makeDb();
		const coordinator = makeCoordinator(completed(true, 200));
		const scheduler = await makeScheduler(db, coordinator);

		await scheduler.primeAccount(makeRow({ id: "codex-1" }));

		expect(coordinator.observe).toHaveBeenCalledTimes(1);
		expect(coordinator.observe.mock.calls[0]).toEqual([
			"codex-1",
			"scheduled-prime",
		]);
		// The translated sendTranslatedClaudePrime path ALWAYS issues the race-guard
		// `SELECT auto_refresh_enabled` query first; the codex path never queries.
		expect(db.query).not.toHaveBeenCalled();
	});

	it("treats a 'skipped' result as a non-failure (no failure counter, no pause, no failure record)", async () => {
		const db = makeDb();
		const coordinator = makeCoordinator({
			status: "skipped",
			reason: "auto-refresh disabled",
		});
		const scheduler = await makeScheduler(db, coordinator);

		await scheduler.primeAccount(makeRow({ id: "codex-skip" }));

		expect(coordinator.observe).toHaveBeenCalledTimes(1);
		expect(scheduler.consecutiveFailures.get("codex-skip")).toBeUndefined();
		// No recordRefreshFailure → no runWithChanges pause write.
		expect(db.runWithChanges).not.toHaveBeenCalled();
		// Not paused/resumed either.
		expect(db.run).not.toHaveBeenCalled();
	});

	it("treats a 'failed' result as a refresh failure (recordRefreshFailure)", async () => {
		const db = makeDb();
		const coordinator = makeCoordinator({
			status: "failed",
			message: "token refresh threw",
		});
		const scheduler = await makeScheduler(db, coordinator);

		await scheduler.primeAccount(makeRow({ id: "codex-fail" }));

		expect(scheduler.consecutiveFailures.get("codex-fail")).toBe(1);
	});

	it("completed + responseOk=false (429) records a failure and does NOT set rate_limited_until (coordinator owns cooldown)", async () => {
		const db = makeDb();
		const coordinator = makeCoordinator(completed(false, 429));
		const scheduler = await makeScheduler(db, coordinator);

		await scheduler.primeAccount(makeRow({ id: "codex-429" }));

		expect(scheduler.consecutiveFailures.get("codex-429")).toBe(1);
		// The scheduler must NOT re-write rate_limited_until / rate_limit_reset for
		// codex — the applicator already handled the cooldown.
		const cooldownWrite = db.runCalls.find(
			(c) =>
				c.sql.includes("rate_limited_until") ||
				c.sql.includes("rate_limit_reset"),
		);
		expect(cooldownWrite).toBeUndefined();
	});

	it("completed + responseOk=true + earliestResetMs updates lastRefreshResetTime and clears the failure counter", async () => {
		const db = makeDb();
		const resetMs = Date.now() + 3 * 60 * 60 * 1000;
		const coordinator = makeCoordinator(
			completed(true, 200, makeObservation({ earliestResetMs: resetMs })),
		);
		const scheduler = await makeScheduler(db, coordinator);
		// Pre-seed a stale failure count to prove success clears it.
		scheduler.consecutiveFailures.set("codex-ok", 3);

		await scheduler.primeAccount(makeRow({ id: "codex-ok" }));

		expect(scheduler.lastRefreshResetTime.get("codex-ok")).toBe(resetMs);
		expect(scheduler.consecutiveFailures.get("codex-ok")).toBeUndefined();
	});

	it("completed + responseOk=true with null usage is still a success (no failure recorded, no reset update)", async () => {
		const db = makeDb();
		const coordinator = makeCoordinator(
			completed(
				true,
				200,
				makeObservation({ usage: null, earliestResetMs: null }),
			),
		);
		const scheduler = await makeScheduler(db, coordinator);

		await scheduler.primeAccount(makeRow({ id: "codex-nullusage" }));

		expect(
			scheduler.consecutiveFailures.get("codex-nullusage"),
		).toBeUndefined();
		expect(db.runWithChanges).not.toHaveBeenCalled();
		// No reset time present → lastRefreshResetTime untouched.
		expect(
			scheduler.lastRefreshResetTime.get("codex-nullusage"),
		).toBeUndefined();
	});

	it("overage-resume: resumes an overage-paused codex account when shouldResumeFromOverage is true (no longer on credits)", async () => {
		const db = makeDb();
		// Below the weekly limit → isCodexOnCredits false → resume allowed.
		seedCredits("codex-resume", onCredits(42));
		const coordinator = makeCoordinator(completed(true, 200));
		const scheduler = await makeScheduler(db, coordinator);

		await scheduler.primeAccount(
			makeRow({
				id: "codex-resume",
				paused: 1,
				auto_pause_on_overage_enabled: 1,
				pause_reason: "overage",
			}),
		);

		const resumeWrite = db.runCalls.find(
			(c) =>
				c.sql.includes("paused = 0") &&
				(c.params as unknown[])[0] === "codex-resume",
		);
		expect(resumeWrite).toBeDefined();
	});

	it("overage-resume: leaves an overage-paused codex account paused when still on credits (shouldResumeFromOverage false)", async () => {
		const db = makeDb();
		// Past the weekly limit → isCodexOnCredits true → resume blocked.
		seedCredits("codex-stillcredits", onCredits(100));
		const coordinator = makeCoordinator(completed(true, 200));
		const scheduler = await makeScheduler(db, coordinator);

		await scheduler.primeAccount(
			makeRow({
				id: "codex-stillcredits",
				paused: 1,
				auto_pause_on_overage_enabled: 1,
				pause_reason: "overage",
			}),
		);

		const resumeWrite = db.runCalls.find((c) => c.sql.includes("paused = 0"));
		expect(resumeWrite).toBeUndefined();
	});

	it("an ANTHROPIC account still uses the translated sendTranslatedClaudePrime path and never calls the coordinator", async () => {
		// Race-guard re-read returns 0 so sendTranslatedClaudePrime short-circuits BEFORE any
		// real dispatch — we only need to prove the translated path was entered
		// (it issues the race-guard query) and the coordinator was not consulted.
		const db = makeDb([{ auto_refresh_enabled: 0 }]);
		const coordinator = makeCoordinator(completed(true, 200));
		const scheduler = await makeScheduler(db, coordinator);

		await scheduler.primeAccount(
			makeRow({ id: "anthropic-1", provider: "anthropic" }),
		);

		// Coordinator untouched for a non-codex account.
		expect(coordinator.observe).not.toHaveBeenCalled();
		// Translated path entered → race-guard SELECT issued for this account.
		const recheck = db.queryCalls.find((c) =>
			c.sql.includes("auto_refresh_enabled"),
		);
		expect(recheck).toBeDefined();
		expect(recheck?.params).toEqual(["anthropic-1"]);
	});

	it("GUARD: sendTranslatedClaudePrime refuses a codex row — returns false, never issues the race-guard SELECT (so it can never reach dispatchProxyRequest), never calls the coordinator", async () => {
		// Defensive guard: primeAccount routes codex to the coordinator, so a codex
		// row reaching the translated path is a programming error. Call the
		// translated path DIRECTLY (bypassing primeAccount) to prove the guard trips
		// at the very top: it returns false BEFORE the race-guard SELECT (which is
		// the last thing that precedes any dispatchProxyRequest), so no db.query is
		// issued and no dispatch can occur. A translated Haiku /v1/messages request
		// would mistranslate for codex AND still burn real quota, so this must never
		// happen.
		const db = makeDb();
		const coordinator = makeCoordinator(completed(true, 200));
		const scheduler = await makeScheduler(db, coordinator);

		const result = await scheduler.sendTranslatedClaudePrime(
			makeRow({ id: "codex-guard", provider: "codex" }),
		);

		expect(result).toBe(false);
		// No race-guard SELECT issued → dispatchProxyRequest was never reached.
		expect(db.query).not.toHaveBeenCalled();
		// The coordinator is a different path entirely; this direct call must not
		// consult it either.
		expect(coordinator.observe).not.toHaveBeenCalled();
	});
});
