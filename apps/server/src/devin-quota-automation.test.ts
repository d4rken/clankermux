import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { LeastUsedStrategy, SessionStrategy } from "@clankermux/load-balancer";
import type { Account, DevinUsageData, RequestMeta } from "@clankermux/types";
import {
	applyDevinQuotaAutomation,
	decideDevinQuotaAction,
} from "./devin-quota-automation";

const now = 1_800_000_000_000;
const account = {
	id: "devin",
	provider: "devin",
	api_key: "session",
	custom_endpoint: null,
	paused: false,
	pause_reason: null,
	auto_fallback_enabled: true,
	auto_pause_on_overage_enabled: true,
	rate_limited_until: null,
} as Account;
const usage: DevinUsageData = {
	kind: "devin",
	quotaBased: true,
	daily: { utilization: 20, resetAt: now + 86_400_000 },
	weekly: { utilization: 40, resetAt: now + 604_800_000 },
	planName: "Pro",
	email: null,
	accountId: null,
	canUseCli: true,
	overageBalanceUsd: 20,
	includedCreditsRemaining: null,
};

describe("Devin metadata quota automation", () => {
	it("leaves entitlement failures separate from quota pause and recovery", () => {
		for (const paused of [false, true])
			expect(
				decideDevinQuotaAction(
					{ ...account, paused, pause_reason: paused ? "overage" : null },
					{ ...usage, canUseCli: false },
					now,
				),
			).toBeNull();
	});
	it("keeps existing defaults unchanged and requires opt-in for both actions", () => {
		expect(
			decideDevinQuotaAction(
				{ ...account, auto_fallback_enabled: false },
				{ ...usage, daily: null, weekly: null },
				now,
			),
		).toBeNull();
		expect(
			decideDevinQuotaAction(
				{
					...account,
					paused: true,
					pause_reason: "overage",
					auto_fallback_enabled: false,
				},
				usage,
				now,
			),
		).toBeNull();
	});
	it("pauses exhausted or unknown included quota when opted in and protected", () => {
		for (const unavailable of [
			{ ...usage, daily: { utilization: 100, resetAt: now + 1 } },
			{ ...usage, weekly: { utilization: 100, resetAt: now + 1 } },
			{ ...usage, daily: null, weekly: null },
			{ ...usage, daily: { utilization: 0, resetAt: now - 1 } },
		])
			expect(decideDevinQuotaAction(account, unavailable, now)).toBe("pause");
		expect(
			decideDevinQuotaAction(
				{ ...account, auto_pause_on_overage_enabled: false },
				{ ...usage, daily: null, weekly: null },
				now,
			),
		).toBeNull();
	});
	it("resumes only safe quota pauses with fresh capacity and no active cooldown", () => {
		const paused = { ...account, paused: true, pause_reason: "overage" };
		expect(decideDevinQuotaAction(paused, usage, now)).toBe("resume");
		expect(decideDevinQuotaAction(paused, { ...usage, daily: null }, now)).toBe(
			"resume",
		);
		expect(
			decideDevinQuotaAction(
				paused,
				{ ...usage, daily: null, weekly: null, includedCreditsRemaining: 4 },
				now,
			),
		).toBe("resume");
		expect(
			decideDevinQuotaAction(
				paused,
				{ ...usage, daily: null, weekly: null },
				now,
			),
		).toBeNull();
		expect(
			decideDevinQuotaAction(
				{ ...paused, rate_limited_until: now },
				usage,
				now,
			),
		).toBeNull();
		for (const pause_reason of [
			"manual",
			"needs_reauth",
			"failure_threshold",
			null,
		])
			expect(
				decideDevinQuotaAction({ ...paused, pause_reason }, usage, now),
			).toBeNull();
	});
	it("does not treat a daily reset as replenishment when the weekly quota is still exhausted", () => {
		expect(
			decideDevinQuotaAction(
				{ ...account, paused: true, pause_reason: "overage" },
				{
					...usage,
					daily: { utilization: 0, resetAt: now + 86_400_000 },
					weekly: { utilization: 100, resetAt: now + 604_800_000 },
				},
				now,
			),
		).toBeNull();
	});
	for (const mutation of [
		"UPDATE accounts SET api_key='new-session'",
		"UPDATE accounts SET custom_endpoint='https://other.example'",
		"UPDATE accounts SET custom_endpoint=''",
		"UPDATE accounts SET auto_fallback_enabled=0",
		"UPDATE accounts SET pause_reason='manual'",
		"UPDATE accounts SET pause_reason='needs_reauth'",
		`UPDATE accounts SET rate_limited_until=${now + 1}`,
	]) {
		it(`a concurrent edit wins over recovery: ${mutation}`, async () => {
			const db = seededDb(true);
			try {
				const adapter = {
					run: async (sql: string, params: unknown[] = []) => {
						db.run(mutation);
						db.run(sql, params as SQLQueryBindings[]);
					},
				};
				await applyDevinQuotaAutomation(
					adapter,
					{ ...account, paused: true, pause_reason: "overage" },
					usage,
					() => true,
					now,
				);
				expect(
					(db.query("SELECT paused FROM accounts").get() as { paused: number })
						.paused,
				).toBe(1);
			} finally {
				db.close();
			}
		});
	}
	it("applies pause/recovery without rewriting calendar resets or clearing cooldown metadata", async () => {
		const db = seededDb(false);
		try {
			const adapter = {
				run: async (sql: string, params: unknown[] = []) => {
					db.run(sql, params as SQLQueryBindings[]);
				},
			};
			await applyDevinQuotaAutomation(
				adapter,
				account,
				{ ...usage, daily: null, weekly: null },
				() => true,
				now,
			);
			expect(
				db
					.query("SELECT paused,pause_reason,rate_limit_reset FROM accounts")
					.get(),
			).toEqual({ paused: 1, pause_reason: "overage", rate_limit_reset: 123 });
			await applyDevinQuotaAutomation(
				adapter,
				{ ...account, paused: true, pause_reason: "overage" },
				usage,
				() => true,
				now,
			);
			expect(
				db
					.query("SELECT paused,pause_reason,rate_limit_reset FROM accounts")
					.get(),
			).toEqual({ paused: 0, pause_reason: null, rate_limit_reset: 123 });
		} finally {
			db.close();
		}
	});
	it("does not write when the poll generation has been replaced", async () => {
		let writes = 0;
		await applyDevinQuotaAutomation(
			{
				run: async () => {
					writes++;
				},
			},
			account,
			{ ...usage, daily: null, weekly: null },
			() => false,
			now,
		);
		expect(writes).toBe(0);
	});
	for (const strategy of [new SessionStrategy(), new LeastUsedStrategy()]) {
		it(`returns the recovered preferred account to fresh request selection (${strategy.constructor.name})`, async () => {
			const db = seededDb(true);
			try {
				const preferred = {
					...account,
					name: "preferred",
					paused: true,
					pause_reason: "overage",
					priority: 0,
					session_start: null,
					created_at: 1,
				};
				const secondary = {
					...account,
					id: "secondary",
					name: "secondary",
					priority: 10,
					session_start: null,
					created_at: 2,
				};
				const meta = (): RequestMeta => ({
					id: "automation-routing",
					method: "POST",
					path: "/v1/messages",
					timestamp: now,
				});
				expect(strategy.select([preferred, secondary], meta())[0]?.id).toBe(
					"secondary",
				);
				await applyDevinQuotaAutomation(
					{
						run: async (sql, params) => {
							db.run(sql, params as SQLQueryBindings[]);
						},
					},
					preferred,
					usage,
					() => true,
					now,
				);
				const row = db
					.query("SELECT paused,pause_reason FROM accounts")
					.get() as { paused: number; pause_reason: string | null };
				expect(
					strategy.select(
						[
							{
								...preferred,
								paused: !!row.paused,
								pause_reason: row.pause_reason,
							},
							secondary,
						],
						meta(),
					)[0]?.id,
				).toBe("devin");
			} finally {
				db.close();
			}
		});
	}
	it("does not overwrite a manual pause or protection opt-out while scheduling a pause", async () => {
		for (const mutation of [
			"UPDATE accounts SET paused=1,pause_reason='manual'",
			"UPDATE accounts SET auto_pause_on_overage_enabled=0",
		]) {
			const db = seededDb(false);
			try {
				await applyDevinQuotaAutomation(
					{
						run: async (sql, params) => {
							db.run(mutation);
							db.run(sql, params as SQLQueryBindings[]);
						},
					},
					account,
					{ ...usage, daily: null, weekly: null },
					() => true,
					now,
				);
				expect(
					(
						db.query("SELECT pause_reason FROM accounts").get() as {
							pause_reason: string | null;
						}
					).pause_reason,
				).not.toBe("overage");
			} finally {
				db.close();
			}
		}
	});
});

function seededDb(paused: boolean): Database {
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE accounts (id TEXT,provider TEXT,api_key TEXT,custom_endpoint TEXT,paused INTEGER,pause_reason TEXT,auto_fallback_enabled INTEGER,auto_pause_on_overage_enabled INTEGER,rate_limited_until INTEGER,rate_limit_reset INTEGER)",
	);
	db.run(
		"INSERT INTO accounts VALUES ('devin','devin','session',NULL,?,?,1,1,NULL,123)",
		[Number(paused), paused ? "overage" : null],
	);
	return db;
}
