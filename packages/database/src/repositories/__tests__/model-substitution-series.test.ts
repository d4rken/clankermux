/**
 * The substitution history buckets, as SQL can describe them.
 *
 * SQL cannot reach the normalisation that decides what a substitution IS — it
 * has no provider-keyed pair table and no alias stripping — so this query does
 * not try. It reports a per-bucket denominator and the mismatch CANDIDATES that
 * make it up, and the http-api handler judges them. A bucket that only counted
 * `reported_model <> outgoing_model` would draw a renamed-but-identical model
 * as a swap forever.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { RoutingRepository } from "../routing.repository";

const BUCKET_MS = 60_000;
const T0 = 1_760_000_000_000;

let db: Database;
let repo: RoutingRepository;

beforeEach(() => {
	db = new Database(":memory:");
	ensureSchema(db);
	db.run("INSERT INTO routing_snapshots (id, content) VALUES ('snap-1', '{}')");
	repo = new RoutingRepository(new BunSqlAdapter(db));
});

afterEach(() => db.close());

let seq = 0;

function attempt(opts: {
	provider: string | null;
	outgoing: string;
	reported: string;
	atMs: number;
}): void {
	seq += 1;
	db.run(
		`INSERT INTO routing_attempts (id, request_id, route_snapshot_id, account_id, provider, requested_model, resolved_model, outgoing_model, reported_model, kind, started_at, status)
		 VALUES (?, ?, 'snap-1', 'acct-1', ?, ?, ?, ?, ?, 'upstream_send', ?, 200)`,
		[
			`att-${seq}`,
			`req-${seq}`,
			opts.provider,
			opts.outgoing,
			opts.outgoing,
			opts.outgoing,
			opts.reported,
			opts.atMs,
		],
	);
}

function series() {
	return repo
		.getModelSubstitutions({ sinceMs: T0 - BUCKET_MS, bucketMs: BUCKET_MS })
		.then((raw) => raw.series);
}

describe("getModelSubstitutions series", () => {
	it("counts every comparable attempt in the bucket's denominator", async () => {
		attempt({
			provider: "codex",
			outgoing: "gpt-6-astra",
			reported: "gpt-6-astra",
			atMs: T0,
		});
		attempt({
			provider: "codex",
			outgoing: "gpt-6-astra",
			reported: "gpt-5.6-luna",
			atMs: T0 + 1,
		});

		const points = await series();

		expect(points).toHaveLength(1);
		expect(points[0]?.comparable).toBe(2);
	});

	it("reports each mismatch with the provider that answered it", async () => {
		attempt({
			provider: "grok-subscription",
			outgoing: "grok-4.6",
			reported: "grok-4.6-build",
			atMs: T0,
		});
		attempt({
			provider: "grok-subscription",
			outgoing: "grok-4.6",
			reported: "grok-4.6-build",
			atMs: T0 + 1,
		});
		attempt({
			provider: "openrouter",
			outgoing: "grok-4.6",
			reported: "grok-4.6-build",
			atMs: T0 + 2,
		});

		const points = await series();

		expect(points).toHaveLength(1);
		expect(points[0]?.candidates).toHaveLength(2);
		const grok = points[0]?.candidates.find(
			(c) => c.provider === "grok-subscription",
		);
		const other = points[0]?.candidates.find(
			(c) => c.provider === "openrouter",
		);
		expect(grok?.count).toBe(2);
		expect(other?.count).toBe(1);
		expect(grok?.outgoingModel).toBe("grok-4.6");
		expect(grok?.reportedModel).toBe("grok-4.6-build");
	});

	it("carries no candidates for a bucket that matched throughout", async () => {
		attempt({
			provider: "codex",
			outgoing: "gpt-6-astra",
			reported: "gpt-6-astra",
			atMs: T0,
		});

		const points = await series();

		expect(points[0]?.candidates).toEqual([]);
	});

	// `routing_attempts.provider` is nullable and older rows have no value, so
	// the mismatch still has to be reported — with nothing claimed about who
	// served it.
	it("reports a mismatch recorded without a provider", async () => {
		attempt({
			provider: null,
			outgoing: "gpt-6-astra",
			reported: "gpt-5.6-luna",
			atMs: T0,
		});

		const points = await series();

		expect(points[0]?.candidates).toHaveLength(1);
		expect(points[0]?.candidates[0]?.provider).toBeNull();
		expect(points[0]?.candidates[0]?.count).toBe(1);
	});

	it("keeps buckets separate and in ascending order", async () => {
		attempt({
			provider: "codex",
			outgoing: "gpt-6-astra",
			reported: "gpt-5.6-luna",
			atMs: T0 + BUCKET_MS,
		});
		attempt({
			provider: "codex",
			outgoing: "gpt-6-astra",
			reported: "gpt-6-astra",
			atMs: T0,
		});

		const points = await series();

		expect(points).toHaveLength(2);
		expect(points[0]?.bucketMs).toBeLessThan(points[1]?.bucketMs ?? 0);
		expect(points[0]?.candidates).toEqual([]);
		expect(points[1]?.candidates).toHaveLength(1);
	});
});
