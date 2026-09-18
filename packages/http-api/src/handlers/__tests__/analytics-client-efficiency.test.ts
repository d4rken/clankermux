/**
 * The `clientEfficiency` analytics section.
 *
 * Two things are under test that no other suite covers. The RESOLVED harness is
 * a three-tier read (observed header, then session identity, then the client's
 * configured application) and the tiers must not be allowed to reorder — a row
 * that carries its own harness must never be relabelled by its key's profile.
 * And the payload is deliberately all sums and counts: the dashboard divides
 * after rolling rows up, so anything pre-divided here would be re-averaged and
 * silently wrong. The cases below pin the numerators and denominators that
 * makes possible.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter, ensureSchema } from "@clankermux/database";
import type {
	AnalyticsResponse,
	APIContext,
	ClientEfficiencyRow,
} from "../../types";
import { createAnalyticsHandler } from "../analytics-direct";

const NOW = Date.UTC(2026, 2, 15, 12, 0, 0, 0);
const HOUR = 60 * 60 * 1000;

const KEY_CC = "key-cc";
const KEY_CODEX = "key-codex";
const KEY_GENERIC = "key-generic";

let db: Database;
let context: APIContext;

interface SeedRow {
	id: string;
	apiKeyId: string | null;
	apiKeyName: string | null;
	model?: string | null;
	success?: boolean;
	costUsd?: number | null;
	costSource?: string | null;
	clientHarness?: string | null;
	sessionKey?: string | null;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
	contextSystemChars?: number | null;
	contextToolsChars?: number | null;
	contextToolCount?: number | null;
	contextMessagesChars?: number | null;
	contextToolResultChars?: number | null;
	contextMessageCount?: number | null;
	project?: string | null;
}

function insertKey(id: string, name: string): void {
	db.run(
		`INSERT INTO api_keys (id, name, hashed_key, prefix_last_8, created_at, last_used, usage_count, is_active)
		 VALUES (?, ?, ?, ?, ?, NULL, 0, 1)`,
		[id, name, `hash-${id}`, id.slice(0, 8), NOW - HOUR],
	);
}

function insertProfile(apiKeyId: string, application: string): void {
	db.run(
		`INSERT INTO client_profiles (api_key_id, application, revision, catalogues, notices)
		 VALUES (?, ?, 1, '{}', '[]')`,
		[apiKeyId, application],
	);
}

function insertRequest(row: SeedRow): void {
	db.run(
		`INSERT INTO requests (
			id, timestamp, method, path, account_used, status_code, success,
			error_message, response_time_ms, failover_attempts, model, total_tokens,
			cost_usd, cost_source, input_tokens, cache_read_input_tokens,
			cache_creation_input_tokens, output_tokens, billing_type, api_key_id,
			api_key_name, client_harness, session_key, context_system_chars,
			context_tools_chars, context_tool_count, context_messages_chars,
			context_tool_result_chars, context_message_count, project
		) VALUES (?, ?, 'POST', '/v1/messages', 'acct-a', 200, ?, NULL, 500, 0, ?, 0,
			?, ?, ?, ?, ?, ?, 'plan', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			row.id,
			NOW - HOUR,
			row.success === false ? 0 : 1,
			row.model === undefined ? "claude-opus-4-8" : row.model,
			row.costUsd === undefined ? 0.01 : row.costUsd,
			row.costSource === undefined ? "estimated" : row.costSource,
			row.inputTokens ?? 100,
			row.cacheReadTokens ?? 200,
			row.cacheCreationTokens ?? 50,
			row.outputTokens ?? 20,
			row.apiKeyId,
			row.apiKeyName,
			row.clientHarness ?? null,
			row.sessionKey ?? null,
			row.contextSystemChars ?? null,
			row.contextToolsChars ?? null,
			row.contextToolCount ?? null,
			row.contextMessagesChars ?? null,
			row.contextToolResultChars ?? null,
			row.contextMessageCount ?? null,
			row.project ?? null,
		],
	);
}

async function fetchSection(
	query = "range=all&sections=clientEfficiency",
): Promise<AnalyticsResponse> {
	const response = await createAnalyticsHandler(context)(
		new URLSearchParams(query),
	);
	expect(response.status).toBe(200);
	return (await response.json()) as AnalyticsResponse;
}

function rowFor(
	body: AnalyticsResponse,
	apiKeyId: string | null,
	harness: string | null,
): ClientEfficiencyRow {
	const row = body.clientEfficiency?.rows.find(
		(candidate) =>
			candidate.apiKeyId === apiKeyId && candidate.harness === harness,
	);
	if (!row) {
		throw new Error(
			`no row for ${apiKeyId ?? "(no key)"} / ${harness ?? "(no harness)"}`,
		);
	}
	return row;
}

beforeEach(() => {
	db = new Database(":memory:");
	ensureSchema(db);
	insertKey(KEY_CC, "cc-key");
	insertKey(KEY_CODEX, "codex-key");
	insertKey(KEY_GENERIC, "generic-key");
	const adapter = new BunSqlAdapter(db);
	context = {
		db: adapter,
		config: {},
		dbOps: { getAdapter: () => adapter },
	} as unknown as APIContext;
});

afterEach(() => {
	db.close();
});

describe("clientEfficiency — resolved harness precedence", () => {
	it("prefers the OBSERVED harness over both inference tiers", async () => {
		// Everything the two lower tiers could say points at claude-code; the
		// row's own header says codex. Letting the profile win here would relabel
		// a measurement with a guess.
		insertProfile(KEY_CC, "claude-code");
		insertRequest({
			id: "r-1",
			apiKeyId: KEY_CC,
			apiKeyName: "cc-key",
			clientHarness: "codex",
			sessionKey: `${KEY_CC}:session-1`,
		});

		const body = await fetchSection();
		const row = rowFor(body, KEY_CC, "codex");
		expect(row.observedRequests).toBe(1);
		expect(row.inferredSessionRequests).toBe(0);
		expect(row.inferredDeclaredRequests).toBe(0);
		expect(row.declaredApplication).toBe("claude-code");
	});

	it("falls back to session identity before the declared application", async () => {
		insertProfile(KEY_CODEX, "codex");
		insertRequest({
			id: "r-1",
			apiKeyId: KEY_CODEX,
			apiKeyName: "codex-key",
			sessionKey: `${KEY_CODEX}:session-1`,
		});

		const body = await fetchSection();
		// Only Claude Code's metadata.user_id produces a session key, so its
		// presence outranks a stale configured application.
		const row = rowFor(body, KEY_CODEX, "claude-code");
		expect(row.inferredSessionRequests).toBe(1);
		expect(row.inferredDeclaredRequests).toBe(0);
	});

	it("falls back to the declared application when nothing else speaks", async () => {
		insertProfile(KEY_CODEX, "codex");
		insertRequest({ id: "r-1", apiKeyId: KEY_CODEX, apiKeyName: "codex-key" });

		const body = await fetchSection();
		const row = rowFor(body, KEY_CODEX, "codex");
		expect(row.inferredDeclaredRequests).toBe(1);
		expect(row.observedRequests).toBe(0);
	});

	it("treats a generic profile as declaring nothing", async () => {
		insertProfile(KEY_GENERIC, "generic");
		insertRequest({
			id: "r-1",
			apiKeyId: KEY_GENERIC,
			apiKeyName: "generic-key",
		});

		const body = await fetchSection();
		const row = rowFor(body, KEY_GENERIC, null);
		expect(row.harness).toBeNull();
		expect(row.declaredApplication).toBe("generic");
		expect(row.inferredDeclaredRequests).toBe(0);
	});
});

describe("clientEfficiency — provenance counts", () => {
	it("keeps the three counts separate on a group mixing observed and inferred rows", async () => {
		// One observed row among three inferred ones. A single collapsed "source"
		// label would report this whole group as observed and the UI would drop
		// the inferred marking entirely.
		insertProfile(KEY_CC, "claude-code");
		insertRequest({
			id: "r-1",
			apiKeyId: KEY_CC,
			apiKeyName: "cc-key",
			clientHarness: "claude-code",
		});
		insertRequest({
			id: "r-2",
			apiKeyId: KEY_CC,
			apiKeyName: "cc-key",
			sessionKey: `${KEY_CC}:session-1`,
		});
		insertRequest({
			id: "r-3",
			apiKeyId: KEY_CC,
			apiKeyName: "cc-key",
			sessionKey: `${KEY_CC}:session-2`,
		});
		insertRequest({ id: "r-4", apiKeyId: KEY_CC, apiKeyName: "cc-key" });

		const body = await fetchSection();
		const row = rowFor(body, KEY_CC, "claude-code");
		expect(row.requests).toBe(4);
		expect(row.observedRequests).toBe(1);
		expect(row.inferredSessionRequests).toBe(2);
		expect(row.inferredDeclaredRequests).toBe(1);
		// The three provenance counts partition the group exactly.
		expect(
			row.observedRequests +
				row.inferredSessionRequests +
				row.inferredDeclaredRequests,
		).toBe(row.requests);
	});

	it("splits one key across two harnesses into rows that sum back to the key's totals", async () => {
		insertProfile(KEY_CC, "claude-code");
		insertRequest({
			id: "r-1",
			apiKeyId: KEY_CC,
			apiKeyName: "cc-key",
			clientHarness: "claude-code",
			inputTokens: 100,
			outputTokens: 10,
			costUsd: 0.02,
		});
		insertRequest({
			id: "r-2",
			apiKeyId: KEY_CC,
			apiKeyName: "cc-key",
			clientHarness: "claude-code",
			inputTokens: 100,
			outputTokens: 10,
			costUsd: 0.02,
		});
		insertRequest({
			id: "r-3",
			apiKeyId: KEY_CC,
			apiKeyName: "cc-key",
			clientHarness: "codex",
			inputTokens: 300,
			outputTokens: 30,
			costUsd: 0.06,
		});

		const body = await fetchSection();
		const claudeCode = rowFor(body, KEY_CC, "claude-code");
		const codex = rowFor(body, KEY_CC, "codex");
		expect(claudeCode.requests).toBe(2);
		expect(codex.requests).toBe(1);
		expect(claudeCode.inputTokens + codex.inputTokens).toBe(500);
		expect(claudeCode.outputTokens + codex.outputTokens).toBe(50);
		expect(claudeCode.costUsd + codex.costUsd).toBeCloseTo(0.1, 10);
		expect(claudeCode.successfulRequests + codex.successfulRequests).toBe(3);
	});

	it("does not truncate a small result set", async () => {
		insertRequest({ id: "r-1", apiKeyId: KEY_CC, apiKeyName: "cc-key" });
		const body = await fetchSection();
		expect(body.clientEfficiency?.truncated).toBe(false);
	});
});

describe("clientEfficiency — cost coverage", () => {
	it("counts unpriced rows instead of coercing their cost to zero", async () => {
		// A client whose models have no pricing must not read as free: the cost
		// column has to be divided by the PRICED rows, and the unpriced count is
		// what says how much of the group that leaves out.
		insertRequest({
			id: "r-1",
			apiKeyId: KEY_CC,
			apiKeyName: "cc-key",
			clientHarness: "claude-code",
			costUsd: 0.5,
			costSource: "estimated",
		});
		insertRequest({
			id: "r-2",
			apiKeyId: KEY_CC,
			apiKeyName: "cc-key",
			clientHarness: "claude-code",
			costUsd: null,
			costSource: null,
		});
		insertRequest({
			id: "r-3",
			apiKeyId: KEY_CC,
			apiKeyName: "cc-key",
			clientHarness: "claude-code",
			costUsd: null,
			costSource: null,
		});

		const body = await fetchSection();
		const row = rowFor(body, KEY_CC, "claude-code");
		expect(row.requests).toBe(3);
		expect(row.pricedRequests).toBe(1);
		expect(row.unpricedRequests).toBe(2);
		expect(row.costUsd).toBeCloseTo(0.5, 10);
	});
});

describe("clientEfficiency — context coverage", () => {
	it("counts only the rows carrying the context columns as the denominator", async () => {
		insertRequest({
			id: "r-1",
			apiKeyId: KEY_CC,
			apiKeyName: "cc-key",
			clientHarness: "claude-code",
			inputTokens: 100,
			cacheReadTokens: 200,
			cacheCreationTokens: 50,
			contextMessagesChars: 9000,
			contextSystemChars: 1000,
			contextToolsChars: 2000,
			contextToolCount: 7,
		});
		// Same tokens, no context columns: it must not enter the denominator or
		// any of the sums, or the averages the UI derives are diluted by rows
		// that were never measured.
		insertRequest({
			id: "r-2",
			apiKeyId: KEY_CC,
			apiKeyName: "cc-key",
			clientHarness: "claude-code",
			inputTokens: 100,
			cacheReadTokens: 200,
			cacheCreationTokens: 50,
		});

		const body = await fetchSection();
		const row = rowFor(body, KEY_CC, "claude-code");
		expect(row.requests).toBe(2);
		expect(row.contextCoveredRequests).toBe(1);
		// Real context tokens = uncached input + both cache buckets.
		expect(row.contextTokensSum).toBe(350);
		expect(row.contextSystemCharsSum).toBe(1000);
		expect(row.contextToolsCharsSum).toBe(2000);
		expect(row.contextToolCountSum).toBe(7);
	});
});

describe("clientEfficiency — context breakdown", () => {
	const measured = {
		apiKeyId: KEY_CC,
		apiKeyName: "cc-key",
		clientHarness: "claude-code",
		contextSystemChars: 100,
		contextToolsChars: 200,
		contextMessagesChars: 1000,
		contextToolResultChars: 600,
		contextMessageCount: 8,
	};

	it("uses the same fully measured cohort for every sum and excludes tool results from other messages", async () => {
		insertRequest({ id: "measured", ...measured });
		insertRequest({
			id: "unmeasured",
			apiKeyId: KEY_CC,
			apiKeyName: "cc-key",
			clientHarness: "claude-code",
		});
		for (const field of [
			"contextSystemChars",
			"contextToolsChars",
			"contextMessagesChars",
			"contextToolResultChars",
			"contextMessageCount",
		] as const) {
			insertRequest({ id: `missing-${field}`, ...measured, [field]: null });
		}

		const row = rowFor(await fetchSection(), KEY_CC, "claude-code");
		expect(row.requests).toBe(7);
		expect(row.contextCoveredRequests).toBe(5);
		expect(row.contextSystemCharsSum).toBe(500);
		expect(row.contextBreakdown).toEqual({
			coveredRequests: 1,
			systemCharsSum: 100,
			toolsCharsSum: 200,
			toolResultCharsSum: 600,
			otherMessagesCharsSum: 400,
			messageCountSum: 8,
		});
	});

	it("counts measured zeros while keeping unmeasured groups uncovered", async () => {
		insertRequest({
			id: "zero",
			...measured,
			contextSystemChars: 0,
			contextToolsChars: 0,
			contextMessagesChars: 0,
			contextToolResultChars: 0,
			contextMessageCount: 0,
		});
		insertRequest({
			id: "unknown",
			apiKeyId: KEY_CODEX,
			apiKeyName: "codex-key",
			clientHarness: "codex",
		});
		const body = await fetchSection();
		const sums = {
			systemCharsSum: 0,
			toolsCharsSum: 0,
			toolResultCharsSum: 0,
			otherMessagesCharsSum: 0,
			messageCountSum: 0,
		};
		expect(rowFor(body, KEY_CC, "claude-code").contextBreakdown).toEqual({
			coveredRequests: 1,
			...sums,
		});
		expect(rowFor(body, KEY_CODEX, "codex").contextBreakdown).toEqual({
			coveredRequests: 0,
			...sums,
		});
	});

	it("keeps measured sums separate for observed and inferred harness groups on one key", async () => {
		insertProfile(KEY_CC, "codex");
		insertRequest({ id: "observed", ...measured });
		insertRequest({
			id: "session",
			...measured,
			clientHarness: null,
			sessionKey: `${KEY_CC}:session-1`,
		});
		insertRequest({
			id: "declared",
			...measured,
			clientHarness: null,
			contextMessagesChars: 1500,
			contextToolResultChars: 500,
			contextMessageCount: 12,
		});
		const body = await fetchSection();
		expect(rowFor(body, KEY_CC, "claude-code").contextBreakdown).toEqual({
			coveredRequests: 2,
			systemCharsSum: 200,
			toolsCharsSum: 400,
			toolResultCharsSum: 1200,
			otherMessagesCharsSum: 800,
			messageCountSum: 16,
		});
		expect(rowFor(body, KEY_CC, "codex").contextBreakdown).toEqual({
			coveredRequests: 1,
			systemCharsSum: 100,
			toolsCharsSum: 200,
			toolResultCharsSum: 500,
			otherMessagesCharsSum: 1000,
			messageCountSum: 12,
		});
	});

	it("applies model, project, key and status filters to the measured cohort", async () => {
		const selected = {
			...measured,
			model: "shared-model",
			project: "project-a",
		};
		insertRequest({ id: "selected", ...selected });
		insertRequest({ id: "other-model", ...selected, model: "other-model" });
		insertRequest({ id: "other-project", ...selected, project: "project-b" });
		insertRequest({ id: "other-key", ...selected, apiKeyId: KEY_CODEX });
		insertRequest({ id: "error", ...selected, success: false });
		const body = await fetchSection(
			`range=all&sections=clientEfficiency&models=shared-model&projects=project-a&apiKeys=${KEY_CC}&status=success`,
		);
		expect(body.clientEfficiency?.rows).toHaveLength(1);
		expect(rowFor(body, KEY_CC, "claude-code").contextBreakdown).toEqual({
			coveredRequests: 1,
			systemCharsSum: 100,
			toolsCharsSum: 200,
			toolResultCharsSum: 600,
			otherMessagesCharsSum: 400,
			messageCountSum: 8,
		});
	});
});

describe("clientEfficiency — filters", () => {
	it("narrows the rows to the filtered API key", async () => {
		insertRequest({
			id: "r-1",
			apiKeyId: KEY_CC,
			apiKeyName: "cc-key",
			clientHarness: "claude-code",
		});
		insertRequest({
			id: "r-2",
			apiKeyId: KEY_CODEX,
			apiKeyName: "codex-key",
			clientHarness: "codex",
		});

		const body = await fetchSection(
			`range=all&sections=clientEfficiency&apiKeys=${KEY_CC}`,
		);
		expect(body.clientEfficiency?.rows.map((row) => row.apiKeyId)).toEqual([
			KEY_CC,
		]);
	});
});

describe("clientModelEfficiency", () => {
	it("drops (key × model) pairs below the request floor and keeps the rest", async () => {
		for (let i = 0; i < 5; i++) {
			insertRequest({
				id: `busy-${i}`,
				apiKeyId: KEY_CC,
				apiKeyName: "cc-key",
				model: "claude-opus-4-8",
				inputTokens: 100,
				outputTokens: 10,
				costUsd: 0.01,
			});
		}
		for (let i = 0; i < 4; i++) {
			insertRequest({
				id: `quiet-${i}`,
				apiKeyId: KEY_CC,
				apiKeyName: "cc-key",
				model: "claude-sonnet-5",
			});
		}

		const body = await fetchSection();
		expect(body.clientModelEfficiency?.map((row) => row.model)).toEqual([
			"claude-opus-4-8",
		]);
		const row = body.clientModelEfficiency?.[0];
		expect(row?.requests).toBe(5);
		expect(row?.inputTokens).toBe(500);
		expect(row?.outputTokens).toBe(50);
		expect(row?.costUsd).toBeCloseTo(0.05, 10);
		expect(row?.pricedRequests).toBe(5);
		expect(row?.unpricedRequests).toBe(0);
	});

	it("excludes rows with no API key, which have no client to compare", async () => {
		for (let i = 0; i < 6; i++) {
			insertRequest({
				id: `anon-${i}`,
				apiKeyId: null,
				apiKeyName: null,
				model: "claude-opus-4-8",
			});
		}

		const body = await fetchSection();
		expect(body.clientModelEfficiency).toEqual([]);
	});
});

describe("clientEfficiency — section scoping", () => {
	it("omits both fields when the section was not requested", async () => {
		insertRequest({ id: "r-1", apiKeyId: KEY_CC, apiKeyName: "cc-key" });
		const body = await fetchSection("range=all&sections=totals");
		expect(body).not.toHaveProperty("clientEfficiency");
		expect(body).not.toHaveProperty("clientModelEfficiency");
	});

	it("appears in the resolved section set when requested", async () => {
		insertRequest({ id: "r-1", apiKeyId: KEY_CC, apiKeyName: "cc-key" });
		const body = await fetchSection();
		expect(body.meta?.sections).toContain("clientEfficiency");
	});
});
