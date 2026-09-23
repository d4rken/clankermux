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
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "affinity-pins-"));
	dbOps = new DatabaseOperations(path.join(tmpDir, "test.db"));
	await insertAccount("acc-a");
	await insertAccount("acc-b");
});

afterEach(async () => {
	await dbOps.close();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("session affinity pins", () => {
	it("replaces the whole set and reads it back oldest first", async () => {
		await dbOps.replaceSessionAffinityPins([
			{ keyHash: "k1", accountId: "acc-a", lastUsedAt: 100 },
			{ keyHash: "k2", accountId: "acc-b", lastUsedAt: 200 },
		]);
		await dbOps.replaceSessionAffinityPins([
			{ keyHash: "k3", accountId: "acc-b", lastUsedAt: 300 },
			{ keyHash: "k2", accountId: "acc-a", lastUsedAt: 250 },
		]);

		expect(await dbOps.getSessionAffinityPins(0)).toEqual([
			{ keyHash: "k2", accountId: "acc-a", lastUsedAt: 250 },
			{ keyHash: "k3", accountId: "acc-b", lastUsedAt: 300 },
		]);
	});

	it("returns only pins used at or after the cutoff", async () => {
		await dbOps.replaceSessionAffinityPins([
			{ keyHash: "old", accountId: "acc-a", lastUsedAt: 100 },
			{ keyHash: "edge", accountId: "acc-a", lastUsedAt: 200 },
			{ keyHash: "new", accountId: "acc-b", lastUsedAt: 300 },
		]);

		expect(
			(await dbOps.getSessionAffinityPins(200)).map((p) => p.keyHash),
		).toEqual(["edge", "new"]);
	});

	it("skips pins for accounts that no longer exist instead of failing the write", async () => {
		await dbOps.replaceSessionAffinityPins([
			{ keyHash: "k1", accountId: "acc-a", lastUsedAt: 100 },
			{ keyHash: "k2", accountId: "acc-deleted", lastUsedAt: 200 },
		]);

		expect(await dbOps.getSessionAffinityPins(0)).toEqual([
			{ keyHash: "k1", accountId: "acc-a", lastUsedAt: 100 },
		]);
	});

	it("drops an account's pins when the account is deleted", async () => {
		await dbOps.replaceSessionAffinityPins([
			{ keyHash: "k1", accountId: "acc-a", lastUsedAt: 100 },
			{ keyHash: "k2", accountId: "acc-b", lastUsedAt: 200 },
		]);

		await dbOps
			.getAdapter()
			.run("DELETE FROM accounts WHERE id = ?", ["acc-a"]);

		expect(await dbOps.getSessionAffinityPins(0)).toEqual([
			{ keyHash: "k2", accountId: "acc-b", lastUsedAt: 200 },
		]);
	});

	it("clears the table when given no pins", async () => {
		await dbOps.replaceSessionAffinityPins([
			{ keyHash: "k1", accountId: "acc-a", lastUsedAt: 100 },
		]);
		await dbOps.replaceSessionAffinityPins([]);
		expect(await dbOps.getSessionAffinityPins(0)).toEqual([]);
	});
});
