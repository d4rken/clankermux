import { describe, expect, test } from "bun:test";
import {
	type CachePrefixCapture,
	computeCachePrefixHashes,
} from "../cache-prefix-hash";
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

function capture(body: unknown): CachePrefixCapture {
	const result = computeCachePrefixHashes(body);
	if (!result) throw new Error("expected a capture");
	return result;
}

/** The message-chain digest at 0-based message index `i`, or null if the tail
 * window no longer covers it — mirrors the offline analysis join. */
function tailAt(c: CachePrefixCapture, i: number): string | null {
	const offset = i - (c.n - c.tail.length);
	return offset >= 0 && offset < c.tail.length ? c.tail[offset] : null;
}

describe("computeCachePrefixHashes", () => {
	test("emits breakpoint digests in walk order and one tail digest per message", () => {
		const c = capture(claudeCodeBody());
		expect(c.v).toBe(2);
		expect(c.bp).toHaveLength(3);
		expect(c.n).toBe(2);
		expect(c.tail).toHaveLength(2);
		for (const h of [...c.bp, ...c.tail]) {
			expect(h).toMatch(HEX16);
		}
		expect(new Set([...c.bp, ...c.tail]).size).toBe(5);
	});

	test("the Claude Code sliding-breakpoint resume joins position-aligned", () => {
		// The pattern live data showed: the resume request B carries A's
		// messages verbatim, the message breakpoint MOVED from A's last message
		// to B's new last message, and two messages were appended. The v1
		// breakpoint-containment join scored 0/31 on exactly this; the
		// position-aligned message-chain join must score it as intact.
		const a = claudeCodeBody();
		const b = claudeCodeBody();
		const bMessages = b.messages as Record<string, unknown>[];
		delete (
			(bMessages[1].content as Record<string, unknown>[])[0] as {
				cache_control?: unknown;
			}
		).cache_control;
		bMessages.push(
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

		const ca = capture(a);
		const cb = capture(b);
		expect(cb.n).toBe(ca.n + 2);
		// B's digest at A's last message index equals A's final tail digest —
		// the breakpoint slide is invisible to the message chain.
		expect(tailAt(cb, ca.n - 1)).toBe(ca.tail[ca.tail.length - 1]);
		// And every earlier shared index agrees too.
		expect(tailAt(cb, 0)).toBe(tailAt(ca, 0));
	});

	test("an edit to early content diverges both chains from there on", () => {
		const edited = claudeCodeBody();
		(edited.system as { text: string }[])[0].text = "You are Claude Code!";
		const ca = capture(claudeCodeBody());
		const ce = capture(edited);
		// Tools breakpoint precedes the edit — unchanged; later bp digests differ.
		expect(ce.bp[0]).toBe(ca.bp[0]);
		expect(ce.bp[1]).not.toBe(ca.bp[1]);
		expect(ce.bp[2]).not.toBe(ca.bp[2]);
		// Every message digest sits after system — all diverge.
		expect(ce.tail[0]).not.toBe(ca.tail[0]);
		expect(ce.tail[1]).not.toBe(ca.tail[1]);
	});

	test("a compacted history diverges the message chain at the rewrite point", () => {
		const compacted = claudeCodeBody();
		(compacted.messages as Record<string, unknown>[])[0] = {
			role: "user",
			content: "summary of earlier conversation",
		};
		const ca = capture(claudeCodeBody());
		const cc = capture(compacted);
		expect(cc.tail[0]).not.toBe(ca.tail[0]);
		expect(cc.tail[1]).not.toBe(ca.tail[1]);
	});

	test("invariant to cache_control ttl, including a real injectCacheTtl1h pass", () => {
		const plain = capture(claudeCodeBody());

		const withTtl = claudeCodeBody();
		// biome-ignore lint/style/noNonNullAssertion: fixture shape is known
		(withTtl.system as { cache_control?: { ttl?: string } }[])[1]
			.cache_control!.ttl = "1h";
		expect(capture(withTtl)).toEqual(plain);

		const context = new RequestBodyContext(
			new TextEncoder().encode(JSON.stringify(claudeCodeBody()))
				.buffer as ArrayBuffer,
		);
		injectCacheTtl1h(context);
		expect(capture(context.getParsedJson())).toEqual(plain);
	});

	test("does not mutate the shared parsed body", () => {
		const body = claudeCodeBody();
		const before = JSON.stringify(body);
		computeCachePrefixHashes(body);
		expect(JSON.stringify(body)).toBe(before);
	});

	test("moving a breakpoint changes bp but never the message chain", () => {
		const moved = claudeCodeBody();
		const system = moved.system as Record<string, unknown>[];
		system[0].cache_control = system[1].cache_control;
		delete system[1].cache_control;
		const ca = capture(claudeCodeBody());
		const cm = capture(moved);
		expect(cm.bp).not.toEqual(ca.bp);
		expect(cm.n).toBe(ca.n);
		expect(cm.tail).toEqual(ca.tail);
	});

	test("tool_choice and thinking changes perturb message digests only", () => {
		const base = capture(claudeCodeBody());

		const withToolChoice = claudeCodeBody();
		withToolChoice.tool_choice = { type: "auto" };
		const tc = capture(withToolChoice);
		// Tools + system breakpoints precede tool_choice in the walk — unchanged
		// (Anthropic's documented invalidation scope).
		expect(tc.bp[0]).toBe(base.bp[0]);
		expect(tc.bp[1]).toBe(base.bp[1]);
		expect(tc.bp[2]).not.toBe(base.bp[2]);
		expect(tc.tail[0]).not.toBe(base.tail[0]);

		const withThinking = claudeCodeBody();
		withThinking.thinking = { type: "enabled", budget_tokens: 4096 };
		const th = capture(withThinking);
		expect(th.bp[0]).toBe(base.bp[0]);
		expect(th.bp[1]).toBe(base.bp[1]);
		expect(th.tail[0]).not.toBe(base.tail[0]);

		// Absent and explicit null are the same choice.
		const explicitNull = claudeCodeBody();
		explicitNull.tool_choice = null;
		expect(capture(explicitNull)).toEqual(base);
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

	test("caps bp at 8 and keeps a 16-deep sliding tail", () => {
		const body: Record<string, unknown> = {
			model: "m",
			messages: Array.from({ length: 20 }, (_, i) => ({
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
		const c = capture(body);
		expect(c.bp).toHaveLength(8);
		expect(c.n).toBe(20);
		expect(c.tail).toHaveLength(16);
		// The tail keeps the LAST 16 message digests: index 4 is the window's
		// oldest entry, index 3 has fallen out.
		expect(tailAt(c, 4)).toMatch(HEX16);
		expect(tailAt(c, 3)).toBeNull();
		// The bp cap stores the FIRST 8 but later breakpoints keep chaining: a
		// body truncated to its first 8 messages agrees on bp yet differs in n.
		const truncated = {
			...body,
			messages: (body.messages as unknown[]).slice(0, 8),
		};
		const ct = capture(truncated);
		expect(ct.bp).toEqual(c.bp);
		expect(ct.n).toBe(8);
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
		expect(capture(a).bp).not.toEqual(capture(b).bp);
	});
});
