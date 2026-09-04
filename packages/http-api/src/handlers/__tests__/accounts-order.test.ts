import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "@clankermux/config";
import { DatabaseOperations } from "@clankermux/database";
import type { AccountResponse } from "@clankermux/types";
import { createAccountsListHandler } from "../accounts";

let tmpDir: string;
let dbOps: DatabaseOperations;

const config = {
	getUsageThrottlingFiveHourEnabled: () => false,
	getUsageThrottlingWeeklyEnabled: () => false,
} as unknown as Config;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "clankermux-accounts-order-"));
	dbOps = new DatabaseOperations(join(tmpDir, "test.db"));
});

afterEach(async () => {
	await dbOps.dispose();
	rmSync(tmpDir, { recursive: true, force: true });
});

async function insertAccount(
	id: string,
	name: string,
	priority: number,
): Promise<void> {
	await dbOps.getAdapter().run(
		`INSERT INTO accounts (
			id, name, provider, refresh_token, created_at, priority
		) VALUES (?, ?, 'openai-compatible', ?, ?, ?)`,
		[id, name, `token-${id}`, Date.now(), priority],
	);
}

describe("GET /api/accounts ordering", () => {
	it("sorts by name first and descending priority when names match", async () => {
		await insertAccount("zulu", "Zulu", 100);
		await insertAccount("echo-low", "Echo", 1);
		await insertAccount("alpha", "Alpha", 0);
		await insertAccount("echo-high", "Echo", 9);

		const response = await createAccountsListHandler(dbOps, config)();
		const accounts = (await response.json()) as AccountResponse[];

		expect(accounts.map(({ id }) => id)).toEqual([
			"alpha",
			"echo-high",
			"echo-low",
			"zulu",
		]);
	});
});
