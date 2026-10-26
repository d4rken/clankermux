import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnEmbeddedWorker } from "../worker-spawn";

const DOUBLER = "self.onmessage = (e) => postMessage(e.data * 2);";

function roundTrip(worker: Worker, value: number): Promise<number> {
	return new Promise((resolve, reject) => {
		worker.onmessage = (event: MessageEvent) => resolve(event.data);
		worker.onerror = (event: ErrorEvent) => reject(new Error(event.message));
		worker.postMessage(value);
	});
}

describe("spawnEmbeddedWorker", () => {
	let created: string[];
	let revoked: string[];
	let createSpy: ReturnType<typeof spyOn>;
	let revokeSpy: ReturnType<typeof spyOn>;
	let tmpDir: string;

	beforeEach(() => {
		created = [];
		revoked = [];
		const realCreate = URL.createObjectURL.bind(URL);
		const realRevoke = URL.revokeObjectURL.bind(URL);
		createSpy = spyOn(URL, "createObjectURL").mockImplementation(
			(blob: Blob) => {
				const url = realCreate(blob);
				created.push(url);
				return url;
			},
		);
		revokeSpy = spyOn(URL, "revokeObjectURL").mockImplementation(
			(url: string) => {
				revoked.push(url);
				realRevoke(url);
			},
		);
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clankermux-embedded-"));
	});

	afterEach(() => {
		createSpy.mockRestore();
		revokeSpy.mockRestore();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("runs the embedded bundle and revokes its blob URL on dispose", async () => {
		const spawned = spawnEmbeddedWorker(
			Buffer.from(DOUBLER, "utf8").toString("base64"),
			"file:///never-loaded.ts",
		);
		try {
			expect(await roundTrip(spawned.worker, 21)).toBe(42);
			expect(created).toHaveLength(1);
			expect(revoked).toEqual([]);
		} finally {
			spawned.dispose();
		}
		expect(revoked).toEqual(created);
	});

	it("dispose is idempotent", () => {
		const spawned = spawnEmbeddedWorker(
			Buffer.from(DOUBLER, "utf8").toString("base64"),
			"file:///never-loaded.ts",
		);
		spawned.dispose();
		spawned.dispose();
		expect(revoked).toEqual(created);
		expect(created).toHaveLength(1);
	});

	it("loads the on-disk source when the embedded bundle is a placeholder", async () => {
		const source = path.join(tmpDir, "doubler.js");
		fs.writeFileSync(source, DOUBLER);
		const spawned = spawnEmbeddedWorker("", pathToFileURL(source).href);
		try {
			expect(await roundTrip(spawned.worker, 4)).toBe(8);
		} finally {
			spawned.dispose();
		}
		expect(created).toEqual([]);
		expect(revoked).toEqual([]);
	});
});
