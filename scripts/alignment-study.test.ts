import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SEED } from "../packages/core/src/alignment-study";
import { assertSafeOutPath } from "./db-tool-io";
import { parseArgs } from "./alignment-study";

const temp = mkdtempSync(join(tmpdir(), "alignment-study-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("parseArgs", () => {
	test("defaults to the five-hour claim, the whole range and the fixed seed", () => {
		expect(parseArgs([])).toEqual({
			dbPath: null,
			claim: "5h",
			fromMs: null,
			toMs: null,
			seed: DEFAULT_SEED,
			outPath: null,
		});
	});

	test("reads every flag", () => {
		const options = parseArgs([
			"--db=/tmp/x.db",
			"--claim=7d",
			"--from=2026-08-24T00:00:00Z",
			"--to=2026-09-08T00:00:00Z",
			"--seed=5",
			"--out=/tmp/out.md",
		]);
		expect(options).toEqual({
			dbPath: "/tmp/x.db",
			claim: "7d",
			fromMs: Date.parse("2026-08-24T00:00:00Z"),
			toMs: Date.parse("2026-09-08T00:00:00Z"),
			seed: 5,
			outPath: "/tmp/out.md",
		});
	});

	test("refuses an argument it does not understand rather than ignoring it", () => {
		expect(() => parseArgs(["--widen=3"])).toThrow(/unknown argument/);
	});

	test("refuses an unparseable instant or seed", () => {
		expect(() => parseArgs(["--from=yesterday"])).toThrow(/ISO instant/);
		expect(() => parseArgs(["--to=soon"])).toThrow(/ISO instant/);
		expect(() => parseArgs(["--seed=many"])).toThrow(/number/);
	});
});

describe("output safety", () => {
	test("the report may never be written over the database or a sidecar", () => {
		const dbPath = join(temp, "clankermux.db");
		new Database(dbPath).close();
		expect(() => assertSafeOutPath(dbPath, dbPath)).toThrow();
		expect(() => assertSafeOutPath(`${dbPath}-wal`, dbPath)).toThrow();
		expect(() => assertSafeOutPath(join(temp, "report.md"), dbPath)).not.toThrow();
	});
});
