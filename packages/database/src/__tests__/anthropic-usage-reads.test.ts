import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseOperations } from "../database-operations";

let tmpDir: string;
let dbOps: DatabaseOperations;

const insertAccount = (id: string) =>
	dbOps.getAdapter().run(
		`INSERT INTO accounts (id, name, provider, created_at, refresh_token, auto_pause_on_overage_enabled)
			 VALUES (?, ?, 'anthropic', ?, 'rt', 1)`,
		[id, id, Date.now()],
	);

beforeEach(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "anthropic-usage-reads-"));
	dbOps = new DatabaseOperations(path.join(tmpDir, "test.db"));
	await insertAccount("acc-a");
	await insertAccount("acc-b");
});

afterEach(async () => {
	await dbOps.close();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("anthropic usage reads", () => {
	it("keeps the latest read time and reading per account, independently", async () => {
		await dbOps.recordAnthropicUsageReadAt("acc-a", 100);
		await dbOps.recordAnthropicUsageReading("acc-a", '{"n":1}', 110);
		await dbOps.recordAnthropicUsageReadAt("acc-a", 200);
		await dbOps.recordAnthropicUsageReading("acc-b", '{"n":2}', 50);

		expect(await dbOps.getAnthropicUsageReads()).toEqual([
			{
				accountId: "acc-a",
				lastReadAt: 200,
				reading: '{"n":1}',
				readingObservedAt: 110,
			},
			{
				accountId: "acc-b",
				lastReadAt: null,
				reading: '{"n":2}',
				readingObservedAt: 50,
			},
		]);
	});

	it("never moves either value back to an older one", async () => {
		await dbOps.recordAnthropicUsageReadAt("acc-a", 300);
		await dbOps.recordAnthropicUsageReadAt("acc-a", 200);
		await dbOps.recordAnthropicUsageReading("acc-a", '{"n":"new"}', 300);
		await dbOps.recordAnthropicUsageReading("acc-a", '{"n":"old"}', 200);

		expect(await dbOps.getAnthropicUsageReads()).toEqual([
			{
				accountId: "acc-a",
				lastReadAt: 300,
				reading: '{"n":"new"}',
				readingObservedAt: 300,
			},
		]);
	});

	it("skips an account that no longer exists instead of failing", async () => {
		await dbOps.recordAnthropicUsageReadAt("gone", 100);
		await dbOps.recordAnthropicUsageReading("gone", "{}", 100);
		expect(await dbOps.getAnthropicUsageReads()).toEqual([]);
	});

	it("drops the row when its account is deleted", async () => {
		await dbOps.recordAnthropicUsageReadAt("acc-a", 100);
		await dbOps
			.getAdapter()
			.run("DELETE FROM accounts WHERE id = ?", ["acc-a"]);
		expect(await dbOps.getAnthropicUsageReads()).toEqual([]);
	});
});
