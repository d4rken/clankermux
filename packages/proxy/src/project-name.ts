const PROJECT_NAME_MAX_LEN = 64;

const CLAUDE_ENV_MARKER_RE =
	/\s*(?:-\s*)?(?:Is a git repository\b|Is directory a git repo\b|Platform\b|Shell\b|Today's date\b|Model\b).*$/i;

export function sanitizeProjectName(
	raw: string | undefined | null,
): string | null {
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
	return withoutEnvBlock.length > PROJECT_NAME_MAX_LEN
		? withoutEnvBlock.slice(0, PROJECT_NAME_MAX_LEN)
		: withoutEnvBlock;
}
