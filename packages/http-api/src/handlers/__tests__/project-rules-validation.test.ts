import { describe, expect, it } from "bun:test";
import { validateProjectRulesPayload } from "../project-rules-validation";

function ok(body: unknown) {
	const result = validateProjectRulesPayload(body);
	if ("error" in result)
		throw new Error(`expected valid, got: ${result.error}`);
	return result.rules;
}

function err(body: unknown): string {
	const result = validateProjectRulesPayload(body);
	if (!("error" in result)) throw new Error("expected an error");
	return result.error;
}

describe("validateProjectRulesPayload", () => {
	it("accepts a well-formed payload and trims", () => {
		expect(
			ok({
				roots: ["  /home/*/projects  "],
				overrides: [{ prefix: " /home/u/.claude ", name: " .claude " }],
			}),
		).toEqual({
			roots: ["/home/*/projects"],
			overrides: [{ prefix: "/home/u/.claude", name: ".claude" }],
		});
	});

	it("accepts empty lists", () => {
		expect(ok({ roots: [], overrides: [] })).toEqual({
			roots: [],
			overrides: [],
		});
	});

	it("accepts a Windows drive root, because clients report their own paths", () => {
		expect(ok({ roots: ["C:\\Users\\alice"], overrides: [] }).roots).toEqual([
			"C:\\Users\\alice",
		]);
	});

	it("rejects a non-object body", () => {
		expect(err(null)).toContain("expected an object");
		expect(err("roots")).toContain("expected an object");
	});

	it("rejects a missing or non-array list", () => {
		expect(err({ overrides: [] })).toContain("'roots' must be an array");
		expect(err({ roots: [], overrides: {} })).toContain(
			"'overrides' must be an array",
		);
	});

	it("rejects a relative path", () => {
		// A relative path cannot name a directory on the client's machine, and
		// would silently never match.
		expect(err({ roots: ["projects"], overrides: [] })).toContain(
			"roots[0] must be an absolute path",
		);
	});

	it("rejects an empty entry", () => {
		expect(err({ roots: ["   "], overrides: [] })).toContain(
			"roots[0] must not be empty",
		);
	});

	it("rejects a control character", () => {
		expect(err({ roots: ["/home/u\nrepo"], overrides: [] })).toContain(
			"control characters",
		);
	});

	it("rejects a wildcard used inside a segment", () => {
		// The matcher only understands a whole-segment '*', so `/home/dar*` would
		// be accepted and then never match anything.
		expect(err({ roots: ["/home/dar*"], overrides: [] })).toContain(
			"only use '*' as a whole path segment",
		);
		expect(ok({ roots: ["/home/*"], overrides: [] }).roots).toEqual([
			"/home/*",
		]);
	});

	it("reports the offending index", () => {
		expect(err({ roots: ["/a", "/b", "relative"], overrides: [] })).toContain(
			"roots[2]",
		);
	});

	it("rejects a malformed override entry", () => {
		expect(err({ roots: [], overrides: ["/home/u"] })).toContain(
			"overrides[0] must be an object",
		);
		expect(err({ roots: [], overrides: [{ prefix: "/home/u" }] })).toContain(
			"overrides[0].name must be a string",
		);
		expect(
			err({ roots: [], overrides: [{ prefix: "/home/u", name: "  " }] }),
		).toContain("overrides[0].name must not be empty");
	});

	it("rejects an over-long name rather than truncating it", () => {
		expect(
			err({
				roots: [],
				overrides: [{ prefix: "/home/u", name: "a".repeat(65) }],
			}),
		).toContain("at most 64 characters");
	});

	it("rejects a list longer than the cap", () => {
		expect(
			err({ roots: new Array(257).fill("/home/u"), overrides: [] }),
		).toContain("at most 256 entries");
	});

	it("validates every entry before returning, so one bad row rejects the batch", () => {
		// The whole point of returning an error instead of writing per field: a
		// half-applied rule set silently changes which account each affected
		// project pins to.
		const result = validateProjectRulesPayload({
			roots: ["/home/*", "nope"],
			overrides: [],
		});
		expect("error" in result).toBe(true);
	});
});
