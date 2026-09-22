import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MODEL_SUBSTITUTION_SUPPRESSION_REASON } from "@clankermux/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { RequestRepository } from "../request.repository";

/**
 * The two credential-scoped reads `/client/v1/requests/*` is built on, against
 * a real schema.
 *
 * `model_substitution_discards` is computed by a correlated count rather than
 * stored, and its reason is interpolated into that SQL rather than bound, so
 * the query is the only thing that can be wrong — a fake reader would pass
 * whatever these assertions claimed.
 */
describe("client request reads", () => {
	let db: Database;
	let repo: RequestRepository;

	const KEY = "key-1";
	const OTHER_KEY = "key-2";

	const insertRequest = (
		id: string,
		apiKeyId: string,
		timestamp: number,
		tag: string | null = "run-1",
	): void => {
		db.query(
			`INSERT INTO requests(id,timestamp,method,path,api_key_id,correlation_tag)
			 VALUES(?,?,?,?,?,?)`,
		).run(id, timestamp, "POST", "/v1/messages", apiKeyId, tag);
	};

	const insertAttempt = (
		requestId: string,
		kind: "upstream_send" | "local_reject",
		error: string | null,
	): void => {
		db.query(
			`INSERT INTO routing_attempts(
				id,request_id,route_snapshot_id,requested_model,kind,started_at,error)
			 VALUES(?,?,?,?,?,?,?)`,
		).run(
			crypto.randomUUID(),
			requestId,
			"snapshot-1",
			"claude-sonnet-5",
			kind,
			1,
			error,
		);
	};

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		repo = new RequestRepository(new BunSqlAdapter(db));
	});
	afterEach(() => db.close());

	it("counts a discarded substitution and ignores an attempt that cost nothing", async () => {
		insertRequest("r1", KEY, 100);
		insertAttempt("r1", "upstream_send", MODEL_SUBSTITUTION_SUPPRESSION_REASON);
		insertAttempt("r1", "upstream_send", "retryable_429");
		insertAttempt("r1", "upstream_send", null);

		expect(
			(await repo.getClientRequest(KEY, "r1"))?.model_substitution_discards,
		).toBe(1);
	});

	it("reports 0 for a request that never recorded an attempt", async () => {
		insertRequest("r1", KEY, 100);

		expect(
			(await repo.getClientRequest(KEY, "r1"))?.model_substitution_discards,
		).toBe(0);
	});

	it("does not count a local rejection carrying the same reason", async () => {
		// A rejection decided before dispatch discarded nothing, so `kind` is as
		// load-bearing as the reason itself.
		insertRequest("r1", KEY, 100);
		insertAttempt("r1", "local_reject", MODEL_SUBSTITUTION_SUPPRESSION_REASON);

		expect(
			(await repo.getClientRequest(KEY, "r1"))?.model_substitution_discards,
		).toBe(0);
	});

	it("counts every discard when no attempt ever succeeded", async () => {
		// Every candidate substituting ends the request 503 with nothing after the
		// last discard; the count is of discards, not of failovers that followed.
		insertRequest("r1", KEY, 100);
		insertAttempt("r1", "upstream_send", MODEL_SUBSTITUTION_SUPPRESSION_REASON);
		insertAttempt("r1", "upstream_send", MODEL_SUBSTITUTION_SUPPRESSION_REASON);

		expect(
			(await repo.getClientRequest(KEY, "r1"))?.model_substitution_discards,
		).toBe(2);
	});

	it("attributes discards to their own request only", async () => {
		insertRequest("r1", KEY, 100);
		insertRequest("r2", KEY, 200);
		insertAttempt("r1", "upstream_send", MODEL_SUBSTITUTION_SUPPRESSION_REASON);

		const page = await repo.listClientRequestsByTag({
			apiKeyId: KEY,
			tag: "run-1",
			limit: 10,
		});
		expect(
			page.map((row) => [row.id, row.model_substitution_discards]),
		).toEqual([
			["r1", 1],
			["r2", 0],
		]);
	});

	it("still refuses another key's row, by id and by tag", async () => {
		// The count is interpolated into the shared column list of both queries;
		// a bound parameter there would shift these keys' own placeholders.
		insertRequest("r1", OTHER_KEY, 100);
		insertAttempt("r1", "upstream_send", MODEL_SUBSTITUTION_SUPPRESSION_REASON);

		expect(await repo.getClientRequest(KEY, "r1")).toBeNull();
		expect(
			await repo.listClientRequestsByTag({
				apiKeyId: KEY,
				tag: "run-1",
				limit: 10,
			}),
		).toEqual([]);
	});

	it("pages by the keyset cursor with the count in place", async () => {
		insertRequest("r1", KEY, 100);
		insertRequest("r2", KEY, 200);
		insertAttempt("r2", "upstream_send", MODEL_SUBSTITUTION_SUPPRESSION_REASON);

		const page = await repo.listClientRequestsByTag({
			apiKeyId: KEY,
			tag: "run-1",
			limit: 10,
			after: { timestamp: 100, id: "r1" },
		});
		expect(page.map((row) => row.id)).toEqual(["r2"]);
		expect(page[0]?.model_substitution_discards).toBe(1);
	});
});
