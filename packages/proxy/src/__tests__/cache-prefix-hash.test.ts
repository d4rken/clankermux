import { describe, expect, test } from "bun:test";
import { computeCachePrefixHashes } from "../cache-prefix-hash";
import { injectCacheTtl1h } from "../cache-ttl-injector";
import { RequestBodyContext } from "../request-body-context";

const HEX16 = /^[0-9a-f]{16}$/;

/** A representative Claude Code-shaped body: breakpoint on the last tool, on
 * the last system block, and on the last message content block. */
function claudeCodeBody(): Record<string, unknown> {
	return {
		model: "claude-opus-5",
		tools: [
			{ name: "Read", input_schema: { type: "object" } },
			{
				name: "Bash",
				input_schema: { type: "object" },
				cache_control: { type: "ephemeral" },
			},
		],
		system: [
			{ type: "text", text: "You are Claude Code." },
			{
				type: "text",
				text: "Project instructions.",
				cache_control: { type: "ephemeral" },
			},
		],
		messages: [
			{ role: "user", content: "hello" },
			{
				role: "assistant",
				content: [
					{
						type: "text",
						text: "hi",
						cache_control: { type: "ephemeral" },
					},
				],
			},
		],
	};
}

describe("computeCachePrefixHashes", () => {
	test("emits one 16-hex hash per breakpoint, in walk order", () => {
		const hashes = computeCachePrefixHashes(claudeCodeBody());
		expect(hashes).not.toBeNull();
		expect(hashes).toHaveLength(3);
		for (const h of hashes ?? []) {
			expect(h).toMatch(HEX16);
		}
		// Distinct positions produce distinct digests.
		expect(new Set(hashes).size).toBe(3);
	});

	test("append-only continuation keeps the earlier array as a prefix", () => {
		const a = claudeCodeBody();
		const b = claudeCodeBody();
		(b.messages as unknown[]).push(
			{ role: "user", content: "next turn" },
			{
				role: "assistant",
				content: [
					{
						type: "text",
						text: "reply",
						cache_control: { type: "ephemeral" },
					},
				],
			},
		);
		const hashesA = computeCachePrefixHashes(a) ?? [];
		const hashesB = computeCachePrefixHashes(b) ?? [];
		expect(hashesB).toHaveLength(hashesA.length + 1);
		expect(hashesB.slice(0, hashesA.length)).toEqual(hashesA);
	});

	test("an edit before a breakpoint changes that hash and all later ones", () => {
		const a = claudeCodeBody();
		const edited = claudeCodeBody();
		(edited.system as { text: string }[])[0].text = "You are Claude Code!";
		const hashesA = computeCachePrefixHashes(a) ?? [];
		const hashesE = computeCachePrefixHashes(edited) ?? [];
		// Tools breakpoint precedes the edit — unchanged.
		expect(hashesE[0]).toBe(hashesA[0]);
		// System breakpoint and everything after diverge.
		expect(hashesE[1]).not.toBe(hashesA[1]);
		expect(hashesE[2]).not.toBe(hashesA[2]);
	});

	test("invariant to cache_control ttl, including a real injectCacheTtl1h pass", () => {
		const plain = computeCachePrefixHashes(claudeCodeBody());

		const withTtl = claudeCodeBody();
		// biome-ignore lint/style/noNonNullAssertion: fixture shape is known
		(withTtl.system as { cache_control?: { ttl?: string } }[])[1]
			.cache_control!.ttl = "1h";
		expect(computeCachePrefixHashes(withTtl)).toEqual(plain);

		const context = new RequestBodyContext(
			new TextEncoder().encode(JSON.stringify(claudeCodeBody()))
				.buffer as ArrayBuffer,
		);
		injectCacheTtl1h(context);
		expect(computeCachePrefixHashes(context.getParsedJson())).toEqual(plain);
	});

	test("does not mutate the shared parsed body", () => {
		const body = claudeCodeBody();
		const before = JSON.stringify(body);
		computeCachePrefixHashes(body);
		expect(JSON.stringify(body)).toBe(before);
	});

	test("moving a breakpoint to a different block changes the array", () => {
		const moved = claudeCodeBody();
		const system = moved.system as Record<string, unknown>[];
		system[0].cache_control = system[1].cache_control;
		delete system[1].cache_control;
		expect(computeCachePrefixHashes(moved)).not.toEqual(
			computeCachePrefixHashes(claudeCodeBody()),
		);
	});

	test("returns null when the body carries no ephemeral breakpoint", () => {
		expect(
			computeCachePrefixHashes({
				model: "claude-opus-5",
				messages: [{ role: "user", content: "hello" }],
			}),
		).toBeNull();
		// Non-ephemeral cache_control is not a breakpoint.
		expect(
			computeCachePrefixHashes({
				model: "m",
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "x", cache_control: { type: "other" } },
						],
					},
				],
			}),
		).toBeNull();
	});

	test("returns null on malformed shapes, never throws", () => {
		expect(computeCachePrefixHashes(null)).toBeNull();
		expect(computeCachePrefixHashes("a string")).toBeNull();
		expect(computeCachePrefixHashes(42)).toBeNull();
		expect(computeCachePrefixHashes({ messages: "not-an-array" })).toBeNull();
		// A body that throws on property access must be swallowed.
		const trap = new Proxy(
			{},
			{
				get() {
					throw new Error("boom");
				},
			},
		);
		expect(computeCachePrefixHashes(trap)).toBeNull();
	});

	test("caps at 8 breakpoints", () => {
		const body: Record<string, unknown> = {
			model: "m",
			messages: Array.from({ length: 12 }, (_, i) => ({
				role: "user",
				content: [
					{
						type: "text",
						text: `turn ${i}`,
						cache_control: { type: "ephemeral" },
					},
				],
			})),
		};
		const hashes = computeCachePrefixHashes(body);
		expect(hashes).toHaveLength(8);
		// The cap keeps the FIRST 8: a body truncated to its first 8 breakpoints
		// hashes identically.
		const truncated = {
			...body,
			messages: (body.messages as unknown[]).slice(0, 8),
		};
		expect(computeCachePrefixHashes(truncated)).toEqual(hashes);
	});

	test("tool_choice and thinking changes invalidate message breakpoints only", () => {
		const base = computeCachePrefixHashes(claudeCodeBody()) ?? [];

		const withToolChoice = claudeCodeBody();
		withToolChoice.tool_choice = { type: "auto" };
		const tc = computeCachePrefixHashes(withToolChoice) ?? [];
		// Tools + system breakpoints precede tool_choice in the hash walk —
		// unchanged (Anthropic's documented invalidation scope).
		expect(tc[0]).toBe(base[0]);
		expect(tc[1]).toBe(base[1]);
		// The message breakpoint diverges.
		expect(tc[2]).not.toBe(base[2]);

		const withThinking = claudeCodeBody();
		withThinking.thinking = { type: "enabled", budget_tokens: 4096 };
		const th = computeCachePrefixHashes(withThinking) ?? [];
		expect(th[0]).toBe(base[0]);
		expect(th[1]).toBe(base[1]);
		expect(th[2]).not.toBe(base[2]);

		// Absent and explicit null are the same choice.
		const explicitNull = claudeCodeBody();
		explicitNull.tool_choice = null;
		expect(computeCachePrefixHashes(explicitNull)).toEqual(base);
	});

	test("length-prefixing distinguishes identical bytes split differently", () => {
		const bp = { type: "ephemeral" };
		const a = {
			model: "m",
			system: [
				{ type: "text", text: "ab" },
				{ type: "text", text: "c", cache_control: bp },
			],
			messages: [],
		};
		const b = {
			model: "m",
			system: [
				{ type: "text", text: "a" },
				{ type: "text", text: "bc", cache_control: bp },
			],
			messages: [],
		};
		expect(computeCachePrefixHashes(a)).not.toEqual(
			computeCachePrefixHashes(b),
		);
	});
});
