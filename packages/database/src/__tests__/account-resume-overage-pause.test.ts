/**
 * AccountRepository.resumeIfOveragePaused — the compare-and-resume that lifts
 * the proxy's OWN overage pause after a reset credit restored the account's
 * usage windows, and no other pause. The predicate lives in SQL so the stored
 * row is what decides, not a stale in-memory account.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema } from "../migrations";
import { AccountRepository } from "../repositories/account.repository";

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	return db;
}

interface PauseRow {
	paused: number;
	pause_reason: string | null;
}

let db: Database;
let repo: AccountRepository;

function insertAccount(
	id: string,
	state: {
		paused: number;
		pause_reason: string | null;
		auto_pause_on_overage_enabled: number;
	},
): void {
	db.run(
		`INSERT INTO accounts (id, name, provider, created_at, paused, pause_reason, auto_pause_on_overage_enabled)
		 VALUES (?, ?, 'codex', ?, ?, ?, ?)`,
		[
			id,
			id,
			Date.now(),
			state.paused,
			state.pause_reason,
			state.auto_pause_on_overage_enabled,
		],
	);
}

function pauseState(id: string): PauseRow {
	return db
		.query("SELECT paused, pause_reason FROM accounts WHERE id = ?")
		.get(id) as PauseRow;
}

beforeEach(() => {
	db = makeDb();
	repo = new AccountRepository(new BunSqlAdapter(db));
});

afterEach(() => {
	db.close();
});

describe("AccountRepository.resumeIfOveragePaused", () => {
	for (const reason of ["overage", null]) {
		it(`lifts an auto-pause-on-overage pause with reason ${reason}`, async () => {
			insertAccount("a", {
				paused: 1,
				pause_reason: reason,
				auto_pause_on_overage_enabled: 1,
			});
			expect(await repo.resumeIfOveragePaused("a")).toBe(true);
			expect(pauseState("a")).toEqual({ paused: 0, pause_reason: null });
		});
	}

	for (const reason of [
		"manual",
		"failure_threshold",
		"subscription_expired",
		"oauth_invalid_grant",
		"peak_hours",
		"some-future-reason",
	]) {
		it(`keeps a ${reason} pause even with auto-pause-on-overage on`, async () => {
			insertAccount("a", {
				paused: 1,
				pause_reason: reason,
				auto_pause_on_overage_enabled: 1,
			});
			expect(await repo.resumeIfOveragePaused("a")).toBe(false);
			expect(pauseState("a")).toEqual({ paused: 1, pause_reason: reason });
		});
	}

	it("keeps an overage pause once auto-pause-on-overage has been switched off", async () => {
		insertAccount("a", {
			paused: 1,
			pause_reason: "overage",
			auto_pause_on_overage_enabled: 0,
		});
		expect(await repo.resumeIfOveragePaused("a")).toBe(false);
		expect(pauseState("a")).toEqual({ paused: 1, pause_reason: "overage" });
	});

	it("is a no-op on an unpaused account", async () => {
		insertAccount("a", {
			paused: 0,
			pause_reason: null,
			auto_pause_on_overage_enabled: 1,
		});
		expect(await repo.resumeIfOveragePaused("a")).toBe(false);
		expect(pauseState("a")).toEqual({ paused: 0, pause_reason: null });
	});

	it("is a no-op on an unknown account", async () => {
		expect(await repo.resumeIfOveragePaused("missing")).toBe(false);
	});

	it("only touches the addressed account", async () => {
		insertAccount("a", {
			paused: 1,
			pause_reason: "overage",
			auto_pause_on_overage_enabled: 1,
		});
		insertAccount("b", {
			paused: 1,
			pause_reason: "overage",
			auto_pause_on_overage_enabled: 1,
		});
		expect(await repo.resumeIfOveragePaused("a")).toBe(true);
		expect(pauseState("b")).toEqual({ paused: 1, pause_reason: "overage" });
	});
});
