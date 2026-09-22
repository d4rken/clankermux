/**
 * The substituted-model split, executed inside the analytics worker.
 *
 * The rest of the split's coverage drives `analytics-direct` on the main
 * thread. Production does not: the analytics endpoint runs from an inline
 * bundle, and this change put a NEW cross-package import into that bundle's
 * closure (`isModelSubstitution`, from `@clankermux/proxy`). If the bundler
 * cannot reach it, the endpoint throws on every dashboard poll while every
 * main-thread test stays green — which is exactly how this feature's first
 * endpoint shipped dead.
 *
 * So the assertion that matters is `x-clankermux-analytics-mode: worker`
 * beside a correct split. Without the header the main-thread fallback answers
 * and proves nothing.
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
import { createAnalyticsHandler } from "../analytics";
import {
	clearAnalyticsCachesForTests,
	terminateAnalyticsWorker,
} from "../analytics-runner";
import { makeContext } from "./dashboard-test-helpers";

const NOW = Date.now();

let tmpDir: string;
let dbOps: DatabaseOperations;

beforeEach(() => {
	clearAnalyticsCachesForTests();
	tmpDir = mkdtempSync(join(tmpdir(), "clankermux-substitution-split-"));
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

async function seed(
	id: string,
	sent: string,
	served: string,
	atMs: number,
	provider = "codex",
): Promise<void> {
	const adapter = dbOps.getAdapter();
	await adapter.run(
		`INSERT INTO requests (id, timestamp, method, path, account_used, status_code, success, model, requested_model, cost_usd, total_tokens)
		 VALUES (?, ?, 'POST', '/v1/messages', 'acct-1', 200, 1, ?, ?, 0.01, 100)`,
		[id, atMs, served, sent],
	);
	await adapter.run(
		`INSERT OR IGNORE INTO routing_snapshots (id, content) VALUES ('snap-1', '{}')`,
	);
	await adapter.run(
		`INSERT INTO routing_attempts (id, request_id, route_snapshot_id, account_id, provider, requested_model, resolved_model, outgoing_model, reported_model, kind, started_at, status)
		 VALUES (?, ?, 'snap-1', 'acct-1', ?, ?, ?, ?, ?, 'upstream_send', ?, 200)`,
		[`att-${id}`, id, provider, sent, sent, sent, served, atMs],
	);
}

describe("substituted-model split through the analytics worker", () => {
	it("splits in the worker and normalises there too", async () => {
		await dbOps.getAdapter().run(
			`INSERT INTO accounts (id, name, provider, refresh_token, created_at, priority, request_count)
			 VALUES ('acct-1', 'Codex-me', 'codex', 'tok', ?, 0, 0)`,
			[NOW],
		);
		await seed("r1", "gpt-5.6-luna", "gpt-5.6-luna", NOW - 60_000);
		await seed("r2", "gpt-6-astra", "gpt-5.6-luna", NOW - 50_000);
		// A slug the backend resolves by design. It reaches the SQL as a
		// candidate and only `isModelSubstitution` rejects it — which is the
		// import that has to survive bundling.
		await seed("r3", "codex-auto-review", "gpt-5.6-luna", NOW - 40_000);

		const response = await createAnalyticsHandler(makeContext(dbOps))(
			new URLSearchParams({ range: "24h", sections: "modelDistribution" }),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("x-clankermux-analytics-mode")).toBe("worker");

		const body = (await response.json()) as {
			modelDistribution?: Array<{
				model: string;
				count: number;
				substitutedFrom?: string;
			}>;
		};
		const rows = body.modelDistribution ?? [];
		const substituted = rows.filter((row) => row.substitutedFrom);
		const ordinary = rows.filter((row) => !row.substitutedFrom);

		expect(substituted).toHaveLength(1);
		expect(substituted[0]?.substitutedFrom).toBe("gpt-6-astra");
		expect(substituted[0]?.count).toBe(1);
		// The genuine request and the backend-resolved one, together.
		expect(ordinary).toHaveLength(1);
		expect(ordinary[0]?.count).toBe(2);
	});

	// The provider decides whether a rename is a swap, and it is packed into the
	// same scalar column as the origin so the query keeps ONE correlated
	// subquery per row. Packing it in SQL and splitting it in TypeScript is a
	// seam the bundle has to carry across, so it is pinned in the worker rather
	// than only on the main thread.
	it("resolves the answering provider inside the worker", async () => {
		await dbOps.getAdapter().run(
			`INSERT INTO accounts (id, name, provider, refresh_token, created_at, priority, request_count)
			 VALUES ('acct-1', 'SuperGrok', 'grok-subscription', 'tok', ?, 0, 0)`,
			[NOW],
		);
		// Same two ids either side: one provider renames its own model, the
		// other really swapped.
		await seed(
			"r1",
			"grok-4.6",
			"grok-4.6-build",
			NOW - 60_000,
			"grok-subscription",
		);
		await seed("r2", "grok-4.6", "grok-4.6-build", NOW - 50_000, "openrouter");

		const response = await createAnalyticsHandler(makeContext(dbOps))(
			new URLSearchParams({ range: "24h", sections: "modelDistribution" }),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("x-clankermux-analytics-mode")).toBe("worker");

		const body = (await response.json()) as {
			modelDistribution?: Array<{
				model: string;
				count: number;
				substitutedFrom?: string;
			}>;
		};
		const rows = body.modelDistribution ?? [];
		const substituted = rows.filter((row) => row.substitutedFrom);
		const ordinary = rows.filter((row) => !row.substitutedFrom);

		expect(ordinary).toHaveLength(1);
		expect(ordinary[0]?.count).toBe(1);
		expect(substituted).toHaveLength(1);
		expect(substituted[0]?.substitutedFrom).toBe("grok-4.6");
		expect(substituted[0]?.count).toBe(1);
	});
});
