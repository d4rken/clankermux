/**
 * Longest project name we accept. Exported so the extraction guard can REJECT
 * an over-long candidate instead of letting it be truncated here — truncation is
 * what turns a leaked prompt tail into a plausible-looking project name. This is
 * not a storage constraint: `requests.project` is plain TEXT.
 */
export const PROJECT_NAME_MAX_LEN = 64;

/**
 * Marker cleanup for an already-SELECTED name (a single path segment or an
 * `x-project` header). Deliberately NOT applied to a whole captured path: `\s*`
 * matches zero whitespace, so on a path it would read `/workspace/model/repo`
 * as `/workspace` plus a trailer. See the guard notes in project-extraction.ts.
 */
const CLAUDE_ENV_MARKER_RE =
	/\s*(?:-\s*)?(?:Is a git repository\b|Is directory a git repo\b|Platform\b|Shell\b|Today's date\b|Model\b).*$/i;

/** Everything {@link sanitizeProjectName} does except the length cap. */
function cleanProjectName(raw: string | undefined | null): string | null {
	if (!raw) return null;

	// Strip ASCII control chars (incl. newlines/tabs) before applying marker
	// cleanup so concatenated Claude Code environment blocks cannot fragment
	// routing affinity keys.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
	const withoutControls = raw.replace(/[\x00-\x1F\x7F]/g, "").trim();
	const withoutEnvBlock = withoutControls
		.replace(CLAUDE_ENV_MARKER_RE, "")
		.replace(/[\s:;,-]+$/g, "")
		.trim();

	if (!withoutEnvBlock) return null;
	return withoutEnvBlock;
}

export function sanitizeProjectName(
	raw: string | undefined | null,
): string | null {
	const cleaned = cleanProjectName(raw);
	if (cleaned === null) return null;
	return cleaned.length > PROJECT_NAME_MAX_LEN
		? cleaned.slice(0, PROJECT_NAME_MAX_LEN)
		: cleaned;
}

/**
 * True when {@link sanitizeProjectName} would TRUNCATE `raw` — i.e. it is still
 * over the limit after env-marker cleanup. Callers that route or persist a
 * freshly extracted name reject in that case rather than store the slice;
 * `sanitizeProjectName` keeps truncating for its other callers (notably the
 * backfill's repair pass over already-stored rows).
 */
export function exceedsProjectNameLimit(
	raw: string | undefined | null,
): boolean {
	const cleaned = cleanProjectName(raw);
	return cleaned !== null && cleaned.length > PROJECT_NAME_MAX_LEN;
}
