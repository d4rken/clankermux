import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { defaultProjectRules } from "@clankermux/types";
import {
	applyProjectRepairs,
	planMissingProjects,
} from "./backfill-missing-projects";

test("backfill fills supported missing projects, preserves other rows, and is idempotent", async () => {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE requests (id TEXT PRIMARY KEY, timestamp INTEGER, method TEXT,
		 path TEXT, project TEXT, project_attribution_source TEXT);
		CREATE TABLE request_payloads (id TEXT PRIMARY KEY, json TEXT);
	`);
	const insert = db.query(
		"INSERT INTO requests VALUES (?, ?, 'POST', '/v1/messages', ?, ?)",
	);
	const save = db.query("INSERT INTO request_payloads VALUES (?, ?)");
	const body = {
		messages: [
			{ role: "system", content: "Primary working directory: /home/u/repo" },
		],
	};
	const envelope = (value: unknown) =>
		JSON.stringify({
			request: { body: Buffer.from(JSON.stringify(value)).toString("base64") },
		});
	for (const id of [
		"repair",
		"existing",
		"concurrent",
		"source-changed",
		"future",
		"no-payload",
		"capped",
		"invalid",
		"unknown",
	]) {
		insert.run(
			id,
			id === "future" ? 200 : 100,
			id === "existing" ? "keep" : null,
			"none",
		);
		if (id !== "no-payload") save.run(id, envelope(body));
	}
	db.query("UPDATE request_payloads SET json = ? WHERE id = ?").run(
		JSON.stringify({ request: { body: null } }),
		"capped",
	);
	db.query("UPDATE request_payloads SET json = ? WHERE id = ?").run(
		"bad json",
		"invalid",
	);
	db.query("UPDATE request_payloads SET json = ? WHERE id = ?").run(
		envelope({
			messages: [{ role: "user", content: "Working directory: /home/u/wrong" }],
		}),
		"unknown",
	);
	try {
		const plan = await planMissingProjects(db, defaultProjectRules(), 200);
		expect(plan.repairs.map((r) => r.id).sort()).toEqual([
			"concurrent",
			"repair",
			"source-changed",
		]);
		expect(plan.missingBody).toBe(1);
		expect(plan.invalidBody).toBe(1);
		expect(plan.unresolved).toBe(1);
		// Changes made since the preview must not be overwritten.
		db.exec("UPDATE requests SET project = 'manual' WHERE id = 'concurrent'");
		db.exec(
			"UPDATE requests SET project_attribution_source = 'session_ambiguous' WHERE id = 'source-changed'",
		);
		expect(applyProjectRepairs(db, plan.repairs)).toBe(1);
		expect(applyProjectRepairs(db, plan.repairs)).toBe(0);
		expect(
			db
				.query(
					"SELECT project, project_attribution_source FROM requests WHERE id = 'repair'",
				)
				.get(),
		).toEqual({ project: "repo", project_attribution_source: "wd_primary" });
		expect(
			db.query("SELECT project FROM requests WHERE id = 'existing'").get(),
		).toEqual({ project: "keep" });
		expect(
			db.query("SELECT project FROM requests WHERE id = 'future'").get(),
		).toEqual({ project: null });
	} finally {
		db.close();
	}
});
