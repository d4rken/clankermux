import { describe, expect, it } from "bun:test";
import { NativeTerminalJson } from "../native-terminal-json";

function parse(text: string, size = 1) {
	const parser = new NativeTerminalJson();
	for (let i = 0; i < text.length; i += size)
		parser.feed(text.slice(i, i + size));
	return { value: parser.finish(), error: parser.error };
}

describe("native terminal JSON projection", () => {
	it("validates skipped JSON and retains only accounting fields regardless of key order", () => {
		const text = JSON.stringify({
			response: {
				usage: {
					attribution: [
						null,
						false,
						true,
						-2.5e-12,
						0,
						{},
						[],
						{ '"\\😀': "\\u1234\n\t\b\f\r" },
					],
					output_tokens: 7,
					input_tokens: 10,
					input_tokens_details: { cached_tokens: 3 },
					cost: 0.01,
					is_byok: true,
				},
			},
			type: "response.completed",
		});
		for (const size of [1, 2, 7, text.length]) {
			expect(parse(text, size)).toEqual({
				error: null,
				value: {
					type: "response.completed",
					response: {
						usage: {
							output_tokens: 7,
							input_tokens: 10,
							input_tokens_details: { cached_tokens: 3 },
							cost: 0.01,
							is_byok: true,
						},
					},
				},
			});
		}
	});
	it("honors escaped keys and duplicate keys like JSON.parse", () => {
		expect(
			parse(
				'{"ty\\u0070e":"response.failed","type":"response.completed","response":{"usage":{"output_tokens":2}},"response":{"usage":{"output_tokens":7}}}',
			).value,
		).toEqual({
			type: "response.completed",
			response: { usage: { output_tokens: 7 } },
		});
	});
	for (const bad of [
		'{"x":01}',
		'{"x":-}',
		'{"x":1.}',
		'{"x":1e}',
		'{"x":1e+}',
		'{"x":tru}',
		'{"x":truee}',
		'{"x":nul}',
		'{"x":"\\x"}',
		'{"x":"\\u00xz"}',
		'{"x":"\n"}',
		'{"x":[1,]}',
		'{"x":1,}',
		'{"x" 1}',
		'{"x":1 "y":2}',
		'{"x":[]]',
		"{}{}",
		'{"x":NaN}',
		'{"x":+1}',
		'{"x":.1}',
		'{"x":1e+-2}',
		'{"x":{"z":2}',
	]) {
		it(`rejects invalid skipped content ${JSON.stringify(bad)}`, () => {
			expect(parse(bad).error).toBe("native_responses_parse_error");
		});
	}
	it("skips arbitrarily long strings and numbers without retaining them", () => {
		const parser = new NativeTerminalJson();
		parser.feed('{"padding":"');
		for (let i = 0; i < 100; i++) {
			parser.feed("x".repeat(65536));
			expect(parser.retainedCharacters).toBeLessThan(65536);
		}
		parser.feed('","number":1');
		for (let i = 0; i < 100; i++) {
			parser.feed("0".repeat(65536));
			expect(parser.retainedCharacters).toBeLessThan(65536);
		}
		parser.feed(',"type":"response.completed"}');
		expect(parser.finish()).toEqual({ type: "response.completed" });
		expect(parser.error).toBeNull();
	});
	it("limits retained fields and nesting", () => {
		expect(parse(JSON.stringify({ type: "x".repeat(5000) }), 100).error).toBe(
			"native_responses_parse_limit",
		);
		expect(parse(`{"x":${"[".repeat(65)}0${"]".repeat(65)}}`).error).toBe(
			"native_responses_parse_limit",
		);
	});
	it("ignores prototype names without changing field selection", () => {
		expect(
			parse(
				'{"__proto__":{"type":"response.failed"},"constructor":{"code":"error"},"type":"response.completed"}',
			).value,
		).toEqual({ type: "response.completed" });
	});
});

it("requires an object at the event root", () => {
	for (const root of ["[]", "[{}]", "null", "true", "123", '"text"'])
		expect(parse(root).error).toBe("native_responses_parse_error");
});
