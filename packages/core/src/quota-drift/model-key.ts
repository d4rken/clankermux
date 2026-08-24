/**
 * Normalization of a raw `requests.model` string into the key a quota-drift
 * coefficient is estimated for.
 *
 * The key is deliberately FINER than `ModelFamily`: measured coefficients for
 * `claude-opus-5` and `claude-opus-4-8` differ by roughly a factor of two, so
 * collapsing them to `opus` would confound the very quantity being measured.
 */

/**
 * Trailing release-date suffixes, both forms this database actually contains:
 *
 *  - compact `-YYYYMMDD` — Anthropic, e.g. `claude-haiku-4-5-20251001`
 *  - dashed `-YYYY-MM-DD` — OpenAI, e.g. `gpt-5.4-mini-2026-03-17`
 *
 * Both are ANCHORED at the end. A date-like run in the middle of an id is part
 * of the id (`claude-sonnet-4-5` is a version, not a date) and must survive.
 *
 * Missing the dashed form fragments dated Codex releases into several
 * low-share keys, each below the pooling threshold, which manufactures
 * rollout-shaped discontinuities in the series out of nothing.
 */
const TRAILING_DATE_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;

/**
 * Lowercase a model id and strip an anchored trailing release-date suffix.
 *
 * Returns the empty string for null/undefined/blank input; callers treat that
 * as "no model recorded" and must not fold it into a real key.
 */
export function normalizeModelKey(modelId: string | null | undefined): string {
	if (!modelId) return "";
	const lowered = modelId.trim().toLowerCase();
	if (lowered === "") return "";
	return lowered.replace(TRAILING_DATE_SUFFIX, "");
}

/** The key low-share models are pooled into inside a fit window. */
export const OTHER_MODEL_KEY = "other";
