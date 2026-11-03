import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { DatabaseOperations } from "@clankermux/database";
import { usageCache } from "@clankermux/providers";
import {
	clearCodexPayloadScanMemo,
	getCachedOrPersistedCodexUsage,
} from "../resolve-codex-usage";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * A stored `request_payloads` row, shaped the way the legacy recovery scan
 * reads it: the response headers of one retained request plus its status.
 */
function payloadRow(
	headers: Record<string, string>,
	status: number,
	timestampMs: number,
): { json: string; timestamp: number } {
	return {
		json: JSON.stringify({
			response: { headers, status },
			meta: { timestamp: timestampMs },
		}),
		timestamp: timestampMs,
	};
}

function makeDb(
	rows: Array<{ json: string; timestamp: number }>,
): ReturnType<DatabaseOperations["getAdapter"]> {
	return {
		query: async () =>
			rows.map((row, index) => ({
				id: String(index),
				timestamp: row.timestamp,
			})),
		get: async (_sql: string, params: unknown[]) =>
			rows[Number(params[0])] ?? null,
	} as unknown as ReturnType<DatabaseOperations["getAdapter"]>;
}

/**
 * A read-only resolution with no live cache entry and no persisted column, so
 * the stored-payload scan is the only channel that can answer. `seedCache:
 * false` keeps the shared `usageCache` singleton out of these tests entirely.
 */
function resolveFromPayloads(
	accountId: string,
	rows: Array<{ json: string; timestamp: number }>,
) {
	return getCachedOrPersistedCodexUsage(
		makeDb(rows),
		accountId,
		"codex-account",
		null,
		null,
		null,
		Date.now(),
		{ seedCache: false },
	);
}

describe("getCachedOrPersistedCodexUsage — stored-payload recovery", () => {
	beforeEach(() => {
		clearCodexPayloadScanMemo();
	});

	it("recovers a compressed row after skipping a corrupt row", async () => {
		const row = payloadRow(
			{
				"x-codex-primary-window-minutes": "10080",
				"x-codex-primary-used-percent": "42",
				"x-codex-primary-reset-at": String(
					Math.floor((Date.now() + DAY_MS) / 1000),
				),
			},
			200,
			Date.now() - HOUR_MS,
		);
		row.json = `zst:${(await Bun.zstdCompress(row.json)).toString("base64")}`;
		const result = await resolveFromPayloads("compressed", [
			{ json: "zst:bm90IHpzdGQ=", timestamp: Date.now() },
			row,
		]);
		expect(result.source).toBe("payload");
		expect(
			result.data &&
				"seven_day" in result.data &&
				result.data.seven_day?.utilization,
		).toBe(42);
	});

	it("recovers encrypted legacy and compressed payloads through the real repository", async () => {
		// A separate process gives the encryption singleton its own key without
		// changing the shared state of other HTTP handler tests.
		const child = Bun.spawn(
			[
				process.execPath,
				"--eval",
				`
			import { getCachedOrPersistedCodexUsage } from ${JSON.stringify(`${import.meta.dir}/../resolve-codex-usage.ts`)};
			import { encryptPayload } from ${JSON.stringify(`${import.meta.dir}/../../../../database/src/payload-encryption.ts`)};
			const now = Date.now();
			const json = JSON.stringify({ response: { status: 200, headers: {
				"x-codex-primary-window-minutes": "10080",
				"x-codex-primary-used-percent": "37",
				"x-codex-primary-reset-at": String(Math.floor((now + 86400000) / 1000))
			} }, meta: { timestamp: now } });
			for (const compressed of [false, true]) {
				const body = compressed ? "zst:" + (await Bun.zstdCompress(json)).toString("base64") : json;
				const stored = await encryptPayload(body);
				if (!stored.startsWith("enc:")) throw new Error("encryption premise failed");
				const db = { query: async () => [{id:"row", timestamp:now}], get: async () => ({json:stored}) };
				const result = await getCachedOrPersistedCodexUsage(db, String(compressed), "test", null, null, null, now, {seedCache:false});
				if (result.source !== "payload" || result.data?.seven_day?.utilization !== 37) throw new Error(JSON.stringify(result));
			}
		`,
			],
			{
				env: {
					...process.env,
					PAYLOAD_ENCRYPTION_KEY: "0123456789abcdef".repeat(4),
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exit, stderr] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
			new Response(child.stdout).text(),
		]);
		expect(stderr).not.toContain("error:");
		expect(exit).toBe(0);
	});

	it("recovers nothing from a 200 payload whose window reports no used-percent", async () => {
		const resetSec = Math.floor((Date.now() + 3 * DAY_MS) / 1000);
		const recovered = await resolveFromPayloads("codex-no-percent", [
			payloadRow(
				{
					"content-type": "application/json",
					"x-codex-primary-window-minutes": "10080",
					"x-codex-primary-reset-at": String(resetSec),
				},
				200,
				Date.now() - HOUR_MS,
			),
		]);

		// Identical to a payload that carries no Codex headers at all: a reset
		// without a percentage is not a reading.
		const control = await resolveFromPayloads("codex-no-headers", [
			payloadRow(
				{ "content-type": "application/json" },
				200,
				Date.now() - HOUR_MS,
			),
		]);

		expect(recovered).toEqual(control);
		expect(recovered.data).toBeNull();
		expect(recovered.source).toBeNull();
	});

	it("recovers a 100% weekly window from a stored 429 payload with the same headers", async () => {
		const resetSec = Math.floor((Date.now() + 3 * DAY_MS) / 1000);
		const recovered = await resolveFromPayloads("codex-429", [
			payloadRow(
				{
					"content-type": "application/json",
					"x-codex-primary-window-minutes": "10080",
					"x-codex-primary-reset-at": String(resetSec),
				},
				429,
				Date.now() - HOUR_MS,
			),
		]);

		expect(recovered.source).toBe("payload");
		const data = recovered.data;
		if (data === null || !("seven_day" in data)) {
			throw new Error(
				`expected Anthropic-shaped usage data with a weekly window, got ${JSON.stringify(data)}`,
			);
		}
		expect(data.seven_day?.utilization).toBe(100);
		expect(data.seven_day?.resets_at).toBe(
			new Date(resetSec * 1000).toISOString(),
		);
	});
});

/**
 * A db whose payload-scan query is counted, with rows the test can change
 * between calls. Each query sees the rows as they were when it STARTED; after
 * `hold()`, every query waits until `release(n)` or `reject(n)` settles the
 * n-th held one. `failNext()` makes the next query reject immediately.
 */
function makeCountingDb(rows: Array<{ json: string; timestamp: number }>) {
	let queries = 0;
	let holding = false;
	let failNext = false;
	const held: Array<{ resolve: () => void; reject: (error: Error) => void }> =
		[];
	// Payload bodies by row id, so a held query reads its own snapshot.
	const stored = new Map<string, { json: string }>();
	const db = {
		query: async () => {
			queries++;
			if (failNext) {
				failNext = false;
				throw new Error("query failed");
			}
			const ids = rows.map((row, index) => {
				const id = `${queries}:${index}`;
				stored.set(id, { json: row.json });
				return { id, timestamp: row.timestamp };
			});
			if (holding) {
				await new Promise<void>((resolve, reject) =>
					held.push({ resolve, reject }),
				);
			}
			return ids;
		},
		get: async (_sql: string, params: unknown[]) =>
			stored.get(String(params[0])) ?? null,
	} as unknown as ReturnType<DatabaseOperations["getAdapter"]>;
	return {
		db,
		rows,
		queries: () => queries,
		hold() {
			holding = true;
		},
		release(index: number) {
			held[index]?.resolve();
		},
		reject(index: number) {
			held[index]?.reject(new Error("query failed"));
		},
		failNext() {
			failNext = true;
		},
		/** Stop holding new queries; already-held ones still wait for release. */
		resume() {
			holding = false;
		},
	};
}

function weeklyUtilization(data: unknown): number | undefined {
	return (data as { seven_day?: { utilization?: number } } | null)?.seven_day
		?.utilization;
}

function weeklyHeaders(usedPercent: number, nowMs: number) {
	return {
		"x-codex-primary-window-minutes": "10080",
		"x-codex-primary-used-percent": String(usedPercent),
		"x-codex-primary-reset-at": String(Math.floor((nowMs + DAY_MS) / 1000)),
	};
}

describe("getCachedOrPersistedCodexUsage — remembered empty payload scans", () => {
	const BASE = 1_800_000_000_000;
	const MINUTE_MS = 60_000;
	// Fixed, so advancing the clock never changes the memo key.
	const LAST_USED = BASE - HOUR_MS;
	let now = BASE;
	const accountIds: string[] = [];

	function resolve(
		db: ReturnType<DatabaseOperations["getAdapter"]>,
		accountId: string,
		seedCache: boolean,
		opts: {
			lastUsed?: number;
			persistedJson?: string | null;
			persistedObservedAt?: number | null;
		} = {},
	) {
		accountIds.push(accountId);
		return getCachedOrPersistedCodexUsage(
			db,
			accountId,
			"codex-account",
			null,
			opts.persistedJson ?? null,
			opts.persistedObservedAt ?? null,
			opts.lastUsed ?? LAST_USED,
			{ seedCache },
		);
	}

	beforeEach(() => {
		clearCodexPayloadScanMemo();
		now = BASE;
		spyOn(Date, "now").mockImplementation(() => now);
	});

	afterEach(() => {
		// Entries here are stamped from BASE, which lies in the future.
		clearCodexPayloadScanMemo();
		(Date.now as unknown as { mockRestore(): void }).mockRestore();
		for (const id of accountIds.splice(0)) usageCache.delete(id);
	});

	it("reuses an empty read-only scan across minute-spaced polls until ten minutes pass", async () => {
		const fake = makeCountingDb([]);
		await resolve(fake.db, "neg-ro", false);
		now += MINUTE_MS;
		await resolve(fake.db, "neg-ro", false);
		now = BASE + 9 * MINUTE_MS;
		await resolve(fake.db, "neg-ro", false);
		expect(fake.queries()).toBe(1);

		now = BASE + 10 * MINUTE_MS + 1;
		await resolve(fake.db, "neg-ro", false);
		expect(fake.queries()).toBe(2);
	});

	it("recovers a payload that landed after an empty scan once the memo expires", async () => {
		const fake = makeCountingDb([]);
		expect((await resolve(fake.db, "late", false)).source).toBeNull();
		fake.rows.push(payloadRow(weeklyHeaders(33, BASE), 200, BASE - HOUR_MS));

		now = BASE + 9 * MINUTE_MS;
		expect((await resolve(fake.db, "late", false)).source).toBeNull();

		now = BASE + 10 * MINUTE_MS + 1;
		expect((await resolve(fake.db, "late", false)).source).toBe("payload");
	});

	it("still forgets a non-empty scan after ten seconds", async () => {
		const fake = makeCountingDb([
			payloadRow(weeklyHeaders(40, BASE), 200, BASE - HOUR_MS),
		]);
		expect((await resolve(fake.db, "pos-ro", false)).source).toBe("payload");
		now += 11_000;
		expect((await resolve(fake.db, "pos-ro", false)).source).toBe("payload");
		expect(fake.queries()).toBe(2);
	});

	it("retires a remembered empty scan when last_used moves", async () => {
		const fake = makeCountingDb([]);
		await resolve(fake.db, "rekey", false);
		await resolve(fake.db, "rekey", false, { lastUsed: LAST_USED + 1 });
		expect(fake.queries()).toBe(2);
	});

	it("shares an empty scan run by a writer with later readers and writers", async () => {
		const fake = makeCountingDb([]);
		await resolve(fake.db, "neg-w", true);
		now += MINUTE_MS;
		await resolve(fake.db, "neg-w", false);
		await resolve(fake.db, "neg-w", true);
		expect(fake.queries()).toBe(1);
	});

	it("lets a writer reuse an empty scan a reader ran", async () => {
		const fake = makeCountingDb([]);
		await resolve(fake.db, "neg-rw", false);
		now += MINUTE_MS;
		await resolve(fake.db, "neg-rw", true);
		expect(fake.queries()).toBe(1);
	});

	it("never hands a writer a scan that is still in flight", async () => {
		const fake = makeCountingDb([]);
		fake.hold();
		const reader = resolve(fake.db, "inflight", false);
		const writer = resolve(fake.db, "inflight", true);
		fake.resume();
		fake.release(0);
		fake.release(1);
		await Promise.all([reader, writer]);
		expect(fake.queries()).toBe(2);
	});

	it("lets a writer's empty scan replace an in-flight reader that then finds a reading", async () => {
		const fake = makeCountingDb([
			payloadRow(weeklyHeaders(44, BASE), 200, BASE - HOUR_MS),
		]);
		fake.hold();
		const reader = resolve(fake.db, "race", false);
		fake.rows.length = 0;
		const writer = resolve(fake.db, "race", true);
		fake.resume();
		fake.release(1);
		expect((await writer).source).toBeNull();
		fake.release(0);
		// The reader still gets its own scan's answer...
		expect((await reader).source).toBe("payload");
		expect(usageCache.peek("race")).toBeNull();
		// ...but the writer replaced the entry it saw at start, so later callers
		// inherit its empty result.
		now += MINUTE_MS;
		expect((await resolve(fake.db, "race", false)).source).toBeNull();
		expect(fake.queries()).toBe(2);
	});

	it("never hands a writer a remembered reading, and the writer seeds the cache with its own", async () => {
		const fake = makeCountingDb([
			payloadRow(weeklyHeaders(55, BASE), 200, BASE - HOUR_MS),
		]);
		const read = await resolve(fake.db, "pos-w", false);
		expect(weeklyUtilization(read.data)).toBe(55);
		expect(usageCache.peek("pos-w")).toBeNull();

		fake.rows[0] = payloadRow(weeklyHeaders(66, BASE), 200, BASE - HOUR_MS);
		const written = await resolve(fake.db, "pos-w", true);
		expect(written.source).toBe("payload");
		expect(weeklyUtilization(written.data)).toBe(66);
		expect(weeklyUtilization(usageCache.peek("pos-w"))).toBe(66);
	});

	it("lets a writer replace an empty scan remembered under an older key", async () => {
		const fake = makeCountingDb([]);
		await resolve(fake.db, "writer-rekey", true);
		await resolve(fake.db, "writer-rekey", true, { lastUsed: LAST_USED + 1 });
		expect(fake.queries()).toBe(2);
		now += MINUTE_MS;
		await resolve(fake.db, "writer-rekey", true, { lastUsed: LAST_USED + 1 });
		expect(fake.queries()).toBe(2);
	});

	it("serves the persisted column and its credits on a remembered empty scan", async () => {
		const fake = makeCountingDb([]);
		const persistedJson = JSON.stringify({
			five_hour: null,
			seven_day: {
				utilization: 21,
				resets_at: new Date(BASE + DAY_MS).toISOString(),
			},
			codexCredits: {
				hasCredits: true,
				balance: 5,
				unlimited: false,
				planType: null,
				weeklyUsedPct: null,
			},
		});
		const opts = { persistedJson, persistedObservedAt: LAST_USED - 80_000 };
		const first = await resolve(fake.db, "column", true, opts);
		now += MINUTE_MS;
		const second = await resolve(fake.db, "column", true, opts);
		expect(fake.queries()).toBe(1);
		for (const result of [first, second]) {
			expect(result.source).toBe("column");
			expect(result.observedAtMs).toBe(LAST_USED - 80_000);
			expect(result.persistedCredits?.balance).toBe(5);
		}
	});

	it("does not let an older reader scan that settles last overwrite a newer key", async () => {
		const fake = makeCountingDb([]);
		fake.hold();
		const stale = resolve(fake.db, "supersede", false);
		const fresh = resolve(fake.db, "supersede", false, {
			lastUsed: LAST_USED + 1,
		});
		fake.resume();
		fake.release(1);
		await fresh;
		fake.release(0);
		await stale;
		now += MINUTE_MS;
		// The newer key's empty result is the one remembered...
		await resolve(fake.db, "supersede", false, { lastUsed: LAST_USED + 1 });
		expect(fake.queries()).toBe(2);
		// ...and the superseded older key scans again.
		await resolve(fake.db, "supersede", false);
		expect(fake.queries()).toBe(3);
	});

	it("does not let an older writer scan that settles last overwrite a newer key", async () => {
		const fake = makeCountingDb([]);
		fake.hold();
		const stale = resolve(fake.db, "supersede-w", true);
		const fresh = resolve(fake.db, "supersede-w", false, {
			lastUsed: LAST_USED + 1,
		});
		fake.resume();
		fake.release(1);
		await fresh;
		fake.release(0);
		await stale;
		now += MINUTE_MS;
		await resolve(fake.db, "supersede-w", true, { lastUsed: LAST_USED + 1 });
		expect(fake.queries()).toBe(2);
		await resolve(fake.db, "supersede-w", true);
		expect(fake.queries()).toBe(3);
	});

	it("does not extend a remembered empty scan on a hit", async () => {
		const fake = makeCountingDb([]);
		await resolve(fake.db, "no-renew", false);
		now = BASE + 9 * MINUTE_MS;
		await resolve(fake.db, "no-renew", false);
		now = BASE + 10 * MINUTE_MS + 1;
		await resolve(fake.db, "no-renew", false);
		expect(fake.queries()).toBe(2);
	});

	it("counts the empty-scan lifetime from settlement, not from the start of the scan", async () => {
		const fake = makeCountingDb([]);
		fake.hold();
		const reader = resolve(fake.db, "settle", false);
		fake.resume();
		now = BASE + 5 * MINUTE_MS;
		fake.release(0);
		await reader;
		now = BASE + 14 * MINUTE_MS;
		await resolve(fake.db, "settle", false);
		expect(fake.queries()).toBe(1);
		now = BASE + 15 * MINUTE_MS + 1;
		await resolve(fake.db, "settle", false);
		expect(fake.queries()).toBe(2);
	});

	it("does not let a writer's empty scan replace a reader that started after it", async () => {
		const fake = makeCountingDb([]);
		fake.hold();
		const writer = resolve(fake.db, "late-reader", true);
		fake.rows.push(payloadRow(weeklyHeaders(88, BASE), 200, BASE - HOUR_MS));
		const reader = resolve(fake.db, "late-reader", false);
		fake.resume();
		fake.release(0);
		expect((await writer).source).toBeNull();
		fake.release(1);
		expect((await reader).source).toBe("payload");
		now += 5_000;
		expect((await resolve(fake.db, "late-reader", false)).source).toBe(
			"payload",
		);
		expect(fake.queries()).toBe(2);
	});

	it("leaves an empty entry that settled during a writer's scan on its own expiry", async () => {
		const fake = makeCountingDb([]);
		fake.hold();
		const writer = resolve(fake.db, "kept", true);
		now = BASE + MINUTE_MS;
		const reader = resolve(fake.db, "kept", false);
		fake.resume();
		fake.release(1);
		// Settles empty at BASE + 1 min, so it expires at BASE + 11 min.
		await reader;
		now = BASE + 2 * MINUTE_MS;
		fake.release(0);
		await writer;
		now = BASE + 10.5 * MINUTE_MS;
		await resolve(fake.db, "kept", false);
		expect(fake.queries()).toBe(2);
		now = BASE + 11 * MINUTE_MS + 1;
		await resolve(fake.db, "kept", false);
		expect(fake.queries()).toBe(3);
	});

	it("forgets a rejected reader scan and propagates its error", async () => {
		const fake = makeCountingDb([]);
		fake.failNext();
		await expect(resolve(fake.db, "rej-r", false)).rejects.toThrow(
			"query failed",
		);
		await resolve(fake.db, "rej-r", false);
		expect(fake.queries()).toBe(2);
	});

	it("propagates a writer's failed scan and publishes nothing for it", async () => {
		const fake = makeCountingDb([]);
		fake.failNext();
		await expect(resolve(fake.db, "rej-w", true)).rejects.toThrow(
			"query failed",
		);
		// The second writer scans (nothing was published) and publishes; the
		// third reuses that.
		await resolve(fake.db, "rej-w", true);
		await resolve(fake.db, "rej-w", true);
		expect(fake.queries()).toBe(2);
	});

	it("does not let an older scan that rejects last evict a newer key", async () => {
		const fake = makeCountingDb([]);
		fake.hold();
		const stale = resolve(fake.db, "rej-stale", false);
		const fresh = resolve(fake.db, "rej-stale", false, {
			lastUsed: LAST_USED + 1,
		});
		fake.resume();
		// Not `expect(stale).rejects`: that waits for `stale` to settle, which
		// only happens after the release below.
		const staleError = stale.then(
			() => null,
			(error: Error) => error.message,
		);
		fake.release(1);
		await fresh;
		fake.reject(0);
		expect(await staleError).toBe("query failed");
		now += MINUTE_MS;
		await resolve(fake.db, "rej-stale", false, { lastUsed: LAST_USED + 1 });
		expect(fake.queries()).toBe(2);
	});

	const CORRUPT_ROW = { json: "zst:bm90IHpzdGQ=", timestamp: BASE - HOUR_MS };

	it("keeps a scan that hit an unreadable row for ten seconds only", async () => {
		const fake = makeCountingDb([{ ...CORRUPT_ROW }]);
		expect((await resolve(fake.db, "corrupt", false)).source).toBeNull();
		now += 5_000;
		await resolve(fake.db, "corrupt", false);
		expect(fake.queries()).toBe(1);
		now += 6_000;
		await resolve(fake.db, "corrupt", false);
		expect(fake.queries()).toBe(2);
	});

	it("never publishes a writer scan that hit an unreadable row", async () => {
		const fake = makeCountingDb([{ ...CORRUPT_ROW }]);
		await resolve(fake.db, "corrupt-w", true);
		await resolve(fake.db, "corrupt-w", true);
		expect(fake.queries()).toBe(2);
	});

	it("recovers a reading once the unreadable row is replaced", async () => {
		const fake = makeCountingDb([{ ...CORRUPT_ROW }]);
		expect((await resolve(fake.db, "corrupt-fix", false)).source).toBeNull();
		fake.rows[0] = payloadRow(weeklyHeaders(77, BASE), 200, BASE - HOUR_MS);
		now += 11_000;
		const recovered = await resolve(fake.db, "corrupt-fix", false);
		expect(recovered.source).toBe("payload");
		expect(weeklyUtilization(recovered.data)).toBe(77);
		expect(fake.queries()).toBe(2);
	});
});
