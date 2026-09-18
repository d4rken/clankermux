import "@clankermux/core";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { isAccountAvailable } from "@clankermux/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { AccountRepository } from "../account.repository";
import { AccountPaymentRepository } from "../account-payment.repository";
import { StatsRepository } from "../stats.repository";

let db: Database;
let repo: AccountRepository;
let payments: AccountPaymentRepository;
beforeEach(() => {
	db = new Database(":memory:");
	ensureSchema(db);
	const adapter = new BunSqlAdapter(db);
	repo = new AccountRepository(adapter);
	payments = new AccountPaymentRepository(adapter);
	db.run(`INSERT INTO accounts (id, name, created_at, paused, pause_reason, renewal_anchor, renewal_cadence, renewal_price_usd_micros, renewal_auto_start_date)
	 VALUES ('saved', 'Saved', 1, 1, 'subscription_expired', '2026-01-01', 'monthly', 20000000, '2026-01-01')`);
});
afterEach(() => db.close());

it("retains disabled configuration while excluding it from operation across migration/repository recreation", async () => {
	expect(await repo.setDisabled("saved", true, "2026-02-01")).toBe(true);
	runMigrations(db);
	repo = new AccountRepository(new BunSqlAdapter(db));
	expect(await repo.findAll()).toEqual([]);
	expect(await repo.getRenewalConfigs()).toEqual([]);
	expect(await repo.hasAccountsForProvider("anthropic")).toBe(false);
	const account = (await repo.findAll(true))[0];
	if (!account) throw new Error("Disabled account must remain in inventory");
	expect(account.disabled).toBe(true);
	expect(account.pause_reason).toBe("subscription_expired");
	expect(account.renewal_anchor).toBe("2026-01-01");
	expect(isAccountAvailable({ ...account, paused: false })).toBe(false);
});

it("automatic resume never enables a disabled account", async () => {
	await repo.setDisabled("saved", true, "2026-02-01");
	await repo.resume("saved");
	expect((await repo.findById("saved"))?.disabled).toBe(true);
	expect(await repo.findAll()).toEqual([]);
});

it("preserves history, prevents invoices during disable and catch-up after enable", async () => {
	expect(
		await payments.recordAuto("saved", "Saved", "2026-01-01", 20000000, 1),
	).toBe(true);
	await repo.setDisabled("saved", true, "2026-02-01");
	expect(
		await payments.recordAuto("saved", "Saved", "2026-02-01", 20000000, 2),
	).toBe(false);
	await repo.setDisabled("saved", false, "2026-03-15");
	expect(
		await payments.recordAuto("saved", "Saved", "2026-03-01", 20000000, 3),
	).toBe(false);
	expect(
		await payments.recordAuto("saved", "Saved", "2026-04-01", 20000000, 4),
	).toBe(true);
	expect(await payments.findRecent(10)).toHaveLength(2);
	expect((await repo.findAll())[0]?.pause_reason).toBe("subscription_expired");
	await repo.setDisabled("saved", false, "2026-05-01");
	expect((await repo.findById("saved"))?.renewal_auto_start_date).toBe(
		"2026-03-15",
	);
});

it("excludes disabled accounts from the current active-account statistic", async () => {
	const stats = new StatsRepository(new BunSqlAdapter(db));
	db.run("UPDATE accounts SET request_count = 10 WHERE id = 'saved'");
	expect(await stats.getActiveAccountCount()).toBe(1);
	await repo.setDisabled("saved", true, "2026-02-01");
	expect(await stats.getActiveAccountCount()).toBe(0);
	expect((await repo.findById("saved"))?.request_count).toBe(10);
});
