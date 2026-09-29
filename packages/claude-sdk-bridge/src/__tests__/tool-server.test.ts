import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	MCP_TOOL_PREFIX,
	ParkedCalls,
	ToolNames,
	withheldResult,
} from "../tool-server";

const UPSTREAM_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const sha = (name: string) => createHash("sha256").update(name).digest("hex");

describe("ToolNames", () => {
	it("keeps a name that fits once prefixed", () => {
		const names = new ToolNames(["read", "x".repeat(56)]);
		expect(names.exposed).toEqual(["read", "x".repeat(56)]);
		expect(names.upstreamName("read")).toBe("mcp__c__read");
		expect(names.upstreamName("x".repeat(56))).toHaveLength(64);
	});

	it("aliases a 64-character client name and a Chat-encoded name, and maps both back", () => {
		const long = "y".repeat(64);
		const chat = `cmux_chat_${sha("read").slice(0, 48)}`;
		const names = new ToolNames([long, chat, "read"]);
		for (const name of [long, chat]) {
			const upstream = names.upstreamName(name) ?? "";
			expect(upstream).toBe(`${MCP_TOOL_PREFIX}t_${sha(name).slice(0, 16)}`);
			expect(upstream).toMatch(UPSTREAM_NAME);
			expect(names.clientName(upstream)).toBe(name);
		}
		expect(names.clientName("mcp__c__read")).toBe("read");
	});

	it("knows only its own tools", () => {
		const names = new ToolNames(["read"]);
		expect(names.clientName("read")).toBeNull();
		expect(names.clientName("mcp__other__read")).toBeNull();
		expect(names.clientName("mcp__c__write")).toBeNull();
		expect(names.upstreamName("write")).toBeUndefined();
	});

	it("gives a tool the same alias whatever else the list holds", () => {
		const long = "z".repeat(60);
		const alone = new ToolNames([long]).exposedName(long);
		expect(
			new ToolNames(["read", "q".repeat(70), long]).exposedName(long),
		).toBe(alone);
	});

	it("takes more of the hash when an alias is already a client's own name", () => {
		const long = "w".repeat(60);
		const taken = `t_${sha(long).slice(0, 16)}`;
		const names = new ToolNames([taken, long]);
		expect(names.exposedName(taken)).toBe(taken);
		expect(names.exposedName(long)).toBe(`t_${sha(long).slice(0, 17)}`);
		expect(names.clientName(`mcp__c__${taken}`)).toBe(taken);
	});
});

describe("withheldResult", () => {
	it("names why the client never saw the call", () => {
		const text = (r: ReturnType<typeof withheldResult>) =>
			r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(withheldResult({ kind: "cut_off" })).toEqual({
			content: [
				{
					type: "text",
					text: "The tool call's input was cut off before it completed; call the tool again.",
				},
			],
			isError: true,
		});
		expect(text(withheldResult({ kind: "not_object" }))).toContain(
			"not a JSON object",
		);
		expect(
			text(withheldResult({ kind: "stop_reason", stopReason: "max_tokens" })),
		).toContain('stop reason "max_tokens"');
		expect(text(withheldResult({ kind: "sibling" }))).toContain(
			"another tool call in the same message",
		);
	});
});

describe("ParkedCalls", () => {
	it("keeps nothing delivered after it closed", async () => {
		const parked = new ParkedCalls();
		parked.close("done");
		expect(parked.deliver("t1", withheldResult({ kind: "cut_off" }))).toBe(
			"closed",
		);
		expect(await parked.wait("t1")).toEqual({
			content: [{ type: "text", text: "Tool call aborted (done)" }],
			isError: true,
		});
	});
});
