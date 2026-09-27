import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	forkVerifiedTranscript,
	transcriptHoldsCalls,
} from "../released-parks";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "sdk-bridge-transcript-"));
	dirs.push(dir);
	return dir;
}

/** user u1 → assistant a1 (toolu_1) → assistant a2 (toolu_2), plus a side branch. */
function transcript(): string {
	const e = (o: Record<string, unknown>) =>
		JSON.stringify({ sessionId: A, ...o });
	return `${[
		e({
			type: "user",
			uuid: "u1",
			parentUuid: null,
			message: { content: "héllo" },
		}),
		e({
			type: "assistant",
			uuid: "a1",
			parentUuid: "u1",
			message: { content: [{ type: "tool_use", id: "toolu_1" }] },
		}),
		e({
			type: "assistant",
			uuid: "a2",
			parentUuid: "a1",
			cwd: "/work",
			version: "2.1.280",
			timestamp: "2026-09-27T06:02:11.366Z",
			message: { content: [{ type: "tool_use", id: "toolu_2" }] },
		}),
		e({
			type: "assistant",
			uuid: "x1",
			parentUuid: "u1",
			message: { content: [{ type: "tool_use", id: "toolu_side" }] },
		}),
		JSON.stringify({ type: "last-prompt", leafUuid: "a2" }),
	].join("\n")}\n`;
}

/** A user entry holding one tool_result, as Claude Code writes them. */
function result(
	uuid: string,
	parentUuid: string,
	toolUseId: string,
	sourceToolAssistantUUID?: string,
): string {
	return JSON.stringify({
		type: "user",
		uuid,
		parentUuid,
		sessionId: A,
		...(sourceToolAssistantUUID ? { sourceToolAssistantUUID } : {}),
		message: {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: toolUseId, content: "r" }],
		},
	});
}

/** The tool_use ids a resume's answer entry answers. */
function answered(
	src: string,
	dst: string,
	resumeAt: string,
	awaited: string[],
): string[] | undefined {
	return (
		forkVerifiedTranscript(src, dst, A, B, resumeAt, awaited)?.message as
			| { content: Array<{ tool_use_id: string }> }
			| undefined
	)?.content.map((b) => b.tool_use_id);
}

describe("transcriptHoldsCalls", () => {
	it("walks the chain back from the resume point", () => {
		const dir = temp();
		const path = join(dir, "t.jsonl");
		writeFileSync(path, transcript());
		expect(transcriptHoldsCalls(path, "a2", ["toolu_1", "toolu_2"])).toBe(true);
		expect(transcriptHoldsCalls(path, "a1", ["toolu_1", "toolu_2"])).toBe(
			false,
		);
		// A call on another branch is not on the chain.
		expect(transcriptHoldsCalls(path, "a2", ["toolu_side"])).toBe(false);
		expect(transcriptHoldsCalls(path, "nope", [])).toBe(false);
		expect(transcriptHoldsCalls(join(dir, "missing"), "a2", [])).toBe(false);
	});

	it("refuses a chain whose parent is missing from the file", () => {
		const dir = temp();
		const path = join(dir, "t.jsonl");
		// a1's parent u1 is gone: the chain from a2 breaks before its root.
		writeFileSync(
			path,
			transcript()
				.split("\n")
				.filter((line) => !line.includes('"uuid":"u1"'))
				.join("\n"),
		);
		expect(transcriptHoldsCalls(path, "a2", ["toolu_1", "toolu_2"])).toBe(
			false,
		);
		expect(transcriptHoldsCalls(path, "a2", ["toolu_2"])).toBe(false);
		const dst = join(dir, "dst.jsonl");
		expect(
			forkVerifiedTranscript(path, dst, A, B, "a2", ["toolu_2"]),
		).toBeNull();
		expect(existsSync(dst)).toBe(false);
	});
});

describe("forkVerifiedTranscript", () => {
	it("copies a transcript that holds the calls, rewriting only the session id", () => {
		const dir = temp();
		const src = join(dir, "src.jsonl");
		const dst = join(dir, "dst.jsonl");
		writeFileSync(src, transcript());
		expect(
			forkVerifiedTranscript(src, dst, A, B, "a2", ["toolu_1", "toolu_2"]),
		).not.toBeNull();
		expect(readFileSync(dst, "utf8")).toBe(
			transcript().replaceAll(`"sessionId":"${A}"`, `"sessionId":"${B}"`),
		);
		expect(statSync(dst).mode & 0o777).toBe(0o600);
		// The source is left as it was.
		expect(readFileSync(src, "utf8")).toBe(transcript());
	});

	it("answers every awaited call in an entry after the resume point, for the resumed load", () => {
		const dir = temp();
		const src = join(dir, "src.jsonl");
		const dst = join(dir, "dst.jsonl");
		writeFileSync(src, transcript());
		const answer = forkVerifiedTranscript(src, dst, A, B, "a2", [
			"toolu_1",
			"toolu_2",
		]);
		expect(answer).toEqual({
			type: "user",
			uuid: expect.stringMatching(/^[0-9a-f-]{36}$/),
			parentUuid: "a2",
			sourceToolAssistantUUID: "a2",
			isSidechain: false,
			sessionId: B,
			timestamp: expect.any(String),
			cwd: "/work",
			version: "2.1.280",
			message: {
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "toolu_1", content: "" },
					{ type: "tool_result", tool_use_id: "toolu_2", content: "" },
				],
			},
		});
		// Stamped when it is made, not copied from the resume point.
		const stamped = Date.parse(String(answer?.timestamp));
		expect(Math.abs(Date.now() - stamped)).toBeLessThan(60_000);
		// It is never part of the copy.
		expect(readFileSync(dst, "utf8")).not.toContain(String(answer?.uuid));
	});

	it("also answers calls on the chain that nothing answered, awaited or not", () => {
		const dir = temp();
		const src = join(dir, "src.jsonl");
		writeFileSync(src, transcript());
		// Only toolu_2 was handed to the client; toolu_1 has no result anywhere.
		const both = forkVerifiedTranscript(src, join(dir, "d1"), A, B, "a2", [
			"toolu_2",
		]);
		expect(
			(
				both?.message as { content: Array<{ tool_use_id: string }> }
			).content.map((b) => b.tool_use_id),
		).toEqual(["toolu_1", "toolu_2"]);
		// A result Claude Code wrote for toolu_1 off the chain (a child of its
		// call, as parallel results are) counts as an answer.
		writeFileSync(
			src,
			`${transcript()}${JSON.stringify({
				type: "user",
				uuid: "r1",
				parentUuid: "a1",
				sessionId: A,
				message: {
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "toolu_1", content: "no" },
					],
				},
			})}\n`,
		);
		const one = forkVerifiedTranscript(src, join(dir, "d2"), A, B, "a2", [
			"toolu_2",
		]);
		expect(
			(one?.message as { content: Array<{ tool_use_id: string }> }).content.map(
				(b) => b.tool_use_id,
			),
		).toEqual(["toolu_2"]);
	});

	it("answers an awaited call whatever results for its id lie elsewhere", () => {
		const dir = temp();
		const src = join(dir, "src.jsonl");
		// A result for toolu_2 on the side branch, beneath x1.
		writeFileSync(src, `${transcript()}${result("s1", "x1", "toolu_2")}\n`);
		expect(answered(src, join(dir, "d"), "a2", ["toolu_2"])).toEqual([
			"toolu_1",
			"toolu_2",
		]);
	});

	it("takes an off-chain result for an unforwarded call only from that call's own entry", () => {
		const dir = temp();
		const src = join(dir, "src.jsonl");
		// For toolu_1 (in a1), a result on the side branch is someone else's.
		writeFileSync(src, `${transcript()}${result("s1", "x1", "toolu_1")}\n`);
		expect(answered(src, join(dir, "d1"), "a2", ["toolu_2"])).toEqual([
			"toolu_1",
			"toolu_2",
		]);
		// Beneath a1 at any depth, it is a1's.
		writeFileSync(
			src,
			`${transcript()}${[
				JSON.stringify({
					type: "attachment",
					uuid: "t1",
					parentUuid: "a1",
					sessionId: A,
				}),
				result("r1", "t1", "toolu_1"),
			].join("\n")}\n`,
		);
		expect(answered(src, join(dir, "d2"), "a2", ["toolu_2"])).toEqual([
			"toolu_2",
		]);
		// Elsewhere, but naming a1 as its source, it is a1's too.
		writeFileSync(
			src,
			`${transcript()}${result("r1", "x1", "toolu_1", "a1")}\n`,
		);
		expect(answered(src, join(dir, "d3"), "a2", ["toolu_2"])).toEqual([
			"toolu_2",
		]);
	});

	it("writes nothing when the chain does not hold the calls or the file is gone", () => {
		const dir = temp();
		const src = join(dir, "src.jsonl");
		const dst = join(dir, "dst.jsonl");
		writeFileSync(src, transcript());
		expect(
			forkVerifiedTranscript(src, dst, A, B, "a1", ["toolu_2"]),
		).toBeNull();
		expect(existsSync(dst)).toBe(false);
		expect(
			forkVerifiedTranscript(join(dir, "gone"), dst, A, B, "a2", ["toolu_2"]),
		).toBeNull();
		expect(existsSync(dst)).toBe(false);
	});

	it("verifies and forks a 64 MiB transcript in one synchronous pass", () => {
		const dir = temp();
		const src = join(dir, "src.jsonl");
		const pad = "x".repeat(4_000);
		const lines: string[] = [];
		let parent: string | null = null;
		for (let i = 0; i < 16_000; i++) {
			const uuid = `e${i}`;
			lines.push(
				JSON.stringify({
					type: "assistant",
					uuid,
					parentUuid: parent,
					sessionId: A,
					message: {
						content: [
							{ type: "text", text: pad },
							...(i === 15_999 ? [{ type: "tool_use", id: "toolu_last" }] : []),
						],
					},
				}),
			);
			parent = uuid;
		}
		writeFileSync(src, `${lines.join("\n")}\n`);
		const t0 = performance.now();
		expect(
			forkVerifiedTranscript(src, join(dir, "dst.jsonl"), A, B, "e15999", [
				"toolu_last",
			]),
		).not.toBeNull();
		expect(performance.now() - t0).toBeLessThan(3_000);
		expect(readFileSync(join(dir, "dst.jsonl"), "latin1").includes(A)).toBe(
			false,
		);
	});
});
