import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROJECT_ROOTS } from "@clankermux/types";
import { Config, type ConfigData } from "./index";

function makeConfig(file?: ConfigData): {
	config: Config;
	path: string;
	cleanup: () => void;
} {
	const dir = mkdtempSync(join(tmpdir(), "clankermux-project-rules-"));
	const path = join(dir, "config.json");
	// Seeded BEFORE construction: the constructor reads the file once, so a
	// later write would not be observed.
	if (file) writeFileSync(path, JSON.stringify(file, null, 2));
	return {
		config: new Config(path),
		path,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("project rules", () => {
	it("defaults to the built-in roots and no overrides", () => {
		const { config, cleanup } = makeConfig();
		try {
			const rules = config.getProjectRules();
			expect(rules.roots).toEqual([...DEFAULT_PROJECT_ROOTS]);
			expect(rules.overrides).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("round-trips both lists through the file", () => {
		const { config, path, cleanup } = makeConfig();
		try {
			config.setProjectRules({
				roots: ["/workspace"],
				overrides: [{ prefix: "/home/u/.claude", name: ".claude" }],
			});
			expect(config.getProjectRules()).toEqual({
				roots: ["/workspace"],
				overrides: [{ prefix: "/home/u/.claude", name: ".claude" }],
			});

			const onDisk = JSON.parse(readFileSync(path, "utf-8"));
			expect(onDisk.project_roots).toEqual(["/workspace"]);
			expect(onDisk.project_overrides).toEqual([
				{ prefix: "/home/u/.claude", name: ".claude" },
			]);
		} finally {
			cleanup();
		}
	});

	it("honours a present-but-empty roots list", () => {
		// An operator can legitimately choose to attribute nothing by heuristic
		// and rely entirely on overrides.
		const { config, cleanup } = makeConfig({ project_roots: [] });
		try {
			expect(config.getProjectRules().roots).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("falls back to defaults when a key is malformed rather than to nothing", () => {
		// A hand-edited file with a typo must not silently switch attribution
		// off across the deployment.
		const { config, cleanup } = makeConfig({
			project_roots: "not-an-array",
		} as unknown as ConfigData);
		try {
			expect(config.getProjectRules().roots).toEqual([
				...DEFAULT_PROJECT_ROOTS,
			]);
		} finally {
			cleanup();
		}
	});

	it("returns a copy, so a caller cannot mutate the stored rules", () => {
		const { config, cleanup } = makeConfig();
		try {
			const first = config.getProjectRules();
			first.roots.push("/injected");
			expect(config.getProjectRules().roots).not.toContain("/injected");
		} finally {
			cleanup();
		}
	});

	it("keeps the structured keys out of the flat settings map", () => {
		// getAllSettings is typed as scalars only and backs GET /api/config.
		const { config, cleanup } = makeConfig();
		try {
			config.setProjectRules({ roots: ["/workspace"], overrides: [] });
			const settings = config.getAllSettings();
			expect(settings.project_roots).toBeUndefined();
			expect(settings.project_overrides).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("is not reachable through the scalar accessor", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setProjectRules({ roots: ["/workspace"], overrides: [] });
			expect(config.get("project_roots")).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("emits a change event so listeners can react to a rules edit", () => {
		const { config, cleanup } = makeConfig();
		try {
			const keys: string[] = [];
			config.on("change", ({ key }: { key: string }) => keys.push(key));
			config.setProjectRules({ roots: ["/workspace"], overrides: [] });
			expect(keys).toEqual(["project_roots", "project_overrides"]);
		} finally {
			cleanup();
		}
	});
});
