import type { ProjectPathOverride, ProjectRules } from "@clankermux/types";

/**
 * Segment-wise matching of a working directory against the operator's project
 * rules (see `ProjectRules`).
 *
 * Split out of project-extraction.ts because it is the only part of
 * attribution that is CONFIGURED rather than parsed: everything in
 * project-extraction is about getting a trustworthy path out of a request
 * body, and everything here is about what that path means once you have it.
 *
 * Two shapes of rule, one matcher:
 *
 *   roots      a directory whose IMMEDIATE CHILD is the project
 *   overrides  a directory whose whole subtree IS the named project
 *
 * Both are matched by path SEGMENT, never by string prefix. A raw
 * `startsWith` would make `/home/u/repo` match `/home/u/repo-two`, quietly
 * pulling an unrelated repository into another project's affinity partition.
 */

/**
 * Split a path into comparable segments.
 *
 * Only the separator is normalized. A Windows drive (`C:`) and a UNC host
 * (`\\server`) are KEPT as ordinary leading segments: stripping them, which is
 * what this did originally, erases the only thing distinguishing two machines'
 * identical layouts, so `C:\work\repo` and `D:\work\repo` — or two different
 * file servers exporting the same share name — collapsed onto one project and
 * therefore one load-balancer affinity partition. The default roots carry
 * wildcard-led patterns so those paths still resolve (see
 * DEFAULT_PROJECT_ROOTS).
 *
 * Empty segments are dropped, so a trailing slash, a doubled separator and the
 * bare path all produce the same list.
 */
export function toPathSegments(path: string): string[] {
	return path
		.replace(/\\/g, "/")
		.split("/")
		.filter((segment) => segment.length > 0);
}

/**
 * True for a capture that can be treated as a working directory at all.
 *
 * Two rejections, both of which otherwise yield a definite WRONG project
 * rather than nothing:
 *
 *  - Not absolute. Segment matching ignores the leading slash, so a bare
 *    `home/u/repo` — or any prompt fragment shaped like a path — matches the
 *    `/home/*` default exactly as the real thing does.
 *  - Contains `.` or `..`. These are not resolved (resolving would require a
 *    filesystem we do not have), so `/home/u/repo/../other` stays "under" an
 *    override for `/home/u/repo` and is attributed to it.
 */
export function isUsableWorkingDir(path: string): boolean {
	const normalized = path.replace(/\\/g, "/");
	const absolute =
		normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
	if (!absolute) return false;
	return !toPathSegments(normalized).some(
		(segment) => segment === "." || segment === "..",
	);
}

/** The wildcard segment. Matches exactly one segment; there is no `**`. */
const WILDCARD = "*";

/**
 * True when `pattern` matches the first `pattern.length` segments of `path`.
 *
 * Deliberately a PREFIX match rather than a whole-path match: both rule kinds
 * are about a directory and everything beneath it.
 */
function matchesPrefix(
	patternSegments: string[],
	pathSegments: string[],
): boolean {
	if (patternSegments.length > pathSegments.length) return false;
	for (let i = 0; i < patternSegments.length; i++) {
		const p = patternSegments[i];
		if (p === WILDCARD) continue;
		if (p !== pathSegments[i]) return false;
	}
	return true;
}

/**
 * Specificity ranking for two matching patterns of the same shape.
 *
 * Depth first: a two-segment root loses to a three-segment one for a path
 * under both, because the deeper rule is the one that says something the
 * shallower one does not. Literal count breaks a depth tie, so a hand-written
 * `/home/darken/work` outranks a wildcarded root of the same depth — an
 * operator who named a specific user meant that user.
 */
function isMoreSpecific(candidate: string[], incumbent: string[]): boolean {
	if (candidate.length !== incumbent.length) {
		return candidate.length > incumbent.length;
	}
	const literals = (segments: string[]) =>
		segments.reduce((n, s) => (s === WILDCARD ? n : n + 1), 0);
	return literals(candidate) > literals(incumbent);
}

/**
 * The most specific override whose prefix contains `pathSegments`, or null.
 *
 * The caller uses the returned `name` VERBATIM — this is the tier that is
 * never second-guessed, so an override for `/home/u/.claude` is what makes a
 * dot-leading directory usable as a project.
 */
export function matchProjectOverride(
	pathSegments: string[],
	overrides: readonly ProjectPathOverride[],
): ProjectPathOverride | null {
	let best: ProjectPathOverride | null = null;
	let bestSegments: string[] | null = null;

	for (const override of overrides) {
		const segments = toPathSegments(override.prefix);
		// A zero-segment prefix ("/" or "") would match every path on the
		// machine; treat it as unconfigured rather than as a global override.
		if (segments.length === 0) continue;
		if (!matchesPrefix(segments, pathSegments)) continue;
		if (bestSegments === null || isMoreSpecific(segments, bestSegments)) {
			best = override;
			bestSegments = segments;
		}
	}

	return best;
}

/**
 * The project-name CANDIDATE produced by the configured roots, or null.
 *
 * Null covers three genuinely different situations that all mean "we do not
 * know", and the caller must treat them the same way:
 *
 *  - no root matches at all (an unconfigured layout)
 *  - the path IS a root (`/home/u/projects` — you are standing in the
 *    container, not in a project)
 *  - a root matched but the segment after it fails normalization upstream
 *
 * The returned string is a RAW segment. Normalization (length cap, control
 * characters, the dot-leading rejection) is the caller's job, because that
 * rejection must apply to inferred names and not to configured ones.
 */
export function matchProjectRoot(
	pathSegments: string[],
	roots: readonly string[],
): string | null {
	return matchProjectRootDetailed(pathSegments, roots)?.segment ?? null;
}

/**
 * As {@link matchProjectRoot}, but also reporting the project DIRECTORY — the
 * matched root plus the project segment.
 *
 * The directory is what lets a later tier refine this answer safely: a tier
 * that may only name something at or below this path cannot be talked into
 * naming something above it.
 */
export function matchProjectRootDetailed(
	pathSegments: string[],
	roots: readonly string[],
): { segment: string; projectDir: string } | null {
	let bestSegments: string[] | null = null;

	for (const root of roots) {
		const segments = toPathSegments(root);
		if (segments.length === 0) continue;
		if (!matchesPrefix(segments, pathSegments)) continue;
		// The path IS this root: a container, never a project. This wins over
		// every other match rather than merely skipping the current one:
		// `/home/u/projects` is matched exactly by the projects root AND as a
		// parent by the bare-home root, and letting the parent answer would
		// name the container `projects` as a project.
		if (segments.length === pathSegments.length) return null;
		if (segments.length > pathSegments.length) continue;
		if (bestSegments === null || isMoreSpecific(segments, bestSegments)) {
			bestSegments = segments;
		}
	}

	if (bestSegments === null) return null;
	const segment = pathSegments[bestSegments.length];
	if (segment === undefined) return null;
	return {
		segment,
		projectDir: `/${pathSegments.slice(0, bestSegments.length + 1).join("/")}`,
	};
}

/** True when `ancestor` is `path` or contains it, compared segment-wise. */
export function isAncestorOrSame(ancestor: string, path: string): boolean {
	const a = toPathSegments(ancestor);
	const p = toPathSegments(path);
	if (a.length === 0 || a.length > p.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== p[i]) return false;
	}
	return true;
}

/**
 * Both rule kinds, resolved in priority order, for a path already known to be
 * a real working directory.
 *
 * `override` wins over `root` because it is what the operator stated
 * explicitly; `root` is still the answer for every path they did not name.
 */
export function resolveConfiguredProject(
	workingDir: string,
	rules: ProjectRules,
):
	| { kind: "override"; name: string }
	| { kind: "root"; segment: string; projectDir: string }
	| null {
	const segments = toPathSegments(workingDir);
	if (segments.length === 0) return null;

	const override = matchProjectOverride(segments, rules.overrides);
	if (override) return { kind: "override", name: override.name };

	const matched = matchProjectRootDetailed(segments, rules.roots);
	if (matched) return { kind: "root", ...matched };

	return null;
}
