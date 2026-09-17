/**
 * Tests for `requests.client_user_agent` + `requests.client_harness` — the
 * inbound client-identity columns captured at ingress.
 *
 * Both are ingress-derived facts the usage-patch re-upsert never carries, so
 * both must survive a later upsert that omits them: the same COALESCE contract
 * `session_key` has. A regression there does not fail loudly — it silently
 * blanks the harness of every request whose usage arrived late, which is most
 * of them.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type RequestRow,
	toRequest,
	toRequestResponse,
} from "@clankermux/types";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { type RequestData, RequestRepository } from "../request.repository";

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
): { client_user_agent: string | null; client_harness: string | null } | null {
	return db
		.query(
			`SELECT client_user_agent, client_harness FROM requests WHERE id = ?`,
		)
		.get(id) as {
		client_user_agent: string | null;
		client_harness: string | null;
	} | null;
}

describe("requests client-identity columns", () => {
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
		const columns = db.query(`PRAGMA table_info(requests)`).all() as {
			name: string;
		}[];
		const names = new Set(columns.map((c) => c.name));
		expect(names.has("client_user_agent")).toBe(true);
		expect(names.has("client_harness")).toBe(true);
	});

	it("round-trips both values on insert", async () => {
		await repo.save(
			requestData({
				clientUserAgent: "claude-cli/2.1.270 (external, cli)",
				clientHarness: "claude-code",
			}),
		);
		const row = readRow(db);
		expect(row?.client_user_agent).toBe("claude-cli/2.1.270 (external, cli)");
		expect(row?.client_harness).toBe("claude-code");
	});

	it("writes NULL for both when the ingress row carried neither", async () => {
		await repo.save(requestData());
		const row = readRow(db);
		expect(row?.client_user_agent).toBeNull();
		expect(row?.client_harness).toBeNull();
	});

	it("keeps a user-agent without a harness (an unlabelled client)", async () => {
		await repo.save(
			requestData({ clientUserAgent: "!!!/1.0", clientHarness: null }),
		);
		const row = readRow(db);
		expect(row?.client_user_agent).toBe("!!!/1.0");
		expect(row?.client_harness).toBeNull();
	});

	it("preserves both across a usage-patch re-upsert that carries neither", async () => {
		await repo.save(
			requestData({
				clientUserAgent: "codex_cli_rs/0.104.0",
				clientHarness: "codex",
			}),
		);
		// The late usage patch re-upserts the same id with the response-side facts
		// only; it holds no ingress facts at all.
		await repo.save(
			requestData({
				usage: { model: "gpt-5-codex", inputTokens: 10, outputTokens: 5 },
			}),
		);
		const row = readRow(db);
		expect(row?.client_user_agent).toBe("codex_cli_rs/0.104.0");
		expect(row?.client_harness).toBe("codex");
	});

	it("does not null out a stored harness via updateUsage", async () => {
		await repo.save(
			requestData({
				clientUserAgent: "claude-cli/2.1.270",
				clientHarness: "claude-code",
			}),
		);
		await repo.updateUsage("req-1", {
			model: "claude-opus-4-8",
			inputTokens: 100,
			outputTokens: 50,
		});
		const row = readRow(db);
		expect(row?.client_user_agent).toBe("claude-cli/2.1.270");
		expect(row?.client_harness).toBe("claude-code");
	});
});

describe("gateway hint persistence", () => {
	it("round-trips all hints through SQL and type mappers after a metadata-free upsert", async () => {
		const db = makeDb();
		try {
			const adapter = new BunSqlAdapter(db);
			const repo = new RequestRepository(adapter);
			const hints = {
				gatewayHintRequestClass: "primary",
				gatewayHintAgentType: "explore",
				gatewayHintPrevToolDurations: "[12,34]",
				gatewayHintCompaction: "false",
				gatewayHintContextCompacted: "0",
			};
			await repo.save(requestData(hints));
			await repo.save(
				requestData({ usage: { model: "claude", outputTokens: 3 } }),
			);
			const row = db
				.query("SELECT * FROM requests WHERE id = ?")
				.get("req-1") as RequestRow;
			expect(toRequestResponse(toRequest(row))).toMatchObject(hints);
			await repo.save(requestData({ id: "no-hints" }));
			const absent = db
				.query("SELECT * FROM requests WHERE id = ?")
				.get("no-hints") as RequestRow;
			expect(absent.gateway_hint_agent_type).toBeNull();
			expect(
				JSON.parse(JSON.stringify(toRequestResponse(toRequest(absent)))),
			).not.toHaveProperty("gatewayHintAgentType");
		} finally {
			db.close();
		}
	});
});
