import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "@clankermux/core";
import type { RoutingRule } from "@clankermux/types";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { RoutingRepository } from "../routing.repository";

const rule = (id: string, position: number): RoutingRule => ({
	id,
	position,
	name: id,
	enabled: true,
	match_api_key_id: null,
	match_model_kind: "any",
	match_model_value: null,
	pool_kind: "inherit",
	pool_provider: null,
	pool_account_ids: null,
	target_kind: "default",
	target_model: null,
});
describe("routing storage", () => {
	let db: Database;
	let repo: RoutingRepository;
	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		repo = new RoutingRepository(new BunSqlAdapter(db));
	});
	afterEach(() => db.close());
	it("swaps unique positions atomically and rejects incomplete reorder", async () => {
		await repo.saveRule(rule("a", 0));
		await repo.saveRule(rule("b", 1));
		await repo.reorderRules(["b", "a"]);
		expect((await repo.listRules()).map((r) => r.id)).toEqual(["b", "a"]);
		await expect(repo.reorderRules(["a"])).rejects.toThrow();
		expect((await repo.listRules()).map((r) => r.id)).toEqual(["b", "a"]);
	});
	it("rejects dangling references without installing a widened rule", async () => {
		await expect(
			repo.saveRule({ ...rule("a", 0), match_api_key_id: "missing" }),
		).rejects.toThrow();
		await expect(
			repo.saveRule({
				...rule("a", 0),
				pool_kind: "accounts",
				pool_account_ids: ["missing"],
			}),
		).rejects.toThrow();
		expect(await repo.listRules()).toEqual([]);
	});
	it("preserves manual IDs and last good evidence on failed discovery and rejects late generations", async () => {
		const first = await repo.ensurePermissionScope("a", "scope-a");
		expect(first.completeness).toBe("unknown");
		const manual = await repo.setManualModels("a", "scope-a", ["manual"]);
		expect(
			await repo.completeDiscovery(
				"a",
				"scope-a",
				first.generation,
				["stale"],
				100,
			),
		).toBe(false);
		expect(
			await repo.completeDiscovery(
				"a",
				"scope-a",
				manual.generation,
				["discovered"],
				110,
			),
		).toBe(true);
		await repo.failDiscovery(
			"a",
			"scope-a",
			manual.generation,
			"unavailable",
			120,
		);
		expect(await repo.getPermissions("a")).toMatchObject({
			discovered_ids: ["discovered"],
			manual_ids: ["manual"],
			last_success_at: 110,
			last_error: "unavailable",
		});
		const changed = await repo.ensurePermissionScope("a", "scope-b");
		expect(changed).toMatchObject({
			completeness: "unknown",
			discovered_ids: [],
			manual_ids: [],
		});
		expect(
			await repo.completeDiscovery(
				"a",
				"scope-a",
				manual.generation,
				["late"],
				130,
			),
		).toBe(false);
	});
	it("supports deliberate empty manual-only permissions and rejection suppression survives refresh", async () => {
		const p = await repo.setManualModels("a", "scope", [], true);
		expect(p.completeness).toBe("known-empty");
		await repo.suppressModel("a", "scope", "m", 500, "model_not_found");
		await repo.completeDiscovery("a", "scope", p.generation, ["m"], 100);
		expect(await repo.isModelSuppressed("a", "scope", "m", 200)).toBe(true);
		expect(await repo.isModelSuppressed("a", "scope", "m", 501)).toBe(false);
		expect(await repo.isModelSuppressed("a", "new-scope", "m", 200)).toBe(
			false,
		);
	});
	it("refuses deletion of rule and pin references and retains attempts with parent retention", async () => {
		db.run(
			"INSERT INTO accounts(id,name,provider,refresh_token,created_at) VALUES('a','A','codex','',0)",
		);
		db.run(
			"INSERT INTO api_keys(id,name,hashed_key,prefix_last_8,created_at,pinned_account_id) VALUES('k','K','hash','suffix',0,'a')",
		);
		await repo.saveRule({
			...rule("r", 0),
			match_api_key_id: "k",
			pool_kind: "accounts",
			pool_account_ids: ["a"],
		});
		expect(() => db.run("DELETE FROM accounts WHERE id='a'")).toThrow();
		expect(() => db.run("DELETE FROM api_keys WHERE id='k'")).toThrow();
		await repo.recordAttempt({
			id: "attempt",
			request_id: "request",
			rule_id: "r",
			route_snapshot: "{}",
			account_id: "a",
			provider: "codex",
			requested_model: "claude-fable-5-1",
			resolved_model: "gpt-6-astra",
			outgoing_model: "gpt-6-astra",
			reported_model: null,
			kind: "upstream_send",
			started_at: 10,
			finished_at: null,
			status: null,
			error: null,
		});
		expect(await repo.listAttempts("request")).toHaveLength(1);
		expect(
			db.query("SELECT COUNT(*) AS n FROM routing_snapshots").get(),
		).toEqual({ n: 1 });
		expect((await repo.listAttempts("request"))[0]?.route_snapshot).toBe("{}");
		db.run(
			"INSERT INTO requests(id,timestamp,method,path,status_code,success) VALUES('request',0,'POST','/v1/messages',200,1)",
		);
		db.run("DELETE FROM requests WHERE id='request'");
		expect(await repo.listAttempts("request")).toHaveLength(0);
		expect(
			db.query("SELECT COUNT(*) AS n FROM routing_snapshots").get(),
		).toEqual({ n: 0 });
	});
	it("manual additions preserve unknown discovery and explicit empty intent is distinct", async () => {
		const p = await repo.setManualModels("a", "scope", ["manual"]);
		expect(p.completeness).toBe("unknown");
		expect(await repo.ensurePermissionScope("a", "scope")).toEqual(p);
		expect((await repo.setManualModels("a", "scope", [])).completeness).toBe(
			"unknown",
		);
		expect(
			(await repo.setManualModels("a", "scope", [], true)).completeness,
		).toBe("known-empty");
	});
	it("deleting an unreferenced account clears evidence even with inherit rules", async () => {
		db.run(
			"INSERT INTO accounts(id,name,provider,refresh_token,created_at) VALUES('a','A','codex','',0)",
		);
		await repo.saveRule(rule("inherit", 0));
		await repo.setManualModels("a", "scope", ["m"]);
		await repo.suppressModel("a", "scope", "m", 500, "rejected");
		db.run("DELETE FROM accounts WHERE id='a'");
		expect(await repo.getPermissions("a")).toBeNull();
		expect(await repo.isModelSuppressed("a", "scope", "m", 0)).toBe(false);
	});
	it("rejects keyed rules that conflict with the key's destinations", async () => {
		db.run(
			"INSERT INTO accounts(id,name,provider,refresh_token,created_at) VALUES('a','A','codex','',0),('b','B','openrouter','',0)",
		);
		db.run(
			"INSERT INTO api_keys(id,name,hashed_key,prefix_last_8,created_at,pinned_account_id) VALUES('k','K','hash','suffix',0,'a')",
		);
		await expect(
			repo.saveRule({
				...rule("r", 0),
				match_api_key_id: "k",
				pool_kind: "provider",
				pool_provider: "openrouter",
			}),
		).rejects.toThrow();
		await expect(
			repo.saveRule({
				...rule("r", 0),
				match_api_key_id: "k",
				pool_kind: "accounts",
				pool_account_ids: ["b"],
			}),
		).rejects.toThrow();
	});
	it("generation zero cannot overwrite a concurrently provisioned scope", async () => {
		const current = await repo.setManualModels("a", "new-scope", ["manual"]);
		expect(await repo.ensurePermissionScope("a", "stale-scope", 0)).toEqual(
			current,
		);
	});
	it("preserves permissions for inert endpoint JSON edits and invalidates actual destination changes", async () => {
		const endpoint = JSON.stringify({
			endpoint: "https://backend.test/v1",
			modelMappings: { old: "one" },
		});
		db.run(
			"INSERT INTO accounts(id,name,provider,refresh_token,created_at,custom_endpoint) VALUES('a','A','codex','',0,?)",
			[endpoint],
		);
		const before = await repo.setManualModels("a", "scope", ["manual"]);
		await repo.suppressModel("a", "scope", "manual", 500, "rejected");
		db.run("UPDATE accounts SET custom_endpoint=? WHERE id='a'", [
			JSON.stringify({
				endpoint: "https://backend.test/v1",
				modelMappings: { old: "two" },
			}),
		]);
		expect(await repo.getPermissions("a")).toEqual(before);
		db.run(
			"UPDATE accounts SET access_token='rotated',refresh_token='rotated' WHERE id='a'",
		);
		expect(await repo.getPermissions("a")).toEqual(before);
		db.run(
			"UPDATE accounts SET custom_endpoint='https://other.test/v1' WHERE id='a'",
		);
		expect(await repo.getPermissions("a")).toMatchObject({
			scope: "invalidated",
			manual_ids: [],
			completeness: "unknown",
		});
		expect(await repo.isModelSuppressed("a", "scope", "manual", 0)).toBe(false);
	});
});
