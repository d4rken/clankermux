import type { ModelVariant } from "@clankermux/types";

/** Ascending. `none` is thinking switched off, not the bottom of a scale. */
const EFFORT_ORDER = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
type Effort = (typeof EFFORT_ORDER)[number];

/** Map a provider's effort label ("XHigh", "X-High", "Max") onto the vocabulary. */
export function variantEffort(name: string | null | undefined): Effort | null {
	const normalized = name?.toLowerCase().replace(/[^a-z]/g, "");
	return EFFORT_ORDER.find((effort) => effort === normalized) ?? null;
}

/**
 * Describe one catalogue entry from its family label and metadata entries. The
 * entry whose key names an effort carries the level; every other entry is an
 * axis a sibling must share. A model outside any family describes nothing.
 */
export function describeModelVariant(
	family: string,
	entries: ReadonlyArray<{ key: string; name: string; order: number }>,
): ModelVariant | null {
	if (!family) return null;
	const effortEntry = entries.find((entry) => /effort/i.test(entry.key));
	const dimensions = entries
		.filter((entry) => entry !== effortEntry)
		.map((entry) => `${entry.key}=${entry.name}@${entry.order}`)
		.sort()
		.join("|");
	return {
		family,
		effort: variantEffort(effortEntry?.name),
		dimensions,
	};
}

/**
 * The sibling of `target` that serves `requested`: the same family and
 * dimensions, at the nearest effort at or below the request, else the lowest
 * one that exists. A `none` sibling is only chosen when `none` is requested.
 * Anything that cannot be mapped (no effort, a value outside the vocabulary, a
 * target with no known variant) leaves the target as written.
 */
export function selectEffortVariant(
	target: string,
	requested: string | null | undefined,
	variants: Readonly<Record<string, ModelVariant>>,
): string {
	const want = variantEffort(requested);
	const base = variants[target];
	if (!want || !base?.effort) return target;
	const rank = (effort: string) => EFFORT_ORDER.indexOf(effort as Effort);
	const siblings = Object.entries(variants)
		.filter(
			([, v]) =>
				v.family === base.family &&
				v.dimensions === base.dimensions &&
				v.effort !== null &&
				(v.effort !== "none" || want === "none"),
		)
		.map(([id, v]) => ({ id, rank: rank(v.effort as string) }))
		.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
	const wanted = rank(want);
	const atOrBelow = siblings.filter((s) => s.rank <= wanted).at(-1);
	return (atOrBelow ?? siblings[0])?.id ?? target;
}
