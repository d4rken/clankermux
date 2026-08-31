/**
 * The two status hues that are NOT theme tokens, and must not become them.
 *
 * Live Activity draws amber "rate limited" and red "failed" marks in the same
 * plot as model-coloured request marks. `model-colors.test.ts` measures all 28
 * model hues — in both colour modes, at normal vision and under simulated
 * protanopia and deuteranopia — against exactly these two values, and
 * `scripts/extend-model-palette.ts` searches for new hues against them too. Of
 * 36 candidate warning/error pairs, only this one and #F7B500/#EF4444 keep
 * every model hue clear; the theme's own --warning (#F2B544 on the dark ground)
 * fails on `gold` at 6.4 dE and on `tan` at 2.5 dE under dichromacy.
 *
 * So these stay literals, deliberately outside the mode-following tokens:
 * routing them through --warning/--destructive would silently invalidate the
 * separation guarantee the palette is built on.
 */
export const PINNED_MARK_COLORS = {
	warning: "#F59E0B",
	error: "#EF4444",
} as const;

// Color palette used across UI components
export const COLORS = {
	primary: "#f38020",
	success: "#10b981",
	warning: "#f59e0b",
	error: "#ef4444",
	blue: "#3b82f6",
	purple: "#8b5cf6",
	pink: "#ec4899",
	indigo: "#6366f1",
	cyan: "#06b6d4",
} as const;

/**
 * Qualitative palette for per-model data series.
 *
 * Deliberately separate from `COLORS`: those are SEMANTIC names (success,
 * warning, error, ...) that other components rely on, and there are only nine
 * of them — far too few to give every model a unique hue, which is why models
 * used to collide. Charts plot every model in the time range side by side, so
 * a data-series palette needs many mutually distinguishable hues and nothing
 * else.
 *
 * Every hue clears the same two bars, enforced by model-colors.test.ts:
 * 15 dE from every other entry at normal vision and 7.9 dE under simulated
 * protanopia and deuteranopia; and, on the dark ground, L* 45 or above so it
 * reads on the near-black chart background (hsl(220 13% 8%)).
 *
 * A second exclusion applies on top of the pairwise one: no entry may be
 * confusable with `COLORS.warning` or `COLORS.error`. Those two hues MEAN
 * "rate limited" and "failed" on surfaces that draw model-coloured marks
 * alongside status-coloured ones — Live Activity is one — so a model wearing
 * one of them reads as a status on sight, whatever its shape says.
 *
 * For the error red that exclusion is a HUE-FAMILY rule, not a distance: a
 * colour within 30° of the error hue and saturated enough to read as that hue
 * (chroma 25+) is out even when it clears 15 dE, because clearing on distance
 * usually means it is merely darker. `red` (#CC3311) passed every numeric
 * check at 11° from the error hue while being the assigned colour of Claude
 * Opus 5, which is over half of all traffic — the card would have been a field
 * of red marks captioned "red means failed". That cost five original entries:
 * `red`, `peach`, `rose`, `pink` and `magenta`, plus `orange` (dE 7.2 from
 * warning, 1.2 under dichromacy), `olive` and `pear` (yellow-greens that the
 * red-green axis collapses onto red exactly as it does the error hue).
 *
 * The warning amber keeps only the numeric checks. Rate limits are drawn as
 * TRIANGLES and are ~2 requests a day against ~15,000 successes; reserving
 * that arc too would have cost the whole warm half of the palette to guard a
 * collision that is both shape-distinguished and vanishingly rare.
 *
 * Ten entries are the surviving originals, verbatim from Okabe-Ito and Paul
 * Tol's schemes. `gold` is Tol high-contrast yellow. The remaining seventeen
 * come from a Lab sweep, not a published set: those sets cluster tightly
 * enough that they are exhausted well before 28 mutually separable hues, and
 * 28 is what 24 models plus a fallback pool needs.
 * `bun packages/ui-constants/scripts/extend-model-palette.ts` is that search.
 */
export const MODEL_PALETTE = {
	// Survivors from the original curated set.
	blue: "#0077BB", // Tol vibrant blue
	teal: "#009988", // Tol vibrant teal
	green: "#228833", // Tol bright green
	skyBlue: "#99DDFF", // Tol light cyan
	yellow: "#EEDD88", // Tol light yellow
	mint: "#44BB99", // Tol light mint
	purple: "#AA4499", // Tol muted purple
	lightBlue: "#77AADD", // Tol light blue
	mauve: "#CC79A7", // Okabe-Ito reddish purple
	grey: "#DDDDDD", // Tol pale grey
	// Added by the search. `gold` is Tol high-contrast yellow verbatim; the rest
	// come from the Lab sweep, because the published qualitative sets are
	// clustered enough that they run out well before 28 mutually separable hues.
	gold: "#DDAA33", // Tol high-contrast yellow
	periwinkle: "#8582FD",
	indigo: "#8846E5",
	moss: "#6A7055",
	fern: "#7C880C",
	tan: "#C9966D",
	sage: "#C0E8B6",
	orchid: "#C20FB7",
	violet: "#9F19FF",
	lilac: "#C8ACD3",
	leaf: "#92C55B",
	cornflower: "#98A5FF",
	magenta: "#C63D7B",
	fuchsia: "#EB6BD4",
	emerald: "#7FD38F",
	amethyst: "#D53DF2",
	azure: "#175FF9",
	plum: "#A176B7",
} as const;

/**
 * Light-ground counterpart to MODEL_PALETTE.
 *
 * MODEL_PALETTE's hues are chosen to sit above L* 45 so they read on the
 * near-black chart ground the dark palettes use. On a white card those same
 * hues invert the problem: `#99DDFF`, `#EEDD88`, `#DDDDDD` and `#FFAABB` all
 * fall under 1.5:1 against white and effectively disappear. This set mirrors
 * the constraints for a light ground — every entry at or below L* 66 and at
 * least 3:1 on white — while keeping the same keys, so a model's identity is
 * the key and only the rendered value depends on the colour mode.
 *
 * The surviving original entries are Paul Tol's muted, dark and high-contrast
 * schemes plus darkened Okabe-Ito entries. Most ADDED entries are their dark
 * counterpart walked down its own Lab hue ray until it clears the 3:1 floor, so
 * the two palettes hold the same colour at different lightness rather than two
 * unrelated colours under one key — searching the grounds independently and
 * zipping the results is what yields a key that is green in dark mode and
 * violet in light mode. Two are exceptions, both fine: `indigo` takes Tol muted
 * indigo directly (L* 22, below the ray walk's search band) and `periwinkle`
 * happens to satisfy both grounds unchanged.
 *
 * Cross-ground coherence is enforced by model-colors.test.ts alongside the
 * separation checks; `scripts/check-light-palette.ts` and
 * `scripts/extend-model-palette.ts` are the design-time aids used to pick them.
 */
export const MODEL_PALETTE_LIGHT: Record<keyof typeof MODEL_PALETTE, string> = {
	blue: "#0F96C7", // L* 58 · 3.4:1
	teal: "#046A5E", // L* 40 · 6.5:1
	green: "#496812", // L* 40 · 6.4:1
	skyBlue: "#077788", // L* 46 · 5.2:1
	yellow: "#8C9457", // L* 59 · 3.2:1
	mint: "#73967E", // L* 59 · 3.3:1
	purple: "#7B3BC4", // L* 40 · 6.4:1
	lightBlue: "#1A4961", // L* 29 · 9.7:1
	mauve: "#7B218C", // L* 32 · 8.6:1
	grey: "#4C4343", // L* 29 · 9.6:1
	gold: "#B88904", // L* 60 · 3.2:1
	periwinkle: "#8582FD", // L* 60 · 3.2:1
	indigo: "#332288", // L* 22 · 12.2:1 — Tol muted indigo
	moss: "#5E6449", // L* 41 · 6.2:1
	fern: "#758200", // L* 52 · 4.2:1
	tan: "#5B3410", // L* 26 · 10.8:1
	sage: "#30542A", // L* 32 · 8.7:1
	orchid: "#EE4CE0", // L* 61 · 3.1:1
	violet: "#9F19FF", // L* 46 · 5.2:1
	lilac: "#A68BB1", // L* 61 · 3.0:1
	leaf: "#689B33", // L* 59 · 3.3:1
	cornflower: "#5064B6", // L* 45 · 5.5:1
	magenta: "#B3296B", // L* 42 · 6.1:1
	fuchsia: "#C647B1", // L* 51 · 4.3:1
	emerald: "#106D31", // L* 40 · 6.5:1
	amethyst: "#C92EE6", // L* 52 · 4.2:1
	azure: "#025CF5", // L* 45 · 5.5:1
	plum: "#68417E", // L* 34 · 7.9:1
} as const;

/**
 * Fallback sequence for series that have no explicit model assignment.
 *
 * Drawn from MODEL_PALETTE rather than the semantic COLORS object: the old
 * sequence was orange/blue/purple/pink/green straight out of COLORS, which put
 * the brand hue and a non-colourblind-safe set on charts that sit next to
 * MODEL_COLORS series using the curated palette. Two palettes disagreeing on
 * the same axes is what made unknown models look like a different kind of
 * thing entirely.
 */
export const CHART_COLORS = [
	MODEL_PALETTE.blue,
	MODEL_PALETTE.teal,
	MODEL_PALETTE.green,
	MODEL_PALETTE.magenta,
	MODEL_PALETTE.mint,
] as const;

/** Light-ground counterpart to CHART_COLORS, same ordering. */
export const CHART_COLORS_LIGHT = [
	MODEL_PALETTE_LIGHT.blue,
	MODEL_PALETTE_LIGHT.teal,
	MODEL_PALETTE_LIGHT.green,
	MODEL_PALETTE_LIGHT.magenta,
	MODEL_PALETTE_LIGHT.mint,
] as const;

// Time range options for analytics
export type TimeRange = "1h" | "6h" | "24h" | "7d" | "30d" | "all";

export const TIME_RANGES: Record<TimeRange, string> = {
	"1h": "Last Hour",
	"6h": "Last 6 Hours",
	"24h": "Last 24 Hours",
	"7d": "Last 7 Days",
	"30d": "Last 30 Days",
	all: "All Time",
} as const;

// Chart dimensions
export const CHART_HEIGHTS = {
	compact: 180,
	small: 250,
	medium: 300,
	large: 400,
} as const;

// Common chart tooltip styles
export const CHART_TOOLTIP_STYLE = {
	default: {
		backgroundColor: "var(--background)",
		border: "1px solid var(--border)",
		borderRadius: "var(--radius)",
	},
	success: {
		backgroundColor: COLORS.success,
		border: `1px solid ${COLORS.success}`,
		borderRadius: "var(--radius)",
		color: "#fff",
	},
	dark: {
		backgroundColor: "rgba(0,0,0,0.8)",
		border: "1px solid rgba(255,255,255,0.2)",
		borderRadius: "8px",
		backdropFilter: "blur(8px)",
	},
} as const;

// Chart common properties
export const CHART_PROPS = {
	strokeDasharray: "3 3",
	gridClassName: "stroke-muted",
} as const;

// API and data refresh intervals (in milliseconds)
export const REFRESH_INTERVALS = {
	default: 30000, // 30 seconds
	fast: 10000, // 10 seconds
	slow: 60000, // 1 minute
} as const;

// API timeout
export const API_TIMEOUT = 30000; // 30 seconds

// React Query configuration
export const QUERY_CONFIG = {
	staleTime: 10000, // Consider data stale after 10 seconds
} as const;

// API default limits
export const API_LIMITS = {
	requestsDetail: 50,
	requestsSummary: 50,
} as const;
