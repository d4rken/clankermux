import { describe, expect, it } from "bun:test";
import { defaultProjectRules } from "@clankermux/types";
import {
	isAncestorOrSame,
	isUsableWorkingDir,
	matchProjectOverride,
	matchProjectRoot,
	resolveConfiguredProject,
	toPathSegments,
} from "../project-path-match";

const DEFAULTS = defaultProjectRules();

/** The segment produced by the DEFAULT roots, or null. */
function underDefaults(path: string): string | null {
	return matchProjectRoot(toPathSegments(path), DEFAULTS.roots);
}

describe("toPathSegments", () => {
	it("drops empty segments so a trailing slash changes nothing", () => {
		expect(toPathSegments("/home/u/repo/")).toEqual(["home", "u", "repo"]);
		expect(toPathSegments("/home//u///repo")).toEqual(["home", "u", "repo"]);
	});

	it("keeps the Windows drive as a segment", () => {
		// The separator swap is still needed — without it the whole string is ONE
		// segment and the entire path, user name included, became the project.
		// The DRIVE is kept: stripping it made `C:\work\repo` and `D:\work\repo`
		// the same project and therefore the same affinity partition.
		expect(toPathSegments("C:\\Users\\alice\\myrepo")).toEqual([
			"C:",
			"Users",
			"alice",
			"myrepo",
		]);
	});

	it("keeps the UNC host as a segment", () => {
		// Same reason: two file servers exporting a share of the same name are
		// two different machines, not one project.
		expect(toPathSegments("//server/share/myrepo")).toEqual([
			"server",
			"share",
			"myrepo",
		]);
	});
});

describe("isUsableWorkingDir", () => {
	it("accepts absolute POSIX, Windows and UNC paths", () => {
		expect(isUsableWorkingDir("/home/u/repo")).toBe(true);
		expect(isUsableWorkingDir("C:\\Users\\alice\\repo")).toBe(true);
		expect(isUsableWorkingDir("\\\\server\\share\\repo")).toBe(true);
	});

	it("rejects a relative path", () => {
		// Segment matching ignores the leading slash, so a bare `home/u/repo`
		// would match the `/home/*` default exactly as the real thing does.
		expect(isUsableWorkingDir("home/u/repo")).toBe(false);
		expect(isUsableWorkingDir("token=sk-ABCDEFGH12345678")).toBe(false);
	});

	it("rejects unresolved dot segments", () => {
		// Nothing resolves these — that would need a filesystem — so without the
		// rejection `/home/u/repo/../other` stays "under" an override for
		// `/home/u/repo` and is attributed to it.
		expect(isUsableWorkingDir("/home/u/repo/../other")).toBe(false);
		expect(isUsableWorkingDir("/home/u/./repo")).toBe(false);
	});
});

describe("matchProjectRoot", () => {
	it("keeps two drives apart", () => {
		// The collision this exists to prevent: one project, two machines, one
		// affinity partition.
		const roots = ["/C:/work"];
		expect(matchProjectRoot(toPathSegments("C:\\work\\repo"), roots)).toBe(
			"repo",
		);
		expect(
			matchProjectRoot(toPathSegments("D:\\work\\repo"), roots),
		).toBeNull();
	});

	it("resolves a Windows path under the shipped defaults", () => {
		// The wildcard-led default is what keeps drive paths working now that the
		// drive is no longer stripped.
		expect(underDefaults("C:\\Users\\alice\\myrepo")).toBe("myrepo");
		expect(underDefaults("C:\\Users\\alice\\projects\\myrepo")).toBe("myrepo");
		expect(underDefaults("C:\\Users\\alice")).toBeNull();
	});

	it("returns the segment directly below the matching root", () => {
		expect(underDefaults("/home/darken/clankermux")).toBe("clankermux");
	});

	it("returns the repo root for a working directory deep inside it", () => {
		// The whole point of walking DOWN from a root rather than taking the
		// basename: two cwds in one repo must be one project.
		expect(underDefaults("/home/darken/clankermux/packages/proxy")).toBe(
			"clankermux",
		);
		expect(underDefaults("/home/darken/projects/octi/app/src")).toBe("octi");
	});

	it("prefers the deeper root when two match", () => {
		// /home/*/projects and /home/* both match; the deeper one is the one
		// saying something the shallower does not.
		expect(underDefaults("/home/darken/projects/octi")).toBe("octi");
	});

	it("breaks a depth tie by literal count, so a named user outranks a wildcard", () => {
		const roots = ["/home/*/work", "/home/darken/work"];
		// Same depth. The operator who spelled out `darken` meant that user, so
		// their rule is the one that applies to darken's paths.
		expect(
			matchProjectRoot(toPathSegments("/home/darken/work/acme"), roots),
		).toBe("acme");
		expect(
			matchProjectRoot(toPathSegments("/home/alice/work/acme"), roots),
		).toBe("acme");
	});

	it("returns null for the root itself: a container is not a project", () => {
		expect(underDefaults("/home/darken/projects")).toBeNull();
		expect(underDefaults("/home/darken")).toBeNull();
	});

	it("returns null when no root matches, rather than guessing a basename", () => {
		// The previous implementation took the BASENAME here, which split one
		// repository into one project per subdirectory and fed that wrong name
		// straight into the load balancer's affinity key.
		expect(underDefaults("/workspace/myrepo/packages/api")).toBeNull();
		expect(underDefaults("/srv/data/myproj")).toBeNull();
		expect(underDefaults("/var/lib/jenkins/workspace/build-42")).toBeNull();
	});

	it("resolves a configured non-home root the same way as a home one", () => {
		const roots = ["/workspace"];
		expect(
			matchProjectRoot(toPathSegments("/workspace/myrepo/packages/api"), roots),
		).toBe("myrepo");
	});

	it("matches segment-wise, never by raw string prefix", () => {
		// `/home/u/repo`.startsWith(`/home/u/repo`) is also true of
		// `/home/u/repo-two`, which would pull an unrelated repository into
		// another project's affinity partition.
		const roots = ["/home/u/repo"];
		expect(
			matchProjectRoot(toPathSegments("/home/u/repo-two/x"), roots),
		).toBeNull();
		expect(matchProjectRoot(toPathSegments("/home/u/repo/x"), roots)).toBe("x");
	});

	it("ignores a root with no segments instead of matching everything", () => {
		expect(matchProjectRoot(toPathSegments("/home/u/repo"), ["/"])).toBeNull();
		expect(matchProjectRoot(toPathSegments("/home/u/repo"), [""])).toBeNull();
	});

	it("reproduces the previous behaviour for a Windows client path", () => {
		expect(underDefaults("C:\\Users\\alice\\dev\\myrepo")).toBe("dev");
	});
});

describe("matchProjectOverride", () => {
	const overrides = [
		{ prefix: "/home/darken/.claude", name: ".claude" },
		{ prefix: "/home/darken/.claude/worktrees", name: "scratch" },
	];

	it("matches the whole subtree below the prefix", () => {
		expect(
			matchProjectOverride(toPathSegments("/home/darken/.claude"), overrides)
				?.name,
		).toBe(".claude");
		expect(
			matchProjectOverride(
				toPathSegments("/home/darken/.claude/plans"),
				overrides,
			)?.name,
		).toBe(".claude");
	});

	it("prefers the deeper prefix, not the first listed", () => {
		// Display order must never change attribution.
		expect(
			matchProjectOverride(
				toPathSegments("/home/darken/.claude/worktrees/x"),
				overrides,
			)?.name,
		).toBe("scratch");
	});

	it("matches segment-wise", () => {
		expect(
			matchProjectOverride(
				toPathSegments("/home/darken/.claude-backup"),
				overrides,
			),
		).toBeNull();
	});

	it("ignores an empty prefix instead of overriding every path", () => {
		expect(
			matchProjectOverride(toPathSegments("/home/u/repo"), [
				{ prefix: "/", name: "everything" },
			]),
		).toBeNull();
	});
});

describe("isAncestorOrSame", () => {
	it("accepts an equal path and a true ancestor", () => {
		expect(isAncestorOrSame("/home/u/repo", "/home/u/repo")).toBe(true);
		expect(isAncestorOrSame("/home/u/repo", "/home/u/repo/packages/a")).toBe(
			true,
		);
	});

	it("rejects a descendant, a sibling and a string-prefix near-miss", () => {
		expect(isAncestorOrSame("/home/u/repo/packages/a", "/home/u/repo")).toBe(
			false,
		);
		expect(isAncestorOrSame("/home/u/other", "/home/u/repo")).toBe(false);
		expect(isAncestorOrSame("/home/u/repo", "/home/u/repo-two")).toBe(false);
	});

	it("rejects an empty ancestor rather than treating it as the filesystem root", () => {
		expect(isAncestorOrSame("/", "/home/u/repo")).toBe(false);
	});
});

describe("resolveConfiguredProject", () => {
	const rules = {
		roots: ["/home/*", "/home/*/projects"],
		overrides: [{ prefix: "/home/darken/.claude", name: ".claude" }],
	};

	it("lets an override win over a root that also matches", () => {
		expect(resolveConfiguredProject("/home/darken/.claude", rules)).toEqual({
			kind: "override",
			name: ".claude",
		});
	});

	it("falls through to the roots for a path no override names", () => {
		expect(resolveConfiguredProject("/home/darken/clankermux", rules)).toEqual({
			kind: "root",
			segment: "clankermux",
			projectDir: "/home/darken/clankermux",
		});
	});

	it("reports the project directory, not just the name", () => {
		// The repository-root tier is bounded from below by this path, so it has
		// to be the directory the project name came from and not merely a prefix
		// of the working directory.
		expect(
			resolveConfiguredProject("/home/darken/projects/octi/app/src", {
				roots: ["/home/*", "/home/*/projects"],
				overrides: [],
			}),
		).toEqual({
			kind: "root",
			segment: "octi",
			projectDir: "/home/darken/projects/octi",
		});
	});

	it("returns null for an unconfigured layout", () => {
		expect(resolveConfiguredProject("/workspace/myrepo", rules)).toBeNull();
	});

	it("returns null for an empty path", () => {
		expect(resolveConfiguredProject("", rules)).toBeNull();
	});
});
