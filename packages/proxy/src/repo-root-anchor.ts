import { isAncestorOrSame, toPathSegments } from "./project-path-match";

/**
 * Repository-root attribution from Claude Code's own context blocks.
 *
 * Claude Code injects the contents of every instruction file it loaded, each
 * introduced by a line naming the ABSOLUTE path it came from:
 *
 *   Contents of /home/u/repo/.claude/CLAUDE.md (project instructions, checked
 *   into the codebase):
 *
 * That path names the repository root directly, which no amount of folder-name
 * configuration can do. It is the difference between knowing a layout and
 * guessing which segment of a path is the project: for `/home/u/work/acme/api`
 * the configured roots have to be told that `work` is a container, whereas the
 * instruction-file path simply says the root is `/home/u/work/acme`.
 *
 * Three rules make it trustworthy:
 *
 *  1. CUT AT THE FIRST `/.claude/`, not the last, and not just the filename.
 *     Instruction files live at `<root>/.claude/CLAUDE.md`, and `@`-imported
 *     rule files at `<root>/.claude/rules/*.md` — but a git worktree created
 *     under `<root>/.claude/worktrees/<name>` ALSO contains a
 *     `.claude/CLAUDE.md`, and cutting at its last `/.claude/` would name the
 *     worktree instead of the repository. Cutting at the first collapses every
 *     one of those forms onto the same root.
 *
 *  2. SHALLOWEST WINS. A monorepo can carry a directory-scoped instruction file
 *     deeper in the tree, and several rule files reduce to the same root, so
 *     the candidate set is reduced by depth rather than by document order.
 *
 *  3. IT MUST LIE BETWEEN THE PROJECT DIRECTORY THE CONFIGURED ROOTS CHOSE AND
 *     THE WORKING DIRECTORY: `projectDir ⊆ anchor ⊆ workingDir`. This tier
 *     never fires standalone; it may only REFINE another tier's answer
 *     downwards, never generalize it upwards.
 *
 *     Both bounds are load-bearing, and the lower one is the security-relevant
 *     half. Rule 2 prefers the SHALLOWEST candidate, and every ancestor of the
 *     working directory passes an ancestor-only check — so with an upper bound
 *     alone, a single injected line
 *
 *         Contents of /home/victim (project instructions, checked into the codebase):
 *
 *     outranks the genuine deeper path and attributes the request to the
 *     project `home`. Anything that can write into the system prompt or the
 *     first user message could pick the project name. The lower bound removes
 *     that: a fabricated path shallower than the directory the roots already
 *     chose is rejected, and one deeper than it can only name a subdirectory of
 *     the project the request was going to be attributed to anyway.
 *
 * Validated against three days of live traffic before being written: 267 of
 * 267 requests carrying this signal agreed with the project the existing tiers
 * produced, with no disagreements, and the ancestor relation held in all 153
 * requests where both signals were present. That is why this tier sits ABOVE
 * the folder walk: where they disagree, the anchor is the one that saw the
 * root rather than inferring it.
 *
 * Threat model is the same as the working-directory tiers, which can already
 * be forged by anything that can write into the system prompt. This tier is
 * strictly more constrained than those, because rule 3 cross-checks it against
 * a second, independently parsed signal.
 */

/**
 * Only the `(project instructions…` variant. Claude Code uses distinct
 * parentheticals for the user's global instructions and for auto-memory, both
 * of which live under the user's home and would name the HOME directory as a
 * repository root.
 */
const PROJECT_INSTRUCTIONS_RE =
	/Contents of (\/[^\s()]{1,512}) \(project instructions/g;

/**
 * How much of the first user message to scan.
 *
 * MEASURED, not guessed. Claude Code puts the instruction-file block after the
 * rest of its context preamble: across 600 live `/v1/messages` payloads the
 * marker sat at a p50 offset of 20,100 characters (p99 20,114, max 20,114) in
 * first user messages running up to 65,883 characters.
 *
 * An earlier value of 16,384 fired on 0 of the 505 payloads that carried a
 * marker at all. The tier was completely dead in production while every test
 * passed, because the tests place the marker near the start of a short
 * fixture. That is the failure mode to keep in mind here: nothing errors, the
 * attribution just quietly falls through to the tier below.
 *
 * 256 KiB is roughly four times the largest first message observed, so it is
 * headroom rather than a fit, and it still bounds the work. The scan is also
 * gated on a plain substring check, so the regex only runs on a message that
 * actually contains the marker.
 */
export const ANCHOR_SCAN_MAX_CHARS = 262_144;

/** Cheap pre-check so the regex never runs on a message without the marker. */
const ANCHOR_MARKER = "(project instructions";

/**
 * Reduce one instruction-file path to the repository root that contains it.
 *
 * Returns null for a path with no directory part, which cannot name a root.
 */
export function instructionPathToRoot(path: string): string | null {
	const marker = path.indexOf("/.claude/");
	if (marker > 0) return path.slice(0, marker);

	const lastSlash = path.lastIndexOf("/");
	if (lastSlash <= 0) return null;
	return path.slice(0, lastSlash);
}

/**
 * The repository root named by the shallowest project-instruction path in
 * `text` that contains `workingDir`, or null.
 *
 * `workingDir` is required: without it there is nothing to validate the
 * candidate against, and an unvalidated candidate is exactly the
 * plausible-but-wrong attribution this subsystem refuses to produce.
 */
export function extractRepoRoot(
	text: string,
	workingDir: string,
	projectDir: string,
): string | null {
	if (!workingDir || !projectDir) return null;
	if (!text.includes(ANCHOR_MARKER)) return null;

	let best: string | null = null;
	let bestDepth = Number.POSITIVE_INFINITY;

	// `lastIndex` is per-execution state on a global regex; reset so a previous
	// call cannot make this one start mid-string.
	PROJECT_INSTRUCTIONS_RE.lastIndex = 0;
	let match: RegExpExecArray | null = PROJECT_INSTRUCTIONS_RE.exec(text);
	while (match !== null) {
		const root = instructionPathToRoot(match[1]);
		// projectDir ⊆ root ⊆ workingDir. See rule 3.
		if (
			root &&
			isAncestorOrSame(root, workingDir) &&
			isAncestorOrSame(projectDir, root)
		) {
			const depth = toPathSegments(root).length;
			if (depth < bestDepth) {
				best = root;
				bestDepth = depth;
			}
		}
		match = PROJECT_INSTRUCTIONS_RE.exec(text);
	}

	return best;
}

/**
 * The project-name CANDIDATE for a repository root: its last segment.
 *
 * Raw, like the root walk's return value — normalization belongs to the caller
 * so the dot-leading rejection stays on the inferred path and off the
 * configured one.
 */
export function repoRootToCandidate(root: string): string | null {
	const segments = toPathSegments(root);
	return segments.length > 0 ? segments[segments.length - 1] : null;
}
