import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("CLI repairs only scoped NULL costs, using recorded providers before account fallback", () => {
	const dir = mkdtempSync(join(tmpdir(), "cost-backfill-"));
	const dbPath = join(dir, "test.db");
	const preload = join(dir, "preload.ts");
	const model = "gpt-5.6-luna";
	const catalogue = {
		bothub: { models: { [model]: { id: model, cost: { input: 90, output: 90 } } } },
		openai: { models: {
			[model]: { id: model, cost: { input: 2, output: 8, cache_read: 0.2 } },
			"other-model": { id: "other-model", cost: { input: 3, output: 9 } },
			"free-input": { id: "free-input", cost: { input: 0, output: 1 } },
		} },
	};
	mkdirSync(join(dir, "clankermux"));
	writeFileSync(join(dir, "clankermux/models.dev.json"), JSON.stringify(catalogue));
	writeFileSync(preload, `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(catalogue))});`);
	const db = new Database(dbPath);
	db.exec(`
		CREATE TABLE accounts (id TEXT PRIMARY KEY, provider TEXT);
		CREATE TABLE requests (id TEXT PRIMARY KEY, timestamp INTEGER, model TEXT,
		 account_used TEXT, cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER,
		 cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
		 estimated_cost_usd REAL, cost_source TEXT);
		CREATE TABLE routing_attempts (id TEXT PRIMARY KEY, request_id TEXT,
		 account_id TEXT, provider TEXT, kind TEXT, started_at INTEGER);
		INSERT INTO accounts VALUES ('changed', 'bothub'), ('legacy', 'codex');
	`);
	const insert = db.query("INSERT INTO requests VALUES (?, 100, ?, ?, ?, 1000000, 0, ?, 0, NULL, 'unknown')");
	insert.run("recorded", model, "changed", null, 1000000);
	insert.run("deleted-account", model, "deleted", null, 1000000);
	insert.run("fallback", model, "legacy", null, 1000000);
	insert.run("reseller", model, "changed", null, 0);
	insert.run("incomplete", model, "changed", null, 1000000);
	insert.run("already-priced", model, "legacy", 123, 1000000);
	db.exec("UPDATE requests SET cost_source = 'reported' WHERE id = 'already-priced'");
	insert.run("other", "other-model", "legacy", null, 0);
	insert.run("free", "free-input", "legacy", null, 0);
	insert.run("unknown-provider", model, "missing", null, 1000000);
	db.exec(`
		INSERT INTO routing_attempts VALUES
		 ('a', 'recorded', 'changed', 'codex', 'upstream_send', 1),
		 ('b', 'recorded', 'changed', 'bothub', 'local_reject', 2),
		 ('c', 'recorded', 'different', 'bothub', 'upstream_send', 3),
		 ('d', 'deleted-account', 'deleted', 'codex', 'upstream_send', 1);
	`);
	const run = (...args: string[]) => Bun.spawnSync({
		cmd: [process.execPath, "--preload", preload, join(import.meta.dir, "backfill-request-costs.ts"), ...args],
		env: { ...process.env, CLANKERMUX_DB_PATH: dbPath, XDG_CACHE_HOME: dir },
	});
	const costs = () => Object.fromEntries(db.query<{ id: string; cost_usd: number | null }, []>("SELECT id, cost_usd FROM requests").all().map((row) => [row.id, row.cost_usd]));
	try {
		const initial = costs();
		const providerPreview = run("--dry-run", `--model=${model}`, "--provider=codex");
		expect(providerPreview.exitCode).toBe(0);
		expect(providerPreview.stdout.toString()).toContain("Rows that would be updated: 3");
		expect(costs()).toEqual(initial);
		const preview = run("--dry-run", `--model=${model}`, "--batch-size=2");
		expect(preview.stderr.toString()).toBe("");
		expect(preview.exitCode).toBe(0);
		expect(preview.stdout.toString()).toContain("Rows that would be updated: 4");
		expect(costs()).toEqual(initial);
		const applied = run(`--model=${model}`, "--batch-size=2");
		expect(applied.stderr.toString()).toBe("");
		expect(applied.exitCode).toBe(0);
		expect(costs()).toEqual({
			recorded: 2.2, "deleted-account": 2.2, fallback: 2.2, reseller: 90,
			incomplete: null, "already-priced": 123, other: null, free: null,
			"unknown-provider": null,
		});
		expect(db.query("SELECT estimated_cost_usd, cost_source FROM requests WHERE id = 'recorded'").get()).toEqual({ estimated_cost_usd: 2.2, cost_source: "estimated" });
		expect(db.query("SELECT estimated_cost_usd, cost_source FROM requests WHERE id = 'already-priced'").get()).toEqual({ estimated_cost_usd: null, cost_source: "reported" });
		const repeated = run(`--model=${model}`);
		expect(repeated.exitCode).toBe(0);
		expect(repeated.stdout.toString()).toContain("Rows updated: 0");
		expect(repeated.stdout.toString()).toContain("Rows without provider provenance: 1");
		expect(repeated.stdout.toString()).toContain("Rows left NULL (missing price): 1");
		const unscoped = run();
		expect(unscoped.exitCode).toBe(0);
		expect(costs().other).toBe(3);
		expect(costs().free).toBe(0);
		for (const arg of ["--model=", "--provider=", "--batch-size=2junk"]) {
			const invalid = run(arg);
			expect(invalid.exitCode).toBe(1);
			expect(invalid.stderr.toString()).toContain("Invalid");
		}
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
