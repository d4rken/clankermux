/**
 * A pause's identity: every change of `paused` or `pause_reason`, by any
 * writer, advances `pause_epoch` and stamps `pause_changed_at`. A caller that
 * owes one particular pause a verdict records the epoch and resumes only
 * while it still matches.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseOperations } from "../database-operations";

let tmpDir: string;
let dbOps: DatabaseOperations;

beforeEach(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pause-marker-"));
	dbOps = new DatabaseOperations(path.join(tmpDir, "test.db"));
	await dbOps.getAdapter().run(
		`INSERT INTO accounts (id, name, provider, created_at, refresh_token, auto_pause_on_overage_enabled)
			 VALUES ('acc-1', 'acc-1', 'anthropic', ?, 'rt', 1)`,
		[Date.now()],
	);
});

afterEach(async () => {
	await dbOps.close();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

const setPause = (paused: 0 | 1, reason: string | null) =>
	dbOps
		.getAdapter()
		.run(
			"UPDATE accounts SET paused = ?, pause_reason = ? WHERE id = 'acc-1'",
			[paused, reason],
		);

describe("account pause marker", () => {
	it("advances on every pause change, whoever writes it, and on nothing else", async () => {
		const start = await dbOps.getAccountPauseMarker("acc-1");
		expect(start?.pauseEpoch).toBe(0);
		expect(start?.pauseChangedAt).toBeNull();

		const before = Date.now();
		await setPause(1, "overage");
		const paused = await dbOps.getAccountPauseMarker("acc-1");
		expect(paused).toMatchObject({
			paused: true,
			pauseReason: "overage",
			autoPauseOnOverageEnabled: true,
			pauseEpoch: 1,
		});
		expect(paused?.pauseChangedAt ?? 0).toBeGreaterThanOrEqual(before - 5);

		await dbOps
			.getAdapter()
			.run("UPDATE accounts SET priority = 3 WHERE id = 'acc-1'");
		await setPause(1, "overage");
		expect((await dbOps.getAccountPauseMarker("acc-1"))?.pauseEpoch).toBe(1);

		await setPause(0, null);
		await setPause(1, "overage");
		expect((await dbOps.getAccountPauseMarker("acc-1"))?.pauseEpoch).toBe(3);
		expect(await dbOps.getAccountPauseMarker("missing")).toBeNull();
	});

	it("resumes an overage pause only while its epoch still matches", async () => {
		await setPause(1, "overage");
		const marker = await dbOps.getAccountPauseMarker("acc-1");
		await setPause(0, null);
		await setPause(1, "overage");

		expect(
			await dbOps.resumeAccountIfOveragePausedAt(
				"acc-1",
				marker?.pauseEpoch ?? -1,
			),
		).toBe(false);
		const current = await dbOps.getAccountPauseMarker("acc-1");
		expect(current?.paused).toBe(true);
		expect(
			await dbOps.resumeAccountIfOveragePausedAt(
				"acc-1",
				current?.pauseEpoch ?? -1,
			),
		).toBe(true);
		expect((await dbOps.getAccountPauseMarker("acc-1"))?.paused).toBe(false);
	});

	it("never resumes a pause of another reason", async () => {
		await setPause(1, "manual");
		const marker = await dbOps.getAccountPauseMarker("acc-1");
		expect(
			await dbOps.resumeAccountIfOveragePausedAt(
				"acc-1",
				marker?.pauseEpoch ?? -1,
			),
		).toBe(false);
	});
});
