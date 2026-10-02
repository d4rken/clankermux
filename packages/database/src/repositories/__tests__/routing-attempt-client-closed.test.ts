import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CLIENT_CLOSED_REQUEST } from "@clankermux/types";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { RoutingRepository } from "../routing.repository";

/**
 * The client left while this attempt's upstream send was still in flight.
 * One conditional UPDATE decides whether the attempt is stamped 499; the
 * guard on the other writers then protects only rows that UPDATE wrote.
 */
describe("client-closed attempt stamp", () => {
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
			service_tier_requested: null,
			service_tier_sent: null,
			service_tier_reason: null,
		});
	};

	const row = (id: string) =>
		db
			.query(
				"SELECT status, error, finished_at, reported_model FROM routing_attempts WHERE id=?",
			)
			.get(id) as {
			status: number | null;
			error: string | null;
			finished_at: number | null;
			reported_model: string | null;
		};

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		repo = new RoutingRepository(new BunSqlAdapter(db));
	});
	afterEach(() => db.close());

	it("stamps a send that is still open", async () => {
		await record("a");
		expect(await repo.finishAttemptClientClosed("a", 50)).toBe(true);
		expect(row("a")).toEqual({
			status: 499,
			error: CLIENT_CLOSED_REQUEST,
			finished_at: 50,
			reported_model: null,
		});
	});

	it("keeps the stamp when the response observer finishes afterwards", async () => {
		await record("a");
		await repo.finishAttemptClientClosed("a", 50);
		await repo.finishAttempt("a", 60, 200, null, "gpt-6-astra");
		await repo.annotateAttempt("a", "network_error", 502);
		expect(row("a")).toMatchObject({
			status: 499,
			error: CLIENT_CLOSED_REQUEST,
			finished_at: 50,
		});
	});

	it("stamps over a transport failure the abort itself caused", async () => {
		await record("a");
		await repo.finishAttempt("a", 40, 502, "Upstream transport failed", null);
		expect(await repo.finishAttemptClientClosed("a", 50)).toBe(true);
		// The transport already said when the send ended.
		expect(row("a")).toMatchObject({
			status: 499,
			error: CLIENT_CLOSED_REQUEST,
			finished_at: 40,
		});
	});

	it.each([
		"Upstream response stream failed",
		"Response consumption canceled",
	])("stamps over the observer's %s", async (error) => {
		await record("a");
		await repo.finishAttempt("a", 40, 200, error, null);
		expect(await repo.finishAttemptClientClosed("a", 50)).toBe(true);
		expect(row("a")).toMatchObject({
			status: 499,
			error: CLIENT_CLOSED_REQUEST,
		});
	});

	it("leaves a completed 429 alone", async () => {
		await record("a");
		await repo.finishAttempt("a", 40, 429, "Upstream HTTP 429", null);
		expect(await repo.finishAttemptClientClosed("a", 50)).toBe(false);
		expect(row("a")).toMatchObject({ status: 429, error: "Upstream HTTP 429" });
	});

	it("leaves a completed in-band failure with HTTP 200 alone", async () => {
		await record("a");
		await repo.finishAttempt("a", 40, 200, "Upstream response failed", null);
		expect(await repo.finishAttemptClientClosed("a", 50)).toBe(false);
		expect(row("a")).toMatchObject({
			status: 200,
			error: "Upstream response failed",
		});
	});

	it("leaves a completed success alone", async () => {
		await record("a");
		await repo.finishAttempt("a", 40, 200, null, "gpt-6-astra");
		expect(await repo.finishAttemptClientClosed("a", 50)).toBe(false);
		expect(row("a")).toMatchObject({ status: 200, error: null });
	});

	it("leaves a semantic failover reason alone", async () => {
		await record("a");
		await repo.annotateAttempt("a", "server_error", 200);
		expect(await repo.finishAttemptClientClosed("a", 50)).toBe(false);
		expect(row("a")).toMatchObject({ status: 200, error: "server_error" });
	});

	it("never stamps a local rejection", async () => {
		await repo.recordAttempt({
			id: "local",
			request_id: "req-1",
			rule_id: null,
			route_snapshot: "{}",
			account_id: "acct-1",
			provider: "codex",
			requested_model: "gpt-6-astra",
			resolved_model: "gpt-6-astra",
			outgoing_model: null,
			reported_model: null,
			kind: "local_reject",
			started_at: 1,
			finished_at: null,
			status: null,
			error: null,
			reasoning_effort_requested: null,
			reasoning_effort_effective: null,
			reasoning_effort_reason: null,
			service_tier_requested: null,
			service_tier_sent: null,
			service_tier_reason: null,
		});
		expect(await repo.finishAttemptClientClosed("local", 50)).toBe(false);
		expect(row("local")).toMatchObject({ status: null, error: null });
	});

	it("leaves no protected row behind when the stamp itself fails", async () => {
		await record("a");
		db.run(`CREATE TEMP TRIGGER refuse_stamp BEFORE UPDATE ON routing_attempts
			WHEN NEW.status = 499 BEGIN SELECT RAISE(ABORT, 'refused'); END`);
		await expect(repo.finishAttemptClientClosed("a", 50)).rejects.toThrow(
			"refused",
		);
		db.run("DROP TRIGGER refuse_stamp");
		await repo.finishAttempt("a", 60, 200, null, "gpt-6-astra");
		expect(row("a")).toMatchObject({
			status: 200,
			error: null,
			finished_at: 60,
		});
	});
});
