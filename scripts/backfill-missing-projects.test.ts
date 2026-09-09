import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultProjectRules } from "@clankermux/types";
import {
	applyProjectRepairs,
	planMissingProjects,
} from "./backfill-missing-projects";

test("CLI previews read-only and opens an existing database for audited writes", () => {
	const dir = mkdtempSync(join(tmpdir(), "project-backfill-"));
	const dbPath = join(dir, "test.db");
	const audit = join(dir, "audit.json");
	const db = new Database(dbPath);
	db.exec(`
		CREATE TABLE requests (id TEXT PRIMARY KEY, timestamp INTEGER, method TEXT,
		 path TEXT, project TEXT, project_attribution_source TEXT);
		CREATE TABLE request_payloads (id TEXT PRIMARY KEY, json TEXT);
		INSERT INTO requests VALUES ('repair', 100, 'POST', '/v1/messages', NULL, 'none');
	`);
	const body = { messages: [{ role: "system", content: "Working directory: /home/u/repo" }] };
	db.query("INSERT INTO request_payloads VALUES ('repair', ?)").run(JSON.stringify({ request: { body: Buffer.from(JSON.stringify(body)).toString("base64") } }));
	const run = (...args: string[]) => Bun.spawnSync({
		cmd: [process.execPath, join(import.meta.dir, "backfill-missing-projects.ts"), "--before=2026-09-09T00:00:00Z", ...args],
		env: { ...process.env, CLANKERMUX_DB_PATH: dbPath },
	});
	try {
		const preview = run();
		expect(preview.exitCode).toBe(0);
		expect(db.query("SELECT project FROM requests").get()).toEqual({ project: null });
		const applied = run("--apply", `--audit=${audit}`);
		expect(applied.stderr.toString()).toBe("");
		expect(applied.exitCode).toBe(0);
		expect(db.query("SELECT project FROM requests").get()).toEqual({ project: "repo" });
		expect(JSON.parse(readFileSync(audit, "utf8")).repairs).toHaveLength(1);
		// A reused audit path cannot be overwritten by a subsequent invocation.
		expect(run("--apply", `--audit=${audit}`).exitCode).not.toBe(0);
	} finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

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
