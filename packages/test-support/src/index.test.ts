import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { tempDbTracker } from "./index";

describe("tempDbTracker", () => {
	const trackers: Array<{ cleanup(): void }> = [];

	function makeTracker(prefix: string) {
		const tracker = tempDbTracker(prefix);
		trackers.push(tracker);
		return tracker;
	}

	afterEach(() => {
		for (const tracker of trackers.splice(0)) {
			tracker.cleanup();
		}
	});

	test("next() returns unique paths inside one prefix-named tmpdir subdirectory", () => {
		const tmpDb = makeTracker("test-tracker-unique");

		const first = tmpDb.next();
		const second = tmpDb.next();

		expect(first).not.toBe(second);
		expect(dirname(first)).toBe(dirname(second));

		const dir = dirname(first);
		expect(dirname(dir)).toBe(tmpdir());
		expect(basename(dir).startsWith("test-tracker-unique-")).toBe(true);
		expect(basename(first).startsWith("test-tracker-unique-")).toBe(true);
		expect(first.endsWith(".db")).toBe(true);
		expect(existsSync(dir)).toBe(true);
	});

	test("cleanup() removes the directory including sidecar files", () => {
		const tmpDb = makeTracker("test-tracker-sidecars");

		const dbPath = tmpDb.next();
		writeFileSync(dbPath, "db");
		for (const suffix of ["-wal", "-shm", "-journal"]) {
			writeFileSync(`${dbPath}${suffix}`, suffix);
		}
		const dir = dirname(dbPath);
		expect(existsSync(`${dbPath}-wal`)).toBe(true);

		tmpDb.cleanup();

		expect(existsSync(dir)).toBe(false);
		for (const suffix of ["", "-wal", "-shm", "-journal"]) {
			expect(existsSync(`${dbPath}${suffix}`)).toBe(false);
		}
	});

	test("cleanup() removes nested content created under the directory", () => {
		const tmpDb = makeTracker("test-tracker-nested");

		const dbPath = tmpDb.next();
		const dir = dirname(dbPath);
		mkdirSync(join(dir, "nested"), { recursive: true });
		writeFileSync(join(dir, "nested", "file.db"), "x");

		tmpDb.cleanup();

		expect(existsSync(dir)).toBe(false);
	});

	test("cleanup() without a prior next() call is a no-op", () => {
		const tmpDb = makeTracker("test-tracker-unused");

		expect(() => {
			tmpDb.cleanup();
		}).not.toThrow();
	});

	test("a second consecutive cleanup() is a no-op", () => {
		const tmpDb = makeTracker("test-tracker-twice");

		const dbPath = tmpDb.next();
		writeFileSync(dbPath, "db");

		tmpDb.cleanup();
		expect(() => {
			tmpDb.cleanup();
		}).not.toThrow();
		expect(existsSync(dirname(dbPath))).toBe(false);
	});

	test("next() after cleanup() creates a fresh directory", () => {
		const tmpDb = makeTracker("test-tracker-rearm");

		const first = tmpDb.next();
		const firstDir = dirname(first);
		tmpDb.cleanup();

		const second = tmpDb.next();
		const secondDir = dirname(second);

		expect(secondDir).not.toBe(firstDir);
		expect(existsSync(secondDir)).toBe(true);
		expect(existsSync(firstDir)).toBe(false);
	});

	test("cleanup() tolerates the directory being removed externally", () => {
		const tmpDb = makeTracker("test-tracker-external");

		const dbPath = tmpDb.next();
		rmSync(dirname(dbPath), { recursive: true, force: true });

		expect(() => {
			tmpDb.cleanup();
		}).not.toThrow();
	});
});
