import type { LaneDimension } from "./live-activity";

/**
 * Which dimension the Overview's Live Activity card groups its lanes by.
 *
 * Persisted because it is a reading stance rather than a momentary filter: an
 * operator watching who is sending traffic wants the card to still be doing
 * that after a reload. Unlike the window it couples to nothing else — the
 * store holds every event whatever the grouping, and the bucketing happens at
 * render — so this module is the whole of it.
 */

export interface LaneDimensionOption {
	value: LaneDimension;
	label: string;
}

export const LANE_DIMENSION_OPTIONS: readonly LaneDimensionOption[] = [
	{ value: "project", label: "Project" },
	{ value: "client", label: "Client" },
] as const;

/** Projects are what the card has always shown, and what most reads want. */
export const DEFAULT_LANE_DIMENSION: LaneDimension = "project";

const STORAGE_KEY = "clankermux.liveActivityGroupBy";

function isKnownDimension(value: string): value is LaneDimension {
	return LANE_DIMENSION_OPTIONS.some((option) => option.value === value);
}

/**
 * Restore the persisted grouping, falling back to the default for anything
 * unrecognised — a stored string that is not a dimension would otherwise reach
 * `buildLanes` as a key into its per-dimension spec table and leave the card
 * with nothing it can draw.
 */
export function loadLaneDimension(
	storage?: Pick<Storage, "getItem">,
): LaneDimension {
	const store = storage ?? safeStorage();
	if (!store) return DEFAULT_LANE_DIMENSION;
	try {
		const raw = store.getItem(STORAGE_KEY);
		if (!raw) return DEFAULT_LANE_DIMENSION;
		return isKnownDimension(raw) ? raw : DEFAULT_LANE_DIMENSION;
	} catch {
		return DEFAULT_LANE_DIMENSION;
	}
}

/** Persist the chosen grouping. Silently a no-op where storage is unavailable. */
export function saveLaneDimension(
	dimension: LaneDimension,
	storage?: Pick<Storage, "setItem">,
): void {
	const store = storage ?? safeStorage();
	if (!store) return;
	try {
		store.setItem(STORAGE_KEY, dimension);
	} catch {
		// Private browsing, quota, or no DOM. The grouping still applies for this
		// session; only the memory of it is lost.
	}
}

function safeStorage(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}
