/**
 * DatabaseOperations exposes the banked-reset ledger through its retrying
 * repository wrapper; one pass over every wrapper on a real database file.
 */
import { afterEach, beforeEach, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseOperations } from "../database-operations";

const NOW = Date.parse("2026-09-22T12:00:00Z");

let tmpDir: string;
let dbOps: DatabaseOperations;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banked-reset-ledger-"));
	dbOps = new DatabaseOperations(path.join(tmpDir, "test.db"));
});

afterEach(async () => {
	await dbOps.close();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

it("round-trips a manual and an auto attempt through the wrappers", async () => {
	// A pending manual claim blocks new auto attempts on its account, so the
	// manual one lives on another account.
	const manual = await dbOps.beginManualAnthropicBankedResetAttempt({
		accountId: "acc-manual",
		accountName: "Acc manual",
		grantId: "g1",
		requestId: "req-1",
		grantEndsAt: null,
		now: NOW,
	});
	expect(manual.kind).toBe("created");
	expect(
		(await dbOps.getAnthropicBankedResetEventByRequestId("acc-manual", "req-1"))
			?.id,
	).toBe(manual.row.id);

	const auto = await dbOps.claimAnthropicBankedResetAutoAttempt({
		accountId: "acc",
		accountName: "Acc",
		grantId: "g1",
		grantEndsAt: NOW + 60_000,
		cause: "weekly-limit",
		now: NOW + 1,
	});
	if (!auto) throw new Error("expected an auto claim");
	expect(await dbOps.getNextAnthropicBankedResetAttemptSeq("acc", "g1")).toBe(
		2,
	);
	expect(
		await dbOps.setAnthropicBankedResetNextAttemptAt(
			auto.id,
			NOW + 60_000,
			"503",
		),
	).toBe(true);
	expect(
		(await dbOps.getPendingAnthropicBankedResetAttempts("acc", "auto")).map(
			(row) => row.id,
		),
	).toEqual([auto.id]);

	expect(
		await dbOps.resolveAnthropicBankedResetAttempt(auto.id, {
			status: "reset",
			cleared: ["seven_day"],
			resetsLeft: 0,
			now: NOW + 2,
		}),
	).toBe(true);
	expect(
		await dbOps.getAnthropicBankedResetAutoApplyCooldownAnchorAt("acc"),
	).toBe(NOW + 2);

	expect(
		await dbOps.expireStaleAnthropicBankedResetAttempts(NOW + 60 * 60_000),
	).toBe(1);
	expect(
		(await dbOps.getRecentAnthropicBankedResetEvents("acc", 10)).map(
			(row) => row.status,
		),
	).toEqual(["reset"]);
	expect(
		(await dbOps.getRecentAnthropicBankedResetEvents("acc-manual", 10)).map(
			(row) => row.status,
		),
	).toEqual(["failed"]);
});
