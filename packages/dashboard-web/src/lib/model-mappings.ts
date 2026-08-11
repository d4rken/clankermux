import {
	DEFAULT_CODEX_MODEL_BY_FAMILY,
	DEFAULT_QWEN_MODEL_BY_FAMILY,
	LATEST_FABLE_MODEL,
	LATEST_HAIKU_MODEL,
	LATEST_OPUS_MODEL,
	LATEST_SONNET_MODEL,
	type ModelFamily,
} from "@clankermux/core";

/** The family fields the mappings dialog edits, in display order. */
export const MODEL_FAMILY_FIELDS = [
	"opus",
	"sonnet",
	"haiku",
	"fable",
] as const satisfies readonly ModelFamily[];

/** A value for each family field, as typed into the dialog's text inputs. */
export type ModelFamilyFieldValues = Record<
	(typeof MODEL_FAMILY_FIELDS)[number],
	string
>;

/**
 * Placeholder ids for providers with no built-in family defaults — an
 * Anthropic-compatible endpoint expects Claude ids, so show the latest ones.
 */
const CLAUDE_PLACEHOLDER_MODELS: Record<ModelFamily, string> = {
	opus: LATEST_OPUS_MODEL,
	sonnet: LATEST_SONNET_MODEL,
	haiku: LATEST_HAIKU_MODEL,
	fable: LATEST_FABLE_MODEL,
};

/**
 * Example model id to show per family for `provider`. Providers that map every
 * Claude family onto their own catalogue show what they would actually send,
 * so the placeholder never suggests an id the backend would reject.
 */
export function getPlaceholderModels(
	provider: string | null | undefined,
): Record<ModelFamily, string> {
	switch (provider) {
		case "codex":
			return DEFAULT_CODEX_MODEL_BY_FAMILY;
		case "qwen":
			return DEFAULT_QWEN_MODEL_BY_FAMILY;
		default:
			return CLAUDE_PLACEHOLDER_MODELS;
	}
}

/** Render a stored mapping value into a comma-separated field value. */
export function formatMappingValue(
	value: string | string[] | undefined,
): string {
	if (!value) return "";
	return Array.isArray(value) ? value.join(", ") : value;
}

/**
 * Parse a comma-separated field value into a mapping value, or null when the
 * field is blank (blank means "no mapping for this family").
 */
export function parseMappingValue(value: string): string | string[] | null {
	const parts = value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (parts.length === 0) return null;
	return parts.length === 1 ? parts[0] : parts;
}

/**
 * True iff a raw mapping value is usable as a model target: a non-empty string,
 * or a non-empty array of non-empty strings. Mirrors the core resolver's
 * validity rule and the update endpoint's request validation.
 */
function isValidMappingValue(value: unknown): value is string | string[] {
	if (typeof value === "string") return value.trim().length > 0;
	if (Array.isArray(value)) {
		return (
			value.length > 0 &&
			value.every((item) => typeof item === "string" && item.trim().length > 0)
		);
	}
	return false;
}

/**
 * Build the `model_mappings` payload for a save.
 *
 * The update endpoint REPLACES `model_mappings` wholesale, so every key the
 * dialog does not edit — exact model ids such as `claude-fable-5` — has to be
 * carried over from the account's current mapping or it is silently deleted by
 * an unrelated family edit.
 *
 * Stored data is not necessarily valid: legacy or hand-edited rows can hold
 * `null`, a number, or an empty array, which the core resolver tolerates by
 * skipping. The update endpoint rejects the WHOLE save with a 400 on any such
 * value, so carrying one over would make every dialog save fail. Invalid
 * unknown keys are dropped instead — they had no routing effect anyway.
 */
export function buildModelMappingsPayload(
	original: { [key: string]: unknown } | null | undefined,
	fields: ModelFamilyFieldValues,
): { [key: string]: string | string[] } {
	const familyKeys = MODEL_FAMILY_FIELDS as readonly string[];
	const payload: { [key: string]: string | string[] } = {};

	for (const [key, value] of Object.entries(original ?? {})) {
		if (familyKeys.includes(key)) continue;
		if (!isValidMappingValue(value)) continue;
		payload[key] = value;
	}

	for (const family of MODEL_FAMILY_FIELDS) {
		const parsed = parseMappingValue(fields[family]);
		if (parsed) payload[family] = parsed;
	}

	return payload;
}
