import { getModelShortName } from "@clankermux/core";
import {
	CHART_COLORS,
	CHART_COLORS_LIGHT,
	MODEL_PALETTE,
	MODEL_PALETTE_LIGHT,
} from "../constants";

/** Which chart ground the colour is being resolved for. */
export type ColorMode = "light" | "dark";

/**
 * Model-based chart colour assignment, keyed by the UI short name
 * (`getModelShortName`) with a few legacy ids that predate the registry.
 *
 * The value is a PALETTE KEY, not a hex string. A model's identity is the key;
 * the rendered value depends on the colour mode, because a hue that reads on
 * the near-black chart ground of the dark palettes is close to invisible on the
 * white card the light ones use, and vice versa. MODEL_PALETTE and
 * MODEL_PALETTE_LIGHT share their key set precisely so this indirection works.
 *
 * Invariant: every id here has a GLOBALLY unique key — no two models share one,
 * regardless of family. Charts are not grouped per family: AnalyticsCharts
 * builds its series list from every distinct model in the time range, so Opus,
 * Sonnet and Mythos are plotted side by side and a cross-family repeat is just
 * as unreadable as a within-family one. The "all" range can also surface the
 * pre-registry legacy ids alongside current ones, so they need stable
 * assignments too.
 *
 * Every registry model needs an explicit entry: the substring fallback below is
 * deliberately loose (`claude-opus-4-8` contains `claude-opus-4`), so a model
 * without an entry silently inherits an older model's colour. Uniqueness and
 * perceptual separation are enforced by model-colors.test.ts, in BOTH modes.
 */
export const MODEL_COLOR_KEYS: Record<string, keyof typeof MODEL_PALETTE> = {
	"claude-3.5-sonnet": "rose",
	"claude-3.5-haiku": "pink",
	"claude-3-opus": "grey",
	"claude-opus-4": "blue",
	"claude-opus-4.1": "orange",
	"claude-opus-4.5": "green",
	"claude-opus-4.6": "magenta",
	"claude-opus-4.7": "skyBlue",
	"claude-opus-4.8": "yellow",
	"claude-opus-5": "red",
	"claude-sonnet-4": "mint",
	"claude-sonnet-4.5": "purple",
	"claude-sonnet-4.6": "pear",
	"claude-sonnet-5": "peach",
	"claude-haiku-4.5": "lightBlue",
	"claude-fable-5": "olive",
	"claude-mythos-5": "mauve",
};

/** Resolve a palette key to its value for the given ground. */
export function paletteColor(
	key: keyof typeof MODEL_PALETTE,
	mode: ColorMode,
): string {
	return mode === "light" ? MODEL_PALETTE_LIGHT[key] : MODEL_PALETTE[key];
}

/**
 * Resolve the chart colour for a model id: explicit short-name entry, then
 * explicit raw-id entry, then a loose substring match (so unregistered or
 * third-party variants borrow their base model's colour), then the index-based
 * fallback sequence.
 *
 * `mode` defaults to "dark" — the ground the dashboard used before light
 * palettes existed — so a call site that has not been threaded through the
 * colour mode keeps its previous behaviour instead of silently picking hues
 * tuned for the wrong ground.
 */
export function getModelColor(
	model: string,
	index: number,
	mode: ColorMode = "dark",
): string {
	const key = getModelColorKey(model);
	if (key) return paletteColor(key, mode);

	const sequence = mode === "light" ? CHART_COLORS_LIGHT : CHART_COLORS;
	return sequence[index % sequence.length];
}

/** The palette key a model resolves to, or null if only the fallback applies. */
export function getModelColorKey(
	model: string,
): keyof typeof MODEL_PALETTE | null {
	const shortName = getModelShortName(model);
	if (MODEL_COLOR_KEYS[shortName]) return MODEL_COLOR_KEYS[shortName];

	if (MODEL_COLOR_KEYS[model]) return MODEL_COLOR_KEYS[model];

	for (const [candidate, key] of Object.entries(MODEL_COLOR_KEYS)) {
		if (model.includes(candidate) || candidate.includes(model)) return key;
	}

	return null;
}
