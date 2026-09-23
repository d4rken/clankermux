/**
 * The two Anthropic banked-reset auto-apply toggles must survive the whole
 * round trip: setter → column → findAll/findById SELECT → toAccount. A column
 * missing from either SELECT reads back as `!!undefined`, which silently
 * reports the toggle off and leaves the scheduler with no candidates.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseOperations } from "../database-operations";

let tmpDir: string;
let dbOps: DatabaseOperations;

beforeEach(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banked-reset-toggles-"));
	dbOps = new DatabaseOperations(path.join(tmpDir, "test.db"));
	await dbOps
		.getAdapter()
		.run(
			`INSERT INTO accounts (id, name, provider, created_at, refresh_token) VALUES (?, ?, 'anthropic', ?, 'rt')`,
			["acc-1", "acc-1", Date.now()],
		);
});

afterEach(async () => {
	await dbOps.close();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function both() {
	const byId = await dbOps.getAccount("acc-1");
	const fromAll = (await dbOps.getAllAccounts()).find((a) => a.id === "acc-1");
	return { byId, fromAll };
}

describe("Anthropic banked-reset auto-apply toggles", () => {
	it("default to off", async () => {
		const { byId, fromAll } = await both();
		for (const account of [byId, fromAll]) {
			expect(account?.anthropic_auto_apply_banked_resets_enabled).toBe(false);
			expect(
				account?.anthropic_auto_apply_banked_reset_on_weekly_limit_enabled,
			).toBe(false);
		}
	});

	it("reads the expiry toggle back through getAccount and getAllAccounts", async () => {
		await dbOps.setAnthropicAutoApplyBankedResetsEnabled("acc-1", true);
		const { byId, fromAll } = await both();
		for (const account of [byId, fromAll]) {
			expect(account?.anthropic_auto_apply_banked_resets_enabled).toBe(true);
			expect(
				account?.anthropic_auto_apply_banked_reset_on_weekly_limit_enabled,
			).toBe(false);
		}
	});

	it("reads the weekly-limit toggle back independently", async () => {
		await dbOps.setAnthropicAutoApplyBankedResetOnWeeklyLimitEnabled(
			"acc-1",
			true,
		);
		const { byId, fromAll } = await both();
		for (const account of [byId, fromAll]) {
			expect(
				account?.anthropic_auto_apply_banked_reset_on_weekly_limit_enabled,
			).toBe(true);
			expect(account?.anthropic_auto_apply_banked_resets_enabled).toBe(false);
		}

		await dbOps.setAnthropicAutoApplyBankedResetOnWeeklyLimitEnabled(
			"acc-1",
			false,
		);
		expect(
			(await dbOps.getAccount("acc-1"))
				?.anthropic_auto_apply_banked_reset_on_weekly_limit_enabled,
		).toBe(false);
	});
});
