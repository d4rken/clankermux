/**
 * How a published row decides `finalized` and `usageSource`: a request row
 * from its own columns, a bridged request from its leg's evidence. The SQL
 * that sums a leg's inner rows applies the request-row rules in SQL, so the
 * two are pinned equal here over every combination of the columns they read.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
	type ClientRequestRow,
	clientRowApproximateSql,
	clientRowFinalizedSql,
} from "@clankermux/database";
import { isClientRequestFinalized, toClientUsageSource } from "../dto";

function row(overrides: Partial<ClientRequestRow>): ClientRequestRow {
	return {
		source: "request",
		id: "r1",
		timestamp: 1,
		status_code: 200,
		error_message: null,
		model: null,
		requested_model: null,
		input_tokens: null,
		output_tokens: null,
		cache_read_input_tokens: null,
		cache_creation_input_tokens: null,
		total_tokens: null,
		usage_finalized_at: null,
		usage_source: null,
		failover_attempts: null,
		project: null,
		api_key_id: "key-1",
		correlation_tag: null,
		model_substitution_discards: 0,
		leg_settled: null,
		leg_expected_calls: null,
		leg_inner_rows: null,
		leg_inner_finalized: null,
		leg_inner_approximate: null,
		leg_inner_provider: null,
		...overrides,
	};
}

describe("a request row's SQL and TypeScript rules", () => {
	it("agree on every combination of the columns they read", () => {
		const db = new Database(":memory:");
		db.run(
			"CREATE TABLE r (usage_source TEXT, usage_finalized_at INTEGER, model TEXT, total_tokens INTEGER)",
		);
		const combos: Array<
			[string | null, number | null, string | null, number | null]
		> = [];
		for (const source of [null, "provider", "approximate", "none", "other"])
			for (const finalizedAt of [null, 5])
				for (const model of [null, "m"])
					for (const total of [null, 0, 9])
						combos.push([source, finalizedAt, model, total]);
		for (const combo of combos)
			db.query("INSERT INTO r VALUES (?, ?, ?, ?)").run(...combo);
		const rows = db
			.query(
				`SELECT usage_source, usage_finalized_at, model, total_tokens,
					${clientRowFinalizedSql("r")} AS finalized,
					${clientRowApproximateSql("r")} AS approximate
				FROM r`,
			)
			.all() as Array<{
			usage_source: string | null;
			usage_finalized_at: number | null;
			model: string | null;
			total_tokens: number | null;
			finalized: number;
			approximate: number;
		}>;
		expect(rows).toHaveLength(combos.length);
		for (const sqlRow of rows) {
			const published = row(sqlRow);
			expect([sqlRow, sqlRow.finalized === 1]).toEqual([
				sqlRow,
				isClientRequestFinalized(published),
			]);
			expect([sqlRow, sqlRow.approximate === 1]).toEqual([
				sqlRow,
				toClientUsageSource(published) === "approximate",
			]);
		}
		db.close();
	});
});

describe("a bridged request", () => {
	const leg = (overrides: Partial<ClientRequestRow> = {}) =>
		row({
			source: "sdk_bridge_leg",
			leg_settled: 1,
			leg_expected_calls: 2,
			leg_inner_rows: 2,
			leg_inner_finalized: 2,
			leg_inner_approximate: 0,
			leg_inner_provider: 2,
			...overrides,
		});

	it("is final once settled with every counted call's row present and final", () => {
		expect(isClientRequestFinalized(leg())).toBe(true);
		expect(toClientUsageSource(leg())).toBe("provider");
	});

	it.each([
		["not settled", { leg_settled: 0 }],
		[
			"a counted call has no row yet",
			{ leg_inner_rows: 1, leg_inner_finalized: 1 },
		],
		["a row is still open", { leg_inner_finalized: 1 }],
		["more rows than counted calls", { leg_expected_calls: 1 }],
	] as const)("is not final when %s, and states no source", (_why, overrides) => {
		expect(isClientRequestFinalized(leg(overrides))).toBe(false);
		expect(toClientUsageSource(leg(overrides))).toBeNull();
	});

	it("ignores a request row's columns", () => {
		const settledless = leg({
			leg_settled: 0,
			usage_source: "provider",
			model: "m",
			total_tokens: 9,
		});
		expect(isClientRequestFinalized(settledless)).toBe(false);
	});

	it("reads approximate when any call does, provider when any is, none otherwise", () => {
		expect(toClientUsageSource(leg({ leg_inner_approximate: 1 }))).toBe(
			"approximate",
		);
		expect(toClientUsageSource(leg({ leg_inner_provider: 1 }))).toBe(
			"provider",
		);
		expect(toClientUsageSource(leg({ leg_inner_provider: 0 }))).toBe("none");
	});

	it("with no calls at all is final once settled, as none", () => {
		const empty = leg({
			leg_expected_calls: 0,
			leg_inner_rows: 0,
			leg_inner_finalized: 0,
			leg_inner_provider: 0,
		});
		expect(isClientRequestFinalized(empty)).toBe(true);
		expect(toClientUsageSource(empty)).toBe("none");
	});
});
