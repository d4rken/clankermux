import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "@clankermux/database";
import { getProvider, type UsageData, usageCache } from "@clankermux/providers";
import { makeAccount } from "@clankermux/test-support";
import type { CodexRateLimitResetCreditConsumeResult } from "@clankermux/types";
import { getCodexObservationEpoch } from "../codex-observation-fence";
import { CodexSpendCoordinator } from "../codex-spend-coordinator";
import {
	applyCodexObservation,
	clearCodexUsagePersistMemo,
} from "../handlers/codex-observation";
import type { ProxyContext } from "../handlers/proxy-types";
import { processProxyResponse } from "../handlers/response-processor";

const ids: string[] = [];
afterEach(() => {
	for (const id of ids.splice(0)) usageCache.delete(id);
	clearCodexUsagePersistMemo();
});

function harness(
	result: CodexRateLimitResetCreditConsumeResult | Error = {
		outcome: "reset",
		windowsReset: 2,
	},
) {
	const account = makeAccount({
		id: crypto.randomUUID(),
		provider: "codex",
		access_token: "fake",
		refresh_token: "fake",
	});
	ids.push(account.id);
	const jobs: Array<() => void | Promise<void>> = [];
	const writes: string[] = [];

	const ctx = {
		provider: getProvider("codex"),
		asyncWriter: {
			enqueue: (job: () => void | Promise<void>) => {
				jobs.push(job);
				return true;
			},
		},
		dbOps: {
			getAccount: async () => account,
			recordManualCodexResetCreditEvent: async () => {},
			forceResetAccountRateLimit: async () => true,
			resumeAccountIfOveragePaused: async () => false,
			updateAccountUsage: async () => {
				writes.push("accounting");
			},
			updateAccountRateLimitMeta: async () => {
				writes.push("meta");
			},
			markAccountRateLimited: async () => {
				writes.push("cooldown");
				return 1;
			},
			markAccountRateLimitedDeadlineOnly: async () => {
				writes.push("cooldown");
			},
			getAdapter: () => ({
				run: async () => {
					writes.push("window");
				},
				runTransaction: async (body: () => number) => body(),
				getSQLiteDb: () => ({
					run: () => {
						writes.push("snapshot");
						return { changes: 1 };
					},
				}),
			}),
		},
	} as unknown as ProxyContext;
	const coordinator = new CodexSpendCoordinator(ctx, {
		getValidAccessToken: async () => "fake",
		consumeCodexRateLimitResetCredit: async () => {
			if (result instanceof Error) throw result;
			return result;
		},
		fetchCodexRateLimitResetCredits: async () => ({
			status: 200,
			summary: { availableCount: 1, credits: [] },
		}),
	});
	return {
		account,
		ctx,
		writes,
		reset: () =>
			coordinator.consumeResetCredit(account.id, {
				idempotencyKey: "test-only",
			}),
		flush: async () => {
			for (const job of jobs.splice(0)) await job();
		},
	};
}

function response(status = 200, utilization = 100) {
	return new Response(null, {
		status,
		headers: {
			"x-codex-primary-used-percent": String(utilization),
			"x-codex-primary-window-minutes": "10080",
			"x-codex-primary-reset-at": String(
				Math.floor(Date.now() / 1000) + 604800,
			),
		},
	});
}

function observe(
	h: ReturnType<typeof harness>,
	epoch: number,
	status: number,
	early: boolean,
	utilization = 100,
) {
	const res = response(status, utilization);
	if (early) {
		return applyCodexObservation(h.account, res, h.ctx, {
			source: "real-traffic",
			observationEpoch: epoch,
			rateLimitInfo: h.ctx.provider.parseRateLimit(res),
			requestAccounting: "none",
			rateLimitAction: { kind: "apply" },
			successRecovery: "standard",
		});
	}
	return processProxyResponse(res, h.account, h.ctx, undefined, {
		codexObservationEpoch: epoch,
	});
}

describe("Codex reset fences real traffic observations", () => {
	for (const outcome of ["reset", "alreadyRedeemed"] as const) {
		for (const [status, early] of [
			[200, false],
			[429, false],
			[429, true],
		] as const) {
			it(`${outcome} ignores old ${status} ${early ? "short-circuit" : "main"} but accepts a new request`, async () => {
				const h = harness({ outcome, windowsReset: 2 });
				const epoch = getCodexObservationEpoch(h.account.id);
				await h.reset();
				await observe(h, epoch, status, early);
				await h.flush();
				expect(usageCache.get(h.account.id)).toBeNull();
				expect(h.account.rate_limited_until).toBeNull();
				expect(h.writes.filter((w) => w !== "accounting")).toEqual([]);
				await observe(
					h,
					getCodexObservationEpoch(h.account.id),
					200,
					false,
					12,
				);
				await h.flush();
				expect(
					(usageCache.get(h.account.id) as UsageData | null)?.seven_day
						.utilization,
				).toBe(12);
				expect(h.writes).toContain("snapshot");
			});
		}
	}
	for (const result of [
		{ outcome: "noCredit", windowsReset: 0 },
		{ outcome: "nothingToReset", windowsReset: 0 },
		new Error("mock transport failure"),
	] as const) {
		it(`non-restoring ${result instanceof Error ? "failure" : result.outcome} preserves in-flight observations`, async () => {
			const h = harness(result);
			const epoch = getCodexObservationEpoch(h.account.id);
			await h.reset();
			await observe(h, epoch, 429, false);
			await h.flush();
			expect(
				(usageCache.get(h.account.id) as UsageData | null)?.seven_day
					.utilization,
			).toBe(100);
			expect(h.writes).toContain("snapshot");
			expect(h.writes).toContain("cooldown");
		});
	}
	it("rechecks the snapshot epoch on SQLITE_BUSY retry after a restoring consume", async () => {
		const h = harness();
		const db = new Database(":memory:");
		db.run(
			"CREATE TABLE accounts (id TEXT, refresh_token TEXT, codex_usage_json TEXT, codex_usage_observed_at INTEGER, rate_limit_reset INTEGER)",
		);
		db.run("INSERT INTO accounts (id, refresh_token) VALUES (?, ?)", [
			h.account.id,
			h.account.refresh_token,
		]);
		const adapter = new BunSqlAdapter(db);
		h.ctx.dbOps.getAdapter = () => adapter;
		const run = db.run.bind(db);
		let busy!: () => void;
		const attempted = new Promise<void>((resolve) => {
			busy = resolve;
		});
		let snapshotAttempts = 0;
		db.run = (sql, ...params) => {
			if (sql.includes("SET codex_usage_json") && ++snapshotAttempts === 1) {
				busy();
				throw Object.assign(new Error("mock writer contention"), {
					code: "SQLITE_BUSY",
				});
			}
			return run(sql, ...params);
		};
		try {
			await observe(h, getCodexObservationEpoch(h.account.id), 200, false);
			const flushing = h.flush();
			await attempted;
			await h.reset();
			await flushing;
			expect(snapshotAttempts).toBe(1);
			expect(db.query("SELECT codex_usage_json FROM accounts").get()).toEqual({
				codex_usage_json: null,
			});
			await observe(h, getCodexObservationEpoch(h.account.id), 200, false, 12);
			await h.flush();
			expect(snapshotAttempts).toBe(2);
			expect(
				db
					.query<{ codex_usage_json: string }, []>(
						"SELECT codex_usage_json FROM accounts",
					)
					.get()?.codex_usage_json,
			).toContain('"utilization":12');
		} finally {
			db.close();
		}
	});
	it("voids queued pre-reset snapshot/window/cooldown writes, but not request accounting or identical fresh snapshots", async () => {
		const h = harness();
		await observe(h, getCodexObservationEpoch(h.account.id), 429, false);
		await h.reset();
		await h.flush();
		expect(h.writes).toEqual(["accounting"]);
		expect(usageCache.get(h.account.id)).toBeNull();
		await observe(h, getCodexObservationEpoch(h.account.id), 200, false);
		await h.flush();
		expect(h.writes).toContain("snapshot");
	});
});
