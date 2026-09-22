import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MODEL_SUBSTITUTION_SUPPRESSION_REASON } from "@clankermux/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { RoutingRepository } from "../routing.repository";

/**
 * Two writers can finish one discarded attempt, in either order.
 *
 * `annotateAttempt` carries the semantic reason from the failover decision.
 * `finishAttempt` carries what the response observer saw, and on a cancelled
 * body it still runs. Neither awaits the other, so the reason has to survive
 * both orders — every read of `routing_attempts.error` depends on it, including
 * the discard count the client API publishes.
 */
describe("attempt reason survives either write order", () => {
	let db: Database;
	let repo: RoutingRepository;

	const record = async (id: string): Promise<void> => {
		await repo.recordAttempt({
			id,
			request_id: "req-1",
			rule_id: null,
			route_snapshot: "{}",
			account_id: "acct-1",
			provider: "codex",
			requested_model: "gpt-6-astra",
			resolved_model: "gpt-6-astra",
			outgoing_model: "gpt-6-astra",
			reported_model: null,
			kind: "upstream_send",
			started_at: 1,
			finished_at: null,
			status: null,
			error: null,
			reasoning_effort_requested: null,
			reasoning_effort_effective: null,
			reasoning_effort_reason: null,
		});
	};

	const errorOf = (id: string): unknown =>
		(
			db.query("SELECT error FROM routing_attempts WHERE id=?").get(id) as {
				error: unknown;
			} | null
		)?.error;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		repo = new RoutingRepository(new BunSqlAdapter(db));
	});
	afterEach(() => db.close());

	it("keeps the reason when the observer finishes first", async () => {
		await record("a");
		await repo.finishAttempt("a", 2, 200, null, "gpt-5.6-luna");
		await repo.annotateAttempt(
			"a",
			MODEL_SUBSTITUTION_SUPPRESSION_REASON,
			200,
			"gpt-5.6-luna",
		);

		expect(errorOf("a")).toBe(MODEL_SUBSTITUTION_SUPPRESSION_REASON);
	});

	it("keeps the reason over the observer's own cancellation error", async () => {
		// The discarded body's observer does still complete, and it reports the
		// cancellation rather than a null. Arriving first, that error would be the
		// one a later COALESCE preserved.
		await record("c");
		await repo.finishAttempt(
			"c",
			2,
			200,
			"Response consumption canceled",
			null,
		);
		await repo.annotateAttempt(
			"c",
			MODEL_SUBSTITUTION_SUPPRESSION_REASON,
			200,
			"gpt-5.6-luna",
		);

		expect(errorOf("c")).toBe(MODEL_SUBSTITUTION_SUPPRESSION_REASON);
	});

	it("keeps the reason when the failover decision lands first", async () => {
		await record("b");
		await repo.annotateAttempt(
			"b",
			MODEL_SUBSTITUTION_SUPPRESSION_REASON,
			200,
			"gpt-5.6-luna",
		);
		await repo.finishAttempt("b", 2, 200, null, "gpt-5.6-luna");

		expect(errorOf("b")).toBe(MODEL_SUBSTITUTION_SUPPRESSION_REASON);
	});
});
