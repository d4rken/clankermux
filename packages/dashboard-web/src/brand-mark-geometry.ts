/**
 * Shared 24px geometry for the ClankerMux routing-core mark.
 *
 * Three candidate lanes arrive on each side of a compact switch. The heavier
 * diagonal is the route selected through that core; the other lanes remain
 * available, which is the useful distinction between routing and a plain
 * one-to-many split.
 */
export const BRAND_MARK_CANDIDATE_PATH =
	"M2 12h7M2 19.5h2.5C7 19.5 6.5 15 9 15M15 9c2.5 0 2-4.5 4.5-4.5H22M15 12h7";

export const BRAND_MARK_SELECTED_PATH =
	"M2 4.5h2.5C7 4.5 6.5 9 9 9l6 6c2.5 0 2 4.5 4.5 4.5H22";

export const BRAND_MARK_CORE = {
	x: 8.75,
	y: 8,
	width: 6.5,
	height: 8,
	rx: 1.5,
} as const;

export const BRAND_MARK_STROKES = {
	candidate: 1.35,
	core: 1.6,
	selected: 2.4,
} as const;
