/**
 * Worker round-trip for `/api/analytics/model-substitutions`.
 *
 * This exists because the unit tests could not see the bug that shipped: they
 * drive the sources seam, while the handler ALSO runs inside the analytics
 * worker, whose synthetic APIContext carries only `getAdapter()`. Reaching
 * through `context.dbOps.routing` there threw on every call, so the endpoint
 * failed on every dashboard poll and all three surfaces showed nothing — with a
 * green suite throughout.
 *
 * So the assertion that matters is `x-clankermux-analytics-mode: worker`
 * alongside a 200: it proves the query ran in the worker, not in the
 * main-thread fallback that has a full `dbOps` and would have hidden this.
 */
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "@clankermux/database";
import type { ModelSubstitutionsResponse } from "@clankermux/types";
import {
	clearAnalyticsCachesForTests,
	terminateAnalyticsWorker,
} from "../analytics-runner";
import { createModelSubstitutionsHandler } from "../model-substitutions";
import { makeContext } from "./dashboard-test-helpers";

let tmpDir: string;
let dbOps: DatabaseOperations;

beforeEach(() => {
	clearAnalyticsCachesForTests();
	tmpDir = mkdtempSync(join(tmpdir(), "clankermux-substitutions-"));
	dbOps = new DatabaseOperations(join(tmpDir, "test.db"));
});

afterEach(async () => {
	clearAnalyticsCachesForTests();
	await dbOps.dispose();
	rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
	terminateAnalyticsWorker();
});

async function insertAccount(id: string, name: string): Promise<void> {
	await dbOps.getAdapter().run(
		`INSERT INTO accounts (id, name, provider, refresh_token, created_at, priority, request_count)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[id, name, "codex", "tok", Date.now(), 0, 0],
	);
}

/** `route_snapshot_id` is NOT NULL, so every attempt needs a snapshot row. */
async function insertSnapshot(): Promise<string> {
	const id = "snap-1";
	await dbOps
		.getAdapter()
		.run(
			`INSERT OR IGNORE INTO routing_snapshots (id, content) VALUES (?, ?)`,
			[id, "{}"],
		);
	return id;
}

async function insertAttempt(opts: {
	id: string;
	accountId: string;
	outgoing: string;
	reported: string | null;
	startedAt: number;
}): Promise<void> {
	const snapshotId = await insertSnapshot();
	await dbOps.getAdapter().run(
		`INSERT INTO routing_attempts (id, request_id, route_snapshot_id, account_id, provider, requested_model, resolved_model, outgoing_model, reported_model, kind, started_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			opts.id,
			`req-${opts.id}`,
			snapshotId,
			opts.accountId,
			"codex",
			opts.outgoing,
			opts.outgoing,
			opts.outgoing,
			opts.reported,
			"upstream_send",
			opts.startedAt,
		],
	);
}

describe("model-substitutions worker isolation", () => {
	it("serves the endpoint through the SQLite worker", async () => {
		const now = Date.now();
		await insertAccount("acct-1", "Codex-me");
		await insertAttempt({
			id: "a1",
			accountId: "acct-1",
			outgoing: "gpt-6-astra",
			reported: "gpt-5.6-luna",
			startedAt: now - 60_000,
		});
		await insertAttempt({
			id: "a2",
			accountId: "acct-1",
			outgoing: "gpt-6-astra",
			reported: "gpt-6-astra",
			startedAt: now - 30_000,
		});

		const handler = createModelSubstitutionsHandler(makeContext(dbOps));
		const response = await handler(new URLSearchParams({ range: "24h" }));

		expect(response.status).toBe(200);
		expect(response.headers.get("x-clankermux-analytics-mode")).toBe("worker");

		const data = (await response.json()) as ModelSubstitutionsResponse;
		expect(data.pairs).toHaveLength(1);
		expect(data.pairs[0]?.outgoingModel).toBe("gpt-6-astra");
		expect(data.pairs[0]?.reportedModel).toBe("gpt-5.6-luna");
		// The account NAME has to resolve, which needs the account repository the
		// worker context does not hand out either.
		expect(data.pairs[0]?.accountName).toBe("Codex-me");
		// 2, not 1: the correctly-served attempt belongs in the denominator.
		expect(data.pairs[0]?.comparable).toBe(2);
	});

	it("returns an empty answer rather than failing when nothing substituted", async () => {
		await insertAccount("acct-1", "Codex-me");
		await insertAttempt({
			id: "a1",
			accountId: "acct-1",
			outgoing: "gpt-6-astra",
			reported: "gpt-6-astra",
			startedAt: Date.now() - 60_000,
		});

		const handler = createModelSubstitutionsHandler(makeContext(dbOps));
		const response = await handler(new URLSearchParams({ range: "24h" }));

		expect(response.status).toBe(200);
		const data = (await response.json()) as ModelSubstitutionsResponse;
		expect(data.pairs).toEqual([]);
		expect(data.degraded).toEqual([]);
	});
});
