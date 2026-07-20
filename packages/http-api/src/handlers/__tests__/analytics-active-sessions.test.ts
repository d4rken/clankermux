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
import type { APIContext } from "../../types";
import { createAnalyticsHandler } from "../analytics";
import {
	clearAnalyticsCachesForTests,
	terminateAnalyticsWorker,
} from "../analytics-runner";

let tmpDir: string;
let dbOps: DatabaseOperations;

beforeEach(() => {
	clearAnalyticsCachesForTests();
	tmpDir = mkdtempSync(join(tmpdir(), "clankermux-active-sessions-"));
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

function context(): APIContext {
	return {
		db: dbOps.getAdapter(),
		config: {} as APIContext["config"],
		dbOps,
	};
}

async function insertAccount(id: string, name: string): Promise<void> {
	await dbOps
		.getAdapter()
		.run("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)", [
			id,
			name,
			Date.now(),
		]);
}

// Raw INSERT (not RequestRepository.save) so the request timestamp is
// deterministic — save() hardcodes Date.now() and ignores any passed value,
// which every sibling analytics test also works around this way.
async function insertRequest(opts: {
	id: string;
	timestamp: number;
	accountUsed?: string | null;
	model?: string;
	project?: string | null;
	success?: boolean;
}): Promise<void> {
	await dbOps.getAdapter().run(
		`INSERT INTO requests (
			id, timestamp, method, path, account_used, status_code, success,
			response_time_ms, failover_attempts, model, project
		) VALUES (?, ?, 'POST', '/v1/messages', ?, 200, ?, 100, 0, ?, ?)`,
		[
			opts.id,
			opts.timestamp,
			opts.accountUsed ?? null,
			opts.success ?? true,
			opts.model ?? "claude-opus",
			opts.project ?? null,
		],
	);
}

// The active-sessions series buckets on requests.timestamp (like every other
// time series), NOT request_routing.created_at — so the request's timestamp is
// what places a session in a bucket. created_at is still seeded (it's the
// request START time) but must not affect bucketing; see the multi-bucket test
// where the two deliberately diverge.
async function insertRouting(opts: {
	requestId: string;
	affinityScope: string | null;
	affinityKeyHash: string | null;
	createdAt: number;
	selectedAccountId?: string | null;
}): Promise<void> {
	await dbOps.getAdapter().run(
		`INSERT INTO request_routing (
			request_id, strategy, decision, affinity_scope, affinity_key_hash,
			selected_account_id, failover_attempts, created_at
		) VALUES (?, 'session', 'sticky', ?, ?, ?, 0, ?)`,
		[
			opts.requestId,
			opts.affinityScope,
			opts.affinityKeyHash,
			opts.selectedAccountId ?? null,
			opts.createdAt,
		],
	);
}

const HOUR = 60 * 60 * 1000;

// Mid-bucket anchor so seeds at base±minutes never straddle an hour boundary
// (the 24h range buckets by 1h, mirroring the timeSeries query).
function bucketBase(): number {
	return Math.floor(Date.now() / HOUR) * HOUR;
}

async function fetchAnalytics(
	params: Record<string, string>,
): Promise<ReturnType<JSON["parse"]>> {
	const response = await createAnalyticsHandler(context())(
		new URLSearchParams({ range: "24h", ...params }),
	);
	expect(response.status).toBe(200);
	return response.json();
}

describe("analytics activeSessions", () => {
	it("returns empty series and zero total when there are no routing rows", async () => {
		await insertRequest({ id: "bare", timestamp: bucketBase() });

		const data = await fetchAnalytics({});

		expect(data.activeSessions).toEqual({
			timeSeries: [],
			totalDistinctSessions: 0,
			perAccount: [],
		});
	});

	it("counts distinct sessions per bucket per scope", async () => {
		const base = bucketBase();
		// claude_session: two distinct hashes (cs-a duplicated across two requests
		// to prove COUNT(DISTINCT) collapses it to one).
		await insertRequest({ id: "r-csa1", timestamp: base + 60 * 1000 });
		await insertRouting({
			requestId: "r-csa1",
			affinityScope: "claude_session",
			affinityKeyHash: "cs-a",
			createdAt: base + 60 * 1000,
		});
		await insertRequest({ id: "r-csa2", timestamp: base + 2 * 60 * 1000 });
		await insertRouting({
			requestId: "r-csa2",
			affinityScope: "claude_session",
			affinityKeyHash: "cs-a",
			createdAt: base + 2 * 60 * 1000,
		});
		await insertRequest({ id: "r-csb", timestamp: base + 3 * 60 * 1000 });
		await insertRouting({
			requestId: "r-csb",
			affinityScope: "claude_session",
			affinityKeyHash: "cs-b",
			createdAt: base + 3 * 60 * 1000,
		});
		// codex_thread: one hash.
		await insertRequest({ id: "r-ct", timestamp: base + 4 * 60 * 1000 });
		await insertRouting({
			requestId: "r-ct",
			affinityScope: "codex_thread",
			affinityKeyHash: "ct-a",
			createdAt: base + 4 * 60 * 1000,
		});
		// project: one hash.
		await insertRequest({ id: "r-pr", timestamp: base + 5 * 60 * 1000 });
		await insertRouting({
			requestId: "r-pr",
			affinityScope: "project",
			affinityKeyHash: "pr-a",
			createdAt: base + 5 * 60 * 1000,
		});

		const data = await fetchAnalytics({});
		const as = data.activeSessions;

		expect(as.timeSeries).toEqual(
			expect.arrayContaining([
				{ ts: base, scope: "claude_session", sessions: 2 },
				{ ts: base, scope: "codex_thread", sessions: 1 },
				{ ts: base, scope: "project", sessions: 1 },
			]),
		);
		expect(as.timeSeries).toHaveLength(3);
		// cs-a, cs-b, ct-a, pr-a
		expect(as.totalDistinctSessions).toBe(4);
	});

	it("counts a multi-bucket session in every bucket it touches but once in the total", async () => {
		const base = bucketBase();
		// One session ("multi") makes a request in the previous hour and again in
		// the current hour — two request_routing rows, same hash, different bucket.
		// created_at is deliberately set to the OPPOSITE bucket from timestamp on
		// each row: if bucketing wrongly followed created_at the two points would
		// swap buckets, so the assertion below proves the series buckets on
		// requests.timestamp.
		await insertRequest({
			id: "r-m1",
			timestamp: base - HOUR + 20 * 60 * 1000,
		});
		await insertRouting({
			requestId: "r-m1",
			affinityScope: "claude_session",
			affinityKeyHash: "multi",
			createdAt: base + 10 * 60 * 1000, // current hour — diverges from timestamp
		});
		await insertRequest({ id: "r-m2", timestamp: base + 10 * 60 * 1000 });
		await insertRouting({
			requestId: "r-m2",
			affinityScope: "claude_session",
			affinityKeyHash: "multi",
			createdAt: base - HOUR + 20 * 60 * 1000, // previous hour — diverges from timestamp
		});

		const data = await fetchAnalytics({});
		const as = data.activeSessions;

		// Present in BOTH buckets...
		expect(as.timeSeries).toEqual([
			{ ts: base - HOUR, scope: "claude_session", sessions: 1 },
			{ ts: base, scope: "claude_session", sessions: 1 },
		]);
		// ...but the same distinct session counted only ONCE overall.
		expect(as.totalDistinctSessions).toBe(1);
	});

	it("honors the accounts filter via the JOIN back to requests", async () => {
		const base = bucketBase();
		await insertAccount("acc-A", "Alpha");
		await insertAccount("acc-B", "Beta");
		// Session on account A.
		await insertRequest({
			id: "r-a",
			timestamp: base + 60 * 1000,
			accountUsed: "acc-A",
		});
		await insertRouting({
			requestId: "r-a",
			affinityScope: "claude_session",
			affinityKeyHash: "sess-a",
			createdAt: base + 60 * 1000,
			selectedAccountId: "acc-A",
		});
		// Session on account B.
		await insertRequest({
			id: "r-b",
			timestamp: base + 2 * 60 * 1000,
			accountUsed: "acc-B",
		});
		await insertRouting({
			requestId: "r-b",
			affinityScope: "claude_session",
			affinityKeyHash: "sess-b",
			createdAt: base + 2 * 60 * 1000,
			selectedAccountId: "acc-B",
		});

		// Filtering to Beta must exclude the account-A session entirely.
		const data = await fetchAnalytics({ accounts: "Beta" });
		const as = data.activeSessions;

		expect(as.timeSeries).toEqual([
			{ ts: base, scope: "claude_session", sessions: 1 },
		]);
		expect(as.totalDistinctSessions).toBe(1);
		// The same filter scopes the per-account breakdown to Beta only.
		expect(as.perAccount).toEqual([
			{ accountId: "acc-B", accountName: "Beta", sessions: 1 },
		]);
	});

	it("ignores routing rows with a NULL affinity_key_hash", async () => {
		const base = bucketBase();
		// A routed request that was never a tracked session (no affinity hash).
		await insertRequest({ id: "r-null", timestamp: base + 60 * 1000 });
		await insertRouting({
			requestId: "r-null",
			affinityScope: "claude_session",
			affinityKeyHash: null,
			createdAt: base + 60 * 1000,
		});
		// A request with no routing row at all.
		await insertRequest({ id: "r-untracked", timestamp: base + 2 * 60 * 1000 });

		const data = await fetchAnalytics({});

		expect(data.activeSessions).toEqual({
			timeSeries: [],
			totalDistinctSessions: 0,
			perAccount: [],
		});
	});

	it("breaks distinct sessions down per account, sorted DESC", async () => {
		const base = bucketBase();
		await insertAccount("acc-A", "Alpha");
		await insertAccount("acc-B", "Beta");
		// Alpha: two distinct sessions.
		await insertRequest({
			id: "r-a1",
			timestamp: base + 60 * 1000,
			accountUsed: "acc-A",
		});
		await insertRouting({
			requestId: "r-a1",
			affinityScope: "claude_session",
			affinityKeyHash: "sess-a1",
			createdAt: base + 60 * 1000,
			selectedAccountId: "acc-A",
		});
		await insertRequest({
			id: "r-a2",
			timestamp: base + 2 * 60 * 1000,
			accountUsed: "acc-A",
		});
		await insertRouting({
			requestId: "r-a2",
			affinityScope: "claude_session",
			affinityKeyHash: "sess-a2",
			createdAt: base + 2 * 60 * 1000,
			selectedAccountId: "acc-A",
		});
		// Beta: one distinct session.
		await insertRequest({
			id: "r-b1",
			timestamp: base + 3 * 60 * 1000,
			accountUsed: "acc-B",
		});
		await insertRouting({
			requestId: "r-b1",
			affinityScope: "claude_session",
			affinityKeyHash: "sess-b1",
			createdAt: base + 3 * 60 * 1000,
			selectedAccountId: "acc-B",
		});

		const data = await fetchAnalytics({});

		expect(data.activeSessions.perAccount).toEqual([
			{ accountId: "acc-A", accountName: "Alpha", sessions: 2 },
			{ accountId: "acc-B", accountName: "Beta", sessions: 1 },
		]);
	});

	it("collapses a duplicate hash within one account via COUNT(DISTINCT)", async () => {
		const base = bucketBase();
		await insertAccount("acc-A", "Alpha");
		// Same hash across two requests on the same account → one distinct session.
		await insertRequest({
			id: "r-d1",
			timestamp: base + 60 * 1000,
			accountUsed: "acc-A",
		});
		await insertRouting({
			requestId: "r-d1",
			affinityScope: "claude_session",
			affinityKeyHash: "dup",
			createdAt: base + 60 * 1000,
			selectedAccountId: "acc-A",
		});
		await insertRequest({
			id: "r-d2",
			timestamp: base + 2 * 60 * 1000,
			accountUsed: "acc-A",
		});
		await insertRouting({
			requestId: "r-d2",
			affinityScope: "claude_session",
			affinityKeyHash: "dup",
			createdAt: base + 2 * 60 * 1000,
			selectedAccountId: "acc-A",
		});

		const data = await fetchAnalytics({});

		expect(data.activeSessions.perAccount).toEqual([
			{ accountId: "acc-A", accountName: "Alpha", sessions: 1 },
		]);
	});

	it("groups a NULL selected_account_id under the NO_ACCOUNT_ID sentinel", async () => {
		const base = bucketBase();
		await insertRequest({ id: "r-n1", timestamp: base + 60 * 1000 });
		await insertRouting({
			requestId: "r-n1",
			affinityScope: "claude_session",
			affinityKeyHash: "orphan",
			createdAt: base + 60 * 1000,
			selectedAccountId: null,
		});

		const data = await fetchAnalytics({});

		expect(data.activeSessions.perAccount).toEqual([
			{ accountId: "no_account", accountName: "no_account", sessions: 1 },
		]);
	});

	it("falls back to the raw id when the selected account is unknown/deleted", async () => {
		const base = bucketBase();
		await insertAccount("acc-live", "LiveAcct");
		// Live account resolves via the accounts join.
		await insertRequest({
			id: "r-live",
			timestamp: base + 60 * 1000,
			accountUsed: "acc-live",
		});
		await insertRouting({
			requestId: "r-live",
			affinityScope: "claude_session",
			affinityKeyHash: "s-live",
			createdAt: base + 60 * 1000,
			selectedAccountId: "acc-live",
		});
		// Deleted/unknown account id — no accounts row → name falls back to the id.
		await insertRequest({ id: "r-gone", timestamp: base + 2 * 60 * 1000 });
		await insertRouting({
			requestId: "r-gone",
			affinityScope: "claude_session",
			affinityKeyHash: "s-gone",
			createdAt: base + 2 * 60 * 1000,
			selectedAccountId: "acc-deleted",
		});

		const data = await fetchAnalytics({});

		expect(data.activeSessions.perAccount).toEqual(
			expect.arrayContaining([
				{ accountId: "acc-live", accountName: "LiveAcct", sessions: 1 },
				{ accountId: "acc-deleted", accountName: "acc-deleted", sessions: 1 },
			]),
		);
		expect(data.activeSessions.perAccount).toHaveLength(2);
	});

	it("excludes rows with a NULL affinity_key_hash from perAccount", async () => {
		const base = bucketBase();
		await insertAccount("acc-A", "Alpha");
		// Routed request that was never a tracked session (no affinity hash).
		await insertRequest({
			id: "r-nohash",
			timestamp: base + 60 * 1000,
			accountUsed: "acc-A",
		});
		await insertRouting({
			requestId: "r-nohash",
			affinityScope: "claude_session",
			affinityKeyHash: null,
			createdAt: base + 60 * 1000,
			selectedAccountId: "acc-A",
		});

		const data = await fetchAnalytics({});

		expect(data.activeSessions.perAccount).toEqual([]);
	});
});
