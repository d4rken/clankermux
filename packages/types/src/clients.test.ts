import { describe, expect, it } from "bun:test";
import {
	claudeCodeCatalogue,
	claudeCodeName,
	claudeCodeTarget,
	composeGlobalCatalogue,
	type GlobalCatalogueFormat,
	type GlobalCatalogueModel,
	globalCatalogueFormats,
	globalDeltaFromList,
	sameGlobalEntry,
} from "./clients";

const entry = (
	id: string,
	targetModel = id,
	accountIds: string[] | null = null,
): GlobalCatalogueModel => ({ id, displayName: id, targetModel, accountIds });
const global: GlobalCatalogueFormat = {
	models: [entry("a"), entry("b"), entry("c")],
	defaultModel: "a",
};

describe("composeGlobalCatalogue", () => {
	it("keeps global order, replaces overrides in place and appends the client's own entries", () => {
		const composed = composeGlobalCatalogue(global, {
			additions: [entry("mine"), { ...entry("b"), displayName: "Mine B" }],
			removals: ["c"],
		});
		expect(
			composed.map(({ model, provenance }) => [model.id, provenance]),
		).toEqual([
			["a", "global"],
			["b", "override"],
			["mine", "added"],
		]);
		expect(composed[1]?.model.displayName).toBe("Mine B");
	});
});

describe("globalDeltaFromList", () => {
	it("records what a list adds, changes and leaves out", () => {
		expect(
			globalDeltaFromList(
				global,
				{ removals: [] },
				[{ ...entry("a"), displayName: "Renamed" }, entry("b"), entry("x")],
				new Set(),
			),
		).toEqual({
			additions: [{ ...entry("a"), displayName: "Renamed" }, entry("x")],
			removals: ["c"],
		});
	});
	it("keeps a skipped entry's previous removal state, whatever the list says", () => {
		const list = [entry("a")];
		const skipped = new Set(["b", "c"]);
		expect(
			globalDeltaFromList(global, { removals: ["c"] }, list, skipped).removals,
		).toEqual(["c"]);
		expect(
			globalDeltaFromList(global, { removals: [] }, list, skipped).removals,
		).toEqual([]);
	});
	it("treats an entry that matches its global one up to pin order as no addition", () => {
		const pinned: GlobalCatalogueFormat = {
			models: [entry("fast", "gpt", ["b", "a"])],
			defaultModel: null,
		};
		expect(
			globalDeltaFromList(
				pinned,
				{ removals: [] },
				[entry("fast", "gpt", ["a", "b", "a"])],
				new Set(),
			),
		).toEqual({ additions: [], removals: [] });
	});
});

describe("sameGlobalEntry", () => {
	it("ignores client-derived fields and account pin order", () => {
		expect(
			sameGlobalEntry(entry("x", "x", ["b", "a"]), {
				...entry("x", "x", ["a", "b"]),
				// A client's published copy carries fields the global entry never has.
				...({ createdAt: "2026-01-01" } as object),
			}),
		).toBe(true);
		expect(sameGlobalEntry(entry("x"), entry("x", "y"))).toBe(false);
	});
});

describe("globalCatalogueFormats", () => {
	it("covers the application's own format, and every format for a generic client", () => {
		expect(globalCatalogueFormats("generic")).toEqual([
			"anthropic",
			"openai",
			"codex",
		]);
		expect(globalCatalogueFormats("claude-code")).toEqual(["anthropic"]);
		expect(globalCatalogueFormats("codex")).toEqual(["codex"]);
		for (const application of ["opencode", "pi", "oh-my-pi"] as const)
			expect(globalCatalogueFormats(application)).toEqual(["openai"]);
	});
});

describe("Claude Code names", () => {
	it("prefixes only IDs Claude Code would not list, and reads the prefix back", () => {
		for (const [id, name] of [
			["gpt-6-astra", "claude-gpt-6-astra"],
			["alias:frontier", "claude-alias:frontier"],
			["claude-opus-5-5", "claude-opus-5-5"],
			["alias:frontier_anthropic", "alias:frontier_anthropic"],
		] as const) {
			expect(claudeCodeName(id)).toBe(name);
			if (name !== id) expect(claudeCodeTarget(name)).toBe(id);
		}
	});
	it("yields no candidate for a name the prefix cannot have produced", () => {
		expect(claudeCodeTarget("gpt-6-astra")).toBeNull();
		expect(claudeCodeTarget("claude-")).toBeNull();
		expect(claudeCodeTarget("claude-claude-x")).toBeNull();
		expect(claudeCodeTarget("claude-anthropic-x")).toBeNull();
		// Only a candidate: the accounts decide whether it is a prefixed name.
		expect(claudeCodeTarget("claude-opus-5-5")).toBe("opus-5-5");
	});
});

describe("claudeCodeCatalogue", () => {
	it("lists every entry under its Claude Code name and carries the default", () => {
		expect(
			claudeCodeCatalogue(
				[entry("gpt-6-astra"), entry("claude-opus-5-5")],
				"gpt-6-astra",
			),
		).toEqual({
			models: [
				{ model: entry("gpt-6-astra"), name: "claude-gpt-6-astra" },
				{ model: entry("claude-opus-5-5"), name: "claude-opus-5-5" },
			],
			defaultModel: "claude-gpt-6-astra",
		});
	});
	it("keeps the entry already stored under a contested name, and drops a default that lost", () => {
		const result = claudeCodeCatalogue(
			[entry("gpt-6", "gpt-6"), entry("claude-gpt-6", "other")],
			"gpt-6",
		);
		expect(result.models.map(({ model }) => model.targetModel)).toEqual([
			"other",
		]);
		expect(result.defaultModel).toBeNull();
	});
});
