import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MODEL_SUBSTITUTION_SUPPRESSION_REASON } from "@clankermux/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import {
	CLIENT_REQUEST_BY_ID_SQL,
	clientRequestsByTagSql,
	clientRowApproximateSql,
	clientRowFinalizedSql,
	modelSubstitutionDiscardsSql,
	RequestRepository,
} from "../request.repository";

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
			(await repo.getClientRequest(KEY, "r1", 0))?.model_substitution_discards,
		).toBe(1);
	});

	it("reports 0 for a request that never recorded an attempt", async () => {
		insertRequest("r1", KEY, 100);

		expect(
			(await repo.getClientRequest(KEY, "r1", 0))?.model_substitution_discards,
		).toBe(0);
	});

	it("does not count a local rejection carrying the same reason", async () => {
		// A rejection decided before dispatch discarded nothing, so `kind` is as
		// load-bearing as the reason itself.
		insertRequest("r1", KEY, 100);
		insertAttempt("r1", "local_reject", MODEL_SUBSTITUTION_SUPPRESSION_REASON);

		expect(
			(await repo.getClientRequest(KEY, "r1", 0))?.model_substitution_discards,
		).toBe(0);
	});

	it("counts every discard when no attempt ever succeeded", async () => {
		// Every candidate substituting ends the request 503 with nothing after the
		// last discard; the count is of discards, not of failovers that followed.
		insertRequest("r1", KEY, 100);
		insertAttempt("r1", "upstream_send", MODEL_SUBSTITUTION_SUPPRESSION_REASON);
		insertAttempt("r1", "upstream_send", MODEL_SUBSTITUTION_SUPPRESSION_REASON);

		expect(
			(await repo.getClientRequest(KEY, "r1", 0))?.model_substitution_discards,
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
			legsReadableSince: 0,
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

		expect(await repo.getClientRequest(KEY, "r1", 0)).toBeNull();
		expect(
			await repo.listClientRequestsByTag({
				apiKeyId: KEY,
				tag: "run-1",
				limit: 10,
				legsReadableSince: 0,
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
			legsReadableSince: 0,
			after: { timestamp: 100, id: "r1" },
		});
		expect(page.map((row) => row.id)).toEqual(["r2"]);
		expect(page[0]?.model_substitution_discards).toBe(1);
	});
});

/**
 * Requests the SDK bridge served, read through their legs. The leg is the
 * resource (its id is the client's request id); the inner rows Claude Code's
 * model calls wrote are summed into it and never readable on their own.
 */
describe("client request reads of bridged requests", () => {
	let db: Database;
	let repo: RequestRepository;

	const KEY = "key-1";
	const OTHER_KEY = "key-2";

	interface TurnSeed {
		id: string;
		apiKeyId?: string | null;
		project?: string | null;
		model?: string | null;
		finishedAt?: number | null;
		innerCalls?: number;
	}

	const turn = (seed: TurnSeed): void => {
		db.query(
			`INSERT INTO sdk_bridge_turns (id, started_at, finished_at, status,
				api_key_id, model, project, history_mode, system_prompt_policy,
				inner_call_count)
			 VALUES (?, 1000, ?, 'completed', ?, ?, ?, 'fresh', 'drop', ?)`,
		).run(
			seed.id,
			seed.finishedAt === undefined ? 9_000 : seed.finishedAt,
			seed.apiKeyId === undefined ? KEY : seed.apiKeyId,
			seed.model ?? "claude-sonnet-5",
			seed.project ?? "turn-project",
			seed.innerCalls ?? 0,
		);
	};

	interface LegSeed {
		id: string;
		turnId: string;
		kind?: "start" | "continue";
		startedAt?: number;
		finishedAt?: number | null;
		apiKeyId?: string | null;
		tag?: string | null;
		requestedModel?: string | null;
		project?: string | null;
		/** null: a leg written before the column (legacy). */
		innerCalls?: number | null;
		settledAt?: number | null;
		failedOver?: boolean;
		httpStatus?: number | null;
		errorMessage?: string | null;
	}

	const leg = (seed: LegSeed): void => {
		db.query(
			`INSERT INTO sdk_bridge_turn_legs (id, turn_id, kind, started_at,
				finished_at, http_status, error_message, api_key_id,
				correlation_tag, requested_model, project, inner_call_count,
				settled_at, failed_over)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			seed.id,
			seed.turnId,
			seed.kind ?? "start",
			seed.startedAt ?? 1_000,
			seed.finishedAt === undefined ? 2_000 : seed.finishedAt,
			seed.httpStatus === undefined ? 200 : seed.httpStatus,
			seed.errorMessage ?? null,
			seed.apiKeyId === undefined ? KEY : seed.apiKeyId,
			seed.tag === undefined ? "run-1" : seed.tag,
			seed.requestedModel === undefined
				? "alias:balanced"
				: seed.requestedModel,
			seed.project === undefined ? "leg-project" : seed.project,
			seed.innerCalls === undefined ? 0 : seed.innerCalls,
			seed.settledAt === undefined ? 2_500 : seed.settledAt,
			seed.failedOver ? 1 : 0,
		);
		db.run(
			"UPDATE sdk_bridge_turns SET leg_count = leg_count + 1 WHERE id = ?",
			[seed.turnId],
		);
	};

	interface InnerSeed {
		id: string;
		turnId: string;
		legId: string | null;
		timestamp?: number;
		apiKeyId?: string;
		model?: string | null;
		input?: number | null;
		output?: number | null;
		cacheRead?: number | null;
		cacheCreation?: number | null;
		usageSource?: string | null;
		failoverAttempts?: number | null;
		tag?: string | null;
	}

	const inner = (seed: InnerSeed): void => {
		db.query(
			`INSERT INTO requests (id, timestamp, method, path, api_key_id, model,
				input_tokens, output_tokens, cache_read_input_tokens,
				cache_creation_input_tokens, total_tokens, usage_source,
				failover_attempts, correlation_tag, sdk_bridge_turn_id,
				sdk_bridge_leg_id)
			 VALUES (?, ?, 'POST', '/v1/messages', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
		).run(
			seed.id,
			seed.timestamp ?? 1_500,
			seed.apiKeyId ?? KEY,
			seed.model === undefined ? "claude-sonnet-5-20261101" : seed.model,
			seed.input === undefined ? 10 : seed.input,
			seed.output === undefined ? 5 : seed.output,
			seed.cacheRead === undefined ? 100 : seed.cacheRead,
			seed.cacheCreation === undefined ? 0 : seed.cacheCreation,
			seed.usageSource === undefined ? "provider" : seed.usageSource,
			seed.failoverAttempts ?? 0,
			seed.tag ?? null,
			seed.turnId,
			seed.legId,
		);
	};

	const attempt = (requestId: string, model: string, startedAt = 1): void => {
		db.query(
			`INSERT INTO routing_attempts(
				id,request_id,route_snapshot_id,requested_model,kind,started_at,error)
			 VALUES(?,?,?,?,?,?,?)`,
		).run(
			crypto.randomUUID(),
			requestId,
			"snapshot-1",
			model,
			"upstream_send",
			startedAt,
			MODEL_SUBSTITUTION_SUPPRESSION_REASON,
		);
	};

	const byId = (id: string, key = KEY, since = 0) =>
		repo.getClientRequest(key, id, since);
	const byTag = (
		opts: {
			key?: string;
			tag?: string;
			limit?: number;
			after?: { timestamp: number; id: string };
			since?: number;
		} = {},
	) =>
		repo.listClientRequestsByTag({
			apiKeyId: opts.key ?? KEY,
			tag: opts.tag ?? "run-1",
			limit: opts.limit ?? 10,
			after: opts.after ?? null,
			legsReadableSince: opts.since ?? 0,
		});

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		repo = new RequestRepository(new BunSqlAdapter(db));
	});
	afterEach(() => db.close());

	it("answers a leg's id with its own facts and the sums of its inner rows", async () => {
		turn({ id: "t1", innerCalls: 2 });
		leg({ id: "leg-1", turnId: "t1", innerCalls: 2, httpStatus: 200 });
		inner({ id: "i1", turnId: "t1", legId: "leg-1", timestamp: 1_100 });
		inner({
			id: "i2",
			turnId: "t1",
			legId: "leg-1",
			timestamp: 1_200,
			model: "claude-sonnet-5-20261102",
			input: 3,
			output: 7,
			cacheRead: 200,
			cacheCreation: 50,
			failoverAttempts: 2,
		});

		expect(await byId("leg-1")).toEqual({
			source: "sdk_bridge_leg",
			id: "leg-1",
			timestamp: 2_000,
			status_code: 200,
			error_message: null,
			model: "claude-sonnet-5-20261102",
			requested_model: "alias:balanced",
			input_tokens: 13,
			output_tokens: 12,
			cache_read_input_tokens: 300,
			cache_creation_input_tokens: 50,
			total_tokens: null,
			usage_finalized_at: null,
			usage_source: null,
			failover_attempts: 2,
			project: "leg-project",
			api_key_id: KEY,
			correlation_tag: "run-1",
			model_substitution_discards: 0,
			leg_settled: 1,
			leg_expected_calls: 2,
			leg_inner_rows: 2,
			leg_inner_finalized: 2,
			leg_inner_approximate: 0,
			leg_inner_provider: 2,
		});
	});

	it("never answers an inner row's own id, by id or by tag", async () => {
		turn({ id: "t1", innerCalls: 1 });
		leg({ id: "leg-1", turnId: "t1", innerCalls: 1 });
		inner({ id: "i1", turnId: "t1", legId: "leg-1", tag: "run-1" });

		expect(await byId("i1")).toBeNull();
		expect((await byTag()).map((r) => r.id)).toEqual(["leg-1"]);
	});

	it("scopes a leg to the key that sent its outer request", async () => {
		turn({ id: "t1" });
		leg({ id: "leg-1", turnId: "t1" });

		expect(await byId("leg-1", OTHER_KEY)).toBeNull();
		expect(await byTag({ key: OTHER_KEY })).toEqual([]);
	});

	it("shows another key's refused continuation on a turn to that key alone, without the turn's project", async () => {
		turn({ id: "t1", project: "secret-of-key-1" });
		leg({ id: "leg-1", turnId: "t1" });
		leg({
			id: "leg-b",
			turnId: "t1",
			kind: "continue",
			apiKeyId: OTHER_KEY,
			project: "key-2-project",
			httpStatus: 409,
			errorMessage: "belongs to another API key",
		});

		const row = await byId("leg-b", OTHER_KEY);
		expect(row).toMatchObject({
			id: "leg-b",
			status_code: 409,
			project: "key-2-project",
			api_key_id: OTHER_KEY,
		});
		expect(JSON.stringify(row)).not.toContain("secret-of-key-1");
		expect(JSON.stringify(await byTag({ key: OTHER_KEY }))).not.toContain(
			"secret-of-key-1",
		);
		expect(await byId("leg-b")).toBeNull();
	});

	it("answers a request row over a leg with the same id", async () => {
		turn({ id: "t1" });
		leg({ id: "r1", turnId: "t1" });
		db.query(
			`INSERT INTO requests(id,timestamp,method,path,api_key_id,correlation_tag,status_code)
			 VALUES('r1',3000,'POST','/v1/messages',?,'run-1',503)`,
		).run(KEY);

		expect(await byId("r1")).toMatchObject({
			source: "request",
			status_code: 503,
		});
		expect((await byTag()).map((r) => [r.id, r.source])).toEqual([
			["r1", "request"],
		]);
	});

	it("answers the next destination's row for a leg the proxy failed over from, leaving the refused call out of its counts", async () => {
		turn({ id: "t1", innerCalls: 1 });
		leg({
			id: "r1",
			turnId: "t1",
			innerCalls: 1,
			failedOver: true,
			httpStatus: 502,
			errorMessage:
				"No answer matching the response schema: the model refused to answer",
		});
		inner({ id: "i1", turnId: "t1", legId: "r1", input: 900, output: 3 });
		db.query(
			`INSERT INTO requests(id,timestamp,method,path,api_key_id,correlation_tag,
				status_code,model,input_tokens,output_tokens,failover_attempts)
			 VALUES('r1',3000,'POST','/v1/messages',?,'run-1',200,'gpt-6.1-sol',40,8,1)`,
		).run(KEY);

		expect(await byId("r1")).toMatchObject({
			source: "request",
			status_code: 200,
			error_message: null,
			model: "gpt-6.1-sol",
			input_tokens: 40,
			output_tokens: 8,
			failover_attempts: 1,
		});
		expect((await byTag()).map((r) => [r.id, r.source])).toEqual([
			["r1", "request"],
		]);
	});

	it("never publishes a leg the proxy failed over from, or one not finished yet", async () => {
		turn({ id: "t1" });
		leg({ id: "failed-over", turnId: "t1", failedOver: true });
		turn({ id: "t2" });
		leg({ id: "open", turnId: "t2", finishedAt: null });

		expect(await byId("failed-over")).toBeNull();
		expect(await byId("open")).toBeNull();
		expect(await byTag()).toEqual([]);
	});

	it("reads a leg with no inner rows as nulls", async () => {
		turn({ id: "t1" });
		leg({ id: "leg-1", turnId: "t1", httpStatus: 400 });

		expect(await byId("leg-1")).toMatchObject({
			model: null,
			input_tokens: null,
			output_tokens: null,
			cache_read_input_tokens: null,
			cache_creation_input_tokens: null,
			failover_attempts: null,
			leg_expected_calls: 0,
			leg_inner_rows: 0,
		});
	});

	it("keeps a class null when no inner row reported it", async () => {
		turn({ id: "t1", innerCalls: 2 });
		leg({ id: "leg-1", turnId: "t1", innerCalls: 2 });
		inner({ id: "i1", turnId: "t1", legId: "leg-1", cacheCreation: null });
		inner({ id: "i2", turnId: "t1", legId: "leg-1", cacheCreation: null });

		const row = await byId("leg-1");
		expect(row?.cache_creation_input_tokens).toBeNull();
		expect(row?.input_tokens).toBe(20);
	});

	it("counts only the leg's own inner rows, of the owner's key", async () => {
		turn({ id: "t1", innerCalls: 3 });
		leg({ id: "leg-1", turnId: "t1", innerCalls: 1 });
		leg({ id: "leg-2", turnId: "t1", kind: "continue", innerCalls: 1 });
		inner({ id: "i1", turnId: "t1", legId: "leg-1", input: 1 });
		inner({ id: "i2", turnId: "t1", legId: "leg-2", input: 2 });
		inner({ id: "i3", turnId: "t1", legId: null, input: 4 });
		inner({
			id: "i4",
			turnId: "t1",
			legId: "leg-1",
			input: 8,
			apiKeyId: OTHER_KEY,
		});

		expect((await byId("leg-1"))?.input_tokens).toBe(1);
		expect((await byId("leg-2"))?.input_tokens).toBe(2);
	});

	it("reports the leg's evidence for finality as it stands", async () => {
		turn({ id: "t1", innerCalls: 2 });
		leg({ id: "leg-1", turnId: "t1", innerCalls: 2, settledAt: null });
		inner({ id: "i1", turnId: "t1", legId: "leg-1" });
		inner({
			id: "i2",
			turnId: "t1",
			legId: "leg-1",
			model: null,
			input: null,
			output: null,
			cacheRead: null,
			cacheCreation: null,
			usageSource: null,
		});

		expect(await byId("leg-1")).toMatchObject({
			leg_settled: 0,
			leg_expected_calls: 2,
			leg_inner_rows: 2,
			leg_inner_finalized: 1,
		});
	});

	it("counts the leg's own discards and its inner rows'", async () => {
		turn({ id: "t1", innerCalls: 1 });
		leg({ id: "leg-1", turnId: "t1", innerCalls: 1 });
		inner({ id: "i1", turnId: "t1", legId: "leg-1" });
		attempt("leg-1", "alias:balanced");
		attempt("i1", "claude-sonnet-5");
		attempt("i1", "claude-sonnet-5");

		expect((await byId("leg-1"))?.model_substitution_discards).toBe(3);
	});

	describe("a leg written before legs kept their own accounting", () => {
		it("resolves a turn's single start leg for the turn's key, from the turn's rows", async () => {
			turn({ id: "t1", innerCalls: 1, project: "turn-project" });
			leg({
				id: "leg-1",
				turnId: "t1",
				apiKeyId: null,
				tag: null,
				requestedModel: null,
				project: null,
				innerCalls: null,
				settledAt: null,
			});
			inner({ id: "i1", turnId: "t1", legId: null, input: 9 });
			attempt("leg-1", "alias:economy", 5);
			attempt("leg-1", "alias:later", 6);

			expect(await byId("leg-1")).toMatchObject({
				source: "sdk_bridge_leg",
				api_key_id: KEY,
				input_tokens: 9,
				requested_model: "alias:economy",
				project: "turn-project",
				leg_settled: 1,
				leg_expected_calls: 1,
				leg_inner_rows: 1,
			});
			expect(await byId("leg-1", OTHER_KEY)).toBeNull();
		});

		it("falls back to the turn's model without a routing attempt", async () => {
			turn({ id: "t1", model: "claude-opus-5" });
			leg({
				id: "leg-1",
				turnId: "t1",
				apiKeyId: null,
				requestedModel: null,
				innerCalls: null,
			});

			expect((await byId("leg-1"))?.requested_model).toBe("claude-opus-5");
		});

		it("is unsettled while its turn runs", async () => {
			turn({ id: "t1", finishedAt: null });
			leg({ id: "leg-1", turnId: "t1", apiKeyId: null, innerCalls: null });

			expect((await byId("leg-1"))?.leg_settled).toBe(0);
		});

		it("leaves a multi-leg turn's legs unresolved", async () => {
			turn({ id: "t1", innerCalls: 2 });
			leg({ id: "leg-1", turnId: "t1", apiKeyId: null, innerCalls: null });
			leg({
				id: "leg-2",
				turnId: "t1",
				kind: "continue",
				apiKeyId: null,
				innerCalls: null,
			});

			expect(await byId("leg-1")).toBeNull();
			expect(await byId("leg-2")).toBeNull();
		});
	});

	it("stops answering a leg that started before the retention bound", async () => {
		turn({ id: "t1" });
		leg({ id: "leg-1", turnId: "t1", startedAt: 1_000 });

		expect(await byId("leg-1", KEY, 1_000)).not.toBeNull();
		expect(await byId("leg-1", KEY, 1_001)).toBeNull();
		expect(await byTag({ since: 1_001 })).toEqual([]);
	});

	it("pages requests and legs together, ties and all, at a page size of 1", async () => {
		for (const id of ["a", "c"])
			db.query(
				`INSERT INTO requests(id,timestamp,method,path,api_key_id,correlation_tag)
				 VALUES(?,2000,'POST','/v1/messages',?,'run-1')`,
			).run(id, KEY);
		turn({ id: "t1" });
		leg({ id: "b", turnId: "t1", finishedAt: 2_000 });
		turn({ id: "t2" });
		leg({ id: "d", turnId: "t2", finishedAt: 1_500 });

		const seen: string[] = [];
		let after: { timestamp: number; id: string } | undefined;
		for (;;) {
			const page = await byTag({ limit: 2, after });
			const first = page[0];
			if (!first) break;
			seen.push(first.id);
			after = { timestamp: first.timestamp, id: first.id };
		}
		expect(seen).toEqual(["d", "a", "b", "c"]);
	});

	it("binds no parameter inside a shared fragment", () => {
		for (const fragment of [
			clientRowFinalizedSql("r"),
			clientRowApproximateSql("r"),
			modelSubstitutionDiscardsSql("r.id"),
		])
			expect(fragment).not.toContain("?");
	});

	it("walks indexes, never a whole table", () => {
		const scans = (sql: string, params: unknown[]) =>
			(
				db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as [])) as Array<{
					detail: string;
				}>
			).map((r) => r.detail);
		const plans = [
			...scans(CLIENT_REQUEST_BY_ID_SQL, ["x", 0, KEY, KEY, 1, "x", KEY]),
			...scans(clientRequestsByTagSql(true), [
				"run-1",
				KEY,
				1,
				1,
				"x",
				0,
				KEY,
				KEY,
				10,
				"run-1",
				KEY,
				1,
				1,
				"x",
				10,
				10,
			]),
		];
		// The CTEs (p, i, a) and subqueries are scanned; a base table, under
		// any of its aliases, never is, not even through a whole index.
		for (const detail of plans)
			expect(detail).not.toMatch(
				/^SCAN (requests|sdk_bridge_turn_legs|sdk_bridge_turns|routing_attempts|r|l|t|d|ra)\b/,
			);
		const joined = plans.join("\n");
		expect(joined).toContain("idx_sdk_bridge_turn_legs_correlation_tag");
		expect(joined).toContain("idx_requests_correlation_tag");
		expect(joined).toContain("idx_requests_sdk_bridge_leg");
		expect(joined).toContain("idx_requests_sdk_bridge_turn");
		expect(joined).toContain("idx_routing_attempts_request");
	});
});
