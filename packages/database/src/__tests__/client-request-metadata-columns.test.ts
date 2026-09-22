/**
 * Tests for `requests.correlation_tag` + `requests.usage_source` — the two
 * columns the client-facing request lookup reads.
 *
 * They take OPPOSITE upsert clauses, and getting either backwards is silent:
 *
 *  - `correlation_tag` is an ingress fact, so EXCLUDED wins and the usage-patch
 *    re-upsert (which carries no tag) must not null it.
 *  - `usage_source` is WRITE-ONCE, so the STORED value wins. A reader treats a
 *    non-NULL value as a promise that the row's accounting is finished; a write
 *    that could replace one would make that promise worthless.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ADDITIVE_COLUMNS, ensureSchema } from "../migrations";
import {
	type RequestData,
	RequestRepository,
} from "../repositories/request.repository";

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	return db;
}

function requestData(overrides: Partial<RequestData> = {}): RequestData {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		accountUsed: "acct-a",
		statusCode: 200,
		success: true,
		errorMessage: null,
		responseTime: 1_200,
		failoverAttempts: 0,
		projectAttributionSource: null,
		...overrides,
	};
}

function readRow(
	db: Database,
	id = "req-1",
): { correlation_tag: string | null; usage_source: string | null } | null {
	return db
		.query(`SELECT correlation_tag, usage_source FROM requests WHERE id = ?`)
		.get(id) as {
		correlation_tag: string | null;
		usage_source: string | null;
	} | null;
}

describe("requests client-metadata columns", () => {
	let db: Database;
	let repo: RequestRepository;

	beforeEach(() => {
		db = makeDb();
		repo = new RequestRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("fresh schema has both columns", () => {
		const names = new Set(
			(db.query(`PRAGMA table_info(requests)`).all() as { name: string }[]).map(
				(c) => c.name,
			),
		);
		expect(names.has("correlation_tag")).toBe(true);
		expect(names.has("usage_source")).toBe(true);
	});

	// Step 2 of the migration contract. Without an entry each, an existing live
	// database gains neither column and nothing errors at startup — the first
	// symptom would be a runtime `no such column` on a client lookup.
	it("carries an ADDITIVE_COLUMNS entry for each, so upgraded databases gain them", () => {
		const entries = ADDITIVE_COLUMNS.filter((e) => e.table === "requests");
		expect(entries.map((e) => e.column)).toContain("correlation_tag");
		expect(entries.map((e) => e.column)).toContain("usage_source");
	});

	it("has the partial correlation-tag index", () => {
		const index = db
			.query(
				`SELECT sql FROM sqlite_master
				 WHERE type = 'index' AND name = 'idx_requests_correlation_tag'`,
			)
			.get() as { sql: string } | null;
		expect(index?.sql).toContain("WHERE correlation_tag IS NOT NULL");
	});

	it("round-trips both values on insert", async () => {
		await repo.save(
			requestData({ correlationTag: "run-42", usageSource: "provider" }),
		);
		expect(readRow(db)).toEqual({
			correlation_tag: "run-42",
			usage_source: "provider",
		});
	});

	it("stores NULL when the fields are omitted", async () => {
		await repo.save(requestData());
		expect(readRow(db)).toEqual({
			correlation_tag: null,
			usage_source: null,
		});
	});

	it("a later upsert without the tag does not clobber it", async () => {
		await repo.save(requestData({ correlationTag: "run-42" }));
		await repo.save(requestData());
		expect(readRow(db)?.correlation_tag).toBe("run-42");
	});

	it("a later upsert cannot overwrite a stored usage_source", async () => {
		await repo.save(requestData({ usageSource: "provider" }));
		await repo.save(requestData({ usageSource: "none" }));
		expect(readRow(db)?.usage_source).toBe("provider");
	});

	it("lets a later upsert fill in a usage_source the first write did not have", async () => {
		await repo.save(requestData());
		await repo.save(requestData({ usageSource: "approximate" }));
		expect(readRow(db)?.usage_source).toBe("approximate");
	});

	it("fills usage_source in on the late usage patch", async () => {
		await repo.save(requestData());
		await repo.updateUsage(
			"req-1",
			{ model: "claude-sonnet-4-5", outputTokens: 7 },
			3_000,
			undefined,
			"provider",
		);
		expect(readRow(db)?.usage_source).toBe("provider");
	});

	/**
	 * `finalized` is published as a promise that no later write can change the
	 * row's accounting, and `usageSource` is part of that accounting. Committing
	 * the token vector and the provenance as two statements breaks it: between
	 * them the row is stamped and tokened with `usage_source` still NULL, which
	 * the client DTO publishes as finalized with an `approximate` source, and
	 * the same row answers `provider` once the second statement lands.
	 *
	 * Observed at the adapter, which is the only place the intermediate commit
	 * is visible — each statement is its own transaction, so a concurrent reader
	 * genuinely sees it.
	 */
	it("settles usage_source in the same statement that finalizes the row", async () => {
		interface Snapshot {
			usage_source: string | null;
			usage_finalized_at: number | null;
			total_tokens: number | null;
			model: string | null;
		}
		const observed: Snapshot[] = [];
		const snapshot = () =>
			db
				.query(
					`SELECT usage_source, usage_finalized_at, total_tokens, model
					 FROM requests WHERE id = 'req-1'`,
				)
				.get() as Snapshot | null;

		class ObservingAdapter extends BunSqlAdapter {
			async run(sqlStr: string, params: unknown[] = []): Promise<void> {
				await super.run(sqlStr, params);
				const row = snapshot();
				if (row) observed.push(row);
			}
		}

		const observing = new RequestRepository(new ObservingAdapter(db));
		await observing.save(requestData());
		observed.length = 0; // the insert is not the window under test

		await observing.updateUsage(
			"req-1",
			{ model: "claude-sonnet-4-5", outputTokens: 7, totalTokens: 7 },
			3_000,
			undefined,
			"provider",
		);

		expect(observed.length).toBeGreaterThan(0);
		expect(readRow(db)?.usage_source).toBe("provider");

		// `isClientRequestFinalized`, restated over the columns: this package
		// cannot import the DTO that owns it.
		const finalized = (s: Snapshot) =>
			s.usage_source != null ||
			s.usage_finalized_at != null ||
			s.model != null ||
			s.total_tokens != null;
		expect(
			observed.filter((s) => finalized(s) && s.usage_source !== "provider"),
		).toEqual([]);
	});

	it("settles usage_source on a patch that carried NO token vector", async () => {
		await repo.save(requestData());
		await repo.updateUsage("req-1", undefined, null, undefined, "none");
		expect(readRow(db)?.usage_source).toBe("none");
	});

	it("does NOT let the late usage patch overwrite a stored usage_source", async () => {
		await repo.save(requestData({ usageSource: "approximate" }));
		await repo.updateUsage(
			"req-1",
			{ model: "claude-sonnet-4-5", outputTokens: 7 },
			3_000,
			undefined,
			"provider",
		);
		expect(readRow(db)?.usage_source).toBe("approximate");
	});

	it("markUsageSource writes once and then leaves the value alone", async () => {
		await repo.save(requestData());
		await repo.markUsageSource("req-1", "none");
		expect(readRow(db)?.usage_source).toBe("none");
		await repo.markUsageSource("req-1", "provider");
		expect(readRow(db)?.usage_source).toBe("none");
	});

	it("leaves the tag alone across a usage patch", async () => {
		await repo.save(requestData({ correlationTag: "run-42" }));
		await repo.updateUsage(
			"req-1",
			{ model: "claude-sonnet-4-5", outputTokens: 7 },
			3_000,
			undefined,
			"provider",
		);
		expect(readRow(db)?.correlation_tag).toBe("run-42");
	});
});
