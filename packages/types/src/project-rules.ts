/**
 * Operator-configurable rules for turning a client's working directory into a
 * project name.
 *
 * Shared between the proxy (which applies them), the config layer (which
 * persists them), the HTTP API and the dashboard (which edit them), so the
 * shape can never drift between producer and consumers.
 *
 * These replace a hard-coded list of "container" folder names that only ever
 * matched directly under `/home/<user>` or `/Users/<user>`. That list was
 * silently wrong for every layout it did not enumerate — `~/work`, `~/dev`,
 * `~/code`, `~/go` and `~/Documents/GitHub` all collapsed every repo beneath
 * them into a single project named after the container — and the non-home
 * fallback took the BASENAME instead, so two working directories inside one
 * repository became two projects. Both outcomes feed the load balancer's
 * affinity partition key, so a wrong name is not merely a mislabelled chart:
 * it merges two codebases onto one upstream account and splits that account's
 * prompt cache between two unrelated prefixes.
 */

/**
 * An explicit path-prefix → project-name mapping.
 *
 * Checked before every heuristic and never second-guessed: the name is used
 * verbatim (after whitespace/control-character cleanup and the length cap),
 * bypassing the dot-leading rejection that applies to inferred names. That is
 * what makes an infrastructure-looking directory such as `/home/u/.claude`
 * usable as a project when the operator says it is one.
 */
export interface ProjectPathOverride {
	/**
	 * Absolute path prefix. Matched segment-wise, so `/home/u/repo` matches
	 * `/home/u/repo` and `/home/u/repo/packages/api` but never
	 * `/home/u/repo-two`. A `*` segment matches exactly one path segment.
	 */
	prefix: string;
	/** Project name to use verbatim for anything under `prefix`. */
	name: string;
}

/**
 * The full rule set.
 *
 * Matching picks the most specific entry rather than the first, so reordering
 * the lists does not normally change attribution. "Most specific" means deeper
 * first, then more literal (non-wildcard) segments. Two entries that tie on
 * BOTH are genuinely ambiguous: a wildcarded user with a literal `repo`, and a
 * literal user with a wildcarded child, say different things about
 * `/home/u/repo/sub` and neither is more specific. In that case the
 * earlier one wins. That case is order-dependent; there is no principled
 * winner, so it is documented rather than papered over.
 *
 * One behaviour deliberately NOT carried over from the folder-name list this
 * replaced: containers no longer nest transitively. The old code skipped a RUN
 * of container names, so `~/projects/repos/acme` resolved to `acme`. A root
 * names one level, so with the defaults that path resolves to `repos`; add
 * `/home/<user>/projects/repos` as a root to get `acme`.
 */
export interface ProjectRules {
	/**
	 * Absolute directories whose IMMEDIATE CHILDREN are projects.
	 *
	 * `/home/*` says "a directory directly under any user's home is a project",
	 * which is what makes `/home/darken/clankermux` resolve to `clankermux`.
	 * A root of `/home/<user>/projects` says the same one level deeper. The
	 * most specific matching root wins, so both can coexist.
	 *
	 * A `*` segment matches exactly one path segment. There is no `**`: a
	 * pattern that matched any depth could not answer "which segment is the
	 * project", which is the only question this list exists to answer.
	 */
	roots: string[];
	/** Explicit mappings, checked before {@link roots}. */
	overrides: ProjectPathOverride[];
}

/**
 * Defaults, chosen to reproduce the previous hard-coded behaviour exactly on
 * a `/home/<user>` or `/Users/<user>` layout.
 *
 * These are PATTERNS rather than resolved home directories on purpose. The
 * proxy attributes paths that describe the CLIENT's machine, which is
 * routinely not the machine the proxy runs on, so `os.homedir()` would be the
 * wrong answer for every remote client and for every multi-user deployment.
 */
export const DEFAULT_PROJECT_ROOTS: readonly string[] = [
	// The former HOME_CONTAINER_DIRS, one entry per (home base, container).
	"/home/*/Desktop",
	"/home/*/projects",
	"/home/*/repos",
	"/home/*/src",
	"/home/*/git_repos",
	"/Users/*/Desktop",
	"/Users/*/projects",
	"/Users/*/repos",
	"/Users/*/src",
	"/Users/*/git_repos",
	// The bare home directory, matched only when no container above applies.
	"/home/*",
	"/Users/*",
	// Windows clients. The drive is kept as a leading segment rather than
	// stripped — stripping it made `C:\work\repo` and `D:\work\repo` the same
	// project — so these patterns lead with a wildcard to match it. They cannot
	// collide with the POSIX entries above: the second segment must be `Users`.
	"/*/Users/*/Desktop",
	"/*/Users/*/projects",
	"/*/Users/*/repos",
	"/*/Users/*/src",
	"/*/Users/*/git_repos",
	"/*/Users/*",
];

/** The default rule set: {@link DEFAULT_PROJECT_ROOTS} and no overrides. */
export function defaultProjectRules(): ProjectRules {
	return { roots: [...DEFAULT_PROJECT_ROOTS], overrides: [] };
}
