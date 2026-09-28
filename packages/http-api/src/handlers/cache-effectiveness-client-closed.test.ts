import { Database } from "bun:sqlite";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	setSystemTime,
} from "bun:test";
import {
	BunSqlAdapter,
	CacheKeepaliveSnapshotRepository,
	ensureSchema,
	RequestRepository,
	UsageSnapshotRepository,
} from "@clankermux/database";
import {
	type CacheEffectivenessResponse,
	CLIENT_CLOSED_REQUEST,
} from "@clankermux/types";
import type { APIContext } from "../types";
import { createCacheEffectivenessHandler } from "./cache-effectiveness-direct";

const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);

/**
 * The work volume the keepalive savings are normalized by counts requests
 * with an outcome. A client that left before any response adds none.
 */
describe("cache effectiveness and requests without an outcome", () => {
	let db: Database;
	let adapter: BunSqlAdapter;
	let requests: RequestRepository;

	beforeEach(async () => {
		db = new Database(":memory:");
		ensureSchema(db);
		adapter = new BunSqlAdapter(db);
		requests = new RequestRepository(adapter);
		setSystemTime(new Date(NOW));
		const keepalive = new CacheKeepaliveSnapshotRepository(adapter);
		// Counters are cumulative; the window reads the growth between samples.
		for (const [sampledAt, hits] of [
			[NOW - 120_000, 0],
			[NOW - 60_000, 2],
		] as const)
			await keepalive.insertSnapshot({
				sampledAt,
				warmSessions: 1,
				promotedSessions: 0,
				totalBytes: 10,
				keepalivesSent: hits,
				hits,
				misses: 0,
				failures: 0,
				spentUsd: 0,
				savedUsd: 0,
				warmResumes: hits,
				savedUsd5m: 0,
			});
		await new UsageSnapshotRepository(adapter).insertSnapshots([
			{
				accountId: "acct-a",
				provider: "anthropic",
				sampledAt: NOW - 60_000,
				fiveHourPct: 40,
				fiveHourReset: null,
				sevenDayPct: 20,
				sevenDayReset: null,
				observedAt: null,
				planTier: null,
				rateLimitTier: null,
			},
		]);
	});
	afterEach(() => {
		db.close();
		setSystemTime();
	});

	const report = async () =>
		(await (
			await createCacheEffectivenessHandler({
				dbOps: { getAdapter: () => adapter },
			} as unknown as APIContext)(new URLSearchParams({ range: "24h" }))
		).json()) as CacheEffectivenessResponse;

	const saveAbort = (id: string) =>
		requests.save({
			id,
			method: "POST",
			path: "/v1/messages",
			accountUsed: "acct-a",
			statusCode: 499,
			success: null,
			errorMessage: CLIENT_CLOSED_REQUEST,
			responseTime: 30_000,
			failoverAttempts: 0,
			projectAttributionSource: null,
		});

	it("reads an abort-only range as no work", async () => {
		await saveAbort("abort");
		const body = await report();
		expect(body.totalRequests).toBe(0);
		expect(body.totalPromptTokens).toBe(0);
		// The keepalive and usage measurements are not request rows.
		expect(body.hits).toBe(2);
		expect(body.poolPeakSevenDayPct).toBe(20);
	});

	it("reports the same when aborts are added", async () => {
		await requests.save({
			id: "ok",
			method: "POST",
			path: "/v1/messages",
			accountUsed: "acct-a",
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 1_000,
			failoverAttempts: 0,
			projectAttributionSource: null,
			usage: { model: "m", inputTokens: 100, cacheReadInputTokens: 900 },
		});
		const before = await report();
		await saveAbort("abort-1");
		await saveAbort("abort-2");
		expect(await report()).toEqual(before);
		expect(before.totalRequests).toBe(1);
	});
});
