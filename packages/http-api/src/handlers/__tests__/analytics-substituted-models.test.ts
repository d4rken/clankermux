/**
 * Substituted requests as their own rows in the general model breakdowns.
 *
 * `requests.model` holds the model the UPSTREAM named, so a substituted request
 * has always been counted under the model that answered it, with nothing saying
 * so. In this deployment that silently moved 2,293 of one day's `gpt-6-astra`
 * requests into `gpt-5.6-luna`'s total, where they read as demand for luna.
 *
 * Real SQL against a real schema, not a mocked adapter: the whole claim lives in
 * the join predicate, which a stubbed `query()` would never evaluate.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter, ensureSchema } from "@clankermux/database";
import type { APIContext } from "../../types";
import { createAnalyticsHandler } from "../analytics-direct";

const NOW = Date.now();

let db: Database;
let context: APIContext;

beforeEach(() => {
	db = new Database(":memory:");
	ensureSchema(db);
	db.run(
		`INSERT INTO accounts (id, name, provider, refresh_token, created_at, priority, request_count)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		["acct-1", "Codex-me", "codex", "tok", NOW, 0, 0],
	);
	db.run(`INSERT INTO routing_snapshots (id, content) VALUES ('snap-1', '{}')`);
	const adapter = new BunSqlAdapter(db);
	context = {
		db: adapter,
		config: {},
		dbOps: { getAdapter: () => adapter },
	} as APIContext;
});

afterEach(() => {
	db.close();
});

/** One finished request, filed under the model that ANSWERED it. */
function seedRequest(id: string, requested: string, served: string): void {
	db.run(
		`INSERT INTO requests (id, timestamp, method, path, account_used, status_code, success, model, requested_model, cost_usd, total_tokens)
		 VALUES (?, ?, 'POST', '/v1/messages', 'acct-1', 200, 1, ?, ?, 0.01, 100)`,
		[id, NOW - 60_000, served, requested],
	);
}

/**
 * One upstream attempt for that request, with what went out, what came back and
 * how it ended. `status` matters: only the attempt that ANSWERED can say what
 * the request was sent as.
 */
function seedAttempt(
	id: string,
	requestId: string,
	outgoing: string,
	reported: string,
	opts: { status?: number; atMs?: number } = {},
): void {
	db.run(
		`INSERT INTO routing_attempts (id, request_id, route_snapshot_id, account_id, provider, requested_model, resolved_model, outgoing_model, reported_model, kind, started_at, status)
		 VALUES (?, ?, 'snap-1', 'acct-1', 'codex', ?, ?, ?, ?, 'upstream_send', ?, ?)`,
		[
			id,
			requestId,
			outgoing,
			outgoing,
			outgoing,
			reported,
			opts.atMs ?? NOW - 60_000,
			opts.status ?? 200,
		],
	);
}

async function modelDistribution(): Promise<
	Array<{ model: string; count: number; substitutedFrom?: string }>
> {
	const response = await createAnalyticsHandler(context)(
		new URLSearchParams({ range: "24h", sections: "modelDistribution" }),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		modelDistribution?: Array<{
			model: string;
			count: number;
			substitutedFrom?: string;
		}>;
	};
	return body.modelDistribution ?? [];
}

describe("model distribution splits substituted requests", () => {
	it("leaves ordinary usage alone", async () => {
		seedRequest("r1", "gpt-5.6-luna", "gpt-5.6-luna");
		seedAttempt("a1", "r1", "gpt-5.6-luna", "gpt-5.6-luna");

		const rows = await modelDistribution();

		expect(rows).toHaveLength(1);
		expect(rows[0]?.model).toBe("gpt-5.6-luna");
		expect(rows[0]?.substitutedFrom).toBeUndefined();
	});

	it("separates a forwarded substitution from genuine demand", async () => {
		seedRequest("r1", "gpt-5.6-luna", "gpt-5.6-luna");
		seedAttempt("a1", "r1", "gpt-5.6-luna", "gpt-5.6-luna");
		seedRequest("r2", "gpt-6-astra", "gpt-5.6-luna");
		seedAttempt("a2", "r2", "gpt-6-astra", "gpt-5.6-luna");

		const rows = await modelDistribution();

		const genuine = rows.find((row) => !row.substitutedFrom);
		const substituted = rows.find((row) => row.substitutedFrom);
		expect(genuine?.model).toBe("gpt-5.6-luna");
		expect(genuine?.count).toBe(1);
		expect(substituted?.model).toBe("gpt-5.6-luna");
		expect(substituted?.substitutedFrom).toBe("gpt-6-astra");
		expect(substituted?.count).toBe(1);
	});

	// The normal shape of an ENFORCED substitution, and the reason the join
	// matches on the served model rather than on request_id alone: account A
	// swapped, the request failed over, account B answered it properly. Counting
	// that request as substituted would report the failover as a failure.
	it("does not mark a request that was successfully routed around", async () => {
		seedRequest("r1", "gpt-6-astra", "gpt-6-astra");
		seedAttempt("a1", "r1", "gpt-6-astra", "gpt-5.6-luna");
		seedAttempt("a2", "r1", "gpt-6-astra", "gpt-6-astra");

		const rows = await modelDistribution();

		expect(rows).toHaveLength(1);
		expect(rows[0]?.model).toBe("gpt-6-astra");
		expect(rows[0]?.count).toBe(1);
		expect(rows[0]?.substitutedFrom).toBeUndefined();
	});

	it("counts a request with no attempt rows as ordinary usage", async () => {
		seedRequest("r1", "gpt-6-astra", "gpt-6-astra");

		const rows = await modelDistribution();

		expect(rows).toHaveLength(1);
		expect(rows[0]?.substitutedFrom).toBeUndefined();
	});

	// A FAILED attempt can name a model in its response without having served
	// anything: an alias route whose first choice 503s while reporting the model
	// it would have fallen back to. Reading that as the request's origin
	// attributes the answer to a model that never ran.
	it("ignores an attempt that did not answer the request", async () => {
		seedRequest("r1", "gpt-5.6-luna", "gpt-5.6-luna");
		seedAttempt("a1", "r1", "gpt-6-astra", "gpt-5.6-luna", {
			status: 503,
			atMs: NOW - 90_000,
		});
		seedAttempt("a2", "r1", "gpt-5.6-luna", "gpt-5.6-luna", {
			status: 200,
			atMs: NOW - 60_000,
		});

		const rows = await modelDistribution();

		expect(rows).toHaveLength(1);
		expect(rows[0]?.substitutedFrom).toBeUndefined();
	});

	// The failover shape that a mismatch-first query gets wrong. Account A is
	// sent astra and answers as luna; the alias then sends luna to B, which
	// answers as luna. The request WAS served by the model its answering attempt
	// sent, so nothing was substituted from the client's point of view — but a
	// query that filters for a mismatch before taking the newest attempt can only
	// see A's row and reports astra.
	it("does not attribute a routed-around swap when the answer came from a clean attempt", async () => {
		seedRequest("r1", "alias:economy", "gpt-5.6-luna");
		seedAttempt("a1", "r1", "gpt-6-astra", "gpt-5.6-luna", {
			atMs: NOW - 90_000,
		});
		seedAttempt("a2", "r1", "gpt-5.6-luna", "gpt-5.6-luna", {
			atMs: NOW - 60_000,
		});

		const rows = await modelDistribution();

		expect(rows).toHaveLength(1);
		expect(rows[0]?.model).toBe("gpt-5.6-luna");
		expect(rows[0]?.substitutedFrom).toBeUndefined();
	});

	// Two successful attempts can report the same model. The one that answered
	// is the LAST, not whichever sorts first alphabetically.
	it("takes the origin from the attempt that answered last", async () => {
		seedRequest("r1", "gpt-5.6-luna", "gpt-5.6-luna");
		seedAttempt("a1", "r1", "gpt-6-astra", "gpt-5.6-luna", {
			atMs: NOW - 90_000,
		});
		seedAttempt("a2", "r1", "gpt-6-terra", "gpt-5.6-luna", {
			atMs: NOW - 60_000,
		});

		const rows = await modelDistribution();

		expect(rows).toHaveLength(1);
		expect(rows[0]?.substitutedFrom).toBe("gpt-6-terra");
	});

	// The comparison in SQL is raw inequality, so it calls this a swap. The
	// normalisation that decides is the same one the proxy fails over on, and it
	// has to run over these rows or the highest-volume path in the deployment
	// splits into two rows for one model.
	it("does not split a dated snapshot of the model that was asked for", async () => {
		seedRequest("r1", "claude-haiku-4-5", "claude-haiku-4-5-20251001");
		seedAttempt("a1", "r1", "claude-haiku-4-5", "claude-haiku-4-5-20251001");
		seedRequest("r2", "claude-haiku-4-5", "claude-haiku-4-5-20251001");
		seedAttempt("a2", "r2", "claude-haiku-4-5", "claude-haiku-4-5-20251001");

		const rows = await modelDistribution();

		expect(rows).toHaveLength(1);
		expect(rows[0]?.count).toBe(2);
		expect(rows[0]?.substitutedFrom).toBeUndefined();
	});

	it("folds a rejected candidate back into its model's ordinary row", async () => {
		// One genuinely ordinary request and one the raw SQL flags, for the same
		// served model. They must come back as ONE row of two, not two of one.
		seedRequest("r1", "claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001");
		seedRequest("r2", "claude-haiku-4-5", "claude-haiku-4-5-20251001");
		seedAttempt("a2", "r2", "claude-haiku-4-5", "claude-haiku-4-5-20251001");

		const rows = await modelDistribution();

		expect(rows).toHaveLength(1);
		expect(rows[0]?.count).toBe(2);
		expect(rows[0]?.substitutedFrom).toBeUndefined();
	});

	// A backend-resolved slug is not a substitution either: being answered by
	// something else is what those slugs are for.
	it("does not split a backend-resolved slug", async () => {
		seedRequest("r1", "codex-auto-review", "gpt-5.6-luna");
		seedAttempt("a1", "r1", "codex-auto-review", "gpt-5.6-luna");

		const rows = await modelDistribution();

		expect(rows).toHaveLength(1);
		expect(rows[0]?.substitutedFrom).toBeUndefined();
	});

	// The top-N cut lands on MODELS, before the split. Cutting the split rows
	// instead discards candidates the fold has not judged yet, and a discarded
	// candidate takes its count with it: these eleven all normalise to ordinary
	// usage of one model, so a row-level cut at ten reports eleven requests as
	// ten and loses one with no trace.
	it("does not lose counts to the top-N cut before folding", async () => {
		const vendors = [
			"anthropic",
			"openai",
			"google",
			"meta",
			"mistral",
			"cohere",
			"ai21",
			"deepseek",
			"qwen",
			"xai",
			"amazon",
		];
		vendors.forEach((vendor, index) => {
			const id = `v${index}`;
			seedRequest(id, `${vendor}/gpt-5.6-luna`, "gpt-5.6-luna");
			seedAttempt(`va${index}`, id, `${vendor}/gpt-5.6-luna`, "gpt-5.6-luna");
		});

		const rows = await modelDistribution();

		expect(rows).toHaveLength(1);
		expect(rows[0]?.model).toBe("gpt-5.6-luna");
		expect(rows[0]?.count).toBe(vendors.length);
		expect(rows[0]?.substitutedFrom).toBeUndefined();
	});
});

describe("cost by model survives the split", () => {
	async function costByModel(extraParams: Record<string, string> = {}): Promise<
		Array<{
			model: string;
			costUsd: number;
			totalTokens?: number;
			substitutedFrom?: string;
		}>
	> {
		const response = await createAnalyticsHandler(context)(
			new URLSearchParams({
				range: "24h",
				sections: "costByModel",
				...extraParams,
			}),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			costByModel?: Array<{
				model: string;
				costUsd: number;
				totalTokens?: number;
				substitutedFrom?: string;
			}>;
		};
		return body.costByModel ?? [];
	}

	// The top-N cut is applied to MODELS, not to the split rows. With the cut on
	// rows, a model reached through many different sent models loses some of its
	// own rows, and the consumer that sums them back reports a smaller cost over
	// fewer tokens — silently, and with a plausible-looking cost per 1K.
	it("returns every row of a model reached many different ways", async () => {
		let n = 0;
		for (const sent of [
			"gpt-6-astra",
			"gpt-6-terra",
			"gpt-6-vega",
			"gpt-6-rigel",
			"gpt-6-mira",
			"gpt-6-nova",
			"gpt-6-atlas",
			"gpt-6-orion",
			"gpt-6-lyra",
			"gpt-6-draco",
			"gpt-6-cygnus",
			"gpt-6-perseus",
		]) {
			n += 1;
			seedRequest(`s${n}`, sent, "gpt-5.6-luna");
			seedAttempt(`sa${n}`, `s${n}`, sent, "gpt-5.6-luna");
		}
		seedRequest("plain", "gpt-5.6-luna", "gpt-5.6-luna");
		seedAttempt("plaina", "plain", "gpt-5.6-luna", "gpt-5.6-luna");

		const rows = await costByModel();
		const luna = rows.filter((row) => row.model === "gpt-5.6-luna");

		// 13 requests seeded at $0.01 and 100 tokens each.
		expect(luna).toHaveLength(13);
		const cost = luna.reduce((sum, row) => sum + row.costUsd, 0);
		const tokens = luna.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0);
		expect(cost).toBeCloseTo(0.13, 6);
		expect(tokens).toBe(1300);
	});

	// The model ranking repeats the window predicate, so this query interpolates
	// the filter clause TWICE and is handed its bind list twice. With an empty
	// clause that is vacuously fine, which is why every other case here would
	// miss a mismatch; a filter has to be active for the placeholders and the
	// binds to actually have to line up.
	it("applies an active filter to both copies of the where clause", async () => {
		seedRequest("kept", "gpt-6-astra", "gpt-5.6-luna");
		seedAttempt("kepta", "kept", "gpt-6-astra", "gpt-5.6-luna");
		seedRequest("dropped", "gpt-5.6-terra", "gpt-5.6-terra");
		seedAttempt("droppeda", "dropped", "gpt-5.6-terra", "gpt-5.6-terra");

		const rows = await costByModel({ models: "gpt-5.6-luna" });

		expect(rows).toHaveLength(1);
		expect(rows[0]?.model).toBe("gpt-5.6-luna");
		expect(rows[0]?.substitutedFrom).toBe("gpt-6-astra");
	});

	it("survives two filters at once", async () => {
		seedRequest("kept", "gpt-6-astra", "gpt-5.6-luna");
		seedAttempt("kepta", "kept", "gpt-6-astra", "gpt-5.6-luna");

		const rows = await costByModel({
			models: "gpt-5.6-luna",
			accounts: "acct-1",
			status: "success",
		});

		expect(rows).toHaveLength(1);
		expect(rows[0]?.substitutedFrom).toBe("gpt-6-astra");
	});

	it("groups repeated substitutions of the same pair into one row", async () => {
		for (const n of [1, 2, 3]) {
			seedRequest(`r${n}`, "gpt-6-astra", "gpt-5.6-luna");
			seedAttempt(`a${n}`, `r${n}`, "gpt-6-astra", "gpt-5.6-luna");
		}

		const rows = await modelDistribution();

		expect(rows).toHaveLength(1);
		expect(rows[0]?.count).toBe(3);
		expect(rows[0]?.substitutedFrom).toBe("gpt-6-astra");
	});
});
