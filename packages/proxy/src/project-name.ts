/**
 * Longest project name we accept. Exported so the extraction guard can REJECT
 * an over-long candidate instead of letting it be truncated here — truncation is
 * what turns a leaked prompt tail into a plausible-looking project name. This is
 * not a storage constraint: `requests.project` is plain TEXT.
 */
export const PROJECT_NAME_MAX_LEN = 64;

const ENV_MARKER_WORDS =
	"Is a git repository\\b|Is directory a git repo\\b|Platform\\b|Shell\\b|Today's date\\b|Model\\b";

/**
 * Marker cleanup for an already-SELECTED name (a single path segment or an
 * `x-project` header). `\s*` matches zero whitespace on purpose: control-char
 * stripping fuses the environment block onto the name with no separator at all
 * (`octiIs directory a git repo: No`).
 */
const CLAUDE_ENV_MARKER_RE = new RegExp(
	`\\s*(?:-\\s*)?(?:${ENV_MARKER_WORDS}).*$`,
	"i",
);

/**
 * Marker cleanup for a whole CAPTURED path. Same words, but at least one
 * whitespace is required in front of them: a capture still contains the path's
 * separators, and the marker words are matched case-insensitively, so the
 * zero-whitespace form above would read `/workspace/model/repo` as
 * `/workspace` + a trailer. That returns the wrong project rather than none —
 * distinct projects collapse into one affinity partition — which is the worse
 * failure of the two.
 */
const CAPTURED_ENV_MARKER_RE = new RegExp(
	`\\s+(?:-\\s*)?(?:${ENV_MARKER_WORDS}).*$`,
	"i",
);

function stripMarkerTrailer(value: string, marker: RegExp): string {
	return value
		.replace(marker, "")
		.replace(/[\s:;,-]+$/g, "")
		.trim();
}

/**
 * Drop a recognized Claude Code environment-block trailer (`… Is directory a
 * git repo: Yes Platform: linux`) from a captured path.
 *
 * A client that collapses the newlines in its system prompt hands us the whole
 * block on one line, so this is what tells us where the path ENDS. A value
 * carrying no whitespace-anchored marker comes back unchanged — the strip never
 * invents a boundary.
 */
export function stripEnvMarkerTrailer(value: string): string {
	return stripMarkerTrailer(value, CAPTURED_ENV_MARKER_RE);
}

/** Everything {@link sanitizeProjectName} does except the length cap. */
function cleanProjectName(raw: string | undefined | null): string | null {
	if (!raw) return null;

	// Strip ASCII control chars (incl. newlines/tabs) before applying marker
	// cleanup so concatenated Claude Code environment blocks cannot fragment
	// routing affinity keys.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
	const withoutControls = raw.replace(/[\x00-\x1F\x7F]/g, "").trim();
	const withoutEnvBlock = stripMarkerTrailer(
		withoutControls,
		CLAUDE_ENV_MARKER_RE,
	);

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
