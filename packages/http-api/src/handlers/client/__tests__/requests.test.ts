/**
 * `GET /client/v1/requests/{id}` and `GET /client/v1/requests?tag=` against a
 * REAL database.
 *
 * The scoping is the point of this file. A stub reader would answer whatever
 * the test told it to, which is exactly the bug worth catching: the
 * `api_key_id` predicate lives in SQL, so only real SQL can show that one
 * client's key cannot reach another client's rows.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "@clankermux/config";
import { DatabaseOperations } from "@clankermux/database";
import { ClientRouter } from "../router";

const KEY_A = "key-a";
const KEY_B = "key-b";
const TAG = "run-42";

let dir: string;
let dbOps: DatabaseOperations;
let router: ClientRouter;

interface SeedRow {
	id: string;
	timestamp?: number;
	apiKeyId?: string | null;
	tag?: string | null;
	statusCode?: number | null;
	errorMessage?: string | null;
	model?: string | null;
	requestedModel?: string | null;
	inputTokens?: number | null;
	outputTokens?: number | null;
	cacheReadInputTokens?: number | null;
	cacheCreationInputTokens?: number | null;
	totalTokens?: number | null;
	usageFinalizedAt?: number | null;
	usageSource?: string | null;
	project?: string | null;
}

/**
 * Write one `requests` row with every column this surface reads stated
 * explicitly — including the NULLs, which override the table's `DEFAULT 0` on
 * the token columns and are what the "null is not zero" case needs.
 */
async function seed(row: SeedRow): Promise<void> {
	await dbOps.getAdapter().run(
		`INSERT INTO requests (
			id, timestamp, method, path, status_code, success, error_message,
			model, requested_model, input_tokens, output_tokens,
			cache_read_input_tokens, cache_creation_input_tokens, total_tokens,
			usage_finalized_at, usage_source, project, api_key_id, correlation_tag
		) VALUES (?, ?, 'POST', '/v1/messages', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			row.id,
			row.timestamp ?? 1000,
			row.statusCode ?? null,
			row.errorMessage ?? null,
			row.model ?? null,
			row.requestedModel ?? null,
			row.inputTokens ?? null,
			row.outputTokens ?? null,
			row.cacheReadInputTokens ?? null,
			row.cacheCreationInputTokens ?? null,
			row.totalTokens ?? null,
			row.usageFinalizedAt ?? null,
			row.usageSource ?? null,
			row.project ?? null,
			row.apiKeyId === undefined ? KEY_A : row.apiKeyId,
			row.tag ?? null,
		],
	);
}

async function call(
	path: string,
	apiKeyId: string = KEY_A,
): Promise<{ status: number; cacheControl: string | null; body: unknown }> {
	const req = new Request(`http://test${path}`);
	const res = await router.handle(req, new URL(req.url), { apiKeyId });
	if (!res) throw new Error(`no route matched ${path}`);
	return {
		status: res.status,
		cacheControl: res.headers.get("Cache-Control"),
		body: await res.json(),
	};
}

interface ListBody {
	schema: string;
	requests: Array<{ id: string; timestamp: number }>;
	next: string | null;
}

async function list(query: string, apiKeyId: string = KEY_A) {
	const answer = await call(`/client/v1/requests?${query}`, apiKeyId);
	return { ...answer, body: answer.body as ListBody };
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "client-requests-"));
	dbOps = new DatabaseOperations(join(dir, "test.db"));
	router = new ClientRouter({
		config: { getRequestRetentionDays: () => 45 } as unknown as Config,
		dbOps,
	});
});

afterEach(async () => {
	await dbOps.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("GET /client/v1/requests/{id}", () => {
	it("publishes the documented shape for the caller's own row", async () => {
		await seed({
			id: "own",
			timestamp: 1700,
			statusCode: 200,
			errorMessage: null,
			model: "claude-x",
			requestedModel: "claude-x-alias",
			inputTokens: 11,
			outputTokens: 22,
			cacheReadInputTokens: 33,
			cacheCreationInputTokens: 44,
			totalTokens: 110,
			usageSource: "provider",
			project: "alpha",
			tag: TAG,
		});

		const { status, cacheControl, body } = await call(
			"/client/v1/requests/own",
		);

		expect(status).toBe(200);
		expect(cacheControl).toBe("private, no-store");
		expect(body).toEqual({
			schema: "clankermux.client.request.v1",
			id: "own",
			timestamp: 1700,
			finalized: true,
			statusCode: 200,
			error: null,
			model: "claude-x",
			requestedModel: "claude-x-alias",
			inputTokens: 11,
			outputTokens: 22,
			cacheReadInputTokens: 33,
			cacheCreationInputTokens: 44,
			usageSource: "provider",
			project: "alpha",
			apiKeyId: KEY_A,
			correlationTag: TAG,
		});
	});

	// One answer for three situations, so the route cannot be used to find out
	// which request ids exist.
	it("404s another client's row, an unowned row, and an id that never existed", async () => {
		await seed({ id: "theirs", apiKeyId: KEY_B });
		await seed({ id: "unowned", apiKeyId: null });

		for (const id of ["theirs", "unowned", "never-issued"]) {
			const { status, cacheControl, body } = await call(
				`/client/v1/requests/${id}`,
			);
			expect(status).toBe(404);
			expect(cacheControl).toBe("private, no-store");
			expect((body as { error: string }).error).toBe("not_found");
		}
	});

	it("reads the same id back for whichever key owns it", async () => {
		await seed({ id: "shared-id-is-not-shared", apiKeyId: KEY_B });

		const mine = await call("/client/v1/requests/shared-id-is-not-shared");
		const theirs = await call(
			"/client/v1/requests/shared-id-is-not-shared",
			KEY_B,
		);

		expect(mine.status).toBe(404);
		expect(theirs.status).toBe(200);
		expect((theirs.body as { apiKeyId: string }).apiKeyId).toBe(KEY_B);
	});

	// The captured segment is an opaque literal, so an encoded spelling is a
	// different id — and no id this proxy ever issued.
	it("does not decode the id segment", async () => {
		await seed({ id: "a b" });

		expect((await call("/client/v1/requests/a%20b")).status).toBe(404);
	});
});

describe("GET /client/v1/requests?tag=", () => {
	// Tags are client-chosen and not unique across clients, so the same tag under
	// two keys is the case a forgotten `api_key_id` predicate would leak.
	it("never returns another client's rows carrying the same tag", async () => {
		await seed({ id: "mine-1", tag: TAG, timestamp: 100 });
		await seed({ id: "theirs-1", tag: TAG, timestamp: 101, apiKeyId: KEY_B });
		await seed({ id: "unowned-1", tag: TAG, timestamp: 102, apiKeyId: null });

		const mine = await list(`tag=${TAG}`);
		const theirs = await list(`tag=${TAG}`, KEY_B);

		expect(mine.status).toBe(200);
		expect(mine.body.schema).toBe("clankermux.client.requests.v1");
		expect(mine.body.requests.map((r) => r.id)).toEqual(["mine-1"]);
		expect(theirs.body.requests.map((r) => r.id)).toEqual(["theirs-1"]);
	});

	it("pages rows that share a timestamp exactly once each, in (timestamp, id) order", async () => {
		for (const id of ["id-c", "id-a", "id-b"]) {
			await seed({ id, tag: TAG, timestamp: 500 });
		}

		const seen: string[] = [];
		let query = `tag=${TAG}&limit=1`;
		for (let page = 0; page < 5; page++) {
			const { body } = await list(query);
			seen.push(...body.requests.map((r) => r.id));
			if (!body.next) break;
			query = `tag=${TAG}&limit=1&after=${encodeURIComponent(body.next)}`;
		}

		expect(seen).toEqual(["id-a", "id-b", "id-c"]);
	});

	it("crosses a page boundary that falls inside a timestamp tie", async () => {
		await seed({ id: "id-a", tag: TAG, timestamp: 100 });
		await seed({ id: "id-b", tag: TAG, timestamp: 100 });
		await seed({ id: "id-c", tag: TAG, timestamp: 100 });
		await seed({ id: "id-d", tag: TAG, timestamp: 200 });

		const first = await list(`tag=${TAG}&limit=2`);
		expect(first.body.requests.map((r) => r.id)).toEqual(["id-a", "id-b"]);
		expect(first.body.next).not.toBeNull();

		// id-b (the page's last row) and id-c (the next page's first) share a
		// timestamp, so only the id half of the cursor can separate them.
		const second = await list(
			`tag=${TAG}&limit=2&after=${encodeURIComponent(first.body.next ?? "")}`,
		);
		expect(second.body.requests.map((r) => r.id)).toEqual(["id-c", "id-d"]);
		expect(second.body.next).toBeNull();
	});

	it("reports no next page rather than serving an empty one", async () => {
		await seed({ id: "only", tag: TAG, timestamp: 1 });

		const { body } = await list(`tag=${TAG}&limit=1`);

		expect(body.requests.map((r) => r.id)).toEqual(["only"]);
		expect(body.next).toBeNull();
	});

	it("returns an empty page with no cursor when the tag matches nothing", async () => {
		const { status, body } = await list("tag=nothing-carries-this");

		expect(status).toBe(200);
		expect(body.requests).toEqual([]);
		expect(body.next).toBeNull();
	});

	// A silent restart re-delivers a whole reconciliation scan and the client
	// cannot tell that from new rows, so a damaged cursor has to be refused.
	it("400s a cursor it did not issue instead of starting over", async () => {
		await seed({ id: "id-a", tag: TAG, timestamp: 1 });
		await seed({ id: "id-b", tag: TAG, timestamp: 2 });
		const { body: firstPage } = await list(`tag=${TAG}&limit=1`);
		const valid = firstPage.next ?? "";
		const truncated = valid.slice(0, valid.length - 4);
		const wrongShape = Buffer.from(
			JSON.stringify({ t: "not-a-number", i: "id-a" }),
			"utf8",
		).toString("base64url");

		for (const cursor of [truncated, wrongShape, "!!!not-a-cursor!!!", ""]) {
			const { status, cacheControl, body } = await list(
				`tag=${TAG}&after=${encodeURIComponent(cursor)}`,
			);
			expect(status).toBe(400);
			expect(cacheControl).toBe("private, no-store");
			expect((body as unknown as { error: string }).error).toBe(
				"invalid_request",
			);
		}
	});

	// The query parameter goes through the ingest validator, so the searchable
	// set is exactly the storable set.
	it("400s a missing tag and any tag the column could not have held", async () => {
		const queries = [
			"",
			"limit=10",
			"tag=",
			`tag=${encodeURIComponent("x".repeat(129))}`,
			`tag=${encodeURIComponent("run\t42")}`,
		];

		for (const query of queries) {
			const { status, body } = await list(query);
			expect(status).toBe(400);
			expect((body as unknown as { error: string }).error).toBe(
				"invalid_request",
			);
		}
	});

	it("400s a limit outside 1..200", async () => {
		for (const limit of ["0", "201", "-1", "1.5", "many"]) {
			const { status, body } = await list(`tag=${TAG}&limit=${limit}`);
			expect(status).toBe(400);
			expect((body as unknown as { error: string }).error).toBe(
				"invalid_request",
			);
		}
	});
});

describe("finalized and usageSource", () => {
	interface Answer {
		finalized: boolean;
		usageSource: string | null;
	}

	async function answerFor(row: SeedRow): Promise<Answer> {
		await seed(row);
		const { body } = await call(`/client/v1/requests/${row.id}`);
		return body as Answer;
	}

	for (const source of ["provider", "approximate", "none"] as const) {
		it(`reports a stored usage_source of '${source}' verbatim`, async () => {
			expect(
				await answerFor({ id: source, usageSource: source }),
			).toMatchObject({
				finalized: true,
				usageSource: source,
			});
		});
	}

	// Rows older than `usage_finalized_at` carry real counts under a NULL stamp,
	// so usage evidence is the only thing that separates them from a row still
	// waiting for a late patch. `approximate` reads as "not established as
	// provider-reported", which is what an unrecorded history is.
	it("treats a legacy row with token evidence as finalized", async () => {
		expect(
			await answerFor({
				id: "legacy-tokens",
				usageSource: null,
				usageFinalizedAt: null,
				model: null,
				totalTokens: 120,
			}),
		).toMatchObject({ finalized: true, usageSource: "approximate" });
	});

	it("treats a legacy row that only names a model as finalized", async () => {
		expect(
			await answerFor({
				id: "legacy-model",
				usageSource: null,
				usageFinalizedAt: null,
				model: "claude-x",
			}),
		).toMatchObject({ finalized: true, usageSource: "approximate" });
	});

	it("treats a row stamped by usage_finalized_at as finalized", async () => {
		expect(
			await answerFor({
				id: "stamped",
				usageSource: null,
				usageFinalizedAt: 1234,
			}),
		).toMatchObject({ finalized: true, usageSource: "approximate" });
	});

	it("reports an unsettled row as unfinalized with no usage source", async () => {
		expect(await answerFor({ id: "unsettled" })).toMatchObject({
			finalized: false,
			usageSource: null,
		});
	});

	// A stored NULL means "the provider reported nothing for this class" OR
	// "it reported zero", because the write path collapses a genuine 0. Neither
	// reading is the server's to pick.
	it("publishes absent token counts as null, never 0", async () => {
		await seed({ id: "no-tokens", usageSource: "none" });

		const { body } = await call("/client/v1/requests/no-tokens");

		expect(body).toMatchObject({
			inputTokens: null,
			outputTokens: null,
			cacheReadInputTokens: null,
			cacheCreationInputTokens: null,
		});
	});
});
