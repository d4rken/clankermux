/**
 * Composing the operator's curation onto an upstream model list.
 *
 * Pure functions over plain data, deliberately shared by every surface that
 * shows a catalogue: the wire route's three reply shapes and the dashboard's
 * editing view. The composition rules are subtle enough (which entry wins, what
 * order additions land in, what a collision means) that two implementations
 * would drift, and the drift would be invisible — the dashboard would show one
 * list while `/v1/models` served another.
 */

/** One curation row, as the rest of the server reads it. */
export interface ModelOverride {
	modelId: string;
	/** Remove this baseline entry from the served list. */
	hidden: boolean;
	/** Add this entry; the baseline does not have it. */
	custom: boolean;
	/** Replaces the shown name. Null leaves the baseline's own name. */
	displayName: string | null;
	/** Epoch ms; orders the appended custom entries. */
	createdAt: number;
}

/** The least a baseline entry has to carry to be composable. */
export interface NamedModel {
	id: string;
	displayName: string;
}

export interface OverrideIndex {
	/** Baseline ids to drop. */
	hidden: ReadonlySet<string>;
	/** Id → replacement display name, for baseline AND custom entries alike. */
	displayNames: ReadonlyMap<string, string>;
	/**
	 * Custom rows the baseline does not already contain, oldest first. A custom
	 * row whose id DOES collide with a baseline entry is not an addition: it can
	 * only act as a rename of the entry that is already there, which is what
	 * `displayNames` does with it.
	 */
	additions: readonly ModelOverride[];
}

/**
 * Reduce the rows to the three decisions a caller actually makes.
 *
 * Split from `applyOverrides` because one caller — the Codex catalogue path —
 * cannot use the generic apply: its entries carry ~34 upstream fields that must
 * survive untouched, so it edits them in place against this index instead of
 * being handed rebuilt ones.
 */
export function indexOverrides(
	baselineIds: Iterable<string>,
	overrides: readonly ModelOverride[],
): OverrideIndex {
	const baseline = new Set(baselineIds);
	const hidden = new Set<string>();
	const displayNames = new Map<string, string>();
	const additions: ModelOverride[] = [];

	for (const override of overrides) {
		if (override.hidden) {
			hidden.add(override.modelId);
			// A hidden entry is not shown at all, so a name for it is moot. Skipping
			// it here keeps a stale name from resurfacing if the row is un-hidden
			// through a path that does not rewrite the name.
			continue;
		}
		if (override.displayName !== null && override.displayName !== "") {
			displayNames.set(override.modelId, override.displayName);
		}
		if (override.custom && !baseline.has(override.modelId)) {
			additions.push(override);
		}
	}

	// Oldest first, id as the tiebreak: two rows written in the same millisecond
	// still order deterministically, so the served list does not reshuffle
	// between requests.
	additions.sort(
		(a, b) => a.createdAt - b.createdAt || a.modelId.localeCompare(b.modelId),
	);

	return { hidden, displayNames, additions };
}

/**
 * The baseline with the curation applied: hidden entries dropped, names
 * replaced, custom entries appended.
 *
 * Ids are deduplicated, first occurrence winning. Upstream should not repeat an
 * id, but a duplicate reaching a client is a picker with two identical rows and
 * a rename that appears to apply to only one of them — cheap to prevent here,
 * awkward to diagnose there.
 */
export function applyOverrides<T extends NamedModel>(
	baseline: readonly T[],
	overrides: readonly ModelOverride[],
	createEntry: (override: ModelOverride) => T,
): T[] {
	const index = indexOverrides(
		baseline.map((entry) => entry.id),
		overrides,
	);

	const seen = new Set<string>();
	const composed: T[] = [];
	for (const entry of baseline) {
		if (index.hidden.has(entry.id)) continue;
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		const renamed = index.displayNames.get(entry.id);
		composed.push(renamed ? { ...entry, displayName: renamed } : entry);
	}
	for (const addition of index.additions) {
		if (seen.has(addition.modelId)) continue;
		seen.add(addition.modelId);
		composed.push(createEntry(addition));
	}
	return composed;
}
