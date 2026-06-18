import { describe, expect, it } from "bun:test";
import { injectCacheTtl1h } from "../cache-ttl-injector";
import { RequestBodyContext } from "../request-body-context";

const enc = new TextEncoder();
const dec = new TextDecoder();

function ctx(body: unknown): RequestBodyContext {
	const buf = enc.encode(JSON.stringify(body));
	return new RequestBodyContext(
		buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
	);
}

function parseBuffer(c: RequestBodyContext): unknown {
	const buf = c.getBuffer();
	if (!buf) return null;
	return JSON.parse(dec.decode(buf));
}

describe("injectCacheTtl1h", () => {
	it("injects ttl:1h on a bare ephemeral system block", () => {
		const c = ctx({
			model: "claude-opus-4-8",
			system: [
				{ type: "text", text: "hi", cache_control: { type: "ephemeral" } },
			],
			messages: [],
		});
		injectCacheTtl1h(c);
		const body = parseBuffer(c) as {
			system: Array<{ cache_control: { ttl: string } }>;
		};
		expect(body.system[0].cache_control.ttl).toBe("1h");
		expect(c.isDirty).toBe(false); // getBuffer re-serialized & cleared dirty
	});

	it("injects ttl:1h on ephemeral message-content blocks", () => {
		const c = ctx({
			model: "claude-opus-4-8",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "a" },
						{
							type: "text",
							text: "b",
							cache_control: { type: "ephemeral" },
						},
					],
				},
			],
		});
		injectCacheTtl1h(c);
		const body = parseBuffer(c) as {
			messages: Array<{
				content: Array<{ cache_control?: { ttl?: string } }>;
			}>;
		};
		expect(body.messages[0].content[0].cache_control).toBeUndefined();
		expect(body.messages[0].content[1].cache_control?.ttl).toBe("1h");
	});

	it("upgrades both system and message blocks uniformly", () => {
		const c = ctx({
			system: [
				{ type: "text", text: "s", cache_control: { type: "ephemeral" } },
			],
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "m",
							cache_control: { type: "ephemeral" },
						},
					],
				},
			],
		});
		injectCacheTtl1h(c);
		const body = parseBuffer(c) as {
			system: Array<{ cache_control: { ttl: string } }>;
			messages: Array<{ content: Array<{ cache_control: { ttl: string } }> }>;
		};
		expect(body.system[0].cache_control.ttl).toBe("1h");
		expect(body.messages[0].content[0].cache_control.ttl).toBe("1h");
	});

	it("leaves already-1h blocks unchanged and does not mark dirty (idempotent)", () => {
		const c = ctx({
			system: [
				{
					type: "text",
					text: "s",
					cache_control: { type: "ephemeral", ttl: "1h" },
				},
			],
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "m",
							cache_control: { type: "ephemeral", ttl: "1h" },
						},
					],
				},
			],
		});
		injectCacheTtl1h(c);
		expect(c.isDirty).toBe(false);
		const body = parseBuffer(c) as {
			system: Array<{ cache_control: { ttl: string } }>;
		};
		expect(body.system[0].cache_control.ttl).toBe("1h");
	});

	it("is a no-op (not dirty) when there is no cache_control", () => {
		const c = ctx({
			system: [{ type: "text", text: "s" }],
			messages: [{ role: "user", content: [{ type: "text", text: "m" }] }],
		});
		injectCacheTtl1h(c);
		expect(c.isDirty).toBe(false);
	});

	it("ignores non-array system / content safely", () => {
		const c = ctx({
			system: "plain string system",
			messages: [{ role: "user", content: "plain string content" }],
		});
		expect(() => injectCacheTtl1h(c)).not.toThrow();
		expect(c.isDirty).toBe(false);
	});

	it("upgrades a 5m-ttl block to 1h", () => {
		const c = ctx({
			system: [
				{
					type: "text",
					text: "s",
					cache_control: { type: "ephemeral", ttl: "5m" },
				},
			],
			messages: [],
		});
		injectCacheTtl1h(c);
		const body = parseBuffer(c) as {
			system: Array<{ cache_control: { ttl: string } }>;
		};
		expect(body.system[0].cache_control.ttl).toBe("1h");
	});

	it("handles an unparseable / null body without throwing", () => {
		const empty = new RequestBodyContext(null);
		expect(() => injectCacheTtl1h(empty)).not.toThrow();
		expect(empty.isDirty).toBe(false);
	});

	it("ignores message content entries that are not objects", () => {
		const c = ctx({
			messages: [
				{
					role: "user",
					content: [
						null,
						"str",
						{ type: "text", cache_control: { type: "ephemeral" } },
					],
				},
			],
		});
		injectCacheTtl1h(c);
		const body = parseBuffer(c) as {
			messages: Array<{ content: Array<unknown> }>;
		};
		const block = body.messages[0].content[2] as {
			cache_control: { ttl: string };
		};
		expect(block.cache_control.ttl).toBe("1h");
	});
});
