import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSessionStore } from "../session-store";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "sdk-bridge-store-"));
	dirs.push(dir);
	return dir;
}

describe("FileSessionStore", () => {
	it("removes a session's transcript and every subpath transcript, and nothing else", async () => {
		const dir = temp();
		const store = new FileSessionStore(dir);
		const entry = [{ type: "user", uuid: "u" }] as never;
		await store.append({ projectKey: "p", sessionId: A }, entry);
		await store.append(
			{ projectKey: "p", sessionId: A, subpath: "subagents/agent-1" },
			entry,
		);
		await store.append({ projectKey: "p", sessionId: B }, entry);
		store.remove(A);
		expect(readdirSync(dir)).toEqual([`${B}.jsonl`]);
	});

	it("writes private files and refuses to write through a symlink", async () => {
		const dir = temp();
		const store = new FileSessionStore(dir);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		store.write(A, [{ type: "user", uuid: "u" }] as never);
		expect(statSync(join(dir, `${A}.jsonl`)).mode & 0o777).toBe(0o600);
		const outside = join(temp(), "target");
		writeFileSync(outside, "untouched");
		symlinkSync(outside, join(dir, `${B}.jsonl`));
		expect(() => store.write(B, [{ type: "user" }] as never)).toThrow();
		expect(readFileSync(outside, "utf8")).toBe("untouched");
	});

	it("does not fork a session it cannot read, so the turn rebuilds", () => {
		const dir = temp();
		const store = new FileSessionStore(dir);
		writeFileSync(join(dir, `${A}.jsonl`), '{"type":"user"}\n{not json\n');
		expect(store.fork(A, B)).toBe(false);
		expect(store.fork(B, A)).toBe(false);
		expect(readdirSync(dir)).toEqual([`${A}.jsonl`]);
	});
});
