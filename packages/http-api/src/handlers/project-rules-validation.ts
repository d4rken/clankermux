import type { ProjectPathOverride, ProjectRules } from "@clankermux/types";

/**
 * Validation for the project-attribution rule payload.
 *
 * Returns an error STRING rather than throwing, because both lists must be
 * checked before either is written. The retention handler's per-field chain
 * applies earlier fields and then throws on a later one; for a rule set that
 * would leave project attribution running on half the operator's intent, with
 * the half that landed silently changing which upstream account every affected
 * project pins to.
 */

/** Bounded so a malformed or hostile payload cannot grow the config file. */
const MAX_ENTRIES = 256;
const MAX_PATH_LENGTH = 512;
const MAX_NAME_LENGTH = 64;

// Same rule the extractor applies to captured paths: a control character means
// the value is two pieces of text, not one path.
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting them is the point
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;

/**
 * A path is absolute if it starts at the filesystem root or names a Windows
 * drive. Clients report their OWN paths, so a deployment serving Windows
 * clients must be able to configure Windows roots.
 */
const ABSOLUTE_PATH_RE = /^(?:\/|[A-Za-z]:[\\/])/;

/**
 * `*` is a whole SEGMENT wildcard, never a substring one. `/home/*` is a rule;
 * `/home/dar*` would imply prefix matching inside a segment, which the matcher
 * does not do and which would silently never match.
 */
function segmentsAreWellFormed(path: string): boolean {
	return path
		.replace(/\\/g, "/")
		.split("/")
		.every((segment) => !segment.includes("*") || segment === "*");
}

function validatePath(value: unknown, label: string): string | null {
	if (typeof value !== "string") return `${label} must be a string`;
	const trimmed = value.trim();
	if (!trimmed) return `${label} must not be empty`;
	if (trimmed.length > MAX_PATH_LENGTH) {
		return `${label} must be at most ${MAX_PATH_LENGTH} characters`;
	}
	if (CONTROL_CHAR_RE.test(trimmed)) {
		return `${label} must not contain control characters`;
	}
	if (!ABSOLUTE_PATH_RE.test(trimmed)) {
		return `${label} must be an absolute path`;
	}
	if (!segmentsAreWellFormed(trimmed)) {
		return `${label} may only use '*' as a whole path segment`;
	}
	return null;
}

export type ProjectRulesValidation =
	| { rules: ProjectRules }
	| { error: string };

export function validateProjectRulesPayload(
	body: unknown,
): ProjectRulesValidation {
	if (typeof body !== "object" || body === null) {
		return { error: "Invalid project rules payload: expected an object" };
	}

	const { roots, overrides } = body as {
		roots?: unknown;
		overrides?: unknown;
	};

	if (!Array.isArray(roots)) return { error: "'roots' must be an array" };
	if (!Array.isArray(overrides)) {
		return { error: "'overrides' must be an array" };
	}
	if (roots.length > MAX_ENTRIES) {
		return { error: `'roots' must have at most ${MAX_ENTRIES} entries` };
	}
	if (overrides.length > MAX_ENTRIES) {
		return { error: `'overrides' must have at most ${MAX_ENTRIES} entries` };
	}

	const cleanRoots: string[] = [];
	for (const [index, root] of roots.entries()) {
		const error = validatePath(root, `roots[${index}]`);
		if (error) return { error };
		cleanRoots.push((root as string).trim());
	}

	const cleanOverrides: ProjectPathOverride[] = [];
	for (const [index, override] of overrides.entries()) {
		if (typeof override !== "object" || override === null) {
			return { error: `overrides[${index}] must be an object` };
		}
		const { prefix, name } = override as { prefix?: unknown; name?: unknown };

		const prefixError = validatePath(prefix, `overrides[${index}].prefix`);
		if (prefixError) return { error: prefixError };

		if (typeof name !== "string") {
			return { error: `overrides[${index}].name must be a string` };
		}
		const cleanName = name.trim();
		if (!cleanName) {
			return { error: `overrides[${index}].name must not be empty` };
		}
		if (cleanName.length > MAX_NAME_LENGTH) {
			return {
				error: `overrides[${index}].name must be at most ${MAX_NAME_LENGTH} characters`,
			};
		}
		if (CONTROL_CHAR_RE.test(cleanName)) {
			return {
				error: `overrides[${index}].name must not contain control characters`,
			};
		}

		cleanOverrides.push({ prefix: (prefix as string).trim(), name: cleanName });
	}

	return { rules: { roots: cleanRoots, overrides: cleanOverrides } };
}
