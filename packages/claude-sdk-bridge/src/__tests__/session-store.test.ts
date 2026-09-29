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

	it("hands entries to every load of the session until it is removed, never to the file", async () => {
		const dir = temp();
		const store = new FileSessionStore(dir);
		const key = { projectKey: "p", sessionId: A };
		await store.append(key, [{ type: "user", uuid: "u" }] as never);
		store.appendOnLoad(A, [{ type: "user", uuid: "x" }] as never);
		expect(
			await store.load({ ...key, subpath: "subagents/agent-1" }),
		).toBeNull();
		const withExtra = [
			{ type: "user", uuid: "u" },
			{ type: "user", uuid: "x" },
		];
		expect(await store.load(key)).toEqual(withExtra as never);
		expect(await store.load(key)).toEqual(withExtra as never);
		expect(readFileSync(join(dir, `${A}.jsonl`), "utf8")).not.toContain('"x"');
		// Removing the session clears them, and so does the SDK's delete().
		store.remove(A);
		await store.append(key, [{ type: "user", uuid: "u2" }] as never);
		expect(await store.load(key)).toEqual([
			{ type: "user", uuid: "u2" },
		] as never);
		store.appendOnLoad(B, [{ type: "user", uuid: "y" }] as never);
		await store.delete({ projectKey: "p", sessionId: B });
		await store.append({ projectKey: "p", sessionId: B }, [
			{ type: "user", uuid: "b" },
		] as never);
		expect(await store.load({ projectKey: "p", sessionId: B })).toEqual([
			{ type: "user", uuid: "b" },
		] as never);
	});

	it("does not fork a session that is missing, so the turn rebuilds", () => {
		const dir = temp();
		const store = new FileSessionStore(dir);
		expect(store.fork(A, B)).toBe(false);
		expect(readdirSync(dir)).toEqual([]);
	});

	it("forks byte for byte, rewriting only the session id", () => {
		const dir = temp();
		const store = new FileSessionStore(dir);
		// Key order, spacing, non-ASCII text and an escaped copy of the id in
		// content are all kept as they are.
		const lines = [
			`{"parentUuid":null,"sessionId":"${A}","message":{"content":"héllo → ✓"}}`,
			`{"type":"summary","leafUuid":"x","escaped":"caf\\u00e9"}`,
			`{"sessionId":"${A}","text":"quoted \\"sessionId\\":\\"${A}\\" stays"}`,
		];
		writeFileSync(join(dir, `${A}.jsonl`), `${lines.join("\n")}\n`);
		expect(store.fork(A, B)).toBe(true);
		expect(readFileSync(join(dir, `${B}.jsonl`), "utf8")).toBe(
			`${lines.map((l) => l.replace(`"sessionId":"${A}"`, `"sessionId":"${B}"`)).join("\n")}\n`,
		);
		expect(statSync(join(dir, `${B}.jsonl`)).mode & 0o777).toBe(0o600);
	});

	it("forks a large transcript quickly and synchronously", () => {
		const dir = temp();
		const store = new FileSessionStore(dir);
		const line = `{"sessionId":"${A}","message":{"content":"${"x".repeat(4_000)}"}}\n`;
		// About 64 MiB, the largest history a turn may send.
		writeFileSync(join(dir, `${A}.jsonl`), line.repeat(16_000));
		const t0 = performance.now();
		expect(store.fork(A, B)).toBe(true);
		const ms = performance.now() - t0;
		const copy = readFileSync(join(dir, `${B}.jsonl`), "latin1");
		expect(copy.length).toBe(line.length * 16_000);
		expect(copy.includes(A)).toBe(false);
		expect(ms).toBeLessThan(1_500);
	});

	describe("forkExtended", () => {
		/**
		 * A transcript as Claude Code writes it: metadata lines without a
		 * uuid, attachments on the chain, and a parallel call's first result
		 * as a child of its own call, off the chain.
		 */
		const transcript = (id: string) =>
			[
				{ type: "queue-operation", operation: "enqueue", sessionId: id },
				{ type: "user", uuid: "u1", parentUuid: null, sessionId: id },
				{ type: "atis-latch", sessionId: id },
				{
					type: "attachment",
					uuid: "at1",
					parentUuid: "u1",
					attachment: { type: "date" },
					sessionId: id,
				},
				{
					type: "assistant",
					uuid: "a1",
					parentUuid: "at1",
					sessionId: id,
					message: { content: [{ type: "tool_use", id: "t1" }] },
				},
				{
					type: "assistant",
					uuid: "a2",
					parentUuid: "a1",
					sessionId: id,
					message: { content: [{ type: "tool_use", id: "t2" }] },
				},
				{
					type: "user",
					uuid: "r1",
					parentUuid: "a1",
					sourceToolAssistantUUID: "a1",
					sessionId: id,
				},
				{
					type: "user",
					uuid: "r2",
					parentUuid: "a2",
					sourceToolAssistantUUID: "a2",
					sessionId: id,
				},
				{
					type: "attachment",
					uuid: "at2",
					parentUuid: "r2",
					attachment: { type: "model" },
					sessionId: id,
				},
				{
					type: "user",
					uuid: "side",
					parentUuid: null,
					isSidechain: true,
					sessionId: id,
				},
				{
					type: "assistant",
					uuid: "a3",
					parentUuid: "at2",
					sessionId: id,
					message: { content: [{ type: "text", text: "done" }] },
				},
				{ type: "last-prompt", sessionId: id },
				{ type: "cost-state", sessionId: id },
			].map((e) => JSON.stringify(e));

		const write = (dir: string, lines: string[]) =>
			writeFileSync(join(dir, `${A}.jsonl`), `${lines.join("\n")}\n`);

		const appended = (leaf: string) =>
			[
				{ type: "user", uuid: "x1", parentUuid: leaf, sessionId: B },
				{ type: "assistant", uuid: "x2", parentUuid: "x1", sessionId: B },
			] as never;

		it("copies the transcript under the new id and appends after its leaf", () => {
			const dir = temp();
			const store = new FileSessionStore(dir);
			const lines = transcript(A);
			write(dir, lines);
			const leaves: string[] = [];
			expect(
				store.forkExtended(A, B, (leaf) => {
					leaves.push(leaf);
					return appended(leaf);
				}),
			).toBe(true);
			expect(leaves).toEqual(["a3"]);
			expect(readFileSync(join(dir, `${B}.jsonl`), "utf8")).toBe(
				[
					...transcript(B),
					JSON.stringify({
						type: "user",
						uuid: "x1",
						parentUuid: "a3",
						sessionId: B,
					}),
					JSON.stringify({
						type: "assistant",
						uuid: "x2",
						parentUuid: "x1",
						sessionId: B,
					}),
				]
					.map((l) => `${l}\n`)
					.join(""),
			);
			expect(statSync(join(dir, `${B}.jsonl`)).mode & 0o777).toBe(0o600);
			// The stored session is left as it was.
			expect(readFileSync(join(dir, `${A}.jsonl`), "utf8")).toBe(
				`${lines.join("\n")}\n`,
			);
		});

		const refused: Array<[string, (lines: string[]) => string[]]> = [
			[
				"a parent missing from the file",
				(l) => l.filter((x) => !x.includes('"uuid":"at1"')),
			],
			[
				"a cycle",
				(l) =>
					l.map((x) =>
						x.includes('"uuid":"u1"')
							? x.replace('"parentUuid":null', '"parentUuid":"a3"')
							: x,
					),
			],
			[
				"a malformed line",
				(l) => [...l.slice(0, 3), "{not json", ...l.slice(3)],
			],
			[
				"a leaf that is not an assistant message",
				(l) => [
					...l,
					JSON.stringify({ type: "user", uuid: "u9", parentUuid: "a3" }),
				],
			],
			[
				"a leaf that makes a tool call",
				(l) => [
					...l,
					JSON.stringify({
						type: "assistant",
						uuid: "a9",
						parentUuid: "a3",
						message: { content: [{ type: "tool_use", id: "t9" }] },
					}),
				],
			],
			[
				"a leaf with a child",
				(l) => [
					JSON.stringify({ type: "user", uuid: "late", parentUuid: "a3" }),
					...l,
				],
			],
			[
				"a uuid written twice",
				(l) => [
					...l.slice(0, -2),
					JSON.stringify({
						type: "assistant",
						uuid: "a3",
						parentUuid: "a2",
						message: { content: [{ type: "text", text: "again" }] },
					}),
				],
			],
			["no entry with a uuid", () => [JSON.stringify({ type: "last-prompt" })]],
		];
		for (const [what, change] of refused)
			it(`refuses ${what}, writing nothing`, () => {
				const dir = temp();
				const store = new FileSessionStore(dir);
				write(dir, change(transcript(A)));
				let called = false;
				expect(
					store.forkExtended(A, B, (leaf) => {
						called = true;
						return appended(leaf);
					}),
				).toBe(false);
				expect(called).toBe(false);
				expect(readdirSync(dir)).toEqual([`${A}.jsonl`]);
			});

		it("refuses a session that is missing", () => {
			const dir = temp();
			const store = new FileSessionStore(dir);
			expect(store.forkExtended(A, B, appended)).toBe(false);
			expect(readdirSync(dir)).toEqual([]);
		});

		it("writes nothing when the entries cannot be built", () => {
			const dir = temp();
			const store = new FileSessionStore(dir);
			write(dir, transcript(A));
			expect(() =>
				store.forkExtended(A, B, () => {
					throw new Error("too deep");
				}),
			).toThrow("too deep");
			expect(readdirSync(dir)).toEqual([`${A}.jsonl`]);
		});

		it("extends a large transcript quickly and synchronously", () => {
			const dir = temp();
			const store = new FileSessionStore(dir);
			const text = "x".repeat(4_000);
			const lines: string[] = [];
			for (let i = 0; i < 16_000; i++)
				lines.push(
					JSON.stringify({
						type: i % 2 ? "assistant" : "user",
						uuid: `e${i}`,
						parentUuid: i ? `e${i - 1}` : null,
						sessionId: A,
						message: { content: [{ type: "text", text }] },
					}),
				);
			write(dir, lines);
			const t0 = performance.now();
			expect(store.forkExtended(A, B, appended)).toBe(true);
			const ms = performance.now() - t0;
			const copy = readFileSync(join(dir, `${B}.jsonl`), "latin1");
			expect(copy.includes(A)).toBe(false);
			expect(copy.endsWith(`"parentUuid":"x1","sessionId":"${B}"}\n`)).toBe(
				true,
			);
			expect(copy).toContain(
				`{"type":"user","uuid":"x1","parentUuid":"e15999"`,
			);
			expect(ms).toBeLessThan(3_000);
		});
	});
});
